/// <reference types="vite/client" />

declare const __APP_VERSION__: string

interface Window {
  __HOF_CONFIG__?: {
    schemaVersion?: unknown
    allowedReturnOrigins?: unknown
    defaultAppUrl?: unknown
    glockeUrl?: unknown
  }
}
