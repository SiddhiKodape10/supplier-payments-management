import axios from 'axios'
import { config, isAiConfigured } from '../config.js'
import { IntegrationError, searchBusinessPartners } from './sapService.js'
import {
  calculatePaymentSummary,
  createUnavailableSapPaymentSummary,
  filterPaymentObligations,
  getSapSupplierInvoices,
  getSapVendorLineItemsPage,
  getDemoPaymentObligations,
  getPaymentDataMode,
} from './supplierPaymentsService.js'

const CRITERIA_FIELDS = new Set([
  'businessPartnerNumber',
  'organizationName',
  'category',
  'grouping',
])

const SEARCH_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    criteria: {
      type: 'object',
      properties: {
        businessPartnerNumber: { type: 'string' },
        organizationName: { type: 'string' },
        category: { type: 'string' },
        grouping: { type: 'string' },
      },
      additionalProperties: false,
    },
    unsupported: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['criteria', 'unsupported'],
  additionalProperties: false,
}

const SYSTEM_PROMPT = `You are a strict parser for read-only SAP Business Partner searches. Extract filters from the user request and return only JSON matching the supplied schema.
Allowed criteria are exactly: businessPartnerNumber, organizationName, category, grouping.
The words "find", "show", "list", "search", "read", and "Business Partner" describe this supported search. NEVER put these words or supported criteria in unsupported.
businessPartnerNumber is the explicitly requested BP number.
organizationName is an explicitly requested organization name or name fragment.
category is one of Person, Organization, Group, 1, 2, or 3.
grouping is an explicitly requested BP grouping.
Set unsupported only when the user explicitly requests something outside read-only BP search, such as creating/updating/deleting a record, addresses, or another entity. Briefly explain each unsupported request.
If the request has no supported criterion, return empty criteria. Never invent values, return records, create OData, or generate code.
Examples:
User: Find Business Partner 1000001
JSON: {"criteria":{"businessPartnerNumber":"1000001"},"unsupported":[]}
User: Show Business Partners with names containing Global
JSON: {"criteria":{"organizationName":"Global"},"unsupported":[]}
User: List Business Partners with category Organization
JSON: {"criteria":{"category":"Organization"},"unsupported":[]}
User: Find Business Partner 1000001 and create a supplier
JSON: {"criteria":{"businessPartnerNumber":"1000001"},"unsupported":["Creating a supplier is not supported."]}`

const PAYMENT_ANSWER_SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
}

const PAYMENT_SYSTEM_PROMPT = `You answer read-only questions about the backend-retrieved supplier invoice records and summary supplied in the user message.
Use only the supplied data. Do not guess, calculate, infer missing fields, or invent financial amounts, dates, references, statuses, or suppliers.
Always call the records DEMO SAMPLE DATA when dataMode is demo; never imply it is verified SAP data.
When dataMode is live, invoice records are SAP supplier invoices, not confirmed payment obligations. Accounting line items may be supplied separately as verified read-only SAP accounting records. Never infer payment status from SupplierInvoiceStatus. Clearing evidence, due dates, balances, and document classification are supported only by the explicitly supplied fields and summary metric status. Never claim an invoice or accounting item is paid, unpaid, overdue, or due unless the supplied data explicitly verifies it.
If a requested value is null, missing, or absent, say it is unavailable.
Do not create, update, approve, post, release, initiate, or execute payments. Do not claim an action was taken.
Return a complete sentence or short explanation, not a bare number or identifier. Keep the answer brief and return only JSON matching the supplied schema.`

function validateAssistantResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IntegrationError('Ollama returned an invalid search response.', 502)
  }
  const resultKeys = Object.keys(value)
  if (
    resultKeys.some((key) => !['criteria', 'unsupported'].includes(key)) ||
    !value.criteria ||
    typeof value.criteria !== 'object' ||
    Array.isArray(value.criteria) ||
    !Array.isArray(value.unsupported) ||
    value.unsupported.some((item) => typeof item !== 'string')
  ) {
    throw new IntegrationError('Ollama returned an invalid search response.', 502)
  }

  const criteriaKeys = Object.keys(value.criteria)
  if (criteriaKeys.some((key) => !CRITERIA_FIELDS.has(key))) {
    throw new IntegrationError(
      'Ollama returned unsupported search fields. No SAP search was performed.',
      502,
    )
  }
  for (const [key, criterion] of Object.entries(value.criteria)) {
    if (
      typeof criterion !== 'string' ||
      !criterion.trim() ||
      criterion.length > (key === 'organizationName' ? 100 : 40)
    ) {
      throw new IntegrationError(
        `Ollama returned an invalid value for ${key}. No SAP search was performed.`,
        502,
      )
    }
  }

  const unsupported = value.unsupported
    .map((item) => item.trim())
    .filter(Boolean)
  if (unsupported.length) {
    throw new IntegrationError(
      `Unsupported request: ${unsupported.join('; ')}. Supported searches use Business Partner number, organization name, category, or grouping only.`,
      422,
    )
  }
  if (criteriaKeys.length === 0) {
    throw new IntegrationError(
      'I could not identify a supported Business Partner search criterion. Try a Business Partner number, organization name, category, or grouping.',
      422,
    )
  }

  return value.criteria
}

function parseAssistantContent(content) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new IntegrationError('Ollama returned an empty search response.', 502)
  }
  let parsed
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new IntegrationError('Ollama did not return valid structured JSON.', 502)
  }
  return validateAssistantResult(parsed)
}

function getCompletedAssistantContent(responseData) {
  if (responseData?.done !== true) {
    throw new IntegrationError(
      'Ollama did not complete generation. Restart the local Ollama service, verify llama3.2 inference with `ollama run llama3.2`, then retry.',
      502,
    )
  }
  return responseData.message?.content
}

function ollamaChatUrl() {
  const base = new URL(config.ai.url)
  return new URL('/api/chat', base).toString()
}

export async function searchWithAssistant(prompt, { client = axios } = {}) {
  if (!isAiConfigured()) {
    throw new IntegrationError(
      'Local Ollama is unavailable or misconfigured. Set OLLAMA_URL to a localhost Ollama URL and OLLAMA_MODEL (for example, llama3.2) in backend/.env.',
      503,
    )
  }

  let response
  try {
    response = await client.post(
      ollamaChatUrl(),
      {
        model: config.ai.model,
        stream: false,
        format: SEARCH_RESPONSE_SCHEMA,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        options: { temperature: 0 },
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 60000,
        maxRedirects: 0,
      },
    )
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (!error.response) {
        throw new IntegrationError(
          'Could not connect to local Ollama. Start Ollama at the configured localhost URL and ensure the llama3.2 model is installed.',
          503,
        )
      }
      if (error.response.status === 404) {
        throw new IntegrationError(
          'Ollama or the configured model was not found. Start Ollama and install the model with `ollama pull llama3.2`.',
          503,
        )
      }
      throw new IntegrationError(
        `Local Ollama request failed (HTTP ${error.response.status}). Check the Ollama service and configured model.`,
        502,
      )
    }
    throw error
  }

  const criteria = parseAssistantContent(getCompletedAssistantContent(response.data))
  const result = await searchBusinessPartners({
    criteria,
    top: 25,
    skip: 0,
  })
  return {
    criteria,
    businessPartners: result.records,
    hasMore: result.hasMore,
  }
}

function parsePaymentAnswer(content) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new IntegrationError('Ollama returned an empty payment-assistant response.', 502)
  }
  let parsed
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new IntegrationError('Ollama did not return a valid payment-assistant response.', 502)
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1 ||
    typeof parsed.answer !== 'string' ||
    !parsed.answer.trim() ||
    parsed.answer.length > 2000
  ) {
    throw new IntegrationError('Ollama returned an invalid payment-assistant response.', 502)
  }
  return parsed.answer.trim()
}

export async function answerPaymentQuestion(prompt, filters = {}, { client = axios } = {}) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 2000) {
    throw new IntegrationError('Prompt must contain 1 to 2000 characters.', 400)
  }
  if (/\b(create|creating|approve|approved|post|posting|execute|executing|initiate|release|pay|make|change|update|delete|remove|schedule|authorize)\b/i.test(prompt)) {
    throw new IntegrationError(
      'Payment actions and record changes are not supported; this assistant is read-only.',
      422,
    )
  }
  if (!isAiConfigured()) {
    throw new IntegrationError(
      'Local Ollama is unavailable or misconfigured. Set OLLAMA_URL to a localhost URL and OLLAMA_MODEL in backend/.env.',
      503,
    )
  }
  const dataMode = getPaymentDataMode()
  let records
  let liveMatchTotal = null
  if (dataMode === 'demo') {
    records = filterPaymentObligations(getDemoPaymentObligations(), filters).slice(0, 100)
  } else {
    const page = await getSapSupplierInvoices({
      filters,
      top: 100,
      skip: 0,
    })
    records = page.records
    liveMatchTotal = page.total
  }
  let accountingLineItems = []
  let summary = dataMode === 'demo'
    ? calculatePaymentSummary(records)
    : createUnavailableSapPaymentSummary(records)
  if (dataMode === 'live') {
    try {
      const accountingPage = await getSapVendorLineItemsPage(filters, { top: 100, skip: 0, client })
      accountingLineItems = accountingPage.records
    } catch {
      accountingLineItems = []
    }
  }
  if (liveMatchTotal !== null && liveMatchTotal > records.length) {
    summary.limitations = [
      ...summary.limitations,
      `The assistant received only the first ${records.length} of ${liveMatchTotal} matching live SAP invoices to keep the local model context bounded.`,
    ]
  }
  const context = {
    dataMode,
    records: records.map((record) => ({
      id: record.id,
      supplierId: record.supplierId,
      supplierName: record.supplierName,
      companyCode: record.companyCode,
      documentReference: record.documentReference,
      documentDate: record.documentDate,
      postingDate: record.postingDate,
      dueDate: record.dueDate,
      amount: record.amount,
      currency: record.currency,
      paymentStatus: record.paymentStatus,
      invoiceProcessingStatus: record.invoiceProcessingStatus,
      clearingDate: record.clearingDate,
      paymentReference: record.paymentReference,
      dataSource: record.dataSource,
    })),
    summary,
    accountingLineItems: dataMode === 'live' ? accountingLineItems.map((record) => ({
      id: record.id,
      supplierId: record.supplierId,
      companyCode: record.companyCode,
      accountingDocument: record.accountingDocument,
      accountingDocumentItem: record.accountingDocumentItem,
      accountingDocumentType: record.accountingDocumentType,
      invoiceReference: record.invoiceReference,
      documentDate: record.documentDate,
      postingDate: record.postingDate,
      dueDate: record.dueDate,
      balanceAmount: record.balanceAmount,
      balanceCurrency: record.balanceCurrency,
      clearingStatus: record.clearingStatus,
      clearingDate: record.clearingDate,
      clearingDocument: record.clearingDocument,
      isCleared: record.isCleared,
      hasClearingDocument: record.hasClearingDocument,
      isClearingReversed: record.isClearingReversed,
      openItemStatus: record.openItemStatus,
      verifiedOpenAmount: record.verifiedOpenAmount,
      dataSource: record.dataSource,
    })) : [],
  }

  let response
  try {
    response = await client.post(
      ollamaChatUrl(),
      {
        model: config.ai.model,
        stream: false,
        format: PAYMENT_ANSWER_SCHEMA,
        messages: [
          { role: 'system', content: PAYMENT_SYSTEM_PROMPT },
          {
            role: 'user',
            content: JSON.stringify({ question: prompt.trim(), paymentData: context }),
          },
        ],
        options: { temperature: 0, num_predict: 300 },
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 60000,
        maxRedirects: 0,
      },
    )
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (!error.response) {
        throw new IntegrationError('Could not connect to local Ollama.', 503)
      }
      if (error.response.status === 404) {
        throw new IntegrationError('Ollama or the configured model was not found.', 503)
      }
      throw new IntegrationError(`Local Ollama request failed (HTTP ${error.response.status}).`, 502)
    }
    throw new IntegrationError('Payment assistant request failed.', 502)
  }

  const modelAnswer = parsePaymentAnswer(getCompletedAssistantContent(response.data))
  const answer = dataMode === 'live' && summary.status === 'unavailable'
    ? `${liveMatchTotal === null ? records.length : liveMatchTotal} matching live SAP supplier invoice${liveMatchTotal === 1 ? '' : 's'} were found${liveMatchTotal !== null && liveMatchTotal > records.length ? `; the assistant received the first ${records.length} records for this explanation` : ''}. Supplier names, a verified payment status, clearing information, and confirmed due dates are unavailable, so outstanding, overdue, upcoming, and completed-payment amounts remain unavailable.`
    : modelAnswer
  return {
    dataMode,
    answer,
    answerIsAuthoritative: false,
    summary,
    records,
    matchedRecordCount: records.length,
    limitations: summary.limitations,
  }
}

export {
  getCompletedAssistantContent,
  parseAssistantContent,
  parsePaymentAnswer,
  validateAssistantResult,
}
