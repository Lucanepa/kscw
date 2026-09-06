/**
 * Basketball slot generation — candidate home-slot inventory for `basketball_slots`.
 *
 * The basketball counterpart of volleyball's POST /terminplanung/admin/generate-slots
 * (game-scheduling.js). Same shape — admin-gated POST, one season, idempotent, raw knex +
 * writeUserLog actor capture — but a completely different rule source: volleyball generates
 * from Spielsamstage + weekly hall slots, basketball generates from the club's constraint
 * matrix (`basketball_team_rules`, migration 278) intersected with everything that can take
 * a KWI court away.
 *
 * WHY A BACKEND ENDPOINT and not a frontend hook:
 *   · it is one transaction — a client loop can half-complete and leave a torn inventory;
 *   · it reads hall_closures / game_scheduling_slots / scheduling_global_blocks, which a
 *     non-admin planner cannot necessarily read under their policy filters;
 *   · raw-knex writes bypass Directus's activity trail, so the actor must be captured
 *     explicitly (CLAUDE.md → "Audit logging (actor capture)").
 *
 * ── ⚠ MIRRORED CONSTANTS ────────────────────────────────────────────────────────────────
 * The fixed time grid, the hall names, the per-league availability windows, the ProBasket
 * blackouts and the volleyball-occupancy arithmetic are DUPLICATED from the frontend:
 *     src/modules/gameScheduling/utils/probasketSeason.ts   (grid, halls, leagues, blackouts)
 *     src/modules/gameScheduling/utils/hallOccupancy.ts     (VB overlap + hall collision)
 * They cannot be imported — that is browser TypeScript and this is a Node extension — so
 * this is the same deliberate mirror as federations.js ↔ federations.ts. **When you change
 * one, change the other in the SAME commit.** The unit tests in
 * __tests__/basketball-slots.test.js pin the values that must agree.
 *
 * ── Reading of the ambiguous cells in the club's constraint sheet ───────────────────────
 * Stated here rather than guessed silently; all three are listed as followups.
 *   1. "start after 1.30" / "start before 1.30" → 13:30 INCLUSIVE on BOTH sides. So the
 *      Saturday 13:30 pitch is the one slot both camps share. Read exclusively instead,
 *      DU14 and HU14 would be left with Sat 11:00 / Sun 10:00 / Sun 12:30 only.
 *   2. "Seniors (youth)" in the timeslot matrix → the parenthesised category is TOLERATED:
 *      it may be generated, but it scores 15 lower than a category the slot is meant for,
 *      so the generator only reaches for it when nothing better fits. It is NOT a hard
 *      exclusion. The one hard exclusion is Friday's "Seniors (youth, U18 only)": Friday
 *      20:00 tolerates `u18` and nothing else, so HU16 / HU14 / DU14 are never generated
 *      into it.
 *   3. "until oct" → blocked BEFORE 2026-10-01 (the narrow reading). "through 31.10" would
 *      delete five more of the thirteen Vorrunde weekends for four senior teams and would
 *      collide with the club's own desired 26/27.09 Spielsamstag.
 */

import crypto from 'crypto'
import { writeUserLog } from './activity-log.js'

// ═══════════════════════════════════════════════════════════════════════════════════════
// Mirrored constants (see the header warning)
// ═══════════════════════════════════════════════════════════════════════════════════════

/** Fri=5, Sat=6, Sun=0 in JS getDay() — the only days basketball plays home games. */
export const PLAY_DOW = [5, 6, 0]

export const FRIDAY_SLOTS = ['20:00']
export const SATURDAY_SLOTS = ['11:00', '13:30', '16:00', '18:30']
export const SUNDAY_SLOTS = ['10:00', '12:30', '15:00']

export const HALL_A = 'KWI A'
export const HALL_B = 'KWI B'
export const HALL_C = 'KWI C'
export const HALL_AB = 'KWI A+B'

/** How long a basketball game holds the court. Mirrors hallOccupancy.ts BB_GAME_MINUTES. */
export const BB_GAME_MINUTES = 120
/** Fallback length for a volleyball booking with no end_time. */
export const VB_DEFAULT_MINUTES = 120
/** Dead time reserved either side of a volleyball booking (net, poles, scorer's table). */
export const VB_CHANGEOVER_MINUTES = 30

/** KSCW plays in Zurich — the canton the Ferien windows resolve against. */
export const KSCW_CANTON = 'ZH'

/**
 * Fixed pitch times + candidate halls for a weekday. Friday offers A/B (plus the combined
 * court); the weekend adds C. Mirrors probasketSeason.ts slotsForDate(), extended with the
 * combined court because the generator has to offer 'KWI A+B' as its own candidate hall.
 */
export function slotsForDate(dow) {
  if (dow === 5) return { times: [...FRIDAY_SLOTS], halls: [HALL_A, HALL_B, HALL_AB] }
  if (dow === 6) return { times: [...SATURDAY_SLOTS], halls: [HALL_A, HALL_B, HALL_C, HALL_AB] }
  if (dow === 0) return { times: [...SUNDAY_SLOTS], halls: [HALL_A, HALL_B, HALL_C, HALL_AB] }
  return { times: [], halls: [] }
}

/** A game's default end time = start + BB_GAME_MINUTES, as 'HH:MM' (24h clamp). */
export function slotEndTime(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number)
  const end = (h * 60 + m + BB_GAME_MINUTES) % (24 * 60)
  return `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`
}

/**
 * Availability-grid ranges per ProBasket league, 2026/27. Mirrors
 * PROBASKET_LEAGUES_2026_27[*].grid in probasketSeason.ts.
 *
 * The window is per LEAGUE, not per season: the 1.-Liga-Interregional grid runs to
 * 09.05.2027 while the junior 1. Phase stops on 13.12.2026. Every grid splits around the
 * Weihnachtsferien Sperrdatum (21.12.2026 – 04.01.2027) because that is the only blackout
 * the official templates physically omit rows for.
 */
export const PROBASKET_LEAGUE_GRIDS_2026_27 = {
  H4LR: [{ start: '2026-09-19', end: '2026-12-20' }, { start: '2027-01-05', end: '2027-04-19' }],
  D3LR: [{ start: '2026-09-19', end: '2026-12-20' }, { start: '2027-01-05', end: '2027-04-18' }],
  H3LR: [{ start: '2026-09-19', end: '2026-12-20' }, { start: '2027-01-05', end: '2027-04-18' }],
  D2LR: [{ start: '2026-09-19', end: '2026-12-20' }, { start: '2027-01-05', end: '2027-05-23' }],
  H2LR: [{ start: '2026-09-19', end: '2026-12-20' }, { start: '2027-01-05', end: '2027-05-23' }],
  // 'template' grids — a byte-match of the official Vorlage_Senior_innen.xlsx sheet, which
  // has no rows before FR 25.09 even though the association prints 19.09 for the phase.
  D1LI: [{ start: '2026-09-25', end: '2026-12-20' }, { start: '2027-01-05', end: '2027-05-09' }],
  H1LI: [{ start: '2026-09-25', end: '2026-12-20' }, { start: '2027-01-05', end: '2027-05-09' }],
  BLS: [{ start: '2026-09-19', end: '2026-12-20' }, { start: '2027-01-05', end: '2027-05-23' }],
  MIXED: [{ start: '2026-09-19', end: '2026-12-20' }, { start: '2027-01-05', end: '2027-05-30' }],
  JUN_REG: [{ start: '2026-09-19', end: '2026-12-13' }],
  JUN_INTER: [{ start: '2026-09-19', end: '2026-12-13' }],
  HU14_INTER: [{ start: '2026-09-19', end: '2026-12-20' }, { start: '2027-01-05', end: '2027-01-17' }],
  KIDS_MINIS: [{ start: '2026-09-19', end: '2026-12-13' }],
}

/**
 * Synthetic league for a team with NO `basketball_team_rules` row.
 *
 * User rule 2026-08-05: "for teams with no rules: means open to all: generate every
 * slot." A missing row used to SKIP the team entirely; it now means the opposite —
 * no TEAM-level restriction at all. To make "every slot" honest the window has to be
 * the widest any league gets, not the JUN_REG default (which ends 13.12.2026 and
 * would quietly under-generate for e.g. the two Classics squads).
 *
 * ⚠ "Open" removes only the team's OWN preferences (weekday, start window, hall tier,
 * category, blocked dates). The club-wide hard rules still bind — Spielsamstage cap,
 * ProBasket blackouts, hall closures, volleyball occupancy, an already-taken pitch,
 * a partner playing at the same time. Those are facts about the hall, not preferences.
 */
export const OPEN_LEAGUE = 'OPEN'

/** Union of every league grid, merged into minimal non-overlapping ranges. */
export function widestGrid(gridsByLeague) {
  const ranges = Object.values(gridsByLeague || {}).flat()
    .filter((r) => r?.start && r?.end)
    .map((r) => ({ start: r.start, end: r.end }))
    .sort((a, b) => a.start.localeCompare(b.start))
  const out = []
  for (const r of ranges) {
    const last = out[out.length - 1]
    // Merge overlapping OR adjacent ranges; a one-day gap between two league phases
    // is an artefact of per-league end dates, not a day the hall is unavailable.
    if (last && r.start <= addDays(last.end, 1)) {
      if (r.end > last.end) last.end = r.end
    } else out.push({ ...r })
  }
  return out
}

export const PROBASKET_GRIDS_BY_SEASON = { '2026/27': PROBASKET_LEAGUE_GRIDS_2026_27 }

/** Fallback league window — junior regional 1. Phase (the documented default). */
export const DEFAULT_LEAGUE = 'JUN_REG'

/**
 * ProBasket blackouts 2026/27, canton-scoped where the document scopes them.
 * 'ferien' binds ONLY interregional + 1./2. Seniorenliga teams (basketball_team_rules
 * .ferien_hard); 'sperr' binds every league. Mirrors PROBASKET_BLACKOUTS_2026_27.
 */
export const PROBASKET_BLACKOUTS_2026_27 = [
  { start: '2026-10-05', end: '2026-10-11', label: 'Herbstferien', kind: 'ferien' },
  { start: '2027-01-30', end: '2027-02-14', label: 'Sport / Fasnachtsferien', kind: 'ferien' },
  { start: '2027-04-03', end: '2027-04-18', label: 'Osterferien (ausser ZH/ZG)', kind: 'ferien', exceptCantons: ['ZH', 'ZG'] },
  { start: '2027-04-24', end: '2027-05-02', label: 'Osterferien (ZH/ZG)', kind: 'ferien', cantons: ['ZH', 'ZG'] },
  { start: '2026-12-21', end: '2027-01-04', label: 'Weihnachtsferien', kind: 'sperr' },
  { start: '2027-04-17', end: '2027-04-18', label: 'Final Four ProBasket Jugend', kind: 'sperr' },
  { start: '2027-04-25', end: '2027-04-25', label: 'ProBasket Classics Final', kind: 'sperr' },
  { start: '2027-04-26', end: '2027-04-30', label: 'Ostern', kind: 'sperr' },
]

export const PROBASKET_BLACKOUTS_BY_SEASON = { '2026/27': PROBASKET_BLACKOUTS_2026_27 }

/**
 * The blackouts in force for one canton — drops the Osterferien window of the other bloc.
 * The association schedules the ZH/ZG break two weeks later than the rest of Switzerland;
 * blocking both would delete four extra weekends that are genuinely playable.
 */
export function blackoutsForCanton(blackouts, canton = KSCW_CANTON) {
  return (blackouts || []).filter((b) => {
    if (b.cantons && !b.cantons.includes(canton)) return false
    if (b.exceptCantons && b.exceptCantons.includes(canton)) return false
    return true
  })
}

/**
 * The club timeslot→category matrix used when a season carries no `bb_slot_config`.
 * Byte-identical to the seed in migration 278 — the DB is authoritative, this is the
 * fallback so an unconfigured season still generates something sane instead of nothing.
 */
export const DEFAULT_TIMESLOT_MATRIX = [
  { dow: 5, time: '20:00', allow: ['seniors'], tolerate: ['u18'] },
  { dow: 6, time: '11:00', allow: ['youth', 'u18'], tolerate: [] },
  { dow: 6, time: '13:30', allow: ['youth', 'u18', 'seniors'], tolerate: [] },
  { dow: 6, time: '16:00', allow: ['seniors'], tolerate: ['youth', 'u18'] },
  { dow: 6, time: '18:30', allow: ['seniors'], tolerate: [] },
  { dow: 0, time: '10:00', allow: ['youth', 'u18'], tolerate: [] },
  { dow: 0, time: '12:30', allow: ['youth', 'u18', 'seniors'], tolerate: [] },
  { dow: 0, time: '15:00', allow: ['seniors'], tolerate: ['youth', 'u18'] },
]

// ═══════════════════════════════════════════════════════════════════════════════════════
// Pure helpers — no IO, exported for the unit tests
// ═══════════════════════════════════════════════════════════════════════════════════════

/** jsonb comes back parsed from knex, but a text column would not. Never throw. */
export function parseJsonColumn(v, fallback) {
  if (v == null) return fallback
  if (typeof v === 'string') {
    try { return JSON.parse(v) } catch { return fallback }
  }
  return v
}

/** 'HH:MM' or 'HH:MM:SS' → minutes since midnight; null for anything unparseable. */
export function minutesOfDay(hhmm) {
  const m = String(hhmm ?? '').match(/^(\d{1,2}):(\d{2})/)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** Half-open interval overlap: touching at a boundary is NOT an overlap. */
export function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd
}

/**
 * Do two hall names fight over the same floor? 'KWI A+B' is the combined big court — the
 * same physical space as A plus B with the divider open — so an A+B booking blocks A and B
 * and vice versa. KWI C never collides with either.
 */
export function hallsCollide(a, b) {
  if (a === b) return true
  const isHalf = (h) => h === HALL_A || h === HALL_B
  if (a === HALL_AB && isHalf(b)) return true
  if (b === HALL_AB && isHalf(a)) return true
  return false
}

/** The minute window a volleyball booking takes a court out of service, changeover included. */
export function vbBusyWindow(booking) {
  const start = minutesOfDay(booking.start)
  if (start == null) return null // caller must treat this as an all-day block
  const rawEnd = minutesOfDay(booking.end)
  const end = rawEnd != null && rawEnd > start ? rawEnd : start + VB_DEFAULT_MINUTES
  return { start: start - VB_CHANGEOVER_MINUTES, end: end + VB_CHANGEOVER_MINUTES }
}

/** Is `hall` unusable for a basketball tip-off at `bbStart` given that day's VB bookings? */
export function vbBlocksSlot(bookings, hall, bbStart) {
  const gameStart = minutesOfDay(bbStart)
  if (gameStart == null) return false
  const gameEnd = gameStart + BB_GAME_MINUTES
  for (const b of bookings || []) {
    if (!hallsCollide(b.hall, hall)) continue
    const win = vbBusyWindow(b)
    // No parsable start time → we cannot know when the court is free; the conservative
    // reading is "busy all day". Never silently frees the hall.
    if (!win) return true
    if (intervalsOverlap(win.start, win.end, gameStart, gameEnd)) return true
  }
  return false
}

// ── Date helpers (pure UTC string arithmetic — no local-timezone drift) ─────────────────

export function ymdToUtc(ymd) {
  return new Date(`${String(ymd).slice(0, 10)}T00:00:00Z`)
}
export function utcToYmd(d) {
  return d.toISOString().slice(0, 10)
}
export function addDays(ymd, n) {
  const d = ymdToUtc(ymd)
  d.setUTCDate(d.getUTCDate() + n)
  return utcToYmd(d)
}
/** JS getDay() (0=Sun … 6=Sat) for a 'YYYY-MM-DD'. */
export function dowOf(ymd) {
  return ymdToUtc(ymd).getUTCDay()
}
/** Every 'YYYY-MM-DD' from start to end inclusive. */
export function eachDate(start, end) {
  const out = []
  const last = ymdToUtc(end)
  for (const d = ymdToUtc(start); d <= last; d.setUTCDate(d.getUTCDate() + 1)) out.push(utcToYmd(d))
  return out
}

/**
 * Every candidate (date, dow, time, hall) inside a league's grid ranges, Fri/Sat/Sun only.
 * Deterministic order: date, then the weekday's pitch order, then the hall order.
 */
export function candidateSlots(ranges) {
  const out = []
  const seen = new Set()
  for (const range of ranges || []) {
    if (!range?.start || !range?.end) continue
    for (const date of eachDate(range.start, range.end)) {
      if (seen.has(date)) continue
      const dow = dowOf(date)
      if (!PLAY_DOW.includes(dow)) continue
      seen.add(date)
      const { times, halls } = slotsForDate(dow)
      for (const time of times) for (const hall of halls) out.push({ date, dow, time, hall })
    }
  }
  return out.sort((a, b) =>
    a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.hall.localeCompare(b.hall))
}

/**
 * Expand a team's `blocked` RULES into a Set of blocked 'YYYY-MM-DD'.
 *
 * Kinds:
 *   before_date     — every candidate date strictly before `date` (sheet "until oct").
 *   date_range      — start…end inclusive.
 *   school_holidays — every day of every range in `holidayRanges` (the ZH Schulferien rows
 *                     from hall_closures, source='school_holidays'). When
 *                     `include_weekend_before` is set, the block is extended back to the
 *                     FRIDAY on-or-before (range start − 1 day) — the sheet's "holidays
 *                     and weekend before". Concretely, Herbstferien Mon 05.10 → Fri 02.10.
 *
 * `dates` bounds the expansion so `before_date` cannot enumerate the epoch.
 */
export function expandBlockedRules(rules, holidayRanges, dates) {
  const blocked = new Set()
  const all = Array.isArray(dates) ? dates : []
  for (const rule of rules || []) {
    if (!rule?.kind) continue
    if (rule.kind === 'before_date' && rule.date) {
      for (const d of all) if (d < rule.date) blocked.add(d)
    } else if (rule.kind === 'date_range' && rule.start && rule.end) {
      for (const d of eachDate(rule.start, rule.end)) blocked.add(d)
    } else if (rule.kind === 'school_holidays') {
      for (const r of holidayRanges || []) {
        if (!r?.start || !r?.end) continue
        let from = r.start
        if (rule.include_weekend_before) {
          // Walk back from the day before the holiday to the Friday on-or-before it, so
          // the whole preceding weekend (Fri/Sat/Sun) is blocked too.
          let cursor = addDays(r.start, -1)
          for (let i = 0; i < 7 && dowOf(cursor) !== 5; i++) cursor = addDays(cursor, -1)
          from = cursor
        }
        for (const d of eachDate(from, r.end)) blocked.add(d)
      }
    }
  }
  return blocked
}

/** Every blackout covering `ymd`, 'sperr' first (a sperr binds everyone, a ferien does not). */
export function blackoutsOn(ymd, blackouts) {
  return (blackouts || [])
    .filter((b) => ymd >= b.start && ymd <= b.end)
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'sperr' ? -1 : 1))
}

/** Hall names a `hall` candidate needs free — A+B needs BOTH halves. */
export function hallComponents(hall) {
  return hall === HALL_AB ? [HALL_A, HALL_B] : [hall]
}

/** The team's hall tier for `hall`, or null when the hall is not offered to the team at all. */
export function hallTierFor(halls, hall) {
  const tiers = Array.isArray(halls?.tiers) ? halls.tiers : []
  if (tiers.length === 0) return { rank: 1, last_resort: false } // no preference = all equal
  const ordered = [...tiers].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
  const usable = halls?.hard ? ordered.slice(0, 1) : ordered
  for (const t of usable) {
    if (Array.isArray(t.options) && t.options.includes(hall)) {
      return { rank: t.rank ?? 1, last_resort: !!t.last_resort }
    }
  }
  return null
}

// ── Reason codes ────────────────────────────────────────────────────────────────────────

/** Why a candidate was NOT written. Stable strings — the UI translates them. */
export const REJECT_CODES = {
  DAY_NOT_ALLOWED: 'day_not_allowed',
  BLACKOUT_SPERR: 'blackout_sperr',
  BLACKOUT_FERIEN: 'blackout_ferien',
  CLUB_BLOCK: 'club_block',
  HALL_CLOSED: 'hall_closed',
  VOLLEYBALL: 'volleyball',
  START_WINDOW: 'start_window',
  BLOCKED_RULE: 'blocked_rule',
  HALL_NOT_ALLOWED: 'hall_not_allowed',
  CATEGORY_NOT_ALLOWED: 'category_not_allowed',
  TEAM_UNAVAILABLE: 'team_unavailable',
  /** The team plays AWAY that day (a `games` row), so it cannot host at KWI. */
  AWAY_GAME: 'away_game',
  /** The team ALREADY hosts that day — a placement, or a home fixture in `games`. */
  HOME_GAME: 'home_game',
  /** The day before / after one of this team's own games — not offered, still placeable. */
  ADJACENT_GAME: 'adjacent_game',
  PITCH_TAKEN: 'pitch_taken',
  PARTNER_SAME_TIME: 'partner_same_time',
  NOT_A_SPIELSAMSTAG: 'not_a_spielsamstag',
}

/**
 * The Saturday that identifies a candidate date's weekend.
 *
 * Spielsamstage are stored as the SATURDAY only, but basketball plays Fri/Sat/Sun,
 * so a Friday and a Sunday belong to the same weekend as the Saturday between
 * them. Fri → +1 day, Sat → itself, Sun → −1 day.
 */
export function weekendKey(ymd) {
  const g = dowOf(ymd)
  return g === 5 ? addDays(ymd, 1) : g === 0 ? addDays(ymd, -1) : ymd
}

/** Soft-score terms. Every delta is a constant so a re-run reproduces the score exactly. */
export const SCORE = {
  PREFERRED_DAY: 30,
  SPIELSAMSTAG: { given: 20, desired: 12, fraglich: 4, bei_bedarf: 2 },
  CATEGORY_ALLOW: 15,
  HALL_RANK1: 10,
  HALL_RANK2: 5,
  HALL_LAST_RESORT: -10,
  ADJACENT_PARTNER: 8,
  OWN_BACK_TO_BACK: -8,
  FERIEN_SOFT: -5,
  VB_SAME_DAY: -6,
  VB_SAME_DAY_FLOOR: -12,
  BUSY_DATE: -4,
  /** ≥ this many basketball placements already on a date makes it "busy". */
  BUSY_DATE_THRESHOLD: 3,
}

/**
 * REST GAP — the day before and the day after one of a team's own games is not OFFERED.
 *
 * Club rule 2026-09-02: "soft block one day before and one day after … so that a game can
 * be placed manually but the date gets not suggested". Removing the candidate from
 * `basketball_slots` is exactly that: the inventory is the SUGGESTION list, while the prep
 * grid's pitches come from the fixed weekday grid, so a rest-gap date still opens, still
 * shows "＋ Put game here", and still takes a hand-placed game. It sits in `hardReject`
 * only because that is where "what gets written" is decided — it is not a block.
 *
 * ⚠ Mirrored in src/modules/gameScheduling/utils/basketballRules.ts (REST_GAP_DAYS +
 * restGapApplies + adjacentGameDate). The prep grid suppresses the same suggestions LIVE,
 * before the next generation run, so the grid and the inventory cannot tell different
 * stories — the same invariant `teamBlockedOn` keeps for the two per-team hard rejects.
 *
 * ⚠ JUNIORS ARE EXEMPT (same rule): their 1.-Phase window is short and their fixture
 * count fixed, so back-to-back days are at times unavoidable. Only `seniors` carry the
 * gap, and an `open` team (no rules row) carries no team preference at all — "open"
 * removes the team's own preferences, never the club-wide hall facts.
 */
export const REST_GAP_DAYS = 1
export const REST_GAP_CATEGORIES = ['seniors']

/** Does the rest gap bind a team of this `basketball_team_rules.category`? */
export function restGapApplies(category) {
  return REST_GAP_CATEGORIES.includes(String(category || ''))
}

/**
 * HARD rules. Returns a REJECT_CODES value when the candidate must NOT be written, else null.
 *
 * `team` is a basketball_team_rules row (json columns already parsed) plus `id`.
 * `ctx` is the per-season blocker bundle built by `loadGeneratorContext`.
 */
export function hardReject(cand, team, ctx) {
  const { date, dow, time, hall } = cand

  // ── Team's own weekday allow-list. "weekends" means Friday is out, full stop. ──
  if (!team.allowed_dows.includes(dow)) return REJECT_CODES.DAY_NOT_ALLOWED

  // ── CLUB-WIDE weekend cap (user rule 2026-08-05: "maximum number of weekends: 10.
  //    In crisis: 11"). KWI only opens for basketball on the Spielsamstage the section
  //    agreed, so a date outside that set is not a candidate for ANY team — this is a
  //    hall-economics decision, not a per-team preference, which is why it sits here
  //    rather than in the scoring. Without it the five senior teams sprawled across
  //    22–26 weekends (their leagues run to April/May) while the six junior teams sat
  //    at exactly 10 purely because their window is that short.
  //    Opt-in: only enforced when the season config says so, so a season that has not
  //    fixed its Spielsamstage yet keeps the old open behaviour instead of generating
  //    nothing at all. ──
  if (ctx.spielsamstagHard) {
    if (!ctx.spielsamstagStatus.has(weekendKey(date))) return REJECT_CODES.NOT_A_SPIELSAMSTAG
  }

  // ── ProBasket blackouts. 'sperr' binds everyone; 'ferien' only the interregional +
  //    1./2.-Seniorenliga teams. For everyone else a Ferien week is a soft penalty, because
  //    the association's own wording is "In allen anderen Ferien gilt eine grundsätzliche
  //    Spielpflicht". NEVER derived from teams.league — see migration 278's header.
  const blackouts = blackoutsOn(date, ctx.blackouts)
  for (const b of blackouts) {
    if (b.kind === 'sperr') return REJECT_CODES.BLACKOUT_SPERR
    if (b.kind === 'ferien' && team.ferien_hard) return REJECT_CODES.BLACKOUT_FERIEN
  }

  // ── Superadmin blackout (scheduling_global_blocks). The set is already filtered to
  //    club-wide (sport IS NULL) + basketball rows by loadGeneratorContext — since
  //    migration 286 a VOLLEYBALL-only block no longer reaches basketball. ──
  if (ctx.clubBlockedDates.has(date)) return REJECT_CODES.CLUB_BLOCK

  // ── Hall closures. A closure with no hall means the whole site is shut. A+B needs both. ──
  const closed = ctx.closedHallsByDate.get(date)
  if (closed) {
    if (closed.has('*')) return REJECT_CODES.HALL_CLOSED
    for (const part of hallComponents(hall)) if (closed.has(part)) return REJECT_CODES.HALL_CLOSED
  }

  // ── Volleyball. Time-aware (a 13:30 VB match does not block a 20:00 BB game), and A+B
  //    dies if EITHER half is taken. Mirrors hallOccupancy.ts so the prep grid agrees. ──
  const vb = ctx.vbBusyByDate.get(date)
  if (vb && vb.length) {
    for (const part of hallComponents(hall)) if (vbBlocksSlot(vb, part, time)) return REJECT_CODES.VOLLEYBALL
  }

  // ── The team's own start window, when it is hard. Both bounds inclusive. ──
  if (team.start_hard) {
    if (team.start_min && time < team.start_min) return REJECT_CODES.START_WINDOW
    if (team.start_max && time > team.start_max) return REJECT_CODES.START_WINDOW
  }

  // ── Blocked-date rules ("until oct", "holidays and weekend before"). ──
  if (team.blockedDates.has(date)) return REJECT_CODES.BLOCKED_RULE

  // ── Hall preference tiers. hard=true → only the rank-1 option exists for this team. ──
  // ── Hall tier. An `open` team (no rules row) may use any court. ──
  if (!team.open && !hallTierFor(team.halls, hall)) return REJECT_CODES.HALL_NOT_ALLOWED

  // ── Club timeslot→category matrix. A pitch with no matrix entry is not offered at all.
  //    An `open` team has no category to match, so the matrix cannot judge it: it is
  //    offered every pitch the weekday grid defines. Still gated on the pitch EXISTING,
  //    so a time nobody plays at is never invented. ──
  const slot = ctx.timeslotByKey.get(`${dow}|${time}`)
  if (!slot) return REJECT_CODES.CATEGORY_NOT_ALLOWED
  if (!team.open) {
    const allowed = slot.allow.includes(team.category) || slot.tolerate.includes(team.category)
    if (!allowed) return REJECT_CODES.CATEGORY_NOT_ALLOWED
  }

  // ── The planner marked this team unavailable on this date (basketball_hall_availability). ──
  if (ctx.unavailableTeamDates.has(`${team.team}|${date}`)) return REJECT_CODES.TEAM_UNAVAILABLE

  // ── The team already plays AWAY that day (a `games` fixture). You cannot host at KWI
  //    and be in the opponent's gym on the same date, so this is hard, not a penalty.
  //
  //    ⚠ Kept as its OWN code rather than folded into TEAM_UNAVAILABLE: the two have
  //    different fixes. A manual block is undone by the planner un-blocking it; an away
  //    fixture is undone only by moving or deleting the game. A reject tally that cannot
  //    tell them apart sends the planner to the wrong screen.
  //
  //    ⚠ AWAY only. A `games` HOME row is either the placement we made here (in which case
  //    blocking its own date would fight the own-slot exemption below) or a post-
  //    Spielplansitzung fixture ProBasket owns — neither is this rule's business.
  if (ctx.awayGameTeamDates.has(`${team.team}|${date}`)) return REJECT_CODES.AWAY_GAME

  // ── The team already HOSTS that day. A basketball team plays one game a day, so every
  //    other pitch on that date is noise — reported 06.09.2026 after the Spielplansitzung:
  //    "especially for h3 slots kept being suggested during which the team already has a
  //    home game". 98 live suggestions on prod sat on a date their own team already hosted.
  //
  //    ⚠ Its OWN pitch stays offered, exactly as PITCH_TAKEN exempts it below: the
  //    placement has to stay visible in the grid to remain removable.
  //
  //    ⚠ Both roads count — a `basketball_slot_plan` placement AND a `games` home row.
  //    The old comment here argued a home `games` row was "not this rule's business"
  //    because it is either our own placement or a ProBasket-owned fixture. Both of those
  //    are precisely reasons NOT to suggest another slot to the same team that day.
  //
  //    ⚠ HARD in generation, not a block in the grid: a planner may still hand-place a
  //    second game on the date (a junior double-header), the same way the rest gap only
  //    stops the suggestion.
  if (
    ctx.homeGameTeamDates.has(`${team.team}|${date}`) &&
    !ctx.ownPlacementPitches.has(`${team.team}|${date}|${time}|${hall}`)
  ) {
    return REJECT_CODES.HOME_GAME
  }

  // ── Rest gap. The day either side of one of this team's own games (a placed home game
  //    or an away fixture) is not SUGGESTED — see REST_GAP_DAYS for why this is not a block:
  //    the pitch stays in the grid and still takes a hand-placed game.
  //
  //    ⚠ `date` itself is never judged here. A team's own game on the day is already
  //    settled: away → AWAY_GAME above, home → its own placed pitch, which is deliberately
  //    exempted below so the placement stays visible and removable.
  if (team.rest_gap && ctx.teamGameDates) {
    for (let gap = 1; gap <= REST_GAP_DAYS; gap++) {
      if (ctx.teamGameDates.has(`${team.team}|${addDays(date, -gap)}`)) return REJECT_CODES.ADJACENT_GAME
      if (ctx.teamGameDates.has(`${team.team}|${addDays(date, gap)}`)) return REJECT_CODES.ADJACENT_GAME
    }
  }

  // ── A placed game already holds a colliding court at this pitch (unless it is ours). ──
  const placedHere = ctx.placementsByPitch.get(`${date}|${time}`) || []
  for (const p of placedHere) {
    if (!hallsCollide(p.hall, hall)) continue
    if (String(p.kscw_team) === String(team.team) && p.hall === hall) continue // our own slot
    return REJECT_CODES.PITCH_TAKEN
  }

  // ── "Cannot play the same time as this team" (team_links). Hard, but only enforceable
  //    against what is ALREADY PLACED — it is a placement-time invariant, not a property of
  //    the inventory. Future placements stay covered by the grid's highlightFor conflict
  //    logic (useBasketballPlan.ts).
  const partners = ctx.exclusivePartners.get(String(team.team))
  if (partners && partners.size) {
    for (const p of placedHere) if (partners.has(String(p.kscw_team))) return REJECT_CODES.PARTNER_SAME_TIME
  }

  return null
}

/**
 * SOFT rules → { score, reasons: [{code, delta}] }. Higher is better.
 * Pure function of the stored inputs, so two runs on unchanged data produce identical rows.
 */
export function scoreSlot(cand, team, ctx) {
  const { date, dow, time, hall } = cand
  const reasons = []
  const add = (code, delta) => { if (delta) reasons.push({ code, delta }) }

  if (team.preferred_dows.includes(dow)) add('preferred_day', SCORE.PREFERRED_DAY)

  const sam = ctx.spielsamstagStatus.get(date)
  if (sam && SCORE.SPIELSAMSTAG[sam]) add(`spielsamstag_${sam}`, SCORE.SPIELSAMSTAG[sam])

  const slot = ctx.timeslotByKey.get(`${dow}|${time}`)
  if (slot && slot.allow.includes(team.category)) add('category_allow', SCORE.CATEGORY_ALLOW)

  const tier = hallTierFor(team.halls, hall)
  if (tier) {
    if (tier.last_resort) add('hall_last_resort', SCORE.HALL_LAST_RESORT)
    else if (tier.rank <= 1) add('hall_preferred', SCORE.HALL_RANK1)
    else if (tier.rank === 2) add('hall_fallback', SCORE.HALL_RANK2)
  }

  // Keep coach/player-sharing partners back-to-back: an 'adjacent' partner already placed in
  // the pitch immediately before or after this one on this date.
  const adj = ctx.adjacentPartners.get(String(team.team))
  if (adj && adj.size) {
    const { times } = slotsForDate(dow)
    const idx = times.indexOf(time)
    for (const nt of [times[idx - 1], times[idx + 1]]) {
      if (!nt) continue
      const near = ctx.placementsByPitch.get(`${date}|${nt}`) || []
      if (near.some((p) => adj.has(String(p.kscw_team)))) { add('adjacent_partner', SCORE.ADJACENT_PARTNER); break }
    }
  }

  // "Back-to-back allowed? no" → penalise, do not remove: the sheet expresses a preference,
  // and a hard rule here would silently delete the only remaining pitch on a tight weekend.
  if (!team.own_back_to_back) {
    const { times } = slotsForDate(dow)
    const idx = times.indexOf(time)
    for (const nt of [times[idx - 1], times[idx + 1]]) {
      if (!nt) continue
      const near = ctx.placementsByPitch.get(`${date}|${nt}`) || []
      if (near.some((p) => String(p.kscw_team) === String(team.team))) { add('own_back_to_back', SCORE.OWN_BACK_TO_BACK); break }
    }
  }

  // A Ferien week that is not hard for this team is still a week the association avoids.
  if (!team.ferien_hard && blackoutsOn(date, ctx.blackouts).some((b) => b.kind === 'ferien')) {
    add('ferien_soft', SCORE.FERIEN_SOFT)
  }

  // Volleyball elsewhere in KWI the same day: legal, but a busy hall day for everyone.
  const vbCount = (ctx.vbBusyByDate.get(date) || []).length
  if (vbCount) add('vb_same_day', Math.max(SCORE.VB_SAME_DAY * vbCount, SCORE.VB_SAME_DAY_FLOOR))

  if ((ctx.bbPlacementCountByDate.get(date) || 0) >= SCORE.BUSY_DATE_THRESHOLD) add('busy_date', SCORE.BUSY_DATE)

  return { score: reasons.reduce((s, r) => s + r.delta, 0), reasons }
}

/**
 * The whole generation pass as a pure function: rules + context → the rows to write and a
 * per-team reject tally. No IO, so the tests can drive it end to end.
 */
export function planSlots(teamRules, ctx) {
  const rows = []
  const perTeam = []
  for (const team of teamRules) {
    const ranges = ctx.gridsByLeague[team.league] || ctx.gridsByLeague[DEFAULT_LEAGUE] || []
    const cands = candidateSlots(ranges)
    const rejects = {}
    let kept = 0
    for (const cand of cands) {
      const reason = hardReject(cand, team, ctx)
      if (reason) { rejects[reason] = (rejects[reason] || 0) + 1; continue }
      const { score, reasons } = scoreSlot(cand, team, ctx)
      rows.push({
        kscw_team: team.team,
        date: cand.date,
        time: cand.time,
        end_time: slotEndTime(cand.time),
        hall: cand.hall,
        score,
        score_reasons: reasons,
      })
      kept++
    }
    perTeam.push({ team: team.team, league: team.league, candidates: cands.length, kept, rejects })
  }
  // Stable order — the write phase and the tests both depend on it.
  rows.sort((a, b) =>
    a.kscw_team - b.kscw_team || a.date.localeCompare(b.date) ||
    a.time.localeCompare(b.time) || a.hall.localeCompare(b.hall))
  return { rows, perTeam }
}

/** Identity key — must match basketball_slots_identity_unique exactly. */
export function slotKey(seasonId, r) {
  return `${seasonId}|${r.kscw_team}|${r.date}|${r.time}|${r.hall}`
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// Routes
// ═══════════════════════════════════════════════════════════════════════════════════════

/** Chunk size for the bulk upsert — keeps the parameter count well under Postgres's limit. */
const INSERT_CHUNK = 400
/** Runaway guard: 11 teams × ~93 dates × 4 pitches × 4 halls is ~16k before hard filters. */
const MAX_GENERATED_SLOTS = 40000

export function registerBasketballSlots(router, { database, logger }) {
  const log = logger.child({ endpoint: 'basketball-slots' })

  const attempts = new Map() // ip → { count, resetAt }
  function rateLimit(req, maxAttempts, windowMs) {
    const xff = req.headers['x-forwarded-for']
    const ip = req.headers['cf-connecting-ip']
      || (typeof xff === 'string' ? xff.split(',')[0].trim() : '')
      || req.ip || 'unknown'
    const now = Date.now()
    const a = attempts.get(ip)
    if (a && now < a.resetAt) {
      if (a.count >= maxAttempts) return false
      a.count++
    } else {
      attempts.set(ip, { count: 1, resetAt: now + windowMs })
    }
    if (attempts.size > 1000) for (const [k, v] of attempts) if (now > v.resetAt) attempts.delete(k)
    return true
  }

  /**
   * Who may run the basketball generator. Mirrors src/components/BasketballAdminRoute.tsx
   * exactly — a Directus admin, an app admin/superuser, a basketball sport admin (bb_admin),
   * or a club-wide Spielplaner (members.is_spielplaner). Deliberately NOT the volleyball
   * `isAdminOrSpielplaner`, which does not know about bb_admin.
   */
  async function isBasketballPlanner(req) {
    if (req.accountability?.admin) return true
    const userId = req.accountability?.user
    if (!userId) return false
    const m = await database('members').where('user', userId).first('role', 'is_spielplaner')
    if (!m) return false
    if (m.is_spielplaner === true) return true
    const roles = Array.isArray(m.role) ? m.role : parseJsonColumn(m.role, [])
    return Array.isArray(roles)
      && (roles.includes('superuser') || roles.includes('admin') || roles.includes('bb_admin'))
  }

  /**
   * Everything the rule engine needs, read once per run. All reads; the only write is the
   * upsert in the generator's transaction.
   */
  async function loadGeneratorContext(season) {
    const seasonId = Number(season.id)
    const cfg = parseJsonColumn(season.bb_slot_config, {}) || {}

    const timeslots = Array.isArray(cfg.timeslots) && cfg.timeslots.length ? cfg.timeslots : DEFAULT_TIMESLOT_MATRIX
    const timeslotByKey = new Map()
    for (const t of timeslots) {
      if (t?.dow == null || !t?.time) continue
      timeslotByKey.set(`${t.dow}|${t.time}`, {
        allow: Array.isArray(t.allow) ? t.allow : [],
        tolerate: Array.isArray(t.tolerate) ? t.tolerate : [],
      })
    }

    const spielsamstagStatus = new Map()
    for (const s of Array.isArray(cfg.spielsamstage) ? cfg.spielsamstage : []) {
      if (s?.date) spielsamstagStatus.set(String(s.date).slice(0, 10), String(s.status || 'desired'))
    }

    const baseGrids = PROBASKET_GRIDS_BY_SEASON[season.season] || PROBASKET_GRIDS_BY_SEASON['2026/27']
    // OPEN = the union of every league window, for teams with no rules row ("open to
    // all"). Added here rather than to the PROBASKET_* literal so it stays derived: a
    // new or edited league window widens it automatically instead of drifting.
    const gridsByLeague = { ...baseGrids, [OPEN_LEAGUE]: widestGrid(baseGrids) }
    const blackouts = blackoutsForCanton(
      PROBASKET_BLACKOUTS_BY_SEASON[season.season] || PROBASKET_BLACKOUTS_2026_27,
      KSCW_CANTON,
    )

    // ── Halls: we only care about the three KWI courts, keyed by NAME (the hall vocabulary
    //    in basketball_slots is names, not ids — ProBasket's forms speak names). ──
    const halls = await database('halls').select('id', 'name')
    const hallNameById = new Map(halls.map((h) => [String(h.id), h.name]))

    // ── Hall closures. hall NULL = the whole site (the FK is ON DELETE SET NULL, so an
    //    orphaned row must fail SAFE and block, never silently free a court).
    //    Bounded to the season: hall_closures carries school holidays to 2030 and every
    //    range is stored once PER HALL, so an unbounded read expands ~700 rows into years
    //    of irrelevant days. Season-WIDE though, not per-league — one workbook can hold a
    //    junior sheet (grid ends 13.12.2026) and a 1.-Liga sheet (ends 09.05.2027). ──
    const seasonYear = parseInt(String(season.season ?? '').slice(0, 4), 10)
    const seasonFloor = Number.isFinite(seasonYear) ? `${seasonYear}-08-01` : null
    const seasonCeiling = Number.isFinite(seasonYear) ? `${seasonYear + 1}-07-31` : null
    const closures = await database('hall_closures')
      .select('hall', database.raw('start_date::text as start_date'), database.raw('end_date::text as end_date'),
        'reason', 'source')
      .whereNotNull('start_date').whereNotNull('end_date')
      .modify((q) => {
        if (seasonFloor) q.where('end_date', '>=', seasonFloor)
        if (seasonCeiling) q.where('start_date', '<=', seasonCeiling)
      })
    const closedHallsByDate = new Map()
    for (const c of closures) {
      const name = c.hall != null ? hallNameById.get(String(c.hall)) ?? null : null
      for (const d of eachDate(c.start_date.slice(0, 10), c.end_date.slice(0, 10))) {
        const set = closedHallsByDate.get(d) ?? new Set()
        set.add(name ?? '*')
        closedHallsByDate.set(d, set)
      }
    }
    // School-holiday ranges, de-duplicated: the sync writes one row PER HALL, so the same
    // range appears three times and the "weekend before" offset would be recomputed thrice.
    const holidaySeen = new Set()
    const holidayRanges = []
    for (const c of closures) {
      if (c.source !== 'school_holidays') continue
      const k = `${c.start_date.slice(0, 10)}|${c.end_date.slice(0, 10)}`
      if (holidaySeen.has(k)) continue
      holidaySeen.add(k)
      holidayRanges.push({ start: c.start_date.slice(0, 10), end: c.end_date.slice(0, 10), reason: c.reason || '' })
    }

    // ── Club-wide superadmin blackout (same source as GET /terminplanung/admin/club-blocked-dates). ──
    // ⚠ `sport IS NULL OR sport = 'basketball'` — NEVER a bare equality. NULL means
    //   club-wide (migration 286's default), so `where('sport','basketball')` would
    //   silently drop every club-wide blackout and let a game land on a closed hall.
    //   The column exists because a VOLLEYBALL U20 tournament was blocking basketball.
    const clubBlocks = await database('scheduling_global_blocks')
      .where((q) => q.whereNull('sport').orWhere('sport', 'basketball'))
      .select(database.raw('start_date::text as start_date'), database.raw('end_date::text as end_date'))
    const clubBlockedDates = new Set()
    for (const b of clubBlocks) {
      for (const d of eachDate(b.start_date.slice(0, 10), b.end_date.slice(0, 10))) clubBlockedDates.add(d)
    }

    // ── Volleyball bookings in KWI. Time-aware; a row with no start_time blocks all day. ──
    const vbSlots = await database('game_scheduling_slots')
      .where('season', seasonId).where('status', 'booked')
      .select(database.raw('date::text as date'), 'hall', 'start_time', 'end_time')
    const vbBusyByDate = new Map()
    for (const s of vbSlots) {
      const name = s.hall != null ? hallNameById.get(String(s.hall)) : null
      if (!name) continue
      const d = String(s.date).slice(0, 10)
      const arr = vbBusyByDate.get(d) ?? []
      arr.push({ hall: name, start: s.start_time ?? null, end: s.end_time ?? null })
      vbBusyByDate.set(d, arr)
    }

    // ── Basketball games already placed by hand. ──
    const placements = await database('basketball_slot_plan')
      .where('season', seasonId)
      .select('id', database.raw('date::text as date'), 'time', 'hall', 'kscw_team')
    const placementsByPitch = new Map()
    const bbPlacementCountByDate = new Map()
    for (const p of placements) {
      const d = String(p.date).slice(0, 10)
      const k = `${d}|${String(p.time).slice(0, 5)}`
      const arr = placementsByPitch.get(k) ?? []
      arr.push({ hall: p.hall, kscw_team: p.kscw_team })
      placementsByPitch.set(k, arr)
      bbPlacementCountByDate.set(d, (bbPlacementCountByDate.get(d) || 0) + 1)
    }

    // ── Pair constraints. 'diff' and 'adjacent' both mean "must not play at the same time"
    //    (the sheet's hard column 4 and soft column 6 carry identical partner lists);
    //    'adjacent' additionally earns the neighbouring-pitch bonus. ──
    const links = await database('team_links')
      .where('season', seasonId).where('sport', 'basketball')
      .select('team_a', 'team_b', 'link_type')
    const exclusivePartners = new Map()
    const adjacentPartners = new Map()
    const push = (map, a, b) => {
      const s = map.get(String(a)) ?? new Set()
      s.add(String(b))
      map.set(String(a), s)
    }
    for (const l of links) {
      if (l.link_type === 'diff' || l.link_type === 'adjacent') {
        push(exclusivePartners, l.team_a, l.team_b)
        push(exclusivePartners, l.team_b, l.team_a)
      }
      if (l.link_type === 'adjacent') {
        push(adjacentPartners, l.team_a, l.team_b)
        push(adjacentPartners, l.team_b, l.team_a)
      }
    }

    // ── Per-team, per-date "not available" flags the planner set by hand. ──
    const avail = await database('basketball_hall_availability')
      .where('season', seasonId).where('unavailable', true)
      .select('team', database.raw('date::text as date'))
    const unavailableTeamDates = new Set(avail.map((a) => `${a.team}|${String(a.date).slice(0, 10)}`))

    // ── Away fixtures. A team in the opponent's gym cannot also host at KWI that day.
    //
    // ⚠ Read from `games`, NOT from basketball_slot_plan — an away game must never become a
    // slot-plan row. That table is keyed to a KWI pitch (`hall` NOT NULL, UNIQUE per
    // season/date/time/hall) and carries three triggers, one of which files a
    // `basketball_floor_claims` row: an away row would claim a KWI floor and take a court
    // away from volleyball for a game played somewhere else entirely.
    //
    // ⚠ Matched on the season LABEL ('2026/27'), which is what `games.season` stores — the
    // scheduling season's numeric id means nothing to that table. A season row with no
    // label yields no away blocks rather than an accidental club-wide match.
    const seasonLabel = String(season.season || '').trim()
    const bbGames = seasonLabel
      ? await database('games as g')
        .join('teams as t', 't.id', 'g.kscw_team')
        .where('t.sport', 'basketball')
        .where('g.season', seasonLabel)
        .whereIn('g.type', ['home', 'away'])
        .whereNotNull('g.date')
        .select('g.kscw_team', 'g.type', database.raw('g.date::text as date'))
      : []
    const teamDate = (g) => `${g.kscw_team}|${String(g.date).slice(0, 10)}`
    const awayGameTeamDates = new Set(bbGames.filter((g) => g.type === 'away').map(teamDate))
    // HOME fixtures are read too since 06.09.2026 — see the HOME_GAME rule in hardReject.
    const homeFixtureTeamDates = new Set(bbGames.filter((g) => g.type === 'home').map(teamDate))

    // ── Every date a team ALREADY has a game — its placed home games plus those away
    //    fixtures. Feeds the rest gap in hardReject.
    //
    //    ⚠ Deliberately the SAME sources the prep grid draws from (basketball_slot_plan
    //    + every `games` fixture of either side), so the live grid and the generated
    //    inventory agree about which dates sit next to a game. Home rows were excluded
    //    until 06.09.2026 on the argument that a ProBasket-owned fixture "is not this
    //    tool's to re-suggest around" — which had it backwards: a fixed home fixture is
    //    the strongest possible reason not to offer that team another pitch.
    //
    //    ⚠ Away fixtures fall on ANY weekday (club rule 2026-09-02) — a Thursday away game
    //    closes Friday's pitches, a Monday one closes Sunday's. Hence dates, not the
    //    Fri/Sat/Sun candidate grid.
    const teamGameDates = new Set([...awayGameTeamDates, ...homeFixtureTeamDates])
    // Dates the team already HOSTS, plus the exact pitch of each of its own placements —
    // the pair the HOME_GAME rule needs (the date rejects, its own pitch is exempt).
    const homeGameTeamDates = new Set(homeFixtureTeamDates)
    const ownPlacementPitches = new Set()
    for (const p of placements) {
      if (p.kscw_team == null) continue
      const d = String(p.date).slice(0, 10)
      teamGameDates.add(`${p.kscw_team}|${d}`)
      homeGameTeamDates.add(`${p.kscw_team}|${d}`)
      ownPlacementPitches.add(`${p.kscw_team}|${d}|${p.time}|${p.hall}`)
    }

    // Club-wide weekend cap. `spielsamstage_hard` makes the Spielsamstag list a HARD
    // filter for every team (see hardReject); `max_weekends` is carried for reporting
    // so a mismatch between the agreed cap and the configured list is visible rather
    // than silent.
    const spielsamstagHard = cfg.spielsamstage_hard === true && spielsamstagStatus.size > 0
    return {
      timeslotByKey, spielsamstagStatus, spielsamstagHard,
      maxWeekends: Number.isFinite(Number(cfg.max_weekends)) ? Number(cfg.max_weekends) : null,
      gridsByLeague, blackouts,
      closedHallsByDate, holidayRanges, clubBlockedDates, vbBusyByDate,
      placementsByPitch, bbPlacementCountByDate, exclusivePartners, adjacentPartners,
      unavailableTeamDates,
      awayGameTeamDates, teamGameDates, homeGameTeamDates, ownPlacementPitches,
    }
  }

  /**
   * The rule for a team with NO `basketball_team_rules` row: open to everything.
   *
   * Deliberately NOT "the defaults of a real rule" — `open: true` makes hardReject skip
   * the hall-tier and category gates outright, because a team with no configuration has
   * no hall preference and no category to match. Giving it a plausible-looking category
   * instead would quietly exclude it from pitches the matrix reserves for other groups,
   * which is the opposite of what "open to all" means.
   */
  function openTeamRule(teamId, ctx) {
    return {
      id: null,
      team: teamId,
      league: OPEN_LEAGUE,
      category: null,
      open: true,
      ferien_hard: false,        // 'ferien' binds only interregional + 1./2. Liga; unknown ⇒ soft
      allowed_dows: [...PLAY_DOW],
      preferred_dows: [],
      start_min: null,
      start_max: null,
      start_hard: false,
      halls: { hard: false, tiers: [] },   // never consulted while open:true
      own_back_to_back: true,
      rest_gap: false,           // no category ⇒ no team preference to enforce (see REST_GAP_DAYS)
      blockedDates: new Set(),
    }
  }

  /** Normalise a basketball_team_rules row + expand its blocked rules against the ctx. */
  function prepareTeamRule(row, ctx) {
    const league = String(row.league || DEFAULT_LEAGUE)
    const category = String(row.category || 'seniors')
    const ranges = ctx.gridsByLeague[league] || ctx.gridsByLeague[DEFAULT_LEAGUE] || []
    const dates = []
    for (const r of ranges) for (const d of eachDate(r.start, r.end)) if (PLAY_DOW.includes(dowOf(d))) dates.push(d)
    return {
      id: row.id,
      team: row.team,
      league,
      category,
      // Derived, not stored: the club stated the exemption as "not for junior teams", and
      // `category` is the club's own junior/senior axis. One column if it ever needs a
      // per-team override.
      rest_gap: restGapApplies(category),
      ferien_hard: row.ferien_hard === true,
      allowed_dows: (parseJsonColumn(row.allowed_dows, [5, 6, 0]) || []).map(Number),
      preferred_dows: (parseJsonColumn(row.preferred_dows, []) || []).map(Number),
      start_min: row.start_min || null,
      start_max: row.start_max || null,
      start_hard: row.start_hard !== false,
      halls: parseJsonColumn(row.halls, { hard: false, tiers: [] }) || { hard: false, tiers: [] },
      own_back_to_back: row.own_back_to_back !== false,
      blockedDates: expandBlockedRules(parseJsonColumn(row.blocked, []), ctx.holidayRanges, dates),
    }
  }

  // ── POST /kscw/terminplanung/admin/basketball/generate-slots ──────────────────────────
  //
  // Body: { season_id }. (Re)generates the candidate inventory for EVERY active basketball
  // team.
  //   · a team WITH an enabled basketball_team_rules row is planned against that row;
  //   · a team with NO row is "open to all" (user rule 2026-08-05) — every pitch the
  //     weekday grid defines, over the widest league window, with no weekday/start/hall/
  //     category/blocked-date restriction. It is NOT skipped, which is what it used to be.
  //   · a row explicitly `enabled = false` IS still skipped — that is the deliberate
  //     opt-out, and it must stay distinguishable from "nobody has configured me yet".
  //
  // Idempotent by construction:
  //   · rows are keyed by (season, kscw_team, date, time, hall) — the table's unique;
  //   · generated rows that are no longer candidates are deleted, unless they are PLACED;
  //   · source='manual' rows are never inserted over, never deleted;
  //   · `status` is never merged on conflict, so a placed slot keeps its placement.
  // A re-run on unchanged data must report created:0, deleted:0 and identical scores.
  router.post('/terminplanung/admin/basketball/generate-slots', async (req, res) => {
    if (!rateLimit(req, 20, 60 * 60 * 1000)) return res.status(429).json({ error: 'Too many requests' })
    if (!(await isBasketballPlanner(req))) return res.status(403).json({ error: 'Admin only' })
    try {
      const seasonId = Number(req.body?.season_id)
      if (!Number.isInteger(seasonId)) return res.status(400).json({ error: 'season_id required' })

      const season = await database('game_scheduling_seasons').where('id', seasonId).first()
      if (!season) return res.status(404).json({ error: 'Season not found' })

      const ctx = await loadGeneratorContext(season)

      const allRows = await database('basketball_team_rules')
        .where('season', seasonId)
        .orderBy('team')
      const ruleByTeam = new Map(allRows.map((r) => [String(r.team), r]))

      // Every ACTIVE basketball team is planned, not just the configured ones.
      const activeTeams = await database('teams')
        .where('sport', 'basketball').where('active', true)
        .select('id', 'name')
        .orderBy('id')

      const teams = []
      const openTeams = []
      for (const t of activeTeams) {
        const row = ruleByTeam.get(String(t.id))
        // An explicit enabled=false is an opt-out and stays skipped; only the ABSENCE
        // of a row means "open to all".
        if (row && row.enabled !== true) continue
        if (row) { teams.push(prepareTeamRule(row, ctx)); continue }
        teams.push(openTeamRule(t.id, ctx))
        openTeams.push(t.name || String(t.id))
      }
      if (!teams.length) {
        return res.status(400).json({
          error: 'no_teams',
          message: 'No active basketball teams to plan for this season.',
        })
      }
      if (openTeams.length) {
        log.info({ msg: `[bb-slots] ${openTeams.length} team(s) planned as OPEN (no rules row): ${openTeams.join(', ')}` })
      }

      const { rows, perTeam } = planSlots(teams, ctx)
      if (rows.length > MAX_GENERATED_SLOTS) {
        return res.status(400).json({
          error: 'too_many_slots',
          message: `Generator produced ${rows.length} candidates (limit ${MAX_GENERATED_SLOTS}). Tighten the team rules.`,
        })
      }

      const runId = crypto.randomUUID()
      const now = new Date()
      let created = 0
      let updated = 0
      let deleted = 0

      await database.transaction(async (trx) => {
        const existing = await trx('basketball_slots')
          .where('season', seasonId)
          .select('id', 'kscw_team', database.raw('date::text as date'), 'time', 'hall', 'source', 'status')

        const existingByKey = new Map()
        for (const e of existing) {
          existingByKey.set(slotKey(seasonId, { kscw_team: e.kscw_team, date: String(e.date).slice(0, 10), time: e.time, hall: e.hall }), e)
        }

        // Manual rows are immortal: never overwritten, never deleted. Drop any candidate
        // that would collide with one so the upsert cannot clobber a hand-added slot.
        const wanted = rows.filter((r) => {
          const e = existingByKey.get(slotKey(seasonId, r))
          return !(e && e.source === 'manual')
        })
        const wantedKeys = new Set(wanted.map((r) => slotKey(seasonId, r)))

        // Delete generated, non-placed rows that stopped being candidates. A PLACED row
        // survives even when the rules no longer offer it — the placement is a fact on the
        // plan and deleting it here would silently unmake a decision a human took.
        const staleIds = existing
          .filter((e) => e.source === 'generated' && e.status !== 'placed'
            && !wantedKeys.has(slotKey(seasonId, { kscw_team: e.kscw_team, date: String(e.date).slice(0, 10), time: e.time, hall: e.hall })))
          .map((e) => e.id)
        for (let i = 0; i < staleIds.length; i += INSERT_CHUNK) {
          deleted += await trx('basketball_slots').whereIn('id', staleIds.slice(i, i + INSERT_CHUNK)).del()
        }

        for (const r of wanted) {
          if (existingByKey.has(slotKey(seasonId, r))) updated++
          else created++
        }

        const payload = wanted.map((r) => ({
          season: seasonId,
          kscw_team: r.kscw_team,
          date: r.date,
          time: r.time,
          end_time: r.end_time,
          hall: r.hall,
          status: 'available',
          source: 'generated',
          score: r.score,
          score_reasons: JSON.stringify(r.score_reasons),
          generation_run: runId,
          generated_at: now,
          date_updated: now,
        }))
        for (let i = 0; i < payload.length; i += INSERT_CHUNK) {
          await trx('basketball_slots')
            .insert(payload.slice(i, i + INSERT_CHUNK))
            .onConflict(['season', 'kscw_team', 'date', 'time', 'hall'])
            // `status`, `source`, `plan`, `note` and `created_by` are deliberately absent:
            // merging status would un-place a placed slot, and merging source would
            // reclassify a manual row (they are already excluded, belt and braces).
            .merge(['end_time', 'score', 'score_reasons', 'generation_run', 'generated_at', 'date_updated'])
        }
      })

      await writeUserLog(database, log, {
        accountability: req.accountability,
        action: 'generate',
        collection: 'basketball_slots',
        recordId: seasonId,
        data: { kind: 'bb_generate_slots', run_id: runId, created, updated, deleted, teams: perTeam.length },
      })

      res.json({ success: true, run_id: runId, created, updated, deleted, total: created + updated, per_team: perTeam })
    } catch (err) {
      log.error({ msg: `basketball/generate-slots: ${err.message}`, endpoint: 'terminplanung/admin/basketball/generate-slots', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // ── GET /kscw/terminplanung/admin/basketball/slots?season_id=&team_id= ────────────────
  // The grid feed. Read-only; same gate as the generator (the inventory reveals the club's
  // hall planning, which is not public).
  router.get('/terminplanung/admin/basketball/slots', async (req, res) => {
    if (!(await isBasketballPlanner(req))) return res.status(403).json({ error: 'Admin only' })
    try {
      const seasonId = Number(req.query.season_id)
      if (!Number.isInteger(seasonId)) return res.status(400).json({ error: 'season_id required' })
      const teamId = req.query.team_id != null ? Number(req.query.team_id) : null

      const q = database('basketball_slots')
        .where('season', seasonId)
        .select('id', 'kscw_team', database.raw('date::text as date'), 'time', 'end_time', 'hall',
          'status', 'source', 'score', 'score_reasons', 'plan', 'generation_run',
          database.raw('generated_at::text as generated_at'), 'note')
        .orderBy([{ column: 'date' }, { column: 'time' }, { column: 'score', order: 'desc' }, { column: 'hall' }])
      if (Number.isInteger(teamId)) q.where('kscw_team', teamId)

      const slots = await q
      res.json({ slots, count: slots.length })
    } catch (err) {
      log.error({ msg: `basketball/slots: ${err.message}`, endpoint: 'terminplanung/admin/basketball/slots', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // ── POST /kscw/terminplanung/admin/basketball/clear-slots ─────────────────────────────
  // Body: { season_id }. Drops the GENERATED, non-placed inventory. Manual rows and placed
  // slots survive — clearing must never unmake a decision a human took.
  router.post('/terminplanung/admin/basketball/clear-slots', async (req, res) => {
    if (!rateLimit(req, 20, 60 * 60 * 1000)) return res.status(429).json({ error: 'Too many requests' })
    if (!(await isBasketballPlanner(req))) return res.status(403).json({ error: 'Admin only' })
    try {
      const seasonId = Number(req.body?.season_id)
      if (!Number.isInteger(seasonId)) return res.status(400).json({ error: 'season_id required' })

      const deleted = await database('basketball_slots')
        .where('season', seasonId).where('source', 'generated').whereNot('status', 'placed')
        .del()

      await writeUserLog(database, log, {
        accountability: req.accountability,
        action: 'delete',
        collection: 'basketball_slots',
        recordId: seasonId,
        data: { kind: 'bb_clear_slots', deleted },
      })

      res.json({ success: true, deleted })
    } catch (err) {
      log.error({ msg: `basketball/clear-slots: ${err.message}`, endpoint: 'terminplanung/admin/basketball/clear-slots', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })
}
