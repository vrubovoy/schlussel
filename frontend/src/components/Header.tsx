import { Header as SharedHeader, ThemeToggle, type HeaderUser } from '@zudar107/schloss-ui'
import { DEFAULT_APP_URL } from '../lib/returnTo'

interface HeaderProps {
  // Only AccountPage passes these - Login/Register/Logout are pre-auth,
  // so they render the plain home-link-only header these default to.
  user?: HeaderUser | null
  onLogout?: () => void
}

// The home link leads to schloss (schlussel has no home page of its own),
// so the badge shows schloss's own logo mark, not schlussel's - it should
// look like it goes to a different app, not display schlussel's identity
// in a slot meant for "where this link goes". No onSettings is ever
// wired here - this IS the settings destination every other service's
// header points at, so there is nowhere further for its own gear icon to
// go.
export function Header({ user, onLogout }: HeaderProps = {}) {
  return (
    <SharedHeader
      logo={
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={2}>
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      }
      homeHref={DEFAULT_APP_URL}
      homeTitle="На главную"
      user={user}
      onLogout={onLogout}
      rightSlot={<ThemeToggle />}
    />
  )
}
