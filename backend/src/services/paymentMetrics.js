// backend/src/services/paymentMetrics.js  (ESM; if your package.json has no "type":"module",
// replace `export` with module.exports = { ... } at the bottom)
// Pure functions: no SAP calls, no writes. Feed it rows from FAP_VENDOR_LINE_ITEMS_SRV.

// 1) FIELD MAP: first name found on the row wins. CONFIRM against your real $metadata
//    (run inspect-sap.js) and put the verified names first.
export const FIELD_MAP = {
  supplierId:  ['Supplier', 'Vendor', 'SupplierAccount'],
  supplierName:['SupplierName', 'VendorName', 'SupplierFullName'],
  companyCode: ['CompanyCode'],
  fiscalYear:  ['FiscalYear'],
  document:    ['AccountingDocument', 'DocumentNumber'],
  item:        ['AccountingDocumentItem', 'LedgerGLLineItem'],
  documentType:['AccountingDocumentType', 'DocumentType'],
  documentDate:['DocumentDate'],
  postingDate: ['PostingDate'],
  dueDate:     ['NetDueDate'],
  baseDate:    ['BaselineDueDate', 'DueCalculationBaseDate'],
  amount:      ['AmountInTransactionCurrency', 'AmountInCompanyCodeCurrency', 'AmountInBalanceTransacCrcy'],
  currency:    ['TransactionCurrency', 'CompanyCodeCurrency', 'DocumentCurrency'],
  dcIndicator: ['DebitCreditCode', 'DebitCreditIndicator'],   // 'S' debit, 'H' credit
  clearingDate:['ClearingDate'],
  clearingDoc: ['ClearingAccountingDocument', 'ClearingJournalEntry'],
  isReversal:  ['IsReversal', 'ReversalDocument', 'ReverseDocument'],
};

// 2) BUSINESS CONFIG: justify each from real rows before trusting it.
export const CONFIG = {
  paymentDocTypes: ['KZ', 'ZP'],        // outgoing payment document types
  excludedDocTypes: [],                  // e.g. ['AB'] only if you can justify it
  amountIsSigned: false,                 // true if SAP already returns credits as negative
  upcomingDays: 30,
};

const pick = (row, names) => {
  for (const n of names) if (row[n] !== undefined && row[n] !== null && row[n] !== '') return row[n];
  return null;
};

export function parseNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim().replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function parseSapDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v;
  const s = String(v);
  const m = s.match(/\/Date\((-?\d+)/);              // OData V2: /Date(1508371200000)/
  if (m) return new Date(Number(m[1]));
  if (/^0{8}$|^0000-00-00/.test(s)) return null;      // SAP "no date"
  if (/^\d{8}$/.test(s)) return new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T00:00:00Z`);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const iso = (d) => (d ? d.toISOString().slice(0, 10) : null);

export function normalize(row, cfg = CONFIG) {
  const g = (k) => pick(row, FIELD_MAP[k]);
  const dc = g('dcIndicator');
  const raw = parseNumber(g('amount'));
  let payable = null;                  // + = we owe supplier, - = supplier owes us (debit item)
  if (raw !== null) {
    if (cfg.amountIsSigned) payable = -raw;                 // SAP signed: credit is negative => payable positive
    else if (dc === 'H') payable = Math.abs(raw);
    else if (dc === 'S') payable = -Math.abs(raw);
  }
  const clearingDate = parseSapDate(g('clearingDate'));
  const clearingDoc = g('clearingDoc');
  const reversal = g('isReversal');
  let dueDate = parseSapDate(g('dueDate'));
  return {
    supplierId: g('supplierId'), supplierName: g('supplierName'),
    companyCode: g('companyCode'), fiscalYear: g('fiscalYear'),
    accountingDocument: g('document'), item: g('item'),
    documentType: g('documentType'),
    documentDate: iso(parseSapDate(g('documentDate'))), postingDate: iso(parseSapDate(g('postingDate'))),
    dueDate: iso(dueDate),
    amount: raw, payable, currency: g('currency'), dcIndicator: dc,
    clearingDate: iso(clearingDate), clearingDocument: clearingDoc || null,
    isCleared: !!(clearingDate || clearingDoc),
    isReversal: !!reversal && reversal !== 'false' && reversal !== false,
    source: 'SAP',
  };
}

export function classify(r, today = new Date(), cfg = CONFIG) {
  if (cfg.excludedDocTypes.includes(r.documentType)) return { status: 'excluded', reason: `Document type ${r.documentType} excluded` };
  if (r.isReversal) return { status: 'excluded', reason: 'Reversal / reversed document' };
  if (r.payable === null || !r.currency) return { status: 'unverified', reason: 'Amount, currency or debit/credit missing' };
  if (r.isCleared) return { status: 'cleared', reason: 'Clearing date/document present' };
  const t = new Date(today.toISOString().slice(0, 10));
  if (!r.dueDate) return { status: 'open', reason: 'Open; due date not available', noDue: true };
  return new Date(r.dueDate) < t ? { status: 'overdue', reason: 'Open and past due' }
                                 : { status: 'open', reason: 'Open and not yet due' };
}

const add = (map, cur, amt) => {
  const e = map.get(cur) || { currency: cur, amount: 0, count: 0 };
  e.amount = Math.round((e.amount + amt) * 100) / 100; e.count += 1; map.set(cur, e);
};
const out = (map) => [...map.values()].sort((a, b) => a.currency.localeCompare(b.currency));

export function computeMetrics(rawRows, { today = new Date(), cfg = CONFIG } = {}) {
  const seen = new Set();
  const m = { outstanding: new Map(), overdue: new Map(), upcoming: new Map(), completed: new Map(), items: new Map() };
  let unverified = 0, excluded = 0, noDue = 0, dup = 0, verified = 0, paymentRows = 0, dueKnownOpen = 0, open = 0;
  const horizon = new Date(today.getTime() + cfg.upcomingDays * 86400000);
  const rows = [];
  for (const raw of rawRows) {
    const r = normalize(raw, cfg);
    const key = [r.companyCode, r.fiscalYear, r.accountingDocument, r.item].join('|');
    if (seen.has(key)) { dup++; continue; }
    seen.add(key);
    const c = classify(r, today, cfg);
    rows.push({ ...r, status: c.status, statusReason: c.reason });
    if (c.status === 'excluded') { excluded++; continue; }
    if (c.status === 'unverified') { unverified++; continue; }
    verified++;
    if (c.status === 'cleared') {
      if (cfg.paymentDocTypes.includes(r.documentType) && r.payable < 0) { paymentRows++; add(m.completed, r.currency, Math.abs(r.payable)); }
      continue;
    }
    open++;
    add(m.outstanding, r.currency, r.payable); add(m.items, r.currency, 0);
    if (c.noDue) { noDue++; continue; }
    dueKnownOpen++;
    if (c.status === 'overdue') add(m.overdue, r.currency, r.payable);
    else if (new Date(r.dueDate) <= horizon) add(m.upcoming, r.currency, r.payable);
  }
  const reasonIf = (ok, why) => (ok ? null : why);
  const metric = (map, ok, why) => ({ available: ok, byCurrency: ok ? out(map) : null, reason: reasonIf(ok, why) });
  return {
    metrics: {
      totalOutstanding: metric(m.outstanding, verified > 0, 'No rows with verified amount, currency and debit/credit'),
      overdue:          metric(m.overdue, dueKnownOpen > 0 || (verified > 0 && open === 0), 'Due dates not available on open items'),
      upcoming:         metric(m.upcoming, dueKnownOpen > 0 || (verified > 0 && open === 0), 'Due dates not available on open items'),
      completed:        metric(m.completed, paymentRows > 0, 'No cleared payment documents (types ' + cfg.paymentDocTypes.join('/') + ') found'),
      outstandingItems: { available: verified > 0, count: verified > 0 ? open : null, byCurrency: out(m.items).map(({ currency, count }) => ({ currency, count })),
                          reason: reasonIf(verified > 0, 'No verified rows') },
    },
    quality: { total: rawRows.length, verified, unverified, excluded, duplicates: dup, openWithoutDueDate: noDue },
    rows,
  };
}
