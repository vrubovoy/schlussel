import { describe, it, expect } from 'vitest'
import { validateName, validateEmail, validatePassword, validatePasswordsMatch } from '../lib/validation'

describe('validateName', () => {
  it('rejects an empty name', () => {
    expect(validateName('')).toBe('Введите имя')
    expect(validateName('   ')).toBe('Введите имя')
  })

  it('rejects a name containing digits', () => {
    expect(validateName('Alice2')).toBe('Имя не должно содержать цифры')
    expect(validateName('123')).toBe('Имя не должно содержать цифры')
  })

  it('rejects a name with symbols other than space/hyphen/apostrophe', () => {
    expect(validateName('Alice!')).toBe('Имя может содержать только буквы, пробел, дефис и апостроф')
    expect(validateName('Alice@test')).toBe('Имя может содержать только буквы, пробел, дефис и апостроф')
  })

  it('accepts a plain name', () => {
    expect(validateName('Alice')).toBeNull()
  })

  it('accepts Cyrillic names', () => {
    expect(validateName('Алиса')).toBeNull()
  })

  it('accepts hyphenated and apostrophe names', () => {
    expect(validateName('Anne-Marie')).toBeNull()
    expect(validateName("O'Brien")).toBeNull()
  })

  it('accepts a name with internal spaces', () => {
    expect(validateName('Mary Jane')).toBeNull()
  })
})

describe('validateEmail', () => {
  it('rejects an empty email', () => {
    expect(validateEmail('')).toBe('Введите email')
  })

  it('rejects a malformed email', () => {
    expect(validateEmail('not-an-email')).toBe('Неверный формат email')
    expect(validateEmail('missing@domain')).toBe('Неверный формат email')
    expect(validateEmail('@missinglocal.com')).toBe('Неверный формат email')
  })

  it('accepts a well-formed email', () => {
    expect(validateEmail('alice@example.com')).toBeNull()
  })
})

describe('validatePassword', () => {
  it('rejects an empty password', () => {
    expect(validatePassword('')).toBe('Введите пароль')
  })

  it('rejects a password shorter than 8 characters', () => {
    expect(validatePassword('short')).toBe('Минимум 8 символов')
  })

  it('accepts a password of exactly 8 characters', () => {
    expect(validatePassword('12345678')).toBeNull()
  })
})

describe('validatePasswordsMatch', () => {
  it('rejects when the two passwords differ', () => {
    expect(validatePasswordsMatch('password1', 'password2')).toBe('Пароли не совпадают')
  })

  it('accepts when the two passwords match', () => {
    expect(validatePasswordsMatch('password1', 'password1')).toBeNull()
  })
})
