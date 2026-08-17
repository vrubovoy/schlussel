import { useState, useEffect, useCallback } from 'react'
import { Users, Ticket, BarChart3, Copy, Check, FileCode2 } from 'lucide-react'
import { Button, Field, Badge, Modal, StatTile, Sparkline, type BadgeVariant } from '@zudar107/schloss-ui'
import {
  ApiError, type AdminUser, type AdminStats, type Invite, type InviteStatus,
  listAdminUsers, changeUserRole, forceLogoutUser, deleteUserAsAdmin, fetchAdminStats,
  listInvites, createInvite, revokeInvite,
} from '../../lib/api'
import { useSchlusselSession } from '../../lib/useSchlusselSession'
import { Header } from '../../components/Header'
import { Footer } from '../../components/Footer'
import { AccessDeniedPage } from '../../components/AccessDeniedPage'
import { PasswordField } from '../auth/PasswordField'

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

export function AdminPage() {
  const { checking, user, accessToken, setAccessToken } = useSchlusselSession('/admin')

  async function handleLogout() {
    window.location.href = '/logout'
  }

  if (checking || !user) {
    return <div style={{ minHeight: '100vh', background: 'var(--bg-base)' }} />
  }

  if (user.role !== 'admin') {
    return <AccessDeniedPage
      user={user}
      accessToken={accessToken}
      onAccessTokenChange={setAccessToken}
      onLogout={handleLogout}
    />
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Header
        user={user}
        accessToken={accessToken}
        onAccessTokenChange={setAccessToken}
        onLogout={handleLogout}
      />

      <div style={{ flex: 1, background: 'var(--bg-base)', padding: '2rem 1rem' }}>
        <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <a href="/account" style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', textDecoration: 'none' }}>
            ← Аккаунт
          </a>

          <div>
            <h1 style={{ margin: 0, fontSize: '1.375rem', fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
              Администрирование
            </h1>
            <p style={{ margin: '0.25rem 0 0', color: 'var(--text-muted)', fontSize: '0.8125rem' }}>
              Пользователи, приглашения и обзор платформы
            </p>
          </div>

          <OverviewSection accessToken={accessToken} />
          <UsersSection accessToken={accessToken} currentUserId={user.id} />
          <InvitesSection accessToken={accessToken} />
          <DocsLinkSection />
        </div>
      </div>

      <Footer />
    </div>
  )
}

// ── Overview ─────────────────────────────────────────────────────────────

function OverviewSection({ accessToken }: { accessToken: string }) {
  const [stats, setStats] = useState<AdminStats | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchAdminStats(accessToken).then((s) => { if (!cancelled) setStats(s) }).catch(() => { /* silently keep the section empty */ })
    return () => { cancelled = true }
  }, [accessToken])

  return (
    <div className="card" style={{ padding: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
        <BarChart3 size={17} color="var(--text-secondary)" />
        <h2 style={{ margin: 0, fontSize: '0.9375rem', fontWeight: 600, color: 'var(--text-primary)' }}>Обзор</h2>
      </div>

      {stats && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
            <StatTile label="Пользователи" value={stats.totalUsers} />
            <StatTile label="Активные сессии" value={stats.totalActiveSessions} />
            <StatTile label="Инвайты в ожидании" value={stats.pendingInvites} />
            <StatTile label="Новых за 30 дней" value={stats.newUsersLast30d} accent />
          </div>
          <div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.375rem' }}>
              Регистрации за 30 дней
            </div>
            <Sparkline values={stats.registrationsByDay.map((d) => d.count)} height={32} />
          </div>
        </>
      )}
    </div>
  )
}

// ── Users ────────────────────────────────────────────────────────────────

function UsersSection({ accessToken, currentUserId }: { accessToken: string; currentUserId: string }) {
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [error, setError] = useState('')
  const [roleTarget, setRoleTarget] = useState<AdminUser | null>(null)
  const [logoutTarget, setLogoutTarget] = useState<AdminUser | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null)
  const [deletePassword, setDeletePassword] = useState('')
  const [deleteError, setDeleteError] = useState('')
  const [deletePasswordError, setDeletePasswordError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    listAdminUsers(accessToken).then(setUsers).catch(() => setError('Не удалось загрузить список пользователей'))
  }, [accessToken])

  useEffect(() => {
    load()
  }, [load])

  async function confirmRoleChange() {
    if (!roleTarget || busy) return
    setBusy(true)
    setError('')
    const nextRole = roleTarget.role === 'admin' ? 'user' : 'admin'
    try {
      await changeUserRole(accessToken, roleTarget.id, nextRole)
      setRoleTarget(null)
      load()
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? 'Нельзя понизить последнего администратора' : 'Не удалось изменить роль')
    } finally {
      setBusy(false)
    }
  }

  async function confirmLogout() {
    if (!logoutTarget || busy) return
    setBusy(true)
    setError('')
    try {
      await forceLogoutUser(accessToken, logoutTarget.id)
      setLogoutTarget(null)
      load()
    } catch {
      setError('Не удалось завершить сессии пользователя')
    } finally {
      setBusy(false)
    }
  }

  async function confirmDelete() {
    if (!deleteTarget || busy) return
    setBusy(true)
    setDeleteError('')
    setDeletePasswordError('')
    try {
      await deleteUserAsAdmin(accessToken, deleteTarget.id, deletePassword)
      setDeleteTarget(null)
      setDeletePassword('')
      load()
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setDeleteError('Нельзя удалить последнего администратора')
      else if (err instanceof ApiError && err.status === 401) setDeletePasswordError('Неверный пароль')
      else setDeleteError('Не удалось удалить пользователя')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card" style={{ padding: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
        <Users size={17} color="var(--text-secondary)" />
        <h2 style={{ margin: 0, fontSize: '0.9375rem', fontWeight: 600, color: 'var(--text-primary)' }}>Пользователи</h2>
      </div>

      {error && (
        <div style={{ padding: '0.625rem 0.75rem', background: 'var(--danger-muted)', border: '1px solid var(--danger)', borderRadius: 8, fontSize: '0.8125rem', color: 'var(--danger)', marginBottom: '0.875rem' }}>
          {error}
        </div>
      )}

      {users === null ? (
        <div style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>Загрузка…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
          {users.map((u) => (
            <div
              key={u.id}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem',
                padding: '0.625rem 0.75rem', border: '1px solid var(--border)', borderRadius: 8, flexWrap: 'wrap',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ fontSize: '0.8125rem', color: 'var(--text-primary)', fontWeight: 500 }}>{u.name}</span>
                  <Badge variant={u.role === 'admin' ? 'info' : 'neutral'}>{u.role === 'admin' ? 'Админ' : 'Пользователь'}</Badge>
                  {u.id === currentUserId && <Badge variant="success">Это вы</Badge>}
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  {u.email} · {u.activeSessionCount} {u.activeSessionCount === 1 ? 'сессия' : 'сессий'} · {formatDate(u.createdAt)}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '0.375rem', flexShrink: 0 }}>
                <Button variant="ghost" onClick={() => setRoleTarget(u)} style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}>
                  {u.role === 'admin' ? 'Разжаловать' : 'Сделать админом'}
                </Button>
                <Button variant="ghost" onClick={() => setLogoutTarget(u)} style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}>
                  Завершить сессии
                </Button>
                <Button variant="danger" onClick={() => setDeleteTarget(u)} style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}>
                  Удалить
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={!!roleTarget}
        onClose={() => setRoleTarget(null)}
        title={roleTarget?.role === 'admin' ? 'Разжаловать администратора?' : 'Назначить администратором?'}
        actions={[
          { label: 'Отмена', onClick: () => setRoleTarget(null), variant: 'ghost' },
          { label: 'Подтвердить', onClick: confirmRoleChange, variant: 'primary' },
        ]}
      >
        <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
          {roleTarget?.role === 'admin'
            ? `${roleTarget?.name} потеряет доступ к администрированию платформы.`
            : `${roleTarget?.name} получит полный доступ к администрированию платформы.`}
        </p>
      </Modal>

      <Modal
        open={!!logoutTarget}
        onClose={() => setLogoutTarget(null)}
        title="Завершить все сессии пользователя?"
        actions={[
          { label: 'Отмена', onClick: () => setLogoutTarget(null), variant: 'ghost' },
          { label: 'Завершить', onClick: confirmLogout, variant: 'primary' },
        ]}
      >
        <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
          {logoutTarget?.name} будет разлогинен на всех устройствах. Аккаунт останется активным.
        </p>
      </Modal>

      <Modal
        open={!!deleteTarget}
        onClose={() => { setDeleteTarget(null); setDeletePassword(''); setDeleteError(''); setDeletePasswordError('') }}
        title="Удалить аккаунт пользователя?"
        actions={[
          { label: 'Отмена', onClick: () => { setDeleteTarget(null); setDeletePassword(''); setDeleteError(''); setDeletePasswordError('') }, variant: 'ghost' },
          { label: 'Удалить навсегда', onClick: confirmDelete, variant: 'danger' },
        ]}
      >
        <p style={{ margin: '0 0 0.875rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
          Аккаунт «{deleteTarget?.name}» ({deleteTarget?.email}) будет удалён безвозвратно. Подтвердите свой пароль.
        </p>
        <PasswordField
          id="admin-delete-user-password"
          label="Ваш пароль"
          value={deletePassword}
          onChange={(v) => { setDeletePassword(v); setDeletePasswordError('') }}
          autoComplete="current-password"
          error={deletePasswordError}
        />
        {deleteError && (
          <div style={{ marginTop: '0.75rem', padding: '0.625rem 0.75rem', background: 'var(--danger-muted)', border: '1px solid var(--danger)', borderRadius: 8, fontSize: '0.8125rem', color: 'var(--danger)' }}>
            {deleteError}
          </div>
        )}
      </Modal>
    </div>
  )
}

// ── Invites ──────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<InviteStatus, string> = {
  pending: 'Ожидает',
  used: 'Использован',
  expired: 'Истёк',
  revoked: 'Отозван',
}

const STATUS_VARIANT: Record<InviteStatus, BadgeVariant> = {
  pending: 'info',
  used: 'success',
  expired: 'neutral',
  revoked: 'danger',
}

function InvitesSection({ accessToken }: { accessToken: string }) {
  const [invites, setInvites] = useState<Invite[] | null>(null)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [newLink, setNewLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const load = useCallback(() => {
    listInvites(accessToken).then(setInvites).catch(() => setError('Не удалось загрузить список приглашений'))
  }, [accessToken])

  useEffect(() => {
    load()
  }, [load])

  async function handleCreate() {
    setCreating(true)
    setError('')
    try {
      const invite = await createInvite(accessToken)
      // A fragment (#invite=...), not a query param - it's never sent in
      // an HTTP request line, so it can't end up in Caddy's access logs or
      // a Referer header the way ?invite=... would. RegisterPage strips
      // it from the visible URL as soon as it reads it.
      setNewLink(`${window.location.origin}/register#invite=${invite.code}`)
      load()
    } catch {
      setError('Не удалось создать приглашение')
    } finally {
      setCreating(false)
    }
  }

  async function handleCopy() {
    if (!newLink) return
    await navigator.clipboard.writeText(newLink)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function handleRevoke(id: string) {
    setError('')
    try {
      await revokeInvite(accessToken, id)
      load()
    } catch {
      setError('Не удалось отозвать приглашение')
    }
  }

  return (
    <div className="card" style={{ padding: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Ticket size={17} color="var(--text-secondary)" />
          <h2 style={{ margin: 0, fontSize: '0.9375rem', fontWeight: 600, color: 'var(--text-primary)' }}>Приглашения</h2>
        </div>
        <Button variant="primary" onClick={handleCreate} disabled={creating} style={{ padding: '0.4rem 0.75rem', fontSize: '0.75rem' }}>
          {creating ? 'Создание…' : 'Создать инвайт'}
        </Button>
      </div>

      {error && (
        <div style={{ padding: '0.625rem 0.75rem', background: 'var(--danger-muted)', border: '1px solid var(--danger)', borderRadius: 8, fontSize: '0.8125rem', color: 'var(--danger)', marginBottom: '0.875rem' }}>
          {error}
        </div>
      )}

      {invites === null ? (
        <div style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>Загрузка…</div>
      ) : invites.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>Приглашений ещё не было</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
          {invites.map((inv) => (
            <div
              key={inv.id}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem',
                padding: '0.625rem 0.75rem', border: '1px solid var(--border)', borderRadius: 8, flexWrap: 'wrap',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Badge variant={STATUS_VARIANT[inv.status]}>{STATUS_LABEL[inv.status]}</Badge>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>от {inv.createdByName ?? '—'}</span>
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  {inv.status === 'used'
                    ? `Использован: ${inv.usedByName ?? inv.usedByEmail ?? '—'}`
                    : `Истекает: ${formatDate(inv.expiresAt)}`}
                </div>
              </div>
              {inv.status === 'pending' && (
                <Button variant="ghost" onClick={() => handleRevoke(inv.id)} style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem', flexShrink: 0 }}>
                  Отозвать
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      <Modal
        open={!!newLink}
        onClose={() => setNewLink(null)}
        title="Приглашение создано"
        actions={[{ label: 'Готово', onClick: () => setNewLink(null), variant: 'primary' }]}
      >
        <p style={{ margin: '0 0 0.75rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
          Отправьте эту ссылку тому, кого хотите пригласить. Она работает один раз и показывается только сейчас.
        </p>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <Field id="new-invite-link" label="" value={newLink ?? ''} readOnly onChange={() => {}} />
          <Button variant="secondary" onClick={handleCopy} style={{ flexShrink: 0, padding: '0.5rem 0.75rem' }}>
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </Button>
        </div>
      </Modal>
    </div>
  )
}

// ── Docs link ────────────────────────────────────────────────────────────

function DocsLinkSection() {
  return (
    <div className="card" style={{ padding: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
        <FileCode2 size={17} color="var(--text-secondary)" />
        <h2 style={{ margin: 0, fontSize: '0.9375rem', fontWeight: 600, color: 'var(--text-primary)' }}>API-документация</h2>
      </div>
      <a href="/docs" style={{ fontSize: '0.8125rem', color: 'var(--accent)', textDecoration: 'none' }}>
        Открыть документацию Schlüssel →
      </a>
    </div>
  )
}
