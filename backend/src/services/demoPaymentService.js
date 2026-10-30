import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data')

function getStorePath() {
  return process.env.DEMO_PAYMENT_STORE_PATH
    ? path.resolve(process.env.DEMO_PAYMENT_STORE_PATH)
    : path.join(DEFAULT_DATA_DIR, 'demo-payment-store.json')
}

export const DEMO_PAYMENT_METHODS = ['ACH', 'WIRE', 'SEPA', 'CARD']

function toMinorUnits(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    throw new Error('Payment amount must be numeric.')
  }
  return Math.round((numeric + Number.EPSILON) * 100)
}

function fromMinorUnits(value) {
  return Number(value) / 100
}

function roundCurrency(value) {
  return Number(Math.round((Number(value) + Number.EPSILON) * 100) / 100)
}

function isoNow() {
  return new Date().toISOString()
}

const BASE_SEED_SUPPLIERS = [
  { supplierId: 'DEMO-SUP-1001', supplierName: 'Northwind Industrial Supplies', country: 'US', paymentTerms: 'Net 30' },
  { supplierId: 'DEMO-SUP-1002', supplierName: 'Summit Technology Group', country: 'US', paymentTerms: 'Net 15' },
  { supplierId: 'DEMO-SUP-1003', supplierName: 'Harborview Logistics', country: 'DE', paymentTerms: 'Net 45' },
  { supplierId: 'DEMO-SUP-1004', supplierName: 'Cedar Ridge Consulting', country: 'GB', paymentTerms: 'Net 30' },
  { supplierId: 'DEMO-SUP-1005', supplierName: 'Meridian Safety Equipment', country: 'SG', paymentTerms: 'Net 21' },
  { supplierId: 'DEMO-SUP-1006', supplierName: 'Blue Peak Logistics', country: 'US', paymentTerms: 'Net 14' },
  { supplierId: 'DEMO-SUP-1007', supplierName: 'Apex Packaging Partners', country: 'IN', paymentTerms: 'Net 30' },
  { supplierId: 'DEMO-SUP-1008', supplierName: 'Atlas Building Group', country: 'AE', paymentTerms: 'Net 45' },
]

const BASE_SEED_INVOICES = [
  { invoiceId: 'INV-84521', supplierId: 'DEMO-SUP-1001', invoiceNumber: 'INV-84521', invoiceDate: '2026-10-01', dueDate: '2026-10-20', originalAmount: 18450, currency: 'USD', description: 'Industrial supply replenishment' },
  { invoiceId: 'INV-18205', supplierId: 'DEMO-SUP-1001', invoiceNumber: 'INV-18205', invoiceDate: '2026-10-12', dueDate: '2026-11-12', originalAmount: 6350, currency: 'USD', description: 'Office and facilities order' },
  { invoiceId: 'INV-47198', supplierId: 'DEMO-SUP-1001', invoiceNumber: 'INV-47198', invoiceDate: '2026-09-28', dueDate: '2026-11-05', originalAmount: 12500, currency: 'USD', description: 'Packaging and maintenance support' },
  { invoiceId: 'INV-60423', supplierId: 'DEMO-SUP-1001', invoiceNumber: 'INV-60423', invoiceDate: '2026-10-14', dueDate: '2026-11-16', originalAmount: 3750, currency: 'USD', description: 'Emergency spare parts' },
  { invoiceId: 'INV-99001', supplierId: 'DEMO-SUP-1002', invoiceNumber: 'INV-99001', invoiceDate: '2026-10-18', dueDate: '2026-11-18', originalAmount: 9500, currency: 'EUR', description: 'Infrastructure services' },
  { invoiceId: 'INV-77312', supplierId: 'DEMO-SUP-1002', invoiceNumber: 'INV-77312', invoiceDate: '2026-10-24', dueDate: '2026-11-07', originalAmount: 2800, currency: 'EUR', description: 'Software maintenance renewal' },
  { invoiceId: 'INV-22304', supplierId: 'DEMO-SUP-1002', invoiceNumber: 'INV-22304', invoiceDate: '2026-09-15', dueDate: '2026-10-18', originalAmount: 6300, currency: 'EUR', description: 'Security infrastructure upgrade' },
  { invoiceId: 'INV-44012', supplierId: 'DEMO-SUP-1002', invoiceNumber: 'INV-44012', invoiceDate: '2026-10-03', dueDate: '2026-11-10', originalAmount: 18500, currency: 'EUR', description: 'Annual support subscription' },
  { invoiceId: 'INV-60344', supplierId: 'DEMO-SUP-1003', invoiceNumber: 'INV-60344', invoiceDate: '2026-09-20', dueDate: '2026-10-25', originalAmount: 16000, currency: 'EUR', description: 'Logistics and customs support' },
  { invoiceId: 'INV-11944', supplierId: 'DEMO-SUP-1003', invoiceNumber: 'INV-11944', invoiceDate: '2026-10-20', dueDate: '2026-11-08', originalAmount: 5400, currency: 'EUR', description: 'Regional freight planning' },
  { invoiceId: 'INV-80402', supplierId: 'DEMO-SUP-1003', invoiceNumber: 'INV-80402', invoiceDate: '2026-09-12', dueDate: '2026-11-14', originalAmount: 13200, currency: 'EUR', description: 'Warehousing and handling extension' },
  { invoiceId: 'INV-66011', supplierId: 'DEMO-SUP-1003', invoiceNumber: 'INV-66011', invoiceDate: '2026-10-13', dueDate: '2026-11-02', originalAmount: 8700, currency: 'EUR', description: 'Seasonal port storage' },
  { invoiceId: 'INV-41309', supplierId: 'DEMO-SUP-1004', invoiceNumber: 'INV-41309', invoiceDate: '2026-10-10', dueDate: '2026-11-18', originalAmount: 7200, currency: 'GBP', description: 'Consulting retainer' },
  { invoiceId: 'INV-90247', supplierId: 'DEMO-SUP-1004', invoiceNumber: 'INV-90247', invoiceDate: '2026-09-30', dueDate: '2026-10-22', originalAmount: 4850, currency: 'GBP', description: 'Interim project support' },
  { invoiceId: 'INV-33218', supplierId: 'DEMO-SUP-1004', invoiceNumber: 'INV-33218', invoiceDate: '2026-10-05', dueDate: '2026-11-20', originalAmount: 9600, currency: 'GBP', description: 'Advisory and compliance services' },
  { invoiceId: 'INV-71181', supplierId: 'DEMO-SUP-1004', invoiceNumber: 'INV-71181', invoiceDate: '2026-10-11', dueDate: '2026-11-15', originalAmount: 3100, currency: 'GBP', description: 'Travel and stakeholder review' },
  { invoiceId: 'INV-88011', supplierId: 'DEMO-SUP-1005', invoiceNumber: 'INV-88011', invoiceDate: '2026-10-04', dueDate: '2026-11-09', originalAmount: 14800, currency: 'SGD', description: 'Safety training and equipment' },
  { invoiceId: 'INV-66242', supplierId: 'DEMO-SUP-1005', invoiceNumber: 'INV-66242', invoiceDate: '2026-09-18', dueDate: '2026-10-30', originalAmount: 6200, currency: 'SGD', description: 'Emergency PPE replenishment' },
  { invoiceId: 'INV-91024', supplierId: 'DEMO-SUP-1005', invoiceNumber: 'INV-91024', invoiceDate: '2026-10-07', dueDate: '2026-11-24', originalAmount: 9100, currency: 'SGD', description: 'Facility inspection and certification' },
  { invoiceId: 'INV-77415', supplierId: 'DEMO-SUP-1005', invoiceNumber: 'INV-77415', invoiceDate: '2026-10-02', dueDate: '2026-10-29', originalAmount: 7000, currency: 'SGD', description: 'Dedicated safety procurement' },
  { invoiceId: 'INV-55601', supplierId: 'DEMO-SUP-1006', invoiceNumber: 'INV-55601', invoiceDate: '2026-09-23', dueDate: '2026-10-17', originalAmount: 22500, currency: 'USD', description: 'Regional distribution support' },
  { invoiceId: 'INV-77183', supplierId: 'DEMO-SUP-1006', invoiceNumber: 'INV-77183', invoiceDate: '2026-10-02', dueDate: '2026-11-11', originalAmount: 12400, currency: 'USD', description: 'Transport and warehousing fees' },
  { invoiceId: 'INV-99210', supplierId: 'DEMO-SUP-1006', invoiceNumber: 'INV-99210', invoiceDate: '2026-10-03', dueDate: '2026-11-12', originalAmount: 9800, currency: 'USD', description: 'Line-haul settlement' },
  { invoiceId: 'INV-70351', supplierId: 'DEMO-SUP-1007', invoiceNumber: 'INV-70351', invoiceDate: '2026-10-08', dueDate: '2026-11-18', originalAmount: 18000, currency: 'INR', description: 'Packaging materials and labor' },
  { invoiceId: 'INV-95482', supplierId: 'DEMO-SUP-1007', invoiceNumber: 'INV-95482', invoiceDate: '2026-10-15', dueDate: '2026-11-14', originalAmount: 6500, currency: 'INR', description: 'Transit and order fulfillment' },
  { invoiceId: 'INV-78102', supplierId: 'DEMO-SUP-1007', invoiceNumber: 'INV-78102', invoiceDate: '2026-09-24', dueDate: '2026-10-31', originalAmount: 13450, currency: 'INR', description: 'Custom carton and print run' },
  { invoiceId: 'INV-30372', supplierId: 'DEMO-SUP-1007', invoiceNumber: 'INV-30372', invoiceDate: '2026-10-09', dueDate: '2026-11-09', originalAmount: 8200, currency: 'INR', description: 'Secondary packaging support' },
  { invoiceId: 'INV-13409', supplierId: 'DEMO-SUP-1008', invoiceNumber: 'INV-13409', invoiceDate: '2026-10-01', dueDate: '2026-11-06', originalAmount: 16750, currency: 'USD', description: 'Facility maintenance and repairs' },
  { invoiceId: 'INV-87022', supplierId: 'DEMO-SUP-1008', invoiceNumber: 'INV-87022', invoiceDate: '2026-09-16', dueDate: '2026-10-26', originalAmount: 9200, currency: 'EUR', description: 'Fit-out project milestone' },
  { invoiceId: 'INV-10158', supplierId: 'DEMO-SUP-1008', invoiceNumber: 'INV-10158', invoiceDate: '2026-10-11', dueDate: '2026-11-16', originalAmount: 14500, currency: 'USD', description: 'Mechanical works and inspections' },
]

const BASE_SEED_PAYMENT_REQUESTS = [
  {
    requestId: 'DPR-1001-PENDING',
    supplierId: 'DEMO-SUP-1006',
    supplierName: 'Blue Peak Logistics',
    invoiceId: 'INV-77183',
    invoiceNumber: 'INV-77183',
    invoiceDate: '2026-10-02',
    dueDate: '2026-11-11',
    originalAmount: 12400,
    previousPaymentsTotal: 0,
    remainingBalance: 12400,
    paymentAmount: 1800,
    paymentDate: '2026-11-04',
    paymentMethod: 'ACH',
    currency: 'USD',
    remarks: 'Partial payment request for transportation fees.',
    idempotencyKey: 'demo-pending-001',
    status: 'Pending Approval',
    approvalStatus: 'pending',
    createdAt: '2026-10-30T09:00:00.000Z',
    updatedAt: '2026-10-30T09:00:00.000Z',
    history: [{ action: 'submitted', status: 'Pending Approval', timestamp: '2026-10-30T09:00:00.000Z', source: 'local-demo-ui' }],
  },
  {
    requestId: 'DPR-1002-APPROVED',
    supplierId: 'DEMO-SUP-1007',
    supplierName: 'Apex Packaging Partners',
    invoiceId: 'INV-70351',
    invoiceNumber: 'INV-70351',
    invoiceDate: '2026-10-08',
    dueDate: '2026-11-18',
    originalAmount: 18000,
    previousPaymentsTotal: 0,
    remainingBalance: 18000,
    paymentAmount: 3200,
    paymentDate: '2026-11-09',
    paymentMethod: 'WIRE',
    currency: 'INR',
    remarks: 'Approved for processing with treasury review.',
    idempotencyKey: 'demo-approved-001',
    status: 'Approved for Demo Processing',
    approvalStatus: 'approved',
    createdAt: '2026-10-30T09:05:00.000Z',
    updatedAt: '2026-10-30T09:10:00.000Z',
    approvalReason: 'Approved in local demo approval workflow.',
    history: [
      { action: 'submitted', status: 'Pending Approval', timestamp: '2026-10-30T09:05:00.000Z', source: 'local-demo-ui' },
      { action: 'approved', status: 'Approved for Demo Processing', timestamp: '2026-10-30T09:10:00.000Z', source: 'local-demo-approval', reason: 'Approved in local demo approval workflow.' },
    ],
  },
  {
    requestId: 'DPR-1003-REJECTED',
    supplierId: 'DEMO-SUP-1004',
    supplierName: 'Cedar Ridge Consulting',
    invoiceId: 'INV-33218',
    invoiceNumber: 'INV-33218',
    invoiceDate: '2026-10-05',
    dueDate: '2026-11-20',
    originalAmount: 9600,
    previousPaymentsTotal: 0,
    remainingBalance: 9600,
    paymentAmount: 2600,
    paymentDate: '2026-11-10',
    paymentMethod: 'SEPA',
    currency: 'GBP',
    remarks: 'Request was declined during committee review.',
    idempotencyKey: 'demo-rejected-001',
    status: 'Rejected',
    approvalStatus: 'rejected',
    createdAt: '2026-10-30T09:15:00.000Z',
    updatedAt: '2026-10-30T09:17:00.000Z',
    rejectionReason: 'Rejected in local demo approval workflow.',
    history: [
      { action: 'submitted', status: 'Pending Approval', timestamp: '2026-10-30T09:15:00.000Z', source: 'local-demo-ui' },
      { action: 'rejected', status: 'Rejected', timestamp: '2026-10-30T09:17:00.000Z', source: 'local-demo-approval', reason: 'Rejected in local demo approval workflow.' },
    ],
  },
]

const BASE_SEED_PAYMENT_RECORDS = [
  { paymentId: 'DPM-1001-84521', requestId: 'DPR-1001-RECORDED', supplierId: 'DEMO-SUP-1001', supplierName: 'Northwind Industrial Supplies', invoiceId: 'INV-84521', invoiceNumber: 'INV-84521', paymentAmount: 250, currency: 'USD', paymentDate: '2026-11-10', paymentMethod: 'ACH', status: 'Demo Payment Recorded', createdAt: '2026-10-30T08:06:09.629Z' },
  { paymentId: 'DPM-1002-99001', requestId: 'DPR-1002-RECORDED', supplierId: 'DEMO-SUP-1002', supplierName: 'Summit Technology Group', invoiceId: 'INV-99001', invoiceNumber: 'INV-99001', paymentAmount: 1000, currency: 'EUR', paymentDate: '2026-11-12', paymentMethod: 'WIRE', status: 'Demo Payment Recorded', createdAt: '2026-10-30T08:06:09.638Z' },
  { paymentId: 'DPM-1003-60344', requestId: 'DPR-1003-RECORDED', supplierId: 'DEMO-SUP-1003', supplierName: 'Harborview Logistics', invoiceId: 'INV-60344', invoiceNumber: 'INV-60344', paymentAmount: 3200, currency: 'EUR', paymentDate: '2026-10-24', paymentMethod: 'SEPA', status: 'Demo Payment Recorded', createdAt: '2026-10-30T08:20:00.000Z' },
  { paymentId: 'DPM-1004-41309', requestId: 'DPR-1004-RECORDED', supplierId: 'DEMO-SUP-1004', supplierName: 'Cedar Ridge Consulting', invoiceId: 'INV-41309', invoiceNumber: 'INV-41309', paymentAmount: 1500, currency: 'GBP', paymentDate: '2026-11-03', paymentMethod: 'ACH', status: 'Demo Payment Recorded', createdAt: '2026-10-30T08:25:00.000Z' },
  { paymentId: 'DPM-1005-88011', requestId: 'DPR-1005-RECORDED', supplierId: 'DEMO-SUP-1005', supplierName: 'Meridian Safety Equipment', invoiceId: 'INV-88011', invoiceNumber: 'INV-88011', paymentAmount: 2400, currency: 'SGD', paymentDate: '2026-11-08', paymentMethod: 'WIRE', status: 'Demo Payment Recorded', createdAt: '2026-10-30T08:35:00.000Z' },
  { paymentId: 'DPM-1006-55601', requestId: 'DPR-1006-RECORDED', supplierId: 'DEMO-SUP-1006', supplierName: 'Blue Peak Logistics', invoiceId: 'INV-55601', invoiceNumber: 'INV-55601', paymentAmount: 4200, currency: 'USD', paymentDate: '2026-10-23', paymentMethod: 'WIRE', status: 'Demo Payment Recorded', createdAt: '2026-10-30T08:45:00.000Z' },
  { paymentId: 'DPM-1007-70351', requestId: 'DPR-1007-RECORDED', supplierId: 'DEMO-SUP-1007', supplierName: 'Apex Packaging Partners', invoiceId: 'INV-70351', invoiceNumber: 'INV-70351', paymentAmount: 2800, currency: 'INR', paymentDate: '2026-10-29', paymentMethod: 'ACH', status: 'Demo Payment Recorded', createdAt: '2026-10-30T08:52:00.000Z' },
  { paymentId: 'DPM-1008-13409', requestId: 'DPR-1008-RECORDED', supplierId: 'DEMO-SUP-1008', supplierName: 'Atlas Building Group', invoiceId: 'INV-13409', invoiceNumber: 'INV-13409', paymentAmount: 3600, currency: 'USD', paymentDate: '2026-10-28', paymentMethod: 'BANK', status: 'Demo Payment Recorded', createdAt: '2026-10-30T09:00:00.000Z' },
]

function buildSeedStore() {
  return {
    suppliers: [...BASE_SEED_SUPPLIERS],
    invoices: [...BASE_SEED_INVOICES],
    paymentRequests: [...BASE_SEED_PAYMENT_REQUESTS],
    paymentRecords: [...BASE_SEED_PAYMENT_RECORDS],
  }
}

function mergeSeedStore(store) {
  if (!store || typeof store !== 'object') return buildSeedStore()
  const merged = {
    suppliers: Array.isArray(store.suppliers) ? [...store.suppliers] : [],
    invoices: Array.isArray(store.invoices) ? [...store.invoices] : [],
    paymentRequests: Array.isArray(store.paymentRequests) ? [...store.paymentRequests] : [],
    paymentRecords: Array.isArray(store.paymentRecords) ? [...store.paymentRecords] : [],
  }

  const existingSupplierIds = new Set(merged.suppliers.map((supplier) => supplier.supplierId))
  for (const supplier of BASE_SEED_SUPPLIERS) {
    if (!existingSupplierIds.has(supplier.supplierId)) {
      merged.suppliers.push(supplier)
      existingSupplierIds.add(supplier.supplierId)
    }
  }

  const existingInvoiceIds = new Set(merged.invoices.map((invoice) => invoice.invoiceId))
  for (const invoice of BASE_SEED_INVOICES) {
    if (!existingInvoiceIds.has(invoice.invoiceId)) {
      merged.invoices.push(invoice)
      existingInvoiceIds.add(invoice.invoiceId)
    }
  }

  const existingRequestIds = new Set(merged.paymentRequests.map((request) => request.requestId))
  for (const request of BASE_SEED_PAYMENT_REQUESTS) {
    if (!existingRequestIds.has(request.requestId)) {
      merged.paymentRequests.push(request)
      existingRequestIds.add(request.requestId)
    }
  }

  const existingPaymentIds = new Set(merged.paymentRecords.map((record) => record.paymentId))
  for (const record of BASE_SEED_PAYMENT_RECORDS) {
    if (!existingPaymentIds.has(record.paymentId)) {
      merged.paymentRecords.push(record)
      existingPaymentIds.add(record.paymentId)
    }
  }

  return merged
}

async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp`
  await fs.writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(tempPath, filePath)
}

let writeQueue = Promise.resolve()

async function withWriteLock(action) {
  const previous = writeQueue
  let release
  writeQueue = new Promise((resolve) => {
    release = resolve
  })
  await previous
  try {
    return await action()
  } finally {
    release()
  }
}

async function ensureStore() {
  const storePath = getStorePath()
  await fs.mkdir(path.dirname(storePath), { recursive: true })
  let raw
  try {
    raw = await fs.readFile(storePath, 'utf8')
  } catch {
    const seed = buildSeedStore()
    await writeJsonAtomic(storePath, seed)
    return seed
  }

  try {
    const parsed = JSON.parse(raw)
    const merged = mergeSeedStore(parsed)
    if (JSON.stringify(merged) !== JSON.stringify(parsed)) {
      await writeJsonAtomic(storePath, merged)
      return merged
    }
    return parsed
  } catch {
    const seed = buildSeedStore()
    await writeJsonAtomic(storePath, seed)
    return seed
  }
}

async function readStore() {
  return ensureStore()
}

async function persistStore(store) {
  const storePath = getStorePath()
  await withWriteLock(async () => {
    await writeJsonAtomic(storePath, store)
  })
}

export async function getDemoSuppliers() {
  const store = await readStore()
  return store.suppliers.map((supplier) => ({
    supplierId: supplier.supplierId,
    supplierName: supplier.supplierName,
    country: supplier.country,
    paymentTerms: supplier.paymentTerms,
  }))
}

function calculateInvoiceBalance(invoice, paymentRecords) {
  const sumRecorded = paymentRecords
    .filter((record) => record.invoiceId === invoice.invoiceId && record.status === 'Demo Payment Recorded')
    .reduce((total, record) => total + Number(record.paymentAmount), 0)
  const remainingBalance = Math.max(0, roundCurrency(Number(invoice.originalAmount) - sumRecorded))
  return {
    previousPaymentsTotal: roundCurrency(sumRecorded),
    remainingBalance,
    paymentStatus: remainingBalance === 0 ? 'Paid' : remainingBalance > 0 && invoice.dueDate && invoice.dueDate < new Date().toISOString().slice(0, 10) ? 'Overdue' : 'Open',
  }
}

export async function getDemoInvoices(supplierId) {
  const store = await readStore()
  const supplier = store.suppliers.find((entry) => entry.supplierId === supplierId)
  if (!supplier) {
    const error = new Error('Supplier was not found in the local demo dataset.')
    error.statusCode = 404
    throw error
  }

  const invoices = store.invoices
    .filter((entry) => entry.supplierId === supplierId)
    .map((invoice) => {
      const { previousPaymentsTotal, remainingBalance, paymentStatus } = calculateInvoiceBalance(invoice, store.paymentRecords)
      return {
        invoiceId: invoice.invoiceId,
        supplierId: invoice.supplierId,
        invoiceNumber: invoice.invoiceNumber,
        invoiceDate: invoice.invoiceDate,
        dueDate: invoice.dueDate,
        originalAmount: Number(invoice.originalAmount),
        currency: invoice.currency,
        description: invoice.description,
        previousPaymentsTotal: roundCurrency(previousPaymentsTotal),
        remainingBalance: roundCurrency(remainingBalance),
        paymentStatus,
        eligibleForPayment: remainingBalance > 0,
      }
    })
  return invoices
}

function ensureValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw Object.assign(new Error('Payment date must be a valid date in YYYY-MM-DD format.'), { statusCode: 400 })
  }
  const parsed = new Date(`${value}T00:00:00Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw Object.assign(new Error('Payment date must be a valid date in YYYY-MM-DD format.'), { statusCode: 400 })
  }
}

async function findRequestById(requestId) {
  const store = await readStore()
  return store.paymentRequests.find((request) => request.requestId === requestId) ?? null
}

export async function listDemoPaymentRequests() {
  const store = await readStore()
  return store.paymentRequests
    .filter((request) => request.status !== 'Demo Payment Recorded')
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

export async function getDemoPaymentRequest(requestId) {
  const request = await findRequestById(requestId)
  if (!request) {
    const error = new Error('Demo payment request could not be found.')
    error.statusCode = 404
    throw error
  }
  return request
}

export async function createDemoPaymentRequest(payload = {}) {
  const store = await readStore()
  const { supplierId, invoiceId, paymentAmount, paymentDate, paymentMethod, remarks, idempotencyKey } = payload

  if (!supplierId || !invoiceId) {
    throw Object.assign(new Error('Supplier and invoice references are required.'), { statusCode: 400 })
  }
  if (!Number.isFinite(Number(paymentAmount)) || Number(paymentAmount) <= 0) {
    throw Object.assign(new Error('Payment amount must be a positive number.'), { statusCode: 400 })
  }
  ensureValidDate(paymentDate)
  if (!DEMO_PAYMENT_METHODS.includes(paymentMethod)) {
    throw Object.assign(new Error('Payment method is not supported in demo mode.'), { statusCode: 400 })
  }

  const supplier = store.suppliers.find((entry) => entry.supplierId === supplierId)
  if (!supplier) {
    const error = new Error('Supplier was not found in the local demo dataset.')
    error.statusCode = 404
    throw error
  }
  const invoice = store.invoices.find((entry) => entry.invoiceId === invoiceId)
  if (!invoice) {
    const error = new Error('Invoice was not found in the local demo dataset.')
    error.statusCode = 404
    throw error
  }
  if (invoice.supplierId !== supplierId) {
    throw Object.assign(new Error('The selected invoice does not belong to the selected supplier.'), { statusCode: 409 })
  }

  const paymentRecordsForInvoice = store.paymentRecords.filter((record) => record.invoiceId === invoiceId && record.status === 'Demo Payment Recorded')
  const totalPaid = paymentRecordsForInvoice.reduce((sum, record) => sum + Number(record.paymentAmount), 0)
  const remainingBalance = roundCurrency(Number(invoice.originalAmount) - totalPaid)
  if (remainingBalance <= 0) {
    throw Object.assign(new Error('This invoice has no remaining balance and cannot accept another demo payment.'), { statusCode: 400 })
  }

  const requestedAmount = roundCurrency(Number(paymentAmount))
  if (requestedAmount > remainingBalance) {
    throw Object.assign(new Error('The requested payment exceeds the remaining demo balance for this invoice.'), { statusCode: 400 })
  }
  if (invoice.currency !== (payload.currency ?? invoice.currency)) {
    throw Object.assign(new Error('The proposed payment currency does not match the invoice currency.'), { statusCode: 400 })
  }

  if (idempotencyKey) {
    const duplicate = store.paymentRequests.find((request) => request.idempotencyKey === idempotencyKey)
    if (duplicate) {
      const error = new Error('A duplicate demo payment request already exists for this idempotency key.')
      error.statusCode = 409
      throw error
    }
  }

  const request = {
    requestId: `DPR-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    supplierId: supplier.supplierId,
    supplierName: supplier.supplierName,
    invoiceId: invoice.invoiceId,
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: invoice.invoiceDate,
    dueDate: invoice.dueDate,
    originalAmount: Number(invoice.originalAmount),
    previousPaymentsTotal: roundCurrency(totalPaid),
    remainingBalance: roundCurrency(remainingBalance),
    paymentAmount: requestedAmount,
    paymentDate,
    paymentMethod,
    currency: invoice.currency,
    remarks: remarks ? String(remarks).slice(0, 500) : '',
    idempotencyKey: idempotencyKey ?? `demo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    status: 'Pending Approval',
    approvalStatus: 'pending',
    createdAt: isoNow(),
    updatedAt: isoNow(),
    history: [
      { action: 'submitted', status: 'Pending Approval', timestamp: isoNow(), source: 'local-demo-ui' },
    ],
  }

  store.paymentRequests.push(request)
  await persistStore(store)
  return request
}

export async function approveDemoPaymentRequest(requestId, decision = 'approved', reason = '') {
  const store = await readStore()
  const request = store.paymentRequests.find((entry) => entry.requestId === requestId)
  if (!request) {
    const error = new Error('Demo payment request could not be found.')
    error.statusCode = 404
    throw error
  }
  if (request.status === 'Demo Payment Recorded') {
    throw Object.assign(new Error('This payment request has already been recorded.',), { statusCode: 409 })
  }
  if (request.status === 'Rejected') {
    throw Object.assign(new Error('This request has already been rejected and cannot be changed.',), { statusCode: 409 })
  }

  const action = decision === 'rejected' ? 'rejected' : 'approved'
  if (action === 'rejected') {
    request.status = 'Rejected'
    request.approvalStatus = 'rejected'
    request.rejectionReason = String(reason || 'Rejected in local demo approval workflow.')
  } else {
    request.status = 'Approved for Demo Processing'
    request.approvalStatus = 'approved'
    request.approvalReason = String(reason || 'Approved in local demo approval workflow.')
  }
  request.updatedAt = isoNow()
  request.history.push({
    action,
    status: request.status,
    timestamp: isoNow(),
    source: 'local-demo-approval',
    reason: request.rejectionReason || request.approvalReason || '',
  })

  await persistStore(store)
  return request
}

export async function recordDemoPayment(requestId, options = {}) {
  const store = await readStore()
  const request = store.paymentRequests.find((entry) => entry.requestId === requestId)
  if (!request) {
    const error = new Error('Demo payment request could not be found.')
    error.statusCode = 404
    throw error
  }
  if (request.status === 'Demo Payment Recorded') {
    const error = new Error('This demo payment has already been recorded and cannot be duplicated.')
    error.statusCode = 409
    throw error
  }
  if (request.status !== 'Approved for Demo Processing') {
    throw Object.assign(new Error('Only approved demo payment requests can be recorded.'), { statusCode: 400 })
  }

  if (options.paymentAmount !== undefined && Number(options.paymentAmount) !== Number(request.paymentAmount)) {
    throw Object.assign(new Error('The payment amount does not match the approved demo request.'), { statusCode: 400 })
  }

  const invoice = store.invoices.find((entry) => entry.invoiceId === request.invoiceId)
  if (!invoice) {
    throw Object.assign(new Error('The invoice associated with this request no longer exists in the local demo dataset.'), { statusCode: 404 })
  }
  const previousPayments = store.paymentRecords.filter((record) => record.invoiceId === invoice.invoiceId && record.status === 'Demo Payment Recorded')
  const totalPaid = previousPayments.reduce((sum, record) => sum + Number(record.paymentAmount), 0)
  const remainingBalance = roundCurrency(Number(invoice.originalAmount) - totalPaid)
  if (remainingBalance <= 0) {
    throw Object.assign(new Error('This invoice has already been fully paid in the local demo dataset.'), { statusCode: 400 })
  }
  if (Number(request.paymentAmount) > remainingBalance) {
    throw Object.assign(new Error('The approved payment exceeds the current remaining demo balance.'), { statusCode: 400 })
  }

  const paymentRecord = {
    paymentId: `DPM-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    requestId: request.requestId,
    supplierId: request.supplierId,
    supplierName: request.supplierName,
    invoiceId: request.invoiceId,
    invoiceNumber: request.invoiceNumber,
    paymentAmount: roundCurrency(Number(request.paymentAmount)),
    currency: request.currency,
    paymentDate: request.paymentDate,
    paymentMethod: request.paymentMethod,
    status: 'Demo Payment Recorded',
    createdAt: isoNow(),
  }

  store.paymentRecords.push(paymentRecord)
  request.status = 'Demo Payment Recorded'
  request.updatedAt = isoNow()
  request.history.push({
    action: 'recorded',
    status: 'Demo Payment Recorded',
    timestamp: isoNow(),
    source: 'local-demo-ledger',
  })

  await persistStore(store)
  return paymentRecord
}

export async function getDemoPaymentHistory() {
  const store = await readStore()
  return store.paymentRecords
    .slice()
    .sort((left, right) => {
      const leftDate = left.paymentDate || left.createdAt || ''
      const rightDate = right.paymentDate || right.createdAt || ''
      return rightDate.localeCompare(leftDate) || right.createdAt.localeCompare(left.createdAt)
    })
    .map((record) => ({
      ...record,
      paymentAmount: roundCurrency(Number(record.paymentAmount)),
    }))
}

export async function getDemoPaymentSummaryForInvoice(invoiceId) {
  const store = await readStore()
  const invoice = store.invoices.find((entry) => entry.invoiceId === invoiceId)
  if (!invoice) {
    throw Object.assign(new Error('Demo invoice could not be found.'), { statusCode: 404 })
  }
  const { previousPaymentsTotal, remainingBalance } = calculateInvoiceBalance(invoice, store.paymentRecords)
  return {
    invoiceId: invoice.invoiceId,
    invoiceNumber: invoice.invoiceNumber,
    supplierId: invoice.supplierId,
    originalAmount: Number(invoice.originalAmount),
    previousPaymentsTotal: roundCurrency(previousPaymentsTotal),
    remainingBalance: roundCurrency(remainingBalance),
    currency: invoice.currency,
    dueDate: invoice.dueDate,
  }
}
