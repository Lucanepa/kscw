import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../../../hooks/useAuth'
import { useGameSchedulingSeason } from '../hooks/useGameSchedulingSeason'
import { useAdminBookings } from '../hooks/useAdminBookings'
import { useTeams } from '../../../hooks/useTeams'
import { useReportPageLoading } from '../../../hooks/usePageReady'
import AwayProposalReview, { type AwayVmCheck, type AwayVmUnbooked } from '../components/AwayProposalReview'
import HomeProposalReview from '../components/HomeProposalReview'
import OpponentNotes from '../components/OpponentNotes'
import ManualBookingForm, { type ManualFixtureOption } from '../components/ManualBookingForm'
import ExcelExportButton from '../components/ExcelExportButton'
import SyncNowButton from '../components/SyncNowButton'
import InlineSpinner from '../../../components/InlineSpinner'
import {
  buildScheduleSections, buildScheduleXlsx, buildSchedulePdf,
  bytesToBase64, exportFilename, XLSX_MIME, PDF_MIME,
} from '../lib/scheduleExport'
import TeamAvailabilityDialog from '../components/TeamAvailabilityDialog'
import SchedulingCalendar, { type CalendarGame } from '../components/SchedulingCalendar'
import { useMailbox, classifyMessages, messagesForOwner, contactAddressSet, type MailboxMessage, type OpponentContacts } from '../hooks/useMailbox'
import { useConfirm } from '../../../components/ConfirmProvider'
import { Badge } from '../../../components/ui/badge'
import { Button } from '../../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { Table, TableBody, TableCell, TableRow } from '../../../components/ui/table'
import type { GameSchedulingOpponent, GameSchedulingSeason, GameSchedulingSlot, InviteStatus, InviteSource, ProposalHealthEntry } from '../../../types'
import type { ExpandedBooking } from '../hooks/useAdminBookings'
import { formatSeasonShort } from '../utils/formatSeason'
import { gameStartForDate } from '../utils/slotTime'
import { formatDateCompactZurich, formatDateTimeCompact } from '../../../utils/dateHelpers'
import { buildMailtoHref } from '../../../utils/sanitizeUrl'
import { kscwApi, fetchAllItems } from '../../../lib/api'
import { useHalls } from '../../../hooks/useData'
// Basketball half of this page (see BasketballDashboardBody at the bottom).
import { useBasketballPlan } from '../hooks/useBasketballPlan'
import { homeGamesFor } from '../utils/bbHomeGames'
import { useBasketballSlots } from '../hooks/useBasketballSlots'
import { useBasketballOffers } from '../hooks/useBasketballOffers'
import { useBasketballClubPortals } from '../hooks/useBasketballClubPortals'
import { BasketballCalendarPanel } from './BasketballCalendarPage'
import { isSchedulableTeam } from '../utils/schedulableTeams'

/** One SVRZ fixture for an opponent (from the svrz-clubs endpoint). */
interface OpponentGame {
  /** svrz_games.svrz_persistence_id — the key bookings attach to (multi-game pairings). */
  svrz_game_id?: string | null
  /** Official SVRZ game number (svrz_games.svrz_number), e.g. 406192. */
  number?: string | number | null
  date: string | null
  display_name: string | null
  is_home_kscw: boolean
  /** UI-only: real agreed date (dd.mm.yyyy HH:MM) overlaid from a confirmed
   *  booking, so the modal shows it instead of the unscheduled SVRZ placeholder. */
  _realDate?: string
}
interface SvrzClub {
  club_id: number
  club_name: string
  team_name: string
  game_count: number
  games: OpponentGame[]
}

/** One schedulable game of a pairing in the admin card — a pairing can be
 *  played 2-3× per season, so each side may carry several fixtures. */
interface FixtureLeg {
  key: string
  svrzGameId: string | null
  /** Official SVRZ game number, shown next to the "Game N" label. */
  number: string | number | null
  seq: number
  sideCount: number
  booking?: ExpandedBooking
}

// Legs for one side of an opponent card: one per fixture (a NULL-keyed legacy
// booking belongs to the FIRST fixture — mirrors the backend keying), plus
// bookings whose fixture is no longer in the feed so a confirmed game never
// vanishes. No fixtures and no bookings ANYWHERE in the pairing → a single empty
// leg (awaiting proposals — the pre-multi-game layout, and the only shape a
// non-SVRZ/manual opponent ever has).
// ⚠ The empty-leg fallback is keyed on the WHOLE pairing, not this side: a
// pairing with fixtures on one side only (single-round group) would otherwise
// grow a phantom game on the empty side — "1 fixture" rendering as 2 games.
function buildFixtureLegs(oppGames: OpponentGame[], oppBookings: ExpandedBooking[], isHome: boolean): FixtureLeg[] {
  const side = oppGames.filter((g) => g.is_home_kscw === isHome)
  const sideBookings = oppBookings.filter((b) => b.type === (isHome ? 'home_slot_pick' : 'away_proposal'))
  const used = new Set<string>()
  const legs: FixtureLeg[] = side.map((g, i) => {
    let bk = g.svrz_game_id
      ? sideBookings.find((b) => String(b.svrz_game_id || '') === String(g.svrz_game_id))
      : undefined
    if (!bk && i === 0) bk = sideBookings.find((b) => b.svrz_game_id == null && !used.has(String(b.id)))
    if (bk) used.add(String(bk.id))
    return { key: String(g.svrz_game_id ?? `fixture-${i}`), svrzGameId: g.svrz_game_id ?? null, number: g.number ?? null, seq: i + 1, sideCount: side.length, booking: bk }
  })
  for (const b of sideBookings) {
    if (used.has(String(b.id))) continue
    legs.push({ key: `bk-${b.id}`, svrzGameId: b.svrz_game_id ?? null, number: null, seq: legs.length + 1, sideCount: side.length, booking: b })
  }
  // Keyed on oppGames (the pairing's synced fixtures), NOT oppBookings: a manual
  // opponent with only an away booking still needs its empty home leg — that leg
  // is what ManualBookingForm offers as the "home game" target.
  if (legs.length === 0 && oppGames.length === 0) {
    legs.push({ key: isHome ? 'legacy-home' : 'legacy-away', svrzGameId: null, number: null, seq: 1, sideCount: 1 })
  }
  return legs.map((l) => ({ ...l, sideCount: legs.length }))
}

// Pre-fill values for the manual-booking form when a leg already has a confirmed
// booking — selecting that fixture starts the fields at the current date/time/hall
// so an overwrite is "tweak the time", not retype from scratch.
function homeLegPrefill(leg: FixtureLeg): ManualFixtureOption['prefill'] | undefined {
  const b = leg.booking
  if (!b || b.status !== 'confirmed') return undefined
  const slot = (typeof b.slot === 'object' ? b.slot : null) as GameSchedulingSlot | null
  if (!slot) return undefined
  return {
    date: String(slot.date).slice(0, 10),
    start_time: gameStartForDate(slot.date, slot.start_time),
    hall: slot.hall != null ? String(slot.hall) : undefined,
  }
}

// Away confirmed bookings store the agreed slot as proposed_datetime_<n> (naive
// wall-clock, e.g. "2026-10-03T18:00", may come back "…Z") — slice it, don't
// tz-convert, to mirror AwayProposalReview.
function awayLegPrefill(leg: FixtureLeg): ManualFixtureOption['prefill'] | undefined {
  const b = leg.booking
  if (!b || b.status !== 'confirmed') return undefined
  const n = b.confirmed_proposal || 1
  const rec = b as unknown as Record<string, unknown>
  const dt = String(rec[`proposed_datetime_${n}`] || '')
  const m = dt.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?/)
  if (!m) return undefined
  const place = String(rec[`proposed_place_${n}`] || '')
  return { date: m[1], start_time: m[2] ? `${m[2]}:${m[3]}` : undefined, place: place || undefined }
}

const normName = (s: string | null | undefined) => String(s || '').trim().toLowerCase()

// The season's offer window [start, end] (YYYY-MM-DD) — the configurable
// season_opens / season_closes when set (migration 108), else Sep 1 (first year)
// → Mar 31 (second year) derived from the season name (e.g. "2026/27"). Mirrors
// the backend `seasonOfferWindow`; used to bound the manual-booking date inputs
// so a typo like 10.02.2026 for a 2026/27 season can't be entered.
function computeSeasonWindow(season: GameSchedulingSeason | null): { start: string; end: string } | null {
  if (!season) return null
  const m = String(season.season || '').match(/(\d{4})\D+(\d{2,4})/)
  let dStart: string | null = null
  let dEnd: string | null = null
  if (m) {
    const y1 = parseInt(m[1], 10)
    let y2 = parseInt(m[2], 10)
    if (y2 < 100) y2 = 2000 + y2
    dStart = `${y1}-09-01`
    dEnd = `${y2}-03-31`
  }
  const start = (season.season_opens || dStart)?.slice(0, 10) || null
  const end = (season.season_closes || dEnd)?.slice(0, 10) || null
  return start && end ? { start, end } : null
}

// Read an ISO timestamp's WALL-CLOCK lexically (no tz conversion) as
// dd.mm.yyyy HH:MM — matches how the away date is mirrored into `games`
// (reconcileBookingsToGames extracts the time lexically too), so the modal
// agrees with the member calendar (e.g. 18:00, not a tz-shifted 19:00).
function fixtureWallClock(iso: string | null | undefined): string {
  const s = String(iso || '')
  const d = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!d) return ''
  const tm = s.match(/[T ](\d{2}:\d{2})/)
  return `${d[3]}.${d[2]}.${d[1]}${tm ? ` ${tm[1]}` : ''}`
}

// The "N games" modal lists SVRZ fixtures at their feed date — but an away game
// we've already agreed sits at the unscheduled placeholder until the opponent
// enters it in VM. Overlay the confirmed away booking's agreed date so the modal
// shows the real date, not the placeholder. (Home games keep their feed date —
// it's real once pushed to VM.)
function overlayBookedDates(games: OpponentGame[], bookings: ExpandedBooking[]): OpponentGame[] {
  return games.map((g) => {
    if (g.is_home_kscw || !g.svrz_game_id) return g
    const b = bookings.find((bk) =>
      bk.type === 'away_proposal' && bk.status === 'confirmed' &&
      String(bk.svrz_game_id || '') === String(g.svrz_game_id))
    if (!b) return g
    const dt = (b as unknown as Record<string, string>)[`proposed_datetime_${b.confirmed_proposal || 1}`]
    const real = fixtureWallClock(dt)
    return real ? { ...g, _realDate: real } : g
  })
}

const INVITE_STATUS_VARIANT: Record<InviteStatus, 'info' | 'warning' | 'success' | 'danger' | 'neutral' | 'secondary'> = {
  invited: 'info',
  viewed: 'warning',
  booked: 'success',
  revoked: 'danger',
  expired: 'neutral',
  active: 'secondary',
}

const SOURCE_VARIANT: Record<InviteSource, 'brand' | 'neutral' | 'outline'> = {
  svrz: 'brand',
  self_registration: 'neutral',
  manual: 'outline' as 'neutral',
}

function inviteStatusKey(status: InviteStatus | undefined): string {
  const s = status || 'active'
  return `status${s.charAt(0).toUpperCase()}${s.slice(1)}`
}

function sourceKey(source: InviteSource | undefined): string {
  if (source === 'svrz') return 'sourceSvrz'
  if (source === 'manual') return 'sourceManual'
  return 'sourceSelfRegistration'
}

/**
 * ONE dashboard, two sports.
 *
 * The volleyball body below is coupled to the bilateral flow from its very first
 * hook (`useAdminBookings` → proposals, confirmations, VM push, SVRZ fixtures).
 * Basketball has none of that: ProBasket owns the schedule (physical
 * Spielplansitzung + Basketplan) and there is no push-back, so those panels are
 * not "hidden" for basketball — they have no data to show and no action to offer.
 *
 * Hence a dispatcher rather than conditional panels: React forbids conditional
 * hooks, so keeping both bodies in one function would run every volleyball query
 * on the basketball tab and then throw the results away. Each body owns its own
 * hooks; the shell (route, nav tab, layout, season) is shared.
 */
export default function AdminDashboardPage({ sport = 'volleyball' }: { sport?: 'volleyball' | 'basketball' } = {}) {
  if (sport === 'basketball') return <BasketballDashboardBody />
  return <VolleyballDashboardBody />
}

function VolleyballDashboardBody() {
  const { t } = useTranslation('gameScheduling')
  const navigate = useNavigate()
  const { hasAdminAccessToSport, is_spielplaner } = useAuth()
  const { season, isLoading: seasonLoading } = useGameSchedulingSeason()
  const { bookings, opponents, slots, proposalHealth, isLoading, hasLoaded, confirmAwayProposal, confirmHomeProposal, requestNewSlots, saveOpponentNote, manualBooking, deleteBooking, blockSlot, finalizeNotify, vmPush, refetch } = useAdminBookings(season?.id)
  const { data: teams, isLoading: teamsLoading } = useTeams()
  const confirm = useConfirm()
  const [expandedTeam, setExpandedTeam] = useState<string | null>(null)
  const [notifyingTeam, setNotifyingTeam] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const mailbox = useMailbox(hasAdminAccessToSport('volleyball') || is_spielplaner, 'volleyball')

  // Intra-club games (e.g. the H1↔H3 derby) — not bookings, so they don't come
  // through useAdminBookings. Surface them on the overview + per-team calendars.
  const [derbyGames, setDerbyGames] = useState<CalendarGame[]>([])
  // Tracks the first derby fetch so the page can wait for it before rendering
  // (otherwise the intra-club games pop into the calendars after the spinner).
  const [derbyLoaded, setDerbyLoaded] = useState(false)
  useEffect(() => {
    if (!season?.season) return
    let cancelled = false
    fetchAllItems<CalendarGame>('games', {
      filter: { season: { _eq: season.season }, home_team: { _starts_with: 'KSC Wiedikon' }, away_team: { _starts_with: 'KSC Wiedikon' } },
      fields: ['id', 'game_id', 'date', 'time', 'home_team', 'away_team', 'kscw_team', 'type', 'hall'],
    }).then((g) => { if (!cancelled) setDerbyGames(g) })
      .catch(() => { if (!cancelled) setDerbyGames([]) })
      .finally(() => { if (!cancelled) setDerbyLoaded(true) })
    return () => { cancelled = true }
  }, [season?.season])

  // VolleyManager cross-check for confirmed away games (green/yellow/red), keyed
  // by booking id. Re-fetched when bookings change (e.g. after a confirm).
  const [awayVmChecks, setAwayVmChecks] = useState<Record<string, AwayVmCheck>>({})
  // Away fixtures VolleyManager has scheduled but we hold no confirmed booking.
  const [awayVmUnbooked, setAwayVmUnbooked] = useState<AwayVmUnbooked[]>([])
  useEffect(() => {
    if (!season?.id) return
    let cancelled = false
    kscwApi<{ checks: Record<string, AwayVmCheck>; unbooked?: AwayVmUnbooked[] }>(`/admin/terminplanung/away-vm-check?season=${season.id}`)
      .then((r) => { if (!cancelled) { setAwayVmChecks(r.checks || {}); setAwayVmUnbooked(r.unbooked || []) } })
      .catch(() => { if (!cancelled) { setAwayVmChecks({}); setAwayVmUnbooked([]) } })
    return () => { cancelled = true }
  }, [season?.id, bookings])

  // VolleyManager PUSH cross-check for confirmed HOME games — those not (yet) in
  // VM (never pushed / push failed) or whose VM date drifted from our slot after
  // we pushed. Keyed by booking id. Re-fetched when bookings change (a re-push
  // updates vm_push_status, which flips a row out of the alert).
  type HomeVmCheck = { status: 'not_pushed' | 'mismatch' | 'match' | 'no_vm' | 'feed_authority'; agreed: string; vm: string | null; push: string | null }
  const [homeVmChecks, setHomeVmChecks] = useState<Record<string, HomeVmCheck>>({})
  useEffect(() => {
    if (!season?.id) return
    let cancelled = false
    kscwApi<{ checks: Record<string, HomeVmCheck> }>(`/admin/terminplanung/home-vm-check?season=${season.id}`)
      .then((r) => { if (!cancelled) setHomeVmChecks(r.checks || {}) })
      .catch(() => { if (!cancelled) setHomeVmChecks({}) })
    return () => { cancelled = true }
  }, [season?.id, bookings])

  // Fixture-aware home/away tallies (server resolves SVRZ fixtures per opponent;
  // the page only knows opponents+bookings). Drives the top cards and the
  // per-team header counter so a multi-game pairing (2H+1A etc.) counts every
  // leg instead of assuming one home + one away per opponent. Re-fetched on
  // bookings change (a confirm flips a leg). Keyed by team id.
  // ⚠ The state is TAGGED with the season it answers for, because a bare `null`
  // conflated three different things — "still in flight", "fetch failed" and
  // "no season" — and the render then silently substituted the booking-based
  // client counts for all three. Those counts assume one home + one away leg
  // per opponent, so for a multi-game pairing they are wrong in numerator AND
  // denominator (they have printed self-contradictory tallies like away 75/74).
  // `season !== the current one` = no answer yet (render a skeleton);
  // `data === null` = the fetch settled without one (fall back, marked `~`).
  type SideTally = { homeConfirmed: number; homeTotal: number; awayConfirmed: number; awayTotal: number }
  type FixtureSummary = { totals: SideTally; byTeam: Record<string, SideTally> }
  const [fixtureSummary, setFixtureSummary] = useState<{ season: string; data: FixtureSummary | null } | null>(null)
  useEffect(() => {
    const sid = season?.id
    if (!sid) { return }
    let cancelled = false
    kscwApi<FixtureSummary>(`/admin/terminplanung/season-summary?season=${sid}`)
      .then((r) => { if (!cancelled) setFixtureSummary({ season: String(sid), data: r }) })
      // A failed REfetch keeps the tally we already have (it is still the best
      // answer we got); only a first failure for this season degrades to `~`.
      .catch(() => { if (!cancelled) setFixtureSummary((prev) => (prev?.season === String(sid) ? prev : { season: String(sid), data: null })) })
    return () => { cancelled = true }
  }, [season?.id, bookings])

  // The four fetch effects above each used to clear their own state
  // synchronously in a `!season` guard (react-hooks/set-state-in-effect). Those
  // resets now happen here as adjust-state-during-render — one render earlier,
  // same committed state. `null` seeds a first pass on mount so the mount run of
  // each guard is preserved (notably `setDerbyLoaded(true)` while the season is
  // still loading). Both keys derive from the same `season` object, so folding
  // them into one primed key changes no trigger.
  const seasonNameKey = season?.season ?? ''
  const seasonIdKey = season?.id ?? ''
  const seasonKey = `${seasonIdKey} ${seasonNameKey}`
  const [primedSeasonKey, setPrimedSeasonKey] = useState<string | null>(null)
  if (primedSeasonKey !== seasonKey) {
    setPrimedSeasonKey(seasonKey)
    if (!seasonNameKey) {
      setDerbyGames([])
      setDerbyLoaded(true)
    }
    if (!seasonIdKey) {
      setAwayVmChecks({})
      setAwayVmUnbooked([])
      setHomeVmChecks({})
      setFixtureSummary(null)
    }
  }

  // The fixture-aware tally is deliberately NOT part of `isInitialLoading` below
  // — its endpoint walks every opponent's SVRZ fixtures sequentially, so gating
  // the whole page on it would hold the app spinner for seconds. The cost is
  // that the page paints while it is still in flight, which is exactly when the
  // booking-based fallback must stay hidden rather than pose as the answer.
  const summaryLoading = fixtureSummary?.season !== seasonIdKey
  const summaryTally = summaryLoading ? null : (fixtureSummary?.data ?? null)

  // Open an opponent's email thread in the Mailbox tab (the mailbox UI moved off
  // the dashboard into its own tab; the per-opponent "N emails" button deep-links).
  const openOpponentMailbox = (opp: GameSchedulingOpponent) =>
    navigate(`/admin/terminplanung/mailbox?sport=volleyball&opponent=${opp.id}`)

  // Wrap confirm so a rejected booking (Saturday cap, cross-team, gap, Döltschi,
  // slot taken, hall closure…) surfaces its reason instead of failing silently.
  const confirmErrMsg = (err: unknown) => {
    const body = (err as { body?: { error?: string } })?.body
    return body?.error || (err instanceof Error ? err.message : String(err))
  }
  const handleConfirmHome = async (bookingId: string, n: number, notes?: string) => {
    try {
      await confirmHomeProposal(bookingId, n, notes)
      toast.success(t('confirmed'))
    } catch (err) {
      toast.error(confirmErrMsg(err))
      // Refetch so a stale booking id (opponent re-proposed → new id) or a slot
      // that changed underneath self-heals instead of staying broken.
      void refetch()
      throw err
    }
  }
  const handleConfirmAway = async (bookingId: string, n: number, notes?: string) => {
    try {
      await confirmAwayProposal(bookingId, n, notes)
      toast.success(t('confirmed'))
    } catch (err) {
      toast.error(confirmErrMsg(err))
      void refetch()
      throw err
    }
  }
  // Delete a confirmed game (frees the slot + clears the member calendar) so the
  // matchup can be rescheduled. Warns when the game was already pushed to VM,
  // since deletion here can't remove it from VolleyManager.
  const handleDeleteBooking = async (booking: ExpandedBooking) => {
    const pushed = booking.type === 'home_slot_pick'
      && ['pushed', 'pushed_no_hall'].includes(String(booking.vm_push_status || ''))
    const message = pushed
      ? `${t('deleteGameConfirm')}\n\n${t('deleteGameVmWarning')}`
      : t('deleteGameConfirm')
    if (!(await confirm({ message }))) return
    try {
      await deleteBooking(booking.id)
      toast.success(t('gameDeleted'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      void refetch()
    }
  }

  // Adopt VolleyManager's date/time (+gym) for one away game — overwrite an
  // existing confirmed slot (bookingId) or create one from VM (opponentId +
  // svrzGameId). refetch() updates `bookings`, which re-runs away-vm-check.
  const [vmSyncing, setVmSyncing] = useState<string | null>(null)
  const handleSyncFromVm = async (args: { key: string; bookingId?: string; opponentId?: string; svrzGameId?: string | null }) => {
    setVmSyncing(args.key)
    try {
      await kscwApi('/admin/terminplanung/sync-away-from-vm', {
        method: 'POST',
        body: args.bookingId
          ? { booking_id: args.bookingId }
          : { opponent_id: args.opponentId, svrz_game_id: args.svrzGameId },
      })
      toast.success(t('vmSynced'))
      await refetch()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setVmSyncing(null)
    }
  }

  // Re-push ONE confirmed home game to VolleyManager — the home alert's action,
  // for games we never pushed / whose push failed, or that drifted from VM. The
  // push is fire-and-forget on the backend; vmPush() refetches now + after ~6s so
  // the alert clears once the worker writes back vm_push_status.
  const [vmRepushing, setVmRepushing] = useState<string | null>(null)
  const handleRepushVm = async (bid: string) => {
    setVmRepushing(bid)
    try {
      await vmPush(bid)
      toast.success(t('vmRepushQueued'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setVmRepushing(null)
    }
  }

  // One-click refresh (SVRZ fixtures/contacts + VM team names/leagues) with live
  // progress — see SyncNowButton / useSyncProgress. refetch() pulls the fresh
  // bookings once the background sync settles.

  // Send a reminder invite to every opponent still missing a home/away game.
  // Two-step: a dry run lists who would be emailed (so the admin confirms the
  // exact set), then the real send. Fully-scheduled opponents are skipped.
  const [reminding, setReminding] = useState(false)
  const [remindingTeam, setRemindingTeam] = useState<string | null>(null)
  // teamId omitted → season-wide (all teams). teamId set → only that team's
  // opponents (the remind endpoint accepts an optional team_id).
  const handleSendReminders = async (teamId?: string) => {
    if (!season) return
    if (teamId) setRemindingTeam(teamId); else setReminding(true)
    const body: { season_id: string; team_id?: string } = { season_id: season.id }
    if (teamId) body.team_id = teamId
    try {
      const preview = await kscwApi<{ previews: Array<{ team_name: string; kscw: string; missing: { home: number; away: number } }> }>(
        '/admin/terminplanung/invites/remind', { method: 'POST', body: { ...body, dry_run: true } })
      const list = preview.previews || []
      if (list.length === 0) { toast.info(t('remindNonePending')); return }
      const lines = list.map((p) => {
        const miss = [p.missing.home ? `${p.missing.home}H` : '', p.missing.away ? `${p.missing.away}A` : ''].filter(Boolean).join('+')
        return `• KSCW ${p.kscw} / ${p.team_name} (${miss})`
      }).join('\n')
      if (!(await confirm({ message: `${t('remindConfirm', { count: list.length })}\n\n${lines}` }))) return
      const res = await kscwApi<{ sent: number; failed: unknown[] }>(
        '/admin/terminplanung/invites/remind', { method: 'POST', body })
      toast.success(t('remindSent', { count: res.sent }))
      await refetch()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      if (teamId) setRemindingTeam(null); else setReminding(false)
    }
  }

  const handleFinalizeNotify = async (teamId: string, pendingCount: number) => {
    if (!season) return
    if (pendingCount > 0 && !(await confirm({ message: t('finalizeNotifyConfirmPending', { count: pendingCount }) }))) return
    setNotifyingTeam(teamId)
    try {
      // Attach the team's schedule as Excel + PDF so coaches can check the dates
      // directly. Best-effort: a generation hiccup must not block the email — the
      // body already lists every game.
      let attachments: { filename: string; content_base64: string; content_type: string }[] = []
      try {
        // Freshly-filtered copy rather than the memoised `volleyballTeams` below:
        // the compiler treats a locally-created value handed to an opaque function
        // as possibly-mutated, which forfeits that useMemo and every memo that
        // depends on it (react-hooks/preserve-manual-memoization). Same contents.
        const schedulable = (teams || []).filter(isSchedulableTeam)
        const teamName = schedulable.find((tm) => String(tm.id) === String(teamId))?.name
        const sections = await buildScheduleSections({ bookings, opponents, slots, teams: schedulable, season, teamId })
        if (sections.some((s) => s.rows.length)) {
          const [xlsx, pdf] = await Promise.all([buildScheduleXlsx(sections), buildSchedulePdf(sections)])
          attachments = [
            { filename: exportFilename('xlsx', teamName), content_base64: bytesToBase64(xlsx), content_type: XLSX_MIME },
            { filename: exportFilename('pdf', teamName), content_base64: bytesToBase64(pdf), content_type: PDF_MIME },
          ]
        }
      } catch { /* fall through — send the email without attachments */ }
      const res = await finalizeNotify(teamId, season.id, attachments)
      toast.success(t('finalizeNotifySent', { home: res.home, away: res.away }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setNotifyingTeam(null)
    }
  }

  // Contact sets for every opponent (across all teams), each tagged with its
  // KSCW pairing short name. Mailbox matching disambiguates opponent rows that
  // share a club's contacts (e.g. Volley Uster D1 vs H4) by these needles, so a
  // "Volley Uster H4 – KSC Wiedikon Legends" mail no longer lands on D1's thread.
  // Declared before the early returns below so the hook order stays stable.
  const opponentContacts = useMemo<OpponentContacts[]>(
    () => opponents.map((o) => {
      const team = (teams || []).find((tm) => String(tm.id) === String(o.kscw_team))
      return { opp: o, contacts: contactAddressSet(o), aliases: team?.name ? [team.name] : [] }
    }),
    [opponents, teams],
  )

  // Classify every synced message to an opponent row once per render (contact
  // match + KSCW team code / opponent name + thread inheritance), so the
  // per-opponent "N emails" thread is computed without re-scanning the list for
  // every opponent card.
  const mailClassification = useMemo(
    () => classifyMessages(mailbox.messages, opponentContacts),
    [mailbox.messages, opponentContacts],
  )

  // Selectable date window for manual bookings — guards against date typos
  // (e.g. 10.02.2026 for a 2026/27 season).
  const manualDateWindow = useMemo(() => computeSeasonWindow(season), [season])

  // Schedulable volleyball teams. Memoised (and declared before the early returns
  // so the hook order stays stable) so a search-box keystroke doesn't refilter
  // the whole team list, and the derivations below reuse one array.
  const volleyballTeams = useMemo(() => (teams || []).filter(isSchedulableTeam), [teams])

  // id → slot lookup, reused by opponent search + the VM-alert derivations.
  // Memoised so typing in the search box doesn't rebuild the Map every keystroke.
  const slotByIdAll = useMemo(() => new Map(slots.map(s => [String(s.id), s])), [slots])

  // Confirmed away games whose agreed date/time DIFFERS from VolleyManager (red).
  // "Not updated yet" (unset) is fine and excluded — only genuine conflicts. The
  // away-vm-check endpoint already scopes this to the teams the user manages.
  // Memoised so a search keystroke doesn't rebuild oppById/teamNameById/bookingById.
  const awayMismatches = useMemo(() => {
    const entries = Object.entries(awayVmChecks).filter(([, c]) => c.status === 'mismatch')
    if (!entries.length) return []
    const oppById = new Map(opponents.map((o) => [String(o.id), o]))
    const teamNameById = new Map(volleyballTeams.map((tm) => [String(tm.id), tm.name]))
    const bookingById = new Map(bookings.map((b) => [String(b.id), b]))
    return entries.map(([bid, c]) => {
      const b = bookingById.get(bid)
      const oid = b ? String(typeof b.opponent === 'object' ? (b.opponent as GameSchedulingOpponent).id : b.opponent) : ''
      const opp = oid ? oppById.get(oid) : null
      return {
        bid,
        opp: opp ? (opp.team_name || opp.club_name) : `#${bid}`,
        team: opp ? (teamNameById.get(String(opp.kscw_team)) || '') : '',
        agreed: c.agreed,
        vm: c.vm,
      }
    })
  }, [awayVmChecks, opponents, volleyballTeams, bookings])

  // Away fixtures VolleyManager has scheduled but we never confirmed a slot —
  // shown in the same alert with a one-click "create from VM" Sync button.
  const awayUnbooked = useMemo(() => {
    if (!awayVmUnbooked.length) return []
    const oppById = new Map(opponents.map((o) => [String(o.id), o]))
    const teamNameById = new Map(volleyballTeams.map((tm) => [String(tm.id), tm.name]))
    return awayVmUnbooked.map((u) => {
      const opp = oppById.get(String(u.opponent_id))
      return {
        key: `${u.opponent_id}:${u.svrz_game_id}`,
        opponentId: String(u.opponent_id),
        svrzGameId: String(u.svrz_game_id),
        opp: opp ? (opp.team_name || opp.club_name) : `#${u.opponent_id}`,
        team: opp ? (teamNameById.get(String(opp.kscw_team)) || '') : '',
        vm: u.vm,
      }
    })
  }, [awayVmUnbooked, opponents, volleyballTeams])

  // Confirmed home games not (yet) in VolleyManager — never pushed / push failed
  // (not_pushed) — or whose VM date drifted from our slot after we pushed
  // (mismatch). Each gets a one-click "Re-push to VM". The home-vm-check endpoint
  // already scopes this to the teams the user manages.
  const homeVmAlerts = useMemo(() => {
    const entries = Object.entries(homeVmChecks).filter(([, c]) => c.status === 'not_pushed' || c.status === 'mismatch')
    if (!entries.length) return []
    const oppById = new Map(opponents.map((o) => [String(o.id), o]))
    const teamNameById = new Map(volleyballTeams.map((tm) => [String(tm.id), tm.name]))
    const bookingById = new Map(bookings.map((b) => [String(b.id), b]))
    return entries.map(([bid, c]) => {
      const b = bookingById.get(bid)
      const oid = b ? String(typeof b.opponent === 'object' ? (b.opponent as GameSchedulingOpponent).id : b.opponent) : ''
      const opp = oid ? oppById.get(oid) : null
      return {
        bid,
        opp: opp ? (opp.team_name || opp.club_name) : `#${bid}`,
        team: opp ? (teamNameById.get(String(opp.kscw_team)) || '') : '',
        status: c.status,
        agreed: c.agreed,
        vm: c.vm,
      }
    })
  }, [homeVmChecks, opponents, volleyballTeams, bookings])

  // Only the very first load blanks the page. After data has loaded once,
  // confirming a proposal refetches in the background without flashing the page.
  // Wait for ALL the content data (season, bookings, teams, intra-club games) so
  // the tables/cards render fully formed instead of popping in piecemeal.
  const isInitialLoading = seasonLoading || (isLoading && !hasLoaded) || teamsLoading || !derbyLoaded
  // Report to the app boot gate — see usePageReady.tsx. Runs on every render
  // (before the access early return) so the hook order stays stable.
  useReportPageLoading(isInitialLoading)

  if (!hasAdminAccessToSport('volleyball') && !is_spielplaner) {
    return <Navigate to="/" replace />
  }

  if (isInitialLoading) return null

  if (!season) {
    return (
      <div className="text-center text-gray-500 dark:text-gray-400">
        <p>{t('noSeasonConfigured')}</p>
      </div>
    )
  }

  const getTeamOpponents = (teamId: string) =>
    opponents.filter(o => String(o.kscw_team) === String(teamId))

  const getTeamSlots = (teamId: string) =>
    slots.filter(s => String(s.kscw_team) === String(teamId))

  // Bookings belonging to this team — both legs reference the opponent, whose
  // kscw_team is the team. Scopes the per-team calendar to its own games.
  const getTeamBookings = (teamId: string) =>
    bookings.filter(b => {
      const opp = typeof b.opponent === 'object' ? (b.opponent as GameSchedulingOpponent) : null
      return opp ? String(opp.kscw_team) === String(teamId) : false
    })

  // Dashboard search: matches opponent/club/contact names and any booking date
  // of the opponent (booked or proposed, home or away) in dd.mm.yyyy, dd.mm.yy
  // and yyyy-mm-dd forms. Active search filters the accordion to matching
  // opponent cards and force-expands the teams that still have matches.
  const searchQuery = search.trim().toLowerCase()
  const dateForms = (ymd: unknown): string[] => {
    const m = String(ymd ?? '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/)
    return m ? [`${m[3]}.${m[2]}.${m[1]}`, `${m[3]}.${m[2]}.${m[1].slice(2)}`, `${m[1]}-${m[2]}-${m[3]}`] : []
  }
  const opponentSearchText = (opp: GameSchedulingOpponent): string => {
    const parts: string[] = [opp.team_name || '', opp.club_name || '', opp.contact_name || '', opp.contact_email || '']
    for (const b of bookings) {
      const oid = typeof b.opponent === 'object' ? (b.opponent as GameSchedulingOpponent).id : b.opponent
      if (String(oid) !== String(opp.id)) continue
      const rec = b as unknown as Record<string, unknown>
      if (b.type === 'home_slot_pick') {
        for (const key of ['slot', 'proposed_slot_1', 'proposed_slot_2', 'proposed_slot_3']) {
          const ref = rec[key]
          if (ref == null) continue
          const sl = typeof ref === 'object' ? (ref as GameSchedulingSlot) : slotByIdAll.get(String(ref))
          if (sl?.date) parts.push(...dateForms(sl.date))
        }
      } else {
        for (const n of [1, 2, 3]) {
          const dt = rec[`proposed_datetime_${n}`]
          if (dt) parts.push(...dateForms(String(dt)))
        }
      }
    }
    return parts.join(' ').toLowerCase()
  }
  const opponentMatches = (opp: GameSchedulingOpponent) => !searchQuery || opponentSearchText(opp).includes(searchQuery)
  const teamMatchedOpponents = (teamId: string) => getTeamOpponents(teamId).filter(opponentMatches)
  const visibleTeams = searchQuery
    ? volleyballTeams.filter(team => teamMatchedOpponents(team.id).length > 0)
    : volleyballTeams

  // Opponents (excluding revoked/expired) still missing a confirmed home or away
  // leg — mirrors the backend's "Noch offen" count for the finalize warning.
  const teamPending = (teamId: string) =>
    getTeamOpponents(teamId)
      .filter(o => !['revoked', 'expired'].includes(String(o.status)))
      .filter(o => {
        const ob = bookings.filter(b => {
          const oid = typeof b.opponent === 'object' ? (b.opponent as GameSchedulingOpponent).id : b.opponent
          return String(oid) === String(o.id)
        })
        const home = ob.find(b => b.type === 'home_slot_pick')?.status === 'confirmed'
        const away = ob.find(b => b.type === 'away_proposal')?.status === 'confirmed'
        return !home || !away
      }).length

  const teamStats = (teamId: string) => {
    const teamSlots = getTeamSlots(teamId)
    const booked = teamSlots.filter(s => s.status === 'booked').length
    const opps = getTeamOpponents(teamId)
    const byStatus = {
      invited: 0, viewed: 0, booked: 0, revoked: 0, expired: 0, active: 0,
    } as Record<InviteStatus, number>
    for (const o of opps) {
      const s = (o.status as InviteStatus) || 'active'
      if (s in byStatus) byStatus[s]++
    }
    // Actions awaiting the spielplaner: opponent proposals (home slot pick /
    // away proposal) still `pending` — each is one slot left to confirm.
    const activeOppIds = new Set(
      opps
        .filter(o => !['revoked', 'expired'].includes(String(o.status)))
        .map(o => String(o.id))
    )
    const toConfirm = bookings.filter(b => {
      if (b.status !== 'pending') return false
      const oid = typeof b.opponent === 'object' ? (b.opponent as GameSchedulingOpponent).id : b.opponent
      return activeOppIds.has(String(oid))
    }).length
    // Traffic light: blue = opponents who haven't proposed yet (ball in their
    // court), yellow = proposals awaiting confirmation (toConfirm), green =
    // confirmed games.
    const oppWithBooking = new Set(
      bookings.map(b => String(typeof b.opponent === 'object' ? (b.opponent as GameSchedulingOpponent).id : b.opponent))
    )
    const notProposed = [...activeOppIds].filter(id => !oppWithBooking.has(id)).length
    const confirmedLeg = (type: 'home_slot_pick' | 'away_proposal') =>
      bookings.filter(b => {
        if (b.type !== type || b.status !== 'confirmed') return false
        const oid = typeof b.opponent === 'object' ? (b.opponent as GameSchedulingOpponent).id : b.opponent
        return activeOppIds.has(String(oid))
      }).length
    const homeConfirmed = confirmedLeg('home_slot_pick')
    const awayConfirmed = confirmedLeg('away_proposal')
    const confirmed = homeConfirmed + awayConfirmed
    // Each active opponent = one home leg + one away leg to schedule.
    const gamesTotal = activeOppIds.size
    // Saturday game counters: confirmed HOME games are booked slots on a
    // Saturday; confirmed AWAY games are confirmed away_proposals whose chosen
    // datetime is a Saturday. Total = home + away.
    const isSat = (d: string | null | undefined) =>
      !!d && new Date(`${String(d).slice(0, 10)}T00:00:00Z`).getUTCDay() === 6
    const homeSat = teamSlots.filter(s => s.status === 'booked' && isSat(s.date)).length
    const oppIdSet = new Set(opps.map(o => String(o.id)))
    const awaySat = bookings.filter(b => {
      if (b.type !== 'away_proposal' || b.status !== 'confirmed' || !b.confirmed_proposal) return false
      const oid = typeof b.opponent === 'object' ? (b.opponent as GameSchedulingOpponent).id : b.opponent
      if (!oppIdSet.has(String(oid))) return false
      const dt = (b as unknown as Record<string, unknown>)[`proposed_datetime_${b.confirmed_proposal}`] as string | undefined
      return isSat(dt)
    }).length
    return {
      booked, total: teamSlots.length, opponents: opps.length, byStatus, toConfirm,
      notProposed, confirmed, homeConfirmed, awayConfirmed, gamesTotal,
      homeSat, awaySat, satTotal: homeSat + awaySat,
    }
  }

  // Season-wide rollup across all schedulable teams — drives the top summary.
  const summary = volleyballTeams.reduce((acc, team) => {
    const s = teamStats(team.id)
    acc.homeConfirmed += s.homeConfirmed
    acc.awayConfirmed += s.awayConfirmed
    acc.gamesTotal += s.gamesTotal
    acc.toConfirm += s.toConfirm
    acc.notProposed += s.notProposed
    return acc
  }, { homeConfirmed: 0, awayConfirmed: 0, gamesTotal: 0, toConfirm: 0, notProposed: 0 })

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900 sm:text-2xl dark:text-gray-100">{t('dashboardTitle')}</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{formatSeasonShort(season.season)}</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <SyncNowButton seasonName={season.season} onDone={refetch} />
          <Button size="sm" variant="outline" onClick={() => handleSendReminders()} disabled={reminding}>
            {reminding ? '…' : t('sendReminders')}
          </Button>
          <ExcelExportButton bookings={bookings} opponents={opponents} slots={slots} teams={volleyballTeams} season={season} />
        </div>
      </div>

      {/* Season summary — confirmed home/away vs total, plus what's outstanding.
          Home/away totals are fixture-aware (server) so multi-game pairings count
          every leg. Until that lands the number line is a skeleton: the
          booking-based client counts (one leg per opponent) look identical to
          the real tally but read three legs short on a multi-game pairing, so a
          planner would take "5/6" for "one date left to place". Once the fetch
          has settled without an answer we do fall back — prefixed `~` so the
          estimate is never mistaken for the fixture-aware count. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{t('summaryHome')}</p>
          {summaryLoading ? (
            <span className="mt-1 block h-8 w-20 animate-pulse rounded bg-gray-200 dark:bg-gray-700" aria-hidden />
          ) : (
            <p className="mt-1 text-2xl font-bold text-green-600 dark:text-green-400 tabular-nums">
              {summaryTally ? '' : '~'}{summaryTally?.totals.homeConfirmed ?? summary.homeConfirmed}<span className="text-base font-medium text-gray-400 dark:text-gray-500">/{summaryTally?.totals.homeTotal ?? summary.gamesTotal}</span>
            </p>
          )}
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{t('summaryAway')}</p>
          {summaryLoading ? (
            <span className="mt-1 block h-8 w-20 animate-pulse rounded bg-gray-200 dark:bg-gray-700" aria-hidden />
          ) : (
            <p className="mt-1 text-2xl font-bold text-green-600 dark:text-green-400 tabular-nums">
              {summaryTally ? '' : '~'}{summaryTally?.totals.awayConfirmed ?? summary.awayConfirmed}<span className="text-base font-medium text-gray-400 dark:text-gray-500">/{summaryTally?.totals.awayTotal ?? summary.gamesTotal}</span>
            </p>
          )}
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{t('summaryToConfirm')}</p>
          <p className="mt-1 text-2xl font-bold text-amber-600 dark:text-amber-400 tabular-nums">{summary.toConfirm}</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{t('summaryAwaiting')}</p>
          <p className="mt-1 text-2xl font-bold text-blue-600 dark:text-blue-400 tabular-nums">{summary.notProposed}</p>
        </div>
      </div>

      {/* Away games that diverge from VolleyManager (red) or that VM has scheduled
          but we never booked (amber) — each with a one-click "Sync with VM".
          "VM not updated yet" (unset/placeholder) is intentionally NOT flagged. */}
      {(awayMismatches.length > 0 || awayUnbooked.length > 0) && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-3 dark:border-red-800 dark:bg-red-900/30">
          <p className="flex items-center gap-2 text-sm font-semibold text-red-700 dark:text-red-300">
            <span aria-hidden>⚠</span>
            {t('awayVmMismatchAlert', { count: awayMismatches.length + awayUnbooked.length })}
          </p>
          <ul className="mt-2 space-y-1.5">
            {awayMismatches.map((m) => (
              <li key={m.bid} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-red-700 dark:text-red-300">
                <span className="font-medium">{[m.team, m.opp].filter(Boolean).join(' · ')}</span>
                <span className="text-red-600/80 dark:text-red-400/80">{t('awayVmMismatchRow', { agreed: m.agreed || '—', vm: m.vm || '—' })}</span>
                <button
                  type="button"
                  onClick={() => handleSyncFromVm({ key: `b:${m.bid}`, bookingId: m.bid })}
                  disabled={vmSyncing === `b:${m.bid}`}
                  className="rounded-md border border-red-300 bg-white px-2 py-0.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-700 dark:bg-gray-800 dark:text-red-300 dark:hover:bg-gray-700"
                >
                  {vmSyncing === `b:${m.bid}` ? <InlineSpinner /> : t('syncWithVm')}
                </button>
              </li>
            ))}
            {awayUnbooked.map((u) => (
              <li key={u.key} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-red-700 dark:text-red-300">
                <span className="font-medium">{[u.team, u.opp].filter(Boolean).join(' · ')}</span>
                <span className="text-red-600/80 dark:text-red-400/80">{t('awayVmUnbookedRow', { vm: u.vm })}</span>
                <button
                  type="button"
                  onClick={() => handleSyncFromVm({ key: `u:${u.key}`, opponentId: u.opponentId, svrzGameId: u.svrzGameId })}
                  disabled={vmSyncing === `u:${u.key}`}
                  className="rounded-md border border-red-300 bg-white px-2 py-0.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-700 dark:bg-gray-800 dark:text-red-300 dark:hover:bg-gray-700"
                >
                  {vmSyncing === `u:${u.key}` ? <InlineSpinner /> : t('syncWithVm')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Home games missing from VolleyManager (never pushed / push failed) or
          whose VM date drifted from our slot after we pushed — each with a
          one-click "Re-push to VM". WE own the home hall, so WE push the date. */}
      {homeVmAlerts.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-900/30">
          <p className="flex items-center gap-2 text-sm font-semibold text-amber-700 dark:text-amber-300">
            <span aria-hidden>⚠</span>
            {t('homeVmAlert', { count: homeVmAlerts.length })}
          </p>
          <ul className="mt-2 space-y-1.5">
            {homeVmAlerts.map((m) => (
              <li key={m.bid} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-amber-700 dark:text-amber-300">
                <span className="font-medium">{[m.team, m.opp].filter(Boolean).join(' · ')}</span>
                <span className="text-amber-600/80 dark:text-amber-400/80">
                  {m.status === 'mismatch'
                    ? t('homeVmMismatchRow', { agreed: m.agreed || '—', vm: m.vm || '—' })
                    : t('homeVmNotPushedRow', { agreed: m.agreed || '—' })}
                </span>
                <button
                  type="button"
                  onClick={() => handleRepushVm(m.bid)}
                  disabled={vmRepushing === m.bid}
                  className="rounded-md border border-amber-300 bg-white px-2 py-0.5 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-700 dark:bg-gray-800 dark:text-amber-300 dark:hover:bg-gray-700"
                >
                  {vmRepushing === m.bid ? <InlineSpinner /> : t('repushVm')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Season overview calendar — all proposed/confirmed/blocked slots. No
          showAbsences: absences/blocks/wishes are per-team, shown in each team's
          own calendar below, not on this all-teams overview. */}
      <SchedulingCalendar slots={slots} bookings={bookings} teams={volleyballTeams} season={season} games={derbyGames} />

      {/* Search across all teams: opponent / club / contact / booking dates */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('searchPlaceholder')}
          aria-label={t('searchPlaceholder')}
          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none sm:max-w-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:placeholder:text-gray-500"
        />
        {searchQuery && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {t('searchMatchCount', { count: visibleTeams.reduce((n, team) => n + teamMatchedOpponents(team.id).length, 0) })}
          </span>
        )}
      </div>

      {/* Team overview accordion */}
      <div className="space-y-3">
        {searchQuery && visibleTeams.length === 0 && (
          <p className="text-sm text-gray-500 dark:text-gray-400">{t('searchNoResults')}</p>
        )}
        {visibleTeams.map(team => {
          const stats = teamStats(team.id)
          const isExpanded = searchQuery ? true : expandedTeam === team.id
          // Matchups still missing a confirmed game — the canonical "is this team
          // done?" metric (same one driving the finalize-ready text). A team can
          // have all its existing bookings confirmed yet still be missing legs that
          // were never proposed, so this is the truthful "remaining" count.
          const pending = teamPending(team.id)
          const finished = stats.gamesTotal > 0 && pending === 0

          return (
            <div
              key={team.id}
              className={`overflow-hidden rounded-lg border ${
                finished
                  ? 'border-green-300 bg-green-50 dark:border-green-900 dark:bg-green-900/20'
                  : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800'
              }`}
            >
              {/* Team header */}
              <button
                onClick={() => setExpandedTeam(isExpanded ? null : team.id)}
                className={`flex w-full items-center justify-between px-4 py-3 text-left ${
                  finished
                    ? 'hover:bg-green-100 dark:hover:bg-green-900/30'
                    : 'hover:bg-gray-50 dark:hover:bg-gray-700'
                }`}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span
                    className="inline-block h-3 w-3 flex-shrink-0 rounded-full"
                    style={{ backgroundColor: team.color || '#6b7280' }}
                  />
                  <span className="truncate font-semibold text-gray-900 dark:text-gray-100">{team.name}</span>
                  {team.full_name && (
                    <span className="hidden truncate text-sm text-gray-500 sm:inline dark:text-gray-400">
                      {team.full_name}
                    </span>
                  )}
                </div>
                <div className="flex flex-shrink-0 items-center gap-3 text-xs text-gray-600 sm:text-sm dark:text-gray-400">
                  {stats.gamesTotal > 0 && (() => {
                    // Fixture-aware per-side totals (multi-game pairings). A
                    // skeleton holds the slot until the server tally lands —
                    // same trap as the summary tiles: the booking-based client
                    // counts assume one leg per side and would read as a
                    // finished "H 5/6 · A 4/6". `~` marks the fallback once the
                    // fetch has settled without an answer for this team.
                    const tally = summaryTally?.byTeam[String(team.id)]
                    if (summaryLoading) {
                      return <span className="hidden h-4 w-28 animate-pulse rounded bg-gray-200 sm:inline-block dark:bg-gray-700" aria-hidden />
                    }
                    return (
                      <span className="hidden whitespace-nowrap sm:inline" title={t('homeAwayCounterHint')}>
                        {tally ? '' : '~'}{t('homeAwayCounter', {
                          hc: tally?.homeConfirmed ?? stats.homeConfirmed,
                          ht: tally?.homeTotal ?? stats.gamesTotal,
                          ac: tally?.awayConfirmed ?? stats.awayConfirmed,
                          at: tally?.awayTotal ?? stats.gamesTotal,
                        })}
                      </span>
                    )
                  })()}
                  {stats.satTotal > 0 && (
                    <span className="whitespace-nowrap" title={t('saturdayCounterHint')}>
                      {t('saturdayCounter', { home: stats.homeSat, away: stats.awaySat })}
                    </span>
                  )}
                  {stats.opponents > 0 && (
                    <span className="hidden sm:inline">
                      {t('opponentCount', { count: stats.opponents })}
                    </span>
                  )}
                  <div className="flex items-center gap-1">
                    {pending > 0 && (
                      <Badge variant="info" size="sm" title={t('remainingGamesHint')}>
                        {pending}
                      </Badge>
                    )}
                    {stats.toConfirm > 0 && (
                      <Badge variant="warning" size="sm" title={t('statusToConfirm')}>
                        {stats.toConfirm}
                      </Badge>
                    )}
                  </div>
                  <span className="text-lg">{isExpanded ? '▾' : '▸'}</span>
                </div>
              </button>

              {/* Expanded content — while searching, skip the calendar +
                  finalize row so the matching opponent cards stand alone. */}
              {isExpanded && (
                <div className="border-t border-gray-200 px-4 py-4 dark:border-gray-700">
                  {!searchQuery && (
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {teamPending(team.id) > 0
                        ? t('finalizeNotifyPending', { count: teamPending(team.id) })
                        : t('finalizeNotifyReady')}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <TeamAvailabilityDialog
                        kscwTeamId={team.id}
                        kscwTeamName={team.name}
                        seasonId={season.id}
                        seasonName={season.season}
                      />
                      <button
                        type="button"
                        onClick={() => handleFinalizeNotify(team.id, teamPending(team.id))}
                        disabled={notifyingTeam === team.id || stats.opponents === 0}
                        className="inline-flex items-center gap-1.5 self-start rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                      >
                        {notifyingTeam === team.id ? t('finalizeNotifySending') : t('finalizeNotify')}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSendReminders(team.id)}
                        disabled={remindingTeam === team.id || stats.opponents === 0}
                        className="inline-flex items-center gap-1.5 self-start rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                      >
                        {remindingTeam === team.id ? '…' : t('sendReminder')}
                      </button>
                      {/* Per-team Excel / PDF export of just this team's games. */}
                      <ExcelExportButton
                        bookings={bookings}
                        opponents={opponents}
                        slots={slots}
                        teams={volleyballTeams}
                        season={season}
                        teamId={team.id}
                        teamName={team.name}
                        compact
                      />
                    </div>
                  </div>
                  )}
                  {/* This team's own calendar — proposed + confirmed home/away
                      games, blocked + open slots, scoped to the team. */}
                  {!searchQuery && (
                  <div className="mb-4">
                    <SchedulingCalendar
                      slots={getTeamSlots(team.id)}
                      bookings={getTeamBookings(team.id)}
                      teams={[team]}
                      season={season}
                      games={derbyGames.filter((g) => String(g.kscw_team) === String(team.id))}
                      title={t('teamCalendarTitle')}
                      showAbsences
                    />
                  </div>
                  )}
                  <TeamBookingsContent
                    kscwTeamId={team.id}
                    kscwTeamName={team.name}
                    seasonId={season.id}
                    opponents={searchQuery ? teamMatchedOpponents(team.id) : getTeamOpponents(team.id)}
                    bookings={bookings}
                    slots={getTeamSlots(team.id)}
                    proposalHealth={proposalHealth}
                    onConfirmAway={handleConfirmAway}
                    onConfirmHome={handleConfirmHome}
                    onDeleteBooking={handleDeleteBooking}
                    onVmPush={vmPush}
                    onRequestNewSlots={requestNewSlots}
                    onSaveOpponentNote={saveOpponentNote}
                    onManualBooking={manualBooking}
                    dateWindow={manualDateWindow}
                    onBlockSlot={blockSlot}
                    mailboxConfigured={mailbox.configured === true}
                    emailsFor={(opp) => messagesForOwner(mailbox.messages, opp.id, mailClassification)}
                    onOpenMailbox={openOpponentMailbox}
                    awayVmChecks={awayVmChecks}
                    awayVmUnbooked={awayVmUnbooked}
                    onSyncVm={handleSyncFromVm}
                    vmSyncing={vmSyncing}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function TeamBookingsContent({
  kscwTeamId,
  kscwTeamName,
  seasonId,
  opponents: teamOpponents,
  bookings: allBookings,
  slots: teamSlots,
  proposalHealth,
  onConfirmAway,
  onConfirmHome,
  onDeleteBooking,
  onVmPush,
  onRequestNewSlots,
  onSaveOpponentNote,
  onManualBooking,
  dateWindow,
  mailboxConfigured,
  emailsFor,
  onOpenMailbox,
  awayVmChecks,
  awayVmUnbooked,
  onSyncVm,
  vmSyncing,
}: {
  kscwTeamId: string
  kscwTeamName: string
  seasonId: string
  opponents: GameSchedulingOpponent[]
  bookings: ExpandedBooking[]
  slots: GameSchedulingSlot[]
  proposalHealth: ProposalHealthEntry[]
  onConfirmAway: (bookingId: string, proposalNumber: number, notes?: string) => Promise<void>
  onConfirmHome: (bookingId: string, proposalNumber: number, notes?: string) => Promise<void>
  onDeleteBooking: (booking: ExpandedBooking) => Promise<void>
  onVmPush: (bookingId: string, svrzPersistenceId?: string) => Promise<void>
  onRequestNewSlots: (opponentId: string | number, bookingId?: string | number) => Promise<void>
  onSaveOpponentNote: (opponentId: string | number, kscwNote: string) => Promise<void>
  onManualBooking: (
    opponentId: string | number,
    legs: {
      home?: { date: string; start_time: string; end_time?: string; hall: number | string; svrz_game_id?: string }
      away?: { date: string; start_time?: string; place?: string; svrz_game_id?: string }
    },
  ) => Promise<void>
  dateWindow: { start: string; end: string } | null
  onBlockSlot: (slotId: string, action: 'block' | 'unblock') => Promise<void>
  mailboxConfigured: boolean
  emailsFor: (opp: GameSchedulingOpponent) => MailboxMessage[]
  onOpenMailbox: (opp: GameSchedulingOpponent) => void
  awayVmChecks: Record<string, AwayVmCheck>
  awayVmUnbooked: AwayVmUnbooked[]
  onSyncVm: (args: { key: string; bookingId?: string; opponentId?: string; svrzGameId?: string | null }) => Promise<void>
  vmSyncing: string | null
}) {
  const { t } = useTranslation('gameScheduling')
  // VM fixtures with a date but no booking, keyed `${opponent}:${svrz_game_id}`
  // so an unbooked away leg can offer a one-click "create from VM".
  const unbookedByKey = new Map(awayVmUnbooked.map((u) => [`${u.opponent_id}:${u.svrz_game_id}`, u]))
  const { data: halls } = useHalls()
  const hallsById = new Map((halls || []).map((h) => [String(h.id), h.name]))

  // Copy this opponent's tokenized scheduling link — mirrors the invites
  // section's "Copy link" (the per-opponent /terminplanung/<token> URL the
  // opponent uses to view + propose dates).
  const copyOpponentLink = async (opp: GameSchedulingOpponent) => {
    const url = `${window.location.origin}/terminplanung/${opp.token}`
    try {
      await navigator.clipboard.writeText(url)
      toast.success(t('linkCopied'))
    } catch {
      toast.error(url)
    }
  }

  // Per-opponent inline email thread — collapsed by default so a long mail
  // history doesn't bloat the card. Full read/reply still opens the bottom panel.
  const [openEmails, setOpenEmails] = useState<Set<string>>(new Set())
  const toggleEmails = (id: string) =>
    setOpenEmails((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })

  // Clubs can carry a dozen+ Spielplan contacts (comma-joined) — collapse the
  // list by default so it doesn't balloon the card.
  const [openContacts, setOpenContacts] = useState<Set<string>>(new Set())
  const toggleContacts = (id: string) =>
    setOpenContacts((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })

  // SVRZ fixtures per opponent (the games still to schedule) — loaded lazily when
  // this team's accordion expands. Matched to opponent rows by normalised team
  // name. Best-effort: a hiccup just hides the "N games" buttons.
  const [gamesByName, setGamesByName] = useState<Map<string, OpponentGame[]>>(new Map())
  // True only after the fixtures fetch succeeded — guards the orphan-fixture flag
  // below from firing on every opponent while the map is still empty (mid-load).
  const [fixturesLoaded, setFixturesLoaded] = useState(false)
  // True once the fetch is no longer in flight, success OR failure. Separate
  // from `fixturesLoaded` on purpose: the card tint and the per-leg bodies are
  // fixture-shaped, so they must stay neutral while the map is empty — but a
  // failed fetch has to release them back to the booking-only rendering instead
  // of leaving every card greyed out forever.
  const [fixturesSettled, setFixturesSettled] = useState(false)
  const [gamesFor, setGamesFor] = useState<{ label: string; games: OpponentGame[] } | null>(null)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const resp = await kscwApi(`/admin/terminplanung/invites/svrz-clubs?kscw_team=${kscwTeamId}&season=${seasonId}`) as { clubs?: SvrzClub[] }
        if (cancelled) return
        const map = new Map<string, OpponentGame[]>()
        for (const c of resp?.clubs || []) {
          if (c.team_name) map.set(normName(c.team_name), c.games || [])
          if (c.club_name) map.set(normName(c.club_name), c.games || [])
        }
        setGamesByName(map)
        setFixturesLoaded(true)
      } catch { /* games disclosure just won't show */ }
      finally { if (!cancelled) setFixturesSettled(true) }
    })()
    return () => { cancelled = true }
  }, [kscwTeamId, seasonId])
  const hallOptions = (halls || []).map((h) => ({ id: h.id, name: h.name }))
  const slotsById = new Map(teamSlots.map((s) => [String(s.id), s]))
  // The gym this team plays its home games in — the hall its currently-open slots
  // use (most common among available slots). Pre-selected + floated to the top of
  // the manual-booking hall dropdown so a new home game defaults to the right gym.
  const defaultHomeHall = (() => {
    const counts = new Map<string, number>()
    for (const s of teamSlots) {
      if (s.status !== 'available') continue
      const h = s.hall != null ? String(s.hall) : ''
      if (h) counts.set(h, (counts.get(h) || 0) + 1)
    }
    let best: string | undefined; let bestN = 0
    for (const [h, n] of counts) if (n > bestN) { best = h; bestN = n }
    return best
  })()
  // Home slots are KSCW-hall, shared across this team's opponents and NOT held
  // until confirmed — so the real contention is "another club proposed this same
  // slot". Index: home slot id -> set of opponent ids that proposed it (pending).
  // Scoped to this team's opponents (cross-team home slots can't collide).
  const teamOpponentIds = new Set(teamOpponents.map((o) => String(o.id)))
  const oppIdOf = (b: ExpandedBooking): string =>
    String(typeof b.opponent === 'object' ? (b.opponent as GameSchedulingOpponent).id : b.opponent)
  const homeSlotProposers = new Map<string, Set<string>>()
  for (const b of allBookings) {
    if (b.status !== 'pending' || b.type !== 'home_slot_pick') continue
    const oid = oppIdOf(b)
    if (!teamOpponentIds.has(oid)) continue
    for (const sid of [b.proposed_slot_1, b.proposed_slot_2, b.proposed_slot_3]) {
      if (sid == null) continue
      const key = String(sid)
      if (!homeSlotProposers.has(key)) homeSlotProposers.set(key, new Set())
      homeSlotProposers.get(key)!.add(oid)
    }
  }
  // Count distinct OTHER opponents (≠ this one) who proposed this exact home slot.
  const homeAlsoProposedBy = (slotId: string | number | null | undefined, opponentId: string) => {
    if (slotId == null) return 0
    const set = homeSlotProposers.get(String(slotId))
    if (!set) return 0
    let n = 0
    for (const oid of set) if (oid !== opponentId) n++
    return n
  }

  // Live proposal validity, keyed by booking id (Item 3).
  const healthByBooking = new Map<string, ProposalHealthEntry>()
  for (const h of proposalHealth) healthByBooking.set(String(h.booking_id), h)

  // Stale-duplicate guard ("games with actual fixtures"): an opponent with
  // confirmed games but NO matching SVRZ fixture is almost always a leftover from
  // an SVRZ rename — e.g. a provisional "VBC Limmattal 1" that became "VBC
  // Limmattal DU23-2" once fixtures were published. Such games can't be pushed to
  // VM (no fixture) and never reach the calendar, yet the card looks "done"
  // (green). Flag them so the spielplaner re-homes the games onto the real record
  // and deletes the duplicate. Only after fixtures actually loaded.
  const oppFixtures = (o: GameSchedulingOpponent) =>
    gamesByName.get(normName(o.team_name)) || gamesByName.get(normName(o.club_name)) || []
  const clubKey = (o: GameSchedulingOpponent) =>
    normName(o.team_name || o.club_name).split(/\s+/).slice(0, 2).join(' ')
  const orphanAlerts = fixturesLoaded
    ? teamOpponents.flatMap((o) => {
        if (oppFixtures(o).length > 0) return []
        const hasConfirmed = allBookings.some((b) => oppIdOf(b) === String(o.id) && b.status === 'confirmed')
        if (!hasConfirmed) return []
        // Likely correct record: a sibling with the same club name that DOES carry fixtures.
        const sibling = teamOpponents.find(
          (s) => String(s.id) !== String(o.id) && oppFixtures(s).length > 0 && clubKey(s) === clubKey(o),
        )
        return [{ opp: o, sibling }]
      })
    : []

  if (teamOpponents.length === 0) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">{t('noBookingsYet')}</p>
  }

  return (
    <>
    {/* Stale-duplicate guard: confirmed games on an opponent record that matches
        no SVRZ fixture (leftover after an SVRZ rename) — flagged so the games get
        re-homed onto the real fixtured record. */}
    {orphanAlerts.length > 0 && (
      <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-900/30">
        <p className="flex items-center gap-2 text-sm font-semibold text-amber-700 dark:text-amber-300">
          <span aria-hidden>⚠</span>
          {t('orphanFixtureAlert', { count: orphanAlerts.length })}
        </p>
        <p className="mt-1 text-xs text-amber-700/90 dark:text-amber-300/90">{t('orphanFixtureHint')}</p>
        <ul className="mt-2 space-y-1.5">
          {orphanAlerts.map(({ opp, sibling }) => (
            <li key={opp.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-amber-700 dark:text-amber-300">
              <span className="font-medium">{opp.team_name || opp.club_name}</span>
              <span className="text-amber-600/80 dark:text-amber-400/80">
                {sibling
                  ? t('orphanFixtureSuggest', { sibling: sibling.team_name || sibling.club_name })
                  : t('orphanFixtureNoSibling')}
              </span>
            </li>
          ))}
        </ul>
      </div>
    )}
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      {teamOpponents.map(opp => {
        const oppBookings = allBookings.filter(b => {
          const oid = typeof b.opponent === 'object' ? (b.opponent as GameSchedulingOpponent).id : b.opponent
          return String(oid) === String(opp.id)
        })
        const inviteStatus = (opp.status as InviteStatus) || 'active'
        const source = (opp.source as InviteSource) || 'self_registration'
        const oppGames = gamesByName.get(normName(opp.team_name)) || gamesByName.get(normName(opp.club_name)) || []

        // One leg per fixture — a pairing can be played 2-3× (junior triple
        // round-robin), so each side may carry several games to schedule.
        const homeLegs = buildFixtureLegs(oppGames, oppBookings, true)
        const awayLegs = buildFixtureLegs(oppGames, oppBookings, false)

        // Colour the card by how far this matchup's scheduling has got: ALL
        // games confirmed → green, some → yellow, none → red. Subtle tints.
        // ⚠ The denominator is fixture-shaped, so before `gamesByName` lands the
        // legs are built from bookings alone and the ratio means something else:
        // a pairing played 2-3× shows 2/2 → GREEN ("done, skip it") and then
        // 2/4 → yellow, and a single-round pairing paints its phantom empty leg
        // yellow before flipping to green. Both frames are the inverse of the
        // truth, so hold a neutral tint until the fetch settles (success or not).
        const allLegs = [...homeLegs, ...awayLegs]
        const confirmedCount = allLegs.filter(l => l.booking?.status === 'confirmed').length
        const cardClass = !fixturesSettled
          ? 'border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800/30'
          : confirmedCount === allLegs.length
            ? 'border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-900/20'
            : confirmedCount >= 1
              ? 'border-yellow-200 bg-yellow-50 dark:border-yellow-900 dark:bg-yellow-900/20'
              : 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-900/20'

        return (
          <div
            key={opp.id}
            className={`rounded-md border p-3 ${cardClass}`}
          >
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-gray-900 dark:text-gray-100">{opp.club_name || opp.team_name}</span>
                  <Badge variant={INVITE_STATUS_VARIANT[inviteStatus]} size="sm">
                    {t(inviteStatusKey(inviteStatus))}
                  </Badge>
                  <Badge variant={SOURCE_VARIANT[source]} size="sm">
                    {t(sourceKey(source))}
                  </Badge>
                  {opp.token && (
                    <button
                      type="button"
                      onClick={() => copyOpponentLink(opp)}
                      className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
                    >
                      {t('copyLink')}
                    </button>
                  )}
                  {oppGames.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setGamesFor({ label: opp.team_name || opp.club_name, games: overlayBookedDates(oppGames, oppBookings) })}
                      className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
                    >
                      {t('gameCount', { count: oppGames.length })}
                    </button>
                  )}
                  {mailboxConfigured && (
                    emailsFor(opp).length > 0 ? (
                      <>
                        {/* Expand the email chain inline (kept on the dashboard) … */}
                        <button
                          type="button"
                          onClick={() => toggleEmails(String(opp.id))}
                          aria-expanded={openEmails.has(String(opp.id))}
                          className="inline-flex items-center gap-0.5 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
                        >
                          {t('opponentEmails', { count: emailsFor(opp).length })}
                          <span aria-hidden>{openEmails.has(String(opp.id)) ? '▾' : '▸'}</span>
                        </button>
                        {/* … plus an explicit jump to the full Mailbox tab for this opponent. */}
                        <button
                          type="button"
                          onClick={() => onOpenMailbox(opp)}
                          title={t('openInMailbox')}
                          className="text-xs font-medium text-gray-500 hover:text-brand-600 hover:underline dark:text-gray-400 dark:hover:text-brand-400"
                        >
                          {t('openInMailbox')} ↗
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onOpenMailbox(opp)}
                        className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
                      >
                        {t('mailboxCompose')}
                      </button>
                    )
                  )}
                </div>
                {(() => {
                  const contactEmails = String(opp.contact_email || '').split(',').map((s) => s.trim()).filter(Boolean)
                  const idStr = String(opp.id)
                  const collapsible = contactEmails.length > 1
                  const open = openContacts.has(idStr)
                  // Two labelled groups when the split is stored; otherwise fall
                  // back to the merged blob (rows not re-synced since migration 110).
                  const hasSplit = !!(String(opp.calendar_contact_email || '').trim() || String(opp.team_contact_email || '').trim())
                  const renderGroup = (label: string, names?: string | null, emails?: string | null) => {
                    const e = String(emails || '').trim()
                    if (!e) return null
                    return (
                      <div className="break-words">
                        <span className="font-medium text-gray-600 dark:text-gray-300">{label}:</span>{' '}
                        {names && <span>{names} </span>}
                        <a href={buildMailtoHref(e)} className="hover:underline">({e})</a>
                      </div>
                    )
                  }
                  return (
                    <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                      {collapsible && (
                        <button
                          type="button"
                          onClick={() => toggleContacts(idStr)}
                          aria-expanded={open}
                          className="inline-flex items-center gap-0.5 font-medium text-brand-600 hover:underline dark:text-brand-400"
                        >
                          {t('contactCount', { count: contactEmails.length })}
                          <span aria-hidden>{open ? '▾' : '▸'}</span>
                        </button>
                      )}
                      {(!collapsible || open) && (
                        hasSplit ? (
                          <div className={`space-y-1 ${collapsible ? 'mt-1' : ''}`}>
                            {renderGroup(t('calendarResponsibles'), opp.calendar_contact_name, opp.calendar_contact_email)}
                            {renderGroup(t('teamResponsibles'), opp.team_contact_name, opp.team_contact_email)}
                          </div>
                        ) : (
                          <div className={`break-words ${collapsible ? 'mt-1' : ''}`}>
                            {opp.contact_name && <span>{opp.contact_name} </span>}
                            {opp.contact_email && (
                              <a href={buildMailtoHref(opp.contact_email)} className="hover:underline">
                                ({opp.contact_email})
                              </a>
                            )}
                          </div>
                        )
                      )}
                    </div>
                  )
                })()}
                {opp.team_name && opp.team_name !== opp.club_name && (
                  <div className="text-xs text-gray-400 dark:text-gray-500">{opp.team_name}</div>
                )}
              </div>
            </div>

            {mailboxConfigured && openEmails.has(String(opp.id)) && emailsFor(opp).length > 0 && (
              <div className="mb-3 divide-y divide-gray-100 rounded-md border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
                {emailsFor(opp).map((m) => {
                  const unread = m.direction === 'in' && !m.read_at
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => onOpenMailbox(opp)}
                      className="flex w-full items-start gap-2 px-2 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50"
                    >
                      <span className="whitespace-nowrap text-xs text-gray-400 dark:text-gray-500">
                        {m.date_sent ? formatDateTimeCompact(m.date_sent) : ''}
                      </span>
                      <span className={`min-w-0 flex-1 truncate text-xs ${unread ? 'font-semibold text-gray-900 dark:text-gray-100' : 'text-gray-600 dark:text-gray-400'}`}>
                        {m.direction === 'out' ? '→ ' : ''}{m.subject || t('mailboxNoSubject')}
                      </span>
                      {unread && <span aria-hidden className="mt-1 inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-brand-600" />}
                    </button>
                  )
                })}
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {/* Home game bookings — one block per fixture */}
              <div className="flex flex-col">
                <h4 className="mb-1 text-sm font-medium text-gray-700 dark:text-gray-300">{t('homeBookings')}</h4>
                <div className="flex flex-1 flex-col gap-3">
                  {homeLegs.length === 0 && (
                    <span className="text-sm text-gray-400">{t('noGameThisSide')}</span>
                  )}
                  {homeLegs.map((leg) => (
                    <div key={leg.key} className="flex flex-1 flex-col">
                      {(leg.sideCount > 1 || leg.number != null) && (
                        <p className="mb-0.5 text-xs font-medium text-gray-500 dark:text-gray-400">
                          {leg.sideCount > 1 ? t('gameN', { number: leg.seq }) : t('manualHomeGame')}
                          {leg.number != null && <span className="font-normal"> · #{leg.number}</span>}
                        </p>
                      )}
                      {leg.booking ? (
                        <HomeProposalReview
                          booking={leg.booking}
                          slotsById={slotsById}
                          hallsById={hallsById}
                          alsoProposedBy={(slotId) => homeAlsoProposedBy(slotId, oppIdOf(leg.booking!))}
                          health={healthByBooking.get(String(leg.booking.id))}
                          onConfirm={onConfirmHome}
                          onVmPush={onVmPush}
                          onRequestNewSlots={() => onRequestNewSlots(opp.id, leg.booking!.id)}
                          onDelete={() => onDeleteBooking(leg.booking!)}
                        />
                      ) : opp.new_slots_requested_at ? (
                        <span className="text-sm text-amber-600 dark:text-amber-400">
                          {t('awaitingNewProposals', { date: formatDateCompactZurich(opp.new_slots_requested_at) })}
                        </span>
                      ) : !fixturesSettled ? (
                        // "Pending" asserts a game exists on this side and is
                        // awaiting a proposal — but until the fixtures land the
                        // leg under it is synthetic, and a single-round pairing
                        // resolves to "No game this side" instead.
                        <span className="inline-block h-5 w-20 animate-pulse rounded bg-gray-200 dark:bg-gray-700" aria-hidden />
                      ) : (
                        <span className="text-sm text-gray-400">{t('pending')}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Away game proposals — one block per fixture */}
              <div className="flex flex-col">
                <h4 className="mb-1 text-sm font-medium text-gray-700 dark:text-gray-300">{t('awayProposals')}</h4>
                <div className="flex flex-1 flex-col gap-3">
                  {awayLegs.length === 0 && (
                    <span className="text-sm text-gray-400">{t('noGameThisSide')}</span>
                  )}
                  {awayLegs.map((leg) => (
                    <div key={leg.key} className="flex flex-1 flex-col">
                      {(leg.sideCount > 1 || leg.number != null) && (
                        <p className="mb-0.5 text-xs font-medium text-gray-500 dark:text-gray-400">
                          {leg.sideCount > 1 ? t('gameN', { number: leg.seq }) : t('manualAwayGame')}
                          {leg.number != null && <span className="font-normal"> · #{leg.number}</span>}
                        </p>
                      )}
                      {leg.booking ? (
                        <AwayProposalReview
                          booking={leg.booking}
                          onConfirm={onConfirmAway}
                          vmCheck={awayVmChecks[String(leg.booking.id)] ?? null}
                          onSyncVm={() => onSyncVm({ key: `b:${leg.booking!.id}`, bookingId: String(leg.booking!.id) })}
                          vmSyncing={vmSyncing === `b:${leg.booking.id}`}
                          health={healthByBooking.get(String(leg.booking.id))}
                          onDelete={() => onDeleteBooking(leg.booking!)}
                        />
                      ) : unbookedByKey.has(`${opp.id}:${leg.svrzGameId}`) ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm text-amber-700 dark:text-amber-400">
                            {t('awayVmUnbookedRow', { vm: unbookedByKey.get(`${opp.id}:${leg.svrzGameId}`)!.vm })}
                          </span>
                          <button
                            type="button"
                            onClick={() => onSyncVm({ key: `u:${opp.id}:${leg.svrzGameId}`, opponentId: String(opp.id), svrzGameId: leg.svrzGameId })}
                            disabled={vmSyncing === `u:${opp.id}:${leg.svrzGameId}`}
                            className="rounded-md border border-amber-300 bg-white px-2 py-0.5 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-700 dark:bg-gray-800 dark:text-amber-300 dark:hover:bg-gray-700"
                          >
                            {vmSyncing === `u:${opp.id}:${leg.svrzGameId}` ? '…' : t('syncWithVm')}
                          </button>
                        </div>
                      ) : !fixturesSettled ? (
                        // "Pending" asserts a game exists on this side and is
                        // awaiting a proposal — but until the fixtures land the
                        // leg under it is synthetic, and a single-round pairing
                        // resolves to "No game this side" instead.
                        <span className="inline-block h-5 w-20 animate-pulse rounded bg-gray-200 dark:bg-gray-700" aria-hidden />
                      ) : (
                        <span className="text-sm text-gray-400">{t('pending')}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <OpponentNotes
              opponentNote={opp.opponent_note}
              kscwNote={opp.kscw_note}
              onSave={(note) => onSaveOpponentNote(opp.id, note)}
            />

            <ManualBookingForm
              halls={hallOptions}
              defaultHomeHall={defaultHomeHall}
              homeFixtures={homeLegs.map((leg) => ({
                id: leg.svrzGameId,
                label: leg.sideCount > 1 ? t('gameN', { number: leg.seq }) : t('manualHomeGame'),
                booked: leg.booking?.status === 'confirmed',
                prefill: homeLegPrefill(leg),
              }))}
              awayFixtures={awayLegs.map((leg) => ({
                id: leg.svrzGameId,
                label: leg.sideCount > 1 ? t('gameN', { number: leg.seq }) : t('manualAwayGame'),
                booked: leg.booking?.status === 'confirmed',
                prefill: awayLegPrefill(leg),
              }))}
              minDate={dateWindow?.start}
              maxDate={dateWindow?.end}
              fetchDateContext={async (date) => {
                try {
                  const resp = await kscwApi(`/admin/terminplanung/date-context?kscw_team=${kscwTeamId}&dates=${date}`) as {
                    context?: Record<string, { absences: number; absent_names: string[]; prev_game: { date: string; days: number } | null; next_game: { date: string; days: number } | null }>
                  }
                  const c = resp.context?.[date]
                  return c ? { num: 0, slot_id: 0, valid: true, reason: null, absences: c.absences, absent_names: c.absent_names, prev_game: c.prev_game, next_game: c.next_game } : null
                } catch { return null }
              }}
              onSave={(legs) => onManualBooking(opp.id, legs)}
            />
          </div>
        )
      })}
    </div>

    {/* SVRZ fixtures for one opponent (the games still to schedule). Each row
        stacks date+number / matchup on separate lines so nothing is squeezed
        into a wide single line. */}
    <Dialog open={!!gamesFor} onOpenChange={(o) => { if (!o) setGamesFor(null) }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{gamesFor?.label}</DialogTitle>
          <DialogDescription>
            {t('gameCount', { count: gamesFor?.games.length ?? 0 })}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[65vh] overflow-y-auto">
          <Table>
            <TableBody>
              {(gamesFor?.games ?? []).map((g, i) => (
                <TableRow key={i}>
                  <TableCell className="py-2.5">
                    <p className="font-medium">
                      {g._realDate || (g.date ? formatDateTimeCompact(g.date) : '—')}
                      {g.number != null && (
                        <span className="ml-2 font-normal text-gray-400 dark:text-gray-500" title={t('gameNumberHint')}>
                          #{g.number}
                        </span>
                      )}
                    </p>
                    <p className="break-words whitespace-normal text-gray-600 dark:text-gray-400">
                      {g.is_home_kscw
                        ? `KSCW ${kscwTeamName} vs ${gamesFor?.label ?? ''}`
                        : `${gamesFor?.label ?? ''} vs KSCW ${kscwTeamName}`}
                    </p>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </DialogContent>
    </Dialog>
    </>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// Basketball
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The basketball half of the dashboard.
 *
 * Same shape as the volleyball body above — season header, summary tiles, per-team
 * table, overview calendar — over basketball's own data. What is deliberately
 * ABSENT, because ProBasket owns the schedule and there is no push-back: proposal
 * inbox, confirm/decline, invite tracking, derby anchoring, SVRZ fixtures and
 * VolleyManager push. Those are not hidden panels; there is nothing to put in them
 * (user, 2026-08-05: "no VM push, no SVRZ stuff etc").
 *
 * Read-only by design. Every action lives on the tab that owns it — generating
 * slots and editing rules on Settings, placing games on the Planner — so this page
 * cannot become a second, diverging way to mutate the plan.
 */
function BasketballDashboardBody() {
  const { t } = useTranslation('basketballScheduling')
  const { season, isLoading: seasonLoading } = useGameSchedulingSeason()
  const { teams, placements, vbGames, closureEntries, blockedDayReasons, isLoading: planLoading } =
    useBasketballPlan(season)
  const slots = useBasketballSlots(season?.id)
  const offers = useBasketballOffers(season?.id)
  const portals = useBasketballClubPortals(season?.id)

  const isInitialLoading = seasonLoading || planLoading
  useReportPageLoading(isInitialLoading)

  const placed = useMemo(() => [...placements.values()], [placements])

  // One row per team: what is planned, what is still only a candidate, and whether
  // the opponent has been told. `offered` counts games published to an opponent
  // club; `candidates` are generated possibilities nobody has acted on yet.
  const perTeam = useMemo(() => {
    const offeredByTeam = new Map<string, number>()
    for (const g of offers.games ?? []) {
      if (!g.offered || g.kscw_team == null) continue
      const k = String(g.kscw_team)
      offeredByTeam.set(k, (offeredByTeam.get(k) ?? 0) + 1)
    }
    return teams.map((tm) => {
      const k = String(tm.id)
      return {
        id: k,
        name: tm.name,
        placed: placed.filter((p) => String(p.kscw_team ?? '') === k).length,
        candidates: (slots.byTeam?.get(k) ?? []).length,
        offered: offeredByTeam.get(k) ?? 0,
        // Demand: home games under Hin+Rück, or null where the group is not final yet.
        home: homeGamesFor(tm.bb_source_id),
      }
    })
  }, [teams, placed, slots.byTeam, offers.games])

  /**
   * Club-wide home-game demand — summed only over the teams whose group is final, with the
   * rest counted separately. A single total that silently blended "7 real" with "unknown"
   * would be the one number nobody could act on.
   */
  const homeDemand = useMemo(() => {
    let known = 0
    let unknownTeams = 0
    for (const r of perTeam) {
      if (r.home.count !== null) known += r.home.count
      else unknownTeams += 1
    }
    return { known, unknownTeams }
  }, [perTeam])

  const totals = useMemo(() => ({
    placed: placed.length,
    candidates: slots.slots?.length ?? 0,
    offered: (offers.games ?? []).filter((g) => g.offered).length,
    unassigned: (offers.unassigned ?? []).length,
    clubs: (portals.clubs ?? []).length,
    portals: (portals.portals ?? []).length,
    // 'booked' is the portal's terminal answered state (BbPortalStatus:
    // invited | viewed | booked | revoked | expired) — there is no 'responded'.
    responded: (portals.portals ?? []).filter((p) => p.status === 'booked').length,
  }), [placed, slots.slots, offers.games, offers.unassigned, portals.clubs, portals.portals])

  if (isInitialLoading) return null
  if (!season) {
    return <div className="text-center text-gray-500 dark:text-gray-400">{t('noSeason')}</div>
  }

  const tile = 'rounded-lg border border-border bg-card px-4 py-3'
  const tileNum = 'text-2xl font-bold tabular-nums'

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-bold sm:text-2xl">{t('dashboardTitle')}</h1>
        <p className="text-sm text-muted-foreground">{formatSeasonShort(season.season)}</p>
      </header>

      {/* Summary — planned vs merely possible vs communicated. Kept to what the
          section actually asks about; a number nobody acts on is noise. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <div className={tile}>
          <div className={tileNum}>{totals.placed}</div>
          <div className="text-xs text-muted-foreground">{t('dashPlacedGames')}</div>
        </div>
        <div className={tile}>
          <div className={tileNum}>{totals.candidates}</div>
          <div className="text-xs text-muted-foreground">{t('dashCandidateSlots')}</div>
        </div>
        <div className={tile}>
          <div className={tileNum}>{totals.offered}</div>
          <div className="text-xs text-muted-foreground">{t('dashOffered')}</div>
        </div>
        <div className={tile} title={t('dashHomeGamesHint')}>
          <div className={tileNum}>
            {homeDemand.known}
            {homeDemand.unknownTeams > 0 && (
              <span className="text-base font-normal text-muted-foreground">
                {' '}
                +{t('dashHomeGamesOpen', { count: homeDemand.unknownTeams })}
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground">{t('dashHomeGames')}</div>
        </div>
        <div className={tile}>
          <div className={tileNum}>
            {totals.portals}
            <span className="text-base font-normal text-muted-foreground">/{totals.clubs}</span>
          </div>
          <div className="text-xs text-muted-foreground">{t('dashPortals')}</div>
        </div>
        <div className={tile}>
          <div className={tileNum}>{totals.responded}</div>
          <div className="text-xs text-muted-foreground">{t('dashResponded')}</div>
        </div>
      </div>

      {totals.unassigned > 0 && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
          ⚠ {t('dashUnassignedWarning', { count: totals.unassigned })}
        </p>
      )}

      {/* Per-team status — a record list, so a table (CLAUDE.md). */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{t('dashPerTeam')}</h2>
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableBody>
              <TableRow className="bg-muted/50 font-medium">
                <TableCell className="whitespace-normal break-words">{t('dashTeam')}</TableCell>
                <TableCell className="text-right">{t('dashPlacedGames')}</TableCell>
                <TableCell className="text-right">{t('dashCandidateSlots')}</TableCell>
                <TableCell className="text-right">{t('dashOffered')}</TableCell>
                <TableCell className="text-right">{t('dashHomeGames')}</TableCell>
              </TableRow>
              {perTeam.map((r) => (
                <TableRow key={r.id} className="min-h-[44px]">
                  <TableCell className="whitespace-normal break-words font-medium">{r.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.placed}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.candidates}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.offered}</TableCell>
                  {/* A dash is "not decided yet", never zero — see bbHomeGames.ts. */}
                  <TableCell className="text-right tabular-nums">
                    {r.home.count !== null ? (
                      r.home.count
                    ) : (
                      <span
                        className="text-muted-foreground"
                        title={t(`homeGamesUnknown_${r.home.reason ?? 'no_group'}`)}
                      >
                        –
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      {/* The same calendar component the Planner and Calendar tabs use — one
          calendar, not a third rendering of the same season. */}
      <BasketballCalendarPanel
        seasonName={season.season}
        teams={teams}
        placements={placements}
        vbGames={vbGames}
        closureEntries={closureEntries}
        blockedDayReasons={blockedDayReasons}
      />
    </div>
  )
}
