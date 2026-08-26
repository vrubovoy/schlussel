import '@testing-library/jest-dom'
import { beforeEach } from 'vitest'

declare global {
  function stubRuntimeConfig(
    name: 'allowedReturnOrigins' | 'defaultAppUrl' | 'glockeUrl' | 'glockeEnabled',
    value: string,
  ): void
}

const defaultRuntimeConfig = {
  schemaVersion: 1 as const,
  allowedReturnOrigins: [
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
    'http://localhost:5176',
    'http://localhost:5177',
  ],
  defaultAppUrl: 'http://localhost:3000',
  glockeUrl: 'http://localhost:5177',
  services: { glocke: true },
}

function cloneDefaultRuntimeConfig(): typeof defaultRuntimeConfig {
  return {
    ...defaultRuntimeConfig,
    allowedReturnOrigins: [...defaultRuntimeConfig.allowedReturnOrigins],
    services: { ...defaultRuntimeConfig.services },
  }
}

window.__HOF_CONFIG__ = cloneDefaultRuntimeConfig()

globalThis.stubRuntimeConfig = (name, value) => {
  const config = window.__HOF_CONFIG__ as typeof defaultRuntimeConfig
  if (name === 'allowedReturnOrigins') config.allowedReturnOrigins = value.split(',')
  if (name === 'defaultAppUrl') config.defaultAppUrl = value
  if (name === 'glockeUrl') config.glockeUrl = value
  if (name === 'glockeEnabled') config.services = { glocke: value === 'true' }
}

beforeEach(() => {
  window.__HOF_CONFIG__ = cloneDefaultRuntimeConfig()
})

// ---------------------------------------------------------------------------
// localStorage stub
// ---------------------------------------------------------------------------
// Node.js 22+ ships a non-functional experimental `localStorage` getter that
// returns `undefined` when accessed without `--localstorage-file`.  This
// stomps over jsdom's own implementation.  We replace it with a proper
// in-memory Web Storage implementation so every test file gets a working
// `localStorage`.
class LocalStorageMock implements Storage {
  private store: Record<string, string> = {}

  get length() { return Object.keys(this.store).length }
  clear() { this.store = {} }
  getItem(key: string): string | null { return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null }
  setItem(key: string, value: string): void { this.store[key] = String(value) }
  removeItem(key: string): void { delete this.store[key] }
  key(index: number): string | null { return Object.keys(this.store)[index] ?? null }
}

Object.defineProperty(globalThis, 'localStorage', {
  value: new LocalStorageMock(),
  writable: true,
  configurable: true,
})

// ---------------------------------------------------------------------------
// matchMedia stub
// ---------------------------------------------------------------------------
// jsdom does not implement matchMedia; provide a minimal stub so that
// getStoredTheme() and any component using it can run without throwing.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
})
