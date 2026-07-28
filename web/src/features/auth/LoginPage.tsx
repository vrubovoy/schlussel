import { useState, useEffect } from 'react'
import { Field, Button } from '@zudar107/schloss-ui'
import { login, ApiError } from '../../lib/api'
import { readReturnTo, readCodeChallenge, redirectWithCode, redirectToDefaultApp, withReturnTo } from '../../lib/returnTo'
import { validateEmail } from '../../lib/validation'
import { ErrorPage } from './ErrorPage'
import { PasswordField } from './PasswordField'
import { Header } from '../../components/Header'
import { Footer } from '../../components/Footer'

// Deliberately the same message under both fields, never split into
// "email not found" vs "wrong password" - that would let a caller
// enumerate which emails are registered on the platform. Both fields get
// highlighted (neither is provably the culprit) rather than singling one
// out. Mirrors the server's own generic 401 (see schlussel's isTrustedOrigin
// discussion / the security audit that added a matching test there).
const INVALID_CREDENTIALS_MESSAGE = 'Неверный email или пароль'

interface FieldErrors {
  email?: string
  password?: string
}

export function LoginPage() {
  const returnTo = readReturnTo()
  const codeChallenge = readCodeChallenge()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  // Separate from fieldErrors - a 401 highlights both fields (see
  // INVALID_CREDENTIALS_MESSAGE) but the message itself is shown once, as
  // formError, not duplicated under each field.
  const [credentialsInvalid, setCredentialsInvalid] = useState(false)
  const [formError, setFormError] = useState('')
  const [loading, setLoading] = useState(false)
  const [checkingSession, setCheckingSession] = useState(true)

  const returnToUrl = returnTo.present && returnTo.valid ? returnTo.url : ''
  const challenge = codeChallenge.present ? codeChallenge.codeChallenge : ''
  const canSilentAuth = returnTo.present && returnTo.valid && codeChallenge.present

  // Before ever showing the credentials form, check whether this browser
  // already has a valid schlussel session (the httpOnly refresh cookie -
  // always same-origin here, since this page is the only thing that ever
  // calls POST /auth/login, so the cookie is always scoped to schlussel's
  // own origin and never needs sharing across subdomains). If so, silently
  // complete the PKCE handoff instead of making the visitor log in again -
  // the same "already signed in, redirect straight back" flow every real
  // SSO provider uses.
  useEffect(() => {
    if (!canSilentAuth) {
      setCheckingSession(false)
      return
    }
    let cancelled = false
    fetch('/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codeChallenge: challenge, codeChallengeMethod: 'S256' }),
    })
      .then((res) => (res.ok ? (res.json() as Promise<{ code: string }>) : null))
      .then((data) => {
        if (cancelled) return
        if (data?.code) {
          redirectWithCode(returnToUrl, data.code)
        } else {
          setCheckingSession(false)
        }
      })
      .catch(() => {
        if (!cancelled) setCheckingSession(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // No return_to (or no code_challenge) means this page was reached by
  // typing the URL directly rather than via an external redirect - send
  // the visitor to the platform's home instead of ever rendering the form.
  if (!returnTo.present || !codeChallenge.present) {
    redirectToDefaultApp()
    return null
  }

  if (!returnTo.valid) {
    return <ErrorPage message="Адрес, на который нужно вернуться после входа, не входит в список разрешённых." />
  }

  // Still checking for an existing session - render a themed blank div
  // rather than flash the credentials form before a silent redirect might
  // fire, or an unthemed white background before that.
  if (checkingSession) {
    return <div style={{ minHeight: '100vh', background: 'var(--bg-base)' }} />
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFormError('')
    setCredentialsInvalid(false)

    const nextErrors: FieldErrors = {}
    const emailError = validateEmail(email)
    if (emailError) nextErrors.email = emailError
    if (!password) nextErrors.password = 'Введите пароль'

    if (Object.keys(nextErrors).length > 0) {
      setFieldErrors(nextErrors)
      return
    }
    setFieldErrors({})

    setLoading(true)
    try {
      const { code } = await login(email, password, challenge)
      redirectWithCode(returnToUrl, code)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setCredentialsInvalid(true)
        setFormError(INVALID_CREDENTIALS_MESSAGE)
      } else {
        setFormError('Не удалось войти')
      }
      setLoading(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Header />

      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--bg-base)', padding: '1rem',
      }}>
        <div className="card-elevated" style={{ width: '100%', maxWidth: 380, padding: '2rem' }}>
          <div style={{ textAlign: 'center', marginBottom: '1.75rem' }}>
            <div style={{
              width: 48, height: 48, background: 'var(--accent)', borderRadius: 12,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: '0.75rem',
            }}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                <circle cx="8" cy="15" r="4" />
                <path d="M10.85 12.15 19 4" />
                <path d="M18 5l2 2" />
                <path d="M15 8l2 2" />
              </svg>
            </div>
            <h1 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
              Войти
            </h1>
          </div>

          <form onSubmit={handleSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
            <Field
              id="login-email"
              label="Email"
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value)
                setFieldErrors((f) => ({ ...f, email: undefined }))
                setCredentialsInvalid(false)
                setFormError('')
              }}
              placeholder="name@example.com"
              required
              autoComplete="email"
              error={fieldErrors.email}
              invalid={credentialsInvalid}
            />
            <PasswordField
              id="login-password"
              label="Пароль"
              value={password}
              onChange={(v) => {
                setPassword(v)
                setFieldErrors((f) => ({ ...f, password: undefined }))
                setCredentialsInvalid(false)
                setFormError('')
              }}
              placeholder="••••••••"
              autoComplete="current-password"
              error={fieldErrors.password}
              invalid={credentialsInvalid}
            />

            {formError && (
              <div style={{ padding: '0.625rem 0.75rem', background: 'var(--danger-muted)', border: '1px solid var(--danger)', borderRadius: 8, fontSize: '0.875rem', color: 'var(--danger)' }}>
                {formError}
              </div>
            )}

            <Button
              type="submit"
              variant="primary"
              disabled={loading}
              style={{ justifyContent: 'center', padding: '0.625rem', marginTop: '0.25rem', opacity: loading ? 0.7 : 1 }}
            >
              {loading ? 'Подождите…' : 'Войти'}
            </Button>
          </form>

          <p style={{ margin: '1.25rem 0 0', textAlign: 'center', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
            Нет аккаунта?{' '}
            <a href={withReturnTo('/register')} style={{ color: 'var(--accent)', textDecoration: 'none' }}>
              Зарегистрироваться
            </a>
          </p>
        </div>
      </div>

      <Footer />
    </div>
  )
}
