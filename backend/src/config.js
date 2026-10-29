import dotenv from 'dotenv'
import { fileURLToPath } from 'node:url'

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) })

export const config = {
  host: '127.0.0.1',
  port: Number(process.env.BACKEND_PORT || '3000'),
  dataMode: process.env.DATA_MODE?.trim().toLowerCase() || 'live',
  upcomingDays: Number(process.env.UPCOMING_DAYS || '30'),
  sap: {
    baseUrl: process.env.SAP_BASE_URL?.trim() || '',
    client: process.env.SAP_CLIENT?.trim() || '',
    username: process.env.SAP_USERNAME || '',
    password: process.env.SAP_PASSWORD || '',
    odataPath:
      process.env.SAP_ODATA_PATH?.trim() ||
      '/API_SUPPLIERINVOICE_PROCESS_SRV',
    lineItemsOdataPath:
      process.env.SAP_LINE_ITEMS_ODATA_PATH?.trim() ||
      '/FAP_VENDOR_LINE_ITEMS_SRV',
  },
  ai: {
    url: process.env.OLLAMA_URL?.trim() || 'http://127.0.0.1:11434',
    model: process.env.OLLAMA_MODEL?.trim() || 'llama3.2',
  },
}

export function validateConfig(settings = config) {
  if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535) {
    throw new Error('BACKEND_PORT must be a valid TCP port between 1 and 65535.')
  }
  if (!['demo', 'sap', 'live'].includes(settings.dataMode)) {
    throw new Error('DATA_MODE must be "demo" or "live" ("sap" is accepted as a legacy alias).')
  }
  if (
    !Number.isInteger(settings.upcomingDays) ||
    settings.upcomingDays < 1 ||
    settings.upcomingDays > 365
  ) {
    throw new Error('UPCOMING_DAYS must be an integer between 1 and 365.')
  }
  if (settings.sap.client && !/^[A-Za-z0-9]{1,3}$/.test(settings.sap.client)) {
    throw new Error('SAP_CLIENT must be 1 to 3 letters or numbers.')
  }
  if (
    settings.dataMode !== 'demo' &&
    settings.sap.baseUrl &&
    !isValidSapBaseUrl(settings.sap.baseUrl)
  ) {
    throw new Error('SAP_BASE_URL must be a valid HTTPS URL without credentials, query, or fragment.')
  }
  return true
}

function isValidSapBaseUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
  } catch {
    return false
  }
}

validateConfig()

export function isSapConfigured() {
  return Boolean(config.sap.baseUrl && config.sap.username && config.sap.password)
}

export function isAiConfigured() {
  if (!config.ai.model) return false
  try {
    const url = new URL(config.ai.url)
    return (
      url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname) &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}
