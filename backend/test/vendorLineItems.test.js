import assert from 'node:assert/strict'
import test from 'node:test'
import { config } from '../src/config.js'
import {
  calculateVendorLineItemSummary,
  classifyVendorLineItem,
  getVendorLineItemStatusDetails,
  getVendorLineItems,
  mapVendorLineItem,
  verifiedOpenAmount,
  filterVendorLineItems,
} from '../src/services/vendorLineItemsService.js'

function lineItem(overrides = {}) {
  return {
    Supplier: '0000100024',
    SupplierName: 'Example Supplier',
    CompanyCode: '1000',
    AccountingDocument: '1900000001',
    AccountingDocumentItem: '001',
    FiscalYear: '2026',
    AccountingDocumentType: 'KR',
    DebitCreditCode: 'H',
    DocumentDate: '/Date(1767225600000)/',
    PostingDate: '/Date(1767225600000)/',
    InvoiceReference: 'INV-1001',
    AmountInBalanceTransactionCurrency: '-125.50',
    BalanceTransactionCurrency: 'USD',
    AmountInTransactionCurrency: '-125.50',
    TransactionCurrency: 'USD',
    NetDueDate: '/Date(1767225600000)/',
    ClearingStatus: '2',
    ClearingDate: null,
    ClearingAccountingDocument: null,
    HasClearingAccountingDocument: '',
    IsCleared: '',
    IsClearingReversed: '',
    ...overrides,
  }
}

function mapped(overrides = {}) {
  return mapVendorLineItem(lineItem(overrides))
}

test('vendor line-item mapping verifies stable accounting identity and live fields', () => {
  const record = mapped()
  assert.equal(record.id, '1000_2026_1900000001_001')
  assert.equal(record.invoiceReference, 'INV-1001')
  assert.equal(record.grossAmount, '125.50')
  assert.equal(record.signedAmount, '125.50')
  assert.equal(record.currency, 'USD')
  assert.equal(record.dataSource, 'live')
  assert.equal(record.source, 'SAP')
})

test('debit/credit sign mapping: Credit (H) is positive payable, Debit (S) is negative reduction', () => {
  const invoiceCredit = mapped({ AccountingDocumentType: 'KR', DebitCreditCode: 'H', AmountInTransactionCurrency: '-250.00' })
  assert.equal(invoiceCredit.grossAmount, '250.00')
  assert.equal(invoiceCredit.signedAmount, '250.00')
  assert.equal(verifiedOpenAmount(invoiceCredit), '250.00')

  const creditMemoDebit = mapped({
    AccountingDocumentType: 'KG',
    DebitCreditCode: 'S',
    AmountInTransactionCurrency: '50.00',
    AmountInBalanceTransactionCurrency: '50.00',
  })
  assert.equal(creditMemoDebit.grossAmount, '50.00')
  assert.equal(creditMemoDebit.signedAmount, '-50.00')
  assert.equal(verifiedOpenAmount(creditMemoDebit), '-50.00')

  const paymentDebit = mapped({
    AccountingDocumentType: 'KZ',
    DebitCreditCode: 'S',
    AmountInTransactionCurrency: '100.00',
    AmountInBalanceTransactionCurrency: '100.00',
  })
  assert.equal(paymentDebit.signedAmount, '-100.00')
})

test('accounting summary separates currencies and never combines them', () => {
  const openUsd = mapped({ NetDueDate: '/Date(1767225600000)/' })
  const openEur = mapped({
    AccountingDocument: '1900000002',
    BalanceTransactionCurrency: 'EUR',
    AmountInBalanceTransactionCurrency: '-40.00',
    AmountInTransactionCurrency: '-40.00',
    TransactionCurrency: 'EUR',
  })
  const cleared = mapped({ AccountingDocument: '1900000003', IsCleared: 'X', ClearingStatus: '1' })
  const summary = calculateVendorLineItemSummary([openUsd, openEur, cleared], {
    reportingDate: '2026-01-01',
    upcomingDays: 30,
  })

  assert.equal(summary.amounts.outstandingByCurrency.USD, '125.50')
  assert.equal(summary.amounts.outstandingByCurrency.EUR, '40.00')
  assert.equal(summary.counts.outstandingItems, 2)
  assert.equal(summary.metrics.totalOutstandingAmount.available, true)
  assert.deepEqual(
    summary.metrics.totalOutstandingAmount.byCurrency,
    [
      { currency: 'EUR', amount: 40, count: 1 },
      { currency: 'USD', amount: 125.5, count: 1 },
    ],
  )
  assert.equal(summary.metricStatus.completedPayments, 'unavailable')
  assert.equal(summary.metrics.completedPayments.available, false)
})

test('cleared items have null open balance and do not count toward outstanding totals', () => {
  const cleared1 = mapped({ IsCleared: 'X', ClearingAccountingDocument: '2000000001', ClearingDate: '/Date(1767225600000)/' })
  assert.equal(verifiedOpenAmount(cleared1), null)
  assert.equal(classifyVendorLineItem(cleared1, '2026-01-01'), 'Cleared')

  const cleared2 = mapped({ ClearingStatus: '1', ClearingAccountingDocument: '2000000002' })
  assert.equal(verifiedOpenAmount(cleared2), null)
  assert.equal(classifyVendorLineItem(cleared2, '2026-01-01'), 'Cleared')

  const summary = calculateVendorLineItemSummary([cleared1, cleared2], { reportingDate: '2026-01-01' })
  assert.equal(summary.counts.outstandingItems, 0)
})

test('overdue vs upcoming 30-day classification per due date', () => {
  // reporting date = 2026-01-15
  // overdue: dueDate < 2026-01-15
  const overdue = mapped({
    AccountingDocument: '1900000010',
    NetDueDate: '/Date(1767225600000)/', // 2026-01-01
    AmountInTransactionCurrency: '-100.00',
  })
  assert.equal(classifyVendorLineItem(overdue, '2026-01-15'), 'Overdue')

  // upcoming: 2026-01-15 <= dueDate <= 2026-02-14
  const upcoming = mapped({
    AccountingDocument: '1900000011',
    NetDueDate: '/Date(1769385600000)/', // 2026-01-26
    AmountInTransactionCurrency: '-200.00',
  })
  assert.equal(classifyVendorLineItem(upcoming, '2026-01-15'), 'Open')

  // far future: dueDate > 2026-02-14
  const future = mapped({
    AccountingDocument: '1900000012',
    NetDueDate: '/Date(1775001600000)/', // 2026-04-01
    AmountInTransactionCurrency: '-300.00',
  })
  assert.equal(classifyVendorLineItem(future, '2026-01-15'), 'Open')

  const summary = calculateVendorLineItemSummary([overdue, upcoming, future], {
    reportingDate: '2026-01-15',
    upcomingDays: 30,
  })

  assert.equal(summary.counts.overdueItems, 1)
  assert.equal(summary.counts.upcomingItems, 1)
  assert.equal(summary.counts.outstandingItems, 3)
  assert.equal(summary.amounts.overdueByCurrency.USD, '100.00')
  assert.equal(summary.amounts.upcomingByCurrency.USD, '200.00')
  assert.equal(summary.amounts.outstandingByCurrency.USD, '600.00')
})

test('verifiable zero upcoming obligations returns available: true with amount 0', () => {
  // All items are overdue (e.g. historical 2017 data)
  const oldItem = mapped({
    AccountingDocument: '1900000020',
    NetDueDate: '/Date(1508457600000)/', // 2017-10-20
    AmountInTransactionCurrency: '-100.00',
  })
  const summary = calculateVendorLineItemSummary([oldItem], {
    reportingDate: '2026-10-29',
    upcomingDays: 30,
  })

  assert.equal(summary.metrics.upcomingPaymentObligations.available, true)
  assert.equal(summary.counts.upcomingItems, 0)
  assert.deepEqual(summary.metrics.upcomingPaymentObligations.byCurrency, [
    { currency: 'USD', amount: 0, count: 0 },
  ])
})

test('missing due dates make overdue and upcoming unavailable but leave outstanding available', () => {
  const open = mapped({ NetDueDate: null })
  const summary = calculateVendorLineItemSummary([open], { reportingDate: '2026-01-01' })
  assert.equal(summary.metricStatus.totalOutstandingAmount, 'available')
  assert.equal(summary.metricStatus.overdueAmount, 'unavailable')
  assert.equal(summary.metricStatus.upcomingPaymentObligations, 'unavailable')
  assert.equal(summary.metricStatus.completedPayments, 'unavailable')
})

test('missing amount or currency causes unverified status', () => {
  const noAmount = mapped({
    AmountInTransactionCurrency: null,
    AmountInBalanceTransactionCurrency: null,
  })
  assert.equal(verifiedOpenAmount(noAmount), null)
  assert.equal(classifyVendorLineItem(noAmount, '2026-01-01'), 'Unverified')

  const noCurrency = mapped({
    TransactionCurrency: null,
    BalanceTransactionCurrency: null,
    CompanyCodeCurrency: null,
  })
  assert.equal(verifiedOpenAmount(noCurrency), null)
  assert.equal(classifyVendorLineItem(noCurrency, '2026-01-01'), 'Unverified')
})

test('reversals and noted items are excluded from outstanding balance', () => {
  const reversed = mapped({ IsClearingReversed: 'X' })
  assert.equal(classifyVendorLineItem(reversed, '2026-01-01'), 'Reversed')
  assert.equal(verifiedOpenAmount(reversed), null)

  const notedDownPaymentReq = mapped({ SpecialGeneralLedgerCode: 'F' })
  assert.equal(classifyVendorLineItem(notedDownPaymentReq, '2026-01-01'), 'Excluded')
  assert.equal(verifiedOpenAmount(notedDownPaymentReq), null)
  const details = getVendorLineItemStatusDetails(notedDownPaymentReq)
  assert.match(details.reason, /down payment request/i)
})

test('duplicate accounting items by full key are deduplicated', () => {
  const item1 = mapped()
  const duplicate = mapped()
  const summary = calculateVendorLineItemSummary([item1, duplicate], { reportingDate: '2026-01-01' })
  assert.equal(summary.counts.outstandingItems, 1)
  assert.equal(summary.amounts.outstandingByCurrency.USD, '125.50')
})

test('OData V2 number and date parsing handles multiple formats', () => {
  // Integer number string
  const item1 = mapped({ AmountInTransactionCurrency: '-500' })
  assert.equal(item1.grossAmount, '500')
  assert.equal(item1.signedAmount, '500')

  // Decimal number string
  const item2 = mapped({ AmountInTransactionCurrency: '-1234.56' })
  assert.equal(item2.grossAmount, '1234.56')
  assert.equal(item2.signedAmount, '1234.56')

  // Date parsing /Date(1508457600000)/
  const item3 = mapped({ DocumentDate: '/Date(1508457600000)/' })
  assert.equal(item3.documentDate, '2017-10-20')

  // Due date fallback from DueCalculationBaseDate + NetPaymentDays
  const item4 = mapped({
    NetDueDate: null,
    DueCalculationBaseDate: '/Date(1508457600000)/', // 2017-10-20
    NetPaymentDays: 14,
  })
  assert.equal(item4.dueDate, '2017-11-03')
})

test('filterVendorLineItems applies search, supplier, currency, and status consistently', () => {
  const openItem = mapped({ Supplier: 'SUP-001', TransactionCurrency: 'USD', NetDueDate: '/Date(1508457600000)/' })
  const clearedItem = mapped({
    AccountingDocument: '1900000099',
    Supplier: 'SUP-002',
    TransactionCurrency: 'EUR',
    BalanceTransactionCurrency: 'EUR',
    AmountInTransactionCurrency: '-10.00',
    IsCleared: 'X',
  })

  // Filter by currency
  const usdFiltered = filterVendorLineItems([openItem, clearedItem], { currency: 'USD' })
  assert.equal(usdFiltered.length, 1)
  assert.equal(usdFiltered[0].supplierId, 'SUP-001')

  // Filter by supplier
  const supFiltered = filterVendorLineItems([openItem, clearedItem], { supplierId: 'SUP-002' })
  assert.equal(supFiltered.length, 1)
  assert.equal(supFiltered[0].supplierId, 'SUP-002')

  // Filter by status Cleared
  const clearedFiltered = filterVendorLineItems([openItem, clearedItem], { paymentStatus: 'Cleared' })
  assert.equal(clearedFiltered.length, 1)
  assert.equal(clearedFiltered[0].id, clearedItem.id)
})

test('vendor line-item retrieval paginates with read-only GET and returns only mapped records', async () => {
  const previousSap = { ...config.sap }
  Object.assign(config.sap, {
    baseUrl: 'https://sap.example.test',
    lineItemsOdataPath: '/FAP_VENDOR_LINE_ITEMS_SRV',
    username: 'test-user',
    password: 'test-password',
    client: '100',
  })
  const calls = []
  try {
    const result = await getVendorLineItems({
      maxRecords: 150,
      client: {
        async get(url, options) {
          calls.push({ url, options })
          assert.equal(options.auth.username, 'test-user')
          assert.equal(options.auth.password, 'test-password')
          if (calls.length === 1) {
            return {
              data: {
                d: {
                  results: [lineItem()],
                  __next: 'https://sap.example.test/FAP_VENDOR_LINE_ITEMS_SRV/Items?$skip=100',
                },
              },
            }
          }
          return { data: { d: { results: [lineItem({ AccountingDocument: '1900000002' })] } } }
        },
      },
    })
    assert.equal(result.records.length, 2)
    assert.equal(result.sourceService, 'FAP_VENDOR_LINE_ITEMS_SRV')
    assert.equal(result.sourceEntity, 'Items')
    assert.equal(calls.length, 2)
  } finally {
    Object.assign(config.sap, previousSap)
  }
})
