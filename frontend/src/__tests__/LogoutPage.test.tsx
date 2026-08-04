import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'

// LogoutPage exists because the session cookie is host-only to this origin
// (auth.localhost) - consumer apps (schloss, kuvert) can't clear it
// themselves via a cross-origin proxied fetch, so they do a full browser
// navigation here instead, and this page does the real same-origin logout
// call, then bounces back via return_to/DEFAULT_APP_URL.

// ALLOWED_ORIGINS (read by readReturnTo, imported by LogoutPage) is captured
// from import.meta.env at module-evaluation time, so any test that changes
// VITE_ALLOWED_RETURN_ORIGINS must vi.resetModules() + re-import the page,
// same convention as LoginPage.test.tsx / headerFooter.test.tsx.
async function setLocation(search: string) {
  vi.resetModules()
  const original = window.location
  // @ts-expect-error -- jsdom allows reassigning location for test purposes
  delete window.location
  // @ts-expect-error -- minimal stub covering what the module under test reads
  window.location = { ...original, search, href: '', pathname: '/logout' }
  const mod = await import('../features/auth/LogoutPage')
  return { LogoutPage: mod.LogoutPage }
}

const mockFetch = vi.fn()

beforeEach(() => {
  mockFetch.mockReset()
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({}),
  })
  vi.stubGlobal('fetch', mockFetch)
})

describe('LogoutPage', () => {
  it('fetches /auth/logout with method POST and credentials include on mount', async () => {
    const { LogoutPage } = await setLocation('')
    render(<LogoutPage />)

    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/auth/logout')
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' })
  })
})

describe('LogoutPage — valid return_to', () => {
  it('redirects to the return_to URL once the logout fetch resolves', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { LogoutPage } = await setLocation('?return_to=https://kuvert.test/after-logout')
    render(<LogoutPage />)

    await waitFor(() => expect(window.location.href).toBe('https://kuvert.test/after-logout'))
    vi.unstubAllEnvs()
  })
})

describe('LogoutPage — missing return_to', () => {
  it('redirects to the hardcoded default app URL when VITE_DEFAULT_APP_URL is not set', async () => {
    const { LogoutPage } = await setLocation('')
    render(<LogoutPage />)

    await waitFor(() => expect(window.location.href).toBe('http://localhost:3000'))
  })

  it('redirects to VITE_DEFAULT_APP_URL when it is stubbed', async () => {
    vi.stubEnv('VITE_DEFAULT_APP_URL', 'https://schloss.example.com')
    const { LogoutPage } = await setLocation('')
    render(<LogoutPage />)

    await waitFor(() => expect(window.location.href).toBe('https://schloss.example.com'))
    vi.unstubAllEnvs()
  })
})

describe('LogoutPage — invalid (non-allowlisted) return_to', () => {
  it('redirects to the default app URL instead of the untrusted return_to (open-redirect guard)', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { LogoutPage } = await setLocation('?return_to=https://evil.test/steal')
    render(<LogoutPage />)

    await waitFor(() => expect(window.location.href).toBe('http://localhost:3000'))
    expect(window.location.href).not.toContain('evil.test')
    vi.unstubAllEnvs()
  })
})

describe('LogoutPage — /auth/logout fetch rejects (network failure)', () => {
  it('still redirects to a valid return_to even though the logout call failed', async () => {
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { LogoutPage } = await setLocation('?return_to=https://kuvert.test/after-logout')
    render(<LogoutPage />)

    await waitFor(() => expect(window.location.href).toBe('https://kuvert.test/after-logout'))
    vi.unstubAllEnvs()
  })

  it('still redirects to the default app URL when return_to is absent and the logout call failed', async () => {
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'))
    const { LogoutPage } = await setLocation('')
    render(<LogoutPage />)

    await waitFor(() => expect(window.location.href).toBe('http://localhost:3000'))
  })

  it('still redirects to the default app URL when return_to is invalid and the logout call failed', async () => {
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { LogoutPage } = await setLocation('?return_to=https://evil.test/steal')
    render(<LogoutPage />)

    await waitFor(() => expect(window.location.href).toBe('http://localhost:3000'))
    vi.unstubAllEnvs()
  })
})

describe('LogoutPage — does not throw', () => {
  it('renders without throwing and eventually redirects when return_to is valid', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { LogoutPage } = await setLocation('?return_to=https://kuvert.test/after-logout')
    expect(() => render(<LogoutPage />)).not.toThrow()
    await waitFor(() => expect(window.location.href).not.toBe(''))
    vi.unstubAllEnvs()
  })

  it('renders without throwing and eventually redirects when the logout fetch rejects', async () => {
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'))
    const { LogoutPage } = await setLocation('')
    expect(() => render(<LogoutPage />)).not.toThrow()
    await waitFor(() => expect(window.location.href).not.toBe(''))
  })
})
