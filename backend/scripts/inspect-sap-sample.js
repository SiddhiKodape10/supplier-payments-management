#!/usr/bin/env node
/**
 * Read-only SAP diagnostic.
 *
 * Fetches $metadata for the supplier-invoice and vendor-line-item OData
 * services, then samples $top=50 rows from each configured entity set and
 * reports, per property, how many rows have a non-empty value plus three
 * sample values.
 *
 * This script performs GET requests only. It never prints credentials or
 * request headers.
 *
 * Usage: node scripts/inspect-sap-sample.js [--top=50]
 */
import axios from 'axios'
import { config, isSapConfigured } from '../src/config.js'

const TOP = (() => {
  const arg = process.argv.find((value) => value.startsWith('--top='))
  const parsed = arg ? Number.parseInt(arg.slice('--top='.length), 10) : 50
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 200 ? parsed : 50
})()

const SERVICES = [
  {
    label: 'supplier-invoice',
    path: config.sap.odataPath,
    entitySet: 'A_SupplierInvoice',
  },
  {
    label: 'vendor-line-items',
    path: config.sap.lineItemsOdataPath,
    entitySet: 'Items',
  },
]

const SENSITIVE = /password|secret|token|credential|authorization/i

function baseUrl() {
  return new URL(config.sap.baseUrl).origin
}

function serviceUrl(servicePath) {
  return new URL(`${servicePath.replace(/\/+$/, '')}/`, baseUrl()).toString()
}

function entityUrl(servicePath, entitySet) {
  return new URL(`${servicePath.replace(/\/+$/, '')}/${entitySet}`, baseUrl()).toString()
}

function headers() {
  return {
    Accept: 'application/json',
    'Accept-Encoding': 'gzip, deflate',
    ...(config.sap.client ? { 'sap-client': config.sap.client } : {}),
  }
}

function auth() {
  return { username: config.sap.username, password: config.sap.password }
}

async function get(url, params, accept = 'application/json') {
  const response = await axios.get(url, {
    auth: auth(),
    headers: { ...headers(), Accept: accept },
    maxRedirects: 0,
    timeout: 60000,
    params,
  })
  return response.data
}

/** Minimal metadata parser: entity sets, entity types and their properties. */
function parseMetadata(xml) {
  const entitySets = new Map()
  for (const match of xml.matchAll(/<EntitySet Name="([^"]+)" EntityType="([^"]+)"/g)) {
    entitySets.set(match[1], match[2].split('.').pop())
  }
  const entityTypes = new Map()
  for (const match of xml.matchAll(/<EntityType Name="([^"]+)"[^>]*>([\s\S]*?)<\/EntityType>/g)) {
    const properties = []
    for (const property of match[2].matchAll(
      /<Property Name="([^"]+)" Type="([^"]+)"(?: Nullable="([^"]+)")?/g,
    )) {
      properties.push({
        name: property[1],
        type: property[2],
        nullable: property[3] !== 'false',
      })
    }
    entityTypes.set(match[1], properties)
  }
  return { entitySets, entityTypes }
}

function describeValue(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function sampleValues(records, property) {
  const values = []
  for (const record of records) {
    const value = describeValue(record?.[property])
    if (!value.trim()) continue
    const truncated = value.length > 60 ? `${value.slice(0, 57)}…` : value
    if (!values.includes(truncated)) values.push(truncated)
    if (values.length === 3) break
  }
  return values
}

function countNonEmpty(records, property) {
  return records.filter((record) => describeValue(record?.[property]).trim() !== '').length
}

function reportProperties(label, properties, records) {
  console.log(`\n--- ${label}: ${records.length} sampled rows ---`)
  console.log(
    ['property', 'type', 'non-empty', 'samples'].join('\t'),
  )
  for (const property of properties) {
    if (SENSITIVE.test(property.name)) continue
    const samples = sampleValues(records, property.name)
    console.log(
      [
        property.name,
        property.type.replace('Edm.', ''),
        `${countNonEmpty(records, property.name)}/${records.length}`,
        samples.join(' | '),
      ].join('\t'),
    )
  }
}

function distribution(records, property) {
  const counts = new Map()
  for (const record of records) {
    const value = describeValue(record?.[property]).trim() || '(empty)'
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

async function inspect(service) {
  console.log(`\n============================================================`)
  console.log(`Service: ${service.label}`)
  console.log(`Path:    ${service.path}`)
  console.log(`Entity:  ${service.entitySet}`)

  const metadataXml = await get(
    new URL(`${service.path.replace(/\/+$/, '')}/$metadata`, baseUrl()).toString(),
    undefined,
    'application/xml',
  )
  const metadataText = typeof metadataXml === 'string' ? metadataXml : JSON.stringify(metadataXml)
  const { entitySets, entityTypes } = parseMetadata(metadataText)

  console.log(`\nEntity sets (${entitySets.size}):`)
  console.log([...entitySets.keys()].sort().join(', '))

  const typeName = entitySets.get(service.entitySet)
  const properties = typeName ? entityTypes.get(typeName) : undefined
  if (!properties) {
    console.log(`\n!! Entity type for ${service.entitySet} was not found in $metadata.`)
    return
  }
  console.log(`\nEntity type: ${typeName} (${properties.length} properties)`)

  const payload = await get(entityUrl(service.path, service.entitySet), {
    $format: 'json',
    $top: TOP,
    $inlinecount: 'allpages',
  })
  const records = payload?.d?.results
  if (!Array.isArray(records)) {
    console.log('\n!! The sample response did not contain d.results.')
    return
  }
  const reportedTotal = payload?.d?.__count
  console.log(`\nReported __count for ${service.entitySet}: ${reportedTotal ?? '(not returned)'}`)

  reportProperties(service.entitySet, properties, records)

  console.log(`\n${service.entitySet} AccountingDocumentType distribution (${records.length} rows):`)
  for (const [value, count] of distribution(records, 'AccountingDocumentType')) {
    console.log(`  ${value}: ${count}`)
  }
  console.log(`\n${service.entitySet} DebitCreditCode distribution:`)
  for (const [value, count] of distribution(records, 'DebitCreditCode')) {
    console.log(`  ${value}: ${count}`)
  }
  console.log(`\n${service.entitySet} ClearingStatus distribution:`)
  for (const [value, count] of distribution(records, 'ClearingStatus')) {
    console.log(`  ${value}: ${count}`)
  }
  console.log(`\n${service.entitySet} IsCleared distribution:`)
  for (const [value, count] of distribution(records, 'IsCleared')) {
    console.log(`  ${value}: ${count}`)
  }
  console.log(`\n${service.entitySet} HasClearingAccountingDocument distribution:`)
  for (const [value, count] of distribution(records, 'HasClearingAccountingDocument')) {
    console.log(`  ${value}: ${count}`)
  }
}

async function main() {
  if (!isSapConfigured()) {
    console.error('SAP is not configured. Set SAP_BASE_URL, SAP_USERNAME, and SAP_PASSWORD in backend/.env.')
    process.exitCode = 1
    return
  }
  console.log('Read-only SAP sample inspection. Credentials are not printed.')
  console.log(`Base host: ${new URL(config.sap.baseUrl).host}`)
  console.log(`SAP client: ${config.sap.client || '(none)'}`)
  for (const service of SERVICES) {
    try {
      await inspect(service)
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined
      console.error(
        `\n!! ${service.label} failed${status ? ` (HTTP ${status})` : ''}: ${error.message}`,
      )
    }
  }
}

main()
