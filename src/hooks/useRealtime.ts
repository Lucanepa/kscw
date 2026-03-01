import { useEffect, useRef } from 'react'
import type { RecordModel, RecordSubscription } from 'pocketbase'
import pb from '../pb'

type RealtimeAction = 'create' | 'update' | 'delete'

export function useRealtime<T extends RecordModel>(
  collection: string,
  callback: (data: RecordSubscription<T>) => void,
  actions?: RealtimeAction[],
) {
  const callbackRef = useRef(callback)
  callbackRef.current = callback

  const actionsRef = useRef(actions)
  actionsRef.current = actions

  useEffect(() => {
    let cancelled = false
    let unsubscribe: (() => void) | undefined

    pb.collection(collection)
      .subscribe('*', (e: RecordSubscription<T>) => {
        if (!actionsRef.current || actionsRef.current.includes(e.action as RealtimeAction)) {
          callbackRef.current(e)
        }
      })
      .then((unsub) => {
        if (cancelled) unsub()
        else unsubscribe = unsub
      })

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [collection])
}
