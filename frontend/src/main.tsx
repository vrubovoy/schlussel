import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { LoginPage } from './features/auth/LoginPage'
import { RegisterPage } from './features/auth/RegisterPage'
import { LogoutPage } from './features/auth/LogoutPage'
import { AccountPage } from './features/account/AccountPage'
import { AdminPage } from './features/admin/AdminPage'
import { DocsPage } from './features/docs/DocsPage'
import { HelpPage } from './features/help/HelpPage'
import { applyTheme, getStoredTheme, ThemeSync } from '@zudar107/schloss-ui'
import './index.css'

applyTheme(getStoredTheme())

function Root() {
  let page
  if (window.location.pathname === '/register') page = <RegisterPage />
  else if (window.location.pathname === '/logout') page = <LogoutPage />
  else if (window.location.pathname === '/account') page = <AccountPage />
  else if (window.location.pathname === '/admin') page = <AdminPage />
  else if (window.location.pathname === '/docs') page = <DocsPage />
  else if (window.location.pathname === '/help') page = <HelpPage />
  else page = <LoginPage />

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
