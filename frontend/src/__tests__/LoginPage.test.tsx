import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const mockLogin = vi.fn()
vi.mock('../lib/api', () => ({
  login: (...args: unknown[]) => mockLogin(...args),
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
    }
  },
}))

async function setLocation(search: string) {
  vi.resetModules()
  const original = window.location
  // @ts-expect-error -- jsdom allows reassigning location for test purposes
  delete window.location
  // @ts-expect-error -- minimal stub covering what the module under test reads
  window.location = { ...original, search, href: '', pathname: '/login' }
  const mod = await import('../features/auth/LoginPage')
  return { LoginPage: mod.LoginPage }
}

// A plausible 43-character base64url code_challenge fixture, valid per the
// readCodeChallenge contract (see returnTo.test.ts): present + code_challenge_method=S256.
const CODE_CHALLENGE = 'A'.repeat(43)
const PKCE_QS = `&code_challenge=${CODE_CHALLENGE}&code_challenge_method=S256`

// LoginPage now makes a raw `fetch('/auth/refresh', ...)` silent-reauth
// check on mount, separate from the `login`/`register` calls mocked above
// (those go through ../lib/api, not raw fetch). We stub the global fetch
// so every test controls that check explicitly.
const mockFetch = vi.fn()

function mockRefreshFails(status = 401) {
  mockFetch.mockResolvedValue({
    ok: false,
    status,
    json: async () => ({ error: 'no session' }),
  })
}

function mockRefreshSucceeds(code: string) {
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ code }),
  })
}

function mockRefreshRejects(error: unknown = new TypeError('Failed to fetch')) {
  mockFetch.mockRejectedValue(error)
}

beforeEach(() => {
  mockLogin.mockReset()
  mockFetch.mockReset()
  // Default: no active session anywhere else, so the form falls back to
  // rendering normally unless a test opts into a different outcome.
  mockRefreshFails()
  vi.stubGlobal('fetch', mockFetch)
  localStorage.clear()
})

describe('LoginPage — no return_to', () => {
  it('redirects immediately to the hardcoded default app URL when VITE_DEFAULT_APP_URL is not set', async () => {
    const { LoginPage } = await setLocation('')
    render(<LoginPage />)
    expect(window.location.href).toBe('http://localhost:3000')
  })

  it('redirects immediately to VITE_DEFAULT_APP_URL when it is stubbed', async () => {
    vi.stubEnv('VITE_DEFAULT_APP_URL', 'https://schloss.example.com')
    const { LoginPage } = await setLocation('')
    render(<LoginPage />)
    expect(window.location.href).toBe('https://schloss.example.com')
    vi.unstubAllEnvs()
  })

  it('does not render the login form', async () => {
    const { LoginPage } = await setLocation('')
    render(<LoginPage />)
    expect(screen.queryByPlaceholderText(/example/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Войти' })).not.toBeInTheDocument()
  })

  it('never calls login', async () => {
    const { LoginPage } = await setLocation('')
    render(<LoginPage />)
    expect(mockLogin).not.toHaveBeenCalled()
  })
})

describe('LoginPage — valid return_to', () => {
  it('redirects with the code in the URL query string on successful login (no existing query on return_to)', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { LoginPage } = await setLocation(`?return_to=https://kuvert.test/callback${PKCE_QS}`)
    mockLogin.mockResolvedValue({ code: 'the-code' })
    const user = userEvent.setup()
    render(<LoginPage />)

    await user.type(await screen.findByPlaceholderText(/example/i), 'a@a.com')
    await user.type(document.querySelector('input[type="password"]') as Element, 'password1')
    await user.click(screen.getByRole('button', { name: 'Войти' }))

    await waitFor(() => expect(window.location.href).toBe('https://kuvert.test/callback?code=the-code'))
    // No accessToken/fragment-based redirect must remain.
    expect(window.location.href).not.toContain('#')
    vi.unstubAllEnvs()
  })

  it('redirects with &code=<value> appended when the return_to URL already has a query string', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { LoginPage } = await setLocation(
      `?return_to=${encodeURIComponent('https://kuvert.test/callback?next=%2Fbudget')}${PKCE_QS}`,
    )
    mockLogin.mockResolvedValue({ code: 'the-code' })
    const user = userEvent.setup()
    render(<LoginPage />)

    await user.type(await screen.findByPlaceholderText(/example/i), 'a@a.com')
    await user.type(document.querySelector('input[type="password"]') as Element, 'password1')
    await user.click(screen.getByRole('button', { name: 'Войти' }))

    await waitFor(() =>
      expect(window.location.href).toBe('https://kuvert.test/callback?next=%2Fbudget&code=the-code'),
    )
    vi.unstubAllEnvs()
  })

  it('calls login with the email, password, and the code_challenge extracted from the URL', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { LoginPage } = await setLocation(`?return_to=https://kuvert.test/callback${PKCE_QS}`)
    mockLogin.mockResolvedValue({ code: 'the-code' })
    const user = userEvent.setup()
    render(<LoginPage />)

    await user.type(await screen.findByPlaceholderText(/example/i), 'a@a.com')
    await user.type(document.querySelector('input[type="password"]') as Element, 'password1')
    await user.click(screen.getByRole('button', { name: 'Войти' }))

    await waitFor(() => expect(mockLogin).toHaveBeenCalled())
    const args = mockLogin.mock.calls[0]
    expect(args).toContain('a@a.com')
    expect(args).toContain('password1')
    expect(args).toContain(CODE_CHALLENGE)
    vi.unstubAllEnvs()
  })

  it('shows an error message when login rejects, and marks BOTH fields invalid without saying which is wrong', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { LoginPage } = await setLocation(`?return_to=https://kuvert.test/callback${PKCE_QS}`)
    const ApiError = (await import('../lib/api')).ApiError
    mockLogin.mockRejectedValue(new ApiError(401, 'Invalid credentials'))
    const user = userEvent.setup()
    render(<LoginPage />)

    const emailInput = await screen.findByPlaceholderText(/example/i)
    const passwordInput = document.querySelector('input[type="password"]') as HTMLInputElement
    await user.type(emailInput, 'bad@user.com')
    await user.type(passwordInput, 'wrong')
    await user.click(screen.getByRole('button', { name: 'Войти' }))

    await screen.findByText('Неверный email или пароль')
    // Exactly one occurrence of the message - not duplicated under each
    // field (this is the point of Field's `invalid` prop).
    expect(screen.getAllByText('Неверный email или пароль')).toHaveLength(1)
    expect(emailInput).toHaveAttribute('aria-invalid', 'true')
    expect(passwordInput).toHaveAttribute('aria-invalid', 'true')
    vi.unstubAllEnvs()
  })

  it('clears the invalid-credentials highlight as soon as either field is edited again', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { LoginPage } = await setLocation(`?return_to=https://kuvert.test/callback${PKCE_QS}`)
    const ApiError = (await import('../lib/api')).ApiError
    mockLogin.mockRejectedValue(new ApiError(401, 'Invalid credentials'))
    const user = userEvent.setup()
    render(<LoginPage />)

    const emailInput = await screen.findByPlaceholderText(/example/i)
    const passwordInput = document.querySelector('input[type="password"]') as HTMLInputElement
    await user.type(emailInput, 'bad@user.com')
    await user.type(passwordInput, 'wrong')
    await user.click(screen.getByRole('button', { name: 'Войти' }))
    await screen.findByText('Неверный email или пароль')

    await user.type(passwordInput, '2')
    expect(screen.queryByText('Неверный email или пароль')).not.toBeInTheDocument()
    expect(emailInput).toHaveAttribute('aria-invalid', 'false')
    expect(passwordInput).toHaveAttribute('aria-invalid', 'false')
    vi.unstubAllEnvs()
  })

  it('rejects a malformed email client-side without ever calling login', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { LoginPage } = await setLocation(`?return_to=https://kuvert.test/callback${PKCE_QS}`)
    const user = userEvent.setup()
    render(<LoginPage />)

    await user.type(await screen.findByPlaceholderText(/example/i), 'not-an-email')
    await user.type(document.querySelector('input[type="password"]') as Element, 'password1')
    await user.click(screen.getByRole('button', { name: 'Войти' }))

    expect(await screen.findByText('Неверный формат email')).toBeInTheDocument()
    expect(mockLogin).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })

  it('rejects an empty password client-side without ever calling login', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { LoginPage } = await setLocation(`?return_to=https://kuvert.test/callback${PKCE_QS}`)
    const user = userEvent.setup()
    render(<LoginPage />)

    await user.type(await screen.findByPlaceholderText(/example/i), 'alice@test.com')
    await user.click(screen.getByRole('button', { name: 'Войти' }))

    expect(await screen.findByText('Введите пароль')).toBeInTheDocument()
    expect(mockLogin).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })
})

describe('LoginPage — silent re-authentication', () => {
  it('posts to /auth/refresh with the code_challenge and codeChallengeMethod S256 on mount', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { LoginPage } = await setLocation(`?return_to=https://kuvert.test/callback${PKCE_QS}`)
    render(<LoginPage />)

    await waitFor(() => expect(mockFetch).toHaveBeenCalled())
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/auth/refresh')
    expect(init).toMatchObject({ method: 'POST' })
    expect(JSON.parse(init.body as string)).toEqual({
      codeChallenge: CODE_CHALLENGE,
      codeChallengeMethod: 'S256',
    })
    vi.unstubAllEnvs()
  })

  it('redirects immediately with the returned code and never renders the form when /auth/refresh succeeds (no existing query on return_to)', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    mockRefreshSucceeds('silent-code')
    const { LoginPage } = await setLocation(`?return_to=https://kuvert.test/callback${PKCE_QS}`)
    render(<LoginPage />)

    await waitFor(() => expect(window.location.href).toBe('https://kuvert.test/callback?code=silent-code'))
    expect(screen.queryByPlaceholderText(/example/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Войти' })).not.toBeInTheDocument()
    expect(mockLogin).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })

  it('redirects with &code=<value> appended when /auth/refresh succeeds and return_to already has a query string', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    mockRefreshSucceeds('silent-code')
    const { LoginPage } = await setLocation(
      `?return_to=${encodeURIComponent('https://kuvert.test/callback?next=%2Fbudget')}${PKCE_QS}`,
    )
    render(<LoginPage />)

    await waitFor(() =>
      expect(window.location.href).toBe('https://kuvert.test/callback?next=%2Fbudget&code=silent-code'),
    )
    expect(screen.queryByPlaceholderText(/example/i)).not.toBeInTheDocument()
    vi.unstubAllEnvs()
  })

  it('falls back to rendering the credentials form when /auth/refresh resolves with a non-ok status (no session)', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    mockRefreshFails(401)
    const { LoginPage } = await setLocation(`?return_to=https://kuvert.test/callback${PKCE_QS}`)
    render(<LoginPage />)

    expect(await screen.findByPlaceholderText(/example/i)).toBeInTheDocument()
    expect(document.querySelector('input[type="password"]')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Войти' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /зарегистрироваться/i })).toBeInTheDocument()
    expect(window.location.href).toBe('')
    vi.unstubAllEnvs()
  })

  it('falls back to rendering the credentials form when /auth/refresh rejects with a network error', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    mockRefreshRejects(new TypeError('Failed to fetch'))
    const { LoginPage } = await setLocation(`?return_to=https://kuvert.test/callback${PKCE_QS}`)
    render(<LoginPage />)

    expect(await screen.findByPlaceholderText(/example/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Войти' })).toBeInTheDocument()
    expect(window.location.href).toBe('')
    vi.unstubAllEnvs()
  })
})

describe('LoginPage — invalid return_to', () => {
  it('shows an error page instead of the login form and never calls login', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { LoginPage } = await setLocation(`?return_to=https://evil.test/steal${PKCE_QS}`)
    render(<LoginPage />)

    expect(screen.getByText(/небезопасный адрес возврата/i)).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/example/i)).not.toBeInTheDocument()
    expect(mockLogin).not.toHaveBeenCalled()
    expect(window.location.href).toBe('')
    vi.unstubAllEnvs()
  })
})

describe('LoginPage — missing or invalid code_challenge', () => {
  it('redirects to the default app URL (same as missing return_to) when return_to is valid but code_challenge is absent', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { LoginPage } = await setLocation('?return_to=https://kuvert.test/callback')
    render(<LoginPage />)
    expect(window.location.href).toBe('http://localhost:3000')
    expect(screen.queryByPlaceholderText(/example/i)).not.toBeInTheDocument()
    expect(mockLogin).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })

  it('redirects to the default app URL when code_challenge is present but code_challenge_method is not S256', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { LoginPage } = await setLocation(
      `?return_to=https://kuvert.test/callback&code_challenge=${CODE_CHALLENGE}&code_challenge_method=plain`,
    )
    render(<LoginPage />)
    expect(window.location.href).toBe('http://localhost:3000')
    expect(screen.queryByPlaceholderText(/example/i)).not.toBeInTheDocument()
    expect(mockLogin).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })

  it('honors VITE_DEFAULT_APP_URL when redirecting due to missing code_challenge', async () => {
    vi.stubEnv('VITE_DEFAULT_APP_URL', 'https://schloss.example.com')
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { LoginPage } = await setLocation('?return_to=https://kuvert.test/callback')
    render(<LoginPage />)
    expect(window.location.href).toBe('https://schloss.example.com')
    vi.unstubAllEnvs()
  })
})

describe('LoginPage — password visibility toggle', () => {
  it('shows a toggle button initially labeled "Показать пароль"', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { LoginPage } = await setLocation(`?return_to=https://kuvert.test/callback${PKCE_QS}`)
    render(<LoginPage />)

    expect(await screen.findByRole('button', { name: 'Показать пароль' })).toBeInTheDocument()
    vi.unstubAllEnvs()
  })

  it('toggles the password input type and the button label when clicked', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { LoginPage } = await setLocation(`?return_to=https://kuvert.test/callback${PKCE_QS}`)
    const user = userEvent.setup()
    render(<LoginPage />)

    const toggleButton = await screen.findByRole('button', { name: 'Показать пароль' })
    const input = document.querySelector('#login-password') as HTMLInputElement
    expect(input).toHaveAttribute('type', 'password')

    await user.click(toggleButton)
    expect(input).toHaveAttribute('type', 'text')
    expect(screen.getByRole('button', { name: 'Скрыть пароль' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Скрыть пароль' }))
    expect(input).toHaveAttribute('type', 'password')
    expect(screen.getByRole('button', { name: 'Показать пароль' })).toBeInTheDocument()
    vi.unstubAllEnvs()
  })

  it('preserves the typed value when toggling visibility', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { LoginPage } = await setLocation(`?return_to=https://kuvert.test/callback${PKCE_QS}`)
    const user = userEvent.setup()
    render(<LoginPage />)

    await screen.findByRole('button', { name: 'Показать пароль' })
    const input = document.querySelector('#login-password') as HTMLInputElement
    await user.type(input, 'secret123')
    expect(input).toHaveValue('secret123')

    await user.click(screen.getByRole('button', { name: 'Показать пароль' }))
    expect(input).toHaveValue('secret123')

    await user.click(screen.getByRole('button', { name: 'Скрыть пароль' }))
    expect(input).toHaveValue('secret123')
    vi.unstubAllEnvs()
  })
})

describe('LoginPage — focus moves to the first invalid field', () => {
  it('focuses login-email (first field in visual order) when the form is submitted entirely empty', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { LoginPage } = await setLocation(`?return_to=https://kuvert.test/callback${PKCE_QS}`)
    const user = userEvent.setup()
    render(<LoginPage />)

    await screen.findByPlaceholderText(/example/i)
    await user.click(screen.getByRole('button', { name: 'Войти' }))

    await waitFor(() => expect(document.activeElement).toBe(document.getElementById('login-email')))
    expect(mockLogin).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })

  it('focuses login-email when login rejects with 401 (invalid credentials)', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { LoginPage } = await setLocation(`?return_to=https://kuvert.test/callback${PKCE_QS}`)
    const ApiError = (await import('../lib/api')).ApiError
    mockLogin.mockRejectedValue(new ApiError(401, 'Invalid credentials'))
    const user = userEvent.setup()
    render(<LoginPage />)

    const emailInput = await screen.findByPlaceholderText(/example/i)
    const passwordInput = document.querySelector('input[type="password"]') as HTMLInputElement
    await user.type(emailInput, 'bad@user.com')
    await user.type(passwordInput, 'wrong')
    await user.click(screen.getByRole('button', { name: 'Войти' }))

    await screen.findByText('Неверный email или пароль')
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById('login-email')))
    vi.unstubAllEnvs()
  })
})

describe('LoginPage — email field guards against the saved-credentials picker', () => {
  // login-email sits immediately before the password field, which makes
  // Chrome/Edge treat it as a "username" field and offer the saved-password
  // picker on any focus - including a programmatic one from this page's own
  // error-focusing behavior (see focusField.ts). The fix is the standard
  // readonly-until-focus technique: the input carries a static readOnly
  // attribute that is imperatively removed on focus and reinstated on blur,
  // so the browser sees readOnly at the exact instant any focus event fires
  // (and skips the picker) while the field stays fully typable a moment
  // later within that same synchronous event.
  // (Mirrors the equivalent register-email tests in RegisterPage.test.tsx.)

  it('is not readOnly once it receives focus', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { LoginPage } = await setLocation(`?return_to=https://kuvert.test/callback${PKCE_QS}`)
    render(<LoginPage />)

    await screen.findByPlaceholderText(/example/i)
    const emailInput = document.getElementById('login-email') as HTMLInputElement
    fireEvent.focus(emailInput)
    expect(emailInput.readOnly).toBe(false)
    expect(emailInput).not.toHaveAttribute('readonly')
    vi.unstubAllEnvs()
  })

  it('still accepts typed input once focused - no functional regression in normal typing', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { LoginPage } = await setLocation(`?return_to=https://kuvert.test/callback${PKCE_QS}`)
    render(<LoginPage />)

    await screen.findByPlaceholderText(/example/i)
    const emailInput = document.getElementById('login-email') as HTMLInputElement
    fireEvent.focus(emailInput)
    fireEvent.change(emailInput, { target: { value: 'alice@test.com' } })
    expect(emailInput).toHaveValue('alice@test.com')
    vi.unstubAllEnvs()
  })

  it('becomes readOnly again once blurred, ready to guard the next focus', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { LoginPage } = await setLocation(`?return_to=https://kuvert.test/callback${PKCE_QS}`)
    render(<LoginPage />)

    await screen.findByPlaceholderText(/example/i)
    const emailInput = document.getElementById('login-email') as HTMLInputElement
    fireEvent.focus(emailInput)
    expect(emailInput.readOnly).toBe(false)
    fireEvent.blur(emailInput)
    expect(emailInput.readOnly).toBe(true)
    vi.unstubAllEnvs()
  })

  it('repeats the readOnly-on-blur / editable-on-focus pattern across multiple focus/blur cycles (not a one-shot guard)', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { LoginPage } = await setLocation(`?return_to=https://kuvert.test/callback${PKCE_QS}`)
    render(<LoginPage />)

    await screen.findByPlaceholderText(/example/i)
    const emailInput = document.getElementById('login-email') as HTMLInputElement

    fireEvent.focus(emailInput)
    expect(emailInput.readOnly).toBe(false)
    fireEvent.blur(emailInput)
    expect(emailInput.readOnly).toBe(true)

    // Second cycle - a "one-shot" implementation that only guards the very
    // first focus would fail to reinstate readOnly here, or fail to remove
    // it again on this second focus.
    fireEvent.focus(emailInput)
    expect(emailInput.readOnly).toBe(false)
    fireEvent.blur(emailInput)
    expect(emailInput.readOnly).toBe(true)
    vi.unstubAllEnvs()
  })
})

describe('LoginPage — register link', () => {
  it('carries the return_to param over to the register link', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { LoginPage } = await setLocation(`?return_to=https%3A%2F%2Fkuvert.test%2Fcallback${PKCE_QS}`)
    render(<LoginPage />)
    const link = await screen.findByRole('link', { name: /зарегистрироваться/i })
    expect(link).toHaveAttribute(
      'href',
      `/register?return_to=https%3A%2F%2Fkuvert.test%2Fcallback&code_challenge=${CODE_CHALLENGE}&code_challenge_method=S256`,
    )
    vi.unstubAllEnvs()
  })
})
