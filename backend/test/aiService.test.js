import assert from 'node:assert/strict'
import test from 'node:test'
import axios from 'axios'
import { config } from '../src/config.js'
import {
  answerPaymentQuestion,
  getCompletedAssistantContent,
  parsePaymentAnswer,
  parseAssistantContent,
  validateAssistantResult,
} from '../src/services/aiService.js'
import { buildCriteriaFilter } from '../src/services/sapService.js'

test('assistant response accepts only supported criteria in JSON', () => {
  assert.deepEqual(
    parseAssistantContent(
      JSON.stringify({
        criteria: {
          businessPartnerNumber: '1000001',
          organizationName: 'Global',
          category: 'Organization',
          grouping: 'Z001',
        },
        unsupported: [],
      }),
    ),
    {
      businessPartnerNumber: '1000001',
      organizationName: 'Global',
      category: 'Organization',
      grouping: 'Z001',
    },
  )
})

test('assistant reports unsupported criteria rather than searching', () => {
  assert.throws(
    () =>
      validateAssistantResult({
        criteria: { organizationName: 'Global' },
        unsupported: ['supplier addresses'],
      }),
    (error) =>
      error.statusCode === 422 &&
      error.message.includes('supplier addresses'),
  )
})

test('assistant rejects arbitrary query properties and malformed JSON', () => {
  assert.throws(
    () =>
      validateAssistantResult({
        criteria: { filter: 'BusinessPartner eq 1' },
        unsupported: [],
      }),
    { statusCode: 502 },
  )
  assert.throws(() => parseAssistantContent('not JSON'), { statusCode: 502 })
})

test('assistant rejects incomplete Ollama generation with actionable error', () => {
  assert.throws(
    () => getCompletedAssistantContent({ done: false, message: { content: '' } }),
    (error) => error.statusCode === 502 && error.message.includes('ollama run llama3.2'),
  )
  assert.equal(
    getCompletedAssistantContent({ done: true, message: { content: '{"criteria":{}}' } }),
    '{"criteria":{}}',
  )
})

test('criteria translate only to allowlisted direct A_BusinessPartner fields', () => {
  assert.equal(
    buildCriteriaFilter({
      businessPartnerNumber: '1000001',
      organizationName: 'Global',
      category: 'Organization',
      grouping: 'Z001',
    }),
    "BusinessPartner eq '1000001' and (substringof('Global',OrganizationBPName1) or substringof('Global',OrganizationBPName2)) and BusinessPartnerCategory eq '2' and BusinessPartnerGrouping eq 'Z001'",
  )
})

test('payment assistant receives only backend-filtered records and labels demo information', async () => {
  const previousMode = config.dataMode
  config.dataMode = 'demo'
  let postedPayload
  try {
    const result = await answerPaymentQuestion(
      'Show me the due date for this supplier',
      { supplierId: 'SUP-10024' },
      {
        client: {
          async post(url, payload) {
            assert.equal(url, 'http://127.0.0.1:11434/api/chat')
            postedPayload = payload
            return {
              data: {
                done: true,
                message: { content: JSON.stringify({ answer: 'This is fictional demo data.' }) },
              },
            }
          },
        },
      },
    )
    const context = JSON.parse(postedPayload.messages[1].content).paymentData
    assert.equal(context.dataMode, 'demo')
    assert.equal(context.records.length, 1)
    assert.equal(context.records[0].supplierId, 'SUP-10024')
    assert.equal(context.records[0].documentDate, null)
    assert.equal(result.dataMode, 'demo')
    assert.equal(result.matchedRecordCount, 1)
    assert.match(result.answer, /demo data/)
  } finally {
    config.dataMode = previousMode
  }
})

test('payment assistant refuses actions, handles Ollama failures, and uses only live SAP invoices in live mode', async () => {
  const previousMode = config.dataMode
  const previousSap = { ...config.sap }
  const previousGet = axios.get
  config.dataMode = 'demo'
  try {
    let called = false
    await assert.rejects(
      answerPaymentQuestion('Approve payment SUP-10024', {}, {
        client: { post: async () => { called = true } },
      }),
      (error) => error.statusCode === 422,
    )
    assert.equal(called, false)

    await assert.rejects(
      answerPaymentQuestion('Summarize the obligations', {}, {
        client: {
          async post() {
            throw Object.assign(new Error('connection refused'), { isAxiosError: true })
          },
        },
      }),
      (error) => error.statusCode === 503 && !/connection refused|11434/.test(error.message),
    )

    config.dataMode = 'live'
    Object.assign(config.sap, {
      baseUrl: 'https://sap.example.test',
      odataPath: '/API_SUPPLIERINVOICE_PROCESS_SRV',
      username: 'test-user',
      password: 'test-password',
    })
    let ollamaCalled = false
    axios.get = async () => {
      throw Object.assign(new Error('upstream unavailable'), {
        isAxiosError: true,
        response: { status: 503 },
      })
    }
    await assert.rejects(
      answerPaymentQuestion('Summarize obligations', {}, {
        client: { post: async () => { ollamaCalled = true } },
      }),
      (error) => error.statusCode === 502,
    )
    assert.equal(ollamaCalled, false)

    const invoice = {
      SupplierInvoice: '5100001234',
      FiscalYear: '2025',
      InvoicingParty: '0000100024',
      InvoiceGrossAmount: '215.50',
      DocumentCurrency: 'USD',
      SupplierInvoiceStatus: '5',
    }
    axios.get = async (url) => ({
      data: url.endsWith('/')
        ? { d: { EntitySets: ['A_SupplierInvoice'] } }
        : { d: { results: [invoice], __count: '1' } },
    })
    let postedPayload
    const result = await answerPaymentQuestion('Explain the invoice record', {}, {
      client: {
        async post(_url, payload) {
          postedPayload = payload
          return {
            data: {
              done: true,
              message: { content: JSON.stringify({ answer: 'Payment status is unavailable.' }) },
            },
          }
        },
      },
    })
    const context = JSON.parse(postedPayload.messages[1].content).paymentData
    assert.equal(context.dataMode, 'live')
    assert.equal(context.records.length, 1)
    assert.equal(context.records[0].paymentStatus, null)
    assert.equal(context.records[0].invoiceProcessingStatus, '5')
    assert.equal(context.summary.status, 'unavailable')
    assert.equal(result.dataMode, 'live')
    assert.equal(result.records.length, 1)
    assert.ok(result.limitations.some((limitation) => /payment status/i.test(limitation)))
  } finally {
    axios.get = previousGet
    config.dataMode = previousMode
    Object.assign(config.sap, previousSap)
  }
})

test('payment assistant bounds live SAP records when more than 100 match', async () => {
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
  try {
    const records = Array.from({ length: 100 }, (_, index) => ({
      SupplierInvoice: `5100${String(index).padStart(6, '0')}`,
      FiscalYear: '2025',
      InvoicingParty: '0000100024',
      InvoiceGrossAmount: '100.00',
      DocumentCurrency: 'USD',
      SupplierInvoiceStatus: '5',
    }))
    axios.get = async (url) => ({
      data: url.endsWith('/')
        ? { d: { EntitySets: ['A_SupplierInvoice'] } }
        : { d: { results: records, __count: '101' } },
    })
    const result = await answerPaymentQuestion('Summarize the invoices', {}, {
      client: {
        async post() {
          return {
            data: {
              done: true,
              message: { content: JSON.stringify({ answer: 'Only live invoice records are available.' }) },
            },
          }
        },
      },
    })
    assert.equal(result.records.length, 100)
    assert.equal(result.matchedRecordCount, 100)
    assert.ok(result.limitations.some((limitation) => /first 100 of 101/.test(limitation)))
  } finally {
    axios.get = previousGet
    config.dataMode = previousMode
    Object.assign(config.sap, previousSap)
  }
})

test('payment assistant response is constrained and validates malformed model output', () => {
  assert.equal(parsePaymentAnswer('{"answer":"No matching records."}'), 'No matching records.')
  assert.throws(() => parsePaymentAnswer('{"answer":"x","amount":100}'), { statusCode: 502 })
  assert.throws(() => parsePaymentAnswer('not JSON'), { statusCode: 502 })
})
