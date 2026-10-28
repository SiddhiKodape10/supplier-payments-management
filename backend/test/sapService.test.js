import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildSearchFilter,
  buildCriteriaFilter,
  executeBusinessPartnerCreate,
  validateBusinessPartnerCreation,
  mapBusinessPartner,
  validateSearchTerm,
} from '../src/services/sapService.js'

test('search filter searches the Business Partner number and organization name fields', () => {
  assert.equal(
    buildSearchFilter('Acme'),
    "BusinessPartner eq 'Acme' or substringof('Acme',OrganizationBPName1) or substringof('Acme',OrganizationBPName2)",
  )
})

test('search filter escapes OData string literal apostrophes', () => {
  assert.equal(
    buildSearchFilter("O'Brien"),
    "BusinessPartner eq 'O''Brien' or substringof('O''Brien',OrganizationBPName1) or substringof('O''Brien',OrganizationBPName2)",
  )
})

test('criteria filters escape OData literals and cannot inject arbitrary filters', () => {
  assert.equal(
    buildCriteriaFilter({ organizationName: "O'Brien" }),
    "(substringof('O''Brien',OrganizationBPName1) or substringof('O''Brien',OrganizationBPName2))",
  )
  assert.throws(() => buildCriteriaFilter({ arbitraryFilter: 'BusinessPartner eq 1' }), {
    statusCode: 400,
  })
})

test('search validation rejects overly long and control-character input', () => {
  assert.throws(() => validateSearchTerm('x'.repeat(101)), { statusCode: 400 })
  assert.throws(() => validateSearchTerm('name\nvalue'), { statusCode: 400 })
})

test('Business Partner mapping uses only direct A_BusinessPartner fields', () => {
  assert.deepEqual(
    mapBusinessPartner({
      BusinessPartner: '0000123456',
      BusinessPartnerCategory: '2',
      BusinessPartnerGrouping: 'Z001',
      OrganizationBPName1: 'Example',
      OrganizationBPName2: 'Company',
      BusinessPartnerFullName: 'Example Company',
    }),
    {
      businessPartner: '0000123456',
      category: '2',
      grouping: 'Z001',
      organizationName1: 'Example',
      organizationName2: 'Company',
      organizationName: 'Example Company',
      fullName: 'Example Company',
    },
  )
})

test('create validation fixes category to Organization and only allows grouping and organization name', () => {
  assert.deepEqual(
    validateBusinessPartnerCreation({
      grouping: '0001',
      organizationName: 'Example Organization',
    }),
    {
      BusinessPartnerCategory: '2',
      BusinessPartnerGrouping: '0001',
      OrganizationBPName1: 'Example Organization',
    },
  )
})

test('create validation rejects missing or invalid mandatory fields', () => {
  assert.throws(
    () => validateBusinessPartnerCreation({ grouping: '', organizationName: 'Example' }),
    { statusCode: 400 },
  )
  assert.throws(
    () => validateBusinessPartnerCreation({ grouping: 'TOO-LONG', organizationName: 'Example' }),
    { statusCode: 400 },
  )
  assert.throws(
    () => validateBusinessPartnerCreation({ grouping: '0001', organizationName: '  ' }),
    { statusCode: 400 },
  )
  assert.throws(
    () =>
      validateBusinessPartnerCreation({
        grouping: '0001',
        organizationName: 'x'.repeat(41),
      }),
    { statusCode: 400 },
  )
})

test('create flow fetches a CSRF token, forwards session cookies, then verifies using mocked HTTP', async () => {
  const calls = []
  const mockClient = {
    async get(url, options) {
      calls.push({ method: 'GET', url, options })
      return {
        headers: {
          'x-csrf-token': 'mock-token',
          'set-cookie': ['SAP_SESSIONID=mock-session; Path=/; Secure', 'sap-usercontext=mock-client; Path=/'],
        },
      }
    },
    async post(url, payload, options) {
      calls.push({ method: 'POST', url, payload, options })
      return { data: { d: { BusinessPartner: '0000001234' } }, headers: {} }
    },
  }
  const verifiedRecords = []
  const result = await executeBusinessPartnerCreate({
    payload: {
      BusinessPartnerCategory: '2',
      BusinessPartnerGrouping: 'Z001',
      OrganizationBPName1: 'Mocked organization',
    },
    serviceRootUrl: 'https://sap.example.test/sap/opu/odata/sap/API_BUSINESS_PARTNER/',
    entityUrl:
      'https://sap.example.test/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner',
    auth: { username: 'mock-user', password: 'mock-password' },
    headers: { Accept: 'application/json' },
    client: mockClient,
    async verifyPartner(number) {
      verifiedRecords.push(number)
      return {
        businessPartner: number,
        category: '2',
        organizationName: 'Mocked organization',
      }
    },
  })

  assert.deepEqual(calls.map((call) => call.method), ['GET', 'POST'])
  assert.equal(calls[0].options.headers['x-csrf-token'], 'Fetch')
  assert.equal(calls[1].options.headers['x-csrf-token'], 'mock-token')
  assert.equal(
    calls[1].options.headers.Cookie,
    'SAP_SESSIONID=mock-session; sap-usercontext=mock-client',
  )
  assert.deepEqual(Object.keys(calls[1].payload).sort(), [
    'BusinessPartnerCategory',
    'BusinessPartnerGrouping',
    'OrganizationBPName1',
  ])
  assert.deepEqual(verifiedRecords, ['0000001234'])
  assert.equal(result.businessPartner, '0000001234')
})

test('create flow does not post if SAP does not provide a CSRF token', async () => {
  let postCalled = false
  await assert.rejects(
    executeBusinessPartnerCreate({
      payload: {
        BusinessPartnerCategory: '2',
        BusinessPartnerGrouping: 'Z001',
        OrganizationBPName1: 'Mocked organization',
      },
      serviceRootUrl: 'https://sap.example.test/service/',
      entityUrl: 'https://sap.example.test/service/A_BusinessPartner',
      auth: { username: 'mock-user', password: 'mock-password' },
      headers: {},
      client: {
        async get() {
          return { headers: {} }
        },
        async post() {
          postCalled = true
          return {}
        },
      },
      async verifyPartner() {
        return null
      },
    }),
    { statusCode: 502 },
  )
  assert.equal(postCalled, false)
})
