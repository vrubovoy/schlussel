import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { UserEvent } from '@testing-library/user-event'

const mockRefreshSession = vi.fn()
const mockFetchMe = vi.fn()
const mockFetchAdminStats = vi.fn()
const mockListAdminUsers = vi.fn()
const mockListInvites = vi.fn()
const mockCreateInvite = vi.fn()
const mockChangeUserRole = vi.fn()
const mockForceLogoutUser = vi.fn()
const mockDeleteUserAsAdmin = vi.fn()
const mockRevokeInvite = vi.fn()

vi.mock('../lib/api', () => ({
  refreshSession: (...args: unknown[]) => mockRefreshSession(...args),
  fetchMe: (...args: unknown[]) => mockFetchMe(...args),
  fetchAdminStats: (...args: unknown[]) => mockFetchAdminStats(...args),
  listAdminUsers: (...args: unknown[]) => mockListAdminUsers(...args),
  listInvites: (...args: unknown[]) => mockListInvites(...args),
  createInvite: (...args: unknown[]) => mockCreateInvite(...args),
  changeUserRole: (...args: unknown[]) => mockChangeUserRole(...args),
  forceLogoutUser: (...args: unknown[]) => mockForceLogoutUser(...args),
  deleteUserAsAdmin: (...args: unknown[]) => mockDeleteUserAsAdmin(...args),
  revokeInvite: (...args: unknown[]) => mockRevokeInvite(...args),
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
  window.location = { ...original, search, href: '', pathname: '/admin' }
  const mod = await import('../features/admin/AdminPage')
  return { AdminPage: mod.AdminPage }
}

const ADMIN_USER = { id: 'admin1', email: 'admin@example.com', name: 'Admin User', role: 'admin' }
const PLAIN_USER = { id: 'user1', email: 'plain@example.com', name: 'Plain User', role: 'user' }

const STATS = {
  totalUsers: 42,
  totalActiveSessions: 7,
  pendingInvites: 2,
  newUsersLast30d: 5,
  registrationsByDay: [
    { date: '2026-07-20', count: 1 },
    { date: '2026-07-21', count: 2 },
  ],
}

const USERS = [
  { id: 'u1', email: 'alice@example.com', name: 'Alice A', role: 'user', createdAt: '2026-01-01T00:00:00.000Z', activeSessionCount: 1 },
  { id: 'u2', email: 'bob@example.com', name: 'Bob B', role: 'admin', createdAt: '2026-01-02T00:00:00.000Z', activeSessionCount: 2 },
  { id: 'u3', email: 'carol@example.com', name: 'Carol C', role: 'user', createdAt: '2026-01-03T00:00:00.000Z', activeSessionCount: 0 },
]

const INVITE_PENDING = {
  id: 'inv1',
  createdByName: 'Admin One',
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-02-01T00:00:00.000Z',
  revokedAt: null,
  usedAt: null,
  usedByName: null,
  usedByEmail: null,
  status: 'pending' as const,
}
const INVITE_USED = {
  id: 'inv2',
  createdByName: 'Admin Two',
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-02-01T00:00:00.000Z',
  revokedAt: null,
  usedAt: '2026-01-05T00:00:00.000Z',
  usedByName: 'Someone Registered',
  usedByEmail: 'usedinvite@example.com',
  status: 'used' as const,
}
const INVITES = [INVITE_PENDING, INVITE_USED]

async function renderAsAdmin(opts?: {
  users?: typeof USERS
  invites?: typeof INVITES
  stats?: typeof STATS
}) {
  mockRefreshSession.mockResolvedValue({ accessToken: 'token-abc' })
  mockFetchMe.mockResolvedValue(ADMIN_USER)
  mockFetchAdminStats.mockResolvedValue(opts?.stats ?? STATS)
  mockListAdminUsers.mockResolvedValue(opts?.users ?? USERS)
  mockListInvites.mockResolvedValue(opts?.invites ?? INVITES)
  const { AdminPage } = await setLocation('')
  const user = userEvent.setup()
  render(<AdminPage />)
  // Wait for some admin-only content to show up before returning control.
  await screen.findByText(/alice@example\.com/)
  return { user }
}

beforeEach(() => {
  mockRefreshSession.mockReset()
  mockFetchMe.mockReset()
  mockFetchAdminStats.mockReset()
  mockListAdminUsers.mockReset()
  mockListInvites.mockReset()
  mockCreateInvite.mockReset()
  mockChangeUserRole.mockReset()
  mockForceLogoutUser.mockReset()
  mockDeleteUserAsAdmin.mockReset()
  mockRevokeInvite.mockReset()
})

// Climbs from a text node up the DOM until the ancestor contains at least
// `minButtons` <button> elements - a generic way to find "the row" for a
// given piece of text without knowing the exact table/list markup.
function climbToRowWithButtons(text: string | RegExp, minButtons: number): HTMLElement {
  let el: HTMLElement = screen.getByText(text)
  for (let i = 0; i < 12 && el.parentElement; i++) {
    if (el.querySelectorAll('button').length >= minButtons) return el
    el = el.parentElement
  }
  return el
}

// Climbs a fixed number of ancestor levels to capture surrounding row
// context for a piece of text, without requiring buttons to be present
// (used for invite rows, some of which have no action buttons at all).
function rowAround(text: string | RegExp, levels = 3): HTMLElement {
  let el: HTMLElement = screen.getByText(text)
  for (let i = 0; i < levels && el.parentElement; i++) el = el.parentElement
  return el
}

// Clicks `target`, then - if this design system's shared Modal component
// (role="dialog", rightmost/last action button is primary) appears as a
// result - clicks its primary action too. If no dialog appears, this is a
// no-op beyond the initial click, covering implementations with no
// confirmation step at all.
async function clickAndConfirm(user: UserEvent, target: HTMLElement) {
  await user.click(target)
  let dialog: HTMLElement | null = null
  try {
    dialog = await screen.findByRole('dialog', {}, { timeout: 300 })
  } catch {
    dialog = null
  }
  if (dialog) {
    const buttons = within(dialog)
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-label') !== 'Закрыть')
    if (buttons.length > 0) {
      await user.click(buttons[buttons.length - 1]!)
    }
  }
}

describe('AdminPage — session bootstrap', () => {
  it('renders a blank loading state with no heading or admin content while the bootstrap is pending', async () => {
    mockRefreshSession.mockReturnValue(new Promise(() => {}))
    const { AdminPage } = await setLocation('')
    render(<AdminPage />)
    expect(screen.queryByText(/администратор/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/alice@example\.com/)).not.toBeInTheDocument()
  })

  it('calls refreshSession then fetchMe with the resulting access token', async () => {
    mockRefreshSession.mockResolvedValue({ accessToken: 'tok-xyz' })
    mockFetchMe.mockResolvedValue(ADMIN_USER)
    mockFetchAdminStats.mockResolvedValue(STATS)
    mockListAdminUsers.mockResolvedValue(USERS)
    mockListInvites.mockResolvedValue(INVITES)
    const { AdminPage } = await setLocation('')
    render(<AdminPage />)
    await screen.findByText(/alice@example\.com/)
    expect(mockFetchMe).toHaveBeenCalledWith('tok-xyz')
  })
})

describe('AdminPage — access denied for non-admin users', () => {
  it('shows an access-denied indicator and no admin content when the resolved user has role "user"', async () => {
    mockRefreshSession.mockResolvedValue({ accessToken: 'tok' })
    mockFetchMe.mockResolvedValue(PLAIN_USER)
    mockFetchAdminStats.mockResolvedValue(STATS)
    mockListAdminUsers.mockResolvedValue(USERS)
    mockListInvites.mockResolvedValue(INVITES)
    const { AdminPage } = await setLocation('')
    render(<AdminPage />)

    await screen.findAllByText(/администратор/i)
    expect(screen.queryByText(/alice@example\.com/)).not.toBeInTheDocument()
    expect(screen.queryByText(/bob@example\.com/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Admin One/)).not.toBeInTheDocument()
  })
})

describe('AdminPage — admin content on load', () => {
  it('fetches stats, users and invites with the access token once bootstrap resolves as admin', async () => {
    await renderAsAdmin()
    expect(mockFetchAdminStats).toHaveBeenCalledWith('token-abc')
    expect(mockListAdminUsers).toHaveBeenCalledWith('token-abc')
    expect(mockListInvites).toHaveBeenCalledWith('token-abc')
  })

  it('renders the fetched users emails and names', async () => {
    await renderAsAdmin()
    expect(screen.getByText(/alice@example\.com/)).toBeInTheDocument()
    expect(screen.getByText(/bob@example\.com/)).toBeInTheDocument()
    expect(screen.getByText(/carol@example\.com/)).toBeInTheDocument()
    expect(screen.getByText('Alice A')).toBeInTheDocument()
    expect(screen.getByText('Bob B')).toBeInTheDocument()
  })

  it('renders a distinguishing marker between a pending and a used invite row', async () => {
    await renderAsAdmin()
    const pendingRow = rowAround(/Admin One/)
    const usedRow = rowAround(/Admin Two/)
    expect(pendingRow.textContent).not.toBe(usedRow.textContent)
    expect(usedRow.textContent ?? '').toMatch(/Someone Registered/i)
    expect(pendingRow.textContent ?? '').not.toMatch(/Someone Registered/i)
  })

  it('renders a link referencing /docs once the admin view has loaded', async () => {
    await renderAsAdmin()
    const link = Array.from(document.querySelectorAll('a')).find((a) =>
      (a.getAttribute('href') ?? '').includes('/docs'),
    )
    expect(link).toBeTruthy()
  })
})

describe('AdminPage — create invite', () => {
  it('calls createInvite with the access token when the create-invite control is clicked, and shows the returned code afterward', async () => {
    const { user } = await renderAsAdmin()
    mockCreateInvite.mockResolvedValue({
      id: 'newinv',
      code: 'test-invite-code-123',
      createdAt: '2026-07-27T00:00:00.000Z',
      expiresAt: '2026-08-27T00:00:00.000Z',
    })

    const createButton = screen.getByRole('button', { name: /созда|приглаш/i })
    // Deliberately NOT using clickAndConfirm here: the success surface that
    // shows the code is itself presented in a dialog-like element, and a
    // generic "click the primary action" helper could dismiss it before we
    // get to assert on it.
    await user.click(createButton)

    await waitFor(() => expect(mockCreateInvite).toHaveBeenCalled())
    expect(mockCreateInvite.mock.calls[0]?.[0]).toBe('token-abc')

    // The code may be shown as visible text OR as the value of a (readonly)
    // link input - check both.
    const bodyText = document.body.textContent ?? ''
    const inputWithCode = Array.from(document.querySelectorAll('input')).find((i) =>
      i.value.includes('test-invite-code-123'),
    )
    expect(bodyText.includes('test-invite-code-123') || !!inputWithCode).toBe(true)
  })
})

describe('AdminPage — change user role', () => {
  it('promotes a "user" row to admin, calling changeUserRole with that user id and the opposite role', async () => {
    const { user } = await renderAsAdmin()
    mockChangeUserRole.mockResolvedValue({ ...USERS[0], role: 'admin' })

    const row = climbToRowWithButtons(/alice@example\.com/, 2)
    const buttons = within(row).getAllByRole('button')
    const roleButton = buttons.find(
      (b) => !/удал/i.test(b.textContent ?? '') && !/выход|сесс|разлогин|заверш/i.test(b.textContent ?? ''),
    )
    expect(
      roleButton,
      `expected a role-change button among: ${buttons.map((b) => b.textContent).join(', ')}`,
    ).toBeTruthy()

    await clickAndConfirm(user, roleButton!)

    expect(mockChangeUserRole).toHaveBeenCalledWith('token-abc', 'u1', 'admin')
  })
})

describe('AdminPage — force logout user', () => {
  it('calls forceLogoutUser with the access token and the user id', async () => {
    const { user } = await renderAsAdmin()
    mockForceLogoutUser.mockResolvedValue(undefined)

    const row = climbToRowWithButtons(/bob@example\.com/, 2)
    const buttons = within(row).getAllByRole('button')
    const logoutButton = buttons.find((b) => /выход|сесс|разлогин|заверш/i.test(b.textContent ?? ''))
    expect(
      logoutButton,
      `expected a force-logout button among: ${buttons.map((b) => b.textContent).join(', ')}`,
    ).toBeTruthy()

    await clickAndConfirm(user, logoutButton!)

    expect(mockForceLogoutUser).toHaveBeenCalledWith('token-abc', 'u2')
  })
})

describe('AdminPage — delete user', () => {
  it('surfaces a password input before calling deleteUserAsAdmin, and calls it with the typed password on confirm', async () => {
    const { user } = await renderAsAdmin()
    mockDeleteUserAsAdmin.mockResolvedValue(undefined)

    const row = climbToRowWithButtons(/carol@example\.com/, 2)
    const buttons = within(row).getAllByRole('button')
    const deleteButton = buttons.find((b) => /удал/i.test(b.textContent ?? ''))
    expect(
      deleteButton,
      `expected a delete button among: ${buttons.map((b) => b.textContent).join(', ')}`,
    ).toBeTruthy()

    await user.click(deleteButton!)

    const passwordInput = await screen.findByLabelText(/пароль/i).catch(() => null)
    const input = (passwordInput ?? document.querySelector('input[type="password"]')) as HTMLInputElement | null
    expect(input, 'expected a password input to appear before confirming user deletion').toBeTruthy()
    await user.type(input!, 'admin-own-password')

    const confirmCandidates = screen
      .getAllByRole('button')
      .filter((b) => b !== deleteButton && /удал|подтверд/i.test(b.textContent ?? ''))
    expect(
      confirmCandidates.length,
      'expected a confirm button distinct from the row delete button after typing the password',
    ).toBeGreaterThan(0)
    await user.click(confirmCandidates[confirmCandidates.length - 1]!)

    await waitFor(() => expect(mockDeleteUserAsAdmin).toHaveBeenCalledWith('token-abc', 'u3', 'admin-own-password'))
  })

  it('shows an error indication and does not proceed when deleteUserAsAdmin rejects with a 401', async () => {
    const { user } = await renderAsAdmin()
    const ApiError = (await import('../lib/api')).ApiError
    mockDeleteUserAsAdmin.mockRejectedValue(new ApiError(401, 'Invalid password'))

    const row = climbToRowWithButtons(/carol@example\.com/, 2)
    const buttons = within(row).getAllByRole('button')
    const deleteButton = buttons.find((b) => /удал/i.test(b.textContent ?? ''))!
    await user.click(deleteButton)

    const passwordInput = await screen.findByLabelText(/пароль/i).catch(() => null)
    const input = (passwordInput ?? document.querySelector('input[type="password"]')) as HTMLInputElement | null
    expect(input).toBeTruthy()
    await user.type(input!, 'wrong-password')

    const confirmCandidates = screen
      .getAllByRole('button')
      .filter((b) => b !== deleteButton && /удал|подтверд/i.test(b.textContent ?? ''))
    await user.click(confirmCandidates[confirmCandidates.length - 1]!)

    await waitFor(() => expect(mockDeleteUserAsAdmin).toHaveBeenCalled())
    // Some visible error indication - loose assertion by design.
    await waitFor(() => {
      const bodyText = document.body.textContent ?? ''
      expect(bodyText).toMatch(/ошибк|неверн|401|не удал/i)
    })
  })
})

describe('AdminPage — revoke invite', () => {
  it('calls revokeInvite with the access token and the pending invite id', async () => {
    const { user } = await renderAsAdmin()
    mockRevokeInvite.mockResolvedValue(undefined)

    const row = climbToRowWithButtons(/Admin One/, 1)
    const buttons = within(row).getAllByRole('button')
    const revokeButton = buttons.find((b) => /отозв|аннулир|revoke|отмен/i.test(b.textContent ?? ''))
    expect(
      revokeButton,
      `expected a revoke button among: ${buttons.map((b) => b.textContent).join(', ')}`,
    ).toBeTruthy()

    await clickAndConfirm(user, revokeButton!)

    expect(mockRevokeInvite).toHaveBeenCalledWith('token-abc', 'inv1')
  })
})
