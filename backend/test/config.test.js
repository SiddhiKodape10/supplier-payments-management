import assert from 'node:assert/strict'
import test from 'node:test'
import { config, validateConfig } from '../src/config.js'

function settings(overrides = {}) {
  return {
    ...config,
    ...overrides,
    sap: { ...config.sap, ...(overrides.sap ?? {}) },
    ai: { ...config.ai, ...(overrides.ai ?? {}) },
  }
}

test('configuration validation accepts the supported demo and live modes', () => {
  assert.equal(validateConfig(settings({ dataMode: 'demo', port: 3000, upcomingDays: 30 })), true)
  assert.equal(
    validateConfig({
      ...settings({ dataMode: 'live', port: 3000, upcomingDays: 30 }),
      sap: { ...config.sap, baseUrl: 'https://sap.example.test' },
    }),
    true,
  )
  assert.equal(validateConfig(settings({ dataMode: 'sap' })), true)
})

test('configuration validation rejects invalid ports, data modes, and summary periods', () => {
  assert.throws(() => validateConfig(settings({ port: 0 })), /BACKEND_PORT/)
  assert.throws(() => validateConfig(settings({ dataMode: 'other' })), /DATA_MODE/)
  assert.throws(() => validateConfig(settings({ upcomingDays: 366 })), /UPCOMING_DAYS/)
  assert.throws(() => validateConfig(settings({ upcomingDays: 0 })), /UPCOMING_DAYS/)
})

test('live SAP URL configuration must use HTTPS without embedded credentials or query strings', () => {
  for (const baseUrl of [
    'http://sap.example.test',
    'https://user:password@sap.example.test',
    'https://sap.example.test?tenant=secret',
  ]) {
    assert.throws(
      () => validateConfig(settings({ dataMode: 'live', sap: { baseUrl } })),
      /SAP_BASE_URL/,
    )
  }
})
