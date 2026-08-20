import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Root } from '../Root'

vi.mock('../features/auth/LoginPage', () => ({ LoginPage: () => <div>login-page</div> }))
vi.mock('../features/auth/RegisterPage', () => ({ RegisterPage: () => <div>register-page</div> }))
vi.mock('../features/auth/LogoutPage', () => ({ LogoutPage: () => <div>logout-page</div> }))
vi.mock('../features/account/AccountPage', () => ({ AccountPage: () => <div>account-page</div> }))
vi.mock('../features/admin/AdminPage', () => ({ AdminPage: () => <div>admin-page</div> }))
vi.mock('../features/docs/DocsPage', () => ({ DocsPage: () => <div>docs-page</div> }))
vi.mock('../features/help/HelpPage', () => ({ HelpPage: () => <div>help-page</div> }))

function setPathname(pathname: string) {
  const original = window.location
  // @ts-expect-error -- jsdom allows reassigning location for test purposes
  delete window.location
  // @ts-expect-error -- minimal stub covering what Root reads
  window.location = { ...original, pathname, origin: 'https://auth.localhost' }
}

afterEach(() => {
  cleanup()
})

describe('Root', () => {
  it.each([
    ['/', 'login-page'],
    ['/login', 'login-page'],
    ['/register', 'register-page'],
    ['/logout', 'logout-page'],
    ['/account', 'account-page'],
    ['/admin', 'admin-page'],
    ['/docs', 'docs-page'],
    ['/help', 'help-page'],
  ])('renders the right page for %s', (pathname, expectedText) => {
    setPathname(pathname)
    render(<Root />)

    expect(screen.getByText(expectedText)).toBeInTheDocument()
  })

  it('renders the shared Not Found page for an unrecognized path', () => {
    setPathname('/does-not-exist')
    render(<Root />)

    expect(screen.getByRole('heading', { name: 'Страница не найдена' })).toBeInTheDocument()
  })
})
