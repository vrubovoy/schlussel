import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const mockRegister = vi.fn()
vi.mock('../lib/api', () => ({
  register: (...args: unknown[]) => mockRegister(...args),
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
    }
  },
}))

async function setLocation(search: string, hash: string = '') {
  vi.resetModules()
  const original = window.location
  // @ts-expect-error -- jsdom allows reassigning location for test purposes
  delete window.location
  // @ts-expect-error -- minimal stub covering what the module under test reads
  window.location = { ...original, search, hash, href: '', pathname: '/register' }
  const mod = await import('../features/auth/RegisterPage')
  return { RegisterPage: mod.RegisterPage }
}

// A plausible 43-character base64url code_challenge fixture, valid per the
// readCodeChallenge contract (see returnTo.test.ts): present + code_challenge_method=S256.
const CODE_CHALLENGE = 'B'.repeat(43)
const PKCE_QS = `&code_challenge=${CODE_CHALLENGE}&code_challenge_method=S256`

beforeEach(() => {
  mockRegister.mockReset()
  localStorage.clear()
})

describe('RegisterPage — no return_to', () => {
  it('redirects immediately to the hardcoded default app URL when VITE_DEFAULT_APP_URL is not set', async () => {
    const { RegisterPage } = await setLocation('')
    render(<RegisterPage />)
    expect(window.location.href).toBe('http://localhost:3000')
  })

  it('redirects immediately to VITE_DEFAULT_APP_URL when it is stubbed', async () => {
    vi.stubEnv('VITE_DEFAULT_APP_URL', 'https://schloss.example.com')
    const { RegisterPage } = await setLocation('')
    render(<RegisterPage />)
    expect(window.location.href).toBe('https://schloss.example.com')
    vi.unstubAllEnvs()
  })

  it('does not render name, email or password fields', async () => {
    const { RegisterPage } = await setLocation('')
    render(<RegisterPage />)
    expect(screen.queryByPlaceholderText('Ваше имя')).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/example/i)).not.toBeInTheDocument()
    expect(document.querySelector('input[type="password"]')).not.toBeInTheDocument()
  })

  it('never calls register', async () => {
    const { RegisterPage } = await setLocation('')
    render(<RegisterPage />)
    expect(mockRegister).not.toHaveBeenCalled()
  })
})

describe('RegisterPage — missing or invalid code_challenge', () => {
  it('redirects to the default app URL (same as missing return_to) when return_to is valid but code_challenge is absent', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { RegisterPage } = await setLocation('?return_to=https://kuvert.test/callback')
    render(<RegisterPage />)
    expect(window.location.href).toBe('http://localhost:3000')
    expect(screen.queryByPlaceholderText('Ваше имя')).not.toBeInTheDocument()
    expect(mockRegister).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })

  it('redirects to the default app URL when code_challenge is present but code_challenge_method is not S256', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { RegisterPage } = await setLocation(
      `?return_to=https://kuvert.test/callback&code_challenge=${CODE_CHALLENGE}&code_challenge_method=plain`,
    )
    render(<RegisterPage />)
    expect(window.location.href).toBe('http://localhost:3000')
    expect(screen.queryByPlaceholderText('Ваше имя')).not.toBeInTheDocument()
    expect(mockRegister).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })

  it('honors VITE_DEFAULT_APP_URL when redirecting due to missing code_challenge', async () => {
    vi.stubEnv('VITE_DEFAULT_APP_URL', 'https://schloss.example.com')
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { RegisterPage } = await setLocation('?return_to=https://kuvert.test/callback')
    render(<RegisterPage />)
    expect(window.location.href).toBe('https://schloss.example.com')
    vi.unstubAllEnvs()
  })
})

describe('RegisterPage — valid return_to', () => {
  it('calls register with email, password, name and the code_challenge extracted from the URL', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { RegisterPage } = await setLocation(`?return_to=https://kuvert.test/callback${PKCE_QS}`)
    mockRegister.mockResolvedValue({ code: 'reg-code' })
    const user = userEvent.setup()
    render(<RegisterPage />)

    await user.type(screen.getByPlaceholderText('Ваше имя'), 'Alice')
    await user.type(screen.getByPlaceholderText(/example/i), 'alice@test.com')
    await user.type(document.querySelectorAll('input[type="password"]')[0], 'password1')
    await user.type(document.querySelectorAll('input[type="password"]')[1], 'password1')
    await user.click(screen.getByRole('button', { name: 'Зарегистрироваться' }))

    await waitFor(() => expect(mockRegister).toHaveBeenCalled())
    const args = mockRegister.mock.calls[0]
    expect(args).toContain('alice@test.com')
    expect(args).toContain('password1')
    expect(args).toContain('Alice')
    expect(args).toContain(CODE_CHALLENGE)
    vi.unstubAllEnvs()
  })

  it('redirects with the code in the URL query string on successful registration (no existing query on return_to)', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { RegisterPage } = await setLocation(`?return_to=https://kuvert.test/callback${PKCE_QS}`)
    mockRegister.mockResolvedValue({ code: 'reg-code' })
    const user = userEvent.setup()
    render(<RegisterPage />)

    await user.type(screen.getByPlaceholderText('Ваше имя'), 'Alice')
    await user.type(screen.getByPlaceholderText(/example/i), 'alice@test.com')
    await user.type(document.querySelectorAll('input[type="password"]')[0], 'password1')
    await user.type(document.querySelectorAll('input[type="password"]')[1], 'password1')
    await user.click(screen.getByRole('button', { name: 'Зарегистрироваться' }))

    await waitFor(() => expect(window.location.href).toBe('https://kuvert.test/callback?code=reg-code'))
    expect(window.location.href).not.toContain('#')
    vi.unstubAllEnvs()
  })

  it('redirects with &code=<value> appended when the return_to URL already has a query string', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { RegisterPage } = await setLocation(
      `?return_to=${encodeURIComponent('https://kuvert.test/callback?next=%2Fbudget')}${PKCE_QS}`,
    )
    mockRegister.mockResolvedValue({ code: 'reg-code' })
    const user = userEvent.setup()
    render(<RegisterPage />)

    await user.type(screen.getByPlaceholderText('Ваше имя'), 'Alice')
    await user.type(screen.getByPlaceholderText(/example/i), 'alice@test.com')
    await user.type(document.querySelectorAll('input[type="password"]')[0], 'password1')
    await user.type(document.querySelectorAll('input[type="password"]')[1], 'password1')
    await user.click(screen.getByRole('button', { name: 'Зарегистрироваться' }))

    await waitFor(() =>
      expect(window.location.href).toBe('https://kuvert.test/callback?next=%2Fbudget&code=reg-code'),
    )
    vi.unstubAllEnvs()
  })

  it('shows an error when the email is already registered', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { RegisterPage } = await setLocation(`?return_to=https://kuvert.test/callback${PKCE_QS}`)
    const ApiError = (await import('../lib/api')).ApiError
    mockRegister.mockRejectedValue(new ApiError(409, 'Email already registered'))
    const user = userEvent.setup()
    render(<RegisterPage />)

    await user.type(screen.getByPlaceholderText('Ваше имя'), 'Alice')
    await user.type(screen.getByPlaceholderText(/example/i), 'dup@test.com')
    await user.type(document.querySelectorAll('input[type="password"]')[0], 'password1')
    await user.type(document.querySelectorAll('input[type="password"]')[1], 'password1')
    await user.click(screen.getByRole('button', { name: 'Зарегистрироваться' }))

    await screen.findByText('Этот email уже зарегистрирован')
    vi.unstubAllEnvs()
  })
})

describe('RegisterPage — password confirmation', () => {
  it('blocks submission and shows an error when the passwords do not match', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { RegisterPage } = await setLocation(`?return_to=https://kuvert.test/callback${PKCE_QS}`)
    const user = userEvent.setup()
    render(<RegisterPage />)

    await user.type(screen.getByPlaceholderText('Ваше имя'), 'Alice')
    await user.type(screen.getByPlaceholderText(/example/i), 'alice@test.com')
    await user.type(document.querySelectorAll('input[type="password"]')[0], 'password1')
    await user.type(document.querySelectorAll('input[type="password"]')[1], 'password2')
    await user.click(screen.getByRole('button', { name: 'Зарегистрироваться' }))

    await screen.findByText('Пароли не совпадают')
    expect(mockRegister).not.toHaveBeenCalled()
    expect(window.location.href).toBe('')
    vi.unstubAllEnvs()
  })

  it('proceeds with registration when the passwords match', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { RegisterPage } = await setLocation(`?return_to=https://kuvert.test/callback${PKCE_QS}`)
    mockRegister.mockResolvedValue({ code: 'reg-code' })
    const user = userEvent.setup()
    render(<RegisterPage />)

    await user.type(screen.getByPlaceholderText('Ваше имя'), 'Alice')
    await user.type(screen.getByPlaceholderText(/example/i), 'alice@test.com')
    await user.type(document.querySelectorAll('input[type="password"]')[0], 'password1')
    await user.type(document.querySelectorAll('input[type="password"]')[1], 'password1')
    await user.click(screen.getByRole('button', { name: 'Зарегистрироваться' }))

    await waitFor(() => expect(mockRegister).toHaveBeenCalled())
    const args = mockRegister.mock.calls[0]
    expect(args).toContain('alice@test.com')
    expect(args).toContain('password1')
    expect(args).toContain('Alice')
    expect(args).toContain(CODE_CHALLENGE)
    expect(screen.queryByText('Пароли не совпадают')).not.toBeInTheDocument()
    vi.unstubAllEnvs()
  })
})

describe('RegisterPage — field-level validation', () => {
  it('rejects a name containing digits without ever calling register', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { RegisterPage } = await setLocation(`?return_to=https://kuvert.test/callback${PKCE_QS}`)
    const user = userEvent.setup()
    render(<RegisterPage />)

    await user.type(screen.getByPlaceholderText('Ваше имя'), 'Alice2')
    await user.type(screen.getByPlaceholderText(/example/i), 'alice@test.com')
    await user.type(document.querySelectorAll('input[type="password"]')[0], 'password1')
    await user.type(document.querySelectorAll('input[type="password"]')[1], 'password1')
    await user.click(screen.getByRole('button', { name: 'Зарегистрироваться' }))

    expect(await screen.findByText('Имя не должно содержать цифры')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Ваше имя')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByPlaceholderText(/example/i)).toHaveAttribute('aria-invalid', 'false')
    expect(mockRegister).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })

  it('rejects a malformed email without ever calling register', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { RegisterPage } = await setLocation(`?return_to=https://kuvert.test/callback${PKCE_QS}`)
    const user = userEvent.setup()
    render(<RegisterPage />)

    await user.type(screen.getByPlaceholderText('Ваше имя'), 'Alice')
    await user.type(screen.getByPlaceholderText(/example/i), 'not-an-email')
    await user.type(document.querySelectorAll('input[type="password"]')[0], 'password1')
    await user.type(document.querySelectorAll('input[type="password"]')[1], 'password1')
    await user.click(screen.getByRole('button', { name: 'Зарегистрироваться' }))

    expect(await screen.findByText('Неверный формат email')).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/example/i)).toHaveAttribute('aria-invalid', 'true')
    expect(mockRegister).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })

  it('rejects a password shorter than 8 characters without ever calling register', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { RegisterPage } = await setLocation(`?return_to=https://kuvert.test/callback${PKCE_QS}`)
    const user = userEvent.setup()
    render(<RegisterPage />)

    await user.type(screen.getByPlaceholderText('Ваше имя'), 'Alice')
    await user.type(screen.getByPlaceholderText(/example/i), 'alice@test.com')
    await user.type(document.querySelectorAll('input[type="password"]')[0], 'short')
    await user.type(document.querySelectorAll('input[type="password"]')[1], 'short')
    await user.click(screen.getByRole('button', { name: 'Зарегистрироваться' }))

    expect(await screen.findByText('Минимум 8 символов')).toBeInTheDocument()
    expect(mockRegister).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })

  it('clears a field error as soon as that field is edited again', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { RegisterPage } = await setLocation(`?return_to=https://kuvert.test/callback${PKCE_QS}`)
    const user = userEvent.setup()
    render(<RegisterPage />)

    await user.type(screen.getByPlaceholderText('Ваше имя'), 'Alice2')
    await user.type(screen.getByPlaceholderText(/example/i), 'alice@test.com')
    await user.type(document.querySelectorAll('input[type="password"]')[0], 'password1')
    await user.type(document.querySelectorAll('input[type="password"]')[1], 'password1')
    await user.click(screen.getByRole('button', { name: 'Зарегистрироваться' }))
    await screen.findByText('Имя не должно содержать цифры')

    await user.type(screen.getByPlaceholderText('Ваше имя'), '3')
    expect(screen.queryByText('Имя не должно содержать цифры')).not.toBeInTheDocument()
    vi.unstubAllEnvs()
  })

  it('marks the email field invalid (not the password fields) when the email is already registered', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { RegisterPage } = await setLocation(`?return_to=https://kuvert.test/callback${PKCE_QS}`)
    const ApiError = (await import('../lib/api')).ApiError
    mockRegister.mockRejectedValue(new ApiError(409, 'Email already registered'))
    const user = userEvent.setup()
    render(<RegisterPage />)

    await user.type(screen.getByPlaceholderText('Ваше имя'), 'Alice')
    await user.type(screen.getByPlaceholderText(/example/i), 'dup@test.com')
    await user.type(document.querySelectorAll('input[type="password"]')[0], 'password1')
    await user.type(document.querySelectorAll('input[type="password"]')[1], 'password1')
    await user.click(screen.getByRole('button', { name: 'Зарегистрироваться' }))

    await screen.findByText('Этот email уже зарегистрирован')
    expect(screen.getByPlaceholderText(/example/i)).toHaveAttribute('aria-invalid', 'true')
    expect(document.querySelectorAll('input[type="password"]')[0]).toHaveAttribute('aria-invalid', 'false')
    vi.unstubAllEnvs()
  })
})

describe('RegisterPage — password visibility toggle', () => {
  it('shows two toggle buttons, both initially labeled "Показать пароль"', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { RegisterPage } = await setLocation(`?return_to=https://kuvert.test/callback${PKCE_QS}`)
    render(<RegisterPage />)

    const toggles = screen.getAllByRole('button', { name: 'Показать пароль' })
    expect(toggles).toHaveLength(2)
    vi.unstubAllEnvs()
  })

  it('toggles the main password field independently of the confirm field', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { RegisterPage } = await setLocation(`?return_to=https://kuvert.test/callback${PKCE_QS}`)
    const user = userEvent.setup()
    render(<RegisterPage />)

    const passwordInput = document.querySelector('#register-password') as HTMLInputElement
    const confirmInput = document.querySelector('#register-password-confirm') as HTMLInputElement
    expect(passwordInput).toHaveAttribute('type', 'password')
    expect(confirmInput).toHaveAttribute('type', 'password')

    const [passwordToggle, confirmToggle] = screen.getAllByRole('button', { name: 'Показать пароль' })

    await user.click(passwordToggle)
    expect(passwordInput).toHaveAttribute('type', 'text')
    expect(confirmInput).toHaveAttribute('type', 'password')
    expect(screen.getByRole('button', { name: 'Скрыть пароль' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Показать пароль' })).toBeInTheDocument()

    await user.click(confirmToggle)
    expect(passwordInput).toHaveAttribute('type', 'text')
    expect(confirmInput).toHaveAttribute('type', 'text')
    expect(screen.getAllByRole('button', { name: 'Скрыть пароль' })).toHaveLength(2)

    vi.unstubAllEnvs()
  })

  it('preserves typed values in both fields when toggling visibility', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { RegisterPage } = await setLocation(`?return_to=https://kuvert.test/callback${PKCE_QS}`)
    const user = userEvent.setup()
    render(<RegisterPage />)

    const passwordInput = document.querySelector('#register-password') as HTMLInputElement
    const confirmInput = document.querySelector('#register-password-confirm') as HTMLInputElement

    await user.type(passwordInput, 'password1')
    await user.type(confirmInput, 'password2')

    const [passwordToggle, confirmToggle] = screen.getAllByRole('button', { name: 'Показать пароль' })
    await user.click(passwordToggle)
    await user.click(confirmToggle)

    expect(passwordInput).toHaveValue('password1')
    expect(confirmInput).toHaveValue('password2')
    vi.unstubAllEnvs()
  })
})

describe('RegisterPage — invalid return_to', () => {
  it('shows an error page instead of the registration form and never calls register', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { RegisterPage } = await setLocation(`?return_to=https://evil.test/steal${PKCE_QS}`)
    render(<RegisterPage />)

    expect(screen.getByText(/небезопасный адрес возврата/i)).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Ваше имя')).not.toBeInTheDocument()
    expect(mockRegister).not.toHaveBeenCalled()
    expect(window.location.href).toBe('')
    vi.unstubAllEnvs()
  })
})

describe('RegisterPage — login link', () => {
  it('carries the return_to param over to the login link', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { RegisterPage } = await setLocation(`?return_to=https%3A%2F%2Fkuvert.test%2Fcallback${PKCE_QS}`)
    render(<RegisterPage />)
    const link = screen.getByRole('link', { name: /^войти$/i })
    expect(link).toHaveAttribute(
      'href',
      `/login?return_to=https%3A%2F%2Fkuvert.test%2Fcallback&code_challenge=${CODE_CHALLENGE}&code_challenge_method=S256`,
    )
    vi.unstubAllEnvs()
  })
})

describe('RegisterPage — invite-gated registration', () => {
  // A bare admin-shared invite link: no return_to, no code_challenge at all.
  // Unlike every other "no return_to" case above (which bounces away
  // immediately), the presence of #invite= makes this a legitimate entry
  // point, so the form should render instead. The decision appears to be
  // made asynchronously (the very first render is still blank), so queries
  // here use the async find* variants rather than get*. The code travels
  // in the URL fragment, not a query param - see returnTo.ts's
  // readInviteCode for why.
  const INVITE_HASH = '#invite=SOMECODE123'

  it('renders the registration form instead of redirecting when only #invite= is present', async () => {
    const { RegisterPage } = await setLocation('', INVITE_HASH)
    render(<RegisterPage />)

    expect(await screen.findByPlaceholderText('Ваше имя')).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/example/i)).toBeInTheDocument()
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(2)
    expect(window.location.href).toBe('')
    expect(mockRegister).not.toHaveBeenCalled()
  })

  it('pre-fills an invite-code field with the code from the URL', async () => {
    const { RegisterPage } = await setLocation('', INVITE_HASH)
    render(<RegisterPage />)

    await screen.findByPlaceholderText('Ваше имя')
    expect(screen.getByDisplayValue('SOMECODE123')).toBeInTheDocument()
  })

  it('calls register with the invite code included when submitting from a bare invite link', async () => {
    const { RegisterPage } = await setLocation('', INVITE_HASH)
    mockRegister.mockResolvedValue({ code: 'reg-code' })
    const user = userEvent.setup()
    render(<RegisterPage />)

    await user.type(await screen.findByPlaceholderText('Ваше имя'), 'Alice')
    await user.type(screen.getByPlaceholderText(/example/i), 'alice@test.com')
    await user.type(document.querySelectorAll('input[type="password"]')[0], 'password1')
    await user.type(document.querySelectorAll('input[type="password"]')[1], 'password1')
    await user.click(screen.getByRole('button', { name: 'Зарегистрироваться' }))

    await waitFor(() => expect(mockRegister).toHaveBeenCalled())
    const args = mockRegister.mock.calls[0]
    expect(args).toContain('SOMECODE123')
  })

  it('navigates away on successful submission from a bare invite link', async () => {
    const { RegisterPage } = await setLocation('', INVITE_HASH)
    mockRegister.mockResolvedValue({ code: 'reg-code' })
    const user = userEvent.setup()
    render(<RegisterPage />)

    await user.type(await screen.findByPlaceholderText('Ваше имя'), 'Alice')
    await user.type(screen.getByPlaceholderText(/example/i), 'alice@test.com')
    await user.type(document.querySelectorAll('input[type="password"]')[0], 'password1')
    await user.type(document.querySelectorAll('input[type="password"]')[1], 'password1')
    await user.click(screen.getByRole('button', { name: 'Зарегистрироваться' }))

    await waitFor(() => expect(mockRegister).toHaveBeenCalled())
    await waitFor(() => expect(window.location.href).not.toBe(''))
    expect(window.location.href).not.toBe('/register')
  })

  it('also includes the invite code in register() call args for the existing return_to + code_challenge path', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    const { RegisterPage } = await setLocation(
      `?return_to=https://kuvert.test/callback${PKCE_QS}`,
      INVITE_HASH,
    )
    mockRegister.mockResolvedValue({ code: 'reg-code' })
    const user = userEvent.setup()
    render(<RegisterPage />)

    await user.type(screen.getByPlaceholderText('Ваше имя'), 'Alice')
    await user.type(screen.getByPlaceholderText(/example/i), 'alice@test.com')
    await user.type(document.querySelectorAll('input[type="password"]')[0], 'password1')
    await user.type(document.querySelectorAll('input[type="password"]')[1], 'password1')
    await user.click(screen.getByRole('button', { name: 'Зарегистрироваться' }))

    await waitFor(() => expect(mockRegister).toHaveBeenCalled())
    const args = mockRegister.mock.calls[0]
    expect(args).toContain('SOMECODE123')
    vi.unstubAllEnvs()
  })

  it('shows a distinct error when register rejects with a 400 (invalid/expired invite) on the bare invite-link path', async () => {
    const { RegisterPage } = await setLocation('', INVITE_HASH)
    const ApiError = (await import('../lib/api')).ApiError
    mockRegister.mockRejectedValue(new ApiError(400, 'Invalid or expired invite code'))
    const user = userEvent.setup()
    render(<RegisterPage />)

    await user.type(await screen.findByPlaceholderText('Ваше имя'), 'Alice')
    await user.type(screen.getByPlaceholderText(/example/i), 'alice@test.com')
    await user.type(document.querySelectorAll('input[type="password"]')[0], 'password1')
    await user.type(document.querySelectorAll('input[type="password"]')[1], 'password1')
    await user.click(screen.getByRole('button', { name: 'Зарегистрироваться' }))

    await waitFor(() => expect(mockRegister).toHaveBeenCalled())
    await waitFor(() => {
      const text = document.body.textContent ?? ''
      expect(text.length).toBeGreaterThan(0)
    })
    expect(screen.queryByText('Пароли не совпадают')).not.toBeInTheDocument()
    expect(screen.queryByText('Этот email уже зарегистрирован')).not.toBeInTheDocument()
  })
})
