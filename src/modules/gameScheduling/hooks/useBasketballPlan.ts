import { useCallback, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createRecord, deleteRecord, updateRecord, kscwApi } from '../../../lib/api'
import { useCollection } from '../../../lib/query'
import { useAuth } from '../../../hooks/useAuth'
import { useTeamLinks } from './useTeamLinks'
import { useBasketballTeamRules } from './useBasketballTeamRules'
import { adjacentGameDate, restGapApplies } from '../utils/basketballRules'
import type {
  GameSchedulingSeason,
  Team,
  Hall,
  HallClosure,
  GameSchedulingSlot,
  BasketballSlotPlan,
  BasketballHallAvailability,
  Game,
} from '../../../types'
import {
  probasketConfigForSeason,
  probasketCandidateDates,
  parseYmd,
  toYmd,
  slotsForDate,
  HALL_A,
  HALL_B,
  HALL_C,
  HALL_AB,
  type CandidateDate,
  type ProbasketSeasonConfig,
} from '../utils/probasketSeason'
import {
  hallStatusAt,
  dayHallAvailability,
  hallFloors,
  bbGameBlocksPitch,
  type HallBlockers,
  type VbBooking,
  type BbGame,
  type DateBlockReason,
} from '../utils/hallOccupancy'

export type SlotStatus = 'unavailable' | 'vb' | 'game' | 'bbgame' | 'free'

/**
 * A basketball fixture from `games` — home or away — with the raw row kept so the
 * calendar can hand it straight to the edit modal.
 *
 * ⚠ This is the OTHER road a basketball game can take (see the fixturesQ comment below).
 * `placements` are the planner's own `basketball_slot_plan` rows; these are fixtures.
 */
export interface BbFixture {
  id: string
  /** 'YYYY-MM-DD' */
  date: string
  /** 'HH:MM' — may be empty; a fixture whose time is not agreed yet still holds its date. */
  time: string
  type: 'home' | 'away'
  /** teams.id as a string, or null when the row has no KSCW team. */
  team: string | null
  /** The other club, whichever column it sits in. */
  opponent: string
  /** Our hall for a home game, the opponent's gym for an away one. Often blank. */
  venue: string
  /** The untouched row — `editingGame` for ManualGameModal. */
  game: Game
}

export interface HallCell {
  hall: string
  status: SlotStatus
  placement: BasketballSlotPlan | null
  /** This A/B half is covered by a combined 'KWI A+B' placement. */
  viaCombined?: boolean
  /** Set on status 'bbgame': the `games` fixture standing on this court. */
  fixture?: BbGame
}

export interface DateInfo {
  /** ProBasket blackout label (Ferien/Sperrdaten), or null. */
  blackout: string | null
  /** Hall names closed that day ('*' = all halls). */
  closedHalls: Set<string>
  /** Club-wide blackout day (superadmin block). */
  clubBlocked: boolean
  /**
   * Nothing can be placed on this date — a ProBasket blackout, a club-wide block, a
   * hall closure, OR volleyball holding every court at every pitch. The last case is
   * the one the day-granular model used to hide behind an empty card.
   */
  fullyBlocked: boolean
  /** Why (`reason`) and, for a blackout/closure, which one (`reasonDetail`). */
  reason: DateBlockReason | null
  reasonDetail: string | null
}

export interface PlaceGameInput {
  kscw_team?: string | number | null
  kscw_team_label?: string | null
  opponent?: string | null
  sex?: 'm' | 'f' | 'mixed' | null
  game_type?: 'home' | 'guest'
  note?: string | null
}

interface ClubBlock { start_date: string; end_date: string; reason?: string | null }

export const slotKey = (date: string, time: string, hall: string) => `${date}|${time}|${hall}`
const availKey = (teamId: string | number, date: string) => `${teamId}|${date}`

function eachDay(start: string, end: string, cb: (ymd: string) => void) {
  const last = parseYmd(end)
  for (const d = parseYmd(start); d <= last; d.setDate(d.getDate() + 1)) cb(toYmd(d))
}

export interface BasketballPlanOptions {
  /**
   * The selected team's `teams.bb_source_id`. ProBasket publishes a DIFFERENT
   * availability window per league (the 1.-Liga grid runs to 09.05.2027, the junior
   * one stops on 13.12.2026), so the candidate-date grid is per team. Omitted →
   * the documented junior-regional default.
   */
  bbSourceId?: string | number | null
}

/**
 * Slot-grid planner data for the Basketball prep view: candidate dates, per-date
 * blackout/closure info, per-(date,time,hall) status (unavailable / vb / game / free)
 * with A+B combined-court occupancy, plus placement + availability writers.
 */
export function useBasketballPlan(season: GameSchedulingSeason | null, opts: BasketballPlanOptions = {}) {
  const { user } = useAuth()
  const seasonId = season?.id ?? null
  const bbSourceId = opts.bbSourceId ?? null
  const config = useMemo<ProbasketSeasonConfig | null>(
    () => probasketConfigForSeason(season?.season, { bbSourceId }),
    [season?.season, bbSourceId],
  )
  const candidateDates = useMemo<CandidateDate[]>(
    () => (config ? probasketCandidateDates(config) : []),
    [config],
  )
  const hasSeason = seasonId != null && !!config
  /**
   * Closures/blockers are fetched season-wide (from 1 August of the season's first
   * year) rather than from the selected team's grid start: the export can hold a
   * junior AND a senior sheet in one workbook, and those two grids do not overlap.
   */
  const seasonFloor = useMemo(() => {
    const y = parseInt(String(season?.season ?? '').slice(0, 4), 10)
    return Number.isFinite(y) ? `${y}-08-01` : null
  }, [season?.season])

  const teamsQ = useCollection<Team>('teams', {
    filter: { sport: { _eq: 'basketball' }, active: { _eq: true } },
    fields: ['id', 'name', 'league', 'gender', 'sport', 'active', 'bb_source_id'],
    sort: ['name'],
    all: true,
    staleTime: 60_000,
  })
  const planQ = useCollection<BasketballSlotPlan>('basketball_slot_plan', {
    filter: { season: { _eq: seasonId } },
    fields: ['*'],
    all: true,
    enabled: hasSeason,
  })
  const availQ = useCollection<BasketballHallAvailability>('basketball_hall_availability', {
    filter: { season: { _eq: seasonId } },
    fields: ['*'],
    all: true,
    enabled: hasSeason,
  })
  // Coach/player-sharing links (sport-agnostic collection, migration 218).
  const { links, partnersByTeam, addLink, updateLink, removeLink } = useTeamLinks(
    hasSeason ? seasonId : null,
    'basketball',
  )
  // The club's per-team constraint matrix — read here for ONE field, `category`, which
  // decides whether the rest gap binds (juniors are exempt). Same query key as the
  // settings panel's, so react-query serves both from one fetch.
  const { byTeam: rulesByTeam } = useBasketballTeamRules(hasSeason ? seasonId : null)
  const hallsQ = useCollection<Hall>('halls', { fields: ['id', 'name'], sort: ['name'], all: true, staleTime: 120_000 })
  const closuresQ = useCollection<HallClosure>('hall_closures', {
    fields: ['hall', 'start_date', 'end_date', 'reason', 'source'],
    filter: seasonFloor ? { end_date: { _gte: seasonFloor } } : undefined,
    all: true,
    enabled: !!seasonFloor,
  })
  const vbSlotsQ = useCollection<GameSchedulingSlot>('game_scheduling_slots', {
    filter: { season: { _eq: seasonId }, status: { _eq: 'booked' } },
    // end_time matters: without it a 13:30 volleyball match would block a 20:00
    // basketball game (see utils/hallOccupancy.ts).
    fields: ['id', 'date', 'status', 'hall', 'start_time', 'end_time'],
    all: true,
    enabled: hasSeason,
  })
  /**
   * The teams' fixtures, straight from `games` — BOTH sides.
   *
   * ⚠ A fixture is NOT a `basketball_slot_plan` row and must never become one: that
   * table is keyed to a KWI pitch (`hall` NOT NULL, unique per season/date/time/hall) and
   * one of its three triggers files a `basketball_floor_claims` row — an away row would
   * claim a KWI floor and take a court off volleyball for a game played in the opponent's
   * gym. `games` is the fixture table; the planner reads it and edits it in place.
   *
   * ⚠⚠ HOME rows used to be filtered out here (`type = 'away'`), which is why prod's
   * `games` 585 — Lions D1 vs RJ Lakers, KWI A+B, 19.09.2026 — appeared NOWHERE in the
   * basketball section while occupying the club's biggest court. Home basketball games
   * arrive by two roads: a placement the planner makes in the grid, and a `games` row
   * (the Spielplanung editor, and everything bp-sync scrapes out of Basketplan). Both
   * must be visible, and both must hold their floor — migration 351 does the same on the
   * volleyball side of the wall.
   *
   * ⚠ Filtered by an explicit `kscw_team _in` over the basketball teams already loaded
   * above, rather than by walking `kscw_team.sport`. A plain `_in` on an M2O cannot
   * interact with a policy filter the way a walked relation can (CLAUDE.md → "M2M deep
   * filter + policy walk = silent empty"), and the ids are free — we have them.
   */
  const bbTeamIds = useMemo(() => (teamsQ.data ?? []).map((t) => t.id), [teamsQ.data])
  const fixturesQ = useCollection<Game>('games', {
    filter: {
      season: { _eq: season?.season ?? '' },
      kscw_team: { _in: bbTeamIds },
    },
    // Everything ManualGameModal needs to open in edit mode — a fixture the planner
    // can see but not correct is the whole complaint this list exists to answer.
    fields: [
      'id', 'date', 'time', 'type', 'kscw_team', 'home_team', 'away_team',
      'away_hall_json', 'hall', 'additional_halls', 'league', 'round', 'season',
      'source', 'status', 'auto_confirm_rsvp', 'auto_nomination_list',
    ],
    all: true,
    enabled: hasSeason && !!season?.season && bbTeamIds.length > 0,
  })

  const clubBlocksQ = useQuery<ClubBlock[]>({
    queryKey: ['bb-prep', 'club-blocked-dates'],
    queryFn: async () => {
      try {
        const res = await kscwApi<{ blocks: ClubBlock[] }>('/terminplanung/admin/club-blocked-dates')
        return res?.blocks ?? []
      } catch {
        return []
      }
    },
    staleTime: 60_000,
  })

  const teams = useMemo(() => teamsQ.data ?? [], [teamsQ.data])

  const hallNameMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const h of hallsQ.data ?? []) m.set(String(h.id), h.name)
    return m
  }, [hallsQ.data])

  /**
   * Every basketball fixture in `games` for this season, display-resolved once.
   *
   * The raw row rides along (`game`) so the calendar can open the edit modal without a
   * second fetch — before 03.09.2026 a planner who set a game to the wrong side had no
   * way to correct it anywhere in the basketball section.
   */
  const fixtures = useMemo<BbFixture[]>(
    () =>
      (fixturesQ.data ?? [])
        .filter((g) => !!g.date)
        .map((g) => {
          const isHome = g.type === 'home'
          return {
            id: String(g.id),
            date: String(g.date).slice(0, 10),
            time: String(g.time ?? '').slice(0, 5),
            type: isHome ? ('home' as const) : ('away' as const),
            team: g.kscw_team == null ? null : String(g.kscw_team),
            // On an away row `home_team` is the OPPONENT and `away_team` is us; on a
            // home row it is the other way round. Resolved here so no view has to know.
            opponent: (isHome ? g.away_team : g.home_team) ?? '',
            venue: isHome
              ? hallNameMap.get(String(g.hall)) ?? ''
              : (g.away_hall_json as { name?: string } | null)?.name ?? '',
            game: g,
          }
        })
        .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)),
    [fixturesQ.data, hallNameMap],
  )

  /**
   * date → the KWI floors our own HOME fixtures hold, one entry per physical floor.
   *
   * One entry per floor rather than per game, so a KWI A+B fixture (stored as hall =
   * KWI A plus additional_halls [KWI B]) blocks A, B and the combined court alike
   * without anybody having to re-derive the A+B identity. Mirrors migration 351's
   * `basketball_game_floor_claims`, which does exactly this for the volleyball side.
   */
  const bbGameBusyByDate = useMemo(() => {
    const floorHall: Record<string, string> = { A: HALL_A, B: HALL_B, C: HALL_C }
    const m = new Map<string, BbGame[]>()
    for (const f of fixtures) {
      if (f.type !== 'home') continue
      const g = f.game
      const extra = Array.isArray(g.additional_halls)
        ? g.additional_halls.map((v) =>
            hallNameMap.get(String(typeof v === 'object' && v !== null && 'id' in v ? (v as { id: unknown }).id : v)) ?? '',
          )
        : []
      const floors = new Set<string>([
        ...hallFloors(hallNameMap.get(String(g.hall)) ?? ''),
        ...extra.flatMap((n) => hallFloors(n)),
      ])
      if (floors.size === 0) continue // played somewhere that is not our floor
      const teamLabel = teamsQ.data?.find((tm) => String(tm.id) === f.team)?.name ?? ''
      const label = [teamLabel, f.opponent].filter(Boolean).join(' vs ')
      const arr = m.get(f.date) ?? []
      for (const floor of floors) {
        arr.push({ hall: floorHall[floor]!, time: f.time || null, label })
      }
      m.set(f.date, arr)
    }
    return m
  }, [fixtures, hallNameMap, teamsQ.data])

  /**
   * Season-wide per-date blockers (closures, club blackouts, booked volleyball slots)
   * — deliberately NOT limited to the selected team's candidate dates, because the
   * export resolves a different date grid per team from the very same blockers.
   */
  const blockers = useMemo<HallBlockers>(() => {
    const closedHallsByDate = new Map<string, Set<string>>()
    for (const c of closuresQ.data ?? []) {
      const hn = c.hall ? hallNameMap.get(String(c.hall)) ?? null : null
      eachDay(c.start_date, c.end_date, (ymd) => {
        const set = closedHallsByDate.get(ymd) ?? new Set<string>()
        set.add(hn ?? '*')
        closedHallsByDate.set(ymd, set)
      })
    }
    const clubBlockedDates = new Set<string>()
    for (const b of clubBlocksQ.data ?? []) eachDay(b.start_date, b.end_date, (ymd) => clubBlockedDates.add(ymd))

    const vbBusyByDate = new Map<string, VbBooking[]>()
    for (const s of vbSlotsQ.data ?? []) {
      const hn = hallNameMap.get(String(s.hall))
      if (!hn) continue
      const arr = vbBusyByDate.get(s.date) ?? []
      // start_time null → hallOccupancy blocks the whole day (never silently free).
      arr.push({ hall: hn, start: s.start_time ?? null, end: s.end_time ?? null })
      vbBusyByDate.set(s.date, arr)
    }
    return { closedHallsByDate, clubBlockedDates, vbBusyByDate, bbGameBusyByDate }
  }, [closuresQ.data, clubBlocksQ.data, vbSlotsQ.data, hallNameMap, bbGameBusyByDate])

  // Per-date blackout / closure / club-block / volleyball info for the shown grid.
  const dateInfoByDate = useMemo(() => {
    const info = new Map<string, DateInfo>()
    for (const cd of candidateDates) {
      const closedHalls = blockers.closedHallsByDate.get(cd.date) ?? new Set<string>()
      const day = dayHallAvailability(cd.date, cd.dow, blockers, !!cd.blackout)
      info.set(cd.date, {
        blackout: cd.blackout?.label ?? null,
        closedHalls,
        clubBlocked: blockers.clubBlockedDates.has(cd.date),
        fullyBlocked: day.noneFree,
        reason: day.reason,
        reasonDetail:
          day.reason === 'blackout'
            ? cd.blackout?.label ?? null
            : day.reason === 'hall_closed'
              ? [...closedHalls].filter((h) => h !== '*').join(', ') || null
              : null,
      })
    }
    return info
  }, [blockers, candidateDates])

  // Volleyball home games (booked slots) + hall closures — shown on the basketball
  // calendar for cross-sport hall coordination.
  const vbGames = useMemo(
    () =>
      (vbSlotsQ.data ?? [])
        .map((s) => ({ date: s.date, time: String(s.start_time ?? '').slice(0, 5), hall: hallNameMap.get(String(s.hall)) ?? '' }))
        .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)),
    [vbSlotsQ.data, hallNameMap],
  )
  const closureEntries = useMemo(
    () =>
      (closuresQ.data ?? []).map((c) => ({
        start: c.start_date,
        end: c.end_date,
        hall: c.hall ? hallNameMap.get(String(c.hall)) ?? null : null,
        reason: c.reason ?? '',
      })),
    [closuresQ.data, hallNameMap],
  )

  /**
   * date → "no game may be played" reason, for the calendar's blocked-day layer:
   * ProBasket Ferien/Sperrdaten (already canton-resolved by the config) plus the
   * club-wide superadmin blackout, which wins when both land on a day.
   */
  const blockedDayReasons = useMemo(() => {
    const m = new Map<string, string>()
    for (const b of config?.blackouts ?? []) {
      eachDay(b.start, b.end, (ymd) => { if (!m.has(ymd)) m.set(ymd, b.label) })
    }
    for (const b of clubBlocksQ.data ?? []) {
      const reason = (b.reason ?? '').trim()
      eachDay(b.start_date, b.end_date, (ymd) => m.set(ymd, reason || m.get(ymd) || ''))
    }
    return m
  }, [config, clubBlocksQ.data])

  const placements = useMemo(() => {
    const m = new Map<string, BasketballSlotPlan>()
    for (const p of planQ.data ?? []) m.set(slotKey(p.date, p.time, p.hall), p)
    return m
  }, [planQ.data])

  const availability = useMemo(() => {
    const m = new Map<string, BasketballHallAvailability>()
    for (const r of availQ.data ?? []) m.set(availKey(r.team, r.date), r)
    return m
  }, [availQ.data])

  /**
   * The away half of `fixtures` — the only side that closes a date for its team
   * (a home game closes a COURT, which the floor logic above handles instead).
   */
  const awayGames = useMemo(() => fixtures.filter((f) => f.type === 'away'), [fixtures])

  /** `teamId|date` for every away fixture — the same key shape the generator builds. */
  const awayTeamDates = useMemo(() => {
    const m = new Map<string, { opponent: string; time: string }>()
    for (const g of awayGames) if (g.team) m.set(availKey(g.team, g.date), { opponent: g.opponent, time: g.time })
    return m
  }, [awayGames])

  /**
   * Why this team cannot host on this date, or null. Mirrors the two per-team hard
   * rejects in `basketball-slots.js` (`team_unavailable`, `away_game`) so the grid and
   * the generator cannot disagree about which dates are gone — a grid that offers a
   * pitch the generator will never produce is worse than no grid.
   */
  const teamBlockedOn = useCallback(
    (teamId: string | number | null | undefined, date: string):
      { reason: 'away_game'; opponent: string; time: string } | { reason: 'manual' } | null => {
      if (teamId == null) return null
      const away = awayTeamDates.get(availKey(teamId, date))
      if (away) return { reason: 'away_game', opponent: away.opponent, time: away.time }
      if (availability.get(availKey(teamId, date))?.unavailable) return { reason: 'manual' }
      return null
    },
    [awayTeamDates, availability],
  )

  /**
   * teams.id → every date that team already plays: a placed home game (basketball_slot_plan)
   * or a fixture of either side (`games`). The sources the generator's rest gap reads, so
   * the grid and the inventory agree about which dates sit next to a game.
   */
  const gameDatesByTeam = useMemo(() => {
    const m = new Map<string, Set<string>>()
    const add = (team: string | number | null | undefined, date: string) => {
      if (team == null || !date) return
      const k = String(team)
      const set = m.get(k) ?? new Set<string>()
      set.add(date)
      m.set(k, set)
    }
    for (const p of placements.values()) add(p.kscw_team, p.date)
    // Every fixture, not just the away ones: a home game recorded in `games` is as much
    // a game for the rest gap as one placed in the grid.
    for (const g of fixtures) add(g.team, g.date)
    return m
  }, [placements, fixtures])

  /**
   * The home game this team already has on this date — a placement OR a `games` fixture —
   * or null.
   *
   * A basketball team plays one game a day, so every other pitch on that date is noise.
   * The generator learned this on 06.09.2026 (`REJECT_CODES.HOME_GAME`); this is the live
   * half of the same rule, applied on top of the STORED inventory so a grid generated
   * before the placement existed stops advertising the rest of that day. Without it the
   * planner sees suggestions the generator would no longer make — 98 of them on prod,
   * reported as "slots kept being suggested during which the team already has a home game".
   *
   * ⚠ Suppresses SUGGESTIONS only. The date keeps its card and still takes a hand-placed
   * game (a junior double-header is legal), exactly like the rest gap.
   */
  const homeGameByTeamDate = useMemo(() => {
    const m = new Map<string, { time: string; hall: string; opponent: string }>()
    for (const p of placements.values()) {
      if (p.kscw_team == null) continue
      m.set(availKey(p.kscw_team, p.date), { time: p.time, hall: p.hall, opponent: p.opponent ?? '' })
    }
    // A fixture wins the key: it is the agreed game, the placement is the plan for it.
    for (const f of fixtures) {
      if (f.type !== 'home' || !f.team) continue
      m.set(availKey(f.team, f.date), { time: f.time, hall: f.venue, opponent: f.opponent })
    }
    return m
  }, [placements, fixtures])

  const teamHostsOn = useCallback(
    (teamId: string | number | null | undefined, date: string) =>
      teamId == null ? null : homeGameByTeamDate.get(availKey(teamId, date)) ?? null,
    [homeGameByTeamDate],
  )

  /**
   * The team's own game one day either side of this date, or null — the club's SOFT block
   * (rule 2026-09-02). Nothing is closed: the date keeps its card and still takes a
   * hand-placed game. It only stops the date being SUGGESTED, which is what the generator
   * does by not writing the candidate at all (basketball-slots.js → REST_GAP_DAYS).
   *
   * ⚠ Applied live, on top of the stored inventory: a suggestion generated before the
   * neighbouring game was placed would otherwise keep advertising itself until the next
   * generation run.
   *
   * ⚠ Junior teams are exempt, keyed on the SAME `basketball_team_rules.category` the
   * generator reads — never on a league guess from the team name.
   */
  const teamRestBlockedOn = useCallback(
    (teamId: string | number | null | undefined, date: string): { date: string } | null => {
      if (teamId == null) return null
      const rule = rulesByTeam.get(String(teamId))
      if (!rule || !restGapApplies(rule.category)) return null
      const dates = gameDatesByTeam.get(String(teamId))
      if (!dates || !dates.size) return null
      const at = adjacentGameDate(dates, date)
      return at ? { date: at } : null
    },
    [rulesByTeam, gameDatesByTeam],
  )

  /** Per-hall view of a (date, time): status + placement, resolving A+B combined occupancy. */
  const slotView = useCallback(
    (date: string, dow: number, time: string): { cells: HallCell[]; canCombineAB: boolean } => {
      const info = dateInfoByDate.get(date)
      const { halls } = slotsForDate(dow)
      const combined = placements.get(slotKey(date, time, HALL_AB)) ?? null
      const isBlackout = !!info?.blackout
      const cells: HallCell[] = halls.map((hall) => {
        // An already-placed game wins over every blocker: it is a fact on the plan,
        // and hiding it would make it unremovable.
        if (combined && (hall === HALL_A || hall === HALL_B)) {
          return { hall, status: 'game', placement: combined, viaCombined: true }
        }
        const own = placements.get(slotKey(date, time, hall)) ?? null
        if (own) return { hall, status: 'game', placement: own }
        const status = hallStatusAt(date, time, hall, blockers, isBlackout)
        // A `games` fixture holds this court: name it, or the cell reads as a bug.
        if (status === 'bbgame') {
          return {
            hall,
            status,
            placement: null,
            fixture: bbGameBlocksPitch(blockers.bbGameBusyByDate?.get(date) ?? [], hall, time) ?? undefined,
          }
        }
        return { hall, status, placement: null }
      })
      const aFree = cells.find((c) => c.hall === HALL_A)?.status === 'free'
      const bFree = cells.find((c) => c.hall === HALL_B)?.status === 'free'
      return { cells, canCombineAB: !!aFree && !!bFree }
    },
    [dateInfoByDate, blockers, placements],
  )

  // date → day-of-week, so highlightFor can look up a date's slot ordering for adjacency.
  const dowByDate = useMemo(() => {
    const m = new Map<string, number>()
    for (const cd of candidateDates) m.set(cd.date, cd.dow)
    return m
  }, [candidateDates])

  // (date|time) → team ids placed there (any hall).
  const teamsByDateTime = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const p of placements.values()) {
      if (p.kscw_team == null) continue
      const k = `${p.date}|${p.time}`
      const s = m.get(k) ?? new Set<string>()
      s.add(String(p.kscw_team))
      m.set(k, s)
    }
    return m
  }, [placements])

  /**
   * For a selected team, mark a (date,time) as a suggested slot or a conflict:
   *  - conflict: a 'diff' or 'adjacent' partner already plays at this exact time (must not overlap);
   *  - suggest: a 'same' partner plays here, or an 'adjacent' partner plays in the
   *    neighbouring slot on this date (keep them back-to-back).
   */
  const highlightFor = useCallback(
    (teamId: string | number | null | undefined, date: string, time: string): 'suggest' | 'conflict' | null => {
      if (teamId == null) return null
      const p = partnersByTeam.get(String(teamId))
      if (!p) return null
      const here = teamsByDateTime.get(`${date}|${time}`)
      if (here && here.size) {
        for (const tid of here) if (p.diff.has(tid) || p.adjacent.has(tid)) return 'conflict'
        for (const tid of here) if (p.same.has(tid)) return 'suggest'
      }
      // An 'adjacent' partner in the slot immediately before/after → suggested (back-to-back).
      if (p.adjacent.size) {
        const dow = dowByDate.get(date)
        if (dow != null) {
          const { times } = slotsForDate(dow)
          const idx = times.indexOf(time)
          if (idx >= 0) {
            for (const nt of [times[idx - 1], times[idx + 1]]) {
              if (!nt) continue
              const near = teamsByDateTime.get(`${date}|${nt}`)
              if (near) for (const tid of near) if (p.adjacent.has(tid)) return 'suggest'
            }
          }
        }
      }
      return null
    },
    [partnersByTeam, teamsByDateTime, dowByDate],
  )

  const isLoading =
    teamsQ.isLoading || hallsQ.isLoading || (hasSeason && (planQ.isLoading || vbSlotsQ.isLoading || closuresQ.isLoading))
  const error = (teamsQ.error || planQ.error || availQ.error || hallsQ.error || vbSlotsQ.error) as Error | null

  const refetchPlan = planQ.refetch
  const refetchAvail = availQ.refetch

  const placeGame = useCallback(
    async (date: string, time: string, hall: string, input: PlaceGameInput) => {
      if (seasonId == null) return
      const key = slotKey(date, time, hall)
      const existing = placements.get(key)
      const payload = {
        season: seasonId,
        date,
        time,
        hall,
        kscw_team: input.kscw_team ?? null,
        kscw_team_label: input.kscw_team_label ?? null,
        opponent: input.opponent ?? null,
        sex: input.sex ?? null,
        game_type: input.game_type ?? 'home',
        note: input.note ?? null,
        created_by: user?.id ?? null,
      }
      if (existing) await updateRecord<BasketballSlotPlan>('basketball_slot_plan', existing.id, payload)
      else await createRecord<BasketballSlotPlan>('basketball_slot_plan', payload)
      await refetchPlan()
    },
    [seasonId, user?.id, placements, refetchPlan],
  )

  const removeGame = useCallback(
    async (id: string | number) => {
      await deleteRecord('basketball_slot_plan', id)
      await refetchPlan()
    },
    [refetchPlan],
  )

  /** Per-team, per-date availability override for the ProBasket export (Nicht Verfügbar x). */
  const setDateUnavailable = useCallback(
    async (teamId: string | number, date: string, unavailable: boolean) => {
      if (seasonId == null) return
      const existing = availability.get(availKey(teamId, date))
      if (existing) await updateRecord('basketball_hall_availability', existing.id, { unavailable })
      else
        await createRecord('basketball_hall_availability', {
          season: seasonId,
          team: teamId,
          date,
          unavailable,
          windows: [],
          created_by: user?.id ?? null,
        })
      await refetchAvail()
    },
    [seasonId, user?.id, availability, refetchAvail],
  )

  return {
    config,
    candidateDates,
    teams,
    dateInfoByDate,
    /** Season-wide raw blockers — the export re-resolves them per team's own grid. */
    blockers,
    blockedDayReasons,
    placements,
    availability,
    availKey,
    fixtures,
    awayGames,
    teamBlockedOn,
    teamRestBlockedOn,
    teamHostsOn,
    slotView,
    vbGames,
    closureEntries,
    links,
    highlightFor,
    addLink,
    updateLink,
    removeLink,
    isLoading,
    error,
    placeGame,
    removeGame,
    setDateUnavailable,
  }
}
