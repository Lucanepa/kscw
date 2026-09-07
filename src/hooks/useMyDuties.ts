import { useMemo } from 'react'
import type { Game, Team, BaseRecord } from '../types'
import { useCollection } from '../lib/query'
import { useAuth } from './useAuth'
import { todayLocal, toUtcIsoFromDatetimeLocal } from '../utils/dateHelpers'

/**
 * role key → the game column holding the assigned member id. Mirrors ROLE_DEFS
 * in the backend duty-late / duty-leader-contact endpoints. `bb_24s_official`
 * is the odd one out (no `_member` suffix).
 */
export const DUTY_ROLE_COLUMNS: Record<string, keyof Game> = {
  scorer: 'scorer_member',
  scoreboard: 'scoreboard_member',
  scorer_scoreboard: 'scorer_scoreboard_member',
  referee: 'referee_member',
  bb_scorer: 'bb_scorer_member',
  bb_timekeeper: 'bb_timekeeper_member',
  bb_24s_official: 'bb_24s_official',
}

/** role key → i18n key in the `scorer` namespace (shared by all duty surfaces). */
export const DUTY_ROLE_LABEL_KEYS: Record<string, string> = {
  scorer: 'scorer',
  scoreboard: 'scoreboard',
  scorer_scoreboard: 'scorerTaefeler',
  referee: 'referee',
  bb_scorer: 'bbScorer',
  bb_timekeeper: 'bbTimekeeper',
  bb_24s_official: 'bb24sOfficial',
}

/** A duty a member is on: a projection of a game's assignment for that member. */
export interface MyDuty {
  game: Game & { kscw_team?: (Team & BaseRecord) | string }
  role: string
  startMs: number | null
}

// A duty "event" lingers this long after kickoff (covers a full match) before
// it drops off — the "until the end" horizon for the banner + appointment.
export const DUTY_EVENT_DURATION_MS = 3 * 60 * 60 * 1000
// The yellow banner starts showing this far ahead of kickoff.
export const DUTY_BANNER_LEAD_MS = 7 * 24 * 60 * 60 * 1000
// The "Emergency: contact team leaders" button is live from here to +grace.
export const DUTY_EMERGENCY_LEAD_MS = 60 * 60 * 1000
export const DUTY_EMERGENCY_GRACE_MS = 30 * 60 * 1000

function startMsOf(g: Game): number | null {
  if (!g.date || !g.time) return null
  try {
    const ms = new Date(toUtcIsoFromDatetimeLocal(`${String(g.date).slice(0, 10)}T${String(g.time).slice(0, 5)}`)).getTime()
    return Number.isNaN(ms) ? null : ms
  } catch { return null }
}

/**
 * The games the logged-in member is on duty for (any role), from today onward.
 * Filters on the 7 scalar duty columns via a single `_or` (plain FK columns —
 * not an M2M walk, so no deep-filter trap). Returns one MyDuty per (game, role).
 */
export function useMyDuties() {
  const { user } = useAuth()
  const memberId = user?.id ?? ''
  const from = useMemo(() => todayLocal(), [])

  const filter = useMemo(() => {
    if (!memberId) return { id: { _eq: -1 } }
    return {
      _and: [
        { date: { _gte: from } },
        { away_team: { _nnull: true } },
        { _or: Object.values(DUTY_ROLE_COLUMNS).map((col) => ({ [col]: { _eq: memberId } })) },
      ],
    }
  }, [memberId, from])

  const { data, isLoading, refetch } = useCollection<Game & { kscw_team?: (Team & BaseRecord) | string }>('games', {
    filter,
    // hall.* so GameDetailModal can paint Venue on first render. Without it the
    // modal opened with an empty venue and filled it in only after its own
    // re-fetch landed — the one visible 'still loading' block on an open modal.
    fields: ['*', 'kscw_team.name', 'kscw_team.sport', 'hall.*'],
    sort: ['date', 'time'],
    limit: 50,
    enabled: !!memberId,
  })

  const duties = useMemo<MyDuty[]>(() => {
    const out: MyDuty[] = []
    for (const g of data ?? []) {
      for (const [role, col] of Object.entries(DUTY_ROLE_COLUMNS)) {
        const v = g[col]
        if (v != null && String(v) === String(memberId)) {
          out.push({ game: g, role, startMs: startMsOf(g) })
        }
      }
    }
    return out
  }, [data, memberId])

  return { duties, isLoading, refetch }
}
