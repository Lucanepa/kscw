import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { House, Link2, Plane } from 'lucide-react'
import CalendarGrid from '../../../components/CalendarGrid'
import Modal from '../../../components/Modal'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '../../../components/ui/table'
import { fetchAllItems, kscwApi } from '../../../lib/api'
import { toDateKey, getSeasonYear, formatDate } from '../../../utils/dateUtils'
import { toZurichDateString } from '../../../utils/dateHelpers'
import { relId, memberDisplayName } from '../../../utils/relations'
import type { GameSchedulingSeason, GameSchedulingSlot, GameSchedulingOpponent, Team, Absence, MemberTeam, SchedulingBlock } from '../../../types'
import type { ExpandedBooking } from '../hooks/useAdminBookings'
import CrossTeamBadge from '../../spielplanung/CrossTeamBadge'
import { useCrossTeamConflicts } from '../../spielplanung/hooks/useCrossTeamConflicts'
import { useTeamLinks } from '../hooks/useTeamLinks'
import { bbBlocksVbSlot, type BbPlacement } from '../utils/hallOccupancy'

// Season-wide overview of the Terminplanung for all teams: confirmed + proposed
// home and away games, blocked slots, and a count of remaining open home slots,
// rendered on the same month calendar the rest of the app uses. Read-only.

type EntryKind =
  | 'home_confirmed'
  | 'away_confirmed'
  | 'home_proposed'
  | 'away_proposed'
  | 'blocked'      // a reserved KWI court (derby hall hold / a planner's manual block)
  | 'team_block'   // a scheduling_blocks "no games" period for the team
  | 'club_block'   // a scheduling_global_blocks club-wide blackout (all teams)
  | 'team_event'   // a team event that blocks games that day
  | 'bb_game'      // a basketball game placed at KWI (cross-sport hall coordination)
  | 'training'     // the team's own training (single-team calendars only — context, not a blocker)

/** A real fixture out of `games` — the VolleyManager / Swiss Volley feed, which
 *  is the source of truth for what is actually being played. One row per KSCW
 *  team's perspective (a derby therefore has two). Rendered as a confirmed
 *  home/away game. With `confirmedFrom='games'` these REPLACE the entries the
 *  calendar would otherwise reconstruct from booked slots + confirmed away
 *  proposals — see the prop. */
export interface CalendarGame {
  id: number
  game_id?: string | null
  date: string
  time?: string | null
  home_team: string
  away_team: string
  kscw_team: number
  type?: string | null
  /** KWI hall — set on home legs (and on both legs of a derby, which is a home
   *  game for one of the two KSCW sides), so the day detail can name a venue. */
  hall?: number | string | null
  /** Away venue, as synced from the federation (no `halls` row exists for it). */
  away_hall_json?: { name?: string | null } | null
}

interface SchedEntry {
  id: string
  date: Date
  kind: EntryKind
  label: string
  title: string
  teamId: string
  /** HH:MM — for the day-detail table + chip prefix. */
  time?: string
  /** Opponent label (games only). */
  opponent?: string
  /** Hall / venue name. */
  hallName?: string
  /** Why this date is blocked (reserved-for reason, block reason, event title) —
   *  shown in the chip tooltip + the day-detail "Not available" list. */
  detail?: string
}

// One row in the day-detail modal table (games + open slots for a day).
interface DayRow {
  id: string
  time: string
  team: string
  /** Matchup in home-team-first order: home game → "KSCW – opp", away → "opp – KSCW". */
  match: string
  hall: string
  kind: EntryKind | 'open'
}

interface Props {
  slots: GameSchedulingSlot[]
  bookings: ExpandedBooking[]
  teams: Team[]
  season: GameSchedulingSeason
  /** Fixtures from `games` to surface on the calendar — not bookings. */
  games?: CalendarGame[]
  /** Where a CONFIRMED fixture comes from. 'bookings' (default) reconstructs it
   *  from booked slots + confirmed away proposals — right for the planner, whose
   *  job is the negotiation itself. 'games' takes it from the `games` feed
   *  instead (VolleyManager / Swiss Volley), which is what is actually being
   *  played: it also carries cup fixtures, derbies and manually placed games
   *  that never had a booking, and it reflects any date the federation moved
   *  after we booked. Booking-derived confirmed entries are suppressed then, so
   *  the two sources cannot double up. Pending proposals still come from
   *  bookings either way — they are not fixtures yet. */
  confirmedFrom?: 'bookings' | 'games'
  /** Show cross-sport context — basketball games holding a KWI court. True by
   *  default: a volleyball PLANNER needs it, because that court is then gone.
   *  False for a member-facing team calendar, where another sport's fixture is
   *  simply not this team's schedule. Also skips the `basketball_slot_plan`
   *  fetch, so a member viewing a team page does not request it at all. */
  showCrossSport?: boolean
  // Heading text — defaults to the season-wide overview title. Pass a
  // team-scoped title when rendering this inside a single team's panel.
  title?: string
  // Show per-day absent players (dashboard only). Per-team concern, so it only
  // renders on a single-team calendar (teams=[one]) — never on the all-teams
  // season overview, even when filtered to one team.
  showAbsences?: boolean
}

// Parse a 'YYYY-MM-DD' (or ISO) string into a LOCAL Date (no TZ shift) so the
// calendar-day key matches what CalendarGrid computes per cell.
const parseYmd = (s: string | null | undefined): Date | null => {
  if (!s) return null
  const m = String(s).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

// 'HH:MM:SS' (a slot time) → 'HH:MM'.
const hhmm = (s: string | null | undefined): string => (s ? String(s).slice(0, 5) : '')
// 'KWI B' → 'B'. Which COURT a basketball game takes is the whole reason its chip
// is on a volleyball calendar, and the chip has room for one letter, not a hall name.
const shortCourt = (h: string | null | undefined): string => String(h ?? '').replace(/^KWI\s*/i, '')
// A proposed datetime ('YYYY-MM-DD HH:MM:SS' or ISO 'YYYY-MM-DDTHH:MM:SS') → 'HH:MM'.
const dtTime = (s: string | null | undefined): string => {
  const m = String(s ?? '').match(/[T ](\d{2}:\d{2})/)
  return m ? m[1] : ''
}
// Weekday (Mon-Fri) game slots show 20:00 — the slot is just the hall window
// (e.g. 19:30-21:30), the weekday game is at 20:00. Weekend slots (Spielsamstag
// / junior Sunday) keep their actual start time. d is a local-midnight Date.
const slotTime = (d: Date | null | undefined, startTime: string | null | undefined): string => {
  if (!d) return hhmm(startTime)
  const dow = d.getDay() // 0=Sun..6=Sat
  return dow >= 1 && dow <= 5 ? '20:00' : hhmm(startTime)
}

const CHIP: Record<EntryKind, string> = {
  home_confirmed: 'bg-green-600 text-white',
  away_confirmed: 'bg-blue-600 text-white',
  home_proposed: 'border border-dashed border-amber-500 bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  away_proposed: 'border border-dashed border-orange-500 bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200',
  blocked: 'bg-gray-300 text-gray-600 line-through dark:bg-gray-600 dark:text-gray-300',
  team_block: 'bg-rose-200 text-rose-800 dark:bg-rose-900/50 dark:text-rose-200',
  club_block: 'bg-red-300 text-red-900 dark:bg-red-950/70 dark:text-red-100',
  team_event: 'bg-purple-200 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200',
  bb_game: 'bg-orange-500 text-white',
  training: 'bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-200',
}

// Kinds that represent "a game can't happen here" rather than a game itself.
const isBlockerKind = (k: EntryKind) => k === 'blocked' || k === 'team_block' || k === 'club_block' || k === 'team_event'
// Kinds that represent an actual game (home/away, confirmed/proposed) — used for
// the team-link co-occurrence check.
const isGameKind = (k: EntryKind) =>
  k === 'home_confirmed' || k === 'away_confirmed' || k === 'home_proposed' || k === 'away_proposed'

/** A team-link constraint surfaced on a given day: two linked teams both play. */
interface LinkWarning {
  teamAId: string
  teamBId: string
  linkType: 'same' | 'diff' | 'adjacent'
  /** 'clash' = they play the SAME time but must not overlap (red); 'note' = a
   *  'same'-linked pair plays the same day at DIFFERENT times (amber). */
  severity: 'clash' | 'note'
}

// Rows the day-level fetches below return. Each is paired with a module-level
// EMPTY constant so "not loaded yet" has a STABLE identity — the fetches are raw
// `fetchAllItems` / `kscwApi` calls (no TanStack cache), so their state is keyed
// by what it was fetched for and read back through that key; a fresh `[]` on
// every render would re-run every downstream useMemo.
interface ClosureRow { start_date: string; end_date: string; reason?: string }
interface ClubBlockRow { id: number; start_date: string; end_date: string; reason: string | null }
interface BbGameRow { id: string; date: string; time?: string | null; hall: string; team: string; opponent?: string | null }
interface TeamEventRow { id: string; title: string; start_date: string; end_date?: string | null; teamId: string }
interface TrainingRow { id: string; date: string; start_time?: string | null; team: string | number; hall_name?: string | null }

const EMPTY_CLOSURES: ClosureRow[] = []
const EMPTY_TEAM_BLOCKS: SchedulingBlock[] = []
const EMPTY_CLUB_BLOCKS: ClubBlockRow[] = []
const EMPTY_BB_GAMES: BbGameRow[] = []
const EMPTY_TEAM_EVENTS: TeamEventRow[] = []
const EMPTY_TRAININGS: TrainingRow[] = []
const EMPTY_ABSENCES: Map<string, string[]> = new Map()

/** Stand-in for the month grid while the day-level data (hall closures, club and
 *  team blocks, team events, cross-sport court holds) is still in flight. An empty
 *  closure Set is indistinguishable from "no closures" — `CalendarGrid` collapses
 *  a missing one to `false` — so painting the real grid early declares every
 *  school-holiday evening free, which is exactly the read a planner picking a home
 *  date makes. Mirrors CalendarGrid's own shape (month header, weekday strip, 6×7
 *  cells at the same min-heights) so nothing moves when the grid lands. */
function CalendarGridSkeleton({ label }: { label: string }) {
  return (
    <div className="flex flex-1 flex-col" role="status" aria-busy="true" aria-label={label}>
      {/* Month header */}
      <div className="mb-4 flex items-center justify-between">
        <div className="h-10 w-10 animate-pulse rounded-lg bg-gray-200 sm:h-9 sm:w-9 dark:bg-gray-700" />
        <div className="h-6 w-36 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
        <div className="h-10 w-10 animate-pulse rounded-lg bg-gray-200 sm:h-9 sm:w-9 dark:bg-gray-700" />
      </div>
      {/* Day-of-week headers */}
      <div className="grid grid-cols-7 border-b border-gray-200 dark:border-gray-700">
        {Array.from({ length: 7 }, (_, i) => (
          <div key={`h${i}`} className="flex justify-center py-2">
            <div className="h-4 w-7 animate-pulse rounded bg-gray-200 sm:h-5 dark:bg-gray-700" />
          </div>
        ))}
      </div>
      {/* Day grid */}
      <div className="grid flex-1 grid-cols-7 border-l border-gray-200 dark:border-gray-700" style={{ gridAutoRows: '1fr' }}>
        {Array.from({ length: 42 }, (_, i) => (
          <div
            key={`d${i}`}
            className="min-h-[3rem] border-b border-r border-gray-200 bg-white p-0.5 sm:min-h-[5rem] sm:p-1 lg:min-h-[6.5rem] lg:p-2 dark:border-gray-700 dark:bg-gray-800"
          >
            <div className="h-3 w-4 animate-pulse rounded bg-gray-200 sm:h-3.5 dark:bg-gray-700" />
          </div>
        ))}
      </div>
    </div>
  )
}

export default function SchedulingCalendar({ slots, bookings, teams, season, games = [], confirmedFrom = 'bookings', showCrossSport = true, title, showAbsences }: Props) {
  const { t } = useTranslation('gameScheduling')

  // Manual coach/player-sharing links for this season (volleyball). Fail-soft: an
  // error / missing collection just yields [] → no warnings (migration 218).
  // `isLoading` goes false on an error (and on the disabled/no-season query), so
  // using it as a gate can never strand the grid behind a permanent skeleton.
  const { links: teamLinks, isLoading: teamLinksLoading } = useTeamLinks(season.id, 'volleyball')

  const teamName = useMemo(() => {
    const m = new Map<string, string>()
    for (const tm of teams) m.set(String(tm.id), tm.name)
    return (id: string | number | null | undefined) => m.get(String(id)) || '—'
  }, [teams])

  // Season start year drives the initial month + the month pill strip.
  const startYear = useMemo(() => {
    const y = parseInt(String(season.season).slice(0, 4), 10)
    return Number.isFinite(y) ? y : getSeasonYear(new Date())
  }, [season.season])

  const [month, setMonth] = useState(() => new Date(startYear, 8, 1)) // September
  // Terminplanung runs Sep → Mar only — games are scheduled within that window,
  // so drop Apr/May and clamp navigation to the two boundary months.
  const firstMonth = useMemo(() => new Date(startYear, 8, 1), [startYear]) // September
  const lastMonth = useMemo(() => new Date(startYear + 1, 2, 1), [startYear]) // March
  // Configurable season offer window (mirrors backend seasonOfferWindow): days
  // before it opens / after it closes render black with "Season not open".
  const seasonWindow = useMemo(() => ({
    start: season.season_opens ? String(season.season_opens).slice(0, 10) : `${startYear}-09-01`,
    end: season.season_closes ? String(season.season_closes).slice(0, 10) : `${startYear + 1}-03-31`,
  }), [season.season_opens, season.season_closes, startYear])
  const outOfSeasonDates = useMemo(() => {
    const set = new Set<string>()
    const end = new Date(startYear + 1, 3, 30) // Apr 30 — covers trailing grid days
    for (const d = new Date(startYear, 7, 1); d <= end; d.setDate(d.getDate() + 1)) { // from Aug 1
      const k = toDateKey(d)
      if (k < seasonWindow.start || k > seasonWindow.end) set.add(k)
    }
    return set
  }, [seasonWindow, startYear])
  const seasonMonths = useMemo(() => {
    const out: Date[] = []
    for (let m = 8; m <= 11; m++) out.push(new Date(startYear, m, 1)) // Sep–Dec
    for (let m = 0; m <= 2; m++) out.push(new Date(startYear + 1, m, 1)) // Jan–Mar
    return out
  }, [startYear])
  // Clamp so the prev/next arrows (and pill clicks) can't leave the Sep–Mar range.
  const goMonth = (d: Date) => setMonth(d < firstMonth ? firstMonth : d > lastMonth ? lastMonth : d)

  const slotsById = useMemo(() => {
    const m = new Map<string, GameSchedulingSlot>()
    for (const s of slots) m.set(String(s.id), s)
    return m
  }, [slots])

  // Hall id → name, for the day-detail table (members + admins can read halls).
  const [halls, setHalls] = useState<{ id: number; name: string }[]>([])
  useEffect(() => {
    fetchAllItems<{ id: number; name: string }>('halls', { fields: ['id', 'name'] })
      .then(setHalls)
      .catch(() => {})
  }, [])
  const hallName = useMemo(() => {
    const m = new Map<string, string>()
    for (const h of halls) m.set(String(h.id), h.name)
    return (id: string | number | null | undefined) => (id == null ? '' : m.get(String(id)) || '')
  }, [halls])

  // Day the user clicked → detail modal (its teamFilter-applied entries).
  const [dayDetail, setDayDetail] = useState<{ date: Date; entries: SchedEntry[] } | null>(null)

  // Hall closures (gcal + school holidays) for the season — block home games, so
  // they render as a red day background. Fetched from this season's August on.
  // Tagged with the season it was fetched for: until that tag matches, the rows
  // are UNKNOWN rather than empty, and the grid waits (`dayDataPending` below)
  // instead of painting a closed school holiday as an ordinary free evening.
  const closureKey = String(startYear)
  const [closureState, setClosureState] = useState<{ key: string; rows: ClosureRow[] }>({ key: '', rows: EMPTY_CLOSURES })
  useEffect(() => {
    let cancelled = false
    fetchAllItems<ClosureRow>('hall_closures', {
      fields: ['start_date', 'end_date', 'reason'],
      filter: { end_date: { _gte: `${startYear}-08-01` } },
    })
      .then((r) => { if (!cancelled) setClosureState({ key: String(startYear), rows: r }) })
      // A FAILED fetch must release the gate too — an empty month is a wrong
      // frame, but a skeleton that never lifts is a worse one.
      .catch(() => { if (!cancelled) setClosureState({ key: String(startYear), rows: EMPTY_CLOSURES }) })
    return () => { cancelled = true }
  }, [startYear])
  const closures = closureState.key === closureKey ? closureState.rows : EMPTY_CLOSURES
  const closuresPending = closureState.key !== closureKey

  const closedDates = useMemo(() => {
    const s = new Set<string>()
    for (const c of closures) {
      const start = parseYmd(c.start_date)
      const end = parseYmd(c.end_date)
      if (!start || !end) continue
      const cur = new Date(start)
      for (let guard = 0; cur <= end && guard < 400; guard++) {
        s.add(toDateKey(cur))
        cur.setDate(cur.getDate() + 1)
      }
    }
    return s
  }, [closures])

  // date key -> closure reason (first one wins on overlapping closures).
  const closureReasons = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of closures) {
      const reason = (c.reason || '').trim()
      if (!reason) continue
      const start = parseYmd(c.start_date)
      const end = parseYmd(c.end_date)
      if (!start || !end) continue
      const cur = new Date(start)
      for (let guard = 0; cur <= end && guard < 400; guard++) {
        const key = toDateKey(cur)
        if (!m.has(key)) m.set(key, reason)
        cur.setDate(cur.getDate() + 1)
      }
    }
    return m
  }, [closures])

  const teamIds = useMemo(() => teams.map((tm) => String(tm.id)), [teams])

  // Team blocks (scheduling_blocks) — "no games" periods a coach/spielplaner set
  // for a team (e.g. "Keine Spiele (Daniela Imhof)"). The backend hard-blocks
  // every slot in the range, so without surfacing them here a date silently has
  // no slots and it's impossible to see why. Members can read scheduling_blocks.
  // Per-team only — never on the all-teams overview (teamIds.length > 1); an
  // empty key means "not applicable", which is a real none, not a pending one.
  const teamScopeKey = teamIds.length === 1 ? `${teamIds[0]}|${startYear}` : ''
  const [blockState, setBlockState] = useState<{ key: string; rows: SchedulingBlock[] }>({ key: '', rows: EMPTY_TEAM_BLOCKS })
  useEffect(() => {
    if (!teamScopeKey) return
    let cancelled = false
    fetchAllItems<SchedulingBlock>('scheduling_blocks', {
      fields: ['id', 'team', 'start_date', 'end_date', 'reason'],
      filter: { _and: [{ team: { _in: teamIds } }, { end_date: { _gte: `${startYear}-08-01` } }] },
    })
      .then((r) => { if (!cancelled) setBlockState({ key: teamScopeKey, rows: r }) })
      .catch(() => { if (!cancelled) setBlockState({ key: teamScopeKey, rows: EMPTY_TEAM_BLOCKS }) })
    return () => { cancelled = true }
  }, [teamScopeKey, teamIds, startYear])
  const blocks = blockState.key === teamScopeKey ? blockState.rows : EMPTY_TEAM_BLOCKS
  const blocksPending = teamScopeKey !== '' && blockState.key !== teamScopeKey

  // Club-wide blocked dates (scheduling_global_blocks, superadmin blackout) — no
  // HOME games for ANY team, so they're shown on every view (not team-scoped).
  // Read via the scheduling endpoint; a non-admin viewer just gets none.
  // No key to track (it fetches once), so a `loaded` flag carries the same
  // "empty means unknown until this flips" contract. Both paths set it.
  const [clubBlockState, setClubBlockState] = useState<{ loaded: boolean; rows: ClubBlockRow[] }>({ loaded: false, rows: EMPTY_CLUB_BLOCKS })
  useEffect(() => {
    let cancelled = false
    kscwApi<{ blocks: ClubBlockRow[] }>('/terminplanung/admin/club-blocked-dates')
      .then((r) => { if (!cancelled) setClubBlockState({ loaded: true, rows: r.blocks || EMPTY_CLUB_BLOCKS }) })
      .catch(() => { if (!cancelled) setClubBlockState({ loaded: true, rows: EMPTY_CLUB_BLOCKS }) })
    return () => { cancelled = true }
  }, [])
  const clubBlocks = clubBlockState.rows
  const clubBlocksPending = !clubBlockState.loaded

  // Basketball games placed at KWI this season (cross-sport hall coordination):
  // a BB game holds a court, so volleyball schedulers need to see it as "Home game
  // (BB)". Read-only + fail-soft — a non-admin viewer without basketball_slot_plan
  // read simply gets none (same pattern as clubBlocks). BB teams aren't in this
  // calendar's `teams` prop, so the team name comes from the expand / free-text label.
  // Empty key = cross-sport is off (or there is no season) — a real none.
  const bbKey = showCrossSport && season.id != null ? `bb|${season.id}` : ''
  const [bbState, setBbState] = useState<{ key: string; rows: BbGameRow[] }>({ key: '', rows: EMPTY_BB_GAMES })
  useEffect(() => {
    if (!bbKey) return
    let cancelled = false
    fetchAllItems<{ id: string; date: string; time?: string | null; hall?: string | null; opponent?: string | null; kscw_team_label?: string | null; kscw_team?: { name?: string } | null }>('basketball_slot_plan', {
      fields: ['id', 'date', 'time', 'hall', 'opponent', 'kscw_team_label', 'kscw_team.name'],
      filter: { season: { _eq: season.id } },
      // A viewer without basketball_slot_plan read is the expected case here,
      // not a bug — see the `optional` contract on fetchItems.
      optional: true,
    })
      .then((rows) => {
        if (cancelled) return
        setBbState({ key: bbKey, rows: rows.map((r) => ({
          id: String(r.id), date: r.date, time: r.time, hall: r.hall || '',
          team: r.kscw_team?.name || r.kscw_team_label || '', opponent: r.opponent,
        })) })
      })
      .catch(() => { if (!cancelled) setBbState({ key: bbKey, rows: EMPTY_BB_GAMES }) })
    return () => { cancelled = true }
  }, [bbKey, season.id])
  const bbGames = bbState.key === bbKey ? bbState.rows : EMPTY_BB_GAMES
  const bbGamesPending = bbKey !== '' && bbState.key !== bbKey

  // Team events that block games (a tournament weekend, a team trip). The backend
  // drops every slot whose date falls in a linked event, so they too vanish
  // silently — surface them. M2M-safe: fetch the junction first (events_teams by
  // teams_id), then the events by id (never walk the alias in a filter).
  const [teamEventState, setTeamEventState] = useState<{ key: string; rows: TeamEventRow[] }>({ key: '', rows: EMPTY_TEAM_EVENTS })
  useEffect(() => {
    // Per-team only — never on the all-teams overview (teamIds.length > 1).
    if (!teamScopeKey) return
    let cancelled = false
    ;(async () => {
      try {
        const links = await fetchAllItems<{ events_id: unknown; teams_id: unknown }>('events_teams', {
          fields: ['events_id', 'teams_id'], filter: { teams_id: { _in: teamIds } },
        })
        const eventToTeams = new Map<string, Set<string>>()
        for (const l of links) {
          const eid = String(relId(l.events_id as never)); const tid = String(relId(l.teams_id as never))
          if (!eid || eid === 'null') continue
          const set = eventToTeams.get(eid) ?? new Set<string>(); set.add(tid); eventToTeams.set(eid, set)
        }
        const eventIds = [...eventToTeams.keys()]
        if (eventIds.length === 0) { if (!cancelled) setTeamEventState({ key: teamScopeKey, rows: EMPTY_TEAM_EVENTS }); return }
        const evs = await fetchAllItems<{ id: string; title: string; start_date: string; end_date?: string | null }>('events', {
          fields: ['id', 'title', 'start_date', 'end_date'],
          filter: { _and: [{ id: { _in: eventIds } }, { start_date: { _lte: `${startYear + 1}-04-30` } }, { start_date: { _gte: `${startYear}-08-01` } }] },
        })
        const flat: TeamEventRow[] = []
        for (const ev of evs) {
          for (const tid of eventToTeams.get(String(ev.id)) ?? []) {
            flat.push({ id: String(ev.id), title: ev.title, start_date: ev.start_date, end_date: ev.end_date, teamId: tid })
          }
        }
        if (!cancelled) setTeamEventState({ key: teamScopeKey, rows: flat })
      } catch {
        if (!cancelled) setTeamEventState({ key: teamScopeKey, rows: EMPTY_TEAM_EVENTS })
      }
    })()
    return () => { cancelled = true }
  }, [teamScopeKey, teamIds, startYear])
  const teamEvents = teamEventState.key === teamScopeKey ? teamEventState.rows : EMPTY_TEAM_EVENTS
  const teamEventsPending = teamScopeKey !== '' && teamEventState.key !== teamScopeKey

  // The team's own trainings — the scheduling calendar is game data, but on a
  // single team's calendar the training evenings give the week its rhythm, so
  // they render as faint context chips (a training is NOT a blocker: those same
  // evenings double as the team's home-game slots). Cancelled ones are skipped.
  // Fail-soft: a viewer without `trainings` read simply gets none.
  const [trainingState, setTrainingState] = useState<{ key: string; rows: TrainingRow[] }>({ key: '', rows: EMPTY_TRAININGS })
  useEffect(() => {
    // Per-team only — never on the all-teams overview (teamIds.length > 1).
    if (!teamScopeKey) return
    let cancelled = false
    fetchAllItems<TrainingRow>('trainings', {
      fields: ['id', 'date', 'start_time', 'team', 'hall_name'],
      filter: { _and: [
        { team: { _in: teamIds } },
        { cancelled: { _neq: true } },
        { date: { _gte: `${startYear}-08-01` } },
        { date: { _lte: `${startYear + 1}-04-30` } },
      ] },
    })
      .then((r) => { if (!cancelled) setTrainingState({ key: teamScopeKey, rows: r }) })
      .catch(() => { if (!cancelled) setTrainingState({ key: teamScopeKey, rows: EMPTY_TRAININGS }) })
    return () => { cancelled = true }
  }, [teamScopeKey, teamIds, startYear])
  const trainings = trainingState.key === teamScopeKey ? trainingState.rows : EMPTY_TRAININGS
  const trainingsPending = teamScopeKey !== '' && trainingState.key !== teamScopeKey

  // Every per-day tint / chip source above starts out UNKNOWN, and each renders
  // its absence identically to "there is nothing here" — a closed hall as a free
  // evening, a club blackout as a bookable day, a basketball court hold as an
  // empty court. They all fire on mount and land within a tick of each other, so
  // the grid waits for the set rather than reflowing three times. Every branch
  // (including every failure) tags its state, so this always releases.
  const dayDataPending =
    closuresPending || clubBlocksPending || blocksPending || bbGamesPending
    || teamEventsPending || trainingsPending || teamLinksLoading

  // slot id -> opponent label, from confirmed home bookings (so a booked slot
  // shows who it's against).
  const oppBySlot = useMemo(() => {
    const m = new Map<string, string>()
    for (const b of bookings) {
      if (b.type !== 'home_slot_pick' || b.status !== 'confirmed' || !b.slot) continue
      const opp = typeof b.opponent === 'object' ? (b.opponent as GameSchedulingOpponent) : null
      const slotId = typeof b.slot === 'object' ? String((b.slot as GameSchedulingSlot).id) : String(b.slot)
      m.set(slotId, opp?.team_name || opp?.club_name || '')
    }
    return m
  }, [bookings])

  // Team filter — empty Set = all teams shown.
  const [teamFilter, setTeamFilter] = useState<Set<string>>(new Set())

  // The single team to show absences for (dashboard only): the lone team when
  // this calendar is team-scoped, or the one selected in the filter. null when
  // absences are off or more/less than one team is in view.
  const absenceTeamId = useMemo(() => {
    if (!showAbsences) return null
    if (teams.length === 1) return String(teams[0].id)
    return null
  }, [showAbsences, teams])

  // Roster-sharing teams that already play a given day block a home slot for this
  // team — surfaced per-day as a sky badge, exactly like absences. Same gate as
  // absences (single team-scoped calendar); the hook no-ops on an empty id list,
  // so the season overview never fetches.
  const crossTeamIds = useMemo(() => (absenceTeamId ? [absenceTeamId] : []), [absenceTeamId])
  const { byDate: crossTeamByDate, isLoading: crossTeamLoading } = useCrossTeamConflicts(crossTeamIds)
  // The `.length > 0` AND keeps the pending pill off the all-teams overview,
  // where the hook no-ops (empty map there is a real none, not an unknown).
  const crossTeamPending = crossTeamIds.length > 0 && crossTeamLoading

  // Per-team blockers (team blocks "no games", team events, absences, wishes) are
  // ONLY meaningful on a single team's calendar — showing them on the all-teams
  // season overview is misleading noise. True only when this calendar is scoped
  // to exactly one team (the per-team admin panel + the member team calendar).
  const isTeamScoped = teams.length === 1

  // date key -> number of distinct team members unavailable that day (blocking
  // absences affecting games). Fetched per-team via a single-level junction walk
  // (member_teams → members) then absences by member, per the M2M-safe pattern.
  // date key -> sorted names of members unavailable that day (so a click/hover
  // can show WHO, not just how many).
  // Tagged with the team+season it was fetched for, mirroring useCrossTeamConflicts:
  // the walk is two sequential round trips deep, so an untagged empty map would
  // read as "nobody on this team is away all season" for as long as it runs — the
  // exact opposite of what the badge exists to say. Deriving the map from the tag
  // also drops the map on its own when the calendar stops being team-scoped, so the
  // old adjust-state-during-render reset is no longer needed.
  const absenceKey = absenceTeamId ? `${absenceTeamId}|${startYear}` : ''
  const [absenceState, setAbsenceState] = useState<{ key: string; byDate: Map<string, string[]> }>({ key: '', byDate: EMPTY_ABSENCES })
  useEffect(() => {
    if (!absenceTeamId) return
    let cancelled = false
    ;(async () => {
      try {
        const links = await fetchAllItems<MemberTeam>('member_teams', {
          fields: ['member'], filter: { team: { _eq: absenceTeamId } },
        })
        const memberIds = [...new Set(links.map((l) => relId(l.member)).filter(Boolean))]
        if (memberIds.length === 0) { if (!cancelled) setAbsenceState({ key: absenceKey, byDate: EMPTY_ABSENCES }); return }
        const winStart = `${startYear}-08-01`
        const winEnd = `${startYear + 1}-03-31`
        const [members, abs] = await Promise.all([
          fetchAllItems<{ id: string; first_name?: string; last_name?: string; nickname?: string | null }>('members', {
            fields: ['id', 'first_name', 'last_name', 'nickname'], filter: { id: { _in: memberIds } },
          }),
          fetchAllItems<Absence & { member?: string | { id: string } }>('absences', {
            fields: ['id', 'member', 'start_date', 'end_date', 'type', 'days_of_week', 'affects', 'blocking'],
            filter: { _and: [{ member: { _in: memberIds } }, { end_date: { _gte: winStart } }, { start_date: { _lte: winEnd } }] },
          }),
        ])
        const nameById = new Map<string, string>()
        for (const m of members) {
          const nm = memberDisplayName(m)
          nameById.set(String(m.id), nm || String(m.id))
        }
        const lo = new Date(startYear, 7, 1) // Aug 1
        const hi = new Date(startYear + 1, 2, 31) // Mar 31
        const byDate = new Map<string, Set<string>>()
        const add = (key: string, mid: string) => {
          const set = byDate.get(key) ?? new Set<string>()
          set.add(mid); byDate.set(key, set)
        }
        for (const a of abs) {
          // Count only real, blocking absences: skip not-blocking ones and skip
          // weekly recurring "unavailabilities" (those aren't absences).
          if ((a as { blocking?: boolean }).blocking === false) continue
          if (a.type === 'weekly') continue
          const affects = (a as { affects?: string[] }).affects
          if (Array.isArray(affects) && affects.length > 0 && !affects.includes('all') && !affects.includes('games')) continue
          const mid = String(relId(a.member as never))
          const s0 = parseYmd(a.start_date); const e0 = parseYmd(a.end_date)
          if (!s0 || !e0) continue
          const from = s0 < lo ? lo : s0
          const to = e0 > hi ? hi : e0
          for (let d = new Date(from), guard = 0; d <= to && guard < 400; d.setDate(d.getDate() + 1), guard++) {
            add(toDateKey(d), mid)
          }
        }
        const names = new Map<string, string[]>()
        for (const [k, set] of byDate) {
          names.set(k, [...set].map((mid) => nameById.get(mid) || mid).sort((a, b) => a.localeCompare(b)))
        }
        if (!cancelled) setAbsenceState({ key: absenceKey, byDate: names })
      } catch {
        // A failed walk still tags the key: the badge then honestly says "none",
        // and the day cell stays clickable, rather than pulsing for ever.
        if (!cancelled) setAbsenceState({ key: absenceKey, byDate: EMPTY_ABSENCES })
      }
    })()
    return () => { cancelled = true }
  }, [absenceKey, absenceTeamId, startYear])
  const absencesByDate = absenceState.key === absenceKey ? absenceState.byDate : EMPTY_ABSENCES
  const absencesPending = absenceKey !== '' && absenceState.key !== absenceKey

  const entries = useMemo<SchedEntry[]>(() => {
    const out: SchedEntry[] = []
    const oppLabel = (b: ExpandedBooking) => {
      const o = typeof b.opponent === 'object' ? (b.opponent as GameSchedulingOpponent) : null
      return o?.team_name || o?.club_name || ''
    }

    // Dates on which an intra-club derby reserves the gym (a source='derby' slot).
    // On those evenings the whole KWI gym (A+B) is held for the derby, so a blocked
    // KWI court there is a derby reservation — NOT the basketball Friday split.
    const derbyDates = new Set(
      slots
        .filter((s) => (s as { source?: string }).source === 'derby')
        .map((s) => { const dd = parseYmd(s.date); return dd ? toDateKey(dd) : '' })
        .filter(Boolean),
    )

    // Slots: booked = confirmed home game; blocked = blocked.
    for (const s of slots) {
      const d = parseYmd(s.date)
      if (!d) continue
      // 'derby' slots only RESERVE the hall — the matchup is shown via the games
      // table (intra-club), so don't render them here (would double the entry).
      if ((s as { source?: string }).source === 'derby') continue
      const team = teamName(s.kscw_team)
      const tid = String(s.kscw_team ?? '')
      // The booked slot says a home game was agreed HERE; the `games` row says
      // what is being played. When games are authoritative the slot would only
      // duplicate it (or contradict it, if the federation moved the date).
      if (s.status === 'booked' && confirmedFrom === 'games') continue
      if (s.status === 'booked') {
        const opp = oppBySlot.get(String(s.id))
        out.push({
          id: `slot-${s.id}`,
          date: d,
          kind: 'home_confirmed',
          label: team,
          teamId: tid,
          time: slotTime(d, s.start_time),
          opponent: opp,
          hallName: hallName(s.hall),
          title: `${t('legendHomeConfirmed')}: ${team}${opp ? ` vs ${opp}` : ''} · ${slotTime(d, s.start_time)}`,
        })
      } else if (s.status === 'blocked') {
        // A blocked slot is either a derby hall reservation (the gym is held A+B for
        // an intra-club derby that evening) or a manual planner block (pre-season
        // window, hall given away, …) — the DB stores no reason, so don't invent
        // one. Chip just says "Reserved"; the tooltip/detail says which case it is.
        const reason = derbyDates.has(toDateKey(d)) ? t('reservedForDerby') : t('blockedByPlanners')
        out.push({ id: `slot-${s.id}`, date: d, kind: 'blocked', label: t('reserved'), teamId: tid, time: slotTime(d, s.start_time), hallName: hallName(s.hall), detail: reason, title: `${reason} · ${team}` })
      }
    }

    // Bookings: away confirmed + home/away proposals (pending).
    for (const b of bookings) {
      const opp = oppLabel(b)
      const tid = typeof b.opponent === 'object' ? String((b.opponent as GameSchedulingOpponent).kscw_team ?? '') : ''
      const team = typeof b.opponent === 'object' ? teamName((b.opponent as GameSchedulingOpponent).kscw_team) : '—'
      const place = (n: number) => (b as Record<string, unknown>)[`proposed_place_${n}`] as string | undefined
      if (b.type === 'away_proposal' && b.status === 'confirmed' && b.confirmed_proposal) {
        if (confirmedFrom === 'games') continue // the `games` row is the fixture
        const dt = (b as Record<string, unknown>)[`proposed_datetime_${b.confirmed_proposal}`] as string | undefined
        const d = parseYmd(dt)
        if (d) out.push({ id: `awc-${b.id}`, date: d, kind: 'away_confirmed', label: team, teamId: tid, time: dtTime(dt), opponent: opp, hallName: place(b.confirmed_proposal) || '', title: `${t('legendAwayConfirmed')}: ${team}${opp ? ` @ ${opp}` : ''}` })
      } else if (b.type === 'away_proposal' && b.status === 'pending') {
        for (const n of [1, 2, 3]) {
          const dt = (b as Record<string, unknown>)[`proposed_datetime_${n}`] as string | undefined
          const d = parseYmd(dt)
          if (d) out.push({ id: `awp-${b.id}-${n}`, date: d, kind: 'away_proposed', label: team, teamId: tid, time: dtTime(dt), opponent: opp, hallName: place(n) || '', title: `${t('legendAwayProposed')}: ${team}${opp ? ` @ ${opp}` : ''}` })
        }
      } else if (b.type === 'home_slot_pick' && b.status === 'pending') {
        for (const n of [1, 2, 3]) {
          const sid = (b as Record<string, unknown>)[`proposed_slot_${n}`]
          if (sid == null) continue
          const sl = slotsById.get(String(sid))
          const d = parseYmd(sl?.date)
          if (d) out.push({ id: `hmp-${b.id}-${n}`, date: d, kind: 'home_proposed', label: team, teamId: tid, time: slotTime(d, sl?.start_time), opponent: opp, hallName: hallName(sl?.hall), title: `${t('legendHomeProposed')}: ${team}${opp ? ` vs ${opp}` : ''}` })
        }
      }
    }

    // Real fixtures out of `games` (one row per team's perspective). With
    // confirmedFrom='games' this is THE source of confirmed games; on the
    // planner it is the top-up for what has no booking behind it (derbies, cup).
    const shortName = (n: string) => String(n).replace(/^KSC Wiedikon\s+/, '')
    for (const g of games) {
      const d = parseYmd(g.date)
      if (!d) continue
      const me = teamName(g.kscw_team)
      const isHome = g.type !== 'away'
      const opp = shortName(isHome ? g.away_team : g.home_team)
      const time = g.time ? hhmm(g.time) : ''
      // Home legs sit in a KWI hall (an FK); away legs carry the federation's
      // venue as free text — there is no `halls` row for an opponent's gym. A
      // derby's away leg is the exception: it IS played in a KWI hall.
      const venue = isHome ? hallName(g.hall) : (g.away_hall_json?.name || hallName(g.hall))
      if (isHome) {
        out.push({ id: `g-${g.id}`, date: d, kind: 'home_confirmed', label: me, teamId: String(g.kscw_team), time, opponent: opp, hallName: venue, title: `${t('legendHomeConfirmed')}: ${me} vs ${opp}` })
      } else {
        out.push({ id: `g-${g.id}`, date: d, kind: 'away_confirmed', label: me, teamId: String(g.kscw_team), time, opponent: opp, hallName: venue, title: `${t('legendAwayConfirmed')}: ${me} @ ${opp}` })
      }
    }

    // Team blocks (scheduling_blocks) — one chip per day in the range so the whole
    // "no games" period is visible and the reason is one click/hover away. Days
    // already outside the season window are skipped: that stretch is drawn as the
    // off-season band, which says "no games" more plainly than 13 stacked chips,
    // and the day is not clickable there anyway (so nothing is hidden by it).
    for (const bl of blocks) {
      const start = parseYmd(bl.start_date); const end = parseYmd(bl.end_date)
      if (!start || !end) continue
      const tid = String(bl.team)
      const team = teamName(bl.team)
      const reason = (bl.reason || '').trim()
      for (let d = new Date(start), guard = 0; d <= end && guard < 400; d.setDate(d.getDate() + 1), guard++) {
        if (outOfSeasonDates.has(toDateKey(d))) continue
        out.push({
          id: `blk-${bl.id}-${toDateKey(d)}`, date: new Date(d), kind: 'team_block', label: t('blockNoGames'),
          teamId: tid, detail: reason || undefined,
          title: `${t('blockNoGames')}${reason ? `: ${reason}` : ''} · ${team}`,
        })
      }
    }

    // Club-wide blocked dates (scheduling_global_blocks) — one chip per day, no
    // team (applies to all). The itemsByDate guard shows them regardless of the
    // team filter so they appear on every view.
    for (const cb of clubBlocks) {
      const start = parseYmd(cb.start_date); const end = parseYmd(cb.end_date)
      if (!start || !end) continue
      const reason = (cb.reason || '').trim()
      for (let d = new Date(start), guard = 0; d <= end && guard < 400; d.setDate(d.getDate() + 1), guard++) {
        if (outOfSeasonDates.has(toDateKey(d))) continue
        out.push({
          id: `cblk-${cb.id}-${toDateKey(d)}`, date: new Date(d), kind: 'club_block', label: t('clubBlockLegend'),
          teamId: '', detail: reason || undefined,
          title: `${t('clubBlockLegend')}${reason ? `: ${reason}` : ''}`,
        })
      }
    }

    // Team events that block games (tournament weekend, team trip). events.*_date
    // are timestamptz stored at midnight Europe/Zurich (e.g. 22:00Z in summer), so
    // parseYmd's UTC `.slice(0,10)` would land a day early (Sat→Fri). Pin to the
    // Zurich calendar day first so a Sat+Sun weekend renders Sat+Sun.
    for (const ev of teamEvents) {
      const start = parseYmd(toZurichDateString(ev.start_date))
      const end = parseYmd(toZurichDateString(ev.end_date || ev.start_date))
      if (!start || !end) continue
      const team = teamName(ev.teamId)
      const ttl = (ev.title || '').trim()
      for (let d = new Date(start), guard = 0; d <= end && guard < 400; d.setDate(d.getDate() + 1), guard++) {
        out.push({
          id: `ev-${ev.id}-${ev.teamId}-${toDateKey(d)}`, date: new Date(d), kind: 'team_event', label: ttl || t('teamEventLabel'),
          teamId: ev.teamId, detail: ttl || undefined,
          title: `${t('teamEventLabel')}${ttl ? `: ${ttl}` : ''} · ${team}`,
        })
      }
    }

    // Basketball games placed at KWI (cross-sport). Not tied to a volleyball team, so
    // teamId is empty and itemsByDate shows them regardless of the team filter.
    for (const g of bbGames) {
      const d = parseYmd(g.date)
      if (!d) continue
      const time = g.time ? hhmm(g.time) : ''
      out.push({
        id: `bb-${g.id}`, date: d, kind: 'bb_game', label: g.team || t('legendHomeBb'),
        teamId: '', time, opponent: g.opponent || undefined, hallName: g.hall || '',
        // The court belongs in the tooltip even though the chip shows it: WHICH
        // floor is gone is the fact a volleyball planner acts on.
        title: `${t('legendHomeBb')}: ${g.team}${g.opponent ? ` vs ${g.opponent}` : ''}`
          + `${g.hall ? ` · ${g.hall}` : ''}${time ? ` · ${time}` : ''}`,
      })
    }

    // Trainings — pushed LAST so on busy days the game chips win the 3-visible
    // cut and trainings fold into the "+N" overflow. Single-team calendars only
    // (the fetch is gated, so this is empty elsewhere).
    for (const tr of trainings) {
      const d = parseYmd(tr.date)
      if (!d) continue
      const team = teamName(tr.team)
      const time = hhmm(tr.start_time)
      out.push({
        id: `tr-${tr.id}`, date: d, kind: 'training', label: t('legendTraining'),
        teamId: String(tr.team), time, hallName: tr.hall_name || '',
        title: `${t('legendTraining')} · ${team}${time ? ` · ${time}` : ''}`,
      })
    }
    return out
  }, [slots, bookings, slotsById, oppBySlot, teamName, hallName, t, games, confirmedFrom, blocks, clubBlocks, outOfSeasonDates, teamEvents, bbGames, trainings])

  // Team-link warnings per day: when two manually-linked teams (Settings → Team
  // links) both have games on the same day. A 'diff'/'adjacent' pair at the SAME
  // time is a clash (shared players can't be in both); a 'same' pair at DIFFERENT
  // times is a note (they're meant to play together). Both teams' games must be
  // present, so this is meaningful on the all-teams overview; a single-team
  // calendar simply won't have the partner's games and shows nothing.
  const linkWarningsByDate = useMemo<Map<string, LinkWarning[]>>(() => {
    const result = new Map<string, LinkWarning[]>()
    if (teamLinks.length === 0) return result
    // dateKey → teamId → set of game times ('HH:MM'; '' when a proposal has no time).
    const timesByDateTeam = new Map<string, Map<string, Set<string>>>()
    for (const e of entries) {
      if (!isGameKind(e.kind) || !e.teamId) continue
      const k = toDateKey(e.date)
      let perTeam = timesByDateTeam.get(k)
      if (!perTeam) { perTeam = new Map(); timesByDateTeam.set(k, perTeam) }
      const set = perTeam.get(e.teamId) ?? new Set<string>()
      set.add(e.time || '')
      perTeam.set(e.teamId, set)
    }
    for (const [dateKey, perTeam] of timesByDateTeam) {
      const warnings: LinkWarning[] = []
      for (const l of teamLinks) {
        const a = String(l.team_a)
        const b = String(l.team_b)
        const aTimes = perTeam.get(a)
        const bTimes = perTeam.get(b)
        if (!aTimes || !bTimes) continue // both teams must play that day
        // Shared concrete time (ignore the '' unknown-time placeholder).
        let sharedTime = false
        for (const tm of aTimes) if (tm && bTimes.has(tm)) { sharedTime = true; break }
        const type = l.link_type
        if (sharedTime && type !== 'same') {
          warnings.push({ teamAId: a, teamBId: b, linkType: type, severity: 'clash' })
        } else if (!sharedTime && type === 'same') {
          warnings.push({ teamAId: a, teamBId: b, linkType: type, severity: 'note' })
        }
      }
      if (warnings.length) result.set(dateKey, warnings)
    }
    return result
  }, [teamLinks, entries])

  // Teams that actually appear in the calendar, for the filter chips.
  const filterableTeams = useMemo(() => {
    const ids = new Set(entries.map((e) => e.teamId).filter(Boolean))
    return teams.filter((tm) => ids.has(String(tm.id))).sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  }, [entries, teams])

  // Remaining open home slots per day (de-emphasised count, not chips).
  // Basketball placements by date, for the open-slot maths below.
  const bbByDate = useMemo(() => {
    const m = new Map<string, BbPlacement[]>()
    for (const g of bbGames) {
      const d = parseYmd(g.date)
      if (!d) continue
      const k = toDateKey(d)
      const arr = m.get(k) ?? []
      arr.push({ hall: g.hall, time: g.time ?? null })
      m.set(k, arr)
    }
    return m
  }, [bbGames])

  /**
   * Does a placed basketball game hold this slot's court?
   *
   * A KWI court under a basketball game is not an open volleyball slot, so counting it
   * as one invites the planner to book a double. The backend refuses such a booking and
   * stops offering the slot (migration 346); this is the same predicate in TypeScript,
   * from `hallOccupancy.ts`, so the count on screen matches what can actually be booked.
   *
   * Empty whenever `showCrossSport` is off (a member-facing team calendar never fetches
   * basketball), which leaves the count exactly as it was before.
   */
  const bbTakesSlot = useMemo(() => (s: GameSchedulingSlot, dateKey: string): boolean => {
    const placements = bbByDate.get(dateKey)
    if (!placements?.length) return false
    return bbBlocksVbSlot(placements, { hall: hallName(s.hall), start: s.start_time, end: s.end_time })
  }, [bbByDate, hallName])

  const openByDate = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of slots) {
      if (s.status !== 'available') continue
      if (!(teamFilter.size === 0 || teamFilter.has(String(s.kscw_team)))) continue
      const d = parseYmd(s.date)
      if (!d) continue
      const k = toDateKey(d)
      if (bbTakesSlot(s, k)) continue
      m.set(k, (m.get(k) || 0) + 1)
    }
    return m
  }, [slots, teamFilter, bbTakesSlot])

  const itemsByDate = useMemo(() => {
    const map = new Map<string, SchedEntry[]>()
    for (const e of entries) {
      // Club blocks + basketball games aren't tied to a volleyball team, so they
      // ignore the team filter (always shown).
      if (e.kind !== 'club_block' && e.kind !== 'bb_game' && !(teamFilter.size === 0 || teamFilter.has(e.teamId))) continue
      const k = toDateKey(e.date)
      const arr = map.get(k) ?? []
      arr.push(e)
      map.set(k, arr)
    }
    return map
  }, [entries, teamFilter])

  // Highlight configured game-Saturdays (Spielsamstage) like the other calendars.
  const highlightedDates = useMemo(() => {
    const s = new Set<string>()
    for (const sat of season.spielsamstage || []) {
      const d = parseYmd(sat?.date)
      if (d) s.add(toDateKey(d))
    }
    return s
  }, [season.spielsamstage])

  const legend: { kind: EntryKind; label: string }[] = [
    { kind: 'home_confirmed', label: t('legendHomeConfirmed') },
    { kind: 'away_confirmed', label: t('legendAwayConfirmed') },
    { kind: 'home_proposed', label: t('legendHomeProposed') },
    { kind: 'away_proposed', label: t('legendAwayProposed') },
    { kind: 'blocked', label: t('reserved') },
    // Basketball games at KWI — shown on every view (cross-sport) when any exist.
    ...(bbGames.length ? [{ kind: 'bb_game' as EntryKind, label: t('legendHomeBb') }] : []),
    // Club-wide blackout — shown on every view (not team-scoped) when any exist.
    ...(clubBlocks.length ? [{ kind: 'club_block' as EntryKind, label: t('clubBlockLegend') }] : []),
    // "No games" + event blockers are per-team only — keep them out of the
    // all-teams overview legend too.
    ...(isTeamScoped ? [
      // Only when one actually renders: a team whose sole block is the pre-season
      // stretch now shows the off-season band instead, and a legend swatch for a
      // chip that appears nowhere on the grid is just a puzzle.
      ...(entries.some((e) => e.kind === 'team_block') ? [{ kind: 'team_block' as EntryKind, label: t('blockNoGames') }] : []),
      { kind: 'team_event' as EntryKind, label: t('teamEventLabel') },
    ] : []),
    // Trainings are per-team context chips — only in the legend when any render.
    ...(isTeamScoped && trainings.length ? [{ kind: 'training' as EntryKind, label: t('legendTraining') }] : []),
  ]

  const KIND_LABEL = useMemo<Record<EntryKind | 'open', string>>(() => ({
    home_confirmed: t('legendHomeConfirmed'),
    away_confirmed: t('legendAwayConfirmed'),
    home_proposed: t('legendHomeProposed'),
    away_proposed: t('legendAwayProposed'),
    blocked: t('reserved'),
    team_block: t('blockNoGames'),
    club_block: t('clubBlockLegend'),
    team_event: t('teamEventLabel'),
    bb_game: t('legendHomeBb'),
    training: t('legendTraining'),
    open: t('legendOpen'),
  }), [t])

  // Rows for the day-detail modal: the day's games, the things that block a game
  // that day (reserved courts, team blocks, events), the still-open slots, and who
  // is absent.
  const dayRows = useMemo<{ games: DayRow[]; blockers: { id: string; team: string; label: string; detail: string }[]; open: DayRow[]; absent: string[] }>(() => {
    if (!dayDetail) return { games: [], blockers: [], open: [], absent: [] }
    const key = toDateKey(dayDetail.date)
    const games: DayRow[] = dayDetail.entries
      .filter((e) => !isBlockerKind(e.kind))
      .map((e) => {
        // BB games carry their team name in `label` (BB teams aren't in `teams`).
        const team = e.kind === 'bb_game' ? e.label : teamName(e.teamId)
        const opp = e.opponent || ''
        // Home-team first: for an away game the opponent hosts, so it goes left.
        const isAway = e.kind === 'away_confirmed' || e.kind === 'away_proposed'
        const match = opp ? (isAway ? `${opp} – ${team}` : `${team} – ${opp}`) : team
        return { id: e.id, time: e.time || '', team, match, hall: e.hallName || '', kind: e.kind }
      })
      .sort((a, b) => a.time.localeCompare(b.time))
    const blockers = dayDetail.entries
      .filter((e) => isBlockerKind(e.kind))
      .map((e) => ({ id: e.id, team: teamName(e.teamId), label: KIND_LABEL[e.kind], detail: e.detail || '' }))
    const open: DayRow[] = slots
      .filter((s) => s.status === 'available'
        && (teamFilter.size === 0 || teamFilter.has(String(s.kscw_team)))
        && toDateKey(parseYmd(s.date) ?? new Date(0)) === key
        // Same rule as the cell's count — a court basketball holds is not open.
        && !bbTakesSlot(s, key))
      .map((s) => { const team = teamName(s.kscw_team); return { id: `open-${s.id}`, time: slotTime(parseYmd(s.date), s.start_time), team, match: team, hall: hallName(s.hall), kind: 'open' as const } })
      .sort((a, b) => a.team.localeCompare(b.team) || a.time.localeCompare(b.time))
    const absent = absencesByDate.get(key) || []
    return { games, blockers, open, absent }
  }, [dayDetail, slots, teamFilter, teamName, hallName, absencesByDate, KIND_LABEL, bbTakesSlot])

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
      <h2 className="mb-3 text-lg font-semibold text-gray-900 dark:text-gray-100">{title ?? t('overviewTitle')}</h2>

      {/* Legend */}
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-gray-600 dark:text-gray-300">
        {legend.map((l) => (
          <span key={l.kind} className="inline-flex items-center gap-1.5">
            <span className={`inline-block h-3 w-3 rounded ${CHIP[l.kind]}`} />
            {l.label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded bg-gray-100 ring-1 ring-gray-300 dark:bg-gray-700 dark:ring-gray-500" />
          {t('legendOpen')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded bg-gold-200 dark:bg-gold-500/40" />
          {t('spielsamstag')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded bg-red-200 dark:bg-red-900" />
          {t('legendClosed')}
        </span>
        {linkWarningsByDate.size > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded bg-rose-500" />
            <Link2 className="h-3.5 w-3.5" aria-hidden="true" />{t('legendTeamLink')}
          </span>
        )}
      </div>

      {/* Team filter (multi-select; none selected = all shown) */}
      {filterableTeams.length > 1 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => setTeamFilter(new Set())}
            className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
              teamFilter.size === 0
                ? 'bg-gold-400 text-brand-900'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
            }`}
          >
            {t('allTeams')}
          </button>
          {filterableTeams.map((tm) => {
            const on = teamFilter.has(String(tm.id))
            return (
              <button
                key={tm.id}
                onClick={() =>
                  setTeamFilter((prev) => {
                    const next = new Set(prev)
                    if (next.has(String(tm.id))) next.delete(String(tm.id))
                    else next.add(String(tm.id))
                    return next
                  })
                }
                aria-pressed={on}
                className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                  on
                    ? 'bg-gold-400 text-brand-900'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
                }`}
              >
                {tm.name}
              </button>
            )
          })}
        </div>
      )}

      {/* Season month quick navigation */}
      <div className="mb-3 flex flex-wrap gap-1">
        {seasonMonths.map((m) => {
          const isActive = m.getMonth() === month.getMonth() && m.getFullYear() === month.getFullYear()
          return (
            <button
              key={m.toISOString()}
              onClick={() => goMonth(m)}
              className={`rounded px-2.5 py-1.5 text-sm font-medium transition-colors sm:px-2 sm:py-1 sm:text-xs ${
                isActive
                  ? 'bg-gold-400 text-brand-900'
                  : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-300 dark:hover:bg-gray-700'
              }`}
            >
              {formatDate(m, 'MMM')}
            </button>
          )
        })}
      </div>

      {dayDataPending ? (
        <CalendarGridSkeleton label={t('common:loading')} />
      ) : (
      <CalendarGrid
        month={month}
        onMonthChange={goMonth}
        minMonth={firstMonth}
        maxMonth={lastMonth}
        itemsByDate={itemsByDate}
        closedDates={closedDates}
        closedLabel={t('hallClosure')}
        closureReasons={closureReasons}
        highlightedDates={highlightedDates}
        highlightClassName="bg-gold-100 dark:bg-gold-500/20"
        highlightLabel={t('spielsamstag')}
        outOfSeasonDates={outOfSeasonDates}
        outOfSeasonLabel={t('offSeasonBand')}
        onDayClick={(date, items) => {
          const open = openByDate.get(toDateKey(date)) || 0
          const absent = absencesByDate.get(toDateKey(date))?.length || 0
          const linkWarns = linkWarningsByDate.get(toDateKey(date))?.length || 0
          // The cell already looks clickable (CalendarGrid derives that from the
          // month alone), so while an overlay is still unknown a day that is about
          // to say "3 absent" must open the detail modal — which fills in live —
          // instead of silently swallowing the tap.
          if (!absencesPending && !crossTeamPending
            && items.length === 0 && open === 0 && absent === 0 && linkWarns === 0) return
          setDayDetail({ date, entries: items })
        }}
        renderDayContent={(date, items) => {
          const key = toDateKey(date)
          const visible = items.slice(0, 3)
          const hidden = items.length - visible.length
          const open = openByDate.get(key) || 0
          const absentNames = absencesByDate.get(key) || []
          const crossTeam = crossTeamByDate.get(key) || []
          const linkWarns = linkWarningsByDate.get(key) || []
          const hasClash = linkWarns.some((w) => w.severity === 'clash')
          return (
            <div className="flex flex-col gap-0.5">
              {visible.map((e) => {
                // Home/away games get a glyph instead of the old "@" prefix:
                // a house for home legs, a plane (travel) for away legs.
                const isHomeKind = e.kind === 'home_confirmed' || e.kind === 'home_proposed'
                const isAwayKind = e.kind === 'away_confirmed' || e.kind === 'away_proposed'
                // A team-scoped calendar repeats the same team name on every
                // chip, so the informative half of a fixture there is the
                // opponent — show that instead. The season overview keeps the
                // team name (its primary axis is which team plays when).
                // Only for THIS team's own fixtures: a basketball chip's label is
                // a different team, not a repeated own name, so swapping it for
                // its opponent loses the one thing that chip is there to say.
                const chipText = isTeamScoped && (isHomeKind || isAwayKind) && e.opponent ? e.opponent : e.label
                return (
                  <span
                    key={e.id}
                    title={e.title}
                    className={`flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] leading-tight ${CHIP[e.kind]}`}
                  >
                    {e.time && <span className="shrink-0 tabular-nums">{e.time}</span>}
                    {isHomeKind && <House className="h-2.5 w-2.5 shrink-0" aria-hidden />}
                    {isAwayKind && <Plane className="h-2.5 w-2.5 shrink-0" aria-hidden />}
                    <span className="truncate">{chipText}</span>
                    {/* Which court a basketball game takes is what a volleyball
                        planner needs from that chip — one letter, always visible. */}
                    {e.kind === 'bb_game' && e.hallName && (
                      <span className="shrink-0 font-semibold opacity-90">{shortCourt(e.hallName)}</span>
                    )}
                  </span>
                )
              })}
              {hidden > 0 && (
                <span className="text-[10px] text-gray-500 dark:text-gray-400">+{hidden}</span>
              )}
              {open > 0 && (
                <span className="text-[10px] text-gray-400 dark:text-gray-500" title={t('legendOpen')}>
                  {t('openCount', { count: open })}
                </span>
              )}
              {/* Absence + cross-team row. Stays mounted while either overlay is
                  still unknown, so an unknown count reads as a pending pill rather
                  than as "nobody is away" — and so the link-warning badge below it
                  doesn't jump down when the answer lands. */}
              {(absentNames.length > 0 || crossTeam.length > 0 || absencesPending || crossTeamPending) && (
                <div className="flex flex-col gap-0.5">
                  {absencesPending ? (
                    <span
                      role="img"
                      aria-label={t('common:loading')}
                      className="h-3 w-12 animate-pulse rounded-full bg-rose-100 dark:bg-rose-900/40"
                    />
                  ) : absentNames.length > 0 ? (
                    <span className="text-[10px] text-rose-500 dark:text-rose-400" title={t('absentPlayers', { names: absentNames.join(', ') })}>
                      {t('absentCount', { count: absentNames.length })}
                    </span>
                  ) : null}
                  {crossTeamPending ? (
                    <span
                      role="img"
                      aria-label={t('common:loading')}
                      className="h-3 w-6 animate-pulse rounded-full bg-sky-100 dark:bg-sky-900/40"
                    />
                  ) : crossTeam.length > 0 ? (
                    <div className="flex">
                      <CrossTeamBadge conflicts={crossTeam} />
                    </div>
                  ) : null}
                </div>
              )}
              {linkWarns.length > 0 && (
                <span
                  className={`inline-flex w-fit items-center gap-0.5 rounded px-1 py-0.5 text-[10px] leading-tight ${
                    hasClash
                      ? 'bg-rose-500 text-white'
                      : 'bg-amber-200 text-amber-900 dark:bg-amber-900/50 dark:text-amber-200'
                  }`}
                  title={linkWarns
                    .map((w) =>
                      t(w.severity === 'clash' ? 'linkClashDetail' : 'linkSameDayDetail', {
                        a: teamName(w.teamAId),
                        b: teamName(w.teamBId),
                      }),
                    )
                    .join('\n')}
                >
                  <Link2 className="h-3 w-3" aria-hidden="true" />{linkWarns.length}
                </span>
              )}
            </div>
          )
        }}
      />
      )}

      {/* Day-detail modal — time / team / opponent / hall in a table */}
      <Modal
        open={!!dayDetail}
        onClose={() => setDayDetail(null)}
        title={dayDetail ? formatDate(dayDetail.date, 'EEEE, d MMMM yyyy') : ''}
        size="lg"
      >
        {dayDetail && (
          <div className="space-y-4">
            {dayRows.games.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('colTime')}</TableHead>
                    <TableHead>{t('colMatch')}</TableHead>
                    <TableHead>{t('colHall')}</TableHead>
                    <TableHead>{t('colType')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dayRows.games.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap tabular-nums">{r.time || '—'}</TableCell>
                      <TableCell className="font-medium">{r.match}</TableCell>
                      <TableCell>{r.hall || '—'}</TableCell>
                      <TableCell>
                        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                          <span className={`inline-block h-2.5 w-2.5 rounded ${CHIP[r.kind as EntryKind]}`} />
                          <span className="text-xs">{KIND_LABEL[r.kind]}</span>
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('dayNoGames')}</p>
            )}

            {/* Anything that blocks a game that day: reserved courts, team blocks, events. */}
            {dayRows.blockers.length > 0 && (
              <div className="rounded-md border border-rose-200 bg-rose-50 p-3 dark:border-rose-900 dark:bg-rose-900/20">
                <p className="text-xs font-semibold text-rose-700 dark:text-rose-300">{t('blockedHeading')}</p>
                <ul className="mt-1.5 space-y-1">
                  {dayRows.blockers.map((b) => (
                    <li key={b.id} className="flex flex-wrap items-baseline gap-x-2 text-xs text-rose-700 dark:text-rose-300">
                      <span className="font-medium">{b.team}</span>
                      <span>{b.label}{b.detail ? ` — ${b.detail}` : ''}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Who is unavailable that day (single-team calendars only). While the
                absence walk is still running the block keeps its place with a
                pulsing line — a day opened from a pending cell must not look like
                a day with nobody away. */}
            {absencesPending ? (
              <div className="rounded-md border border-rose-200 bg-rose-50 p-3 dark:border-rose-900 dark:bg-rose-900/20">
                <span
                  role="img"
                  aria-label={t('common:loading')}
                  className="block h-3 w-48 max-w-full animate-pulse rounded bg-rose-200 dark:bg-rose-900/60"
                />
              </div>
            ) : dayRows.absent.length > 0 && (
              <div className="rounded-md border border-rose-200 bg-rose-50 p-3 dark:border-rose-900 dark:bg-rose-900/20">
                <p className="text-xs font-medium text-rose-700 dark:text-rose-300">{t('absentPlayers', { names: dayRows.absent.join(', ') })}</p>
              </div>
            )}

            {/* Team-link warnings: linked teams both playing this day. */}
            {(() => {
              const warns = linkWarningsByDate.get(toDateKey(dayDetail.date)) || []
              if (warns.length === 0) return null
              return (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-900/20">
                  <p className="flex items-center gap-1 text-xs font-semibold text-amber-800 dark:text-amber-300"><Link2 className="h-3.5 w-3.5" aria-hidden="true" />{t('linkWarnHeading')}</p>
                  <ul className="mt-1.5 space-y-1">
                    {warns.map((w) => (
                      <li
                        key={`${w.teamAId}-${w.teamBId}`}
                        className={`text-xs ${w.severity === 'clash' ? 'text-rose-700 dark:text-rose-300' : 'text-amber-800 dark:text-amber-300'}`}
                      >
                        {t(w.severity === 'clash' ? 'linkClashDetail' : 'linkSameDayDetail', {
                          a: teamName(w.teamAId),
                          b: teamName(w.teamBId),
                        })}
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })()}

            {dayRows.open.length > 0 && (
              <details className="group">
                <summary className="cursor-pointer text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('openSlotsHeading', { count: dayRows.open.length })}
                </summary>
                <div className="mt-2 max-h-72 overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('colTime')}</TableHead>
                        <TableHead>{t('colTeam')}</TableHead>
                        <TableHead>{t('colHall')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {dayRows.open.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell className="whitespace-nowrap tabular-nums">{r.time || '—'}</TableCell>
                          <TableCell className="font-medium">{r.team}</TableCell>
                          <TableCell>{r.hall || '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </details>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
