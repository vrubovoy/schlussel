import type { ComponentType } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'

const mockRefreshSession = vi.fn()

vi.mock('../lib/api', () => ({
  refreshSession: (...args: unknown[]) => mockRefreshSession(...args),
}))

interface TestHeaderProps {
  user?: { name: string } | null
  onLogout?: () => void
  accessToken?: string
  onAccessTokenChange?: (accessToken: string) => void
}

async function loadHeader() {
  const { Header } = await import('../components/Header')
  return Header as ComponentType<TestHeaderProps>
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

function requestUrl(call: unknown[]): string {
  return String(call[0])
}

function bearerHeader(call: unknown[]): string | null {
  return new Headers((call[1] as RequestInit | undefined)?.headers).get('Authorization')
}

// The Header now also fires an independent GET .../auth/profile fetch
// (useAvatarUrl) alongside the unread-count one. `unread` is the mock
// each test configures/asserts against exactly as before (call count,
// call[n] args, queued Once responses for 401-then-retry flows); `fetch`
// is what actually gets stubbed as globalThis.fetch, routing profile
// requests to a fixed harmless response so they never consume `unread`'s
// queue or its call-count.
function routedFetchMocks(): { fetch: ReturnType<typeof vi.fn>; unread: ReturnType<typeof vi.fn> } {
  const unread = vi.fn()
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/auth/profile')) return Promise.resolve(jsonResponse(200, { avatarDataUrl: null }))
    return unread(input, init)
  })
  return { fetch, unread }
}

describe('authenticated Header Glocke integration', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_GLOCKE_URL', 'https://glocke.example.test')
    mockRefreshSession.mockReset()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('uses VITE_GLOCKE_URL for the bell and unread-count path, sending the token only as a bearer header', async () => {
    const { fetch: mockFetch, unread } = routedFetchMocks()
    unread.mockResolvedValue(jsonResponse(200, { count: 7 }))
    vi.stubGlobal('fetch', mockFetch)
    const Header = await loadHeader()

    const { container } = render(
      <Header user={{ name: 'Jane Doe' }} onLogout={() => {}} accessToken="page-token" />,
    )

    await waitFor(() => expect(unread).toHaveBeenCalled())
    const call = unread.mock.calls[0] as unknown[]
    expect(requestUrl(call)).toBe('https://glocke.example.test/backend/notifications/unread-count')
    expect(requestUrl(call)).not.toContain('page-token')
    expect(bearerHeader(call)).toBe('Bearer page-token')

    const bell = container.querySelector('a[href="https://glocke.example.test/notifications"]')
    expect(bell).toBeInTheDocument()
    await waitFor(() => expect(bell).toHaveTextContent('7'))
  })

  it('aborts the stale unread request when the page-level access token changes', async () => {
    const { fetch: mockFetch, unread } = routedFetchMocks()
    unread
      .mockImplementationOnce(() => new Promise<Response>(() => {}))
      .mockResolvedValueOnce(jsonResponse(200, { count: 2 }))
    vi.stubGlobal('fetch', mockFetch)
    const Header = await loadHeader()

    const { rerender } = render(
      <Header user={{ name: 'Jane Doe' }} onLogout={() => {}} accessToken="old-token" />,
    )
    await waitFor(() => expect(unread).toHaveBeenCalledTimes(1))
    const firstSignal = (unread.mock.calls[0]?.[1] as RequestInit | undefined)?.signal

    rerender(<Header user={{ name: 'Jane Doe' }} onLogout={() => {}} accessToken="new-token" />)

    await waitFor(() => expect(unread).toHaveBeenCalledTimes(2))
    expect(firstSignal?.aborted).toBe(true)
    expect(bearerHeader(unread.mock.calls[1] as unknown[])).toBe('Bearer new-token')
  })

  it('silently refreshes once on 401, retries with the replacement token, and does not redirect', async () => {
    const { fetch: mockFetch, unread } = routedFetchMocks()
    unread
      .mockResolvedValueOnce(jsonResponse(401, { error: 'expired' }))
      .mockResolvedValueOnce(jsonResponse(200, { count: 3 }))
    vi.stubGlobal('fetch', mockFetch)
    mockRefreshSession.mockResolvedValue({ accessToken: 'refreshed-token' })
    const Header = await loadHeader()
    const hrefBefore = window.location.href
    const onAccessTokenChange = vi.fn()

    const { container } = render(
      <Header
        user={{ name: 'Jane Doe' }}
        onLogout={() => {}}
        accessToken="expired-token"
        onAccessTokenChange={onAccessTokenChange}
      />,
    )

    await waitFor(() => expect(unread).toHaveBeenCalledTimes(2))
    expect(mockRefreshSession).toHaveBeenCalledTimes(1)
    expect(mockRefreshSession).toHaveBeenCalledWith()
    expect(onAccessTokenChange).toHaveBeenCalledOnce()
    expect(onAccessTokenChange).toHaveBeenCalledWith('refreshed-token')
    expect(bearerHeader(unread.mock.calls[0] as unknown[])).toBe('Bearer expired-token')
    expect(bearerHeader(unread.mock.calls[1] as unknown[])).toBe('Bearer refreshed-token')
    expect(window.location.href).toBe(hrefBefore)
    expect(container.querySelector('a[href="https://glocke.example.test/notifications"]')).toHaveTextContent('3')
  })

  it('does not publish or retry a late refresh after the page supplies a newer token', async () => {
    let resolveRefresh!: (value: { accessToken: string }) => void
    mockRefreshSession.mockReturnValue(new Promise((resolve) => { resolveRefresh = resolve }))
    const { fetch: mockFetch, unread } = routedFetchMocks()
    unread
      .mockResolvedValueOnce(jsonResponse(401, { error: 'expired' }))
      .mockResolvedValueOnce(jsonResponse(200, { count: 2 }))
    vi.stubGlobal('fetch', mockFetch)
    const Header = await loadHeader()
    const onAccessTokenChange = vi.fn()

    const { rerender } = render(
      <Header
        user={{ name: 'Jane Doe' }}
        accessToken="expired-token"
        onAccessTokenChange={onAccessTokenChange}
      />,
    )
    await waitFor(() => expect(mockRefreshSession).toHaveBeenCalledOnce())

    rerender(
      <Header
        user={{ name: 'Jane Doe' }}
        accessToken="newer-page-token"
        onAccessTokenChange={onAccessTokenChange}
      />,
    )
    await waitFor(() => expect(unread).toHaveBeenCalledTimes(2))
    resolveRefresh({ accessToken: 'late-refreshed-token' })
    await Promise.resolve()

    expect(onAccessTokenChange).not.toHaveBeenCalled()
    expect(unread).toHaveBeenCalledTimes(2)
    expect(bearerHeader(unread.mock.calls[1] as unknown[])).toBe('Bearer newer-page-token')
  })

  it('omits the bell for an invalid Glocke origin without throwing, fetching, or rendering the raw link', async () => {
    vi.stubEnv('VITE_GLOCKE_URL', 'http://glocke.example.test/path')
    const { fetch: mockFetch, unread } = routedFetchMocks()
    vi.stubGlobal('fetch', mockFetch)
    const Header = await loadHeader()

    const { container } = render(
      <Header user={{ name: 'Jane Doe' }} accessToken="page-token" />,
    )

    await Promise.resolve()
    // An invalid Glocke origin only suppresses the unread-count fetch and
    // the bell itself - the avatar fetch (useAvatarUrl) targets
    // Schlüssel's own origin independently and is unaffected.
    expect(unread).not.toHaveBeenCalled()
    expect(container.querySelector('a[aria-label^="Уведомления:"]')).not.toBeInTheDocument()
    expect(container.querySelector('a[href="http://glocke.example.test/path/notifications"]')).not.toBeInTheDocument()
  })

  it('renders no bell and never fetches Glocke when the Header has no authenticated token', async () => {
    const mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
    const Header = await loadHeader()

    const { container } = render(<Header />)

    await Promise.resolve()
    expect(mockFetch).not.toHaveBeenCalled()
    expect(container.querySelector('a[href*="glocke"]')).not.toBeInTheDocument()
  })
})
