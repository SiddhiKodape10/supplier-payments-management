import assert from 'node:assert/strict'
import test from 'node:test'
import axios from 'axios'
import { config } from '../src/config.js'
import app from '../src/app.js'

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

test('unsupported Business Partner writes are disabled', async () => {
  const previousMode = config.dataMode
  config.dataMode = 'sap'
  try {
    await withServer(async (baseUrl) => {
      const { response, body } = await readJson(`${baseUrl}/api/businesspartners`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grouping: '0001', organizationName: 'Example Organization' }),
      })
      assert.equal(response.status, 410)
      assert.match(body.error, /not supported/)
    })
  } finally {
    config.dataMode = previousMode
  }
})

test('health is available with and without the API prefix in demo mode', async () => {
  const previousMode = config.dataMode
  config.dataMode = 'demo'
  try {
    await withServer(async (baseUrl) => {
      for (const path of ['/health', '/api/health']) {
        const { response, body } = await readJson(`${baseUrl}${path}`)
        assert.equal(response.status, 200)
        assert.equal(body.status, 'ok')
        assert.equal(body.application.status, 'healthy')
        assert.equal(body.dataMode, 'demo')
        assert.equal(body.dependencies.sap.status, 'not_checked')
        assert.equal(body.dependencies.sap.paymentObligations.status, 'demo')
      }
    })
  } finally {
    config.dataMode = previousMode
  }
})

test('SAP status reports not configured while demo invoices remain available', async () => {
  const previousMode = config.dataMode
  const previousSap = { ...config.sap }
  config.dataMode = 'demo'
  Object.assign(config.sap, { baseUrl: '', username: '', password: '' })
  try {
    await withServer(async (baseUrl) => {
      const status = await readJson(`${baseUrl}/api/sap/status`)
      assert.equal(status.response.status, 200)
      assert.equal(status.body.status, 'not_configured')
      assert.equal(status.body.paymentDataStatus.status, 'unavailable')
      assert.doesNotMatch(JSON.stringify(status.body), /password|username|https?:\/\//i)

      const invoices = await readJson(`${baseUrl}/api/invoices`)
      assert.equal(invoices.response.status, 200)
      assert.equal(invoices.body.dataMode, 'demo')
      assert.ok(invoices.body.invoices.length > 0)
    })
  } finally {
    config.dataMode = previousMode
    Object.assign(config.sap, previousSap)
  }
})

test('SAP status reports connected only after successful read-only OData response', async () => {
  const previousMode = config.dataMode
  const previousSap = { ...config.sap }
  const previousGet = axios.get
  config.dataMode = 'demo'
  Object.assign(config.sap, {
    baseUrl: 'https://sap.example.test',
    odataPath: '/API_SUPPLIERINVOICE_PROCESS_SRV',
    username: 'test-user',
    password: 'test-password',
  })
  let requestCount = 0
  axios.get = async (url, options) => {
    requestCount += 1
    assert.equal(options.headers.Accept, 'application/json')
    assert.equal(options.headers['Accept-Encoding'], 'gzip, deflate')
    if (url.endsWith('/')) {
      assert.equal(url, 'https://sap.example.test/API_SUPPLIERINVOICE_PROCESS_SRV/')
      assert.deepEqual(options.params, { $format: 'json' })
      return { data: { d: { EntitySets: ['A_SupplierInvoice'] } } }
    }
    return { data: { d: { results: [], __count: '0' } } }
  }
  try {
    await withServer(async (baseUrl) => {
      const { response, body } = await readJson(`${baseUrl}/api/sap/status`)
      assert.equal(response.status, 200)
      assert.equal(body.status, 'connected')
      assert.equal(body.paymentDataStatus.status, 'empty')
      assert.match(body.message, /read-only request/)
      assert.equal(requestCount, 3)
      assert.equal(body.lineItemsStatus.status, 'unavailable')

      const invoices = await readJson(`${baseUrl}/api/invoices`)
      assert.equal(invoices.body.dataMode, 'demo')
      assert.ok(invoices.body.invoices.length > 0)
    })
  } finally {
    axios.get = previousGet
    config.dataMode = previousMode
    Object.assign(config.sap, previousSap)
  }
})

test('SAP status and live payment route verify and return actual supplier invoice records', async () => {
  const previousMode = config.dataMode
  const previousSap = { ...config.sap }
  const previousGet = axios.get
  config.dataMode = 'live'
  Object.assign(config.sap, {
    baseUrl: 'https://sap.example.test',
    odataPath: '/API_SUPPLIERINVOICE_PROCESS_SRV',
    username: 'test-user',
    password: 'test-password',
  })
  axios.get = async (url) => ({
    data: url.endsWith('/')
      ? { d: { EntitySets: ['A_SupplierInvoice'] } }
      : {
          d: {
            results: [{
              SupplierInvoice: '5100001234',
              FiscalYear: '2025',
              CompanyCode: '1000',
              InvoicingParty: '0000100024',
              InvoiceGrossAmount: '215.50',
              DocumentCurrency: 'USD',
            }],
            __count: '1',
          },
        },
  })
  try {
    await withServer(async (baseUrl) => {
      const { response, body } = await readJson(`${baseUrl}/api/sap/status`)
      assert.equal(response.status, 200)
      assert.equal(body.status, 'connected')
      assert.equal(body.paymentDataStatus.status, 'available')
      assert.match(body.paymentDataStatus.reason, /read from SAP/)
      assert.doesNotMatch(JSON.stringify(body), /test-user|test-password|https?:\/\//)

      const payments = await readJson(`${baseUrl}/api/payments`)
      assert.equal(payments.response.status, 200)
      assert.equal(payments.body.dataMode, 'live')
      assert.equal(payments.body.records.length, 1)
      assert.equal(payments.body.records[0].dataSource, 'live')
      assert.equal(payments.body.records[0].supplierName, null)
      assert.equal(payments.body.records[0].paymentStatus, null)
      assert.equal(payments.body.records[0].dueDate, null)
    })
  } finally {
    axios.get = previousGet
    config.dataMode = previousMode
    Object.assign(config.sap, previousSap)
  }
})

test('SAP status reports unavailable on a failed request without leaking credentials', async () => {
  const previousSap = { ...config.sap }
  const previousGet = axios.get
  Object.assign(config.sap, {
    baseUrl: 'https://sap.example.test',
    odataPath: '/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner',
    username: 'status-test-user',
    password: 'status-test-password',
  })
  axios.get = async () => {
    throw Object.assign(new Error('connection refused'), {
      isAxiosError: true,
      config: {},
    })
  }
  try {
    await withServer(async (baseUrl) => {
      const { response, body } = await readJson(`${baseUrl}/api/sap/status`)
      assert.equal(response.status, 200)
      assert.equal(body.status, 'unavailable')
      assert.equal(body.paymentDataStatus.status, 'unavailable')
      assert.match(body.message, /unavailable/i)
      assert.doesNotMatch(JSON.stringify(body), /status-test-user|status-test-password|https?:\/\//)
    })

  } finally {
    axios.get = previousGet
    Object.assign(config.sap, previousSap)
  }
})

test('SAP status classifies authentication, authorization, service errors, and unknown failures', async () => {
  const previousSap = { ...config.sap }
  const previousGet = axios.get
  Object.assign(config.sap, {
    baseUrl: 'https://sap.example.test',
    odataPath: '/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner',
    username: 'classification-test-user',
    password: 'classification-test-password',
  })
  try {
    await withServer(async (baseUrl) => {
      for (const [httpStatus, expected] of [
        [401, 'authentication_failed'],
        [403, 'authorization_failed'],
        [503, 'unavailable'],
        [429, 'other_error'],
      ]) {
        axios.get = async () => {
          throw Object.assign(new Error('sensitive upstream details'), {
            isAxiosError: true,
            response: { status: httpStatus },
            config: { url: 'https://internal.example.test/secret' },
          })
        }
        const { body } = await readJson(`${baseUrl}/api/sap/status`)
        assert.equal(body.status, expected)
        assert.doesNotMatch(
          JSON.stringify(body),
          /classification-test-user|classification-test-password|internal\.example\.test|sensitive upstream/,
        )
      }
      axios.get = async () => {
        throw new Error('unexpected client failure')
      }
      const unknown = await readJson(`${baseUrl}/api/sap/status`)
      assert.equal(unknown.body.status, 'unknown')
    })
  } finally {
    axios.get = previousGet
    Object.assign(config.sap, previousSap)
  }
})

test('demo supplier listing is labelled and searchable', async () => {
  const previousMode = config.dataMode
  config.dataMode = 'demo'
  try {
    await withServer(async (baseUrl) => {
      const { response, body } = await readJson(`${baseUrl}/api/suppliers?search=Northwind`)
      assert.equal(response.status, 200)
      assert.equal(body.dataMode, 'demo')
      assert.equal(body.suppliers.length, 1)
      assert.equal(body.suppliers[0].supplierName, 'Northwind Industrial Supplies')
    })
  } finally {
    config.dataMode = previousMode
  }
})

test('demo invoice listing filters records and paginates', async () => {
  const previousMode = config.dataMode
  config.dataMode = 'demo'
  try {
    await withServer(async (baseUrl) => {
      const { response, body } = await readJson(
        `${baseUrl}/api/invoices?paymentStatus=Overdue&companyCode=US01&top=1`,
      )
      assert.equal(response.status, 200)
      assert.equal(body.dataMode, 'demo')
      assert.equal(body.total, 1)
      assert.equal(body.invoices[0].id, 'PAY-2026-1048')
      assert.equal(body.hasMore, false)
    })

  } finally {
    config.dataMode = previousMode
  }
})

test('payment search filters consistently, supports details, and exports only matching records', async () => {
  const previousMode = config.dataMode
  config.dataMode = 'demo'
  try {
    await withServer(async (baseUrl) => {
      const result = await readJson(
        `${baseUrl}/api/payments?supplierId=SUP-10063&dueDateFrom=2026-10-29&dueDateTo=2026-10-29&minAmount=30000&maxAmount=33000`,
      )
      assert.equal(result.response.status, 200)
      assert.equal(result.body.records.length, 1)
      assert.equal(result.body.records[0].id, 'PAY-2026-1051')
      assert.equal(result.body.records[0].dataSource, 'demo')
      assert.equal(result.body.records[0].documentDate, null)

      const summary = await readJson(
        `${baseUrl}/api/payments/summary?supplierId=SUP-10063&dueDateFrom=2026-10-29&dueDateTo=2026-10-29&minAmount=30000&maxAmount=33000`,
      )
      assert.equal(summary.body.summary.outstandingItemCount, 1)
      assert.equal(summary.body.summary.outstandingAmountByCurrency.USD, 32500)

      const detail = await readJson(`${baseUrl}/api/payments/PAY-2026-1051`)
      assert.equal(detail.body.record.id, 'PAY-2026-1051')

      const csv = await fetch(
        `${baseUrl}/api/payments/export?paymentStatus=Paid&supplierId=SUP-10052`,
      )
      const csvBody = await csv.text()
      assert.equal(csv.status, 200)
      assert.match(csv.headers.get('content-type'), /text\/csv/)
      assert.match(csvBody, /Blue Peak Logistics/)
      assert.doesNotMatch(csvBody, /Northwind Industrial Supplies/)
    })
  } finally {
    config.dataMode = previousMode
  }
})

test('invoice detail validates identifiers and returns demo data only', async () => {
  const previousMode = config.dataMode
  config.dataMode = 'demo'
  try {
    await withServer(async (baseUrl) => {
      const detail = await readJson(`${baseUrl}/api/invoices/PAY-2026-1048`)
      assert.equal(detail.response.status, 200)
      assert.equal(detail.body.dataMode, 'demo')
      assert.equal(detail.body.invoice.supplierId, 'SUP-10024')

      const invalid = await readJson(`${baseUrl}/api/invoices/%2Fetc`)
      assert.equal(invalid.response.status, 400)

      const missing = await readJson(`${baseUrl}/api/invoices/PAY-2026-9999`)
      assert.equal(missing.response.status, 404)
    })
  } finally {
    config.dataMode = previousMode
  }
})

test('payment summary totals are calculated from the demo invoice set', async () => {
  const previousMode = config.dataMode
  config.dataMode = 'demo'
  try {
    await withServer(async (baseUrl) => {
      const { response, body } = await readJson(`${baseUrl}/api/payments/summary`)
      assert.equal(response.status, 200)
      assert.equal(body.dataMode, 'demo')
      assert.equal(body.summary.invoiceCount, 9)
      assert.equal(body.summary.totalInvoiced, 127501.5)
      assert.equal(body.summary.paidAmount, 44005.25)
      assert.equal(body.summary.outstandingAmount, 83496.25)
      assert.equal(body.summary.outstandingItemCount, 6)
      assert.equal(body.summary.overdueCount, 2)
      assert.ok(body.summary.overdueAmountByCurrency.USD > 0)
      assert.ok(body.summary.upcomingPeriod.from)
    })
  } finally {
    config.dataMode = previousMode
  }
})

test('invalid invoice query parameters receive a client error', async () => {
  const previousMode = config.dataMode
  config.dataMode = 'demo'
  try {
    await withServer(async (baseUrl) => {
      for (const query of [
        '?top=0',
        '?paymentStatus=Processing',
        '?currency=USDD',
        '?unknown=value',
        '?search=first&search=second',
      ]) {
        const { response } = await readJson(`${baseUrl}/api/invoices${query}`)
        assert.equal(response.status, 400, query)
      }
    })
  } finally {
    config.dataMode = previousMode
  }
})

test('SAP mode does not fall back to demo suppliers or invoices when SAP is unavailable', async () => {
  const previousMode = config.dataMode
  const previousSap = { ...config.sap }
  config.dataMode = 'sap'
  config.sap.baseUrl = ''
  config.sap.username = ''
  config.sap.password = ''
  try {
    await withServer(async (baseUrl) => {
      const suppliers = await readJson(`${baseUrl}/api/suppliers`)
      assert.equal(suppliers.response.status, 503)
      assert.equal(suppliers.body.dataMode, 'unavailable')
      assert.doesNotMatch(JSON.stringify(suppliers.body), /Northwind|SUP-10024/)

      const invoices = await readJson(`${baseUrl}/api/invoices`)
      assert.equal(invoices.response.status, 503)
      assert.equal(invoices.body.dataMode, 'unavailable')
      assert.equal(invoices.body.invoices, undefined)

      const summary = await readJson(`${baseUrl}/api/payments/summary`)
      assert.equal(summary.response.status, 503)
      assert.equal(summary.body.summary, undefined)

      const payments = await readJson(`${baseUrl}/api/payments`)
      assert.equal(payments.response.status, 503)
      assert.equal(payments.body.dataMode, 'unavailable')
      assert.equal(payments.body.records, undefined)

      const exportResponse = await fetch(`${baseUrl}/api/payments/export`)
      assert.equal(exportResponse.status, 503)
      assert.doesNotMatch(await exportResponse.text(), /Northwind|SUP-10024/)
    })
  } finally {
    config.dataMode = previousMode
    Object.assign(config.sap, previousSap)
  }
})

test('unsupported payment and business partner writes do not execute', async () => {
  const previousMode = config.dataMode
  config.dataMode = 'demo'
  try {
    await withServer(async (baseUrl) => {
      const { response, body } = await readJson(`${baseUrl}/api/businesspartners`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmed: true,
          grouping: '0001',
          organizationName: 'Example Organization',
        }),
      })
      assert.equal(response.status, 410)
      assert.match(body.error, /not supported/)

      const paymentWrite = await readJson(`${baseUrl}/api/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 100 }),
      })
      assert.equal(paymentWrite.response.status, 404)
    })
  } finally {
    config.dataMode = previousMode
  }
})

test('payment assistant receives backend-filtered demo records and identifies its data source', async () => {
  const previousMode = config.dataMode
  const previousPost = axios.post
  config.dataMode = 'demo'
  let submittedContext
  axios.post = async (url, payload) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/chat')
    submittedContext = JSON.parse(payload.messages[1].content)
    return {
      data: {
        done: true,
        message: { content: JSON.stringify({ answer: 'This is a demo record.' }) },
      },
    }
  }
  try {
    await withServer(async (baseUrl) => {
      const { response, body } = await readJson(`${baseUrl}/api/ai/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Show the due date for Northwind',
          filters: { supplierId: 'SUP-10024' },
        }),
      })
      assert.equal(response.status, 200)
      assert.equal(body.dataMode, 'demo')
      assert.equal(body.matchedRecordCount, 1)
      assert.equal(body.answer, 'This is a demo record.')
      assert.equal(submittedContext.paymentData.dataMode, 'demo')
      assert.equal(submittedContext.paymentData.records[0].supplierId, 'SUP-10024')
      assert.equal(submittedContext.paymentData.records[0].documentDate, null)
    })
  } finally {
    axios.post = previousPost
    config.dataMode = previousMode
  }
})

test('payment assistant refuses actions and Ollama failure does not affect other endpoints', async () => {
  const previousMode = config.dataMode
  const previousPost = axios.post
  config.dataMode = 'demo'
  try {
    await withServer(async (baseUrl) => {
      const action = await readJson(`${baseUrl}/api/ai/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Approve this payment' }),
      })
      assert.equal(action.response.status, 422)

      axios.post = async () => {
        throw Object.assign(new Error('internal Ollama URL and credentials'), {
          isAxiosError: true,
          config: { url: 'http://127.0.0.1:11434/api/chat' },
        })
      }
      const assistant = await readJson(`${baseUrl}/api/ai/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Summarize these demo obligations' }),
      })
      assert.equal(assistant.response.status, 503)
      assert.doesNotMatch(JSON.stringify(assistant.body), /internal Ollama|credentials|11434/)

      const dashboard = await readJson(`${baseUrl}/api/payments`)
      assert.equal(dashboard.response.status, 200)
      assert.equal(dashboard.body.dataMode, 'demo')
    })
  } finally {
    axios.post = previousPost
    config.dataMode = previousMode
  }
})
