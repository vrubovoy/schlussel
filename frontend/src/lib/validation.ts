// Shared client-side field validation - returns a Russian error message or
// null when valid. Purely a UX layer (instant, precise feedback pointing
// at the actual field) - the server re-validates everything itself
// regardless, so there's no security reliance on any of this.

export function validateName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Введите имя'
  if (/\d/.test(trimmed)) return 'Имя не должно содержать цифры'
  if (!/^[\p{L}][\p{L}\s'-]*$/u.test(trimmed)) {
    return 'Имя может содержать только буквы, пробел, дефис и апостроф'
  }
  return null
}

export function validateEmail(email: string): string | null {
  const trimmed = email.trim()
  if (!trimmed) return 'Введите email'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return 'Неверный формат email'
  return null
}

export function validatePassword(password: string): string | null {
  if (!password) return 'Введите пароль'
  if (password.length < 8) return 'Минимум 8 символов'
  return null
}

export function validatePasswordsMatch(password: string, confirmPassword: string): string | null {
  if (password !== confirmPassword) return 'Пароли не совпадают'
  return null
}
