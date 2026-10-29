import assert from 'node:assert/strict'
import test from 'node:test'
import { config } from '../src/config.js'
import {
  calculatePaymentSummary,
  deduplicatePaymentObligations,
  createUnavailableSapPaymentSummary,
  filterDemoPayments,
  filterPaymentObligations,
  getDemoPaymentObligations,
  getDemoPaymentSummary,
  getDemoSuppliers,
  getSapSuppliers,
  getSapSupplierInvoices,
  mapSapSupplierInvoice,
  validatePaymentFilters,
} from '../src/services/supplierPaymentsService.js'

test('demo records have unique supplier records and a consistent summary', () => {
  assert.equal(getDemoSuppliers().length, 9)
  const summary = getDemoPaymentSummary({}, {
    now: '2026-10-26T12:00:00.000Z',
    upcomingDays: 30,
  })
  assert.equal(summary.invoiceCount, 9)
  assert.equal(summary.totalInvoiced, 127501.5)
  assert.equal(summary.paidAmount, 44005.25)
  assert.equal(summary.outstandingAmount, 83496.25)
  assert.equal(summary.outstandingItemCount, 6)
  assert.equal(summary.overdueAmountByCurrency.USD, 25375.75)
  assert.equal(summary.upcomingObligationAmountByCurrency.USD, 58120.5)
  assert.equal(summary.upcomingObligationCount, 4)
  assert.equal(summary.completedPaymentCount, 3)
  assert.deepEqual(summary.upcomingPeriod, {
    from: '2026-10-26',
    through: '2026-11-25',
  })
  assert.ok(summary.limitations.length > 0)
})

test('demo invoice filters search fields and enforce validated filter values', () => {
  assert.equal(filterDemoPayments({ search: 'Northwind' })[0].id, 'PAY-2026-1048')
  assert.equal(filterDemoPayments({ paymentStatus: 'Paid' }).length, 3)
  assert.equal(filterDemoPayments({ companyCode: 'US03' }).length, 2)
  assert.throws(() => validatePaymentFilters({ paymentStatus: 'Processing' }), { statusCode: 400 })
  assert.throws(() => validatePaymentFilters({ top: '1e2' }), { statusCode: 400 })
  assert.throws(() => validatePaymentFilters({ search: 'bad\nsearch' }), { statusCode: 400 })
  assert.throws(() => validatePaymentFilters({ unexpected: 'true' }), { statusCode: 400 })
  assert.throws(() => validatePaymentFilters({ dueDateFrom: '2026-02-30' }), { statusCode: 400 })
  assert.throws(
    () => validatePaymentFilters({ dueDateFrom: '2026-11-01', dueDateTo: '2026-10-01' }),
    { statusCode: 400 },
  )
  assert.throws(() => validatePaymentFilters({ minAmount: '-1' }), { statusCode: 400 })
  assert.throws(() => validatePaymentFilters({ minAmount: '10.001' }), { statusCode: 400 })
  assert.throws(
    () => validatePaymentFilters({ minAmount: '100', maxAmount: '99' }),
    { statusCode: 400 },
  )
})

test('filtering supports supplier, date, currency, amount, and status together', () => {
  const results = filterPaymentObligations(getDemoPaymentObligations(), {
    supplierId: 'SUP-10063',
    dueDateFrom: '2026-10-29',
    dueDateTo: '2026-10-29',
    minAmount: '30000',
    maxAmount: '33000',
    currency: 'usd',
    paymentStatus: 'Pending',
  })
  assert.equal(results.length, 1)
  assert.equal(results[0].id, 'PAY-2026-1051')
})

test('SAP supplier read uses only GET against the documented supplier resource', async () => {
  const previousSap = { ...config.sap }
  Object.assign(config.sap, {
    baseUrl: 'https://sap.example.test',
    odataPath: '/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner',
    username: 'test-user',
    password: 'test-password',
    client: '',
  })
  const calls = []
  try {
    const result = await getSapSuppliers({
      top: 10,
      skip: 20,
      client: {
        async get(url, options) {
          calls.push({ url, options })
          if (calls.length === 1) {
            return {
              data: {
                d: { EntitySets: ['A_Supplier'] },
              },
            }
          }
          return {
            data: {
              d: {
                results: [{ Supplier: '0000100024', SupplierName: 'Not forwarded' }],
              },
            },
          }
        },
      },
    })

    assert.equal(calls.length, 2)
    assert.equal(calls[0].url, 'https://sap.example.test/sap/opu/odata/sap/API_BUSINESS_PARTNER/')
    assert.deepEqual(calls[0].options.params, { $format: 'json' })
    assert.equal(calls[1].url, 'https://sap.example.test/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_Supplier')
    assert.deepEqual(calls[1].options.params, { $format: 'json', $top: 10, $skip: 20 })
    assert.deepEqual(result, {
      suppliers: [{ supplierId: '0000100024' }],
      hasMore: false,
    })
  } finally {
    Object.assign(config.sap, previousSap)
  }
})

test('SAP supplier read fails explicitly when SAP is not configured', async () => {
  const previousSap = { ...config.sap }
  Object.assign(config.sap, { baseUrl: '', username: '', password: '' })
  try {
    await assert.rejects(
      getSapSuppliers({ client: { get: async () => assert.fail('unexpected SAP request') } }),
      (error) => error.statusCode === 503 && /unavailable/i.test(error.message),
    )
  } finally {
    Object.assign(config.sap, previousSap)
  }
})

test('SAP supplier connectivity errors fail without substituting mock records', async () => {
  const previousSap = { ...config.sap }
  Object.assign(config.sap, {
    baseUrl: 'https://sap.example.test',
    odataPath: '/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner',
    username: 'test-user',
    password: 'test-password',
  })
  try {
    await assert.rejects(
      getSapSuppliers({
        client: {
          async get(_url, _options) {
            if (!this.called) {
              this.called = true
              return { data: { d: { EntitySets: ['A_Supplier'] } } }
            }
            throw { isAxiosError: true, response: { status: 404 } }
          },
        },
      }),
      (error) =>
        error.statusCode === 502 &&
        /unavailable/i.test(error.message) &&
        !/test-password/.test(error.message),
    )
  } finally {
    Object.assign(config.sap, previousSap)
  }
})

test('SAP supplier lookup does not request an entity set absent from the service document', async () => {
  const previousSap = { ...config.sap }
  Object.assign(config.sap, {
    baseUrl: 'https://sap.example.test',
    odataPath: '/API_SUPPLIERINVOICE_PROCESS_SRV',
    username: 'test-user',
    password: 'test-password',
  })
  const requestedUrls = []
  try {
    await assert.rejects(
      getSapSuppliers({
        client: {
          async get(url) {
            requestedUrls.push(url)
            return { data: { d: { EntitySets: ['A_SupplierInvoice'] } } }
          },
        },
      }),
      (error) => error.statusCode === 503 && /does not expose the A_Supplier/.test(error.message),
    )
    assert.deepEqual(requestedUrls, ['https://sap.example.test/API_SUPPLIERINVOICE_PROCESS_SRV/'])
  } finally {
    Object.assign(config.sap, previousSap)
  }
})

test('verified supplier invoice OData response maps confirmed fields and escapes OData literals', async () => {
  const previousSap = { ...config.sap }
  Object.assign(config.sap, {
    baseUrl: 'https://sap.example.test',
    odataPath: '/API_SUPPLIERINVOICE_PROCESS_SRV',
    username: 'test-user',
    password: 'test-password',
    client: '100',
  })
  const calls = []
  try {
    const result = await getSapSupplierInvoices({
      filters: {
        search: "O'Brien",
        companyCode: '1000',
        currency: 'USD',
        minAmount: '10',
        maxAmount: '500',
      },
      top: 10,
      skip: 20,
      client: {
        async get(url, options) {
          calls.push({ url, options })
          if (calls.length === 1) {
            return { data: { d: { EntitySets: ['A_SupplierInvoice'] } } }
          }
          return {
            data: {
              d: {
                results: [{
                  SupplierInvoice: '5100001234',
                  FiscalYear: '2025',
                  CompanyCode: '1000',
                  DocumentDate: '/Date(1761436800000)/',
                  PostingDate: '/Date(1761523200000)/',
                  InvoicingParty: '0000100024',
                  SupplierInvoiceIDByInvcgParty: "INV-O'Brien",
                  InvoiceGrossAmount: '215.50',
                  DocumentCurrency: 'USD',
                  SupplierInvoiceStatus: '5',
                  PaymentReference: 'PAY-REF-1',
                }],
                __count: '21',
              },
            },
          }
        },
      },
    })

    assert.equal(calls.length, 2)
    assert.equal(calls[1].url, 'https://sap.example.test/API_SUPPLIERINVOICE_PROCESS_SRV/A_SupplierInvoice')
    assert.equal(calls[1].options.params.$top, 10)
    assert.equal(calls[1].options.params.$skip, 20)
    assert.match(calls[1].options.params.$filter, /O''Brien/)
    assert.match(calls[1].options.params.$filter, /InvoiceGrossAmount ge 10/)
    assert.equal(calls[1].options.headers['Accept-Encoding'], 'gzip, deflate')
    assert.equal(calls[1].options.headers['sap-client'], '100')
    assert.equal(result.total, 21)
    assert.equal(result.hasMore, false)
    const [record] = result.records
    assert.equal(record.id, '5100001234_2025')
    assert.equal(record.supplierId, '0000100024')
    assert.equal(record.supplierName, null)
    assert.equal(record.companyCode, '1000')
    assert.equal(record.invoiceReference, "INV-O'Brien")
    assert.equal(record.documentDate, '2025-10-26')
    assert.equal(record.postingDate, '2025-10-27')
    assert.equal(record.dueDate, null)
    assert.equal(record.amount, 215.5)
    assert.equal(record.currency, 'USD')
    assert.equal(record.paymentStatus, null)
    assert.equal(record.invoiceProcessingStatus, '5')
    assert.equal(record.clearingDate, null)
    assert.equal(record.paymentReference, 'PAY-REF-1')
    assert.equal(record.dataSource, 'live')
  } finally {
    Object.assign(config.sap, previousSap)
  }
})

test('live SAP invoice mapping exposes invoice gross amount separately from open-item balances', () => {
  const record = mapSapSupplierInvoice({
    SupplierInvoice: '5100001234',
    FiscalYear: '2025',
    CompanyCode: '1000',
    InvoicingParty: '0000100024',
    SupplierInvoiceIDByInvcgParty: 'INV-2048',
    InvoiceGrossAmount: '215.50',
    DocumentCurrency: 'USD',
    SupplierInvoiceStatus: '5',
    PaymentReference: 'PAY-REF-1',
  })

  assert.equal(record.amount, 215.5)
  assert.equal(record.grossAmount, 215.5)
  assert.equal(record.currency, 'USD')
  assert.equal(record.invoiceReference, 'INV-2048')
  assert.equal(record.paymentStatus, null)
  assert.equal(record.dueDate, null)
  assert.equal(record.dataMode, 'live')
})

test('SAP invoice mapper rejects missing keys and leaves unverified values unavailable', () => {
  assert.throws(() => mapSapSupplierInvoice({ SupplierInvoice: '5100001234' }), {
    statusCode: 502,
  })
  const record = mapSapSupplierInvoice({
    SupplierInvoice: '5100001234',
    FiscalYear: '2025',
    InvoiceGrossAmount: 'not-a-number',
  })
  assert.equal(record.supplierName, null)
  assert.equal(record.amount, null)
  assert.equal(record.grossAmount, null)
  assert.equal(record.currency, null)
  assert.equal(record.dueDate, null)
  assert.equal(record.paymentStatus, null)
  assert.equal(record.clearingDate, null)

  const summary = createUnavailableSapPaymentSummary([record])
  assert.equal(summary.status, 'unavailable')
  assert.equal(summary.outstandingItemCount, null)
  assert.equal(summary.outstandingAmount, null)
  assert.equal(summary.dataSource, 'live')
  assert.equal(summary.availableMetrics.includes('invoiceCount'), true)
  assert.equal(summary.availableMetrics.includes('invoiceGrossAmountByCurrency'), true)
  assert.equal(summary.unavailableMetrics.totalOutstandingAmount.includes('not outstanding balances'), true)
})

test('live unavailable summary reports invoice gross totals separately by currency', () => {
  const records = [
    { id: 'invoice-1', amount: 100, currency: 'USD', dataSource: 'live' },
    { id: 'invoice-2', amount: 250, currency: 'EUR', dataSource: 'live' },
    { id: 'invoice-3', amount: 50, currency: 'USD', dataSource: 'live' },
  ]
  const summary = createUnavailableSapPaymentSummary(records)
  assert.deepEqual(summary.invoiceGrossAmountByCurrency, { USD: 150, EUR: 250 })
  assert.equal(summary.status, 'unavailable')
  assert.equal(summary.totalOutstandingAmount, null)
  assert.equal(summary.outstandingItemCount, null)
})

test('summary uses inclusive date boundaries and does not combine currencies', () => {
  const records = [
    {
      id: 'obligation-1',
      paymentStatus: 'Pending',
      dueDate: '2026-11-25',
      amount: 100,
      currency: 'USD',
    },
    {
      id: 'obligation-2',
      paymentStatus: 'Pending',
      dueDate: '2026-11-26',
      amount: 200,
      currency: 'EUR',
    },
    {
      id: 'obligation-3',
      paymentStatus: 'Paid',
      dueDate: null,
      amount: 50,
      currency: 'EUR',
    },
  ]
  const summary = calculatePaymentSummary(records, {
    now: '2026-10-26T00:00:00.000Z',
    upcomingDays: 30,
  })
  assert.deepEqual(summary.upcomingObligationAmountByCurrency, { USD: 100 })
  assert.deepEqual(summary.completedPaymentAmountByCurrency, { EUR: 50 })
  assert.equal(summary.upcomingObligationCount, 1)
})

test('duplicate obligations are counted once and conflicting duplicates fail', () => {
  const record = { id: 'same', paymentStatus: 'Pending', amount: 10, currency: 'USD' }
  assert.equal(deduplicatePaymentObligations([record, { ...record }]).length, 1)
  assert.throws(
    () => deduplicatePaymentObligations([record, { ...record, amount: 20 }]),
    { statusCode: 502 },
  )
})

test('missing fields remain unavailable and are disclosed in summary limitations', () => {
  const summary = calculatePaymentSummary(
    [{
      id: 'incomplete',
      paymentStatus: 'Pending',
      supplierId: null,
      documentReference: null,
      dueDate: null,
      amount: null,
      currency: null,
      paymentReference: null,
    }],
    { now: '2026-10-26T00:00:00.000Z', upcomingDays: 30 },
  )
  assert.deepEqual(summary.outstandingAmountByCurrency, {})
  assert.equal(summary.outstandingItemCount, 1)
  assert.equal(summary.upcomingObligationCount, 0)
  assert.ok(summary.limitations.some((item) => item.includes('usable due date')))
})
