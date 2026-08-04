import '@testing-library/jest-dom'

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
