import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MessageSquare, X, Check, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import type { Game, Team, Hall, Member, BaseRecord, Participation } from '../../../types'
import { Button } from '@/components/ui/button'
import { MeetingTimeSelect } from '@/components/MeetingTimeSelect'
import TeamChip from '../../../components/TeamChip'
import { teamNameToColorKey } from '../../../utils/teamColors'
import ParticipationSummary from '../../../components/ParticipationSummary'
import { rsvpButtonClass } from '../../../utils/participationColors'
import ParticipationRosterModal from '../../../components/ParticipationRosterModal'
import RosterModal from '../../scorer/components/RosterModal'
import PreGameRosterModal from './PreGameRosterModal'
import ShowIdsModal from './ShowIdsModal'
import { useAuth } from '../../../hooks/useAuth'
import { useAdminMode } from '../../../hooks/useAdminMode'
import { useTeamPermissions } from '../../../hooks/useTeamPermissions'
import { useIsCalledUpToGame } from '../../../hooks/useUserVisibleGameIds'
import { useParticipation } from '../../../hooks/useParticipation'
import { useMyCoveringAbsence } from '../../../hooks/useMyCoveringAbsence'
import { useAbsenceNoteText } from '../../../hooks/useAbsenceNoteText'
import { useMutation } from '../../../hooks/useMutation'
import { fetchItem, kscwApi } from '../../../lib/api'
import { invalidateForCollection } from '../../../lib/query'
import { useConfirm } from '../../../components/ConfirmProvider'
import { sanitizeUrl } from '../../../utils/sanitizeUrl'
import DatePicker from '@/components/ui/DatePicker'
import { currentLocale, formatDate, formatTime, formatDateTimeCompactZurich, parseRespondByTime, toUtcIsoFromDatetimeLocal, isWithinDutyLateWindow, gameKickoffMs, meetingTimeFromOffset } from '../../../utils/dateHelpers'
import RefereeExpenseSection from './RefereeExpenseSection'
import GameGuestSection from './GameGuestSection'
import BroadcastButton from '../../broadcast/BroadcastButton'
import ShareActivityButton from '../../../components/ShareActivityButton'
import { isFeatureEnabled } from '../../../utils/featureToggles'
import { asObj, relId, teamCoachIds, memberDisplayName } from '../../../utils/relations'
import CancelActivityButton from '../../../components/CancelActivityButton'

const GAME_EXPAND = 'kscw_team,hall,scorer_member,scoreboard_member,scorer_scoreboard_member,referee_member,scorer_duty_team,scoreboard_duty_team,scorer_scoreboard_duty_team,referee_duty_team,bb_scorer_member,bb_timekeeper_member,bb_24s_official,bb_duty_team,bb_scorer_duty_team,bb_timekeeper_duty_team,bb_24s_duty_team'

/** Late-report state for a game's duties, from GET /kscw/games/:id/duty-late. */
type DutyLateReport = { at: string; by_name: string }
type DutyLateContact = { phone: string | null; email: string | null; hide_phone: boolean; hide_email: boolean }
type DutyLateData = { reports: Record<string, DutyLateReport>; contacts: Record<string, DutyLateContact> }

interface GameDetailModalProps {
  game: Game | null
  onClose: () => void
  readOnly?: boolean
  /**
   * Participations the opening surface has already fetched for this game. Passing
   * them renders the RSVP counters on the panel's first paint; without it the
   * summary opens its own request and the rectangles arrive a round-trip late.
   */
  participations?: Participation[]
}

type ExpandedGame = Game & {
  kscw_team: (Team & BaseRecord) | string
  hall: (Hall & BaseRecord) | string
  scorer_member: (Member & BaseRecord) | string
  scoreboard_member: (Member & BaseRecord) | string
  scorer_scoreboard_member: (Member & BaseRecord) | string
  referee_member: (Member & BaseRecord) | string
  scorer_duty_team: (Team & BaseRecord) | string
  scoreboard_duty_team: (Team & BaseRecord) | string
  scorer_scoreboard_duty_team: (Team & BaseRecord) | string
  referee_duty_team: (Team & BaseRecord) | string
  bb_scorer_member: (Member & BaseRecord) | string
  bb_timekeeper_member: (Member & BaseRecord) | string
  bb_24s_official: (Member & BaseRecord) | string
  bb_duty_team: (Team & BaseRecord) | string
  bb_scorer_duty_team: (Team & BaseRecord) | string
  bb_timekeeper_duty_team: (Team & BaseRecord) | string
  bb_24s_duty_team: (Team & BaseRecord) | string
}

function parseSets(json: unknown): Array<{ home: number; away: number }> {
  if (!Array.isArray(json)) return []
  return json.filter(
    (s): s is { home: number; away: number } =>
      typeof s === 'object' && s !== null && 'home' in s && 'away' in s,
  )
}

const dateFormatOptions: Intl.DateTimeFormatOptions = {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
}

/** Einsatzliste push journal (`games.vm_nomination_status`) → copy + colour.
 *  `filled` is NOT a failure: the players were written to Volleymanager, but the
 *  list was deliberately left open because VM flagged something fineable (too few
 *  players / no coach), so the coach must review and close it. Hence amber, not red. */
type NominationStatus = NonNullable<Game['vm_nomination_status']>

const NOMINATION_STATUS_KEY: Record<NominationStatus, string> = {
  pending: 'nominationStatusPending',
  filled: 'nominationStatusFilled',
  closed: 'nominationStatusClosed',
  skipped: 'nominationStatusSkipped',
  failed: 'nominationStatusFailed',
}

const NOMINATION_STATUS_TONE: Record<NominationStatus, string> = {
  pending: 'border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300',
  filled: 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200',
  closed: 'border-green-300 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-200',
  skipped: 'border-gray-200 bg-gray-50 text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400',
  failed: 'border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200',
}

/**
 * Does this game object still carry bare ids for relations the modal renders?
 *
 * Asks about what is DISPLAYED, not just the duty block: GAME_EXPAND carries hall
 * and kscw_team too, and while nothing here asked for them a source that expanded
 * the duties but not the hall never triggered the re-fetch, leaving Venue empty
 * for good.
 *
 * Pure, and used twice on purpose — the effect fires the re-fetch off it, and the
 * render uses it to tell "not loaded yet" apart from "nobody is assigned". Without
 * that second use the duty section paints its heading off a bare id and then has
 * no rows to show under it, which reads as "no scorer assigned" until the second
 * request lands — and stays that way for good if the request fails.
 */
function gameNeedsExpand(game: Game): boolean {
  const exp = game as unknown as ExpandedGame
  return !!(
    (game.hall && !asObj(exp.hall)) ||
    (game.kscw_team && !asObj(exp.kscw_team)) ||
    (game.scorer_member && !asObj(exp.scorer_member)) ||
    (game.scoreboard_member && !asObj(exp.scoreboard_member)) ||
    (game.scorer_scoreboard_member && !asObj(exp.scorer_scoreboard_member)) ||
    (game.scorer_duty_team && !asObj(exp.scorer_duty_team)) ||
    (game.scoreboard_duty_team && !asObj(exp.scoreboard_duty_team)) ||
    (game.scorer_scoreboard_duty_team && !asObj(exp.scorer_scoreboard_duty_team)) ||
    (game.bb_scorer_member && !asObj(exp.bb_scorer_member)) ||
    (game.bb_timekeeper_member && !asObj(exp.bb_timekeeper_member)) ||
    (game.bb_24s_official && !asObj(exp.bb_24s_official)) ||
    (game.bb_duty_team && !asObj(exp.bb_duty_team)) ||
    (game.bb_scorer_duty_team && !asObj(exp.bb_scorer_duty_team)) ||
    (game.bb_timekeeper_duty_team && !asObj(exp.bb_timekeeper_duty_team)) ||
    (game.bb_24s_duty_team && !asObj(exp.bb_24s_duty_team))
  )
}

/** One duty line's worth of placeholder, while the expansion is in flight. */
function DutyRowSkeleton() {
  return (
    <div className="flex items-center justify-between gap-3 py-1" aria-hidden="true">
      <div className="h-3 w-20 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
      <div className="h-3 w-32 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
    </div>
  )
}

export default function GameDetailModal({ game, onClose, readOnly, participations }: GameDetailModalProps) {
  const { t } = useTranslation('games')
  const { t: tc } = useTranslation('common')
  const { user, isStaffOnly, canParticipateIn, isGuestIn, coachTeamIds, teamResponsibleIds, hasAdminAccessToTeam, teamsLoading } = useAuth()
  const { effectiveIsAdmin } = useAdminMode()
  const { canManageTeam } = useTeamPermissions()
  const confirm = useConfirm()
  const [rosterOpen, setRosterOpen] = useState(false)
  const [participationListOpen, setParticipationListOpen] = useState(false)
  const [idsOpen, setIdsOpen] = useState(false)
  const [editingDeadline, setEditingDeadline] = useState(false)
  const [deadlineValue, setDeadlineValue] = useState(() => {
    const parsed = parseRespondByTime(game?.respond_by, game?.time)
    return parsed?.date ?? ''
  })
  const [deadlineTime, setDeadlineTime] = useState(() => {
    const parsed = parseRespondByTime(game?.respond_by, game?.time)
    return parsed?.time ?? ''
  })
  const [fullGame, setFullGame] = useState<Game | null>(null)
  const [lateData, setLateData] = useState<DutyLateData | null>(null)
  // `lateData === null` used to mean two opposite things: "the duty-late GET has
  // not landed yet" AND "nobody has flagged this official". The second reading
  // won on the first frame, so an already-reported duty painted a red "report as
  // late" alarm instead of its banner + revealed phone/email. Seeded TRUE so the
  // very first frame is guarded rather than answered.
  const [lateFetched, setLateFetched] = useState(false)
  // Per-game Einsatzliste override — held locally so the pills react instantly;
  // the write goes through updateGame (which invalidates the games query).
  const [autoNomination, setAutoNomination] = useState<boolean | null>(game?.auto_nomination_list ?? null)
  const [pushingNomination, setPushingNomination] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const { update: updateGame } = useMutation<Game>('games')
  // Called-up players (migration 271) are not on this team's roster, so the
  // team-scoped canParticipateIn misses them — see useIsCalledUpToGame.
  const isCalledUp = useIsCalledUpToGame(user?.id, game?.id)
  const canParticipate = !!user && !!game?.kscw_team && (canParticipateIn(relId(game.kscw_team)) || isCalledUp)
  const isStaffParticipant = !!game?.kscw_team && isStaffOnly(relId(game.kscw_team))
  const { effectiveStatus, hasAbsence, note: savedNote, setStatus, saveConfirmed, dismissConfirmed, isLoading: rsvpLoading } = useParticipation(
    'game',
    game?.id ?? '',
    game?.date,
    undefined,
    isStaffParticipant,
  )
  const { absence } = useMyCoveringAbsence('game', game?.date)
  const absenceLabel = absence?.type === 'weekly' ? 'participation:declinedUnavailable' : 'participation:absent'
  const absenceNoteText = useAbsenceNoteText(absence)
  const [noteText, setNoteText] = useState(savedNote)
  const [noteSaved, setNoteSaved] = useState(false)
  // Sync note text — fall back to absence label when no server note. Tracked in
  // state rather than a ref (refs must not be read/written during render); the
  // initial value mirrors the old `useRef(savedNote)` exactly.
  const [noteInit, setNoteInit] = useState(savedNote)
  const effectiveSync = savedNote || absenceNoteText
  if (effectiveSync !== noteInit) {
    setNoteInit(effectiveSync)
    setNoteText(effectiveSync)
  }

  // Auto-dismiss status confirmation after 2s
  useEffect(() => {
    if (!saveConfirmed) return
    const timer = setTimeout(dismissConfirmed, 2000)
    return () => clearTimeout(timer)
  }, [saveConfirmed, dismissConfirmed])

  // Auto-dismiss note confirmation after 2s
  useEffect(() => {
    if (!noteSaved) return
    const timer = setTimeout(() => setNoteSaved(false), 2000)
    return () => clearTimeout(timer)
  }, [noteSaved])

  const saveNote = () => {
    if (noteText !== savedNote && effectiveStatus) {
      setStatus(effectiveStatus as 'confirmed' | 'tentative' | 'declined', noteText)
      setNoteSaved(true)
    }
  }

  // Drop the previously expanded game as soon as a different game object arrives —
  // reset-on-prop-change during render (React's adjust-state-during-render pattern)
  // instead of a setState at the top of the fetch effect below.
  const [prevGame, setPrevGame] = useState(game)
  if (prevGame !== game) {
    setPrevGame(game)
    setFullGame(null)
  }
  // Re-seed the Einsatzliste override whenever a different game is opened.
  const [prevNominationGameId, setPrevNominationGameId] = useState(game?.id)
  if (prevNominationGameId !== game?.id) {
    setPrevNominationGameId(game?.id)
    setAutoNomination(game?.auto_nomination_list ?? null)
    setPushingNomination(false)
  }
  const lateKey = `${game?.id ?? ''}|${game?.type ?? ''}`
  const [prevLateKey, setPrevLateKey] = useState(lateKey)
  if (prevLateKey !== lateKey) {
    setPrevLateKey(lateKey)
    setLateData(null)
    setLateFetched(false)
  }

  // Re-fetch with full expand when opened from calendar (which only expands kscw_team,hall)
  useEffect(() => {
    if (!game) return
    if (gameNeedsExpand(game)) {
      fetchItem<Game>('games', game.id, { fields: ['*', ...GAME_EXPAND.split(',').map(r => `${r}.*`)] }).then(r => setFullGame(r)).catch(() => {})
    }
  }, [game])

  // Late-report state — only for coaches/TRs/admins of the PLAYING team, on home
  // games. Lets the "duty is late" reveal survive a reload without re-emailing.
  // Derived during render, NOT set from inside the effect: a synchronous setState
  // in an effect body is a cascading-render hazard (eslint react-hooks), and this
  // answer is pure anyway.
  //
  // `coachTeamIds` / `teamResponsibleIds` start EMPTY and fill from an async
  // loadTeamContext, so answering this before they land says "not staff". Waiting
  // on `teamsLoading` is what re-arms the fetch when the context arrives — with
  // the old id-only deps a cold start, a deep link or a household acting-member
  // swap left the alarm standing for good.
  const lateTeamId = relId(game?.kscw_team)
  const canSeeLate = !!game?.id && game?.type === 'home' && !teamsLoading
    && (hasAdminAccessToTeam(lateTeamId) || coachTeamIds.includes(lateTeamId) || teamResponsibleIds.includes(lateTeamId))
  // Only whoever may see the alarm ever waits for it; for everyone else it is
  // never "loading", so nothing is gated on a fetch that will not happen.
  const lateLoading = canSeeLate && !lateFetched

  useEffect(() => {
    if (!canSeeLate || !game?.id) return
    let cancelled = false
    kscwApi<DutyLateData>(`/games/${game.id}/duty-late`)
      .then((r) => { if (!cancelled) setLateData(r) })
      .catch(() => { /* non-fatal — alarm still works, reveal just won't pre-populate */ })
      // Settles on failure too: the report POST is idempotent server side, so
      // failing open to the alarm beats hanging on a skeleton for ever.
      .finally(() => { if (!cancelled) setLateFetched(true) })
    return () => { cancelled = true }
  }, [canSeeLate, game?.id])

  useEffect(() => {
    if (!game) return
    const dialog = dialogRef.current
    const focusables = () => dialog
      ? Array.from(
          dialog.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), textarea, input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((el) => el.offsetParent !== null)
      : []
    // Initial-focus management: move focus into the dialog on open.
    focusables()[0]?.focus()
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'Tab' || !dialog) return
      const items = focusables()
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement as HTMLElement | null
      // Only wrap at the dialog's own edges. When focus is elsewhere (e.g. the
      // nested roster sub-modal), leave it alone so we don't hijack its tabbing.
      if (e.shiftKey) {
        if (active === first) {
          e.preventDefault()
          last.focus()
        }
      } else if (active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [game, onClose])

  if (!game) return null

  const expanded = (fullGame ?? game) as unknown as ExpandedGame
  // Duty names live only on the second request. Until it lands the duty rows have
  // nothing to render, so the section would show its heading over empty space —
  // indistinguishable from "no officials assigned".
  const awaitingExpand = !fullGame && gameNeedsExpand(game)
  const expandedHall = asObj<Hall & BaseRecord>(expanded.hall)
  const awayHall = game.away_hall_json
  const awayMapsUrl = awayHall
    ? awayHall.plus_code
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(awayHall.plus_code)}`
      : awayHall.address && awayHall.city
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${awayHall.address}, ${awayHall.city}`)}`
        : ''
    : ''
  const hall = expandedHall ?? (awayHall ? { name: awayHall.name, address: awayHall.address, city: awayHall.city, maps_url: awayMapsUrl } : null)
  const kscwTeamObj = asObj<Team & BaseRecord>(expanded.kscw_team)
  const kscwTeamId = relId(game?.kscw_team)
  const rawKscwTeam = kscwTeamObj?.name ?? ''
  const kscwSport = kscwTeamObj?.sport as 'volleyball' | 'basketball' | undefined
  const kscwTeam = rawKscwTeam && kscwSport ? teamNameToColorKey(rawKscwTeam, kscwSport) : rawKscwTeam
  // Show OUR side from the linked team's VM-owned name (teams.full_name) so it
  // mirrors VM even when the SV API caption lags (e.g. DU23-1 → DU23-2). Opponent
  // keeps the SV caption; falls back to the stored string if kscw_team is bare.
  const kscwFullLabel = kscwTeamObj?.full_name || (rawKscwTeam ? `KSC Wiedikon ${rawKscwTeam}` : '')
  const homeLabel = game.type === 'home' && kscwFullLabel ? kscwFullLabel : game.home_team
  const awayLabel = game.type === 'away' && kscwFullLabel ? kscwFullLabel : game.away_team
  const sets = parseSets(game.sets_json)
  // Long date with weekday/month NAMES — follow the active UI language. The
  // strict de-CH rule (CLAUDE.md) applies to numeric dd.mm.yyyy dates only.
  const dateStr = game.date ? new Intl.DateTimeFormat(currentLocale(), dateFormatOptions).format(new Date(game.date)) : ''
  // Contact reveal: admins (sport/global) still see it anytime via the items
  // API. Coaches/TRs no longer see it automatically — it's kept out of sight and
  // revealed only behind the per-role "duty is late" alarm (handled per row).
  //
  // Admin power in this modal follows the app-wide admin-mode contract: it
  // applies only while the toggle is ON. Both useAuth helpers are mode-BLIND —
  // `isCoachOf` folds `hasAdminAccessToTeam` in — so calling them raw handed an
  // admin full coach powers with admin mode off. This modal was the only one of
  // six `hasAdminAccessToTeam` call sites that did not pair it with useAdminMode.
  // Contact reveal is admin-only — NOT a coach power — so it keeps its own root.
  const adminSeesContact = effectiveIsAdmin && hasAdminAccessToTeam(kscwTeamId)
  // Everything else is the shared idiom: coach/TR of the team, or an admin for its
  // sport while admin mode is ON. `coachTeamIds` is coaches ∪ responsibles, so this
  // covers what `isTeamStaff` and `canEditAsCoach` used to spell out separately.
  const canEditAsCoach = canManageTeam(kscwTeamId)
  // Staff of the playing team. Gates the referee-expenses panel.
  const isTeamStaff = canManageTeam(kscwTeamId)
  // Show IDs is NARROWER than isTeamStaff, and must mirror the server: mayRead()
  // in identity-document.js has no admin branch and refuses an admin outright —
  // they hold no envelope, so they could not decrypt a thing. Offering them the
  // button is a dead end that reports "0 documents downloaded", i.e. the message
  // that means "nobody has uploaded one". Real coach/TR membership only.
  const canShowIds = coachTeamIds.includes(kscwTeamId) || teamResponsibleIds.includes(kscwTeamId)
  // The assigned Schreiber (scorer roles only — pure Täfeler excluded, mirroring
  // the roster endpoint). For them "View roster" opens the confirmed match sheet
  // (jersey #, DoB, coaches, ±window) instead of the RSVP roster. `user.id` is a
  // member id here (useAuth().user is a Member), so it compares to the duty FKs.
  const myMemberId = user?.id ? String(user.id) : ''
  const isAssignedScorer = !!myMemberId && [game.scorer_member, game.scorer_scoreboard_member, game.bb_scorer_member]
    .some((v) => v != null && String(relId(v)) === myMemberId)
  // Scorers and the team's own staff have their roster button hijacked to a match
  // sheet, which is a different question from "who is coming" — so they get both
  // buttons. Everyone else has one, and it is the participation list.
  const rosterIsMatchSheet = isAssignedScorer || isTeamStaff
  const canReportLate = !!user && game.status === 'scheduled' && game.type === 'home'
    && (adminSeesContact || coachTeamIds.includes(kscwTeamId) || teamResponsibleIds.includes(kscwTeamId))
  const sportWord = kscwSport === 'basketball' ? t('scoreboardBasketball') : t('scoreboardVolleyball')

  // Flag a duty official as late: confirm → email (official + sport TK + admin)
  // via the endpoint → reveal their contact until kickoff (+ grace). Idempotent
  // server-side, so a second press won't re-email.
  const gameId = game.id
  async function reportLate(role: string, roleLabel: string, personName: string) {
    const ok = await confirm({
      title: t('dutyLateConfirmTitle', { role: roleLabel }),
      message: t('dutyLateConfirmMessage', { name: personName || roleLabel, sport: sportWord }),
      confirmLabel: t('dutyLateConfirmCta'),
      danger: true,
    })
    if (!ok) return
    try {
      const res = await kscwApi<{ report: DutyLateReport; contact: DutyLateContact }>(
        `/games/${gameId}/duty-late`, { method: 'POST', body: { role } },
      )
      setLateData((prev) => ({
        reports: { ...(prev?.reports ?? {}), [role]: res.report },
        contacts: { ...(prev?.contacts ?? {}), [role]: res.contact },
      }))
      toast.success(t('dutyLateReported', { name: personName || roleLabel }))
    } catch {
      toast.error(t('common:error'))
    }
  }

  // Einsatzliste (Volleymanager nomination list) — coach-only, volleyball only.
  const teamNominationDefault = kscwTeamObj?.features_enabled?.auto_nomination_list === true
  const nominationStatus = (fullGame ?? game).vm_nomination_status ?? null
  const nominationCount = (fullGame ?? game).vm_nomination_count
  const nominationError = (fullGame ?? game).vm_nomination_error
  const nominationPushedAt = (fullGame ?? game).vm_nomination_pushed_at
  const showNomination = kscwSport === 'volleyball' && canEditAsCoach

  async function saveNominationOverride(value: boolean | null) {
    const previous = autoNomination
    setAutoNomination(value) // optimistic — the pills must not lag the tap
    try {
      await updateGame(gameId, { auto_nomination_list: value })
    } catch {
      setAutoNomination(previous)
      toast.error(t('common:error'))
    }
  }

  // Manual retry after a failed push. The endpoint spawns the same worker the T-60
  // cron uses and flips the game back to `pending`, so we refetch to show that.
  async function pushNominationNow() {
    setPushingNomination(true)
    try {
      await kscwApi<{ spawned: boolean }>(`/games/${gameId}/nomination-push`, { method: 'POST' })
      toast.success(t('nominationPushStarted'))
      invalidateForCollection('games')
      const fresh = await fetchItem<Game>('games', gameId, {
        fields: ['*', ...GAME_EXPAND.split(',').map((r) => `${r}.*`)],
      })
      setFullGame(fresh)
    } catch {
      toast.error(t('nominationPushFailed'))
    } finally {
      setPushingNomination(false)
    }
  }

  const lateProps = (role: string) => ({
    role,
    gameDate: game.date,
    gameTime: game.time,
    adminSeesContact,
    canReportLate,
    reported: lateData?.reports?.[role] ?? null,
    revealedContact: lateData?.contacts?.[role] ?? null,
    lateLoading,
    onReport: reportLate,
  })
  const homeWon = Number(game.home_score) > Number(game.away_score)
  const awayWon = Number(game.away_score) > Number(game.home_score)
  const kscwWon = game.type === 'home' ? homeWon : awayWon
  const kscwLost = game.type === 'home' ? awayWon : homeWon
  const scoreColor = kscwWon ? 'text-green-600 dark:text-green-400' : kscwLost ? 'text-red-500 dark:text-red-400' : 'text-gray-900 dark:text-gray-100'

  return (
    <>
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white shadow-xl sm:rounded-2xl dark:bg-gray-800"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — meta on row 1, actions on their own row so the top never
            smushes on mobile (league name + chip + actions used to fight for space). */}
        <div className="border-b dark:border-gray-700 px-6 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {kscwTeam && <TeamChip team={kscwTeam} size="sm" />}
            </div>
            <button
              onClick={onClose}
              aria-label={t('common:close', 'Close')}
              className="-mr-2 flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 sm:-mr-1 sm:min-h-0 sm:min-w-0 sm:p-1 dark:hover:bg-gray-700"
            >
            <X className="h-5 w-5" />
            </button>
          </div>

          {/* Actions row. Share sits outside the status check because a link to a
              played fixture is just as shareable as one to an upcoming game; the
              broadcast/cancel pair keeps its original scheduled-or-cancelled
              gate, and `empty:hidden` no longer fires since share always renders. */}
          <div className="mt-3 flex flex-wrap items-center gap-2 empty:hidden">
            <ShareActivityButton
              kind="game"
              id={game.id}
              title={`${homeLabel} vs ${awayLabel}`}
              iconOnly
            />
            {(game.status === 'scheduled' || game.status === 'cancelled') && (
              <>
              {game.status === 'scheduled' && (
                <BroadcastButton
                  labelAlwaysVisible
                  activity={{
                    type: 'game',
                    id: Number(game.id),
                    title: `${homeLabel} vs ${awayLabel}`,
                    start_date: game.date && game.time ? `${game.date}T${game.time}` : game.date,
                    location: hall?.name ?? undefined,
                    teamName: rawKscwTeam || undefined,
                    sport: kscwSport ?? null,
                    teamId: kscwTeamId ? Number(kscwTeamId) : undefined,
                  }}
                  member={user ? {
                    id: user.id,
                    role: user.role ?? null,
                    isCoachOf: coachTeamIds,
                    isResponsibleOf: teamResponsibleIds,
                  } : null}
                />
              )}
              <CancelActivityButton
                kind="game"
                activityId={game.id}
                isCancelled={game.status === 'cancelled'}
                teamIds={kscwTeamId ? [kscwTeamId] : []}
                variant="inline"
                onDone={onClose}
              />
              </>
            )}
          </div>
        </div>

        {/* Teams & Score */}
        <div className="px-6 py-6">
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1 text-right">
              <p className={`text-base text-gray-900 dark:text-gray-100 ${game.type === 'home' ? 'font-semibold' : ''}`}>
                {homeLabel}
              </p>
            </div>

            <div className="shrink-0 text-center">
              {game.status === 'completed' || game.status === 'live' ? (
                <div className="font-mono text-3xl font-bold">
                  <span className={game.type === 'home' ? scoreColor : 'text-gray-500 dark:text-gray-400'}>{game.home_score}</span>
                  <span className="mx-1 text-gray-400 dark:text-gray-500">:</span>
                  <span className={game.type === 'away' ? scoreColor : 'text-gray-500 dark:text-gray-400'}>{game.away_score}</span>
                </div>
              ) : (
                <div className="text-base font-light text-gray-400 dark:text-gray-500">vs</div>
              )}
            </div>

            <div className="flex-1">
              <p className={`text-base text-gray-900 dark:text-gray-100 ${game.type === 'away' ? 'font-semibold' : ''}`}>
                {awayLabel}
              </p>
            </div>
          </div>

          {/* Sets breakdown */}
          {sets.length > 0 && (
            <div className="mt-4 overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
              <table className="w-full text-center text-sm tabular-nums" style={{ tableLayout: 'fixed' }}>
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-900 text-xs text-gray-500 dark:text-gray-400">
                    <th className="px-3 py-2 w-20 text-left"></th>
                    {sets.map((_, i) => (
                      <th key={i} className="px-3 py-2">
                        {t('set')} {i + 1}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t dark:border-gray-700">
                    <td className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">{t('home')}</td>
                    {sets.map((s, i) => {
                      const kscwWonSet = (s.home > s.away) === (game.type === 'home')
                      return (
                        <td
                          key={i}
                          className={`px-3 py-2 font-bold ${kscwWonSet ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}
                        >
                          {s.home}
                        </td>
                      )
                    })}
                  </tr>
                  <tr className="border-t dark:border-gray-700">
                    <td className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">{t('away')}</td>
                    {sets.map((s, i) => {
                      const kscwWonSet = (s.home > s.away) === (game.type === 'home')
                      return (
                        <td
                          key={i}
                          className={`px-3 py-2 font-bold ${kscwWonSet ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}
                        >
                          {s.away}
                        </td>
                      )
                    })}
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Participation — only for own team's scheduled games */}
        {game.status === 'scheduled' && canParticipate && (
          isGuestIn(kscwTeamId) ? (
            <div className="border-t dark:border-gray-700 px-6 py-3">
              <p className="text-sm text-muted-foreground py-4 text-center">
                {t('games:guestsCannotParticipate')}
              </p>
            </div>
          ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t dark:border-gray-700 px-6 py-3">
            {hasAbsence && (
              <span className="w-full text-xs italic text-gray-500 dark:text-gray-400">{t(absenceLabel)}</span>
            )}
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('participation:attending')}</span>
                <div
                  className={`relative flex gap-2 ${rsvpLoading ? 'pointer-events-none opacity-50' : ''}`}
                  aria-busy={rsvpLoading}
                >
                  <button
                    onClick={() => setStatus('confirmed', noteText)}
                    disabled={rsvpLoading}
                    className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${rsvpButtonClass('confirmed', effectiveStatus === 'confirmed')}`}
                  >
                    {t('participation:yes')}
                  </button>
                  <button
                    onClick={() => setStatus('tentative', noteText)}
                    disabled={rsvpLoading}
                    className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${rsvpButtonClass('tentative', effectiveStatus === 'tentative')}`}
                  >
                    {t('participation:maybe')}
                  </button>
                  <button
                    onClick={() => setStatus('declined', noteText)}
                    disabled={rsvpLoading}
                    className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${rsvpButtonClass('declined', effectiveStatus === 'declined')}`}
                  >
                    {t('participation:no')}
                  </button>
                  {/* Save confirmation popover — colored by response */}
                  {saveConfirmed && (() => {
                    const popoverColor = effectiveStatus === 'declined'
                      ? 'bg-red-600 text-white'
                      : effectiveStatus === 'tentative'
                        ? 'bg-yellow-500 text-black'
                        : 'bg-green-600 text-white'
                    return (
                      <span className={`absolute -top-7 left-1/2 -translate-x-1/2 flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-medium shadow-lg animate-fade-in ${popoverColor}`}>
                        <Check className="h-3 w-3" />
                        {t('participation:saved')}
                      </span>
                    )
                  })()}
                </div>
            </div>
            {/* RSVP tallies on their own full-width row, centred under the buttons */}
            <div className="flex w-full justify-center pt-1">
              <ParticipationSummary activityType="game" activityId={game.id} bars alwaysShow participations={participations} coachMemberIds={teamCoachIds(kscwTeamObj)} />
            </div>
            {/* Participation note */}
            {effectiveStatus && (
              <div className="relative flex w-full items-center gap-2 pt-1">
                <MessageSquare className="h-4 w-4 shrink-0 text-gray-400" />
                <input
                  type="text"
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveNote()
                  }}
                  placeholder={t('participation:notePlaceholder')}
                  className="min-w-0 flex-1 rounded-md border border-gray-200 bg-transparent px-2.5 py-1 text-sm text-gray-700 placeholder:text-gray-400 focus:border-brand-400 focus:outline-none dark:border-gray-600 dark:text-gray-300 dark:placeholder:text-gray-500 dark:focus:border-brand-500"
                />
                <button
                  onClick={saveNote}
                  disabled={noteText === savedNote}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-green-600 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-green-400"
                >
                  <Check className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
          )
        )}

        {/* Show roster — directly beneath the RSVP tallies, visible for any
            scheduled game (also for guests / non-participants, who don't see
            the Attending? block above).

            Gated on `teamsLoading`: `isTeamStaff` below reads coachTeamIds /
            teamResponsibleIds, which start EMPTY and fill from an async
            loadTeamContext. Rendering before they land paints a coach the
            visitor's button set, then swaps the first button's action from the
            RSVP list to the match sheet and inserts two more above the fold —
            so a thumb already on its way down lands on Show IDs. */}
        {game.status === 'scheduled' && !teamsLoading && (
          <div className="border-t dark:border-gray-700 px-6 py-3">
            <Button
              variant="outline"
              onClick={() => (rosterIsMatchSheet ? setRosterOpen(true) : setParticipationListOpen(true))}
              className="w-full"
            >
              {rosterIsMatchSheet ? t('pregameTitle') : t('participationRoster')}
            </Button>

            {/* The RSVP list, for the people whose button above is a match sheet.
                A coach or admin still needs to see who has answered what — an
                assigned scorer does not: it is the other team's internal "who is
                coming", and `useMultiTeamMembers` returns nothing for someone
                with no member_teams row there, so they only ever saw it empty. */}
            {isTeamStaff && (
              <Button
                variant="outline"
                onClick={() => setParticipationListOpen(true)}
                className="mt-2 w-full"
              >
                {t('participationRoster')}
              </Button>
            )}

            {/* Show IDs — coach/TR only, admins deliberately excluded (see canShowIds).
                The documents are end-to-end encrypted: the app decrypts them on this
                device with the coach's own key, and the club cannot read them at all.
                Displayed only in the 45 minutes before kickoff. */}
            {canShowIds && (
              <Button
                variant="outline"
                onClick={() => setIdsOpen(true)}
                className="mt-2 w-full"
              >
                {t('idsTitle')}
              </Button>
            )}
          </div>
        )}

        {/* Game info */}
        <div className="space-y-3 border-t dark:border-gray-700 px-6 py-4">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {t('gameInfo')}
          </h4>
          {game.league && <DetailRow label={t('league')} value={game.league} />}
          <DetailRow label={t('date')} value={dateStr} />
          <DetailRow label={t('kickoff')} value={game.time ? formatTime(game.time) : '–'} />
          {meetingTimeFromOffset(game.time, game.meeting_offset_minutes) && (
            <DetailRow
              label={tc('meetingTime')}
              value={meetingTimeFromOffset(game.time, game.meeting_offset_minutes)}
            />
          )}
          <DetailRow label={t('gameType')} value={game.type === 'home' ? t('typeHome') : t('typeAway')} />
          {game.game_id && <DetailRow label={t('gameNumber')} value={game.game_id.replace(/^(vb_|bb_)/, '')} />}
          {game.season && <DetailRow label={t('season')} value={game.season} />}
        </div>

        {/* Venue */}
        {hall && (
          <div className="space-y-3 border-t dark:border-gray-700 px-6 py-4">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              {t('venue')}
            </h4>
            <DetailRow label={t('hallLabel')} value={hall.name} />
            {hall.address && (() => {
              const mapsUrl = (hall.maps_url && sanitizeUrl(hall.maps_url))
                || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([hall.address, hall.city].filter(Boolean).join(', '))}`
              return (
                <div className="flex items-start gap-3 text-sm">
                  <span className="w-28 shrink-0 text-gray-500 dark:text-gray-400">{t('address')}</span>
                  <a
                    href={mapsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-brand-600 hover:underline dark:text-brand-400"
                  >
                    {[hall.address, hall.city].filter(Boolean).join(', ')} ↗
                  </a>
                </div>
              )
            })()}
          </div>
        )}

        {/* Referees */}
        {game.referees_json && game.referees_json.length > 0 && (
          <div className="space-y-3 border-t dark:border-gray-700 px-6 py-4">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              {t('referees')}
            </h4>
            {game.referees_json.map((ref, i) => (
              <DetailRow key={i} label={t((['referee1st', 'referee2nd', 'referee3rd'] as const)[i] ?? 'referee')} value={ref.name} />
            ))}
          </div>
        )}

        {/* Referee expenses — volleyball home games, staff only (coach/TR/admin) */}
        {kscwSport === 'volleyball' && game.type === 'home' && isTeamStaff && (
          <div className="border-t dark:border-gray-700 px-6 py-4">
            <RefereeExpenseSection
              gameId={game.id}
              teamId={kscwTeamId}
              canEdit={!readOnly && canEditAsCoach}
            />
          </div>
        )}

        {/* Scorer duties — Volleyball */}
        {kscwSport !== 'basketball' &&
        (game.scorer_member || game.scoreboard_member || game.scorer_scoreboard_member || game.referee_member) && (
          <div className="space-y-3 border-t dark:border-gray-700 px-6 py-4">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              {t('scorerDuties')}
            </h4>
            {awaitingExpand ? (
              // One placeholder per duty the game actually has, so the block does not
              // resize much when the real rows replace them.
              Array.from({
                length: (game.scorer_scoreboard_member
                  ? 1
                  : (game.scorer_member ? 1 : 0) + (game.scoreboard_member ? 1 : 0))
                  + (game.referee_member ? 1 : 0),
              }).map((_, i) => <DutyRowSkeleton key={i} />)
            ) : asObj<Member & BaseRecord>(expanded.scorer_scoreboard_member) ? (
              <DutyPersonRow
                label={t('scorerTaefeler')}
                member={asObj<Member & BaseRecord>(expanded.scorer_scoreboard_member)}
                dutyTeam={asObj<Team & BaseRecord>(expanded.scorer_scoreboard_duty_team)}
                {...lateProps('scorer_scoreboard')}
              />
            ) : (
              <>
                {asObj<Member & BaseRecord>(expanded.scorer_member) && (
                  <DutyPersonRow
                    label={t('scorer')}
                    member={asObj<Member & BaseRecord>(expanded.scorer_member)}
                    dutyTeam={asObj<Team & BaseRecord>(expanded.scorer_duty_team)}
                    {...lateProps('scorer')}
                  />
                )}
                {asObj<Member & BaseRecord>(expanded.scoreboard_member) && (
                  <DutyPersonRow
                    label={t('scoreboard')}
                    member={asObj<Member & BaseRecord>(expanded.scoreboard_member)}
                    dutyTeam={asObj<Team & BaseRecord>(expanded.scoreboard_duty_team)}
                    {...lateProps('scoreboard')}
                  />
                )}
              </>
            )}
            {!awaitingExpand && asObj<Member & BaseRecord>(expanded.referee_member) && (
              <DutyPersonRow
                label={t('referee')}
                member={asObj<Member & BaseRecord>(expanded.referee_member)}
                dutyTeam={asObj<Team & BaseRecord>(expanded.referee_duty_team)}
                {...lateProps('referee')}
              />
            )}
          </div>
        )}

        {/* Scorer duties — Basketball */}
        {kscwSport === 'basketball' &&
        (game.bb_scorer_member || game.bb_timekeeper_member || game.bb_24s_official || game.bb_duty_team || game.bb_scorer_duty_team || game.bb_timekeeper_duty_team || game.bb_24s_duty_team) && (
          <div className="space-y-3 border-t dark:border-gray-700 px-6 py-4">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              {t('officialsDuties')}
            </h4>
            {(asObj<Member & BaseRecord>(expanded.bb_scorer_member) || game.bb_scorer_member) && (
              <DutyPersonRow
                label={t('bbScorer', { ns: 'scorer' })}
                member={asObj<Member & BaseRecord>(expanded.bb_scorer_member)}
                dutyTeam={asObj<Team & BaseRecord>(expanded.bb_scorer_duty_team) ?? asObj<Team & BaseRecord>(expanded.bb_duty_team)}
                {...lateProps('bb_scorer')}
              />
            )}
            {(asObj<Member & BaseRecord>(expanded.bb_timekeeper_member) || game.bb_timekeeper_member) && (
              <DutyPersonRow
                label={t('bbTimekeeper', { ns: 'scorer' })}
                member={asObj<Member & BaseRecord>(expanded.bb_timekeeper_member)}
                dutyTeam={asObj<Team & BaseRecord>(expanded.bb_timekeeper_duty_team) ?? asObj<Team & BaseRecord>(expanded.bb_duty_team)}
                {...lateProps('bb_timekeeper')}
              />
            )}
            {(asObj<Member & BaseRecord>(expanded.bb_24s_official) || game.bb_24s_official) && (
              <DutyPersonRow
                label={t('bb24sOfficial')}
                member={asObj<Member & BaseRecord>(expanded.bb_24s_official)}
                dutyTeam={asObj<Team & BaseRecord>(expanded.bb_24s_duty_team) ?? asObj<Team & BaseRecord>(expanded.bb_duty_team)}
                {...lateProps('bb_24s_official')}
              />
            )}
          </div>
        )}

        {/* Einsatzliste — volleyball only (no Volleymanager for basketball), coach only.
            The override drives the T-60 auto-push; the box below is the push journal. */}
        {showNomination && (
          <div className="space-y-3 border-t dark:border-gray-700 px-6 py-4">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              {t('nominationStatusLabel')}
            </h4>

            {game.status === 'scheduled' && !readOnly && (
              <div className="space-y-1.5">
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('autoNomination')}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t('autoNominationHint', {
                    def: teamNominationDefault ? t('autoNominationOn') : t('autoNominationOff'),
                  })}
                </p>
                <div className="flex flex-wrap gap-2 pt-0.5">
                  {([
                    { value: null, label: t('autoNominationUseTeamDefault') },
                    { value: true, label: t('autoNominationOn') },
                    { value: false, label: t('autoNominationOff') },
                  ] as { value: boolean | null; label: string }[]).map((opt) => {
                    const active = autoNomination === opt.value
                    return (
                      <button
                        key={String(opt.value)}
                        type="button"
                        onClick={() => saveNominationOverride(opt.value)}
                        className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                          active
                            ? 'border-brand-500 bg-brand-100 text-brand-700 dark:border-brand-600 dark:bg-brand-900/30 dark:text-brand-300'
                            : 'border-gray-300 bg-transparent text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800'
                        }`}
                      >
                        {opt.label}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Push journal — read-only. `filled` is a warning, not an error. */}
            {nominationStatus && (
              <div className={`space-y-1.5 rounded-md border p-3 text-sm ${NOMINATION_STATUS_TONE[nominationStatus]}`}>
                <p className="flex items-start gap-2">
                  {nominationStatus === 'filled' && <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
                  <span>{t(NOMINATION_STATUS_KEY[nominationStatus])}</span>
                </p>
                {(typeof nominationCount === 'number' || nominationPushedAt) && (
                  <p className="text-xs opacity-80">
                    {[
                      typeof nominationCount === 'number' ? t('nominationCount', { n: nominationCount }) : '',
                      nominationPushedAt
                        ? t('nominationPushedAt', { when: formatDateTimeCompactZurich(nominationPushedAt) })
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                )}
                {nominationError && (
                  <p className="text-xs break-words opacity-90">
                    {t('nominationError', { error: nominationError })}
                  </p>
                )}
                {nominationStatus === 'failed' && !readOnly && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pushingNomination}
                    onClick={pushNominationNow}
                    className="mt-1"
                  >
                    {t('nominationPushNow')}
                  </Button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Participation details (respond-by deadline — coach only). The roster
            button moved up beneath the RSVP tallies; this section now renders
            only when it has content (a deadline to show, or a coach who can
            set one) so it never leaves an empty bordered strip. */}
        {game.status === 'scheduled' && (game.respond_by || (!readOnly && canEditAsCoach)) && (
          <div className="space-y-3 border-t dark:border-gray-700 px-6 py-4">
            {/* Besammlung (migration 340). Stored as minutes before kickoff, so
                it stays right when Swiss Volley moves the fixture — the coach
                picks the gap once and never revisits it after a reschedule. */}
            {!readOnly && canEditAsCoach && (
              <MeetingTimeSelect
                value={game.meeting_offset_minutes ?? null}
                onChange={(v) => { void updateGame(game.id, { meeting_offset_minutes: v }) }}
                startClock={game.time}
              />
            )}
            {game.respond_by && !editingDeadline && (
              <DetailRow label={t('respondBy')} value={`${formatDate(game.respond_by)}${(() => { const p = parseRespondByTime(game.respond_by, game.time); return p?.time ? `, ${p.time}` : '' })()}`} />
            )}
            {!readOnly && canEditAsCoach && (
              editingDeadline ? (
                <div className="flex items-center gap-2">
                  <DatePicker
                    value={deadlineValue}
                    onChange={setDeadlineValue}
                    max={game.date?.split(' ')[0]}
                  />
                  <input
                    type="time"
                    value={deadlineTime || game?.time?.slice(0, 5) || ''}
                    onChange={(e) => setDeadlineTime(e.target.value)}
                    className="w-24 rounded-lg border px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                  />
                  <Button
                    size="sm"
                    onClick={async () => {
                      await updateGame(game.id, { respond_by: deadlineValue ? toUtcIsoFromDatetimeLocal(`${deadlineValue}T${deadlineTime || game?.time?.slice(0, 5) || '23:59'}`) : null })
                      setEditingDeadline(false)
                    }}
                  >
                    OK
                  </Button>
                  <button
                    onClick={() => setEditingDeadline(false)}
                    className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => {
                    const parsed = parseRespondByTime(game.respond_by, game.time)
                    setDeadlineValue(parsed?.date ?? '')
                    setDeadlineTime(parsed?.time ?? '')
                    setEditingDeadline(true)
                  }}
                  className="text-xs text-brand-600 hover:underline dark:text-brand-400"
                >
                  {t('setDeadline')}
                </button>
              )
            )}
          </div>
        )}

        {/* Players borrowed for this one fixture (migration 271). Rendered for
            everyone when the game has guests — an unfamiliar name in the roster
            needs an explanation — but only the game's own coach/TR can change it. */}
        {kscwTeamId && game.status === 'scheduled' && (
          <GameGuestSection
            game={game}
            kscwTeamId={kscwTeamId}
            canEdit={!readOnly && (adminSeesContact || coachTeamIds.includes(kscwTeamId) || teamResponsibleIds.includes(kscwTeamId))}
          />
        )}
      </div>
    </div>
    {idsOpen && (
      <ShowIdsModal
        key={`ids-${game.id}`}
        gameId={game.id}
        kickoffMs={gameKickoffMs(game.date, game.time)}
        onClose={() => setIdsOpen(false)}
      />
    )}
    {isAssignedScorer ? (
      rosterOpen && <RosterModal key={game.id} gameId={game.id} onClose={() => setRosterOpen(false)} />
    ) : isTeamStaff ? (
      // Coach / TR / admin of the playing team: the match sheet, laid out the way it is
      // filled and editable per game (number, captain, libero — none of which exist on
      // the Einsatzliste — plus an emergency add/drop that does NOT reach Volleymanager).
      rosterOpen && (
        <PreGameRosterModal key={game.id} gameId={game.id} onClose={() => setRosterOpen(false)} />
      )
    ) : null}
    {/* Always mounted, never behind the match-sheet branch: every one of its queries
        is gated on `open`, so a closed instance costs nothing. */}
    <ParticipationRosterModal
      open={participationListOpen}
      onClose={() => setParticipationListOpen(false)}
      activityType="game"
      activityId={game?.id ?? ''}
      activityDate={game?.date ?? ''}
      teamIds={kscwTeamId ? [kscwTeamId] : []}
      title={t('participationRoster')}
      activityKind={game ? `${homeLabel ?? ''} vs ${awayLabel ?? ''}`.trim() : undefined}
      respondBy={game?.respond_by}
      activityStartTime={game?.time}
      showRsvpTime={isFeatureEnabled(kscwTeamObj?.features_enabled, 'show_rsvp_time')}
    />
    </>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-3 text-sm">
      <span className="w-28 shrink-0 text-gray-500 dark:text-gray-400">{label}</span>
      <span className="text-gray-900 dark:text-gray-100">{value}</span>
    </div>
  )
}

function DutyPersonRow({
  label, member, dutyTeam, role, gameDate, gameTime,
  adminSeesContact, canReportLate, reported, revealedContact, lateLoading, onReport,
}: {
  label: string
  member?: (Member & BaseRecord) | null
  dutyTeam?: (Team & BaseRecord) | null
  role: string
  gameDate?: string
  gameTime?: string
  adminSeesContact: boolean
  canReportLate: boolean
  reported: DutyLateReport | null
  revealedContact: DutyLateContact | null
  /** True while GET /games/:id/duty-late is still in flight — `reported: null` is not yet an answer. */
  lateLoading: boolean
  onReport: (role: string, roleLabel: string, personName: string) => void
}) {
  const { t } = useTranslation('games')
  const name = member ? memberDisplayName(member) : ''
  const teamName = dutyTeam?.name
  const inWindow = isWithinDutyLateWindow(gameDate, gameTime, role)

  // Contact source: admins read it straight off the expanded member (items API);
  // coaches/TRs only after they've flagged the official late (endpoint payload).
  const contact: DutyLateContact | null = adminSeesContact
    ? (member ? { phone: member.phone ?? null, email: member.email ?? null, hide_phone: !!member.hide_phone, hide_email: !!member.hide_email } : null)
    : (reported ? revealedContact : null)
  const showPhone = !!(contact && !contact.hide_phone && contact.phone)
  const showEmail = !!(contact && !contact.hide_email && contact.email)

  // Coaches/TRs (not admins, who already see contact) get the alarm while inside
  // the role window and it hasn't been flagged yet. `!lateLoading` is what makes
  // "not flagged" an answer rather than a default: without it the alarm painted
  // over an already-reported duty, and swapped for the banner + tel:/mailto:
  // links under a thumb that was already on its way down.
  const alarmSlotApplies = canReportLate && !adminSeesContact && inWindow && !!member
  const showAlarm = alarmSlotApplies && !lateLoading && !reported

  const reportedTime = reported?.at
    ? new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(reported.at))
    : ''

  return (
    <div className="flex items-start gap-3 text-sm">
      <span className="w-28 shrink-0 text-gray-500 dark:text-gray-400">{label}</span>
      <div className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-gray-900 dark:text-gray-100">
          {name}
          {teamName && <TeamChip team={teamName} size="xs" />}
        </span>

        {alarmSlotApplies && lateLoading && (
          // Same height/rounding as the button below, so nothing jumps when the
          // real answer (alarm, or banner + contacts) replaces it. Neutral on
          // purpose — a red placeholder would still read as "not reported".
          <div className="mt-1.5 h-10 w-full animate-pulse rounded-lg bg-gray-200 dark:bg-gray-700" aria-hidden="true" />
        )}

        {showAlarm && (
          <button
            type="button"
            onClick={() => onReport(role, label, name)}
            className="mt-1.5 flex w-full items-center justify-center gap-2 rounded-lg bg-red-600 px-3 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 dark:bg-red-600 dark:hover:bg-red-500"
          >
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {t('dutyLateButton', { role: label })}
          </button>
        )}

        {!adminSeesContact && reported && (
          <div className="mt-1.5 rounded-lg border border-red-300 bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
            {t('dutyLateBanner', { time: reportedTime, name: reported.by_name })}
          </div>
        )}

        {(showPhone || showEmail) && (
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-gray-500 dark:text-gray-400">
            {showPhone && (
              <a href={`tel:${contact!.phone}`} className="font-medium hover:text-brand-600 dark:hover:text-brand-400">{contact!.phone}</a>
            )}
            {showEmail && (
              <a href={`mailto:${contact!.email}`} className="font-medium hover:text-brand-600 dark:hover:text-brand-400">{contact!.email}</a>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
