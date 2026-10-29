import axios from 'axios'
import { config, isSapConfigured } from '../config.js'
import { IntegrationError } from './sapService.js'

const MAX_RECORDS = 5000
const PAGE_SIZE = 100
const LINE_ITEM_CACHE_TTL_MS = 60 * 1000
const lineItemCache = new Map()
const lineItemInflight = new Map()
const PAYABLE_TYPES = new Set(['KR', 'RE'])
const CREDIT_TYPES = new Set(['KG'])
const SUPPORTED_TYPES = new Set([...PAYABLE_TYPES, ...CREDIT_TYPES])
const LINE_FIELDS = [
  'Supplier','SupplierName','CompanyCode','AccountingDocument','AccountingDocumentItem','FiscalYear',
  'AccountingDocumentType','DebitCreditCode','DocumentDate','PostingDate','InvoiceReference',
  'AmountInTransactionCurrency','TransactionCurrency','AmountInBalanceTransactionCurrency','BalanceTransactionCurrency',
  'AmountInPaymentCurrency','PaymentCurrency','NetDueDate','ClearingStatus','ClearingDate',
  'ClearingAccountingDocument','ClearingDocFiscalYear','HasClearingAccountingDocument','IsCleared','IsClearingReversed'
]

function text(value) { return typeof value === 'string' && value.trim() ? value.trim() : null }
function sapDate(value) {
  if (typeof value !== 'string') return null
  const match = /^\/Date\((\d+)(?:[-+]\d{4})?\)\/$/.exec(value)
  if (!match) return null
  const date = new Date(Number(match[1]))
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null
}
function decimal(value) {
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
function isX(value) { return text(value)?.toUpperCase() === 'X' }
function path() { return text(config.sap.lineItemsOdataPath) || '/FAP_VENDOR_LINE_ITEMS_SRV' }
function origin() {
  const url = new URL(config.sap.baseUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new IntegrationError('SAP line-item base URL is invalid.', 503, 'configuration_error')
  }
  return url.origin
}
function serviceUrl() { return new URL(`${path().replace(/\/$/, '')}/`, origin()).toString() }
function entityUrl() { return new URL(`${path().replace(/\/$/, '')}/Items`, origin()).toString() }
function metadataUrl() { return new URL(`${path().replace(/\/$/, '')}/$metadata`, origin()).toString() }

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

export function mapVendorLineItem(row) {
  const supplier = text(row.Supplier)
  const companyCode = text(row.CompanyCode)
  const accountingDocument = text(row.AccountingDocument)
  const item = text(row.AccountingDocumentItem)
  const fiscalYear = text(row.FiscalYear)
  if (!supplier || !companyCode || !accountingDocument || !item || !fiscalYear) {
    throw new IntegrationError('SAP vendor line item lacks a stable accounting key or supplier.', 502, 'invalid_data')
  }
  return {
    id: `${companyCode}_${fiscalYear}_${accountingDocument}_${item}`,
    supplierId: supplier,
    supplierName: text(row.SupplierName),
    companyCode,
    accountingDocument,
    accountingDocumentItem: item,
    fiscalYear,
    accountingDocumentType: text(row.AccountingDocumentType),
    debitCreditCode: text(row.DebitCreditCode),
    documentDate: sapDate(row.DocumentDate),
    postingDate: sapDate(row.PostingDate),
    invoiceReference: text(row.InvoiceReference),
    balanceAmount: decimal(row.AmountInBalanceTransactionCurrency),
    balanceCurrency: text(row.BalanceTransactionCurrency),
    transactionAmount: decimal(row.AmountInTransactionCurrency),
    transactionCurrency: text(row.TransactionCurrency),
    paymentAmount: decimal(row.AmountInPaymentCurrency),
    paymentCurrency: text(row.PaymentCurrency),
    dueDate: sapDate(row.NetDueDate),
    clearingStatus: text(row.ClearingStatus),
    clearingDate: sapDate(row.ClearingDate),
    clearingDocument: text(row.ClearingAccountingDocument),
    clearingDocFiscalYear: text(row.ClearingDocFiscalYear),
    hasClearingDocument: isX(row.HasClearingAccountingDocument),
    isCleared: isX(row.IsCleared),
    isClearingReversed: isX(row.IsClearingReversed),
    dataSource: 'live'
  }
}

export function isClearedVendorItem(record) {
  return record.isCleared || record.hasClearingDocument || Boolean(record.clearingDocument && record.clearingDate) || record.clearingStatus === '1'
}

export function isSupportedVendorPayable(record) {
  return SUPPORTED_TYPES.has(record.accountingDocumentType) && !record.isClearingReversed && Boolean(record.supplierId)
}

export function verifiedOpenAmount(record) {
  if (!isSupportedVendorPayable(record) || isClearedVendorItem(record) || !record.balanceAmount || !record.balanceCurrency) return null
  if (record.debitCreditCode !== 'H' && record.debitCreditCode !== 'S') return null
  const unsigned = record.balanceAmount.replace(/^-/, '')
  if (PAYABLE_TYPES.has(record.accountingDocumentType)) return record.debitCreditCode === 'S' ? unsigned : null
  if (CREDIT_TYPES.has(record.accountingDocumentType)) return record.debitCreditCode === 'H' ? `-${unsigned}` : null
  return null
}

export function classifyVendorLineItem(record, reportingDate) {
  if (record.isClearingReversed) return 'Reversed'
  if (!isSupportedVendorPayable(record)) return 'Excluded'
  if (isClearedVendorItem(record)) return 'Cleared'
  if (!verifiedOpenAmount(record)) return 'Open status not verified'
  if (!record.dueDate) return 'Open'
  const report = text(reportingDate) || new Date().toISOString().slice(0, 10)
  return record.dueDate < report ? 'Overdue' : 'Open'
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
        auth, headers, maxRedirects: 0, timeout: 15000,
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
  const totals = { outstanding: {}, overdue: {}, upcoming: {} }
  const counts = { outstanding: 0, overdue: 0, upcoming: 0, completed: 0 }
  const unique = new Map()
  for (const record of records) {
    if (!record?.id || unique.has(record.id)) continue
    unique.set(record.id, record)
  }

  let openAvailable = true
  let dueAvailable = true
  let supportedItemPresent = false
  for (const record of unique.values()) {
    if (record.isClearingReversed || !SUPPORTED_TYPES.has(record.accountingDocumentType)) continue
    supportedItemPresent = true
    if (isClearedVendorItem(record)) continue

    const amount = verifiedOpenAmount(record)
    if (!amount || !record.balanceCurrency) {
      openAvailable = false
      dueAvailable = false
      continue
    }
    totals.outstanding[record.balanceCurrency] = addDecimal(totals.outstanding[record.balanceCurrency] || '0', amount)
    counts.outstanding += 1

    if (!record.dueDate) {
      dueAvailable = false
      continue
    }
    if (record.dueDate < report) {
      totals.overdue[record.balanceCurrency] = addDecimal(totals.overdue[record.balanceCurrency] || '0', amount)
      counts.overdue += 1
    } else if (record.dueDate <= horizonEnd) {
      totals.upcoming[record.balanceCurrency] = addDecimal(totals.upcoming[record.balanceCurrency] || '0', amount)
      counts.upcoming += 1
    }
  }

  const hasVerifiedOpenEvidence = supportedItemPresent && openAvailable
  const metricStatus = {
    totalOutstandingAmount: hasVerifiedOpenEvidence ? 'available' : (supportedItemPresent ? 'unavailable' : 'unavailable'),
    overdueAmount: hasVerifiedOpenEvidence && dueAvailable ? 'available' : 'unavailable',
    upcomingPaymentObligations: hasVerifiedOpenEvidence && dueAvailable ? 'available' : 'unavailable',
    completedPayments: 'unavailable',
    outstandingItems: hasVerifiedOpenEvidence ? 'available' : 'unavailable',
  }
  return {
    status: Object.values(metricStatus).includes('available') ? 'partially_available' : 'unavailable',
    reportingDate: report,
    upcomingDays,
    sourceService: 'FAP_VENDOR_LINE_ITEMS_SRV',
    sourceEntity: 'Items',
    metricStatus,
    amounts: { outstandingByCurrency: totals.outstanding, overdueByCurrency: totals.overdue, upcomingByCurrency: totals.upcoming },
    counts: { outstandingItems: counts.outstanding, overdueItems: counts.overdue, upcomingItems: counts.upcoming, completedPayments: counts.completed },
    limitations: [
      'Clearing evidence identifies a cleared accounting item; it does not independently prove a completed supplier payment.',
      'KR and RE supplier payables and KG credit adjustments are supported only when the balance currency, balance amount, debit/credit direction, and accounting type are populated.',
      'Amounts use AmountInBalanceTransactionCurrency and debit/credit direction; PaymentCurrency and AmountInPaymentCurrency are not used as open balances.',
      'NetDueDate is used only when present. Missing due dates prevent overdue and upcoming verification.',
      'Reversed items and unsupported accounting document types are excluded.',
      'Currencies are reported separately and never converted.',
      'Completed payment metrics are unavailable because payment and clearing semantics have not been fully verified tenant-wide.'
    ]
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
    if (search && ![record.supplierId, record.supplierName, record.accountingDocument, record.accountingDocumentItem, record.invoiceReference, record.id]
      .filter(Boolean).some((value) => String(value).toLowerCase().includes(search))) return false
    if (supplierId && record.supplierId !== supplierId) return false
    if (supplierName && !String(record.supplierName || '').toLowerCase().includes(supplierName)) return false
    if (companyCode && record.companyCode !== companyCode) return false
    if (currency && record.balanceCurrency !== currency && record.transactionCurrency !== currency) return false
    if (filters.documentDateFrom && (!record.documentDate || record.documentDate < filters.documentDateFrom)) return false
    if (filters.documentDateTo && (!record.documentDate || record.documentDate > filters.documentDateTo)) return false
    if (filters.dueDateFrom && (!record.dueDate || record.dueDate < filters.dueDateFrom)) return false
    if (filters.dueDateTo && (!record.dueDate || record.dueDate > filters.dueDateTo)) return false
    const filterAmount = verifiedOpenAmount(record) ?? record.balanceAmount
    if (filters.minAmount && (!filterAmount || compareDecimal(filterAmount.replace(/^-/, ''), filters.minAmount) < 0)) return false
    if (filters.maxAmount && (!filterAmount || compareDecimal(filterAmount.replace(/^-/, ''), filters.maxAmount) > 0)) return false
    if (status) {
      const classification = classifyVendorLineItem(record, report)
      if (status === 'Open' && classification !== 'Open') return false
      if (status === 'Overdue' && classification !== 'Overdue') return false
      if (status === 'Cleared' && classification !== 'Cleared') return false
      if (status === 'Reversed' && classification !== 'Reversed') return false
      if (status === 'Unverified' && classification !== 'Open status not verified') return false
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
