import { ShieldOff } from 'lucide-react'
import { Header } from './Header'
import { Footer } from './Footer'
import { DEFAULT_APP_URL } from '../lib/returnTo'
import type { AuthUser } from '../lib/api'

interface AccessDeniedPageProps {
  user: AuthUser
  onLogout: () => void
}

// Shown by AdminPage/DocsPage when a logged-in, non-admin user reaches
// them directly - the server-side role check on every actual admin
// endpoint is the real security boundary, this is just so a regular user
// sees a clear message instead of a half-broken page.
export function AccessDeniedPage({ user, onLogout }: AccessDeniedPageProps) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Header user={{ name: user.name }} onLogout={onLogout} />

      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--bg-base)', padding: '1rem',
      }}>
        <div className="card-elevated" style={{ width: '100%', maxWidth: 380, padding: '2rem', textAlign: 'center' }}>
          <ShieldOff size={28} color="var(--text-muted)" style={{ marginBottom: '0.75rem' }} />
          <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.125rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            Доступ только для администраторов
          </h1>
          <p style={{ margin: '0 0 1.25rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
            У вашей учётной записи нет прав администратора.
          </p>
          <a href={DEFAULT_APP_URL} style={{ fontSize: '0.8125rem', color: 'var(--accent)', textDecoration: 'none' }}>
            На главную
          </a>
        </div>
      </div>

      <Footer />
    </div>
  )
}
