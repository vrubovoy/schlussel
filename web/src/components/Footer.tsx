import { Footer as SharedFooter } from '@zudar107/schloss-ui'

export function Footer() {
  return <SharedFooter serviceName="Schlüssel" description="Вход и аккаунты" version={__APP_VERSION__} helpHref="/help" />
}
