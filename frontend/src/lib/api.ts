export interface AuthUser {
  id: string
  email: string
  name: string
  role: 'admin' | 'user'
}

export type DateFormat = 'dmy' | 'mdy' | 'ymd'
export type WeekStart = 'monday' | 'sunday'
export type Language = 'ru' | 'en'

export interface Profile extends AuthUser {
  avatarDataUrl: string | null
  timezone: string | null
  dateFormat: DateFormat | null
  weekStart: WeekStart | null
  language: Language | null
  notifyInApp: boolean
  notifyBrowserPush: boolean
  notifyTelegram: boolean
  sessionTimeoutMinutes: number | null
}

// All optional, `null` explicitly clears a field back to "unset" (the
// frontend's own display default takes over) - an absent key leaves it
// untouched. Mirrors PATCH /auth/profile's own body shape exactly.
export interface ProfileUpdate {
  timezone?: string | null
  dateFormat?: DateFormat | null
  weekStart?: WeekStart | null
  language?: Language | null
  notifyInApp?: boolean
  notifyBrowserPush?: boolean
  notifyTelegram?: boolean
  sessionTimeoutMinutes?: number | null
}

export interface ConnectedAccount {
  id: string
  provider: 'telegram'
  externalUsername: string | null
  connectedAt: string
}

export interface AccountExport {
  exportedAt: string
  scope: string
  profile: Profile
  createdAt: string
  sessions: { userAgent: string | null; ipAddress: string | null; createdAt: string; expiresAt: string }[]
  connectedAccounts: { provider: string; externalUsername: string | null; connectedAt: string }[]
}

export type ExportJobStatus = 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'expired'

export interface ExportJob {
  id: string
  status: ExportJobStatus
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  expiresAt: string | null
  downloadUrl: string | null
  error: string | null
  services: Array<{
    service: 'schlussel' | 'kuvert' | 'tafel' | 'zettel' | 'glocke'
    status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
    attempts: number
    bytes: number | null
    sha256: string | null
    error: string | null
  }>
}

interface LoginResponse {
  code: string
}

interface TokenResponse {
  accessToken: string
  user: AuthUser
}

interface RefreshResponse {
  accessToken: string
}

export interface Session {
  id: string
  userAgent: string | null
  ipAddress: string | null
  createdAt: string
  expiresAt: string
  current: boolean
}

export type InviteStatus = 'pending' | 'used' | 'expired' | 'revoked'

export interface Invite {
  id: string
  createdByName: string | null
  createdAt: string
  expiresAt: string
  revokedAt: string | null
  usedAt: string | null
  usedByName: string | null
  usedByEmail: string | null
  status: InviteStatus
}

export interface CreatedInvite {
  id: string
  code: string
  createdAt: string
  expiresAt: string
}

export interface AdminUser {
  id: string
  email: string
  name: string
  role: 'admin' | 'user'
  createdAt: string
  activeSessionCount: number
}

export interface AdminStats {
  totalUsers: number
  totalActiveSessions: number
  pendingInvites: number
  newUsersLast30d: number
  registrationsByDay: { date: string; count: number }[]
}

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/auth${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => null) as { error?: string } | null
    throw new ApiError(res.status, data?.error ?? 'Request failed')
  }
  return res.json() as Promise<T>
}

// Shared by every /auth call the account page makes once it holds a real
// access token (GET /me, PATCH /password, DELETE /account) - unlike
// login/register, these carry a Bearer header instead of (or alongside)
// the session cookie.
async function authed<T>(method: string, path: string, accessToken: string, body?: unknown): Promise<T> {
  const res = await fetch(`/auth${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => null) as { error?: string } | null
    throw new ApiError(res.status, data?.error ?? 'Request failed')
  }
  return res.json() as Promise<T>
}

// Plain silent-session check, no PKCE involved - used by the account page
// to detect an existing schlussel cookie session on mount, exactly like
// every consumer app's own background refresh (see e.g. kuvert's
// useAuthProvider), just without the codeChallenge branch since this
// never has to hand a token across an origin boundary.
let refreshSessionFlight: Promise<RefreshResponse> | null = null

export function refreshSession(): Promise<RefreshResponse> {
  if (refreshSessionFlight) return refreshSessionFlight

  const refresh = post<RefreshResponse>('/refresh', {}).finally(() => {
    if (refreshSessionFlight === refresh) refreshSessionFlight = null
  })
  refreshSessionFlight = refresh
  return refresh
}

export function fetchMe(accessToken: string): Promise<AuthUser> {
  return authed<AuthUser>('GET', '/me', accessToken)
}

// Redeems the one-time code from schlussel's own login page (see
// AccountPage's bootstrap) the same way every other consumer app's own
// callback page does - returns the user directly, no separate /me
// round-trip needed.
export function exchangeCode(code: string, codeVerifier: string): Promise<TokenResponse> {
  return post<TokenResponse>('/token', { code, codeVerifier })
}

export function changePassword(accessToken: string, currentPassword: string, newPassword: string): Promise<{ ok: true }> {
  return authed('PATCH', '/password', accessToken, { currentPassword, newPassword })
}

export function deleteAccount(accessToken: string, password: string): Promise<{ ok: true }> {
  return authed('DELETE', '/account', accessToken, { password })
}

export function updateName(accessToken: string, name: string): Promise<AuthUser> {
  return authed<AuthUser>('PATCH', '/name', accessToken, { name })
}

export function fetchProfile(accessToken: string): Promise<Profile> {
  return authed<Profile>('GET', '/profile', accessToken)
}

export function updateProfile(accessToken: string, data: ProfileUpdate): Promise<Profile> {
  return authed<Profile>('PATCH', '/profile', accessToken, data)
}

export function uploadAvatar(accessToken: string, avatarDataUrl: string): Promise<Profile> {
  return authed<Profile>('PUT', '/avatar', accessToken, { avatarDataUrl })
}

export function deleteAvatar(accessToken: string): Promise<Profile> {
  return authed<Profile>('DELETE', '/avatar', accessToken)
}

export function listConnectedAccounts(accessToken: string): Promise<ConnectedAccount[]> {
  return authed<ConnectedAccount[]>('GET', '/connected-accounts', accessToken)
}

export function disconnectAccount(accessToken: string, id: string): Promise<{ ok: true }> {
  return authed('DELETE', `/connected-accounts/${id}`, accessToken)
}

export function exportAccountData(accessToken: string): Promise<AccountExport> {
  return authed<AccountExport>('GET', '/export', accessToken)
}

export function createExportJob(accessToken: string): Promise<ExportJob> {
  return authed<ExportJob>('POST', '/export-jobs', accessToken, {})
}

export function getExportJob(accessToken: string, id: string): Promise<ExportJob> {
  return authed<ExportJob>('GET', `/export-jobs/${id}`, accessToken)
}

export function retryExportJob(accessToken: string, id: string): Promise<ExportJob> {
  return authed<ExportJob>('POST', `/export-jobs/${id}/retry`, accessToken)
}

export function cancelExportJob(accessToken: string, id: string): Promise<ExportJob> {
  return authed<ExportJob>('DELETE', `/export-jobs/${id}`, accessToken)
}

export async function downloadExportJob(accessToken: string, id: string): Promise<Blob> {
  const response = await fetch(`/auth/export-jobs/${id}/download`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    credentials: 'include',
  })
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: string } | null
    throw new ApiError(response.status, data?.error ?? 'Request failed')
  }
  return response.blob()
}

export function listSessions(accessToken: string): Promise<Session[]> {
  return authed<Session[]>('GET', '/sessions', accessToken)
}

export function revokeSession(accessToken: string, id: string): Promise<{ ok: true }> {
  return authed('DELETE', `/sessions/${id}`, accessToken)
}

// "Выйти на всех устройствах" - unlike changePassword, this does not
// leave the calling browser's own session intact.
export function logoutEverywhere(accessToken: string): Promise<{ ok: true }> {
  return authed('DELETE', '/sessions', accessToken)
}

// PKCE handoff: the server issues a short-lived one-time code instead of
// a real token, so the token itself never has to travel through a URL.
export function login(email: string, password: string, codeChallenge: string): Promise<LoginResponse> {
  return post<LoginResponse>('/login', { email, password, codeChallenge, codeChallengeMethod: 'S256' })
}

// The register endpoint only returns the created user, not a session — log
// in right after so the caller gets the same { code } shape login()
// produces, letting both pages share one success/redirect path.
// inviteCode is required by the server for every registration except the
// platform's very first user.
export async function register(
  email: string,
  password: string,
  name: string,
  codeChallenge: string,
  inviteCode?: string,
): Promise<LoginResponse> {
  await post<AuthUser>('/register', { email, password, name, inviteCode })
  return login(email, password, codeChallenge)
}

// ── Admin ────────────────────────────────────────────────────────────────

export function createInvite(accessToken: string, expiresInDays?: number): Promise<CreatedInvite> {
  return authed<CreatedInvite>('POST', '/invites', accessToken, { expiresInDays })
}

export function listInvites(accessToken: string): Promise<Invite[]> {
  return authed<Invite[]>('GET', '/invites', accessToken)
}

export function revokeInvite(accessToken: string, id: string): Promise<{ ok: true }> {
  return authed('DELETE', `/invites/${id}`, accessToken)
}

export function listAdminUsers(accessToken: string): Promise<AdminUser[]> {
  return authed<AdminUser[]>('GET', '/admin/users', accessToken)
}

export function changeUserRole(accessToken: string, id: string, role: 'admin' | 'user'): Promise<AuthUser> {
  return authed<AuthUser>('PATCH', `/admin/users/${id}/role`, accessToken, { role })
}

export function forceLogoutUser(accessToken: string, id: string): Promise<{ ok: true }> {
  return authed('DELETE', `/admin/users/${id}/sessions`, accessToken)
}

export function deleteUserAsAdmin(accessToken: string, id: string, password: string): Promise<{ ok: true }> {
  return authed('DELETE', `/admin/users/${id}`, accessToken, { password })
}

export function fetchAdminStats(accessToken: string): Promise<AdminStats> {
  return authed<AdminStats>('GET', '/admin/stats', accessToken)
}

export function fetchOpenApiSpec(accessToken: string): Promise<Record<string, unknown>> {
  return authed<Record<string, unknown>>('GET', '/openapi.json', accessToken)
}
