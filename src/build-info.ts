import { readFileSync } from 'node:fs'

const packageVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/

function safeValue(name: string, fallback: string): string {
  const value = process.env[name]
  return value && SAFE_VALUE.test(value) ? value : fallback
}

export const buildInfo = {
  version: safeValue('SERVICE_VERSION', packageVersion),
  build: safeValue('BUILD_SHA', 'unknown'),
}
