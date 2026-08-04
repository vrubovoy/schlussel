import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('../lib/api', () => ({
  login: vi.fn(),
  register: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
    }
  },
}))

async function setLocation(pathname: string, search: string) {
  vi.resetModules()
  const original = window.location
  // @ts-expect-error -- jsdom allows reassigning location for test purposes
  delete window.location
  // @ts-expect-error -- minimal stub covering what the module under test reads
  window.location = { ...original, search, href: '', pathname }
  const loginMod = await import('../features/auth/LoginPage')
  const registerMod = await import('../features/auth/RegisterPage')
  return { LoginPage: loginMod.LoginPage, RegisterPage: registerMod.RegisterPage }
}

// A plausible 43-character base64url code_challenge fixture, valid per the
// readCodeChallenge contract (see returnTo.test.ts): present + code_challenge_method=S256.
const CODE_CHALLENGE = 'C'.repeat(43)
const PKCE_QS = `&code_challenge=${CODE_CHALLENGE}&code_challenge_method=S256`

// LoginPage performs a silent `fetch('/auth/refresh', ...)` re-auth check on
// mount before ever showing the form; stub it to fail (no session) so these
// Header/Footer assertions can await the settled fallback-to-form state.
const mockFetch = vi.fn()

beforeEach(() => {
  mockFetch.mockReset()
  mockFetch.mockResolvedValue({
    ok: false,
    status: 401,
    json: async () => ({ error: 'no session' }),
  })
  vi.stubGlobal('fetch', mockFetch)
  localStorage.clear()
})

function findLinkWithHref(href: string): HTMLAnchorElement | undefined {
  return Array.from(document.querySelectorAll('a')).find((a) => a.getAttribute('href') === href)
}

function expectHeaderLink(defaultAppUrl: string) {
  const headerLink = findLinkWithHref(defaultAppUrl)
  expect(headerLink).toBeTruthy()
  // The link leads to schloss, not to schlussel itself - the logo badge
  // shows schloss's own logo mark (not schlussel's), so the tooltip says
  // "На главную" rather than naming schlussel, which would incorrectly
  // suggest the link stays within schlussel.
  expect(headerLink).toHaveAttribute('title', 'На главную')
}

function expectFooter() {
  const footer = document.querySelector('footer')
  expect(footer).not.toBeNull()
  expect(footer).toHaveTextContent('Schlüssel — открытый код, свой хостинг')
  const githubLink = footer?.querySelector('a[href="https://github.com/zudaR107"]')
  expect(githubLink).toBeTruthy()
}

describe('Header + Footer — LoginPage (valid return_to/code_challenge)', () => {
  it('renders a Header link to VITE_DEFAULT_APP_URL when it is stubbed', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    vi.stubEnv('VITE_DEFAULT_APP_URL', 'https://schloss.example.com')
    const { LoginPage } = await setLocation('/login', `?return_to=https://kuvert.test/callback${PKCE_QS}`)
    render(<LoginPage />)

    await screen.findByPlaceholderText(/example/i)
    expectHeaderLink('https://schloss.example.com')
    vi.unstubAllEnvs()
  })

  it('renders a Header link to the default app URL fallback when VITE_DEFAULT_APP_URL is not set', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { LoginPage } = await setLocation('/login', `?return_to=https://kuvert.test/callback${PKCE_QS}`)
    render(<LoginPage />)

    // Matches the same hardcoded fallback used by the redirect logic elsewhere
    // in this suite (see LoginPage.test.tsx "no return_to" tests).
    await screen.findByPlaceholderText(/example/i)
    expectHeaderLink('http://localhost:3000')
  })

  it('renders the Footer with its text and GitHub link', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { LoginPage } = await setLocation('/login', `?return_to=https://kuvert.test/callback${PKCE_QS}`)
    render(<LoginPage />)

    await screen.findByPlaceholderText(/example/i)
    expectFooter()
    vi.unstubAllEnvs()
  })

  it('shows exactly one "Войти" heading (no duplicate brand heading in the card)', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { LoginPage } = await setLocation('/login', `?return_to=https://kuvert.test/callback${PKCE_QS}`)
    render(<LoginPage />)

    await screen.findByRole('heading', { name: 'Войти' })
    expect(screen.getAllByRole('heading', { name: 'Войти' })).toHaveLength(1)
    vi.unstubAllEnvs()
  })
})

describe('Header + Footer — RegisterPage (valid return_to/code_challenge)', () => {
  it('renders the Header link to VITE_DEFAULT_APP_URL when it is stubbed', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    vi.stubEnv('VITE_DEFAULT_APP_URL', 'https://schloss.example.com')
    const { RegisterPage } = await setLocation(
      '/register',
      `?return_to=https://kuvert.test/callback${PKCE_QS}`,
    )
    render(<RegisterPage />)

    expectHeaderLink('https://schloss.example.com')
    vi.unstubAllEnvs()
  })

  it('renders the Footer with its text and GitHub link', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { RegisterPage } = await setLocation(
      '/register',
      `?return_to=https://kuvert.test/callback${PKCE_QS}`,
    )
    render(<RegisterPage />)

    expectFooter()
    vi.unstubAllEnvs()
  })
})

describe('Header + Footer — ErrorPage (invalid return_to)', () => {
  it('renders Header and Footer around the "Небезопасный адрес возврата" message from LoginPage', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    vi.stubEnv('VITE_DEFAULT_APP_URL', 'https://schloss.example.com')
    const { LoginPage } = await setLocation('/login', `?return_to=https://evil.test/steal${PKCE_QS}`)
    render(<LoginPage />)

    expect(screen.getByText(/небезопасный адрес возврата/i)).toBeInTheDocument()
    expectHeaderLink('https://schloss.example.com')
    expectFooter()
    vi.unstubAllEnvs()
  })

  it('renders Header and Footer around the "Небезопасный адрес возврата" message from RegisterPage', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    vi.stubEnv('VITE_DEFAULT_APP_URL', 'https://schloss.example.com')
    const { RegisterPage } = await setLocation(
      '/register',
      `?return_to=https://evil.test/steal${PKCE_QS}`,
    )
    render(<RegisterPage />)

    expect(screen.getByText(/небезопасный адрес возврата/i)).toBeInTheDocument()
    expectHeaderLink('https://schloss.example.com')
    expectFooter()
    vi.unstubAllEnvs()
  })
})
