import { useState, useEffect, useRef } from 'react'
import {
  KeyRound, Trash2, User as UserIcon, Monitor, ShieldCheck, Globe, Bell, Link2, Lock, Download,
  Send, Camera,
} from 'lucide-react'
import { Button, Field, Badge } from '@zudar107/schloss-ui'
import { generateCodeVerifier, generateCodeChallenge } from '../../lib/pkce'
import {
  refreshSession, fetchMe, exchangeCode, changePassword, deleteAccount, updateName,
  listSessions, revokeSession, logoutEverywhere, ApiError, type AuthUser, type Session,
  fetchProfile, updateProfile, uploadAvatar, deleteAvatar, listConnectedAccounts, exportAccountData,
  type Profile, type ConnectedAccount, type DateFormat, type WeekStart, type Language,
} from '../../lib/api'
import { MAX_AVATAR_BYTES, readFileAsDataUrl } from '../../lib/avatar'
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
          <PreferencesCard accessToken={accessToken} />
          <NotificationsCard accessToken={accessToken} />
          <ConnectedAccountsCard accessToken={accessToken} />
          <SessionsCard accessToken={accessToken} />
          <PrivacyCard />
          <DataExportCard accessToken={accessToken} />
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
  const [avatarDataUrl, setAvatarDataUrl] = useState<string | null>(null)
  const [avatarError, setAvatarError] = useState('')
  const [avatarLoading, setAvatarLoading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setName(user.name)
  }, [user.name])

  useEffect(() => {
    let cancelled = false
    fetchProfile(accessToken).then((p) => { if (!cancelled) setAvatarDataUrl(p.avatarDataUrl) }).catch(() => {})
    return () => { cancelled = true }
  }, [accessToken])

  async function handleAvatarFile(file: File) {
    setAvatarError('')
    if (!file.type.startsWith('image/')) {
      setAvatarError('Выберите файл изображения')
      return
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setAvatarError(`Файл слишком большой (максимум ${Math.round(MAX_AVATAR_BYTES / 1024)} КБ)`)
      return
    }
    setAvatarLoading(true)
    try {
      const dataUrl = await readFileAsDataUrl(file)
      const updated = await uploadAvatar(accessToken, dataUrl)
      setAvatarDataUrl(updated.avatarDataUrl)
    } catch {
      setAvatarError('Не удалось загрузить изображение')
    } finally {
      setAvatarLoading(false)
    }
  }

  async function handleAvatarRemove() {
    setAvatarError('')
    setAvatarLoading(true)
    try {
      const updated = await deleteAvatar(accessToken)
      setAvatarDataUrl(updated.avatarDataUrl)
    } catch {
      setAvatarError('Не удалось удалить изображение')
    } finally {
      setAvatarLoading(false)
    }
  }

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
        <button
          type="button"
          aria-label="Изменить фото"
          onClick={() => fileInputRef.current?.click()}
          disabled={avatarLoading}
          title="Изменить фото"
          style={{
            position: 'relative', width: 44, height: 44, borderRadius: '50%', flexShrink: 0,
            background: avatarDataUrl ? undefined : 'var(--accent)', color: '#fff', fontWeight: 700, fontSize: '1.0625rem',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
            overflow: 'hidden', opacity: avatarLoading ? 0.6 : 1, border: 'none', padding: 0,
          }}
        >
          {avatarDataUrl ? (
            <img src={avatarDataUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            user.name.trim().charAt(0).toUpperCase()
          )}
          <div style={{
            position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.35)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0,
            transition: 'opacity 150ms',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '1' }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '0' }}
          >
            <Camera size={16} color="#fff" />
          </div>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleAvatarFile(f); e.target.value = '' }}
        />
        <div>
          <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginBottom: avatarDataUrl ? 4 : 0 }}>{user.email}</div>
          {avatarDataUrl && (
            <button
              type="button"
              onClick={handleAvatarRemove}
              disabled={avatarLoading}
              style={{ border: 'none', background: 'none', padding: 0, fontSize: '0.75rem', color: 'var(--danger)', cursor: 'pointer' }}
            >
              Удалить фото
            </button>
          )}
        </div>
      </div>
      {avatarError && (
        <div style={{ marginBottom: '1.125rem', marginTop: '-0.75rem', padding: '0.625rem 0.75rem', background: 'var(--danger-muted)', border: '1px solid var(--danger)', borderRadius: 8, fontSize: '0.8125rem', color: 'var(--danger)' }}>
          {avatarError}
        </div>
      )}

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

// Real IANA zone list where the browser supports it (every evergreen
// browser does); a short common-zone fallback otherwise so the select
// still works rather than being empty.
const FALLBACK_TIMEZONES = [
  'UTC', 'Europe/Moscow', 'Europe/London', 'Europe/Berlin', 'America/New_York',
  'America/Los_Angeles', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Shanghai', 'Asia/Tokyo',
]
function listTimezones(): string[] {
  const supportedValuesOf = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf
  try {
    const timezones = supportedValuesOf ? supportedValuesOf('timeZone') : FALLBACK_TIMEZONES
    return [...new Set(['UTC', ...timezones])]
  } catch {
    return FALLBACK_TIMEZONES
  }
}

const DATE_FORMAT_OPTIONS: { value: DateFormat; label: string }[] = [
  { value: 'dmy', label: `ДД.ММ.ГГГГ (например, ${formatSampleDate('dmy')})` },
  { value: 'mdy', label: `ММ/ДД/ГГГГ (например, ${formatSampleDate('mdy')})` },
  { value: 'ymd', label: `ГГГГ-ММ-ДД (например, ${formatSampleDate('ymd')})` },
]

function formatSampleDate(format: DateFormat): string {
  const d = new Date(2026, 11, 31)
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yyyy = d.getFullYear()
  if (format === 'mdy') return `${mm}/${dd}/${yyyy}`
  if (format === 'ymd') return `${yyyy}-${mm}-${dd}`
  return `${dd}.${mm}.${yyyy}`
}

// Preferences that don't need per-field validation, so unlike
// ProfileCard/PasswordCard above this doesn't build up separate
// dirty/error/success state per field - every change is its own small
// PATCH /profile call, applied immediately (the same interaction the
// rest of the platform already uses for a plain select/toggle, e.g.
// ThemeToggle), with just enough local success/error feedback to show it
// landed.
function PreferencesCard({ accessToken }: { accessToken: string }) {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetchProfile(accessToken).then((p) => { if (!cancelled) setProfile(p) }).catch(() => {})
    return () => { cancelled = true }
  }, [accessToken])

  async function save(field: string, data: Parameters<typeof updateProfile>[1]) {
    setError('')
    setSaving(field)
    try {
      const updated = await updateProfile(accessToken, data)
      setProfile(updated)
    } catch {
      setError('Не удалось сохранить')
    } finally {
      setSaving(null)
    }
  }

  if (!profile) return null

  return (
    <div className="card" style={{ padding: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
        <Globe size={17} color="var(--text-secondary)" />
        <h2 style={{ margin: 0, fontSize: '0.9375rem', fontWeight: 600, color: 'var(--text-primary)' }}>Региональные настройки</h2>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
        <Field
          as="select"
          label="Часовой пояс"
          value={profile.timezone ?? ''}
          onChange={(e) => void save('timezone', { timezone: e.target.value || null })}
          disabled={saving === 'timezone'}
        >
          <option value="">Определять по браузеру</option>
          {listTimezones().map((tz) => <option key={tz} value={tz}>{tz}</option>)}
        </Field>

        <Field
          as="select"
          label="Формат даты"
          value={profile.dateFormat ?? ''}
          onChange={(e) => void save('dateFormat', { dateFormat: (e.target.value || null) as DateFormat | null })}
          disabled={saving === 'dateFormat'}
        >
          <option value="">По умолчанию (ДД.ММ.ГГГГ)</option>
          {DATE_FORMAT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Field>

        <Field
          as="select"
          label="Первый день недели"
          value={profile.weekStart ?? ''}
          onChange={(e) => void save('weekStart', { weekStart: (e.target.value || null) as WeekStart | null })}
          disabled={saving === 'weekStart'}
        >
          <option value="">По умолчанию (Понедельник)</option>
          <option value="monday">Понедельник</option>
          <option value="sunday">Воскресенье</option>
        </Field>

        <div>
          <Field
            as="select"
            label="Язык интерфейса"
            value={profile.language ?? ''}
            onChange={(e) => void save('language', { language: (e.target.value || null) as Language | null })}
            disabled={saving === 'language'}
          >
            <option value="">Русский (по умолчанию)</option>
            <option value="ru">Русский</option>
            <option value="en">English</option>
          </Field>
          <p style={{ margin: '0.375rem 0 0', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            Пока переводов ещё нет ни в одном сервисе — этот выбор просто сохраняется и вступит в силу,
            когда появится переключение языка в интерфейсе.
          </p>
        </div>

        {saving && (
          <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-muted)' }}>Сохранение…</p>
        )}
        {error && (
          <div style={{ padding: '0.625rem 0.75rem', background: 'var(--danger-muted)', border: '1px solid var(--danger)', borderRadius: 8, fontSize: '0.8125rem', color: 'var(--danger)' }}>
            {error}
          </div>
        )}
      </div>
    </div>
  )
}

const NOTIFICATION_OPTIONS: { key: 'notifyInApp' | 'notifyBrowserPush' | 'notifyTelegram'; label: string; caption: string; available: boolean }[] = [
  { key: 'notifyInApp', label: 'Уведомления в приложении', caption: 'Центр уведомлений появится вместе с сервисом уведомлений.', available: false },
  { key: 'notifyBrowserPush', label: 'Push-уведомления в браузере', caption: 'Потребует разрешения браузера — появится вместе с сервисом уведомлений.', available: false },
  { key: 'notifyTelegram', label: 'Уведомления в Telegram', caption: 'Потребует привязки Telegram-аккаунта — появится вместе с сервисом уведомлений.', available: false },
]

// Every toggle here is a stored preference with no running consumer yet -
// see the schema.ts comment on these columns for why that's the honest
// state of things right now, and NOTIFICATION_OPTIONS' captions say so
// in the UI too rather than implying these already do something.
function NotificationsCard({ accessToken }: { accessToken: string }) {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [saving, setSaving] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchProfile(accessToken).then((p) => { if (!cancelled) setProfile(p) }).catch(() => {})
    return () => { cancelled = true }
  }, [accessToken])

  async function toggle(key: 'notifyInApp' | 'notifyBrowserPush' | 'notifyTelegram', value: boolean) {
    setSaving(key)
    try {
      const updated = await updateProfile(accessToken, { [key]: value })
      setProfile(updated)
    } finally {
      setSaving(null)
    }
  }

  if (!profile) return null

  return (
    <div className="card" style={{ padding: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
        <Bell size={17} color="var(--text-secondary)" />
        <h2 style={{ margin: 0, fontSize: '0.9375rem', fontWeight: 600, color: 'var(--text-primary)' }}>Уведомления</h2>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {NOTIFICATION_OPTIONS.map((opt) => (
          <label key={opt.key} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.625rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={profile[opt.key]}
              disabled={saving === opt.key}
              onChange={(e) => void toggle(opt.key, e.target.checked)}
              style={{ marginTop: 3, flexShrink: 0 }}
            />
            <span>
              <span style={{ display: 'block', fontSize: '0.875rem', color: 'var(--text-primary)', fontWeight: 500 }}>{opt.label}</span>
              <span style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)' }}>{opt.caption}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  )
}

// Always shows an empty list today - see connectedAccounts' schema.ts
// comment: there's no connect flow yet (no Telegram bot to hand off to),
// so nothing ever populates this table. The "Подключить" button is
// disabled rather than hidden, so the eventual real flow has an obvious
// place to wire itself into rather than needing new UI built from
// scratch alongside it.
function ConnectedAccountsCard({ accessToken }: { accessToken: string }) {
  const [accounts, setAccounts] = useState<ConnectedAccount[] | null>(null)

  useEffect(() => {
    let cancelled = false
    listConnectedAccounts(accessToken).then((a) => { if (!cancelled) setAccounts(a) }).catch(() => {})
    return () => { cancelled = true }
  }, [accessToken])

  return (
    <div className="card" style={{ padding: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
        <Link2 size={17} color="var(--text-secondary)" />
        <h2 style={{ margin: 0, fontSize: '0.9375rem', fontWeight: 600, color: 'var(--text-primary)' }}>Связанные аккаунты</h2>
      </div>

      {accounts && accounts.length === 0 && (
        <p style={{ margin: '0 0 1rem', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Ничего не подключено.</p>
      )}
      {accounts && accounts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1rem' }}>
          {accounts.map((a) => (
            <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8125rem', color: 'var(--text-primary)' }}>
              <Send size={14} />
              {a.externalUsername ?? a.provider}
            </div>
          ))}
        </div>
      )}

      <Button variant="secondary" disabled style={{ padding: '0.5rem 0.875rem', fontSize: '0.8125rem' }}>
        <Send size={14} /> Подключить Telegram
      </Button>
      <p style={{ margin: '0.5rem 0 0', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
        Появится вместе с сервисом уведомлений — Telegram станет каналом для мобильных уведомлений.
      </p>
    </div>
  )
}

// No real "who can see what" TOGGLE exists on this platform yet - there's
// no sharing feature to turn on or off. But the platform itself is
// multi-user (one admin's server, used by family/friends, each with
// their own account) - so "where is my data and who else on this
// install can see it" is a real, meaningful question worth answering
// plainly, not a single-user platform where it'd be moot. This states
// the actual privacy posture as information rather than inventing a
// toggle with nothing behind it.
function PrivacyCard() {
  return (
    <div className="card" style={{ padding: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
        <Lock size={17} color="var(--text-secondary)" />
        <h2 style={{ margin: 0, fontSize: '0.9375rem', fontWeight: 600, color: 'var(--text-primary)' }}>Приватность</h2>
      </div>
      <ul style={{ margin: 0, paddingLeft: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
        <li>Этой платформой, помимо тебя, могут пользоваться другие люди (например, семья или друзья) — у каждого свой аккаунт.</li>
        <li>Твои счета, бюджет, задачи и заметки видны только тебе — другие пользователи этой платформы не имеют к ним доступа.</li>
        <li>Все данные хранятся на одном сервере, которым управляет администратор платформы — сторонние облака и сервисы не используются.</li>
        <li>Нет стороннего аналитического или рекламного трекинга.</li>
      </ul>
    </div>
  )
}

function DataExportCard({ accessToken }: { accessToken: string }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleExport() {
    setError('')
    setLoading(true)
    try {
      const data = await exportAccountData(accessToken)
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `schlussel-account-export-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      setError('Не удалось экспортировать данные')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="card" style={{ padding: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <Download size={17} color="var(--text-secondary)" />
        <h2 style={{ margin: 0, fontSize: '0.9375rem', fontWeight: 600, color: 'var(--text-primary)' }}>Экспорт данных</h2>
      </div>
      <p style={{ margin: '0 0 1rem', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
        Скачивает данные твоего аккаунта Schlüssel (профиль, настройки, список сессий) в формате JSON.
        Данные Kuvert, Tafel и Zettel экспортируются отдельно, в настройках каждого сервиса.
      </p>
      {error && (
        <div style={{ marginBottom: '1rem', padding: '0.625rem 0.75rem', background: 'var(--danger-muted)', border: '1px solid var(--danger)', borderRadius: 8, fontSize: '0.8125rem', color: 'var(--danger)' }}>
          {error}
        </div>
      )}
      <Button variant="secondary" onClick={handleExport} disabled={loading} style={{ padding: '0.5rem 0.875rem', fontSize: '0.8125rem' }}>
        {loading ? 'Экспорт…' : 'Скачать мои данные'}
      </Button>
    </div>
  )
}

const SESSION_TIMEOUT_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'По умолчанию (7 дней)' },
  { value: '15', label: '15 минут' },
  { value: '60', label: '1 час' },
  { value: '1440', label: '1 день' },
  { value: '10080', label: '7 дней' },
]

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
  const [sessionTimeout, setSessionTimeout] = useState<number | null>(null)
  const [timeoutSaving, setTimeoutSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    listSessions(accessToken)
      .then((s) => { if (!cancelled) setSessions(s) })
      .catch(() => { if (!cancelled) setError('Не удалось загрузить список сессий') })
      .finally(() => { if (!cancelled) setLoading(false) })
    fetchProfile(accessToken).then((p) => { if (!cancelled) setSessionTimeout(p.sessionTimeoutMinutes) }).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [accessToken])

  async function handleTimeoutChange(value: string) {
    setTimeoutSaving(true)
    try {
      const minutes = value ? Number(value) : null
      const updated = await updateProfile(accessToken, { sessionTimeoutMinutes: minutes })
      setSessionTimeout(updated.sessionTimeoutMinutes)
    } catch {
      setError('Не удалось сохранить время жизни сессии')
    } finally {
      setTimeoutSaving(false)
    }
  }

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

      <div style={{ marginBottom: '1rem' }}>
        <Field
          as="select"
          label="Автоматический выход после бездействия"
          value={sessionTimeout != null ? String(sessionTimeout) : ''}
          onChange={(e) => void handleTimeoutChange(e.target.value)}
          disabled={timeoutSaving}
        >
          {SESSION_TIMEOUT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Field>
        <p style={{ margin: '0.375rem 0 0', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          Действует только для новых сессий (следующего входа), уже открытые сессии не сокращаются задним числом.
        </p>
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
