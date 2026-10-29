import assert from 'node:assert';
import { computeMetrics, parseSapDate, parseNumber } from './paymentMetrics.js';
const today = new Date('2026-10-29T00:00:00Z');
const row = (o) => ({ Supplier:'S1', CompanyCode:'1010', FiscalYear:'2026', AccountingDocument:String(Math.random()), AccountingDocumentItem:'1',
  AccountingDocumentType:'KR', TransactionCurrency:'EUR', DebitCreditCode:'H', AmountInTransactionCurrency:'100.00',
  NetDueDate:'/Date(1793232000000)/', ...o }); // 2026-10-29? computed below
const d = (iso) => `/Date(${Date.parse(iso)})/`;
const rows = [
  row({ AccountingDocument:'1', AmountInTransactionCurrency:'1,000.50', NetDueDate:d('2026-10-01') }),            // overdue EUR
  row({ AccountingDocument:'2', AmountInTransactionCurrency:'200', NetDueDate:d('2026-11-10') }),                // upcoming EUR
  row({ AccountingDocument:'3', TransactionCurrency:'USD', AmountInTransactionCurrency:'50', NetDueDate:d('2027-03-01') }), // open later USD
  row({ AccountingDocument:'4', DebitCreditCode:'S', AmountInTransactionCurrency:'100', NetDueDate:d('2026-10-01') }),     // credit memo reduces overdue
  row({ AccountingDocument:'5', ClearingDate:d('2026-09-01'), ClearingAccountingDocument:'9' }),                  // cleared invoice
  row({ AccountingDocument:'6', AccountingDocumentType:'KZ', DebitCreditCode:'S', AmountInTransactionCurrency:'500', ClearingDate:d('2026-09-01') }), // payment
  row({ AccountingDocument:'7', AmountInTransactionCurrency:null }),                                              // unverified
  row({ AccountingDocument:'1' }),                                                                                // duplicate key
];
const r = computeMetrics(rows, { today });
console.log(JSON.stringify(r.metrics, null, 1), r.quality);
const eur = (k) => r.metrics[k].byCurrency.find((x) => x.currency === 'EUR');
assert.equal(eur('totalOutstanding').amount, 1000.5 + 200 - 100);
assert.equal(eur('overdue').amount, 900.5);
assert.equal(eur('upcoming').amount, 200);
assert.equal(eur('completed').amount, 500);
assert.equal(r.metrics.totalOutstanding.byCurrency.length, 2);       // never mixed
assert.equal(r.quality.unverified, 1); assert.equal(r.quality.duplicates, 1);
assert.equal(parseNumber('1234.50'), 1234.5); assert.equal(parseSapDate('00000000'), null);
console.log('ALL PASS');
