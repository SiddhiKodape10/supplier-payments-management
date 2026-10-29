import assert from 'node:assert/strict'
import test from 'node:test'
import { config } from '../src/config.js'
import {
  calculateVendorLineItemSummary,
  classifyVendorLineItem,
  getVendorLineItems,
  mapVendorLineItem,
  verifiedOpenAmount,
} from '../src/services/vendorLineItemsService.js'

function lineItem(overrides = {}) {
  return {
    Supplier: '0000100024', SupplierName: 'Example Supplier', CompanyCode: '1000',
    AccountingDocument: '1900000001', AccountingDocumentItem: '001', FiscalYear: '2026',
    AccountingDocumentType: 'KR', DebitCreditCode: 'S', DocumentDate: '/Date(1767225600000)/',
    PostingDate: '/Date(1767225600000)/', InvoiceReference: 'INV-1001',
    AmountInBalanceTransactionCurrency: '125.50', BalanceTransactionCurrency: 'USD',
    AmountInTransactionCurrency: '125.50', TransactionCurrency: 'USD', NetDueDate: '/Date(1767225600000)/',
    ClearingStatus: null, ClearingDate: null, ClearingAccountingDocument: null,
    HasClearingAccountingDocument: '', IsCleared: '', IsClearingReversed: '',
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
  assert.equal(record.balanceAmount, '125.50')
  assert.equal(record.balanceCurrency, 'USD')
  assert.equal(record.dataSource, 'live')
})

test('accounting summary separates currencies and conservative clearing evidence', () => {
  const openUsd = mapped({ NetDueDate: '/Date(1767225600000)/' })
  const openEur = mapped({
    AccountingDocument: '1900000002', BalanceTransactionCurrency: 'EUR',
    AmountInBalanceTransactionCurrency: '40.00', TransactionCurrency: 'EUR',
  })
  const cleared = mapped({ AccountingDocument: '1900000003', IsCleared: 'X' })
  const summary = calculateVendorLineItemSummary([openUsd, openEur, cleared], {
    reportingDate: '2026-01-01', upcomingDays: 30,
  })
  assert.equal(summary.amounts.outstandingByCurrency.USD, '125.50')
  assert.equal(summary.amounts.outstandingByCurrency.EUR, '40.00')
  assert.equal(summary.counts.outstandingItems, 2)
  assert.equal(summary.metricStatus.completedPayments, 'unavailable')
})

test('credit items and missing clearing evidence are not classified as payment', () => {
  const credit = mapped({ AccountingDocumentType: 'KG', DebitCreditCode: 'H', AmountInBalanceTransactionCurrency: '-10.00' })
  assert.equal(verifiedOpenAmount(credit), '-10.00')
  assert.equal(classifyVendorLineItem(credit, '2026-01-01'), 'Open')

  const unknown = mapped({ DebitCreditCode: null, AmountInBalanceTransactionCurrency: null, BalanceTransactionCurrency: null })
  assert.equal(verifiedOpenAmount(unknown), null)
  assert.equal(classifyVendorLineItem(unknown, '2026-01-01'), 'Open status not verified')
})

test('missing due dates make overdue and upcoming unavailable but leave open evidence separate', () => {
  const open = mapped({ NetDueDate: null })
  const summary = calculateVendorLineItemSummary([open], { reportingDate: '2026-01-01' })
  assert.equal(summary.metricStatus.totalOutstandingAmount, 'available')
  assert.equal(summary.metricStatus.outdatedAmount, undefined)
  assert.equal(summary.metricStatus.overdueAmount, 'unavailable')
  assert.equal(summary.metricStatus.upcomingPaymentObligations, 'unavailable')
  assert.equal(summary.metricStatus.completedPayments, 'unavailable')
})

test('duplicate accounting items are counted once and reversals are not open', () => {
  const open = mapped()
  const summary = calculateVendorLineItemSummary([open, open], { reportingDate: '2026-01-01' })
  assert.equal(summary.counts.outstandingItems, 1)

  const reversed = mapped({ IsClearingReversed: 'X' })
  assert.equal(classifyVendorLineItem(reversed, '2026-01-01'), 'Reversed')
})

test('vendor line-item retrieval paginates with read-only GET and returns only mapped records', async () => {
  const previousSap = { ...config.sap }
  Object.assign(config.sap, {
    baseUrl: 'https://sap.example.test', lineItemsOdataPath: '/FAP_VENDOR_LINE_ITEMS_SRV',
    username: 'test-user', password: 'test-password', client: '100',
  })
  const calls = []
  try {
    const result = await getVendorLineItems({ maxRecords: 150, client: {
      async get(url, options) {
        calls.push({ url, options })
        assert.equal(options.auth.username, 'test-user')
        assert.equal(options.auth.password, 'test-password')
        if (calls.length === 1) return { data: { d: { results: [lineItem()], __next: 'https://sap.example.test/FAP_VENDOR_LINE_ITEMS_SRV/Items?$skip=100' } } }
        return { data: { d: { results: [lineItem({ AccountingDocument: '1900000002' })] } } }
      },
    } })
    assert.equal(result.records.length, 2)
    assert.equal(result.sourceService, 'FAP_VENDOR_LINE_ITEMS_SRV')
    assert.equal(result.sourceEntity, 'Items')
    assert.equal(calls.length, 2)
  } finally {
    Object.assign(config.sap, previousSap)
  }
})
