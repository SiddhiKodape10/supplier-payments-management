import { Router } from 'express'
import { isAiConfigured, isSapConfigured } from '../config.js'
import { answerPaymentQuestion, searchWithAssistant } from '../services/aiService.js'
import {
  filterPaymentObligations,
  getDemoPaymentObligations,
  getDemoPaymentSummary,
  getDemoSuppliers,
  getPaymentCapabilityStatus,
  getPaymentDataMode,
  getSapPaymentSummary,
  getSapSuppliers,
  getSapSupplierInvoiceById,
  getSapSupplierInvoices,
  getAllSapSupplierInvoices,
  checkSapSupplierInvoiceAvailability,
  validatePaymentFilters,
  getSapVendorLineItemsPage,
  getSapVendorLineItemFilters,
} from '../services/supplierPaymentsService.js'
import {
  approveDemoPaymentRequest,
  createDemoPaymentRequest,
  getDemoInvoices,
  getDemoPaymentHistory,
  getDemoPaymentRequest,
  getDemoSuppliers as listDemoSuppliers,
  listDemoPaymentRequests,
  recordDemoPayment,
} from '../services/demoPaymentService.js'
import { checkVendorLineItemsAvailability } from '../services/vendorLineItemsService.js'
import {
  IntegrationError,
  checkSapConnection,
  getBusinessPartner,
  searchBusinessPartners,
  validateSearchTerm,
} from '../services/sapService.js'

const router = Router()

export function healthHandler(_request, response) {
  response.json({
    status: 'ok',
    application: { status: 'healthy' },
    dataMode: getPaymentDataMode(),
    dependencies: {
      sap: {
        status: 'not_checked',
        configured: isSapConfigured(),
        paymentObligations: getPaymentDataMode() === 'demo'
          ? { status: 'demo' }
          : getPaymentCapabilityStatus(),
      },
      ollama: {
        status: 'not_checked',
        configured: isAiConfigured(),
      },
    },
  })
}

router.get('/health', healthHandler)

router.get('/sap/status', async (_request, response) => {
  if (!isSapConfigured()) {
    response.json({
      status: 'not_configured',
      message: 'SAP connection details are not configured.',
      paymentDataStatus: getPaymentCapabilityStatus(),
    })
    return
  }

  try {
    const connection = await checkSapConnection()
    const paymentDataStatus = await checkSapSupplierInvoiceAvailability({
      entitySets: connection.entitySets,
    })
    const lineItemsStatus = await checkVendorLineItemsAvailability()
    response.json({
      status: 'connected',
      message: 'The configured SAP OData service documents were verified with authenticated read-only requests.',
      paymentDataStatus,
      lineItemsStatus,
    })
  } catch (error) {
    const status = error instanceof IntegrationError
      ? ['authentication_failed', 'authorization_failed', 'unavailable', 'other_error'].includes(error.code)
        ? error.code
        : 'unknown'
      : 'unknown'
    const messages = {
      authentication_failed: 'SAP rejected authentication.',
      authorization_failed: 'SAP denied access to the read-only connectivity resource.',
      unavailable: 'SAP service or network is unavailable.',
      other_error: 'SAP returned an error during the read-only connectivity check.',
      unknown: 'SAP connectivity could not be verified.',
    }
    response.json({
      status,
      message: messages[status],
      paymentDataStatus: getPaymentCapabilityStatus(),
    })
  }
})

function rejectUnsupportedQueryParameters(query, allowed) {
  return Object.keys(query).some((key) => !allowed.has(key))
}

function parseFilters(request, response, next) {
  try {
    return validatePaymentFilters(request.query)
  } catch (error) {
    next(error)
    return null
  }
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value)
  const safe = /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text
  return `"${safe.replaceAll('"', '""')}"`
}

function sendPaymentCsv(response, records, liveMode = false) {
  const liveRecords = liveMode || (records.length > 0 && records.every((record) => record.dataSource === 'live'))
  const fields = liveRecords
    ? [
        'id',
        'supplierId',
        'companyCode',
        'documentReference',
        'invoiceReference',
        'documentDate',
        'postingDate',
        'amount',
        'currency',
        'invoiceProcessingStatus',
        'paymentReference',
        'dataSource',
      ]
    : [
        'id',
        'supplierId',
        'supplierName',
        'companyCode',
        'documentReference',
        'documentDate',
        'postingDate',
        'dueDate',
        'amount',
        'currency',
        'paymentStatus',
        'invoiceProcessingStatus',
        'clearingDate',
        'paymentReference',
        'dataSource',
      ]
  const rows = [
    fields.join(','),
    ...records.map((record) => fields.map((field) => csvCell(record[field])).join(',')),
  ]
  response
    .status(200)
    .type('text/csv')
    .set('Content-Disposition', `attachment; filename="${liveRecords ? 'supplier-invoices.csv' : 'payment-obligations.csv'}"`)
    .send(`${rows.join('\r\n')}\r\n`)
}

router.get('/suppliers', async (request, response, next) => {
  if (rejectUnsupportedQueryParameters(request.query, new Set(['search', 'top', 'skip']))) {
    response.status(400).json({ error: 'One or more query parameters are not supported.' })
    return
  }
  let filters
  try {
    filters = validatePaymentFilters(request.query)
  } catch (error) {
    next(error)
    return
  }

  try {
    if (getPaymentDataMode() === 'demo') {
      const search = filters.search.toLocaleLowerCase()
      const suppliers = getDemoSuppliers().filter((supplier) =>
        !search ||
        supplier.supplierId.toLocaleLowerCase().includes(search) ||
        supplier.supplierName.toLocaleLowerCase().includes(search),
      )
      const page = suppliers.slice(filters.skip, filters.skip + filters.top)
      response.json({
        dataMode: 'demo',
        suppliers: page,
        top: filters.top,
        skip: filters.skip,
        hasMore: filters.skip + page.length < suppliers.length,
      })
      return
    }

    const result = await getSapSuppliers({ top: filters.top, skip: filters.skip })
    const search = filters.search.toLocaleLowerCase()
    const suppliers = result.suppliers.filter((supplier) =>
      !search || supplier.supplierId.toLocaleLowerCase().includes(search),
    )
    response.json({
      dataMode: 'live',
      suppliers,
      top: filters.top,
      skip: filters.skip,
      hasMore: result.hasMore,
    })
  } catch (error) {
    if (error instanceof IntegrationError) {
      response.status(error.statusCode).json({
        error: error.message,
        dataMode: 'unavailable',
      })
      return
    }
    next(error)
  }
})

async function readPaymentRecords(request, response, next, legacyInvoiceShape = false) {
  const filters = parseFilters(request, response, next)
  if (!filters) return
  try {
    if (getPaymentDataMode() === 'demo') {
      const results = filterPaymentObligations(getDemoPaymentObligations(), request.query)
      const invoices = results.slice(filters.skip, filters.skip + filters.top)
      const page = {
        dataMode: 'demo',
        top: filters.top,
        skip: filters.skip,
        total: results.length,
        hasMore: filters.skip + invoices.length < results.length,
        limitations: results.flatMap((record) => record.limitations ?? []).filter((value, index, all) => all.indexOf(value) === index),
      }
      response.json(legacyInvoiceShape ? { ...page, invoices } : { ...page, records: invoices })
      return
    }
    const page = await getSapSupplierInvoices({
      filters: request.query,
      top: filters.top,
      skip: filters.skip,
    })
    const payload = {
      dataMode: 'live',
      top: page.top,
      skip: page.skip,
      total: page.total,
      hasMore: page.hasMore,
      limitations: [...new Set(page.records.flatMap((record) => record.limitations ?? []))],
    }
    response.json(
      legacyInvoiceShape
        ? { ...payload, invoices: page.records }
        : { ...payload, records: page.records },
    )
  } catch (error) {
    next(error)
  }
}

router.get('/payments', async (request, response, next) => {
  await readPaymentRecords(request, response, next)
})

router.get('/invoices', async (request, response, next) => {
  await readPaymentRecords(request, response, next, true)
})

async function readPaymentDetail(request, response, next) {
  const { id } = request.params
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) {
    response.status(400).json({ error: 'Payment obligation ID has an invalid format.' })
    return
  }
  try {
    if (getPaymentDataMode() === 'demo') {
      const record = getDemoPaymentObligations().find((payment) => payment.id === id)
      if (!record) {
        response.status(404).json({ error: 'Payment obligation was not found in the selected data source.' })
        return
      }
      response.json({ dataMode: 'demo', record })
      return
    }
    const record = await getSapSupplierInvoiceById(id)
    if (!record) {
      response.status(404).json({ error: 'Supplier invoice was not found in SAP.' })
      return
    }
    response.json({ dataMode: 'live', record })
  } catch (error) {
    next(error)
  }
}

router.get('/payments/line-items', async (request, response, next) => {
  if (getPaymentDataMode() !== 'live') {
    response.status(409).json({ error: 'Accounting line items are available only in live SAP mode.' })
    return
  }
  const filters = parseFilters(request, response, next)
  if (!filters) return
  try {
    const page = await getSapVendorLineItemsPage(request.query, {
      top: Math.min(Math.max(filters.top || 25, 1), 100),
      skip: Math.max(filters.skip || 0, 0),
    })
    response.json({ dataMode: 'live', ...page })
  } catch (error) { next(error) }
})

router.get('/payments/line-items/filters', async (_request, response, next) => {
  if (getPaymentDataMode() !== 'live') {
    response.status(409).json({ error: 'Accounting line-item filters are available only in live SAP mode.' })
    return
  }
  try { response.json({ dataMode: 'live', ...(await getSapVendorLineItemFilters()) }) }
  catch (error) { next(error) }
})

router.get('/payments/export', (request, response, next) => {
  const filters = parseFilters(request, response, next)
  if (!filters) return
  const recordsPromise = getPaymentDataMode() === 'demo'
    ? Promise.resolve(filterPaymentObligations(getDemoPaymentObligations(), request.query))
    : getAllSapSupplierInvoices(request.query)
  const liveMode = getPaymentDataMode() === 'live'
  recordsPromise.then((records) => sendPaymentCsv(response, records, liveMode)).catch(next)
})

router.get('/payments/summary', async (request, response, next) => {
  const filters = parseFilters(request, response, next)
  if (!filters) return
  try {
    if (getPaymentDataMode() === 'demo') {
      response.json({
        dataMode: 'demo',
        summary: getDemoPaymentSummary(request.query),
      })
      return
    }
    response.json({
      dataMode: 'live',
      summary: await getSapPaymentSummary(request.query),
    })
  } catch (error) {
    next(error)
  }
})

router.get('/payments/:id', async (request, response, next) => {
  await readPaymentDetail(request, response, next)
})

router.get('/invoices/:id', (request, response) => {
  const { id } = request.params
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) {
    response.status(400).json({ error: 'Invoice ID has an invalid format.' })
    return
  }
  if (getPaymentDataMode() !== 'demo') {
    unavailablePaymentData(response)
    return
  }
  const invoice = getDemoPaymentObligations().find((payment) => payment.id === id)
  if (!invoice) {
    response.status(404).json({ error: 'Invoice was not found in the selected data source.' })
    return
  }
  response.json({ dataMode: 'demo', invoice })
})

router.get('/business-partners', async (request, response, next) => {
  const rawSearch = request.query.search ?? ''
  const rawTop = request.query.top ?? '25'
  const rawSkip = request.query.skip ?? '0'
  if (typeof rawSearch !== 'string' || typeof rawTop !== 'string' || typeof rawSkip !== 'string') {
    response.status(400).json({ error: 'Search, top, and skip must be single values.' })
    return
  }
  const search = validateSearchTerm(rawSearch)
  const top = Number.parseInt(
    rawTop,
    10,
  )
  const skip = Number.parseInt(rawSkip, 10)
  if (!/^\d+$/.test(rawTop) || !Number.isInteger(top) || top < 1 || top > 100) {
    response.status(400).json({ error: 'Top must be an integer between 1 and 100.' })
    return
  }
  if (!/^\d+$/.test(rawSkip) || !Number.isSafeInteger(skip) || skip > 1000000) {
    response.status(400).json({ error: 'Skip must be an integer between 0 and 1000000.' })
    return
  }

  try {
    const result = await searchBusinessPartners({ search, top, skip })
    response.json({
      businessPartners: result.records,
      top,
      skip,
      hasMore: result.hasMore,
    })
  } catch (error) {
    next(error)
  }
})

router.get('/business-partners/:businessPartner', async (request, response, next) => {
  const { businessPartner } = request.params
  if (!/^[A-Za-z0-9_-]{1,20}$/.test(businessPartner)) {
    response.status(400).json({ error: 'Business Partner number has an invalid format.' })
    return
  }

  try {
    const partner = await getBusinessPartner(businessPartner)
    if (!partner) {
      response.status(404).json({ error: 'Business Partner was not found in SAP.' })
      return
    }
    response.json({ businessPartner: partner })
  } catch (error) {
    next(error)
  }
})

router.post('/businesspartners', (_request, response) => {
  response.status(410).json({
    error: 'Business Partner creation is not supported by Supplier Payments Management.',
  })
})

router.get('/demo/suppliers', async (_request, response, next) => {
  try {
    const suppliers = await listDemoSuppliers()
    response.json({ suppliers })
  } catch (error) {
    next(error)
  }
})

router.get('/demo/invoices', async (request, response, next) => {
  const supplierId = typeof request.query.supplierId === 'string' ? request.query.supplierId.trim() : ''
  if (!supplierId) {
    response.status(400).json({ error: 'A supplierId query parameter is required.' })
    return
  }

  try {
    const invoices = await getDemoInvoices(supplierId)
    response.json({ invoices })
  } catch (error) {
    if (error?.statusCode === 404) {
      response.status(404).json({ error: error.message })
      return
    }
    next(error)
  }
})

router.get('/demo/payment-requests', async (_request, response, next) => {
  try {
    const requests = await listDemoPaymentRequests()
    response.json({ paymentRequests: requests })
  } catch (error) {
    next(error)
  }
})

router.get('/demo/payment-requests/:requestId', async (request, response, next) => {
  try {
    const record = await getDemoPaymentRequest(request.params.requestId)
    response.json({ request: record })
  } catch (error) {
    if (error?.statusCode === 404) {
      response.status(404).json({ error: error.message })
      return
    }
    next(error)
  }
})

router.post('/demo/payment-requests', async (request, response, next) => {
  const body = request.body ?? {}
  try {
    const result = await createDemoPaymentRequest(body)
    response.status(201).json({ request: result })
  } catch (error) {
    if (error?.statusCode) {
      response.status(error.statusCode).json({ error: error.message })
      return
    }
    next(error)
  }
})

router.post('/demo/payment-requests/:requestId/approve', async (request, response, next) => {
  const { decision = 'approved', reason = '' } = request.body ?? {}
  try {
    const result = await approveDemoPaymentRequest(request.params.requestId, decision, reason)
    response.json({ request: result })
  } catch (error) {
    if (error?.statusCode) {
      response.status(error.statusCode).json({ error: error.message })
      return
    }
    next(error)
  }
})

router.get('/demo/payments', async (_request, response, next) => {
  try {
    const payments = await getDemoPaymentHistory()
    response.json({ payments })
  } catch (error) {
    next(error)
  }
})

router.post('/demo/payments', async (request, response, next) => {
  const requestId = request.body?.requestId
  if (!requestId) {
    response.status(400).json({ error: 'A requestId is required to record a demo payment.' })
    return
  }

  try {
    const payment = await recordDemoPayment(requestId, { paymentAmount: request.body?.paymentAmount })
    response.status(201).json({ payment })
  } catch (error) {
    if (error?.statusCode) {
      response.status(error.statusCode).json({ error: error.message })
      return
    }
    next(error)
  }
})

router.post('/ai/search', async (request, response, next) => {
  const prompt = request.body?.prompt
  if (typeof prompt !== 'string' || !prompt.trim()) {
    response.status(400).json({ error: 'A non-empty prompt is required.' })
    return
  }
  if (prompt.length > 4000) {
    response.status(400).json({ error: 'Prompt must be 4000 characters or fewer.' })
    return
  }

  try {
    const result = await searchWithAssistant(prompt.trim())
    response.json(result)
  } catch (error) {
    next(error)
  }
})

router.post('/ai/payments', async (request, response, next) => {
  const prompt = request.body?.prompt
  if (typeof prompt !== 'string' || !prompt.trim()) {
    response.status(400).json({ error: 'A non-empty prompt is required.' })
    return
  }
  if (prompt.length > 2000) {
    response.status(400).json({ error: 'Prompt must be 2000 characters or fewer.' })
    return
  }
  const allowedBodyKeys = new Set(['prompt', 'filters'])
  if (Object.keys(request.body ?? {}).some((key) => !allowedBodyKeys.has(key))) {
    response.status(400).json({ error: 'Only prompt and filters are supported.' })
    return
  }
  validatePaymentFilters(request.body.filters ?? {})

  try {
    const result = await answerPaymentQuestion(prompt.trim(), request.body.filters ?? {})
    response.json(result)
  } catch (error) {
    next(error)
  }
})

export default router
