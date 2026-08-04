import { useState, useEffect } from 'react'
import { KeyRound, Trash2, User as UserIcon, Monitor, ShieldCheck } from 'lucide-react'
import { Button, Field, Badge } from '@zudar107/schloss-ui'
import { generateCodeVerifier, generateCodeChallenge } from '../../lib/pkce'
import {
  refreshSession, fetchMe, exchangeCode, changePassword, deleteAccount, updateName,
  listSessions, revokeSession, logoutEverywhere, ApiError, type AuthUser, type Session,
} from '../../lib/api'
import { readReturnTo, DEFAULT_APP_URL, type ReturnToResult } from '../../lib/returnTo'
import { validateName, validatePassword, validatePasswordsMatch } from '../../lib/validation'
import { focusField, focusFirstError } from '../../lib/focusField'
import { PasswordField } from '../auth/PasswordField'
import { Header } from '../../components/Header'
import { Footer } from '../../components/Footer'

const CODE_VERIFIER_STORAGE_KEY = 'account_pkce_code_verifier'

// Sent to /login with return_to pointing right back at /account (carrying
// the ORIGINAL caller's own return_to along as a nested param, so the
// "back to app" link below still works after the round trip) - mirrors
// every consumer app's own buildSchluesselLoginUrl, just same-origin.
async function redirectToLogin(originalReturnTo: ReturnToResult) {
  const backParam = originalReturnTo.present && originalReturnTo.valid
    ? `?return_to=${encodeURIComponent(originalReturnTo.url)}`
    : ''
  const returnTo = `${window.location.origin}/account${backParam}`

  const verifier = generateCodeVerifier()
  sessionStorage.setItem(CODE_VERIFIER_STORAGE_KEY, verifier)
  const challenge = await generateCodeChallenge(verifier)

  const params = new URLSearchParams({
    return_to: returnTo,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  window.location.href = `/login?${params.toString()}`
}

// The single account settings page every Schloss service's header
// "Настройки" button links out to (see e.g. kuvert's
// buildSchluesselAccountUrl) - profile info plus the things that only
// make sense once, platform-wide, not per-service: password and account
// deletion. Per-service preferences (currency, theme, ...) stay in each
// service's own sidebar settings page.
export function AccountPage() {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [accessToken, setAccessTokenState] = useState('')
  const [backTo, setBackTo] = useState<ReturnToResult | null>(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    const initialReturnTo = readReturnTo()
    let cancelled = false

    async function bootstrap() {
      const params = new URLSearchParams(window.location.search)
      const code = params.get('code')
      history.replaceState(null, '', window.location.pathname)

      const verifier = sessionStorage.getItem(CODE_VERIFIER_STORAGE_KEY)
      sessionStorage.removeItem(CODE_VERIFIER_STORAGE_KEY)

      if (code && verifier) {
        try {
          const data = await exchangeCode(code, verifier)
          if (cancelled) return
          setAccessTokenState(data.accessToken)
          setUser(data.user)
          setBackTo(initialReturnTo)
          setChecking(false)
          return
        } catch {
          // Fall through to a plain silent-session check below - the
          // trusted login that just happened already left a fresh cookie
          // here regardless of whether this code redemption succeeded.
        }
      }

      try {
        const { accessToken: token } = await refreshSession()
        const me = await fetchMe(token)
        if (cancelled) return
        setAccessTokenState(token)
        setUser(me)
        setBackTo(initialReturnTo)
        setChecking(false)
      } catch {
        if (!cancelled) await redirectToLogin(initialReturnTo)
      }
    }

    void bootstrap()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleLogout() {
    window.location.href = '/logout'
  }

  if (checking || !user) {
    return <div style={{ minHeight: '100vh', background: 'var(--bg-base)' }} />
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Header user={{ name: user.name }} onLogout={handleLogout} />

      <div style={{ flex: 1, background: 'var(--bg-base)', padding: '2rem 1rem' }}>
        <div style={{ maxWidth: 480, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {backTo?.present && backTo.valid && (
            <a href={backTo.url} style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', textDecoration: 'none' }}>
              ← Назад
            </a>
          )}

          <div>
            <h1 style={{ margin: 0, fontSize: '1.375rem', fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
              Настройки аккаунта
            </h1>
            <p style={{ margin: '0.25rem 0 0', color: 'var(--text-muted)', fontSize: '0.8125rem' }}>
              Единые для всех сервисов платформы
            </p>
          </div>

          {user.role === 'admin' && <AdminShortcutCard />}

          <ProfileCard
            user={user}
            accessToken={accessToken}
            onNameChange={(name) => setUser((u) => (u ? { ...u, name } : u))}
          />
          <PasswordCard accessToken={accessToken} />
          <SessionsCard accessToken={accessToken} />
          <DangerZoneCard accessToken={accessToken} />
        </div>
      </div>

      <Footer />
    </div>
  )
}

// The one shortcut out of the account settings and into the admin-only
// surfaces (/admin, /docs) - neither is linked from anywhere else in the
// normal UI, so without this an admin has no way to discover them short
// of typing the URL. AdminPage links onward to /docs itself, so this
// only needs to point at /admin.
function AdminShortcutCard() {
  return (
    <div className="card" style={{ padding: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <ShieldCheck size={17} color="var(--text-secondary)" />
        <h2 style={{ margin: 0, fontSize: '0.9375rem', fontWeight: 600, color: 'var(--text-primary)' }}>Администрирование</h2>
      </div>
      <p style={{ margin: '0 0 1rem', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
        Пользователи, инвайты и документация API — доступно только администраторам.
      </p>
      <Button
        variant="secondary"
        onClick={() => { window.location.href = '/admin' }}
        style={{ padding: '0.5rem 0.875rem', fontSize: '0.8125rem' }}
      >
        Открыть админ-панель
      </Button>
    </div>
  )
}

interface ProfileCardProps {
  user: AuthUser
  accessToken: string
  onNameChange: (name: string) => void
}

function ProfileCard({ user, accessToken, onNameChange }: ProfileCardProps) {
  const [name, setName] = useState(user.name)
  const [nameError, setNameError] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setName(user.name)
  }, [user.name])

  const trimmed = name.trim()
  const dirty = trimmed.length > 0 && trimmed !== user.name

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setSuccess(false)

    const validationError = validateName(name)
    if (validationError) {
      setNameError(validationError)
      focusField('account-name')
      return
    }
    setNameError('')

    setLoading(true)
    try {
      const updated = await updateName(accessToken, trimmed)
      onNameChange(updated.name)
      setSuccess(true)
    } catch {
      setError('Не удалось сохранить имя')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="card" style={{ padding: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
        <UserIcon size={17} color="var(--text-secondary)" />
        <h2 style={{ margin: 0, fontSize: '0.9375rem', fontWeight: 600, color: 'var(--text-primary)' }}>Профиль</h2>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem', marginBottom: '1.125rem' }}>
        <div style={{
          width: 44, height: 44, borderRadius: '50%', flexShrink: 0,
          background: 'var(--accent)', color: '#fff', fontWeight: 700, fontSize: '1.0625rem',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {user.name.trim().charAt(0).toUpperCase()}
        </div>
        <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>{user.email}</div>
      </div>

      <form onSubmit={handleSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
        <Field
          id="account-name"
          label="Имя"
          value={name}
          onChange={(e) => { setName(e.target.value); setNameError('') }}
          required
          error={nameError}
        />

        {error && (
          <div style={{ padding: '0.625rem 0.75rem', background: 'var(--danger-muted)', border: '1px solid var(--danger)', borderRadius: 8, fontSize: '0.8125rem', color: 'var(--danger)' }}>
            {error}
          </div>
        )}
        {success && (
          <div style={{ padding: '0.625rem 0.75rem', background: 'var(--success-muted)', border: '1px solid var(--success)', borderRadius: 8, fontSize: '0.8125rem', color: 'var(--success)' }}>
            Имя сохранено.
          </div>
        )}

        <Button type="submit" variant="primary" disabled={loading || !dirty} style={{ justifyContent: 'center', padding: '0.625rem' }}>
          {loading ? 'Сохранение…' : 'Сохранить'}
        </Button>
      </form>
    </div>
  )
}

interface PasswordFieldErrors {
  currentPassword?: string
  newPassword?: string
  confirmPassword?: string
}

function PasswordCard({ accessToken }: { accessToken: string }) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [fieldErrors, setFieldErrors] = useState<PasswordFieldErrors>({})
  const [formError, setFormError] = useState('')
  const [success, setSuccess] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSuccess(false)
    setFormError('')

    const nextErrors: PasswordFieldErrors = {}
    const newPasswordError = validatePassword(newPassword)
    if (newPasswordError) nextErrors.newPassword = newPasswordError
    const matchError = validatePasswordsMatch(newPassword, confirmPassword)
    if (matchError) nextErrors.confirmPassword = matchError
    if (Object.keys(nextErrors).length > 0) {
      setFieldErrors(nextErrors)
      focusFirstError(nextErrors, { newPassword: 'account-new-password', confirmPassword: 'account-new-password-confirm' })
      return
    }
    setFieldErrors({})

    setLoading(true)
    try {
      await changePassword(accessToken, currentPassword, newPassword)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setSuccess(true)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setFieldErrors({ currentPassword: 'Неверный текущий пароль' })
        focusField('account-current-password')
      } else {
        setFormError('Не удалось изменить пароль')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="card" style={{ padding: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
        <KeyRound size={17} color="var(--text-secondary)" />
        <h2 style={{ margin: 0, fontSize: '0.9375rem', fontWeight: 600, color: 'var(--text-primary)' }}>Пароль</h2>
      </div>

      <form onSubmit={handleSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
        <PasswordField
          id="account-current-password"
          label="Текущий пароль"
          value={currentPassword}
          onChange={(v) => { setCurrentPassword(v); setFieldErrors((f) => ({ ...f, currentPassword: undefined })) }}
          autoComplete="current-password"
          error={fieldErrors.currentPassword}
        />
        <PasswordField
          id="account-new-password"
          label="Новый пароль"
          value={newPassword}
          onChange={(v) => { setNewPassword(v); setFieldErrors((f) => ({ ...f, newPassword: undefined })) }}
          placeholder="Минимум 8 символов"
          minLength={8}
          autoComplete="new-password"
          error={fieldErrors.newPassword}
        />
        <PasswordField
          id="account-new-password-confirm"
          label="Повторите новый пароль"
          value={confirmPassword}
          onChange={(v) => { setConfirmPassword(v); setFieldErrors((f) => ({ ...f, confirmPassword: undefined })) }}
          placeholder="Минимум 8 символов"
          minLength={8}
          autoComplete="new-password"
          error={fieldErrors.confirmPassword}
        />

        {formError && (
          <div style={{ padding: '0.625rem 0.75rem', background: 'var(--danger-muted)', border: '1px solid var(--danger)', borderRadius: 8, fontSize: '0.8125rem', color: 'var(--danger)' }}>
            {formError}
          </div>
        )}
        {success && (
          <div style={{ padding: '0.625rem 0.75rem', background: 'var(--success-muted)', border: '1px solid var(--success)', borderRadius: 8, fontSize: '0.8125rem', color: 'var(--success)' }}>
            Пароль изменён. Вы вышли из всех остальных сеансов.
          </div>
        )}

        <Button type="submit" variant="primary" disabled={loading} style={{ justifyContent: 'center', padding: '0.625rem' }}>
          {loading ? 'Сохранение…' : 'Изменить пароль'}
        </Button>
      </form>
    </div>
  )
}

function formatSessionDate(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function SessionsCard({ accessToken }: { accessToken: string }) {
  const [sessions, setSessions] = useState<Session[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [loggingOutEverywhere, setLoggingOutEverywhere] = useState(false)

  useEffect(() => {
    let cancelled = false
    listSessions(accessToken)
      .then((s) => { if (!cancelled) setSessions(s) })
      .catch(() => { if (!cancelled) setError('Не удалось загрузить список сессий') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => {
      cancelled = true
    }
  }, [accessToken])

  async function handleRevoke(id: string) {
    setError('')
    setRevokingId(id)
    try {
      await revokeSession(accessToken, id)
      setSessions((prev) => prev?.filter((s) => s.id !== id) ?? prev)
    } catch {
      setError('Не удалось завершить сессию')
    } finally {
      setRevokingId(null)
    }
  }

  async function handleLogoutEverywhere() {
    setError('')
    setLoggingOutEverywhere(true)
    try {
      await logoutEverywhere(accessToken)
      window.location.href = DEFAULT_APP_URL
    } catch {
      setError('Не удалось выйти на всех устройствах')
      setLoggingOutEverywhere(false)
    }
  }

  return (
    <div className="card" style={{ padding: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Monitor size={17} color="var(--text-secondary)" />
          <h2 style={{ margin: 0, fontSize: '0.9375rem', fontWeight: 600, color: 'var(--text-primary)' }}>Активные сессии</h2>
        </div>
        <Button
          variant="secondary"
          onClick={handleLogoutEverywhere}
          disabled={loggingOutEverywhere || !sessions}
          style={{ padding: '0.4rem 0.75rem', fontSize: '0.75rem' }}
        >
          {loggingOutEverywhere ? 'Выход…' : 'Выйти на всех устройствах'}
        </Button>
      </div>

      {error && (
        <div style={{ padding: '0.625rem 0.75rem', background: 'var(--danger-muted)', border: '1px solid var(--danger)', borderRadius: 8, fontSize: '0.8125rem', color: 'var(--danger)', marginBottom: '0.875rem' }}>
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>Загрузка…</div>
      ) : sessions === null ? null : sessions.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>Нет активных сессий</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
          {sessions.map((s) => (
            <div
              key={s.id}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem',
                padding: '0.625rem 0.75rem', border: '1px solid var(--border)', borderRadius: 8,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div
                  title={s.userAgent ?? undefined}
                  style={{
                    fontSize: '0.8125rem', color: 'var(--text-primary)', fontWeight: 500,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                >
                  {s.userAgent ?? 'Неизвестное устройство'}
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  {s.ipAddress ?? '—'} · {formatSessionDate(s.createdAt)}
                </div>
              </div>
              {s.current ? (
                <Badge variant="success">Это устройство</Badge>
              ) : (
                <Button
                  variant="ghost"
                  onClick={() => handleRevoke(s.id)}
                  disabled={revokingId === s.id}
                  style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem', flexShrink: 0 }}
                >
                  {revokingId === s.id ? 'Завершение…' : 'Завершить'}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function DangerZoneCard({ accessToken }: { accessToken: string }) {
  const [password, setPassword] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleDelete(e: React.FormEvent) {
    e.preventDefault()
    setPasswordError('')
    setLoading(true)
    try {
      await deleteAccount(accessToken, password)
      window.location.href = DEFAULT_APP_URL
    } catch (err) {
      setPasswordError(err instanceof ApiError && err.status === 401 ? 'Неверный пароль' : 'Не удалось удалить аккаунт')
      focusField('account-delete-password')
      setLoading(false)
    }
  }

  return (
    <div className="card" style={{ padding: '1.5rem', border: '1px solid var(--danger)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <Trash2 size={17} color="var(--danger)" />
        <h2 style={{ margin: 0, fontSize: '0.9375rem', fontWeight: 600, color: 'var(--danger)' }}>Удалить аккаунт</h2>
      </div>
      <p style={{ margin: '0 0 1rem', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
        Аккаунт и доступ ко всем сервисам платформы будут удалены безвозвратно. Введите пароль, чтобы подтвердить.
      </p>

      <form onSubmit={handleDelete} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
        <PasswordField
          id="account-delete-password"
          label="Пароль"
          value={password}
          onChange={(v) => { setPassword(v); setPasswordError('') }}
          autoComplete="current-password"
          error={passwordError}
        />

        <Button
          type="submit"
          variant="danger"
          disabled={loading || !password}
          style={{ justifyContent: 'center', padding: '0.625rem' }}
        >
          {loading ? 'Удаление…' : 'Удалить аккаунт навсегда'}
        </Button>
      </form>
    </div>
  )
}
