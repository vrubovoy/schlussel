import { Header } from '../../components/Header'
import { Footer } from '../../components/Footer'

interface Section {
  titel: string
  text: string
  screenshotSlug: string
  screenshotAlt: string
}

const SECTIONS: Section[] = [
  {
    titel: 'Регистрация по приглашению',
    text: 'Если тебе прислали ссылку вида «…/register#invite=…», просто перейди по ней — код приглашения уже будет вписан в форму. Останется заполнить остальные поля и нажать «Зарегистрироваться».',
    screenshotSlug: 'register-invite',
    screenshotAlt: 'Форма регистрации с заполненным кодом приглашения',
  },
  {
    titel: 'Смена пароля',
    text: 'В настройках аккаунта (иконка с твоим именем в правом верхнем углу любого сервиса) есть раздел «Пароль» — там нужно ввести текущий пароль и новый дважды. После смены остальные сессии завершатся, а Glocke покажет уведомление безопасности.',
    screenshotSlug: 'change-password',
    screenshotAlt: 'Карточка смены пароля в настройках аккаунта',
  },
  {
    titel: 'Активные сессии',
    text: 'Раздел «Активные сессии» показывает все устройства, где ты сейчас вошёл в систему. Можно завершить отдельную сессию (если, например, забыл выйти на чужом компьютере) или выйти сразу на всех устройствах.',
    screenshotSlug: 'sessions',
    screenshotAlt: 'Список активных сессий с кнопками завершения',
  },
  {
    titel: 'Экспорт данных',
    text: 'В настройках аккаунта есть два разных экспорта. Прямой JSON содержит только данные аккаунта Schlüssel. «ZIP всех сервисов» собирается в фоне из Schlüssel, Kuvert, Tafel, Zettel и Glocke; каждый сервис делает снимок независимо, поэтому время внутри файлов может различаться. Если часть сервисов недоступна, можно скачать частичный архив и повторить только ошибки. В manifest.json указаны состав, время, размеры, контрольные суммы и ошибки. Архив доступен только владельцу, не кэшируется, удаляется после срока хранения и ограничен квотами. В нём находятся личные данные: храни и передавай файл как конфиденциальный.',
    screenshotSlug: 'data-export',
    screenshotAlt: 'Карточки прямого JSON и фонового ZIP-экспорта всех сервисов',
  },
  {
    titel: 'Удаление аккаунта',
    text: 'В самом низу настроек аккаунта — раздел «Удалить аккаунт». Действие необратимо и требует ввода пароля для подтверждения.',
    screenshotSlug: 'delete-account',
    screenshotAlt: 'Карточка удаления аккаунта с полем пароля',
  },
  {
    titel: 'Тема оформления',
    text: 'Переключатель темы (светлая/тёмная/системная) есть в верхней панели любой страницы платформы, рядом с твоим именем.',
    screenshotSlug: 'theme-toggle',
    screenshotAlt: 'Меню переключения темы оформления',
  },
]

// Deliberately reachable without being logged in - unlike /account, /admin,
// and /docs, this is exactly where someone stuck at the login or
// registration screen needs to land.
export function HelpPage() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Header />

      <div style={{ flex: 1, background: 'var(--bg-base)', padding: '2rem 1rem' }}>
        <div style={{ maxWidth: 560, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <h1 style={{ margin: 0, fontSize: '1.375rem', fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
            Как пользоваться Schlüssel
          </h1>
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.875rem', lineHeight: 1.5 }}>
            Schlüssel — единый вход для всех сервисов платформы: один аккаунт открывает
            доступ ко всем сервисам, и настройки аккаунта тоже одни на всех.
          </p>

          <div className="card" style={{ padding: '1.5rem' }}>
            <h2 style={{ margin: '0 0 0.75rem', fontSize: '0.9375rem', fontWeight: 600, color: 'var(--text-primary)' }}>
              Первые шаги
            </h2>
            {/* Tailwind's preflight resets ol/ul to `list-style: none`, so
                the numbers need to be explicitly restored - otherwise
                paddingLeft below just looks like unexplained indentation. */}
            <ol style={{ margin: 0, paddingLeft: '1.25rem', listStyleType: 'decimal', color: 'var(--text-muted)', fontSize: '0.8125rem', lineHeight: 1.7 }}>
              <li>Зарегистрируйся (обычным способом или по ссылке-приглашению).</li>
              <li>Войди со своим email и паролем.</li>
              <li>Настройки аккаунта — в правом верхнем углу любого сервиса, под твоим именем.</li>
            </ol>
          </div>

          {SECTIONS.map((s) => (
            <div key={s.titel} className="card" style={{ padding: '1.5rem' }}>
              <h2 style={{ margin: '0 0 0.5rem', fontSize: '0.9375rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                {s.titel}
              </h2>
              <p style={{ margin: '0 0 1rem', color: 'var(--text-muted)', fontSize: '0.8125rem', lineHeight: 1.6 }}>
                {s.text}
              </p>
              {/* TODO(screenshot): drop a PNG at public/guide/schlussel-{s.screenshotSlug}.png */}
              <img
                src={`/guide/schlussel-${s.screenshotSlug}.png`}
                alt={s.screenshotAlt}
                style={{ width: '100%', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}
              />
            </div>
          ))}
        </div>
      </div>

      <Footer />
    </div>
  )
}
