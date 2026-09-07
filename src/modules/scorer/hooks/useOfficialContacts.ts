import { useEffect, useMemo, useState } from 'react'
import { kscwApi } from '../../../lib/api'
import { useAuth } from '../../../hooks/useAuth'

export interface OfficialContact {
  phone: string | null
  email: string | null
  hide_phone: boolean
  hide_email: boolean
}

/**
 * The contacts map plus the flag that tells an *unanswered* map apart from an
 * *empty* one.
 *
 * `size === 0` on its own carries two opposite meanings — "the fetch has not
 * returned yet" and "nothing is released for this game" (the endpoint answers
 * `{}` outside the ±1h contact window, and for officials who hid their
 * details). Consumers must render an absence — or the settled "no contact"
 * state — only while `isLoading` is false, and paint a neutral placeholder
 * where the contact strip will go while it is true.
 *
 * Shaped as an augmented `Map` rather than `{ contacts, isLoading }` so the
 * existing `.size` / `.get()` call sites keep working unchanged.
 */
export type OfficialContactMap = Map<string, OfficialContact> & { readonly isLoading: boolean }

const EMPTY: Map<string, OfficialContact> = new Map()

const withLoading = (
  contacts: Map<string, OfficialContact>,
  isLoading: boolean,
): OfficialContactMap => Object.assign(new Map(contacts), { isLoading })

/**
 * Contact details (email/phone) of the officials assigned to games the current
 * coach/team-responsible has scorekeeping duty for — server-scoped per game by
 * `GET /kscw/scorer/official-contacts`.
 *
 * Admins already read member contacts via the items API, so the call is skipped
 * for them and for non-leaders (the endpoint returns {} for those anyway —
 * this just avoids a useless round-trip). Returns a Map keyed by member id,
 * carrying `isLoading` (see `OfficialContactMap`).
 */
export function useOfficialContacts(): OfficialContactMap {
  const { user, isAdmin, coachTeamIds, teamResponsibleIds, teamsLoading } = useAuth()
  const [contacts, setContacts] = useState<Map<string, OfficialContact>>(EMPTY)
  // Flipped only by the fetch callbacks, and by BOTH of them: a failed call has
  // to release the gate too, or the placeholder would never come down.
  const [settled, setSettled] = useState(false)

  const isLeader = coachTeamIds.length > 0 || teamResponsibleIds.length > 0
  const enabled = !!user && !isAdmin && isLeader && !teamsLoading

  // Poll every 60s while enabled: the contact window (1h before kickoff → 1h
  // after) opens/closes over time, so we refetch to surface/drop contacts as
  // the game approaches, and the resulting re-render re-evaluates the per-game
  // display gate in ScorerPage. A poll never re-raises `isLoading` — a refresh
  // of data we already hold is not "unknown", and blinking the contact strip
  // once a minute would be its own defect.
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const load = () => {
      kscwApi<{ data: Record<string, OfficialContact> }>('/scorer/official-contacts')
        .then((res) => {
          if (cancelled) return
          const map = new Map<string, OfficialContact>()
          for (const [id, c] of Object.entries(res?.data ?? {})) map.set(String(id), c)
          setContacts(map)
          setSettled(true)
        })
        .catch(() => {
          if (cancelled) return
          setContacts(EMPTY)
          setSettled(true)
        })
    }
    load()
    const id = setInterval(load, 60_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [enabled])

  // Never hand back contacts while disabled (logged out / lost leader role) —
  // and never a pending flag either: no call is issued for admins/non-leaders,
  // so their empty map is settled, not awaited. Memoised so the identity stays
  // stable across renders (ScorerPage keys a useMemo off it).
  return useMemo(
    () => withLoading(enabled ? contacts : EMPTY, enabled && !settled),
    [enabled, contacts, settled],
  )
}
