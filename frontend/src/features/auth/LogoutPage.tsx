import { useEffect } from 'react'
import { readReturnTo, DEFAULT_APP_URL } from '../../lib/returnTo'

// Consumer apps (schloss, kuvert) cannot clear the session cookie
// themselves - it's host-only to this origin (no Domain attribute, by
// design, so it's never shared cross-subdomain), so a fetch to
// /auth/logout proxied through their own origin never actually carries
// it. Instead they do a full browser navigation here, same-origin with
// the cookie, so the logout request is the real thing - then this page
// bounces the browser back to return_to (or the default app if absent/
// disallowed). Mirrors LoginPage's silent-reauth navigation pattern.
export function LogoutPage() {
  const returnTo = readReturnTo()

  useEffect(() => {
    let cancelled = false
    fetch('/auth/logout', { method: 'POST', credentials: 'include' })
      .catch(() => {})
      .finally(() => {
        if (cancelled) return
        window.location.href = returnTo.present && returnTo.valid ? returnTo.url : DEFAULT_APP_URL
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div style={{ minHeight: '100vh', background: 'var(--bg-base)' }} />
}
