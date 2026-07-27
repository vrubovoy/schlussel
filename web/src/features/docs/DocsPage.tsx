import { useEffect, useRef, useState } from 'react'
import { useSchlusselSession } from '../../lib/useSchlusselSession'
import { fetchOpenApiSpec } from '../../lib/api'
import { Header } from '../../components/Header'
import { Footer } from '../../components/Footer'
import { AccessDeniedPage } from '../../components/AccessDeniedPage'
import 'swagger-ui-dist/swagger-ui.css'

// Admin-only Swagger UI for schlussel's own API. Rendered here (a page
// inside this already-authenticated frontend) rather than served raw by
// the backend, since a plain browser GET can't carry a Bearer header -
// this page already holds one from useSchlusselSession, and threads it
// through to both the initial spec fetch and every "Try it out" call.
export function DocsPage() {
  const { checking, user, accessToken } = useSchlusselSession('/docs')
  const containerRef = useRef<HTMLDivElement>(null)
  const [loadError, setLoadError] = useState('')

  async function handleLogout() {
    window.location.href = '/logout'
  }

  useEffect(() => {
    if (!user || user.role !== 'admin' || !containerRef.current) return
    let cancelled = false

    async function mount() {
      try {
        const [spec, { SwaggerUIBundle }] = await Promise.all([
          fetchOpenApiSpec(accessToken),
          import('swagger-ui-dist'),
        ])
        if (cancelled || !containerRef.current) return
        SwaggerUIBundle({
          domNode: containerRef.current,
          spec,
          presets: [SwaggerUIBundle.presets.apis],
          // SwaggerRequest's own type only declares `url`/`credentials` plus
          // an index signature - `headers` is always present at runtime but
          // isn't statically typed, hence the cast.
          requestInterceptor: (req) => {
            (req as unknown as { headers: Record<string, string> }).headers['Authorization'] = `Bearer ${accessToken}`
            return req
          },
        })
      } catch {
        if (!cancelled) setLoadError('Не удалось загрузить документацию API')
      }
    }

    void mount()
    return () => {
      cancelled = true
    }
  }, [user, accessToken])

  if (checking || !user) {
    return <div style={{ minHeight: '100vh', background: 'var(--bg-base)' }} />
  }

  if (user.role !== 'admin') {
    return <AccessDeniedPage user={user} onLogout={handleLogout} />
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Header user={{ name: user.name }} onLogout={handleLogout} />

      <div style={{ flex: 1, background: '#fff', padding: loadError ? '2rem 1rem' : 0 }}>
        {loadError && (
          <div style={{ maxWidth: 480, margin: '0 auto', padding: '0.75rem 1rem', background: 'var(--danger-muted)', border: '1px solid var(--danger)', borderRadius: 8, fontSize: '0.875rem', color: 'var(--danger)' }}>
            {loadError}
          </div>
        )}
        <div ref={containerRef} />
      </div>

      <Footer />
    </div>
  )
}
