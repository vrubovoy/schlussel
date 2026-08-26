import { useRef } from 'react'
import {
  Header as SharedHeader,
  ThemeToggle,
  normalizeNotificationOrigin,
  useAvatarUrl,
  useUnreadNotifications,
  type ApiClient,
  type HeaderUser,
} from '@zudar107/schloss-ui'
import { refreshSession } from '../lib/api'
import { DEFAULT_APP_URL } from '../lib/returnTo'
import { runtimeConfig } from '../lib/runtimeConfig'

interface HeaderProps {
  // Login/Register/Error/Help are public, so they render the plain header
  // these optional authentication props default to.
  user?: (HeaderUser & { id?: string }) | null
  accessToken?: string
  onAccessTokenChange?: (accessToken: string) => void
  onLogout?: () => void
}

const GLOCKE_ORIGIN = runtimeConfig.glockeUrl
const NORMALIZED_GLOCKE_ORIGIN = normalizeNotificationOrigin(GLOCKE_ORIGIN)

function unsupportedApiMethod(): Promise<never> {
  return Promise.reject(new Error('The Header API adapter only supports notification authentication'))
}

function useHeaderApiClient(
  accessToken: string | undefined,
  onAccessTokenChange: ((accessToken: string) => void) | undefined,
): ApiClient {
  const tokenRef = useRef<string | null>(accessToken || null)
  const propTokenRef = useRef(accessToken)
  const tokenGenerationRef = useRef(0)
  const onAccessTokenChangeRef = useRef(onAccessTokenChange)
  const refreshFlightRef = useRef<Promise<string | null> | null>(null)
  const clientRef = useRef<ApiClient | null>(null)
  onAccessTokenChangeRef.current = onAccessTokenChange

  if (propTokenRef.current !== accessToken) {
    propTokenRef.current = accessToken
    tokenRef.current = accessToken || null
    tokenGenerationRef.current += 1
  }

  if (!clientRef.current) {
    clientRef.current = {
      setAccessToken: (token) => {
        if (tokenRef.current === token) return
        tokenRef.current = token
        tokenGenerationRef.current += 1
      },
      getAccessToken: () => tokenRef.current,
      refreshAccessToken: () => {
        if (refreshFlightRef.current) return refreshFlightRef.current

        const expiredToken = tokenRef.current
        const refreshGeneration = tokenGenerationRef.current
        const refresh = refreshSession()
          .then(({ accessToken: refreshedToken }) => {
            if (tokenGenerationRef.current !== refreshGeneration || tokenRef.current !== expiredToken) return null
            tokenRef.current = refreshedToken
            onAccessTokenChangeRef.current?.(refreshedToken)
            return refreshedToken
          })
          .catch(() => null)
          .finally(() => {
            if (refreshFlightRef.current === refresh) refreshFlightRef.current = null
          })
        refreshFlightRef.current = refresh
        return refresh
      },
      get: unsupportedApiMethod,
      post: unsupportedApiMethod,
      put: unsupportedApiMethod,
      delete: unsupportedApiMethod,
    }
  }

  return clientRef.current
}

// The home link leads to schloss (schlussel has no home page of its own),
// so the badge shows schloss's own logo mark, not schlussel's - it should
// look like it goes to a different app, not display schlussel's identity
// in a slot meant for "where this link goes". No onSettings is ever
// wired here - this IS the settings destination every other service's
// header points at, so there is nowhere further for its own gear icon to
// go.
export function Header({ user, accessToken, onAccessTokenChange, onLogout }: HeaderProps = {}) {
  const apiClient = useHeaderApiClient(accessToken, onAccessTokenChange)
  const userId = accessToken && user && runtimeConfig.services.glocke ? user.id ?? user.name : null
  const notificationState = useUnreadNotifications({
    glockeOrigin: GLOCKE_ORIGIN,
    userId,
    apiClient,
  })
  // schlussel IS Schlüssel - the avatar it fetches for the header is
  // always its own current origin, no separate env var needed the way
  // every other app needs one to point away from itself.
  const avatarUrl = useAvatarUrl({
    schluesselOrigin: window.location.origin,
    userId,
    apiClient,
  })

  return (
    <SharedHeader
      logo={
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={2}>
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      }
      homeHref={DEFAULT_APP_URL}
      homeTitle="На главную"
      user={user ? { ...user, avatarUrl } : user}
      onLogout={onLogout}
      rightSlot={<ThemeToggle />}
      notifications={user && accessToken && NORMALIZED_GLOCKE_ORIGIN && runtimeConfig.services.glocke
        ? { href: `${NORMALIZED_GLOCKE_ORIGIN}/notifications`, state: notificationState, glockeOrigin: NORMALIZED_GLOCKE_ORIGIN, apiClient }
        : undefined}
    />
  )
}
