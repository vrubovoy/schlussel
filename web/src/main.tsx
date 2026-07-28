import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { LoginPage } from './features/auth/LoginPage'
import { RegisterPage } from './features/auth/RegisterPage'
import { LogoutPage } from './features/auth/LogoutPage'
import { AccountPage } from './features/account/AccountPage'
import { AdminPage } from './features/admin/AdminPage'
import { DocsPage } from './features/docs/DocsPage'
import { HelpPage } from './features/help/HelpPage'
import { applyTheme, getStoredTheme } from '@zudar107/schloss-ui'
import './index.css'

applyTheme(getStoredTheme())

function Root() {
  if (window.location.pathname === '/register') return <RegisterPage />
  if (window.location.pathname === '/logout') return <LogoutPage />
  if (window.location.pathname === '/account') return <AccountPage />
  if (window.location.pathname === '/admin') return <AdminPage />
  if (window.location.pathname === '/docs') return <DocsPage />
  if (window.location.pathname === '/help') return <HelpPage />
  return <LoginPage />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
