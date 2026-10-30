import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import app from '../src/app.js'

async function resetDemoStore() {
  const storePath = path.join(process.cwd(), '.tmp-demo-payment-store.json')
  await fs.rm(storePath, { force: true })
  process.env.DEMO_PAYMENT_STORE_PATH = storePath
  return storePath
}

async function withServer(run) {
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  try {
    const address = server.address()
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
}

async function readJson(url, options) {
  const response = await fetch(url, options)
  return { response, body: await response.json() }
}

test('demo suppliers can be listed from the local store', async () => {
  const previousPath = process.env.DEMO_PAYMENT_STORE_PATH
  await resetDemoStore()
  try {
    await withServer(async (baseUrl) => {
      const { response, body } = await readJson(`${baseUrl}/api/demo/suppliers`)
      assert.equal(response.status, 200)
      assert.ok(Array.isArray(body.suppliers))
      assert.ok(body.suppliers.length >= 2)
      assert.equal(body.suppliers[0].supplierId.includes('DEMO-'), true)
    })
  } finally {
    if (previousPath === undefined) {
      delete process.env.DEMO_PAYMENT_STORE_PATH
    } else {
      process.env.DEMO_PAYMENT_STORE_PATH = previousPath
    }
  }
})

test('demo invoices can be listed per supplier and reject invalid suppliers', async () => {
  const previousPath = process.env.DEMO_PAYMENT_STORE_PATH
  await resetDemoStore()
  try {
    await withServer(async (baseUrl) => {
      const valid = await readJson(`${baseUrl}/api/demo/invoices?supplierId=DEMO-SUP-1001`)
      assert.equal(valid.response.status, 200)
      assert.ok(valid.body.invoices.length >= 1)
      assert.equal(valid.body.invoices[0].supplierId, 'DEMO-SUP-1001')

      const invalid = await readJson(`${baseUrl}/api/demo/invoices?supplierId=UNKNOWN-SUPPLIER`)
      assert.equal(invalid.response.status, 404)
      assert.match(invalid.body.error, /supplier/i)
    })
  } finally {
    if (previousPath === undefined) {
      delete process.env.DEMO_PAYMENT_STORE_PATH
    } else {
      process.env.DEMO_PAYMENT_STORE_PATH = previousPath
    }
  }
})

test('a valid payment request is created and can be approved before recording', async () => {
  const previousPath = process.env.DEMO_PAYMENT_STORE_PATH
  await resetDemoStore()
  try {
    await withServer(async (baseUrl) => {
      const requestPayload = {
        supplierId: 'DEMO-SUP-1001',
        invoiceId: 'INV-84521',
        paymentAmount: 250.00,
        paymentDate: '2026-11-10',
        paymentMethod: 'ACH',
        remarks: 'CEO demo payment request',
        idempotencyKey: 'demo-request-001',
      }

      const created = await readJson(`${baseUrl}/api/demo/payment-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestPayload),
      })
      assert.equal(created.response.status, 201)
      assert.equal(created.body.request.status, 'Pending Approval')
      assert.equal(created.body.request.supplierId, 'DEMO-SUP-1001')

      const approved = await readJson(`${baseUrl}/api/demo/payment-requests/${created.body.request.requestId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approved', reason: 'Demo approval by executive sponsor' }),
      })
      assert.equal(approved.response.status, 200)
      assert.equal(approved.body.request.status, 'Approved for Demo Processing')

      const recorded = await readJson(`${baseUrl}/api/demo/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: created.body.request.requestId }),
      })
      assert.equal(recorded.response.status, 201)
      assert.equal(recorded.body.payment.status, 'Demo Payment Recorded')
      assert.equal(recorded.body.payment.invoiceId, 'INV-84521')
    })
  } finally {
    if (previousPath === undefined) {
      delete process.env.DEMO_PAYMENT_STORE_PATH
    } else {
      process.env.DEMO_PAYMENT_STORE_PATH = previousPath
    }
  }
})

test('overpayment and duplicate submissions are rejected on the backend', async () => {
  const previousPath = process.env.DEMO_PAYMENT_STORE_PATH
  await resetDemoStore()
  try {
    await withServer(async (baseUrl) => {
      const requestPayload = {
        supplierId: 'DEMO-SUP-1002',
        invoiceId: 'INV-99001',
        paymentAmount: 1000,
        paymentDate: '2026-11-12',
        paymentMethod: 'WIRE',
        idempotencyKey: 'demo-request-duplicate-001',
      }

      const created = await readJson(`${baseUrl}/api/demo/payment-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestPayload),
      })
      assert.equal(created.response.status, 201)

      const duplicate = await readJson(`${baseUrl}/api/demo/payment-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...requestPayload, idempotencyKey: 'demo-request-duplicate-001' }),
      })
      assert.equal(duplicate.response.status, 409)

      const approval = await readJson(`${baseUrl}/api/demo/payment-requests/${created.body.request.requestId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approved' }),
      })
      assert.equal(approval.response.status, 200)

      const overpay = await readJson(`${baseUrl}/api/demo/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: created.body.request.requestId, paymentAmount: 999999 }),
      })
      assert.equal(overpay.response.status, 400)
    })
  } finally {
    if (previousPath === undefined) {
      delete process.env.DEMO_PAYMENT_STORE_PATH
    } else {
      process.env.DEMO_PAYMENT_STORE_PATH = previousPath
    }
  }
})

test('demo payment lifecycle keeps approval and history synchronized with invoice balances', async () => {
  const previousPath = process.env.DEMO_PAYMENT_STORE_PATH
  await resetDemoStore()
  try {
    await withServer(async (baseUrl) => {
      const invoiceBefore = await readJson(`${baseUrl}/api/demo/invoices?supplierId=DEMO-SUP-1001`)
      const originalBalance = invoiceBefore.body.invoices.find((invoice) => invoice.invoiceId === 'INV-84521').remainingBalance

      const created = await readJson(`${baseUrl}/api/demo/payment-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplierId: 'DEMO-SUP-1001',
          invoiceId: 'INV-84521',
          paymentAmount: 250,
          paymentDate: '2026-11-10',
          paymentMethod: 'ACH',
          currency: 'USD',
          idempotencyKey: 'demo-lifecycle-001',
        }),
      })
      assert.equal(created.response.status, 201)

      const requestList = await readJson(`${baseUrl}/api/demo/payment-requests`)
      assert.equal(requestList.response.status, 200)
      assert.equal(requestList.body.paymentRequests.filter((request) => request.requestId === created.body.request.requestId).length, 1)

      const historyBeforeApproval = await readJson(`${baseUrl}/api/demo/payments`)
      assert.equal(historyBeforeApproval.response.status, 200)
      assert.equal(historyBeforeApproval.body.payments.some((record) => record.requestId === created.body.request.requestId), false)

      const invoiceAfterCreate = await readJson(`${baseUrl}/api/demo/invoices?supplierId=DEMO-SUP-1001`)
      const invoice = invoiceAfterCreate.body.invoices.find((entry) => entry.invoiceId === 'INV-84521')
      assert.equal(invoice.remainingBalance, originalBalance)

      const approved = await readJson(`${baseUrl}/api/demo/payment-requests/${created.body.request.requestId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approved', reason: 'approved by treasury' }),
      })
      assert.equal(approved.response.status, 200)
      assert.equal(approved.body.request.status, 'Approved for Demo Processing')

      const approvedInvoice = await readJson(`${baseUrl}/api/demo/invoices?supplierId=DEMO-SUP-1001`)
      const approvedInvoiceEntry = approvedInvoice.body.invoices.find((entry) => entry.invoiceId === 'INV-84521')
      assert.equal(approvedInvoiceEntry.remainingBalance, originalBalance)

      const recorded = await readJson(`${baseUrl}/api/demo/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: created.body.request.requestId }),
      })
      assert.equal(recorded.response.status, 201)
      assert.equal(recorded.body.payment.requestId, created.body.request.requestId)
      assert.equal(recorded.body.payment.status, 'Demo Payment Recorded')

      const paymentHistory = await readJson(`${baseUrl}/api/demo/payments`)
      assert.equal(paymentHistory.response.status, 200)
      assert.equal(paymentHistory.body.payments.filter((record) => record.requestId === created.body.request.requestId).length, 1)

      const invoiceAfterRecord = await readJson(`${baseUrl}/api/demo/invoices?supplierId=DEMO-SUP-1001`)
      const updatedInvoice = invoiceAfterRecord.body.invoices.find((entry) => entry.invoiceId === 'INV-84521')
      assert.equal(updatedInvoice.remainingBalance, originalBalance - 250)

      const duplicateRecord = await readJson(`${baseUrl}/api/demo/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: created.body.request.requestId }),
      })
      assert.equal(duplicateRecord.response.status, 409)
    })
  } finally {
    if (previousPath === undefined) {
      delete process.env.DEMO_PAYMENT_STORE_PATH
    } else {
      process.env.DEMO_PAYMENT_STORE_PATH = previousPath
    }
  }
})

test('demo payment validation blocks invalid lifecycle transitions and data mixing', async () => {
  const previousPath = process.env.DEMO_PAYMENT_STORE_PATH
  await resetDemoStore()
  try {
    await withServer(async (baseUrl) => {
      const invalidAmount = await readJson(`${baseUrl}/api/demo/payment-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supplierId: 'DEMO-SUP-1001', invoiceId: 'INV-84521', paymentAmount: 0, paymentDate: '2026-11-10', paymentMethod: 'ACH', currency: 'USD', idempotencyKey: 'demo-invalid-001' }),
      })
      assert.equal(invalidAmount.response.status, 400)

      const overpay = await readJson(`${baseUrl}/api/demo/payment-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supplierId: 'DEMO-SUP-1001', invoiceId: 'INV-84521', paymentAmount: 999999, paymentDate: '2026-11-10', paymentMethod: 'ACH', currency: 'USD', idempotencyKey: 'demo-invalid-002' }),
      })
      assert.equal(overpay.response.status, 400)

      const mismatchedSupplier = await readJson(`${baseUrl}/api/demo/payment-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supplierId: 'DEMO-SUP-1002', invoiceId: 'INV-84521', paymentAmount: 100, paymentDate: '2026-11-10', paymentMethod: 'ACH', currency: 'USD', idempotencyKey: 'demo-invalid-003' }),
      })
      assert.equal(mismatchedSupplier.response.status, 409)

      const currencyMismatch = await readJson(`${baseUrl}/api/demo/payment-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supplierId: 'DEMO-SUP-1001', invoiceId: 'INV-84521', paymentAmount: 100, paymentDate: '2026-11-10', paymentMethod: 'ACH', currency: 'EUR', idempotencyKey: 'demo-invalid-004' }),
      })
      assert.equal(currencyMismatch.response.status, 400)

      const created = await readJson(`${baseUrl}/api/demo/payment-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supplierId: 'DEMO-SUP-1001', invoiceId: 'INV-84521', paymentAmount: 140, paymentDate: '2026-11-10', paymentMethod: 'ACH', currency: 'USD', idempotencyKey: 'demo-invalid-005' }),
      })
      assert.equal(created.response.status, 201)

      const rejected = await readJson(`${baseUrl}/api/demo/payment-requests/${created.body.request.requestId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'rejected', reason: 'rejected for testing' }),
      })
      assert.equal(rejected.response.status, 200)
      assert.equal(rejected.body.request.status, 'Rejected')

      const recordRejected = await readJson(`${baseUrl}/api/demo/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: created.body.request.requestId }),
      })
      assert.equal(recordRejected.response.status, 400)
    })
  } finally {
    if (previousPath === undefined) {
      delete process.env.DEMO_PAYMENT_STORE_PATH
    } else {
      process.env.DEMO_PAYMENT_STORE_PATH = previousPath
    }
  }
})

test('demo payment store remains idempotent and persists across a restart', async () => {
  const previousStorePath = process.env.DEMO_PAYMENT_STORE_PATH
  const storePath = path.join(process.cwd(), '.tmp-demo-payment-store.json')
  await fs.rm(storePath, { force: true })
  process.env.DEMO_PAYMENT_STORE_PATH = storePath
  try {
    await withServer(async (baseUrl) => {
      const created = await readJson(`${baseUrl}/api/demo/payment-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supplierId: 'DEMO-SUP-1001', invoiceId: 'INV-18205', paymentAmount: 300, paymentDate: '2026-11-12', paymentMethod: 'WIRE', currency: 'USD', idempotencyKey: 'demo-persistence-001' }),
      })
      assert.equal(created.response.status, 201)

      const beforeRestart = await readJson(`${baseUrl}/api/demo/payment-requests`)
      assert.equal(beforeRestart.response.status, 200)
      assert.equal(beforeRestart.body.paymentRequests.filter((request) => request.idempotencyKey === 'demo-persistence-001').length, 1)
    })

    await withServer(async (baseUrl) => {
      const afterRestart = await readJson(`${baseUrl}/api/demo/payment-requests`)
      assert.equal(afterRestart.response.status, 200)
      assert.equal(afterRestart.body.paymentRequests.filter((request) => request.idempotencyKey === 'demo-persistence-001').length, 1)
    })
  } finally {
    await fs.rm(storePath, { force: true })
    if (previousStorePath === undefined) {
      delete process.env.DEMO_PAYMENT_STORE_PATH
    } else {
      process.env.DEMO_PAYMENT_STORE_PATH = previousStorePath
    }
  }
})
