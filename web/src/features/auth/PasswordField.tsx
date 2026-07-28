import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Field, ICON_SIZE } from '@zudar107/schloss-ui'

interface PasswordFieldProps {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  autoComplete?: string
  minLength?: number
  error?: string
  invalid?: boolean
}

export function PasswordField({ id, label, value, onChange, placeholder, autoComplete, minLength, error, invalid }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false)

  return (
    <Field
      id={id}
      label={label}
      type={visible ? 'text' : 'password'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      required
      minLength={minLength}
      autoComplete={autoComplete}
      error={error}
      invalid={invalid}
      suffix={
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Скрыть пароль' : 'Показать пароль'}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 4,
            display: 'flex',
            alignItems: 'center',
            color: 'var(--text-muted)',
          }}
        >
          {visible ? (
            <EyeOff size={ICON_SIZE.default} strokeWidth={2} />
          ) : (
            <Eye size={ICON_SIZE.default} strokeWidth={2} />
          )}
        </button>
      }
    />
  )
}
