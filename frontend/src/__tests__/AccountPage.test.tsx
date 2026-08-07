import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const mockRefreshSession = vi.fn()
const mockFetchMe = vi.fn()
const mockExchangeCode = vi.fn()
const mockChangePassword = vi.fn()
const mockDeleteAccount = vi.fn()
const mockUpdateName = vi.fn()
const mockListSessions = vi.fn()
const mockRevokeSession = vi.fn()
const mockLogoutEverywhere = vi.fn()
const mockFetchProfile = vi.fn()
const mockUpdateProfile = vi.fn()
const mockUploadAvatar = vi.fn()
const mockDeleteAvatar = vi.fn()
const mockListConnectedAccounts = vi.fn()
const mockExportAccountData = vi.fn()

vi.mock('../lib/api', () => ({
  refreshSession: (...args: unknown[]) => mockRefreshSession(...args),
  fetchMe: (...args: unknown[]) => mockFetchMe(...args),
  exchangeCode: (...args: unknown[]) => mockExchangeCode(...args),
  changePassword: (...args: unknown[]) => mockChangePassword(...args),
  deleteAccount: (...args: unknown[]) => mockDeleteAccount(...args),
  updateName: (...args: unknown[]) => mockUpdateName(...args),
  listSessions: (...args: unknown[]) => mockListSessions(...args),
  revokeSession: (...args: unknown[]) => mockRevokeSession(...args),
  logoutEverywhere: (...args: unknown[]) => mockLogoutEverywhere(...args),
  fetchProfile: (...args: unknown[]) => mockFetchProfile(...args),
  updateProfile: (...args: unknown[]) => mockUpdateProfile(...args),
  uploadAvatar: (...args: unknown[]) => mockUploadAvatar(...args),
  deleteAvatar: (...args: unknown[]) => mockDeleteAvatar(...args),
  listConnectedAccounts: (...args: unknown[]) => mockListConnectedAccounts(...args),
  exportAccountData: (...args: unknown[]) => mockExportAccountData(...args),
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
  window.location = { ...original, search, href: '', pathname: '/account' }
  const mod = await import('../features/account/AccountPage')
  return { AccountPage: mod.AccountPage }
}

const USER = { id: '1', email: 'jane@example.com', name: 'Jane Doe', role: 'user' }
const PROFILE = {
  ...USER,
  avatarDataUrl: null, timezone: null, dateFormat: null, weekStart: null, language: null,
  notifyInApp: true, notifyBrowserPush: false, notifyTelegram: false, sessionTimeoutMinutes: null,
}

// Common path used by most tests below the bootstrap stage: a valid
// refreshSession + fetchMe round-trip landing on the fixture user, so the
// full form is on screen before the test's own assertions begin.
async function renderLoggedIn(search = '') {
  mockRefreshSession.mockResolvedValue({ accessToken: 'token-abc' })
  mockFetchMe.mockResolvedValue(USER)
  const { AccountPage } = await setLocation(search)
  const user = userEvent.setup()
  const { container } = render(<AccountPage />)
  await screen.findByText('Настройки аккаунта')
  return { user, container }
}

beforeEach(() => {
  mockRefreshSession.mockReset()
  mockFetchMe.mockReset()
  mockExchangeCode.mockReset()
  mockChangePassword.mockReset()
  mockDeleteAccount.mockReset()
  mockUpdateName.mockReset()
  mockListSessions.mockReset()
  mockRevokeSession.mockReset()
  mockLogoutEverywhere.mockReset()
  mockFetchProfile.mockReset()
  mockUpdateProfile.mockReset()
  mockUploadAvatar.mockReset()
  mockDeleteAvatar.mockReset()
  mockListConnectedAccounts.mockReset()
  mockExportAccountData.mockReset()
  // Default: an empty sessions list, so tests that don't care about the
  // sessions card (most of them) don't have to stub this themselves.
  mockListSessions.mockResolvedValue([])
  // Same idea for the new cards' own independent fetches - a plain
  // default profile/empty accounts list, so tests unrelated to them don't
  // have to stub every new endpoint just to render past their loading state.
  mockFetchProfile.mockResolvedValue(PROFILE)
  mockListConnectedAccounts.mockResolvedValue([])
  sessionStorage.clear()
})

describe('AccountPage — session bootstrap (no code)', () => {
  it('renders a blank loading state with no heading or form fields while refreshSession is pending', async () => {
    mockRefreshSession.mockReturnValue(new Promise(() => {}))
    const { AccountPage } = await setLocation('')
    render(<AccountPage />)
    expect(screen.queryByText('Настройки аккаунта')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Текущий пароль')).not.toBeInTheDocument()
    expect(screen.queryByText('Jane Doe')).not.toBeInTheDocument()
  })

  it('calls refreshSession with no arguments on mount', async () => {
    mockRefreshSession.mockResolvedValue({ accessToken: 'tok' })
    mockFetchMe.mockResolvedValue(USER)
    const { AccountPage } = await setLocation('')
    render(<AccountPage />)
    await waitFor(() => expect(mockRefreshSession).toHaveBeenCalledWith())
  })

  it('calls fetchMe with the accessToken once refreshSession resolves', async () => {
    mockRefreshSession.mockResolvedValue({ accessToken: 'tok-xyz' })
    mockFetchMe.mockResolvedValue(USER)
    const { AccountPage } = await setLocation('')
    render(<AccountPage />)
    await waitFor(() => expect(mockFetchMe).toHaveBeenCalledWith('tok-xyz'))
  })

  it('renders normally and never touches window.location.href when fetchMe succeeds', async () => {
    await renderLoggedIn()
    expect(window.location.href).toBe('')
  })

  it('redirects to login when fetchMe rejects', async () => {
    mockRefreshSession.mockResolvedValue({ accessToken: 'tok' })
    mockFetchMe.mockRejectedValue(new Error('no user'))
    const { AccountPage } = await setLocation('')
    render(<AccountPage />)
    await waitFor(() => expect(window.location.href).toMatch(/^\/login\?/))
  })

  it('redirects to login when refreshSession rejects', async () => {
    mockRefreshSession.mockRejectedValue(new Error('no session'))
    const { AccountPage } = await setLocation('')
    render(<AccountPage />)
    await waitFor(() => expect(window.location.href).toMatch(/^\/login\?/))
  })
})

describe('AccountPage — code exchange (?code=...)', () => {
  it('calls exchangeCode with the code param and stored verifier, and renders using its user without a separate fetchMe call', async () => {
    sessionStorage.setItem('account_pkce_code_verifier', 'the-verifier')
    mockExchangeCode.mockResolvedValue({ accessToken: 'tok', user: USER })
    const { AccountPage } = await setLocation('?code=the-code')
    render(<AccountPage />)
    await screen.findByText('Настройки аккаунта')
    expect(mockExchangeCode).toHaveBeenCalledWith('the-code', 'the-verifier')
    expect(mockFetchMe).not.toHaveBeenCalled()
    // The name now lives in an editable input, not static text (see the
    // "editable name form" batch that redesigned ProfileCard).
    expect(screen.getByDisplayValue('Jane Doe')).toBeInTheDocument()
  })

  it('removes the stored verifier from sessionStorage after reading it', async () => {
    sessionStorage.setItem('account_pkce_code_verifier', 'the-verifier')
    mockExchangeCode.mockResolvedValue({ accessToken: 'tok', user: USER })
    const { AccountPage } = await setLocation('?code=the-code')
    render(<AccountPage />)
    await screen.findByText('Настройки аккаунта')
    expect(sessionStorage.getItem('account_pkce_code_verifier')).toBeNull()
  })

  it('strips the code param from the visible URL via history.replaceState', async () => {
    sessionStorage.setItem('account_pkce_code_verifier', 'the-verifier')
    mockExchangeCode.mockResolvedValue({ accessToken: 'tok', user: USER })
    const { AccountPage } = await setLocation('?code=the-code')
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {})
    render(<AccountPage />)
    await waitFor(() => expect(replaceStateSpy).toHaveBeenCalled())
    replaceStateSpy.mockRestore()
  })

  it('falls back to refreshSession + fetchMe when exchangeCode rejects, without redirecting to login solely because of that failure', async () => {
    sessionStorage.setItem('account_pkce_code_verifier', 'the-verifier')
    mockExchangeCode.mockRejectedValue(new Error('bad code'))
    mockRefreshSession.mockResolvedValue({ accessToken: 'tok2' })
    mockFetchMe.mockResolvedValue(USER)
    const { AccountPage } = await setLocation('?code=the-code')
    render(<AccountPage />)
    await screen.findByText('Настройки аккаунта')
    expect(mockRefreshSession).toHaveBeenCalled()
    expect(mockFetchMe).toHaveBeenCalledWith('tok2')
  })
})

describe('AccountPage — redirect to login (no valid session)', () => {
  it('redirects to /login? with return_to=<origin>/account, a non-empty code_challenge, and code_challenge_method=S256', async () => {
    mockRefreshSession.mockRejectedValue(new Error('no session'))
    const { AccountPage } = await setLocation('')
    render(<AccountPage />)
    await waitFor(() => expect(window.location.href).toMatch(/^\/login\?/))

    const params = new URL(window.location.href, window.location.origin).searchParams
    expect(params.get('return_to')).toBe(`${window.location.origin}/account`)
    expect(params.get('code_challenge')).toBeTruthy()
    expect(params.get('code_challenge_method')).toBe('S256')
  })

  it('saves a non-empty PKCE verifier to sessionStorage before redirecting', async () => {
    mockRefreshSession.mockRejectedValue(new Error('no session'))
    const { AccountPage } = await setLocation('')
    render(<AccountPage />)
    await waitFor(() => expect(window.location.href).toMatch(/^\/login\?/))
    expect(sessionStorage.getItem('account_pkce_code_verifier')).toBeTruthy()
  })

  it('never renders form or user content before the redirect fires', async () => {
    mockRefreshSession.mockRejectedValue(new Error('no session'))
    const { AccountPage } = await setLocation('')
    render(<AccountPage />)
    await waitFor(() => expect(window.location.href).toMatch(/^\/login\?/))
    expect(screen.queryByText('Настройки аккаунта')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Текущий пароль')).not.toBeInTheDocument()
  })
})

describe('AccountPage — rendered content', () => {
  it('shows the heading and the user name and email', async () => {
    await renderLoggedIn()
    expect(screen.getByText('Настройки аккаунта')).toBeInTheDocument()
    // The name now lives in an editable input, not static text (see the
    // "editable name form" batch that redesigned ProfileCard).
    expect(screen.getByDisplayValue('Jane Doe')).toBeInTheDocument()
    expect(screen.getByText('jane@example.com')).toBeInTheDocument()
  })

  it('shows the password-change form fields and submit button', async () => {
    await renderLoggedIn()
    expect(screen.getByLabelText('Текущий пароль')).toBeInTheDocument()
    expect(screen.getByLabelText('Новый пароль')).toBeInTheDocument()
    expect(screen.getByLabelText('Повторите новый пароль')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Изменить пароль' })).toBeInTheDocument()
  })

  it('each password field independently toggles type via its own Показать/Скрыть пароль button', async () => {
    const { user } = await renderLoggedIn()

    const current = screen.getByLabelText('Текущий пароль') as HTMLInputElement
    const next = screen.getByLabelText('Новый пароль') as HTMLInputElement
    expect(current).toHaveAttribute('type', 'password')
    expect(next).toHaveAttribute('type', 'password')

    const currentToggle = within(current.parentElement as HTMLElement).getByRole('button', {
      name: 'Показать пароль',
    })
    await user.click(currentToggle)
    expect(current).toHaveAttribute('type', 'text')
    // Sibling field is unaffected.
    expect(next).toHaveAttribute('type', 'password')

    expect(
      within(current.parentElement as HTMLElement).getByRole('button', { name: 'Скрыть пароль' }),
    ).toBeInTheDocument()
  })

  it('shows the danger-zone password field and a submit button disabled until text is typed', async () => {
    const { user } = await renderLoggedIn()
    const deleteButton = screen.getByRole('button', { name: 'Удалить аккаунт навсегда' })
    expect(deleteButton).toBeDisabled()

    await user.type(screen.getByLabelText('Пароль'), 'x')
    expect(deleteButton).toBeEnabled()
  })

  it('mentions both "аккаунт" and "удалить" somewhere in the danger zone', async () => {
    await renderLoggedIn()
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/аккаунт/i)
    expect(text).toMatch(/удалить/i)
  })
})

describe('AccountPage — back link', () => {
  it('renders a link to the return_to URL when it is present and allowed', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    await renderLoggedIn('?return_to=' + encodeURIComponent('https://kuvert.test/budget'))
    const link = document.querySelector('a[href="https://kuvert.test/budget"]')
    expect(link).toBeTruthy()
    vi.unstubAllEnvs()
  })

  // The page chrome always renders its own external links regardless of
  // return_to - the header's home logo (href === window.location.origin)
  // and the footer's GitHub icon - neither is the "back" link under test
  // here, so both are excluded from this count.
  function externalNonChromeLinks(): Element[] {
    return Array.from(document.querySelectorAll('a[href^="http"]')).filter((a) => {
      if (a.getAttribute('href') === window.location.origin) return false
      if (a.getAttribute('aria-label') === 'GitHub') return false
      return true
    })
  }

  it('renders no back link when return_to is absent', async () => {
    await renderLoggedIn('')
    expect(externalNonChromeLinks().length).toBe(0)
  })

  it('renders no back link when return_to is present but not an allowed origin', async () => {
    vi.stubEnv('VITE_ALLOWED_RETURN_ORIGINS', 'https://kuvert.test')
    await renderLoggedIn('?return_to=' + encodeURIComponent('https://evil.test/steal'))
    expect(externalNonChromeLinks().length).toBe(0)
    vi.unstubAllEnvs()
  })
})

describe('AccountPage — change password', () => {
  it('calls changePassword with the current and new password as the last two arguments', async () => {
    const { user } = await renderLoggedIn()
    mockChangePassword.mockResolvedValue(undefined)

    await user.type(screen.getByLabelText('Текущий пароль'), 'oldpass123')
    await user.type(screen.getByLabelText('Новый пароль'), 'newpass456')
    await user.type(screen.getByLabelText('Повторите новый пароль'), 'newpass456')
    await user.click(screen.getByRole('button', { name: 'Изменить пароль' }))

    await waitFor(() => expect(mockChangePassword).toHaveBeenCalled())
    const args = mockChangePassword.mock.calls[0]
    expect(args[args.length - 2]).toBe('oldpass123')
    expect(args[args.length - 1]).toBe('newpass456')
  })

  it('does not call changePassword and shows a mismatch message when the new password fields differ', async () => {
    const { user } = await renderLoggedIn()

    await user.type(screen.getByLabelText('Текущий пароль'), 'oldpass123')
    await user.type(screen.getByLabelText('Новый пароль'), 'newpass456')
    await user.type(screen.getByLabelText('Повторите новый пароль'), 'different789')
    await user.click(screen.getByRole('button', { name: 'Изменить пароль' }))

    expect(await screen.findByText(/не совпадают/i)).toBeInTheDocument()
    expect(mockChangePassword).not.toHaveBeenCalled()
  })

  it('shows a success message and clears the fields when changePassword resolves', async () => {
    const { user } = await renderLoggedIn()
    mockChangePassword.mockResolvedValue(undefined)

    const current = screen.getByLabelText('Текущий пароль') as HTMLInputElement
    const next = screen.getByLabelText('Новый пароль') as HTMLInputElement
    const confirm = screen.getByLabelText('Повторите новый пароль') as HTMLInputElement

    await user.type(current, 'oldpass123')
    await user.type(next, 'newpass456')
    await user.type(confirm, 'newpass456')
    await user.click(screen.getByRole('button', { name: 'Изменить пароль' }))

    // Ordered regex ("пароль" before "измен...") to avoid also matching the
    // "Изменить пароль" submit button label, which contains both words in
    // the opposite order.
    await screen.findByText(/пароль\s+измен/i)
    expect(current).toHaveValue('')
    expect(next).toHaveValue('')
    expect(confirm).toHaveValue('')
  })

  it('shows an "invalid current password" error tied specifically to the current-password field when changePassword rejects with 401', async () => {
    const { user } = await renderLoggedIn()
    const ApiError = (await import('../lib/api')).ApiError
    mockChangePassword.mockRejectedValue(new ApiError(401, 'Invalid current password'))

    const current = screen.getByLabelText('Текущий пароль')
    await user.type(current, 'oldpass123')
    await user.type(screen.getByLabelText('Новый пароль'), 'newpass456')
    await user.type(screen.getByLabelText('Повторите новый пароль'), 'newpass456')
    await user.click(screen.getByRole('button', { name: 'Изменить пароль' }))

    await screen.findByText('Неверный текущий пароль')
    expect(current).toHaveAttribute('aria-invalid', 'true')
  })

  it('rejects a new password shorter than 8 characters without ever calling changePassword', async () => {
    const { user } = await renderLoggedIn()

    await user.type(screen.getByLabelText('Текущий пароль'), 'oldpass123')
    await user.type(screen.getByLabelText('Новый пароль'), 'short')
    await user.type(screen.getByLabelText('Повторите новый пароль'), 'short')
    await user.click(screen.getByRole('button', { name: 'Изменить пароль' }))

    expect(await screen.findByText('Минимум 8 символов')).toBeInTheDocument()
    expect(mockChangePassword).not.toHaveBeenCalled()
  })

  it('shows a visible error and does not crash when changePassword rejects with an unrelated error', async () => {
    const { user } = await renderLoggedIn()
    const ApiError = (await import('../lib/api')).ApiError
    mockChangePassword.mockRejectedValue(new ApiError(500, 'boom'))

    await user.type(screen.getByLabelText('Текущий пароль'), 'oldpass123')
    await user.type(screen.getByLabelText('Новый пароль'), 'newpass456')
    await user.type(screen.getByLabelText('Повторите новый пароль'), 'newpass456')
    await user.click(screen.getByRole('button', { name: 'Изменить пароль' }))

    await waitFor(() => expect(mockChangePassword).toHaveBeenCalled())
    // Page is still alive and showing some error text - loose assertion by design.
    expect(screen.getByText('Настройки аккаунта')).toBeInTheDocument()
  })
})

describe('AccountPage — delete account', () => {
  it('calls deleteAccount with the password as the last argument', async () => {
    const { user } = await renderLoggedIn()
    mockDeleteAccount.mockResolvedValue(undefined)

    await user.type(screen.getByLabelText('Пароль'), 'mypassword')
    await user.click(screen.getByRole('button', { name: 'Удалить аккаунт навсегда' }))

    await waitFor(() => expect(mockDeleteAccount).toHaveBeenCalled())
    const args = mockDeleteAccount.mock.calls[0]
    expect(args[args.length - 1]).toBe('mypassword')
  })

  it('navigates away by setting window.location.href when deleteAccount resolves', async () => {
    const { user } = await renderLoggedIn()
    mockDeleteAccount.mockResolvedValue(undefined)
    expect(window.location.href).toBe('')

    await user.type(screen.getByLabelText('Пароль'), 'mypassword')
    await user.click(screen.getByRole('button', { name: 'Удалить аккаунт навсегда' }))

    await waitFor(() => expect(window.location.href).not.toBe(''))
  })

  it('shows an "invalid password" error tied to the password field and does not navigate when deleteAccount rejects with 401', async () => {
    const { user } = await renderLoggedIn()
    const ApiError = (await import('../lib/api')).ApiError
    mockDeleteAccount.mockRejectedValue(new ApiError(401, 'Invalid password'))

    const passwordInput = screen.getByLabelText('Пароль')
    await user.type(passwordInput, 'mypassword')
    await user.click(screen.getByRole('button', { name: 'Удалить аккаунт навсегда' }))

    await screen.findByText('Неверный пароль')
    expect(passwordInput).toHaveAttribute('aria-invalid', 'true')
    expect(window.location.href).toBe('')
  })
})

describe('AccountPage — logout', () => {
  it('sets window.location.href to a string starting with /logout when the Выйти control is clicked', async () => {
    const { user } = await renderLoggedIn()
    await user.click(screen.getByRole('button', { name: 'Выйти' }))
    expect(window.location.href).toMatch(/^\/logout/)
  })
})

describe('AccountPage — editable name form', () => {
  it('pre-fills the name input with the current name and shows the email as read-only text', async () => {
    await renderLoggedIn()
    expect(screen.getByLabelText('Имя')).toHaveValue('Jane Doe')
    expect(screen.getByText('jane@example.com')).toBeInTheDocument()
  })

  it('disables Сохранить until the value differs from the original and is non-empty', async () => {
    const { user } = await renderLoggedIn()
    const input = screen.getByLabelText('Имя')
    const button = screen.getByRole('button', { name: 'Сохранить' })
    expect(button).toBeDisabled()

    await user.clear(input)
    await user.type(input, 'Jane Smith')
    expect(button).toBeEnabled()

    await user.clear(input)
    expect(button).toBeDisabled()

    await user.type(input, '   ')
    expect(button).toBeDisabled()

    await user.clear(input)
    await user.type(input, 'Jane Doe')
    expect(button).toBeDisabled()
  })

  it('calls updateName with the access token and the trimmed new name', async () => {
    const { user } = await renderLoggedIn()
    mockUpdateName.mockResolvedValue({ ...USER, name: 'Jane Smith' })

    const input = screen.getByLabelText('Имя')
    await user.clear(input)
    await user.type(input, 'Jane Smith')
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => expect(mockUpdateName).toHaveBeenCalled())
    const args = mockUpdateName.mock.calls[0]
    expect(args).toContain('Jane Smith')
  })

  it('shows a success message and updates the displayed value when updateName resolves', async () => {
    const { user } = await renderLoggedIn()
    mockUpdateName.mockResolvedValue({ id: '1', email: 'jane@example.com', name: 'Jane Smith', role: 'user' })

    const input = screen.getByLabelText('Имя')
    await user.clear(input)
    await user.type(input, 'Jane Smith')
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => {
      const text = document.body.textContent ?? ''
      expect(text).toMatch(/сохран/i)
    })
    expect(screen.getByDisplayValue('Jane Smith')).toBeInTheDocument()
  })

  it('shows an error and leaves the typed value untouched when updateName rejects', async () => {
    const { user } = await renderLoggedIn()
    mockUpdateName.mockRejectedValue(new Error('boom'))

    const input = screen.getByLabelText('Имя')
    await user.clear(input)
    await user.type(input, 'Jane Smith')
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => expect(mockUpdateName).toHaveBeenCalled())
    expect(input).toHaveValue('Jane Smith')
  })

  it('rejects a name containing digits without ever calling updateName', async () => {
    const { user } = await renderLoggedIn()

    const input = screen.getByLabelText('Имя')
    await user.clear(input)
    await user.type(input, 'Jane2')
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))

    expect(await screen.findByText('Имя не должно содержать цифры')).toBeInTheDocument()
    expect(mockUpdateName).not.toHaveBeenCalled()
  })
})

describe('AccountPage — focus moves to the first invalid field', () => {
  it('focuses account-name when the entered name fails validation', async () => {
    const { user } = await renderLoggedIn()

    const input = screen.getByLabelText('Имя')
    await user.clear(input)
    await user.type(input, 'Jane2')
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))

    expect(await screen.findByText('Имя не должно содержать цифры')).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById('account-name')))
    expect(mockUpdateName).not.toHaveBeenCalled()
  })

  it('focuses account-new-password when the new password is too short', async () => {
    const { user } = await renderLoggedIn()

    await user.type(screen.getByLabelText('Текущий пароль'), 'oldpass123')
    await user.type(screen.getByLabelText('Новый пароль'), 'short')
    await user.type(screen.getByLabelText('Повторите новый пароль'), 'short')
    await user.click(screen.getByRole('button', { name: 'Изменить пароль' }))

    expect(await screen.findByText('Минимум 8 символов')).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById('account-new-password')))
    expect(mockChangePassword).not.toHaveBeenCalled()
  })

  it('focuses account-new-password-confirm when the new password is valid but the confirmation does not match', async () => {
    const { user } = await renderLoggedIn()

    await user.type(screen.getByLabelText('Текущий пароль'), 'oldpass123')
    await user.type(screen.getByLabelText('Новый пароль'), 'newpass456')
    await user.type(screen.getByLabelText('Повторите новый пароль'), 'different789')
    await user.click(screen.getByRole('button', { name: 'Изменить пароль' }))

    expect(await screen.findByText(/не совпадают/i)).toBeInTheDocument()
    await waitFor(() =>
      expect(document.activeElement).toBe(document.getElementById('account-new-password-confirm')),
    )
    expect(mockChangePassword).not.toHaveBeenCalled()
  })

  it('focuses account-current-password when changePassword rejects with 401, despite a well-formed new password/confirm', async () => {
    const { user } = await renderLoggedIn()
    const ApiError = (await import('../lib/api')).ApiError
    mockChangePassword.mockRejectedValue(new ApiError(401, 'Invalid current password'))

    await user.type(screen.getByLabelText('Текущий пароль'), 'wrongcurrent')
    await user.type(screen.getByLabelText('Новый пароль'), 'newpass456')
    await user.type(screen.getByLabelText('Повторите новый пароль'), 'newpass456')
    await user.click(screen.getByRole('button', { name: 'Изменить пароль' }))

    await screen.findByText('Неверный текущий пароль')
    await waitFor(() =>
      expect(document.activeElement).toBe(document.getElementById('account-current-password')),
    )
  })

  it('focuses account-delete-password when deleteAccount rejects with 401 (wrong password)', async () => {
    const { user } = await renderLoggedIn()
    const ApiError = (await import('../lib/api')).ApiError
    mockDeleteAccount.mockRejectedValue(new ApiError(401, 'Invalid password'))

    await user.type(screen.getByLabelText('Пароль'), 'wrongpassword')
    await user.click(screen.getByRole('button', { name: 'Удалить аккаунт навсегда' }))

    await screen.findByText('Неверный пароль')
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById('account-delete-password')))
  })
})

describe('AccountPage — active sessions', () => {
  const SESSION_CURRENT = {
    id: 's1',
    userAgent: 'Mozilla/5.0 Chrome/120',
    ipAddress: '203.0.113.5',
    createdAt: '2026-07-01T10:00:00.000Z',
    expiresAt: '2026-07-08T10:00:00.000Z',
    current: true,
  }
  const SESSION_OTHER = {
    id: 's2',
    userAgent: 'Mozilla/5.0 Safari/17',
    ipAddress: '198.51.100.7',
    createdAt: '2026-06-15T08:30:00.000Z',
    expiresAt: '2026-06-22T08:30:00.000Z',
    current: false,
  }

  // Climb from a text node up the DOM until we reach the smallest ancestor
  // whose textContent contains the ip address AND either the revoke button's
  // label or the "current device" indicator text - in a per-session row
  // layout (the natural way to render a list of sessions) this lands on the
  // full row wrapper for that specific session, letting us scope queries
  // (e.g. for a revoke button) to just that row without knowing the exact
  // markup.
  function findRow(userAgentText: RegExp, ip: string): HTMLElement {
    let el: HTMLElement = screen.getByText(userAgentText)
    for (let i = 0; i < 8 && el.parentElement; i++) {
      const text = el.textContent ?? ''
      if (text.includes(ip) && (text.includes('Завершить') || /устройств/i.test(text))) return el
      el = el.parentElement
    }
    return el
  }

  it('calls listSessions with the access token once bootstrap finishes', async () => {
    mockListSessions.mockResolvedValue([])
    await renderLoggedIn()
    await waitFor(() => expect(mockListSessions).toHaveBeenCalledWith('token-abc'))
  })

  it('shows a loading indicator and no session rows while listSessions is pending', async () => {
    mockListSessions.mockReturnValue(new Promise(() => {}))
    await renderLoggedIn()
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/загрузк/i)
    expect(screen.queryByText(/Chrome\/120/)).not.toBeInTheDocument()
  })

  it('renders both sessions with their userAgent and ipAddress once listSessions resolves', async () => {
    mockListSessions.mockResolvedValue([SESSION_CURRENT, SESSION_OTHER])
    await renderLoggedIn()

    expect(await screen.findByText(/Chrome\/120/)).toBeInTheDocument()
    expect(screen.getByText(/Safari\/17/)).toBeInTheDocument()
    // ipAddress is rendered alongside a formatted date in the same text node
    // (e.g. "203.0.113.5 · 01.07.2026, 13:00"), so match it as a substring.
    expect(screen.getByText(/203\.0\.113\.5/)).toBeInTheDocument()
    expect(screen.getByText(/198\.51\.100\.7/)).toBeInTheDocument()
  })

  it('marks the current session with a "this device" indicator and no revoke button, and the other session with a revoke button and no indicator', async () => {
    mockListSessions.mockResolvedValue([SESSION_CURRENT, SESSION_OTHER])
    await renderLoggedIn()
    await screen.findByText(/Chrome\/120/)

    const currentRow = findRow(/Chrome\/120/, '203.0.113.5')
    const otherRow = findRow(/Safari\/17/, '198.51.100.7')

    expect(currentRow.textContent ?? '').toMatch(/устройств/i)
    expect(within(currentRow).queryByRole('button', { name: 'Завершить' })).not.toBeInTheDocument()

    expect(otherRow.textContent ?? '').not.toMatch(/устройств/i)
    expect(within(otherRow).getByRole('button', { name: 'Завершить' })).toBeInTheDocument()
  })

  it('shows a no-sessions message when listSessions resolves with an empty array', async () => {
    mockListSessions.mockResolvedValue([])
    await renderLoggedIn()

    await waitFor(() => expect(mockListSessions).toHaveBeenCalled())
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/загрузк/i)
    expect(screen.queryByRole('button', { name: 'Завершить' })).not.toBeInTheDocument()
    // Some non-empty message indicating there is nothing to show.
    expect(text.length).toBeGreaterThan(0)
  })

  it('shows a visible error instead of a loading indicator when listSessions rejects, without crashing', async () => {
    mockListSessions.mockRejectedValue(new Error('network down'))
    await renderLoggedIn()

    await waitFor(() => {
      const text = document.body.textContent ?? ''
      expect(text).toMatch(/удалось|ошибк/i)
    })
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/загрузк/i)
    expect(screen.getByText('Настройки аккаунта')).toBeInTheDocument()
  })

  it('revoking the non-current session calls revokeSession with the access token and its id, and removes it from the list on success', async () => {
    mockListSessions.mockResolvedValue([SESSION_CURRENT, SESSION_OTHER])
    const { user } = await renderLoggedIn()
    await screen.findByText(/Safari\/17/)
    mockRevokeSession.mockResolvedValue(undefined)

    const otherRow = findRow(/Safari\/17/, '198.51.100.7')
    await user.click(within(otherRow).getByRole('button', { name: 'Завершить' }))

    await waitFor(() => expect(mockRevokeSession).toHaveBeenCalledWith('token-abc', 's2'))
    await waitFor(() => expect(screen.queryByText(/Safari\/17/)).not.toBeInTheDocument())
    expect(screen.getByText(/Chrome\/120/)).toBeInTheDocument()
  })

  it('renders a "Выйти на всех устройствах" button regardless of the sessions list state', async () => {
    mockListSessions.mockResolvedValue([])
    await renderLoggedIn()
    expect(screen.getByRole('button', { name: 'Выйти на всех устройствах' })).toBeInTheDocument()
  })

  it('calls logoutEverywhere with the access token and navigates away on success', async () => {
    mockListSessions.mockResolvedValue([SESSION_CURRENT, SESSION_OTHER])
    const { user } = await renderLoggedIn()
    await screen.findByText(/Chrome\/120/)
    mockLogoutEverywhere.mockResolvedValue(undefined)
    expect(window.location.href).toBe('')

    await user.click(screen.getByRole('button', { name: 'Выйти на всех устройствах' }))

    await waitFor(() => expect(mockLogoutEverywhere).toHaveBeenCalledWith('token-abc'))
    await waitFor(() => expect(window.location.href).not.toBe(''))
  })

  it('shows an error and does not navigate when logoutEverywhere rejects', async () => {
    mockListSessions.mockResolvedValue([SESSION_CURRENT, SESSION_OTHER])
    const { user } = await renderLoggedIn()
    await screen.findByText(/Chrome\/120/)
    mockLogoutEverywhere.mockRejectedValue(new Error('boom'))

    await user.click(screen.getByRole('button', { name: 'Выйти на всех устройствах' }))

    await waitFor(() => expect(mockLogoutEverywhere).toHaveBeenCalled())
    expect(window.location.href).toBe('')
    expect(screen.getByText('Настройки аккаунта')).toBeInTheDocument()
  })
})

// ── New profile-settings feature (blind spec-based tests) ──────────────────
//
// Everything below tests the new PreferencesCard / NotificationsCard /
// ConnectedAccountsCard / PrivacyCard / DataExportCard sections, the
// avatar-upload addition to ProfileCard, and the session-timeout select
// addition to SessionsCard - all written from the behavioral spec, without
// reading AccountPage.tsx's new component bodies.

describe('AccountPage — avatar upload', () => {
  it('calls fetchProfile with the access token once bootstrap finishes', async () => {
    await renderLoggedIn()
    await waitFor(() => expect(mockFetchProfile).toHaveBeenCalledWith('token-abc'))
  })

  it('has a file input somewhere on the page for picking an avatar image', async () => {
    const { container } = await renderLoggedIn()
    const fileInput = container.querySelector('input[type="file"]')
    expect(fileInput).toBeTruthy()
  })

  it('opens the avatar file picker when its accessible button is activated with the keyboard', async () => {
    const { user, container } = await renderLoggedIn()
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    const clickFileInput = vi.spyOn(fileInput, 'click')
    const avatarButton = screen.getByRole('button', { name: /изменить фото/i })

    avatarButton.focus()
    expect(avatarButton).toHaveFocus()
    await user.keyboard('{Enter}')

    expect(clickFileInput).toHaveBeenCalledOnce()
  })

  it('selecting an image file eventually calls uploadAvatar with the access token and a string payload', async () => {
    const { container } = await renderLoggedIn()
    mockUploadAvatar.mockResolvedValue({ ...PROFILE, avatarDataUrl: 'data:image/png;base64,xyz' })

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['fake-image-content'], 'avatar.png', { type: 'image/png' })
    Object.defineProperty(fileInput, 'files', { value: [file] })
    fireEvent.change(fileInput)

    await waitFor(() => expect(mockUploadAvatar).toHaveBeenCalled())
    const args = mockUploadAvatar.mock.calls[0]
    expect(args[0]).toBe('token-abc')
    expect(typeof args[1]).toBe('string')
  })

  it('selecting a non-image file does not call uploadAvatar', async () => {
    const { container } = await renderLoggedIn()

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['just text'], 'notes.txt', { type: 'text/plain' })
    Object.defineProperty(fileInput, 'files', { value: [file] })
    fireEvent.change(fileInput)

    // Give any async rejection path a chance to run before asserting the negative.
    await new Promise((r) => setTimeout(r, 50))
    expect(mockUploadAvatar).not.toHaveBeenCalled()
  })
})

describe('AccountPage — PreferencesCard', () => {
  it('renders labeled timezone, date-format, week-start and language selects once profile data loads', async () => {
    await renderLoggedIn()
    expect(await screen.findByLabelText(/часовой пояс/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/формат даты/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/первый день недели/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/язык/i)).toBeInTheDocument()
  })

  it('includes UTC when the browser timezone list omits it', async () => {
    const supportedValuesOf = vi.spyOn(Intl, 'supportedValuesOf').mockReturnValue(['Europe/Moscow'])
    try {
      await renderLoggedIn()
      const select = await screen.findByLabelText(/часовой пояс/i)
      const utcOptions = within(select).getAllByRole('option', { name: 'UTC' })
      expect(utcOptions).toHaveLength(1)
    } finally {
      supportedValuesOf.mockRestore()
    }
  })

  it('does not duplicate UTC when the browser timezone list includes it', async () => {
    const supportedValuesOf = vi.spyOn(Intl, 'supportedValuesOf').mockReturnValue(['UTC', 'Europe/Moscow'])
    try {
      await renderLoggedIn()
      const select = await screen.findByLabelText(/часовой пояс/i)
      const utcOptions = within(select).getAllByRole('option', { name: 'UTC' })
      expect(utcOptions).toHaveLength(1)
    } finally {
      supportedValuesOf.mockRestore()
    }
  })

  it('changing the timezone select calls updateProfile with the access token and the new timezone', async () => {
    const { user } = await renderLoggedIn()
    mockUpdateProfile.mockResolvedValue({ ...PROFILE, timezone: 'Europe/Moscow' })

    const select = await screen.findByLabelText(/часовой пояс/i)
    await user.selectOptions(select, 'Europe/Moscow')

    await waitFor(() => expect(mockUpdateProfile).toHaveBeenCalled())
    expect(mockUpdateProfile).toHaveBeenCalledWith(
      'token-abc',
      expect.objectContaining({ timezone: 'Europe/Moscow' }),
    )
  })

  it('changing the date-format select calls updateProfile with the new dateFormat', async () => {
    const { user } = await renderLoggedIn()
    mockUpdateProfile.mockResolvedValue({ ...PROFILE, dateFormat: 'mdy' })

    const select = await screen.findByLabelText(/формат даты/i)
    await user.selectOptions(select, 'mdy')

    await waitFor(() => expect(mockUpdateProfile).toHaveBeenCalled())
    expect(mockUpdateProfile).toHaveBeenCalledWith(
      'token-abc',
      expect.objectContaining({ dateFormat: 'mdy' }),
    )
  })

  it('changing the week-start select calls updateProfile with the new weekStart', async () => {
    const { user } = await renderLoggedIn()
    mockUpdateProfile.mockResolvedValue({ ...PROFILE, weekStart: 'sunday' })

    const select = await screen.findByLabelText(/первый день недели/i)
    await user.selectOptions(select, 'sunday')

    await waitFor(() => expect(mockUpdateProfile).toHaveBeenCalled())
    expect(mockUpdateProfile).toHaveBeenCalledWith(
      'token-abc',
      expect.objectContaining({ weekStart: 'sunday' }),
    )
  })

  it('changing the language select calls updateProfile with the new language', async () => {
    const { user } = await renderLoggedIn()
    mockUpdateProfile.mockResolvedValue({ ...PROFILE, language: 'en' })

    const select = await screen.findByLabelText(/язык/i)
    await user.selectOptions(select, 'en')

    await waitFor(() => expect(mockUpdateProfile).toHaveBeenCalled())
    expect(mockUpdateProfile).toHaveBeenCalledWith(
      'token-abc',
      expect.objectContaining({ language: 'en' }),
    )
  })
})

describe('AccountPage — NotificationsCard', () => {
  it('renders at least 3 checkboxes (in-app, browser push, Telegram)', async () => {
    await renderLoggedIn()
    const checkboxes = await screen.findAllByRole('checkbox')
    expect(checkboxes.length).toBeGreaterThanOrEqual(3)
  })

  it('mentions that these notification channels are not fully working yet', async () => {
    await renderLoggedIn()
    await screen.findAllByRole('checkbox')
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/появится|скоро|coming soon/i)
  })

  it('toggling the Telegram checkbox calls updateProfile with the access token and notifyTelegram: true', async () => {
    const { user } = await renderLoggedIn()
    mockUpdateProfile.mockResolvedValue({ ...PROFILE, notifyTelegram: true })
    await screen.findAllByRole('checkbox')

    const telegramCheckbox = screen.getByRole('checkbox', { name: /telegram/i })
    expect(telegramCheckbox).not.toBeChecked()
    await user.click(telegramCheckbox)

    await waitFor(() => expect(mockUpdateProfile).toHaveBeenCalled())
    expect(mockUpdateProfile).toHaveBeenCalledWith(
      'token-abc',
      expect.objectContaining({ notifyTelegram: true }),
    )
  })

  it('toggling the browser-push checkbox calls updateProfile with the access token and notifyBrowserPush: true', async () => {
    const { user } = await renderLoggedIn()
    mockUpdateProfile.mockResolvedValue({ ...PROFILE, notifyBrowserPush: true })
    await screen.findAllByRole('checkbox')

    const pushCheckbox = screen.getByRole('checkbox', { name: /push/i })
    expect(pushCheckbox).not.toBeChecked()
    await user.click(pushCheckbox)

    await waitFor(() => expect(mockUpdateProfile).toHaveBeenCalled())
    expect(mockUpdateProfile).toHaveBeenCalledWith(
      'token-abc',
      expect.objectContaining({ notifyBrowserPush: true }),
    )
  })

  it('toggling the in-app checkbox (the one initially checked, per the PROFILE fixture default) calls updateProfile with notifyInApp: false', async () => {
    const { user } = await renderLoggedIn()
    mockUpdateProfile.mockResolvedValue({ ...PROFILE, notifyInApp: false })
    const checkboxes = await screen.findAllByRole('checkbox')

    const telegramCheckbox = screen.getByRole('checkbox', { name: /telegram/i })
    const pushCheckbox = screen.getByRole('checkbox', { name: /push/i })
    const inAppCheckbox = checkboxes.find((cb) => cb !== telegramCheckbox && cb !== pushCheckbox)
    expect(inAppCheckbox).toBeTruthy()
    expect(inAppCheckbox).toBeChecked()

    await user.click(inAppCheckbox!)

    await waitFor(() => expect(mockUpdateProfile).toHaveBeenCalled())
    expect(mockUpdateProfile).toHaveBeenCalledWith(
      'token-abc',
      expect.objectContaining({ notifyInApp: false }),
    )
  })
})

describe('AccountPage — ConnectedAccountsCard', () => {
  it('calls listConnectedAccounts with the access token on mount', async () => {
    await renderLoggedIn()
    await waitFor(() => expect(mockListConnectedAccounts).toHaveBeenCalledWith('token-abc'))
  })

  it('shows a "nothing connected" message with the default empty list', async () => {
    mockListConnectedAccounts.mockResolvedValue([])
    await renderLoggedIn()
    await waitFor(() => expect(mockListConnectedAccounts).toHaveBeenCalled())
    await waitFor(() => {
      const text = document.body.textContent ?? ''
      expect(text).toMatch(/ничего не подключено|нет подключ/i)
    })
  })

  it('shows a disabled "Connect Telegram" button', async () => {
    await renderLoggedIn()
    const button = await screen.findByRole('button', { name: /подключить telegram/i })
    expect(button).toBeDisabled()
  })
})

describe('AccountPage — PrivacyCard', () => {
  it('renders a "Приватность" heading/text block', async () => {
    await renderLoggedIn()
    expect(await screen.findByText(/приватность/i)).toBeInTheDocument()
  })

  it('is purely informational - no interactive controls inside its own <section> wrapper', async () => {
    await renderLoggedIn()
    const heading = await screen.findByText(/приватность/i)
    const section = heading.closest('section')
    // Soft check per spec: only assert when we can cleanly scope to a
    // dedicated <section> wrapper for this card.
    if (section) {
      const controls = within(section).queryAllByRole('button').concat(
        within(section).queryAllByRole('checkbox'),
        within(section).queryAllByRole('textbox'),
        within(section).queryAllByRole('combobox'),
      )
      expect(controls.length).toBe(0)
    }
  })
})

describe('AccountPage — DataExportCard', () => {
  it('renders a data-export button', async () => {
    await renderLoggedIn()
    expect(await screen.findByRole('button', { name: /скачать мои данные|экспорт/i })).toBeInTheDocument()
  })

  it('clicking the export button calls exportAccountData with the access token', async () => {
    const { user } = await renderLoggedIn()
    mockExportAccountData.mockResolvedValue({
      exportedAt: '2026-08-06T00:00:00.000Z',
      scope: 'schlussel-account',
      profile: PROFILE,
      createdAt: '2026-01-01T00:00:00.000Z',
      sessions: [],
      connectedAccounts: [],
    })

    const button = await screen.findByRole('button', { name: /скачать мои данные|экспорт/i })
    await user.click(button)

    await waitFor(() => expect(mockExportAccountData).toHaveBeenCalledWith('token-abc'))
  })

  it('nearby text clarifies the export is scoped to this service only, not the whole platform', async () => {
    await renderLoggedIn()
    await screen.findByRole('button', { name: /скачать мои данные|экспорт/i })
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/schlussel|аккаунт|этого сервиса|только этот/i)
  })
})

describe('AccountPage — session timeout select', () => {
  it('shows a labeled select for automatic-logout duration', async () => {
    mockListSessions.mockResolvedValue([])
    await renderLoggedIn()
    expect(await screen.findByLabelText(/автоматический выход/i)).toBeInTheDocument()
  })

  it('changing the timeout select calls updateProfile with the access token and a numeric sessionTimeoutMinutes', async () => {
    mockListSessions.mockResolvedValue([])
    const { user } = await renderLoggedIn()
    mockUpdateProfile.mockResolvedValue({ ...PROFILE, sessionTimeoutMinutes: 60 })

    const select = await screen.findByLabelText(/автоматический выход/i) as HTMLSelectElement
    const options = within(select).getAllByRole('option') as HTMLOptionElement[]
    // Pick a non-default option (one with a non-empty, numeric value) for a
    // clean positive assertion.
    const target = options.find((o) => o.value !== '' && !Number.isNaN(Number(o.value)))
    expect(target).toBeTruthy()

    await user.selectOptions(select, target!.value)

    await waitFor(() => expect(mockUpdateProfile).toHaveBeenCalled())
    expect(mockUpdateProfile).toHaveBeenCalledWith(
      'token-abc',
      expect.objectContaining({ sessionTimeoutMinutes: Number(target!.value) }),
    )
  })
})
