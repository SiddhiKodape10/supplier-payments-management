import axios from 'axios'
import { config, isSapConfigured } from '../config.js'

const SELECTED_FIELDS = [
  'BusinessPartner',
  'BusinessPartnerCategory',
  'BusinessPartnerGrouping',
  'OrganizationBPName1',
  'OrganizationBPName2',
  'BusinessPartnerFullName',
].join(',')

export class IntegrationError extends Error {
  constructor(message, statusCode = 503, code = 'integration_error', sapStatus) {
    super(message)
    this.name = 'IntegrationError'
    this.statusCode = statusCode
    this.code = code
    this.sapStatus = sapStatus
  }
}

function escapeODataLiteral(value) {
  return value.replaceAll("'", "''")
}

export function validateSearchTerm(search) {
  if (typeof search !== 'string') {
    throw new IntegrationError('Search must be a string.', 400)
  }
  if (search.length > 100) {
    throw new IntegrationError('Search must be 100 characters or fewer.', 400)
  }
  if (/[\u0000-\u001f\u007f]/.test(search)) {
    throw new IntegrationError('Search cannot contain control characters.', 400)
  }
  return search.trim()
}

export function buildSearchFilter(search) {
  const term = validateSearchTerm(search)
  if (!term) return undefined
  const literal = `'${escapeODataLiteral(term)}'`
  return [
    `BusinessPartner eq ${literal}`,
    `substringof(${literal},OrganizationBPName1)`,
    `substringof(${literal},OrganizationBPName2)`,
  ].join(' or ')
}

const BP_CATEGORIES = new Map([
  ['1', '1'],
  ['PERSON', '1'],
  ['2', '2'],
  ['ORGANIZATION', '2'],
  ['3', '3'],
  ['GROUP', '3'],
])

export function buildCriteriaFilter(criteria = {}) {
  const allowedCriteria = new Set([
    'businessPartnerNumber',
    'organizationName',
    'category',
    'grouping',
  ])
  if (
    !criteria ||
    typeof criteria !== 'object' ||
    Array.isArray(criteria) ||
    Object.keys(criteria).some((key) => !allowedCriteria.has(key))
  ) {
    throw new IntegrationError('Business Partner search contains unsupported criteria.', 400)
  }
  const filters = []
  const businessPartnerNumber = criteria.businessPartnerNumber?.trim()
  const organizationName = criteria.organizationName?.trim()
  const category = criteria.category?.trim()
  const grouping = criteria.grouping?.trim()

  if (businessPartnerNumber) {
    if (!/^[A-Za-z0-9_-]{1,10}$/.test(businessPartnerNumber)) {
      throw new IntegrationError('Business Partner number must be at most 10 letters or numbers.', 400)
    }
    filters.push(`BusinessPartner eq '${escapeODataLiteral(businessPartnerNumber)}'`)
  }
  if (organizationName) {
    validateSearchTerm(organizationName)
    const literal = `'${escapeODataLiteral(organizationName)}'`
    filters.push(
      `(substringof(${literal},OrganizationBPName1) or substringof(${literal},OrganizationBPName2))`,
    )
  }
  if (category) {
    const normalizedCategory = BP_CATEGORIES.get(category.toUpperCase())
    if (!normalizedCategory) {
      throw new IntegrationError(
        'Business Partner category must be Person (1), Organization (2), or Group (3).',
        400,
      )
    }
    filters.push(`BusinessPartnerCategory eq '${normalizedCategory}'`)
  }
  if (grouping) {
    if (!/^[A-Za-z0-9]{1,4}$/.test(grouping)) {
      throw new IntegrationError('Business Partner grouping must be 1 to 4 letters or numbers.', 400)
    }
    filters.push(`BusinessPartnerGrouping eq '${escapeODataLiteral(grouping)}'`)
  }

  return filters.length ? filters.join(' and ') : undefined
}

export function mapBusinessPartner(record) {
  const organizationName = [
    record.OrganizationBPName1,
    record.OrganizationBPName2,
  ]
    .filter((part) => typeof part === 'string' && part.trim())
    .join(' ')

  return {
    businessPartner: String(record.BusinessPartner ?? ''),
    category: String(record.BusinessPartnerCategory ?? ''),
    grouping: String(record.BusinessPartnerGrouping ?? ''),
    organizationName1: String(record.OrganizationBPName1 ?? ''),
    organizationName2: String(record.OrganizationBPName2 ?? ''),
    organizationName: organizationName || String(record.BusinessPartnerFullName ?? ''),
    fullName: String(record.BusinessPartnerFullName ?? ''),
  }
}

function getRecords(payload) {
  const records = payload?.d?.results
  if (
    !Array.isArray(records) ||
    records.some((record) => typeof record?.BusinessPartner !== 'string')
  ) {
    throw new IntegrationError(
      'SAP returned an unexpected Business Partner response.',
      502,
      'invalid_data',
    )
  }
  return records.map(mapBusinessPartner)
}

function getSapUrl() {
  try {
    const baseUrl = new URL(config.sap.baseUrl)
    if (
      baseUrl.protocol !== 'https:' ||
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.search ||
      baseUrl.hash
    ) {
      throw new Error('SAP must use HTTPS.')
    }
    const configuredPath = new URL(config.sap.odataPath, baseUrl.origin)
    if (
      configuredPath.origin !== baseUrl.origin ||
      configuredPath.username ||
      configuredPath.password ||
      configuredPath.search ||
      configuredPath.hash
    ) {
      throw new Error('Unexpected SAP OData path.')
    }
    const normalizedPath = configuredPath.pathname.replace(/\/+$/, '')
    const serviceRoot = '/API_BUSINESS_PARTNER'
    const entitySuffix = `${serviceRoot}/A_BusinessPartner`
    if (normalizedPath.endsWith(serviceRoot)) {
      return new URL(`${normalizedPath}/A_BusinessPartner`, baseUrl.origin).toString()
    }
    if (!normalizedPath.endsWith(entitySuffix)) {
      throw new Error('Unexpected SAP OData path.')
    }
    return new URL(normalizedPath, baseUrl.origin).toString()
  } catch {
    throw new IntegrationError(
      'SAP_BASE_URL must be a valid HTTPS URL and SAP_ODATA_PATH must target the standard API_BUSINESS_PARTNER OData V2 service.',
    )
  }
}

export function getSapServiceRootUrl() {
  try {
    const baseUrl = new URL(config.sap.baseUrl)
    const serviceUrl = new URL(config.sap.odataPath, baseUrl.origin)
    if (
      baseUrl.protocol !== 'https:' ||
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.search ||
      baseUrl.hash ||
      serviceUrl.origin !== baseUrl.origin ||
      serviceUrl.username ||
      serviceUrl.password ||
      serviceUrl.search ||
      serviceUrl.hash
    ) {
      throw new Error('Unexpected SAP service URL.')
    }
    let servicePath = serviceUrl.pathname.replace(/\/+$/, '')
    servicePath = servicePath.replace(/\/(?:A_BusinessPartner|A_Supplier)$/i, '')
    serviceUrl.pathname = `${servicePath}/`
    return serviceUrl.toString()
  } catch {
    throw new IntegrationError(
      'SAP_BASE_URL must be a valid HTTPS URL and SAP_ODATA_PATH must identify a path on the same host.',
    )
  }
}

function handleSapRequestError(error, operation) {
  if (error instanceof IntegrationError) throw error
  if (!axios.isAxiosError(error)) {
    throw new IntegrationError('SAP connectivity could not be verified.', 502, 'unknown')
  }
  const status = error.response?.status

  if (status === 415) {
    throw new IntegrationError(
      'SAP rejected the request content encoding or media type (HTTP 415).',
      502,
      'other_error',
      status,
    )
  }

  if (status === 401) {
    throw new IntegrationError(
      'SAP authentication failed.',
      502,
      'authentication_failed',
      status,
    )
  }
  if (status === 403) {
    throw new IntegrationError(
      operation === 'create' ? 'SAP rejected the write request.' : 'SAP denied read access.',
      502,
      'authorization_failed',
      status,
    )
  }
  if (status === 404) {
    throw new IntegrationError(
      'The configured SAP service or resource was not found.',
      502,
      'unavailable',
      status,
    )
  }
  if (status === 400 && operation === 'create') {
    throw new IntegrationError(
      'SAP rejected the write request.',
      502,
      'other_error',
      status,
    )
  }
  if (!status) {
    throw new IntegrationError(
      'Could not connect to SAP. Check service availability and network access.',
      502,
      'unavailable',
    )
  }
  throw new IntegrationError(
    `SAP request failed (HTTP ${status}).`,
    502,
    status >= 500 ? 'unavailable' : 'other_error',
    status,
  )
}

async function getFromSap(params, client = axios) {
  if (!isSapConfigured()) {
    throw new IntegrationError(
      'SAP S/4HANA is not configured. Set SAP_BASE_URL, SAP_USERNAME, and SAP_PASSWORD in backend/.env.',
    )
  }

  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'Accept-Encoding': 'gzip, deflate',
    ...(config.sap.client ? { 'sap-client': config.sap.client } : {}),
  }

  try {
    const response = await client.get(getSapUrl(), {
      auth: { username: config.sap.username, password: config.sap.password },
      headers,
      maxRedirects: 0,
      params: {
        $format: 'json',
        $select: SELECTED_FIELDS,
        ...params,
      },
      timeout: 15000,
    })
    return getRecords(response.data)
  } catch (error) {
    handleSapRequestError(error, 'read')
  }
}

export async function checkSapConnection({ client = axios } = {}) {
  const entitySets = await getODataServiceEntitySets({ client })
  return {
    connected: true,
    supplierInvoiceEntityAvailable: entitySets.includes('A_SupplierInvoice'),
    entitySets,
  }
}

export async function getODataServiceEntitySets({ client = axios } = {}) {
  if (!isSapConfigured()) {
    throw new IntegrationError(
      'SAP S/4HANA is not configured. Set SAP_BASE_URL, SAP_USERNAME, and SAP_PASSWORD in backend/.env.',
    )
  }

  try {
    const response = await client.get(getSapServiceRootUrl(), {
      auth: { username: config.sap.username, password: config.sap.password },
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        ...(config.sap.client ? { 'sap-client': config.sap.client } : {}),
      },
      maxRedirects: 0,
      params: { $format: 'json' },
      timeout: 15000,
    })
    const entitySets = response.data?.d?.EntitySets
    if (!Array.isArray(entitySets) || entitySets.some((entitySet) => typeof entitySet !== 'string')) {
      throw new IntegrationError(
        'SAP returned an unexpected OData service document.',
        502,
        'invalid_data',
      )
    }
    return entitySets
  } catch (error) {
    handleSapRequestError(error, 'read')
  }
}

export async function searchBusinessPartners({
  search = '',
  criteria,
  top = 25,
  skip = 0,
} = {}) {
  const filter = criteria ? buildCriteriaFilter(criteria) : buildSearchFilter(search)
  const records = await getFromSap({
    $top: top,
    $skip: skip,
    ...(filter ? { $filter: filter } : {}),
  })
  return { records, hasMore: records.length === top }
}

export async function getBusinessPartner(businessPartner) {
  const filter =
    `BusinessPartner eq '${escapeODataLiteral(businessPartner)}'`
  const records = await getFromSap({
    $filter: filter,
    $top: 1,
    $skip: 0,
  })
  return records[0] ?? null
}

export function validateBusinessPartnerCreation({ grouping, organizationName } = {}) {
  if (typeof grouping !== 'string' || !grouping.trim()) {
    throw new IntegrationError('Business Partner Grouping is required.', 400)
  }
  const normalizedGrouping = grouping.trim()
  if (!/^[A-Za-z0-9]{1,4}$/.test(normalizedGrouping)) {
    throw new IntegrationError(
      'Business Partner Grouping must be 1 to 4 letters or numbers.',
      400,
    )
  }
  if (typeof organizationName !== 'string' || !organizationName.trim()) {
    throw new IntegrationError('Organization Name is required.', 400)
  }
  const normalizedName = organizationName.trim()
  if (normalizedName.length > 40) {
    throw new IntegrationError('Organization Name must be 40 characters or fewer.', 400)
  }
  if (/[\u0000-\u001f\u007f]/.test(normalizedName)) {
    throw new IntegrationError('Organization Name cannot contain control characters.', 400)
  }
  return {
    BusinessPartnerCategory: '2',
    BusinessPartnerGrouping: normalizedGrouping,
    OrganizationBPName1: normalizedName,
  }
}

function getCreatedBusinessPartnerNumber(data, headers) {
  const body = data?.d ?? data
  const fromBody =
    body?.BusinessPartner ??
    body?.businessPartner ??
    body?.__metadata?.uri?.match(/BusinessPartner='([^']+)'/)?.[1]
  if (typeof fromBody === 'string' && fromBody.length > 0) return fromBody

  const location = headers?.location ?? headers?.['odata-entityid']
  if (typeof location === 'string') {
    const key = location.match(/BusinessPartner='([^']+)'|A_BusinessPartner\('([^']+)'\)/)
    return key?.[1] ?? key?.[2] ?? null
  }
  return null
}

export async function executeBusinessPartnerCreate({
  payload,
  serviceRootUrl,
  entityUrl,
  auth,
  headers,
  client = axios,
  verifyPartner,
}) {
  let tokenResponse
  try {
    tokenResponse = await client.get(serviceRootUrl, {
      auth,
      headers: { ...headers, 'x-csrf-token': 'Fetch' },
      maxRedirects: 0,
      timeout: 15000,
    })
  } catch (error) {
    handleSapRequestError(error, 'create')
  }

  const csrfToken = tokenResponse?.headers?.['x-csrf-token']
  if (typeof csrfToken !== 'string' || !csrfToken.trim()) {
    throw new IntegrationError(
      'SAP did not return a CSRF token. Verify the OData service session and write configuration.',
      502,
    )
  }
  const setCookies = tokenResponse.headers['set-cookie'] ?? []
  const cookieHeader = setCookies
    .map((cookie) => cookie.split(';', 1)[0])
    .filter(Boolean)
    .join('; ')
  const postHeaders = {
    ...headers,
    'x-csrf-token': csrfToken,
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
  }

  let createResponse
  try {
    createResponse = await client.post(entityUrl, payload, {
      auth,
      headers: postHeaders,
      maxRedirects: 0,
      timeout: 30000,
    })
  } catch (error) {
    handleSapRequestError(error, 'create')
  }

  const businessPartnerNumber = getCreatedBusinessPartnerNumber(
    createResponse?.data,
    createResponse?.headers,
  )
  if (!businessPartnerNumber) {
    throw new IntegrationError(
      'SAP accepted the create request but did not return a Business Partner number. Check SAP before retrying to avoid a duplicate.',
      502,
    )
  }

  let verifiedPartner
  try {
    verifiedPartner = await verifyPartner(businessPartnerNumber)
  } catch {
    throw new IntegrationError(
      `SAP created Business Partner ${businessPartnerNumber}, but the follow-up read failed. Check SAP before retrying to avoid a duplicate.`,
      502,
    )
  }
  if (!verifiedPartner) {
    throw new IntegrationError(
      `SAP created Business Partner ${businessPartnerNumber}, but it was not found by the follow-up read. Check SAP before retrying to avoid a duplicate.`,
      502,
    )
  }
  if (
    verifiedPartner.businessPartner !== businessPartnerNumber ||
    verifiedPartner.category !== '2'
  ) {
    throw new IntegrationError(
      `SAP returned an unexpected record for Business Partner ${businessPartnerNumber}; creation could not be verified. Check SAP before retrying.`,
      502,
    )
  }
  return verifiedPartner
}

export async function createGeneralBusinessPartner({ grouping, organizationName } = {}) {
  if (!isSapConfigured()) {
    throw new IntegrationError(
      'SAP S/4HANA is not configured. Set SAP_BASE_URL, SAP_USERNAME, and SAP_PASSWORD in backend/.env.',
    )
  }
  const payload = validateBusinessPartnerCreation({ grouping, organizationName })
  const auth = { username: config.sap.username, password: config.sap.password }
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(config.sap.client ? { 'sap-client': config.sap.client } : {}),
  }

  return executeBusinessPartnerCreate({
    payload,
    serviceRootUrl: getSapServiceRootUrl(),
    entityUrl: getSapUrl(),
    auth,
    headers,
    verifyPartner: getBusinessPartner,
  })
}
