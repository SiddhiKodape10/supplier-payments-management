import axios from 'axios'
import { config, isSapConfigured } from '../config.js'
import { IntegrationError } from './sapService.js'

const MAX_RECORDS = 5000
const PAGE_SIZE = 100
const LINE_ITEM_CACHE_TTL_MS = 60 * 1000
const lineItemCache = new Map()
const lineItemInflight = new Map()

export const SUPPORTED_DOC_TYPES = new Set([
  'KR', // Vendor Invoice
  'RE', // Invoice Receipt (MM Logistics)
  'KG', // Vendor Credit Memo
  'KZ', // Vendor Payment
  'ZP', // Payment Posting
  'KA', // Vendor Document (General AP)
  'AB', // General Accounting Document / Clearing
  'CC', // Payment Card Settlement
  'SA', // G/L Account Document
  'RK', // Invoice Reduction
  'Y1', // Internal Document
])

const LINE_FIELDS = [
  'Supplier',
  'SupplierName',
  'CompanyCode',
  'AccountingDocument',
  'AccountingDocumentItem',
  'FiscalYear',
  'AccountingDocumentType',
  'DebitCreditCode',
  'DocumentDate',
  'PostingDate',
  'InvoiceReference',
  'AmountInTransactionCurrency',
  'TransactionCurrency',
  'AmountInBalanceTransactionCurrency',
  'BalanceTransactionCurrency',
  'AmountInCompanyCodeCurrency',
  'CompanyCodeCurrency',
  'AmountInPaymentCurrency',
  'PaymentCurrency',
  'NetDueDate',
  'DueCalculationBaseDate',
  'NetPaymentDays',
  'SpecialGeneralLedgerCode',
  'ClearingStatus',
  'ClearingDate',
  'ClearingAccountingDocument',
  'ClearingDocFiscalYear',
  'HasClearingAccountingDocument',
  'IsCleared',
  'IsClearingReversed',
]

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeSapIdentifier(value) {
  if (value === null || value === undefined) return ''
  const textValue = String(value).trim()
  if (!textValue) return ''
  const normalized = textValue.replace(/^0+(?=\d)/, '')
  return normalized || '0'
}

function matchesSapIdentifier(value, expected) {
  if (!value || !expected) return false
  const left = String(value).trim()
  const right = String(expected).trim()
  if (!left || !right) return false
  return left === right || normalizeSapIdentifier(left) === normalizeSapIdentifier(right)
}

function sapDate(value) {
  if (typeof value !== 'string') return null
  const match = /^\/Date\((-?\d+)(?:[-+]\d{4})?\)\/$/.exec(value)
  if (match) {
    const date = new Date(Number(match[1]))
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
    const date = new Date(value)
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null
  }
  return null
}

function decimal(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const normalized = String(value).trim()
  return /^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized) ? normalized : null
}

function compareDecimal(left, right) {
  if (!left || !right) return null
  const [li, lf = ''] = left.replace(/^[+-]/, '').split('.')
  const [ri, rf = ''] = right.replace(/^[+-]/, '').split('.')
  const scale = Math.max(lf.length, rf.length)
  const ls = BigInt((left.startsWith('-') ? '-' : '') + `${li || '0'}${lf.padEnd(scale, '0')}`)
  const rs = BigInt((right.startsWith('-') ? '-' : '') + `${ri || '0'}${rf.padEnd(scale, '0')}`)
  return ls === rs ? 0 : ls < rs ? -1 : 1
}

function addDecimal(left, right) {
  const [li, lf = ''] = left.replace(/^[+-]/, '').split('.')
  const [ri, rf = ''] = right.replace(/^[+-]/, '').split('.')
  const scale = Math.max(lf.length, rf.length)
  const ls = BigInt(left.startsWith('-') ? `-${li || '0'}${lf.padEnd(scale, '0')}` : `${li || '0'}${lf.padEnd(scale, '0')}`)
  const rs = BigInt(right.startsWith('-') ? `-${ri || '0'}${rf.padEnd(scale, '0')}` : `${ri || '0'}${rf.padEnd(scale, '0')}`)
  const sum = ls + rs
  const negative = sum < 0n
  let digits = (negative ? -sum : sum).toString().padStart(scale + 1, '0')
  const result = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits
  return `${negative ? '-' : ''}${result}`
}

function isX(value) {
  return text(value)?.toUpperCase() === 'X'
}

function path() {
  return text(config.sap.lineItemsOdataPath) || '/FAP_VENDOR_LINE_ITEMS_SRV'
}

function origin() {
  const url = new URL(config.sap.baseUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new IntegrationError('SAP line-item base URL is invalid.', 503, 'configuration_error')
  }
  return url.origin
}

function serviceUrl() {
  return new URL(`${path().replace(/\/$/, '')}/`, origin()).toString()
}

function entityUrl() {
  return new URL(`${path().replace(/\/$/, '')}/Items`, origin()).toString()
}

function metadataUrl() {
  return new URL(`${path().replace(/\/$/, '')}/$metadata`, origin()).toString()
}

function axiosError(error, operation) {
  if (error instanceof IntegrationError) throw error
  if (!axios.isAxiosError(error)) throw new IntegrationError(`SAP ${operation} could not be verified.`, 502, 'unknown')
  if (!error.response) throw new IntegrationError(`Could not connect to the SAP ${operation} service.`, 502, 'unavailable')
  const status = error.response.status
  if (status === 401) throw new IntegrationError(`SAP authentication failed for ${operation}.`, 502, 'authentication_failed', status)
  if (status === 403) throw new IntegrationError(`SAP denied read access to ${operation}.`, 502, 'authorization_failed', status)
  if (status === 404) throw new IntegrationError(`The SAP ${operation} entity was not found.`, 502, 'unavailable', status)
  throw new IntegrationError(`SAP ${operation} request failed (HTTP ${status}).`, 502, status >= 500 ? 'unavailable' : 'other_error', status)
}

export function getExclusionReason(record) {
  if (record.specialGeneralLedgerCode === 'F') {
    return 'Noted item (down payment request) does not affect accounting balance'
  }
  if (record.accountingDocumentType && !SUPPORTED_DOC_TYPES.has(record.accountingDocumentType)) {
    return `Document type ${record.accountingDocumentType} is not a recognized accounts payable document`
  }
  return null
}

export function isExcludedVendorItem(record) {
  return Boolean(getExclusionReason(record))
}

export function isClearedVendorItem(record) {
  return (
    record.isCleared ||
    record.hasClearingDocument ||
    Boolean(record.clearingDocument && record.clearingDate) ||
    record.clearingStatus === '1'
  )
}

export function isSupportedVendorPayable(record) {
  return !record.isClearingReversed && !isExcludedVendorItem(record) && Boolean(record.supplierId)
}

export function mapVendorLineItem(row) {
  const supplier = text(row.Supplier)
  const companyCode = text(row.CompanyCode)
  const accountingDocument = text(row.AccountingDocument)
  const item = text(row.AccountingDocumentItem)
  const fiscalYear = text(row.FiscalYear)
  if (!supplier || !companyCode || !accountingDocument || !item || !fiscalYear) {
    throw new IntegrationError('SAP vendor line item lacks a stable accounting key or supplier.', 502, 'invalid_data')
  }

  const documentType = text(row.AccountingDocumentType)
  const debitCreditCode = text(row.DebitCreditCode)?.toUpperCase() ?? null
  const txAmount = decimal(row.AmountInTransactionCurrency)
  const balAmount = decimal(row.AmountInBalanceTransactionCurrency)
  const rawAmount = txAmount ?? balAmount
  const currency = text(row.TransactionCurrency) || text(row.BalanceTransactionCurrency) || text(row.CompanyCodeCurrency)

  // Unsigned gross amount for display
  const grossAmount = rawAmount ? rawAmount.replace(/^-/, '') : null

  // In AP vendor subledger:
  // Credit ('H') is amount owed to vendor (+ payable liability)
  // Debit ('S') reduces payable / credit memo / payment (- payable)
  let signedAmount = null
  if (grossAmount && debitCreditCode) {
    if (debitCreditCode === 'H') signedAmount = grossAmount
    else if (debitCreditCode === 'S') signedAmount = `-${grossAmount}`
  }

  // Authoritative due date: NetDueDate, fallback to baseline date + net terms
  let dueDate = sapDate(row.NetDueDate)
  if (!dueDate && row.DueCalculationBaseDate && row.NetPaymentDays !== undefined && row.NetPaymentDays !== null) {
    const base = sapDate(row.DueCalculationBaseDate)
    const days = Number(row.NetPaymentDays)
    if (base && Number.isFinite(days)) {
      const dt = new Date(`${base}T00:00:00Z`)
      dt.setUTCDate(dt.getUTCDate() + days)
      dueDate = dt.toISOString().slice(0, 10)
    }
  }

  const clearingDoc = text(row.ClearingAccountingDocument)
  const clearingDate = sapDate(row.ClearingDate)
  const isCleared = isX(row.IsCleared) || isX(row.HasClearingAccountingDocument) || text(row.ClearingStatus) === '1' || Boolean(clearingDoc && clearingDate)
  const isReversal = isX(row.IsClearingReversed)
  const specialGl = text(row.SpecialGeneralLedgerCode)

  const record = {
    id: `${companyCode}_${fiscalYear}_${accountingDocument}_${item}`,
    supplierId: supplier,
    supplierName: text(row.SupplierName),
    companyCode,
    accountingDocument,
    accountingDocumentItem: item,
    fiscalYear,
    accountingDocumentType: documentType,
    documentType,
    debitCreditCode,
    documentDate: sapDate(row.DocumentDate),
    postingDate: sapDate(row.PostingDate),
    invoiceReference: text(row.InvoiceReference),
    balanceAmount: balAmount,
    balanceCurrency: text(row.BalanceTransactionCurrency),
    transactionAmount: txAmount,
    transactionCurrency: text(row.TransactionCurrency),
    paymentAmount: decimal(row.AmountInPaymentCurrency),
    paymentCurrency: text(row.PaymentCurrency),
    currency,
    grossAmount,
    amount: signedAmount ? Number(signedAmount) : null,
    signedAmount,
    dueDate,
    clearingStatus: text(row.ClearingStatus),
    clearingDate,
    clearingDocument: clearingDoc,
    clearingDocFiscalYear: text(row.ClearingDocFiscalYear),
    hasClearingDocument: isX(row.HasClearingAccountingDocument),
    isCleared,
    isClearingReversed: isReversal,
    isReversal,
    specialGeneralLedgerCode: specialGl,
    source: 'SAP',
    dataSource: 'live',
  }

  return record
}

export function verifiedOpenAmount(record) {
  if (record.isClearingReversed || isClearedVendorItem(record)) return null
  if (isExcludedVendorItem(record)) return null
  if (!record.signedAmount || !record.currency) return null
  return record.signedAmount
}

export function getVendorLineItemStatusDetails(record, reportingDate) {
  if (record.isClearingReversed) {
    return { status: 'Reversed', reason: 'Document or clearing is reversed' }
  }
  const excludedReason = getExclusionReason(record)
  if (excludedReason) {
    return { status: 'Excluded', reason: excludedReason }
  }
  if (isClearedVendorItem(record)) {
    const docInfo = record.clearingDocument ? ` by doc ${record.clearingDocument}` : ''
    const dateInfo = record.clearingDate ? ` on ${record.clearingDate}` : ''
    return { status: 'Cleared', reason: `Cleared${docInfo}${dateInfo}`.trim() }
  }
  if (!verifiedOpenAmount(record)) {
    return { status: 'Unverified', reason: 'Open balance or currency could not be verified' }
  }
  if (!record.dueDate) {
    return { status: 'Open', reason: 'Open item without authoritative due date' }
  }
  const report = text(reportingDate) || new Date().toISOString().slice(0, 10)
  if (record.dueDate < report) {
    return { status: 'Overdue', reason: `Due date ${record.dueDate} is before ${report}` }
  }
  return { status: 'Open', reason: `Due on ${record.dueDate}` }
}

export function classifyVendorLineItem(record, reportingDate) {
  return getVendorLineItemStatusDetails(record, reportingDate).status
}

async function fetchVendorLineItems({ client = axios, maxRecords = MAX_RECORDS } = {}) {
  if (!isSapConfigured()) throw new IntegrationError('SAP vendor line-item retrieval is not configured.', 503, 'configuration_error')
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_RECORDS) throw new IntegrationError(`maxRecords must be 1 to ${MAX_RECORDS}.`, 400)
  const records = []
  let continuation = null
  let skip = 0
  let fetched = 0
  const params = { '$format': 'json', '$select': LINE_FIELDS.join(','), '$inlinecount': 'allpages', '$top': PAGE_SIZE }
  const headers = { Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate', ...(config.sap.client ? { 'sap-client': config.sap.client } : {}) }
  const auth = { username: config.sap.username, password: config.sap.password }
  try {
    while (records.length < maxRecords) {
      const response = await client.get(continuation || entityUrl(), {
        auth, headers, maxRedirects: 0, timeout: 30000,
        ...(continuation ? {} : { params: { ...params, '$skip': skip } }),
      })
      const body = response.data?.d
      if (!body || !Array.isArray(body.results)) throw new IntegrationError('SAP returned a malformed vendor line-item response.', 502, 'invalid_data')
      const page = body.results
      if (page.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) throw new IntegrationError('SAP returned a malformed vendor line-item response.', 502, 'invalid_data')
      const mapped = page.map(mapVendorLineItem)
      fetched += mapped.length
      const unique = new Map(records.map((record) => [record.id, record]))
      for (const record of mapped) {
        const previous = unique.get(record.id)
        if (previous && JSON.stringify(previous) !== JSON.stringify(record)) throw new IntegrationError('SAP returned conflicting duplicate vendor line-item records.', 502, 'invalid_data')
        unique.set(record.id, record)
      }
      records.length = 0
      records.push(...unique.values())
      if (records.length >= maxRecords) break
      const next = text(body.__next)
      if (next) {
        const nextUrl = new URL(next, serviceUrl())
        if (nextUrl.origin !== origin()) throw new IntegrationError('SAP line-item continuation URL was outside the trusted SAP origin.', 502, 'invalid_data')
        continuation = nextUrl.toString()
        continue
      }
      if (page.length < PAGE_SIZE || fetched >= maxRecords) break
      skip += page.length
    }
    return { records: records.slice(0, maxRecords), sourceService: 'FAP_VENDOR_LINE_ITEMS_SRV', sourceEntity: 'Items', metadataUrl: metadataUrl(), lastSuccessfulRefresh: new Date().toISOString(), hasMore: false }
  } catch (error) { return axiosError(error, 'vendor line-item retrieval') }
}

export async function getVendorLineItems({ client = axios, maxRecords = MAX_RECORDS } = {}) {
  const cacheKey = String(maxRecords)
  const cached = lineItemCache.get(cacheKey)
  if (cached && Date.now() - cached.cachedAt < LINE_ITEM_CACHE_TTL_MS) return cached.value
  if (lineItemInflight.has(cacheKey)) return lineItemInflight.get(cacheKey)
  const promise = fetchVendorLineItems({ client, maxRecords })
    .then((value) => {
      lineItemCache.set(cacheKey, { cachedAt: Date.now(), value })
      if (lineItemCache.size > 20) {
        const oldestKey = lineItemCache.keys().next().value
        lineItemCache.delete(oldestKey)
      }
      return value
    })
    .finally(() => lineItemInflight.delete(cacheKey))
  lineItemInflight.set(cacheKey, promise)
  return promise
}

export function calculateVendorLineItemSummary(records, { reportingDate, upcomingDays = 30 } = {}) {
  const report = text(reportingDate) || new Date().toISOString().slice(0, 10)
  const horizon = new Date(`${report}T00:00:00Z`)
  horizon.setUTCDate(horizon.getUTCDate() + upcomingDays)
  const horizonEnd = horizon.toISOString().slice(0, 10)

  const unique = new Map()
  for (const record of records) {
    if (!record?.id || unique.has(record.id)) continue
    unique.set(record.id, record)
  }

  // Collect all distinct active currencies across all records
  const allCurrencies = new Set()
  for (const record of unique.values()) {
    if (record.currency) allCurrencies.add(record.currency)
  }
  const currenciesList = [...allCurrencies].sort()

  const totals = { outstanding: {}, overdue: {}, upcoming: {} }
  const counts = { outstanding: {}, overdue: {}, upcoming: {} }
  let totalOutstandingItems = 0
  let totalOverdueItems = 0
  let totalUpcomingItems = 0
  let supportedItemPresent = false
  let openVerificationFailed = false
  let dueAvailable = true
  const suppliersWithOutstandingBalances = new Set()
  let clearedAccountingItemsCount = 0

  for (const c of currenciesList) {
    totals.outstanding[c] = '0'
    totals.overdue[c] = '0'
    totals.upcoming[c] = '0'
    counts.outstanding[c] = 0
    counts.overdue[c] = 0
    counts.upcoming[c] = 0
  }

  for (const record of unique.values()) {
    if (record.isClearingReversed || isExcludedVendorItem(record)) continue
    supportedItemPresent = true

    if (isClearedVendorItem(record)) {
      clearedAccountingItemsCount += 1
      continue
    }

    const amount = verifiedOpenAmount(record)
    const currency = record.currency
    if (!amount || !currency) {
      openVerificationFailed = true
      continue
    }

    if (record.supplierId) {
      suppliersWithOutstandingBalances.add(record.supplierId)
    }

    totals.outstanding[currency] = addDecimal(totals.outstanding[currency] || '0', amount)
    counts.outstanding[currency] = (counts.outstanding[currency] || 0) + 1
    totalOutstandingItems += 1

    if (record.dueDate) {
      if (record.dueDate < report) {
        totals.overdue[currency] = addDecimal(totals.overdue[currency] || '0', amount)
        counts.overdue[currency] = (counts.overdue[currency] || 0) + 1
        totalOverdueItems += 1
      } else if (record.dueDate <= horizonEnd) {
        totals.upcoming[currency] = addDecimal(totals.upcoming[currency] || '0', amount)
        counts.upcoming[currency] = (counts.upcoming[currency] || 0) + 1
        totalUpcomingItems += 1
      }
    } else {
      dueAvailable = false
    }
  }

  const hasVerifiedOpenEvidence = supportedItemPresent && !openVerificationFailed
  const hasDueEvidence = hasVerifiedOpenEvidence && dueAvailable

  // Build byCurrency array helper
  const buildByCurrency = (amountMap, countMap) => {
    return currenciesList.map((currency) => ({
      currency,
      amount: Number(amountMap[currency] || '0'),
      count: countMap[currency] || 0,
    }))
  }

  const outstandingByCurr = buildByCurrency(totals.outstanding, counts.outstanding)
  const overdueByCurr = buildByCurrency(totals.overdue, counts.overdue)
  const upcomingByCurr = buildByCurrency(totals.upcoming, counts.upcoming)

  const metrics = {
    totalOutstandingAmount: {
      available: hasVerifiedOpenEvidence,
      byCurrency: hasVerifiedOpenEvidence ? outstandingByCurr : [],
      reason: hasVerifiedOpenEvidence ? undefined : 'Open balance or direction fields could not be verified on all matching open items',
    },
    overdueAmount: {
      available: hasDueEvidence,
      byCurrency: hasDueEvidence ? overdueByCurr : [],
      reason: hasDueEvidence ? undefined : 'Authoritative due dates and open status required',
    },
    overdueItems: {
      available: hasDueEvidence,
      totalCount: hasDueEvidence ? totalOverdueItems : null,
      byCurrency: hasDueEvidence ? overdueByCurr : [],
      reason: hasDueEvidence ? undefined : 'Authoritative due dates and open status required',
    },
    upcomingPaymentObligations: {
      available: hasDueEvidence,
      byCurrency: hasDueEvidence ? upcomingByCurr : [],
      reason: hasDueEvidence ? undefined : 'Authoritative due dates required for upcoming obligations',
    },
    completedPayments: {
      available: false,
      byCurrency: [],
      reason: 'Clearing evidence identifies a cleared accounting item; it does not independently prove a completed supplier payment.',
    },
    outstandingItems: {
      available: hasVerifiedOpenEvidence,
      totalCount: hasVerifiedOpenEvidence ? totalOutstandingItems : null,
      byCurrency: hasVerifiedOpenEvidence ? outstandingByCurr : [],
      reason: hasVerifiedOpenEvidence ? undefined : 'Stable item identity and open status required',
    },
    suppliersWithOutstandingBalances: {
      available: hasVerifiedOpenEvidence,
      totalCount: hasVerifiedOpenEvidence ? suppliersWithOutstandingBalances.size : null,
      byCurrency: [],
      reason: hasVerifiedOpenEvidence ? undefined : 'Distinct supplier IDs require verified open balances and currencies',
    },
    clearedAccountingItems: {
      available: supportedItemPresent,
      totalCount: supportedItemPresent ? clearedAccountingItemsCount : null,
      byCurrency: [],
      reason: supportedItemPresent ? undefined : 'Clearing evidence fields are required to count cleared accounting items',
    },
  }

  const metricStatus = {
    totalOutstandingAmount: metrics.totalOutstandingAmount.available ? 'available' : 'unavailable',
    overdueAmount: metrics.overdueAmount.available ? 'available' : 'unavailable',
    overdueItems: metrics.overdueItems.available ? 'available' : 'unavailable',
    upcomingPaymentObligations: metrics.upcomingPaymentObligations.available ? 'available' : 'unavailable',
    completedPayments: 'unavailable',
    outstandingItems: metrics.outstandingItems.available ? 'available' : 'unavailable',
    suppliersWithOutstandingBalances: metrics.suppliersWithOutstandingBalances.available ? 'available' : 'unavailable',
    clearedAccountingItems: metrics.clearedAccountingItems.available ? 'available' : 'unavailable',
  }

  return {
    status: Object.values(metricStatus).includes('available') ? 'partially_available' : 'unavailable',
    reportingDate: report,
    upcomingDays,
    sourceService: 'FAP_VENDOR_LINE_ITEMS_SRV',
    sourceEntity: 'Items',
    metrics,
    metricStatus,
    amounts: {
      outstandingByCurrency: totals.outstanding,
      overdueByCurrency: totals.overdue,
      upcomingByCurrency: totals.upcoming,
    },
    counts: {
      outstandingItems: totalOutstandingItems,
      overdueItems: totalOverdueItems,
      upcomingItems: totalUpcomingItems,
      completedPayments: 0,
      suppliersWithOutstandingBalances: suppliersWithOutstandingBalances.size,
      clearedAccountingItems: clearedAccountingItemsCount,
    },
    limitations: [
      'Clearing evidence identifies a cleared accounting item; it does not independently prove a completed supplier payment.',
      'Amounts use signed transaction or balance amounts with debit/credit direction per standard AP subledger rules.',
      'NetDueDate is authoritative when present. Items lacking authoritative due dates are excluded from date-based totals.',
      'Reversed items and noted items (such as down payment requests) do not affect accounting balances.',
      'Currencies are reported separately and never converted or combined.',
      'Completed payment metrics remain unavailable because payment and clearing semantics require clearing document header verification.',
    ],
  }
}

export function filterVendorLineItems(records, filters = {}, reportingDate) {
  const search = text(filters.search)?.toLowerCase() || ''
  const supplierId = text(filters.supplierId)
  const supplierName = text(filters.supplierName)?.toLowerCase() || ''
  const companyCode = text(filters.companyCode)
  const currency = text(filters.currency)?.toUpperCase()
  const status = text(filters.paymentStatus)
  const report = text(reportingDate) || new Date().toISOString().slice(0, 10)

  return records.filter((record) => {
    if (
      search &&
      ![
        record.supplierId,
        record.supplierName,
        record.accountingDocument,
        record.accountingDocumentItem,
        record.invoiceReference,
        record.id,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(search))
    ) {
      return false
    }
    if (supplierId && !matchesSapIdentifier(record.supplierId, supplierId)) return false
    if (supplierName && !String(record.supplierName || '').toLowerCase().includes(supplierName)) return false
    if (companyCode && !matchesSapIdentifier(record.companyCode, companyCode)) return false
    if (currency && record.currency !== currency && record.balanceCurrency !== currency && record.transactionCurrency !== currency) {
      return false
    }
    if (filters.documentDateFrom && (!record.documentDate || record.documentDate < filters.documentDateFrom)) return false
    if (filters.documentDateTo && (!record.documentDate || record.documentDate > filters.documentDateTo)) return false
    if (filters.dueDateFrom && (!record.dueDate || record.dueDate < filters.dueDateFrom)) return false
    if (filters.dueDateTo && (!record.dueDate || record.dueDate > filters.dueDateTo)) return false

    const filterAmount = record.grossAmount ?? (record.signedAmount ? record.signedAmount.replace(/^-/, '') : null)
    if (filters.minAmount && (!filterAmount || compareDecimal(filterAmount, filters.minAmount) < 0)) return false
    if (filters.maxAmount && (!filterAmount || compareDecimal(filterAmount, filters.maxAmount) > 0)) return false

    if (status) {
      const classification = classifyVendorLineItem(record, report)
      if (status === 'Open' && classification !== 'Open') return false
      if (status === 'Overdue' && classification !== 'Overdue') return false
      if (status === 'Cleared' && classification !== 'Cleared') return false
      if (status === 'Reversed' && classification !== 'Reversed') return false
      if (status === 'Excluded' && classification !== 'Excluded') return false
      if (status === 'Unverified' && classification !== 'Unverified') return false
    }
    return true
  })
}

export async function checkVendorLineItemsAvailability({ client = axios } = {}) {
  try {
    const response = await client.get(serviceUrl(), {
      auth: { username: config.sap.username, password: config.sap.password },
      headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate', ...(config.sap.client ? { 'sap-client': config.sap.client } : {}) },
      maxRedirects: 0,
      timeout: 15000,
      params: { '$format': 'json' },
    })
    const sets = response.data?.d?.EntitySets
    if (!Array.isArray(sets) || !sets.includes('Items')) return { status: 'unavailable', reason: 'FAP_VENDOR_LINE_ITEMS_SRV does not expose Items.' }
    const sample = await getVendorLineItems({ client, maxRecords: 100 })
    return { status: sample.records.length ? 'available' : 'empty', recordCount: sample.records.length, reason: 'FAP_VENDOR_LINE_ITEMS_SRV Items is accessible by authenticated read-only GET.' }
  } catch (error) {
    if (error instanceof IntegrationError) return { status: 'unavailable', reason: error.message, errorCategory: error.code }
    return { status: 'unavailable', reason: 'The vendor line-item service could not be verified.', errorCategory: 'unknown' }
  }
}
