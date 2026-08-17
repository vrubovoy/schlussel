import { useEffect, useState } from 'react'
import { generateCodeChallenge, generateCodeVerifier } from './pkce'
import { refreshSession, fetchMe, exchangeCode, type AuthUser } from './api'

interface UseSchlusselSessionResult {
  checking: boolean
  user: AuthUser | null
  accessToken: string
  setAccessToken: (accessToken: string) => void
  setUser: (user: AuthUser) => void
}

// Shared bootstrap for schlussel/web pages that require a logged-in
// session (AdminPage, DocsPage): tries a plain silent-session check first,
// falls back to redeeming a PKCE code if just reached via a /login
// redirect, or sends the visitor to /login otherwise. AccountPage
// implements this same shape itself rather than using this hook, since it
// predates it and its own version carries a nested `return_to` for the
// "back to app" link - not worth touching a working, already-tested page
// just to share this.
export function useSchlusselSession(pagePath: string): UseSchlusselSessionResult {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [accessToken, setAccessToken] = useState('')
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    let cancelled = false
    const storageKey = `${pagePath.replace(/^\//, '')}_pkce_code_verifier`

    async function redirectToLogin() {
      const verifier = generateCodeVerifier()
      sessionStorage.setItem(storageKey, verifier)
      const challenge = await generateCodeChallenge(verifier)
      const params = new URLSearchParams({
        return_to: `${window.location.origin}${pagePath}`,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      })
      window.location.href = `/login?${params.toString()}`
    }

    async function bootstrap() {
      const params = new URLSearchParams(window.location.search)
      const code = params.get('code')
      history.replaceState(null, '', window.location.pathname)

      const verifier = sessionStorage.getItem(storageKey)
      sessionStorage.removeItem(storageKey)

      if (code && verifier) {
        try {
          const data = await exchangeCode(code, verifier)
          if (cancelled) return
          setAccessToken(data.accessToken)
          setUser(data.user)
          setChecking(false)
          return
        } catch {
          // Fall through to a plain silent-session check - the trusted
          // login that just happened already left a fresh cookie here
          // regardless of whether this code redemption succeeded.
        }
      }

      try {
        const { accessToken: token } = await refreshSession()
        const me = await fetchMe(token)
        if (cancelled) return
        setAccessToken(token)
        setUser(me)
        setChecking(false)
      } catch {
        if (!cancelled) await redirectToLogin()
      }
    }

    void bootstrap()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pagePath])

  return { checking, user, accessToken, setAccessToken, setUser }
}
