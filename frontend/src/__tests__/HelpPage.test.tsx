import { beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HelpPage } from '../features/help/HelpPage'

describe('HelpPage', () => {
  const mockFetch = vi.fn()

  beforeEach(() => {
    mockFetch.mockReset()
    vi.stubGlobal('fetch', mockFetch)
  })

  it('renders the guide heading with no login/session check', () => {
    render(<HelpPage />)
    expect(screen.getByText('Как пользоваться Schlüssel')).toBeInTheDocument()
    expect(mockFetch).not.toHaveBeenCalled()
    expect(document.querySelector('a[href*="glocke"]')).not.toBeInTheDocument()
  })

  it('renders a heading for every documented section', () => {
    render(<HelpPage />)
    expect(screen.getByText('Регистрация по приглашению')).toBeInTheDocument()
    expect(screen.getByText('Смена пароля')).toBeInTheDocument()
    expect(screen.getByText('Активные сессии')).toBeInTheDocument()
    expect(screen.getByText('Удаление аккаунта')).toBeInTheDocument()
    expect(screen.getByText('Тема оформления')).toBeInTheDocument()
  })

  it('documents Schrank and Herold in the platform archive', () => {
    render(<HelpPage />)
    const exportGuide = screen.getByText(/ZIP всех сервисов/i)
    expect(exportGuide).toHaveTextContent('Schrank')
    expect(exportGuide).toHaveTextContent('Herold')
  })

  it('renders "Первые шаги" as a heading followed by a visibly numbered ordered list of the three steps', () => {
    render(<HelpPage />)

    const heading = screen.getByText('Первые шаги')
    expect(heading.tagName).toBe('H2')

    // Walk up from the heading to the nearest ancestor that also contains
    // the <ol>, regardless of how the section/div wrapper is structured.
    let container: HTMLElement | null = heading.parentElement
    while (container && !container.querySelector('ol')) {
      container = container.parentElement
    }
    expect(container).not.toBeNull()

    const ol = container!.querySelector('ol') as HTMLOListElement
    expect(ol).toBeInTheDocument()

    // jsdom doesn't render visual list markers, so assert numbering is
    // active via the inline style directly rather than a visual check.
    expect(ol.style.listStyleType).toBe('decimal')
    expect(ol.style.listStyleType).not.toBe('none')
    expect(ol.style.listStyleType).not.toBe('')

    const step1 = screen.getByText(/Зарегистрируйся/)
    const step2 = screen.getByText(/Войди со своим email и паролем/)
    const step3 = screen.getByText(/Настройки аккаунта/)

    expect(ol).toContainElement(step1)
    expect(ol).toContainElement(step2)
    expect(ol).toContainElement(step3)

    expect(ol.querySelectorAll('li')).toHaveLength(3)
  })
})
