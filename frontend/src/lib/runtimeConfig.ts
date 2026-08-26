export interface HofRuntimeConfig {
  schemaVersion: 1
  allowedReturnOrigins: string[]
  defaultAppUrl: string
  glockeUrl: string
}

export const DEFAULT_RUNTIME_CONFIG: HofRuntimeConfig = {
  schemaVersion: 1,
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
}

function parseHttpUrl(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid runtime config: ${name} must be a non-empty URL`)
  }

  const input = value.trim()
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    throw new Error(`Invalid runtime config: ${name} must be an absolute URL`)
  }

  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`Invalid runtime config: ${name} must be an HTTP(S) URL without credentials`)
  }
  return input
}

function parseOrigin(value: unknown, name: string): string {
  const input = parseHttpUrl(value, name)
  const parsed = new URL(input)
  const authorityEnd = input.indexOf('//') + 2
  const suffix = input.slice(authorityEnd).replace(/^[^/?#]*/, '')

  if (parsed.pathname !== '/' || parsed.search || parsed.hash || (suffix !== '' && suffix !== '/')) {
    throw new Error(`Invalid runtime config: ${name} must contain only an origin`)
  }
  return parsed.origin
}

export function parseRuntimeConfig(value: unknown = window.__HOF_CONFIG__): HofRuntimeConfig {
  if (value === undefined) return { ...DEFAULT_RUNTIME_CONFIG, allowedReturnOrigins: [...DEFAULT_RUNTIME_CONFIG.allowedReturnOrigins] }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid runtime config: window.__HOF_CONFIG__ must be an object')
  }

  const supplied = value as Partial<Record<keyof HofRuntimeConfig, unknown>>
  if (supplied.schemaVersion !== undefined && supplied.schemaVersion !== 1) {
    throw new Error('Invalid runtime config: schemaVersion must be 1')
  }
  if (supplied.allowedReturnOrigins !== undefined && !Array.isArray(supplied.allowedReturnOrigins)) {
    throw new Error('Invalid runtime config: allowedReturnOrigins must be an array')
  }

  const origins = supplied.allowedReturnOrigins ?? DEFAULT_RUNTIME_CONFIG.allowedReturnOrigins
  return {
    schemaVersion: 1,
    allowedReturnOrigins: origins.map((origin, index) => parseOrigin(origin, `allowedReturnOrigins[${index}]`)),
    defaultAppUrl: parseHttpUrl(supplied.defaultAppUrl ?? DEFAULT_RUNTIME_CONFIG.defaultAppUrl, 'defaultAppUrl'),
    glockeUrl: parseOrigin(supplied.glockeUrl ?? DEFAULT_RUNTIME_CONFIG.glockeUrl, 'glockeUrl'),
  }
}

export const runtimeConfig = parseRuntimeConfig()
