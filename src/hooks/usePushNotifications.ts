import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { API_URL, kscwApi } from '../lib/api'
import { captureApiError } from '../lib/sentry'
import { toast } from 'sonner'

interface PushState {
  /** Browser supports push notifications */
  supported: boolean
  /** Notification permission: 'default' | 'granted' | 'denied' */
  permission: NotificationPermission
  /** Currently subscribed to push */
  subscribed: boolean
  /** Loading state during subscribe/unsubscribe */
  loading: boolean
  /**
   * The service-worker probe that fills `subscribed` is still running. Until it
   * settles, `subscribed: false` only means "not known yet" — callers must not
   * paint it as "not subscribed" or wire a handler to it.
   */
  probing: boolean
}

/**
 * Feature-detect Web Push support. Brave on Android blocks FCM with no
 * user-facing toggle to re-enable it; desktop Brave has a toggle, so only
 * exclude mobile Brave.
 */
function detectPushSupport(): boolean {
  const hasApis = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  const isBraveMobile = 'brave' in navigator && /Android|Mobile/i.test(navigator.userAgent)
  return hasApis && !isBraveMobile
}

/**
 * Hook for managing Web Push notification subscriptions.
 * Handles permission requests, SW subscription, and backend registration.
 */
export function usePushNotifications() {
  const { t } = useTranslation('notifications')
  // Support + permission are readable synchronously, so seed them in the lazy
  // initializer instead of writing them from an effect on mount.
  const [state, setState] = useState<PushState>(() => {
    const supported = detectPushSupport()
    return {
      supported,
      permission: supported ? Notification.permission : 'default',
      subscribed: false,
      loading: false,
      // Unsupported browsers never run the probe below, so they must not start
      // out probing — the toggle row is not rendered for them at all.
      probing: supported,
    }
  })

  // Whether a subscription already exists is only knowable asynchronously
  // (service-worker ready → PushManager) — that stays in an effect. It can pend
  // for hundreds of ms (serviceWorker.ready waits for an active worker, and
  // registration is fire-and-forget from sw-register.js), so `probing` marks the
  // window in which `subscribed: false` is a placeholder rather than an answer.
  useEffect(() => {
    if (!detectPushSupport()) return

    navigator.serviceWorker.ready
      .then(reg => reg.pushManager.getSubscription())
      .then(sub => {
        setState(s => ({ ...s, subscribed: !!sub, probing: false }))
      })
      // getSubscription() can reject; without this the row would stay disabled
      // forever, so a failed probe falls back to the "not subscribed" default.
      .catch(() => {
        setState(s => ({ ...s, probing: false }))
      })
  }, [])

  const subscribe = useCallback(async () => {
    // Refuse while probing — we don't yet know whether this device is already
    // subscribed, so acting on it could re-subscribe an existing endpoint.
    if (!state.supported || state.loading || state.probing) return false

    setState(s => ({ ...s, loading: true }))

    try {
      // Request permission
      const permission = await Notification.requestPermission()
      setState(s => ({ ...s, permission }))

      if (permission !== 'granted') {
        setState(s => ({ ...s, loading: false }))
        return false
      }

      // Get VAPID public key from Directus (public endpoint, no auth needed)
      const vapidResp = await fetch(`${API_URL}/kscw/web-push/vapid-public-key`)
      if (!vapidResp.ok) throw new Error(`VAPID key fetch failed: ${vapidResp.status}`)
      const { publicKey } = await vapidResp.json()

      // Subscribe via PushManager
      const reg = await navigator.serviceWorker.ready
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        // Pass Uint8Array directly — some Chrome Android versions fail with .buffer
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      })

      const subJson = subscription.toJSON()

      // Register with Directus (uses kscwApi with 401 retry)
      await kscwApi('/web-push/subscribe', {
        method: 'POST',
        body: {
          endpoint: subJson.endpoint,
          keys_p256dh: subJson.keys?.p256dh || '',
          keys_auth: subJson.keys?.auth || '',
          user_agent: navigator.userAgent,
        },
      })

      setState(s => ({ ...s, subscribed: true, loading: false }))
      return true
    } catch (err) {
      // Route to Sentry/JSONL — the browser push APIs (permission, PushManager,
      // VAPID fetch) don't go through the api.ts helpers, so console-only would
      // hide Brave/FCM blocks + quota/network failures from the error log.
      captureApiError(err, { operation: 'usePushNotifications.subscribe' })
      const msg = (err instanceof Error ? err.message : '') || ''
      // Detect push service failures (Brave blocks FCM, network issues, etc.)
      if (msg.includes('push service') || msg.includes('AbortError') || err instanceof DOMException) {
        const isBrave = 'brave' in navigator
        toast.error(isBrave ? t('pushErrorBrave') : t('pushErrorGeneric'), { duration: 8000 })
      } else {
        toast.error(t('pushSubscribeFailed'))
      }
      setState(s => ({ ...s, loading: false }))
      return false
    }
  }, [state.supported, state.loading, state.probing, t])

  const unsubscribe = useCallback(async () => {
    if (!state.supported || state.loading || state.probing) return false

    setState(s => ({ ...s, loading: true }))

    try {
      const reg = await navigator.serviceWorker.ready
      const subscription = await reg.pushManager.getSubscription()

      if (subscription) {
        const endpoint = subscription.endpoint

        // Unsubscribe from browser
        await subscription.unsubscribe()

        // Remove from Directus (uses kscwApi with 401 retry)
        await kscwApi('/web-push/unsubscribe', {
          method: 'POST',
          body: { endpoint },
        })
      }

      setState(s => ({ ...s, subscribed: false, loading: false }))
      return true
    } catch (err) {
      captureApiError(err, { operation: 'usePushNotifications.unsubscribe' })
      toast.error(t('pushUnsubscribeFailed'))
      setState(s => ({ ...s, loading: false }))
      return false
    }
  }, [state.supported, state.loading, state.probing, t])

  return {
    ...state,
    subscribe,
    unsubscribe,
  }
}

/** Convert base64url VAPID key to Uint8Array for PushManager.subscribe() */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}
