import { NotFoundPage, ThemeSync } from '@zudar107/schloss-ui'
import { LoginPage } from './features/auth/LoginPage'
import { RegisterPage } from './features/auth/RegisterPage'
import { LogoutPage } from './features/auth/LogoutPage'
import { AccountPage } from './features/account/AccountPage'
import { AdminPage } from './features/admin/AdminPage'
import { DocsPage } from './features/docs/DocsPage'
import { HelpPage } from './features/help/HelpPage'
import { HeroIllustration } from './components/HeroIllustration'

export function Root() {
  const { pathname } = window.location
  let page
  // '/' and '/login' both render LoginPage - every other app's login
  // redirect points at `${schluesselUrl}/login` (see schloss-ui's
  // buildLoginUrl), so '/login' is the real, linked-to path; '/' is kept
  // as an equivalent alias for visiting Schlüssel directly.
  if (pathname === '/' || pathname === '/login') page = <LoginPage />
  else if (pathname === '/register') page = <RegisterPage />
  else if (pathname === '/logout') page = <LogoutPage />
  else if (pathname === '/account') page = <AccountPage />
  else if (pathname === '/admin') page = <AdminPage />
  else if (pathname === '/docs') page = <DocsPage />
  else if (pathname === '/help') page = <HelpPage />
  else page = <NotFoundPage homeHref="/" illustration={<HeroIllustration size={100} />} />

  return (
    <>
      <ThemeSync apiOrigin={window.location.origin} />
      {page}
    </>
  )
}
