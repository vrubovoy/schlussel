import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { LoginPage } from './features/auth/LoginPage'
import { RegisterPage } from './features/auth/RegisterPage'
import { LogoutPage } from './features/auth/LogoutPage'
import { AccountPage } from './features/account/AccountPage'
import { AdminPage } from './features/admin/AdminPage'
import { DocsPage } from './features/docs/DocsPage'
import { HelpPage } from './features/help/HelpPage'
import { applyTheme, getStoredTheme, NotFoundPage, ThemeSync } from '@zudar107/schloss-ui'
import { HeroIllustration } from './components/HeroIllustration'
import './index.css'

applyTheme(getStoredTheme())

function Root() {
  const { pathname } = window.location
  let page
  if (pathname === '/') page = <LoginPage />
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
