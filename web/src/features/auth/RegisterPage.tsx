import { useEffect, useState } from 'react'
import { Field, Button } from '@zudar107/schloss-ui'
import { register, ApiError } from '../../lib/api'
import { generateCodeChallenge, generateCodeVerifier } from '../../lib/pkce'
import {
  readReturnTo, readCodeChallenge, redirectWithCode, redirectToDefaultApp, withReturnTo, DEFAULT_APP_URL,
} from '../../lib/returnTo'
import { ErrorPage } from './ErrorPage'
import { PasswordField } from './PasswordField'
import { Header } from '../../components/Header'
import { Footer } from '../../components/Footer'

export function RegisterPage() {
  const returnTo = readReturnTo()
  const codeChallenge = readCodeChallenge()
  const inviteFromUrl = new URLSearchParams(window.location.search).get('invite') ?? ''
  const hasInvite = inviteFromUrl.length > 0
  // Both present together, exactly as before - a partially-specified pair
  // is treated the same as neither being there.
  const hasExternalCaller = returnTo.present && codeChallenge.present

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [inviteCode, setInviteCode] = useState(inviteFromUrl)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  // Only needed for the bare-invite-link path below, where there's no
  // external caller supplying its own code_challenge - generated once and
  // never persisted anywhere, since nothing here ever redeems the
  // resulting code itself (see handleSubmit's comment).
  const [selfChallenge, setSelfChallenge] = useState('')

  useEffect(() => {
    if (hasExternalCaller || !hasInvite) return
    let cancelled = false
    void generateCodeChallenge(generateCodeVerifier()).then((c) => {
      if (!cancelled) setSelfChallenge(c)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // No return_to (or no code_challenge) normally means this page was
  // reached by typing the URL directly rather than via an external
  // redirect - send the visitor to the platform's home instead of ever
  // rendering the form. A bare admin-shared invite link is the one
  // legitimate exception: it has neither, but is still a real, intended
  // entry point.
  if (!hasExternalCaller && !hasInvite) {
    redirectToDefaultApp()
    return null
  }

  if (returnTo.present && !returnTo.valid) {
    return <ErrorPage message="Адрес, на который нужно вернуться после регистрации, не входит в список разрешённых." />
  }

  if (!hasExternalCaller && !selfChallenge) {
    // Still generating the throwaway challenge above - nothing to submit
    // to yet.
    return null
  }

  const returnToUrl = hasExternalCaller && returnTo.present && returnTo.valid ? returnTo.url : DEFAULT_APP_URL
  const challenge = hasExternalCaller && codeChallenge.present ? codeChallenge.codeChallenge : selfChallenge

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (password !== confirmPassword) {
      setError('Пароли не совпадают')
      return
    }
    setLoading(true)
    try {
      const { code } = await register(email, password, name, challenge, inviteCode || undefined)
      // In the bare-invite-link case there's no real external app waiting
      // to redeem this code - registering already established a session
      // cookie on this same origin (the login step inside register() is
      // always same-origin/trusted here), so DEFAULT_APP_URL's own auth
      // check will find no local token, bounce through schlussel's /login,
      // and that page's silent-reauth picks the cookie straight back up.
      // The stray `code` param is simply ignored by whatever it lands on.
      redirectWithCode(returnToUrl, code)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setError('Этот email уже зарегистрирован')
      else if (err instanceof ApiError && err.status === 400) {
        setError(inviteCode ? 'Неверный или истёкший код приглашения' : 'Нужен код приглашения')
      } else setError('Не удалось зарегистрироваться')
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
              Создать аккаунт
            </h1>
          </div>

          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
            <Field
              id="register-name"
              label="Имя"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ваше имя"
              required
              autoComplete="name"
            />
            <Field
              id="register-email"
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              required
              autoComplete="email"
            />
            <PasswordField
              id="register-password"
              label="Пароль"
              value={password}
              onChange={setPassword}
              placeholder="Минимум 8 символов"
              minLength={8}
              autoComplete="new-password"
            />
            <PasswordField
              id="register-password-confirm"
              label="Повторите пароль"
              value={confirmPassword}
              onChange={setConfirmPassword}
              placeholder="Минимум 8 символов"
              minLength={8}
              autoComplete="new-password"
            />
            <Field
              id="register-invite"
              label="Код приглашения"
              type="text"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              placeholder="Получен от администратора"
              autoComplete="off"
            />

            {error && (
              <div style={{ padding: '0.625rem 0.75rem', background: 'var(--danger-muted)', border: '1px solid var(--danger)', borderRadius: 8, fontSize: '0.875rem', color: 'var(--danger)' }}>
                {error}
              </div>
            )}

            <Button
              type="submit"
              variant="primary"
              disabled={loading}
              style={{ justifyContent: 'center', padding: '0.625rem', marginTop: '0.25rem', opacity: loading ? 0.7 : 1 }}
            >
              {loading ? 'Подождите…' : 'Зарегистрироваться'}
            </Button>
          </form>

          <p style={{ margin: '1.25rem 0 0', textAlign: 'center', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
            Уже есть аккаунт?{' '}
            <a href={withReturnTo('/login')} style={{ color: 'var(--accent)', textDecoration: 'none' }}>
              Войти
            </a>
          </p>
        </div>
      </div>

      <Footer />
    </div>
  )
}
