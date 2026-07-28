import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HelpPage } from '../features/help/HelpPage'

describe('HelpPage', () => {
  it('renders the guide heading with no login/session check', () => {
    render(<HelpPage />)
    expect(screen.getByText('Как пользоваться Schlüssel')).toBeInTheDocument()
  })

  it('renders a heading for every documented section', () => {
    render(<HelpPage />)
    expect(screen.getByText('Регистрация по приглашению')).toBeInTheDocument()
    expect(screen.getByText('Смена пароля')).toBeInTheDocument()
    expect(screen.getByText('Активные сессии')).toBeInTheDocument()
    expect(screen.getByText('Удаление аккаунта')).toBeInTheDocument()
    expect(screen.getByText('Тема оформления')).toBeInTheDocument()
  })
})
