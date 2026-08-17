import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

const mockRefreshSession = vi.fn()
const mockFetchMe = vi.fn()
const mockFetchOpenApiSpec = vi.fn()
const mockSwaggerUIBundle = vi.fn() as ReturnType<typeof vi.fn> & { presets: { apis: Record<string, unknown> } }
const mockGlockeFetch = vi.fn()
mockSwaggerUIBundle.presets = { apis: {} }

vi.mock('../lib/api', () => ({
  refreshSession: (...args: unknown[]) => mockRefreshSession(...args),
  fetchMe: (...args: unknown[]) => mockFetchMe(...args),
  fetchOpenApiSpec: (...args: unknown[]) => mockFetchOpenApiSpec(...args),
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
    }
  },
}))

vi.mock('swagger-ui-dist', () => ({
  SwaggerUIBundle: mockSwaggerUIBundle,
}))

async function setLocation(search: string) {
  vi.resetModules()
  const original = window.location
  // @ts-expect-error -- jsdom allows reassigning location for test purposes
  delete window.location
  // @ts-expect-error -- minimal stub covering what the module under test reads
  window.location = { ...original, search, href: '', pathname: '/docs' }
  const mod = await import('../features/docs/DocsPage')
  return { DocsPage: mod.DocsPage }
}

const ADMIN_USER = { id: 'admin1', email: 'admin@example.com', name: 'Admin User', role: 'admin' }
const PLAIN_USER = { id: 'user1', email: 'plain@example.com', name: 'Plain User', role: 'user' }
const OPENAPI_SPEC = { openapi: '3.0.0', info: { title: 'Test API', version: '1.0.0' }, paths: {} }

beforeEach(() => {
  mockRefreshSession.mockReset()
  mockFetchMe.mockReset()
  mockFetchOpenApiSpec.mockReset()
  mockSwaggerUIBundle.mockReset()
  mockSwaggerUIBundle.presets = { apis: {} }
  mockGlockeFetch.mockReset()
  mockGlockeFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ count: 6 }) })
  vi.stubGlobal('fetch', mockGlockeFetch)
})

describe('DocsPage — session bootstrap', () => {
  it('renders a blank loading state with no heading while the bootstrap is pending', async () => {
    mockRefreshSession.mockReturnValue(new Promise(() => {}))
    const { DocsPage } = await setLocation('')
    render(<DocsPage />)
    expect(screen.queryAllByText(/администратор/i)).toHaveLength(0)
    expect(mockFetchOpenApiSpec).not.toHaveBeenCalled()
  })

  it('calls refreshSession then fetchMe with the resulting access token', async () => {
    mockRefreshSession.mockResolvedValue({ accessToken: 'tok-xyz' })
    mockFetchMe.mockResolvedValue(ADMIN_USER)
    mockFetchOpenApiSpec.mockResolvedValue(OPENAPI_SPEC)
    const { DocsPage } = await setLocation('')
    render(<DocsPage />)
    await waitFor(() => expect(mockFetchMe).toHaveBeenCalledWith('tok-xyz'))
  })
})

describe('DocsPage — access denied for non-admin users', () => {
  it('keeps the authenticated Glocke bell on the access-denied surface', async () => {
    vi.stubEnv('VITE_GLOCKE_URL', 'https://glocke.docs.test')
    mockRefreshSession.mockResolvedValue({ accessToken: 'denied-token' })
    mockFetchMe.mockResolvedValue(PLAIN_USER)
    const { DocsPage } = await setLocation('')
    render(<DocsPage />)

    await waitFor(() => expect(mockGlockeFetch).toHaveBeenCalledWith(
      'https://glocke.docs.test/backend/notifications/unread-count',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer denied-token' }) }),
    ))
    vi.unstubAllEnvs()
  })

  it('shows an access-denied indicator and never fetches the OpenAPI spec when the resolved user has role "user"', async () => {
    mockRefreshSession.mockResolvedValue({ accessToken: 'tok' })
    mockFetchMe.mockResolvedValue(PLAIN_USER)
    const { DocsPage } = await setLocation('')
    render(<DocsPage />)

    await waitFor(() => expect(screen.queryAllByText(/администратор/i).length).toBeGreaterThan(0))
    expect(mockFetchOpenApiSpec).not.toHaveBeenCalled()
    expect(mockSwaggerUIBundle).not.toHaveBeenCalled()
  })
})

describe('DocsPage — admin content', () => {
  it('passes the authenticated docs page token to the shared Header Glocke request', async () => {
    vi.stubEnv('VITE_GLOCKE_URL', 'https://glocke.docs.test')
    mockRefreshSession.mockResolvedValue({ accessToken: 'token-abc' })
    mockFetchMe.mockResolvedValue(ADMIN_USER)
    mockFetchOpenApiSpec.mockResolvedValue(OPENAPI_SPEC)
    const { DocsPage } = await setLocation('')
    render(<DocsPage />)

    await waitFor(() => expect(mockGlockeFetch).toHaveBeenCalledWith(
      'https://glocke.docs.test/backend/notifications/unread-count',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer token-abc' }) }),
    ))
    vi.unstubAllEnvs()
  })

  it('publishes a Header refresh to the page so docs API actions use the replacement token', async () => {
    vi.stubEnv('VITE_GLOCKE_URL', 'https://glocke.docs.test')
    mockRefreshSession
      .mockResolvedValueOnce({ accessToken: 'expired-token' })
      .mockResolvedValue({ accessToken: 'fresh-token' })
    mockFetchMe.mockResolvedValue(ADMIN_USER)
    mockFetchOpenApiSpec.mockResolvedValue(OPENAPI_SPEC)
    mockGlockeFetch
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: 'expired' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ count: 6 }) })
    const { DocsPage } = await setLocation('')
    render(<DocsPage />)

    await waitFor(() => expect(mockFetchOpenApiSpec).toHaveBeenCalledWith('fresh-token'))
    expect(mockRefreshSession).toHaveBeenCalledTimes(2)
    vi.unstubAllEnvs()
  })

  it('fetches the OpenAPI spec with the access token and mounts SwaggerUIBundle', async () => {
    mockRefreshSession.mockResolvedValue({ accessToken: 'token-abc' })
    mockFetchMe.mockResolvedValue(ADMIN_USER)
    mockFetchOpenApiSpec.mockResolvedValue(OPENAPI_SPEC)
    const { DocsPage } = await setLocation('')
    render(<DocsPage />)

    await waitFor(() => expect(mockFetchOpenApiSpec).toHaveBeenCalledWith('token-abc'))
    await waitFor(() => expect(mockSwaggerUIBundle).toHaveBeenCalled())
  })

  it('shows a visible error indication when fetchOpenApiSpec rejects', async () => {
    mockRefreshSession.mockResolvedValue({ accessToken: 'token-abc' })
    mockFetchMe.mockResolvedValue(ADMIN_USER)
    mockFetchOpenApiSpec.mockRejectedValue(new Error('network down'))
    const { DocsPage } = await setLocation('')
    render(<DocsPage />)

    await waitFor(() => {
      const text = document.body.textContent ?? ''
      expect(text).toMatch(/ошибк|не удал|failed/i)
    })
    expect(mockSwaggerUIBundle).not.toHaveBeenCalled()
  })
})
