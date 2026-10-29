import axios from 'axios'
import { isDeepStrictEqual } from 'node:util'
import { config, isSapConfigured } from '../config.js'
import {
  getODataServiceEntitySets,
  IntegrationError,
  getSapServiceRootUrl,
} from './sapService.js'
import { mockSupplierPayments } from './mockSupplierPayments.js'
import {
  getVendorLineItems,
  calculateVendorLineItemSummary,
  classifyVendorLineItem,
  verifiedOpenAmount,
  isSupportedVendorPayable,
  filterVendorLineItems,
} from './vendorLineItemsService.js'

const PAYMENT_STATUSES = new Set(['Paid', 'Pending', 'Overdue', 'Unknown', 'Open', 'Cleared', 'Unverified', 'Reversed'])
const FILTER_KEYS = new Set([
  'search',
  'supplierId',
  'supplierName',
  'paymentStatus',
  'invoiceStatus',
  'companyCode',
  'currency',
  'dueDateFrom',
  'dueDateTo',
  'documentDateFrom',
  'documentDateTo',
  'postingDateFrom',
  'postingDateTo',
  'minAmount',
  'maxAmount',
  'top',
  'skip',
])
const DEMO_LIMITATIONS = [
  'All records are fictional demonstration data, not SAP accounting documents.',
  'Document dates and payment references are unavailable in the demonstration dataset.',
  'The demonstration payment statuses and clearing dates are not verified SAP clearing evidence.',
]
const SAP_INVOICE_ENTITY_SET = 'A_SupplierInvoice'
const SAP_INVOICE_FIELDS = [
  'SupplierInvoice',
  'FiscalYear',
  'CompanyCode',
  'DocumentDate',
  'PostingDate',
  'SupplierInvoiceIDByInvcgParty',
  'InvoicingParty',
  'DocumentCurrency',
  'InvoiceGrossAmount',
  'PaymentTerms',
  'DueCalculationBaseDate',
  'NetPaymentDays',
  'PaymentBlockingReason',
  'SupplierInvoiceStatus',
  'PaymentReference',
  'InvoiceReference',
]
const SAP_INVOICE_LIMITATIONS = [
  'Supplier names are not exposed by the verified A_SupplierInvoice entity and are unavailable.',
  'A verified invoice due-date field is unavailable; baseline date and payment-term fields are not interpreted as a due date.',
  'SupplierInvoiceStatus is an invoice-document status, not verified payment or clearing status.',
]
const MAX_SUMMARY_RECORDS = 10000
const paymentSummaryCache = new Map()
const PAYMENT_SUMMARY_CACHE_TTL_MS = 60 * 1000

function getCachedPaymentSummary(key) {
  const cached = paymentSummaryCache.get(key)
  if (!cached || Date.now() - cached.cachedAt >= PAYMENT_SUMMARY_CACHE_TTL_MS) return null
  return cached.value
}

function setCachedPaymentSummary(key, value) {
  paymentSummaryCache.set(key, { cachedAt: Date.now(), value })
  if (paymentSummaryCache.size > 50) {
    const oldestKey = paymentSummaryCache.keys().next().value
    paymentSummaryCache.delete(oldestKey)
  }
}

function parseBoundedInteger(value, name, min, max) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new IntegrationError(`${name} must be an integer between ${min} and ${max}.`, 400)
  }
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new IntegrationError(`${name} must be an integer between ${min} and ${max}.`, 400)
  }
  return number
}

function validateDate(value, name) {
  if (!value) return ''
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  ) {
    throw new IntegrationError(`${name} must be a valid date in YYYY-MM-DD format.`, 400)
  }
  return value
}

function parseAmount(value, name) {
  if (value === undefined) return null
  if (
    typeof value !== 'string' ||
    !/^\d{1,12}(?:\.\d{1,2})?$/.test(value) ||
    !Number.isFinite(Number(value))
  ) {
    throw new IntegrationError(`${name} must be a non-negative amount with at most two decimals.`, 400)
  }
  return Number(value)
}

function hasUsableDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const timestamp = Date.parse(`${value}T00:00:00Z`)
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value
  )
}

export function validatePaymentFilters(filters = {}) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
    throw new IntegrationError('Query parameters must be an object.', 400)
  }
  if (Object.keys(filters).some((key) => !FILTER_KEYS.has(key))) {
    throw new IntegrationError('One or more query parameters are not supported.', 400)
  }
  for (const value of Object.values(filters)) {
    if (Array.isArray(value) || typeof value !== 'string') {
      throw new IntegrationError('Query parameters must be single string values.', 400)
    }
  }

  const {
    search = '',
    supplierId = '',
    supplierName = '',
    paymentStatus = '',
    companyCode = '',
    currency = '',
    invoiceStatus = '',
  } = filters
  if (search.length > 100 || /[\u0000-\u001f\u007f]/.test(search)) {
    throw new IntegrationError('Search must be 100 characters or fewer and contain no control characters.', 400)
  }
  if (supplierId && !/^[A-Za-z0-9_-]{1,40}$/.test(supplierId)) {
    throw new IntegrationError('Supplier identifier has an invalid format.', 400)
  }
  if (supplierName.length > 100 || /[\u0000-\u001f\u007f]/.test(supplierName)) {
    throw new IntegrationError('Supplier name is invalid.', 400)
  }
  if (paymentStatus && !PAYMENT_STATUSES.has(paymentStatus)) {
    throw new IntegrationError('Status must be a supported invoice or accounting status.', 400)
  }
  if (companyCode && !/^[A-Za-z0-9_-]{1,10}$/.test(companyCode)) {
    throw new IntegrationError('Company code has an invalid format.', 400)
  }
  if (currency && !/^[A-Za-z]{3}$/.test(currency)) {
    throw new IntegrationError('Currency must be a three-letter code.', 400)
  }
  if (invoiceStatus && (!/^[A-Za-z0-9_-]{1,20}$/.test(invoiceStatus))) {
    throw new IntegrationError('Invoice document status has an invalid format.', 400)
  }

  const dueDateFrom = validateDate(filters.dueDateFrom, 'dueDateFrom')
  const dueDateTo = validateDate(filters.dueDateTo, 'dueDateTo')
  if (dueDateFrom && dueDateTo && dueDateFrom > dueDateTo) {
    throw new IntegrationError('dueDateFrom must be on or before dueDateTo.', 400)
  }
  const documentDateFrom = validateDate(filters.documentDateFrom, 'documentDateFrom')
  const documentDateTo = validateDate(filters.documentDateTo, 'documentDateTo')
  const postingDateFrom = validateDate(filters.postingDateFrom, 'postingDateFrom')
  const postingDateTo = validateDate(filters.postingDateTo, 'postingDateTo')
  for (const pair of [[documentDateFrom, documentDateTo, 'documentDate'], [postingDateFrom, postingDateTo, 'postingDate']]) {
    if (pair[0] && pair[1] && pair[0] > pair[1]) {
      throw new IntegrationError(`${pair[2]}From must be on or before ${pair[2]}To.`, 400)
    }
  }
  const minAmount = parseAmount(filters.minAmount, 'minAmount')
  const maxAmount = parseAmount(filters.maxAmount, 'maxAmount')
  if (minAmount !== null && maxAmount !== null && minAmount > maxAmount) {
    throw new IntegrationError('minAmount must be less than or equal to maxAmount.', 400)
  }

  return {
    search: search.trim(),
    supplierId,
    supplierName: supplierName.trim(),
    paymentStatus,
    companyCode,
    currency: currency.toUpperCase(),
    invoiceStatus,
    dueDateFrom,
    dueDateTo,
    documentDateFrom,
    documentDateTo,
    postingDateFrom,
    postingDateTo,
    minAmount,
    maxAmount,
    top: parseBoundedInteger(filters.top ?? '25', 'top', 1, 100),
    skip: parseBoundedInteger(filters.skip ?? '0', 'skip', 0, 1000000),
  }
}

export function getDemoPaymentObligations() {
  const records = mockSupplierPayments.map((payment) => ({
    ...payment,
    documentReference: payment.invoiceReference || null,
    documentDate: null,
    amount: payment.invoiceAmount,
    clearingDate: payment.paymentDate,
    paymentReference: null,
    dataSource: 'demo',
    dataMode: 'demo',
    limitations: DEMO_LIMITATIONS,
  }))
  return deduplicatePaymentObligations(records)
}

export function deduplicatePaymentObligations(records) {
  const byId = new Map()
  for (const record of records) {
    if (!record || typeof record.id !== 'string' || !record.id) {
      throw new IntegrationError('Payment data contained a record without a stable identifier.', 502, 'invalid_data')
    }
    const previous = byId.get(record.id)
    if (previous && !isDeepStrictEqual(previous, record)) {
      throw new IntegrationError('Payment data contained conflicting duplicate records.', 502, 'invalid_data')
    }
    byId.set(record.id, record)
  }
  return [...byId.values()]
}

export function filterPaymentObligations(records, filters = {}) {
  const validated = validatePaymentFilters(filters)
  const search = validated.search.toLocaleLowerCase()
  return deduplicatePaymentObligations(records).filter((record) => {
    const amount = typeof record.amount === 'number' ? record.amount : record.invoiceAmount
    const hasUsableAmount = typeof amount === 'number' && Number.isFinite(amount)
    const matchesSearch =
      !search ||
      [
        record.id,
        record.supplierId,
        record.supplierName,
        record.documentReference,
        record.invoiceReference,
        record.companyCode,
        record.currency,
        amount?.toString() ?? '',
        record.dueDate,
        record.paymentStatus,
        record.paymentReference,
      ].some((value) => String(value ?? '').toLocaleLowerCase().includes(search))
    return (
      matchesSearch &&
      (!validated.supplierId || record.supplierId === validated.supplierId) &&
      (!validated.paymentStatus || record.paymentStatus === validated.paymentStatus) &&
      (!validated.companyCode || record.companyCode === validated.companyCode) &&
      (!validated.currency || record.currency === validated.currency) &&
      (!validated.dueDateFrom || (record.dueDate && record.dueDate >= validated.dueDateFrom)) &&
      (!validated.dueDateTo || (record.dueDate && record.dueDate <= validated.dueDateTo)) &&
      (validated.minAmount === null || (hasUsableAmount && amount >= validated.minAmount)) &&
      (validated.maxAmount === null || (hasUsableAmount && amount <= validated.maxAmount))
    )
  })
}

export function filterDemoPayments(filters = {}) {
  return filterPaymentObligations(getDemoPaymentObligations(), filters)
}

function addCurrencyAmount(totals, currency, amount) {
  if (!currency || typeof amount !== 'number' || !Number.isFinite(amount)) return
  totals[currency] = Math.round(((totals[currency] ?? 0) + amount) * 100) / 100
}

function todayAsUtcDate(now) {
  return new Date(now).toISOString().slice(0, 10)
}

export function calculatePaymentSummary(records, { now = new Date(), upcomingDays = config.upcomingDays } = {}) {
  const uniqueRecords = deduplicatePaymentObligations(records)
  const today = todayAsUtcDate(now)
  const upcomingEnd = new Date(`${today}T00:00:00Z`)
  upcomingEnd.setUTCDate(upcomingEnd.getUTCDate() + upcomingDays)
  const upcomingThrough = upcomingEnd.toISOString().slice(0, 10)
  const summary = {
    outstandingAmountByCurrency: {},
    overdueAmountByCurrency: {},
    upcomingObligationAmountByCurrency: {},
    completedPaymentAmountByCurrency: {},
    outstandingItemCount: 0,
    overdueItemCount: 0,
    upcomingObligationCount: 0,
    completedPaymentCount: 0,
    upcomingDays,
    upcomingPeriod: { from: today, through: upcomingThrough },
    limitations: [],
  }
  const limitations = new Set()

  for (const record of uniqueRecords) {
    const amount = typeof record.amount === 'number' ? record.amount : record.invoiceAmount
    const currency = typeof record.currency === 'string' ? record.currency : ''
    const usableAmount =
      typeof amount === 'number' &&
      Number.isFinite(amount) &&
      amount >= 0 &&
      /^[A-Z]{3}$/.test(currency)
    const hasDueDate = hasUsableDate(record.dueDate)
    const unpaid = record.paymentStatus === 'Pending' || record.paymentStatus === 'Overdue'

    if (unpaid) {
      summary.outstandingItemCount += 1
      if (usableAmount) addCurrencyAmount(summary.outstandingAmountByCurrency, currency, amount)
      else limitations.add('Some outstanding records have no usable amount or currency.')
      if (hasDueDate && record.dueDate < today) {
        summary.overdueItemCount += 1
        if (usableAmount) addCurrencyAmount(summary.overdueAmountByCurrency, currency, amount)
      } else if (hasDueDate && record.dueDate >= today && record.dueDate <= upcomingThrough) {
        summary.upcomingObligationCount += 1
        if (usableAmount) {
          addCurrencyAmount(summary.upcomingObligationAmountByCurrency, currency, amount)
        }
      } else if (!hasDueDate) {
        limitations.add('Some outstanding records have no usable due date and are excluded from date-based totals.')
      }
    } else if (record.paymentStatus === 'Paid') {
      summary.completedPaymentCount += 1
      if (usableAmount) addCurrencyAmount(summary.completedPaymentAmountByCurrency, currency, amount)
      else limitations.add('Some completed records have no usable amount or currency.')
    } else {
      limitations.add('Some records have unknown payment status and are excluded from financial status totals.')
    }

    for (const field of ['supplierId', 'companyCode', 'documentReference', 'currency']) {
      if (!record[field]) limitations.add(`Some records are missing ${field}.`)
    }
  }
  summary.totalOutstandingAmountByCurrency = summary.outstandingAmountByCurrency
  summary.limitations = [
    ...new Set([
      ...(uniqueRecords.some((record) => record.dataSource === 'demo') ? DEMO_LIMITATIONS : []),
      ...limitations,
    ]),
  ]
  return summary
}

export function getDemoPaymentSummary(filters = {}, options = {}) {
  const records = filterPaymentObligations(getDemoPaymentObligations(), filters)
  const calculated = calculatePaymentSummary(records, options)
  const currencies = [...new Set(records.map((record) => record.currency).filter(Boolean))]
  const singleCurrency = currencies.length === 1 ? currencies[0] : null
  return {
    ...calculated,
    invoiceCount: records.length,
    totalInvoiced: singleCurrency
      ? records.reduce((sum, record) => sum + record.amount, 0)
      : null,
    paidAmount: singleCurrency
      ? calculated.completedPaymentAmountByCurrency[singleCurrency] ?? 0
      : null,
    outstandingAmount:
      singleCurrency
        ? calculated.outstandingAmountByCurrency[singleCurrency] ?? 0
        : null,
    overdueCount: calculated.overdueItemCount,
    currency: singleCurrency,
  }
}

function escapeODataString(value) {
    return `'${String(value).replaceAll("'", "''")}'`
  }

function buildSapInvoiceFilter(validated, invoiceKey) {
    const filters = []
    const search = validated.search
    if (search) {
      const literal = escapeODataString(search)
      filters.push([
        `substringof(${literal},SupplierInvoice)`,
        `substringof(${literal},SupplierInvoiceIDByInvcgParty)`,
        `substringof(${literal},InvoicingParty)`,
        `substringof(${literal},InvoiceReference)`,
        `substringof(${literal},PaymentReference)`,
        `substringof(${literal},CompanyCode)`,
      ].join(' or '))
    }
    if (validated.supplierId) {
      filters.push(`InvoicingParty eq ${escapeODataString(validated.supplierId)}`)
    }
    if (validated.companyCode) {
      filters.push(`CompanyCode eq ${escapeODataString(validated.companyCode)}`)
    }
    if (validated.currency) {
      filters.push(`DocumentCurrency eq ${escapeODataString(validated.currency)}`)
    }
    if (validated.invoiceStatus) {
      filters.push(`SupplierInvoiceStatus eq ${escapeODataString(validated.invoiceStatus)}`)
    }
    if (validated.documentDateFrom) filters.push(`DocumentDate ge datetime'${validated.documentDateFrom}T00:00:00'`)
    if (validated.documentDateTo) filters.push(`DocumentDate le datetime'${validated.documentDateTo}T23:59:59'`)
    if (validated.postingDateFrom) filters.push(`PostingDate ge datetime'${validated.postingDateFrom}T00:00:00'`)
    if (validated.postingDateTo) filters.push(`PostingDate le datetime'${validated.postingDateTo}T23:59:59'`)
    if (validated.minAmount !== null) {
      filters.push(`InvoiceGrossAmount ge ${validated.minAmount}`)
    }
    if (validated.maxAmount !== null) {
      filters.push(`InvoiceGrossAmount le ${validated.maxAmount}`)
    }
    if (invoiceKey) {
      filters.push(
        `SupplierInvoice eq ${escapeODataString(invoiceKey.invoice)} and FiscalYear eq ${escapeODataString(invoiceKey.fiscalYear)}`,
      )
    }
    return filters.length ? filters.map((filter) => `(${filter})`).join(' and ') : undefined
  }

function validateSapInvoiceFilters(validated) {
    if (validated.paymentStatus || validated.dueDateFrom || validated.dueDateTo) {
      throw new IntegrationError(
        'Payment-status and due-date filters are unavailable because this SAP entity does not provide verified payment status or due dates.',
        400,
      )
    }
  }

function toNullableString(value) {
    return typeof value === 'string' && value.trim() ? value : null
  }

function toNullableAmount(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null
    const amount = Number(value)
    return Number.isFinite(amount) ? amount : null
  }

function toSapDate(value) {
    if (typeof value !== 'string' || !value) return null
    const odataDate = value.match(/^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/)
    const date = odataDate
      ? new Date(Number(odataDate[1]))
      : new Date(value)
    if (!Number.isFinite(date.getTime())) return null
    return date.toISOString().slice(0, 10)
  }

export function mapSapSupplierInvoice(record) {
    if (
      !record ||
      typeof record.SupplierInvoice !== 'string' ||
      !record.SupplierInvoice ||
      typeof record.FiscalYear !== 'string' ||
      !record.FiscalYear
    ) {
      throw new IntegrationError(
        'SAP returned a supplier invoice without its verified key fields.',
        502,
        'invalid_data',
      )
    }
    return {
      id: `${record.SupplierInvoice}_${record.FiscalYear}`,
      supplierId: toNullableString(record.InvoicingParty),
      supplierName: null,
      companyCode: toNullableString(record.CompanyCode),
      invoiceReference:
        toNullableString(record.SupplierInvoiceIDByInvcgParty) ??
        toNullableString(record.InvoiceReference),
      documentReference: record.SupplierInvoice,
      documentDate: toSapDate(record.DocumentDate),
      postingDate: toSapDate(record.PostingDate),
      dueDate: null,
      amount: toNullableAmount(record.InvoiceGrossAmount),
      currency: toNullableString(record.DocumentCurrency),
      paymentStatus: null,
      invoiceProcessingStatus: toNullableString(record.SupplierInvoiceStatus),
      clearingDate: null,
      paymentReference: toNullableString(record.PaymentReference),
      dataSource: 'live',
      dataMode: 'live',
      limitations: SAP_INVOICE_LIMITATIONS,
    }
  }

export async function getSapSupplierInvoices({
    client = axios,
    filters = {},
    top = 25,
    skip = 0,
    invoiceKey,
    verifyEntitySet = true,
  } = {}) {
    if (!isSapConfigured()) {
      throw new IntegrationError(
        'SAP supplier invoice retrieval is unavailable. Configure SAP_BASE_URL, SAP_USERNAME, and SAP_PASSWORD in backend/.env.',
      )
    }
    const validated = validatePaymentFilters({
      ...filters,
      top: String(top),
      skip: String(skip),
    })
    validateSapInvoiceFilters(validated)

    if (verifyEntitySet) {
      const entitySets = await getODataServiceEntitySets({ client })
      if (!entitySets.includes(SAP_INVOICE_ENTITY_SET)) {
        throw new IntegrationError(
          'The configured SAP OData service does not expose A_SupplierInvoice.',
          503,
          'unavailable',
        )
      }
    }

    const filter = buildSapInvoiceFilter(validated, invoiceKey)
    const params = {
      $format: 'json',
      $select: SAP_INVOICE_FIELDS.join(','),
      $inlinecount: 'allpages',
      $top: validated.top,
      $skip: validated.skip,
      ...(filter ? { $filter: filter } : {}),
    }
    const url = new URL(SAP_INVOICE_ENTITY_SET, getSapServiceRootUrl()).toString()

    try {
      const response = await client.get(url, {
        auth: { username: config.sap.username, password: config.sap.password },
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          ...(config.sap.client ? { 'sap-client': config.sap.client } : {}),
        },
        maxRedirects: 0,
        params,
        timeout: 15000,
      })
      const payload = response.data?.d
      const rawRecords = payload?.results
      const total = Number(payload?.__count)
      if (
        !Array.isArray(rawRecords) ||
        !Number.isSafeInteger(total) ||
        total < 0 ||
        rawRecords.some((record) => !record || typeof record !== 'object' || Array.isArray(record))
      ) {
        throw new IntegrationError(
          'SAP returned an unexpected OData V2 supplier invoice response.',
          502,
          'invalid_data',
        )
      }
      const records = deduplicatePaymentObligations(rawRecords.map(mapSapSupplierInvoice))
      return {
        records,
        total,
        top: validated.top,
        skip: validated.skip,
        hasMore: validated.skip + records.length < total,
      }
    } catch (error) {
      if (error instanceof IntegrationError) throw error
      if (axios.isAxiosError(error)) {
        if (!error.response) {
          throw new IntegrationError(
            'Could not connect to the SAP supplier invoice service. Check the API Management route and network access.',
            502,
            'unavailable',
          )
        }
        const status = error.response.status
        if (status === 401) {
          throw new IntegrationError('SAP authentication failed for supplier invoice retrieval.', 502, 'authentication_failed', status)
        }
        if (status === 403) {
          throw new IntegrationError('SAP denied read access to supplier invoices.', 502, 'authorization_failed', status)
        }
        if (status === 404) {
          throw new IntegrationError('The SAP supplier invoice entity was not found on the configured service.', 502, 'unavailable', status)
        }
        if (status === 415) {
          throw new IntegrationError('SAP rejected the supplier invoice request content encoding or media type (HTTP 415).', 502, 'other_error', status)
        }
        throw new IntegrationError(
          `SAP supplier invoice request failed (HTTP ${status}).`,
          502,
          status >= 500 ? 'unavailable' : 'other_error',
          status,
        )
      }
      throw error
    }
  }

export async function getAllSapSupplierInvoices(filters = {}, { client = axios, maxRecords = MAX_SUMMARY_RECORDS } = {}) {
    const firstPage = await getSapSupplierInvoices({
      client,
      filters,
      top: 100,
      skip: 0,
    })
    if (firstPage.total > maxRecords) {
      throw new IntegrationError(
        `The filtered SAP result contains more than ${maxRecords} invoices. Narrow the filters before requesting a summary or export.`,
        413,
      )
    }
    const records = [...firstPage.records]
    for (let skip = firstPage.records.length; skip < firstPage.total; skip += 100) {
      const page = await getSapSupplierInvoices({
        client,
        filters,
        top: 100,
        skip,
        verifyEntitySet: false,
      })
      if (page.records.length === 0) {
        throw new IntegrationError(
          'SAP pagination ended before the reported supplier invoice count was reached.',
          502,
          'invalid_data',
        )
      }
      records.push(...page.records)
    }
    return deduplicatePaymentObligations(records)
  }

export async function getSapSupplierInvoiceById(id, { client = axios } = {}) {
    const separator = id.lastIndexOf('_')
    const invoice = id.slice(0, separator)
    const fiscalYear = id.slice(separator + 1)
    if (separator < 1 || !/^[A-Za-z0-9_-]{1,20}$/.test(invoice) || !/^\d{4}$/.test(fiscalYear)) {
      return null
    }
    const result = await getSapSupplierInvoices({
      client,
      top: 1,
      skip: 0,
      invoiceKey: { invoice, fiscalYear },
    })
    return result.records.find((record) => record.id === id) ?? null
  }

export async function checkSapSupplierInvoiceAvailability({ client = axios, entitySets } = {}) {
    try {
      const availableEntitySets = entitySets ?? await getODataServiceEntitySets({ client })
      if (!availableEntitySets.includes(SAP_INVOICE_ENTITY_SET)) {
        return {
          status: 'unavailable',
          reason: 'The configured SAP OData service does not list A_SupplierInvoice.',
        }
      }
      const result = await getSapSupplierInvoices({
        client,
        top: 1,
        skip: 0,
        verifyEntitySet: false,
      })
      return {
        status: result.total === 0 ? 'empty' : 'available',
        recordCount: result.total,
        reason: 'Supplier invoices were read from SAP. Payment status and a verified due date are not provided by this entity.',
      }
    } catch (error) {
      if (error instanceof IntegrationError) {
        return {
          status: 'unavailable',
          reason: error.message,
          errorCategory: error.code,
        }
      }
      return {
        status: 'unavailable',
        reason: 'The SAP supplier invoice response could not be verified.',
        errorCategory: 'unknown',
      }
    }
  }

export function createUnavailableSapPaymentSummary(records) {
    const calculated = calculatePaymentSummary(records)
    const invoiceGrossAmountByCurrency = {}
    const companyCodes = new Set()
    const invoiceDocumentStatusSummary = {}
    for (const record of deduplicatePaymentObligations(records)) {
      if (typeof record.companyCode === 'string' && record.companyCode.trim()) {
        companyCodes.add(record.companyCode.trim())
      }
      if (typeof record.invoiceProcessingStatus === 'string' && record.invoiceProcessingStatus.trim()) {
        const status = record.invoiceProcessingStatus.trim()
        invoiceDocumentStatusSummary[status] = (invoiceDocumentStatusSummary[status] ?? 0) + 1
      }
      const amount = typeof record.amount === 'number' ? record.amount : null
      const currency = typeof record.currency === 'string' ? record.currency : null
      if (amount !== null && Number.isFinite(amount) && amount >= 0 && currency && /^[A-Z]{3}$/.test(currency)) {
        addCurrencyAmount(invoiceGrossAmountByCurrency, currency, amount)
      }
    }
    const unavailableMetrics = {
      totalOutstandingAmount: 'Invoice gross amounts are not outstanding balances; the entity has no verified unpaid-clearing status.',
      overdueAmount: 'No verified payment status and no authoritative invoice due date are available.',
      upcomingPaymentObligations: 'No verified payment status and no authoritative invoice due date are available.',
      completedPayments: 'No verified clearing status, clearing date, clearing document, or payment completion evidence is available.',
      outstandingItems: 'Invoices cannot be counted as outstanding without verified unpaid-clearing status.',
    }
    return {
      ...calculated,
      status: 'unavailable',
      dataSource: 'live',
      reason: 'Outstanding, overdue, upcoming, and completed-payment metrics require verified payment status, clearing information, and due-date data, which this invoice entity does not provide.',
      outstandingAmountByCurrency: {},
      totalOutstandingAmountByCurrency: {},
      overdueAmountByCurrency: {},
      upcomingObligationAmountByCurrency: {},
      completedPaymentAmountByCurrency: {},
      outstandingItemCount: null,
      overdueItemCount: null,
      upcomingObligationCount: null,
      completedPaymentCount: null,
      invoiceCount: records.length,
      invoiceGrossAmountByCurrency,
      totalInvoicedByCurrency: invoiceGrossAmountByCurrency,
      companyCodes: [...companyCodes].sort(),
      companyCodeCount: companyCodes.size,
      invoiceDocumentStatusSummary,
      totalInvoiced: null,
      paidAmount: null,
      totalOutstandingAmount: null,
      outstandingAmount: null,
      overdueCount: null,
      currency: null,
      availableMetrics: ['invoiceCount', 'invoiceGrossAmountByCurrency'],
      unavailableMetrics,
      limitations: [
        ...new Set([
          ...SAP_INVOICE_LIMITATIONS,
          ...calculated.limitations,
          'Invoice gross amounts are available, but they are not outstanding balances.',
        ]),
      ],
    }
  }

export async function getSapPaymentSummary(filters = {}, options = {}) {
  const cacheKey = JSON.stringify({ filters, upcomingDays: config.upcomingDays })
  const cached = getCachedPaymentSummary(cacheKey)
  if (cached) return cached

  const records = await getAllSapSupplierInvoices(filters, options)
  const unavailable = createUnavailableSapPaymentSummary(records)
  try {
    const result = await getVendorLineItems({ client: options.client ?? axios, maxRecords: 5000 })
    const filteredRecords = filterVendorLineItems(result.records, { ...filters, reportingDate: filters.reportingDate }, filters.reportingDate)
    const summary = calculateVendorLineItemSummary(filteredRecords, { reportingDate: filters.reportingDate, upcomingDays: config.upcomingDays })
    const currencyTotals = (values) => Object.fromEntries(Object.entries(values || {}).map(([currency, value]) => [currency, Number(value)]))
    const unavailableMetrics = { ...unavailable.unavailableMetrics }
    for (const [metric, status] of Object.entries(summary.metricStatus)) {
      if (status === 'available') delete unavailableMetrics[metric]
    }
    const summaryResponse = {
      ...unavailable,
      status: summary.status,
      sourceService: summary.sourceService,
      sourceEntity: summary.sourceEntity,
      lastSuccessfulRefresh: result.lastSuccessfulRefresh,
      reportingDate: summary.reportingDate,
      upcomingDays: summary.upcomingDays,
      metricStatus: summary.metricStatus,
      totalOutstandingAmountByCurrency: summary.metricStatus.totalOutstandingAmount === 'available' ? currencyTotals(summary.amounts.outstandingByCurrency) : {},
      outstandingAmountByCurrency: summary.metricStatus.totalOutstandingAmount === 'available' ? currencyTotals(summary.amounts.outstandingByCurrency) : {},
      overdueAmountByCurrency: summary.metricStatus.overdueAmount === 'available' ? currencyTotals(summary.amounts.overdueByCurrency) : {},
      upcomingObligationAmountByCurrency: summary.metricStatus.upcomingPaymentObligations === 'available' ? currencyTotals(summary.amounts.upcomingByCurrency) : {},
      completedPaymentAmountByCurrency: {},
      outstandingItemCount: summary.metricStatus.outstandingItems === 'available' ? summary.counts.outstandingItems : null,
      overdueItemCount: summary.metricStatus.overdueAmount === 'available' ? summary.counts.overdueItems : null,
      upcomingObligationCount: summary.metricStatus.upcomingPaymentObligations === 'available' ? summary.counts.upcomingItems : null,
      completedPaymentCount: summary.metricStatus.completedPayments === 'available' ? summary.counts.completedPayments : null,
      availableMetrics: [...unavailable.availableMetrics, ...Object.keys(summary.counts).filter((key) => summary.counts[key] > 0)],
      unavailableMetrics,
      limitations: [...new Set([...unavailable.limitations, ...summary.limitations])],
    }
    setCachedPaymentSummary(cacheKey, summaryResponse)
    return summaryResponse
  } catch (error) {
    const unavailableResponse = {
      ...unavailable,
      sourceService: 'FAP_VENDOR_LINE_ITEMS_SRV',
      sourceEntity: 'Items',
      metricStatus: {
        totalOutstandingAmount: 'unavailable', overdueAmount: 'unavailable', upcomingPaymentObligations: 'unavailable', completedPayments: 'unavailable', outstandingItems: 'unavailable',
      },
      limitations: [...new Set([...unavailable.limitations, `Vendor line-item service unavailable: ${error instanceof Error ? error.message : 'unknown error'}`])],
    }
    setCachedPaymentSummary(cacheKey, unavailableResponse)
    return unavailableResponse
  }
}

export async function getSapVendorLineItemsPage(filters = {}, { top = 25, skip = 0, client = axios, maxRecords = 5000 } = {}) {
  const result = await getVendorLineItems({ client, maxRecords })
  const filtered = filterVendorLineItems(result.records, filters, new Date().toISOString().slice(0, 10))
  const records = filtered.slice(skip, skip + top).map((record) => ({
    ...record,
    openItemStatus: classifyVendorLineItem(record, new Date().toISOString().slice(0, 10)),
    verifiedOpenAmount: verifiedOpenAmount(record),
  }))
  return { ...result, records, total: filtered.length, top, skip, hasMore: skip + records.length < filtered.length }
}

export async function getSapVendorLineItemFilters({ client = axios, maxRecords = 5000 } = {}) {
  const result = await getVendorLineItems({ client, maxRecords })
  return {
    companyCodes: [...new Set(result.records.map((record) => record.companyCode).filter(Boolean))].sort(),
    currencies: [...new Set(result.records.map((record) => record.balanceCurrency || record.transactionCurrency).filter(Boolean))].sort(),
    supplierIds: [...new Set(result.records.map((record) => record.supplierId).filter(Boolean))].sort(),
    openItemStatuses: ['Open', 'Overdue', 'Cleared'],
  }
}

export function getDemoSuppliers() {
  const suppliers = new Map()
  for (const payment of getDemoPaymentObligations()) {
    suppliers.set(payment.supplierId, {
      supplierId: payment.supplierId,
      supplierName: payment.supplierName,
    })
  }
  return [...suppliers.values()]
}

export async function getSapSuppliers({ client = axios, top = 100, skip = 0 } = {}) {
  if (!isSapConfigured()) {
    throw new IntegrationError(
      'SAP supplier lookup is unavailable. Configure SAP_BASE_URL, SAP_USERNAME, and SAP_PASSWORD before selecting live mode.',
    )
  }

  const entitySets = await getODataServiceEntitySets({ client })
  if (!entitySets.includes('A_Supplier')) {
    throw new IntegrationError(
      'The configured SAP OData service does not expose the A_Supplier entity set.',
      503,
      'unavailable',
    )
  }

  const url = new URL('A_Supplier', getSapServiceRootUrl()).toString()
  try {
    const response = await client.get(url, {
      auth: { username: config.sap.username, password: config.sap.password },
      headers: {
        Accept: 'application/json',
        ...(config.sap.client ? { 'sap-client': config.sap.client } : {}),
      },
      maxRedirects: 0,
      params: { $format: 'json', $top: top, $skip: skip },
      timeout: 15000,
    })
    const records = response.data?.d?.results
    if (!Array.isArray(records) || records.some((record) => typeof record?.Supplier !== 'string')) {
      throw new IntegrationError('SAP returned an unexpected supplier response.', 502, 'invalid_data')
    }
    return {
      suppliers: records.map((record) => ({ supplierId: record.Supplier })),
      hasMore: records.length === top,
    }
  } catch (error) {
    if (error instanceof IntegrationError) throw error
    const status = axios.isAxiosError(error) ? error.response?.status : undefined
    if (status === 401) {
      throw new IntegrationError('SAP supplier lookup authentication failed.', 502, 'authentication_failed', status)
    }
    if (status === 403) {
      throw new IntegrationError('SAP denied access to the supplier resource.', 502, 'authorization_failed', status)
    }
    if (status === 404 || !status || status >= 500) {
      throw new IntegrationError('SAP supplier lookup is unavailable.', 502, 'unavailable', status)
    }
    throw new IntegrationError(`SAP supplier lookup failed (HTTP ${status}).`, 502, 'other_error', status)
  }
}

export function getPaymentDataMode() {
  return config.dataMode === 'demo' ? 'demo' : 'live'
}

export function getPaymentCapabilityStatus({ supplierInvoiceEntityAvailable } = {}) {
  let reason =
    'Supplier invoice retrieval, service metadata, and payment or clearing fields have not been verified.'
  if (supplierInvoiceEntityAvailable === true) {
    reason =
      'A_SupplierInvoice is listed by SAP, but metadata and invoice-record retrieval have not been verified. Payment and clearing fields remain unavailable.'
  } else if (supplierInvoiceEntityAvailable === false) {
    reason =
      'The configured SAP OData service does not list A_SupplierInvoice. Supplier invoice and payment data are unavailable.'
  }
  return {
    status: 'unavailable',
    reason,
  }
}
