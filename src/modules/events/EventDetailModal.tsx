import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '@/components/Modal'
import StatusBadge from '../../components/StatusBadge'
import { trimBBTeamName } from '../../utils/teamColors'
import RichText from '../../components/RichText'
import ParticipationSummary from '../../components/ParticipationSummary'
import { rsvpButtonClass } from '../../utils/participationColors'
import ParticipationRosterModal from '../../components/ParticipationRosterModal'
import SessionParticipationSheet from '../../components/SessionParticipationSheet'
import { useAuth } from '../../hooks/useAuth'
import { useAdminMode } from '../../hooks/useAdminMode'
import { useTeamPermissions } from '../../hooks/useTeamPermissions'
import { useParticipation } from '../../hooks/useParticipation'
import { useMyCoveringAbsence } from '../../hooks/useMyCoveringAbsence'
import { useAbsenceNoteText } from '../../hooks/useAbsenceNoteText'
import { useCollection } from '../../lib/query'
import { kscwApi } from '../../lib/api'
import { useMutation } from '../../hooks/useMutation'
import { useConfirm } from '../../components/ConfirmProvider'
import { formatDate, formatTime } from '../../utils/dateHelpers'
import BroadcastButton from '../broadcast/BroadcastButton'
import ShareActivityButton from '../../components/ShareActivityButton'
import { isFeatureEnabled } from '../../utils/featureToggles'
import { Calendar, Clock, MapPin, Users, Check, MessageSquare, UserPlus, Share2, ClipboardList, Link2, AlarmClock } from 'lucide-react'
import { toast } from 'sonner'
import EventSignupsModal from './EventSignupsModal'
import { teamCoachIds } from '../../utils/relations'
import { asTeams, teamId, isHtml, isSameDay, isGuestExcludedFromEvent, ALL_GUEST_LEVELS } from './eventHelpers'
import type { Event, EventSession, Participation, VolleyPosition } from '../../types'
import CancelActivityButton from '../../components/CancelActivityButton'

const VOLLEY_POSITIONS: VolleyPosition[] = ['Setter', 'Outside', 'Middle', 'Opposite', 'Libero', 'Universal']

interface EventDetailModalProps {
  event: Event | null
  onClose: () => void
  /**
   * Every participation row the opening surface already fetched for this event.
   * Passing it means the modal opens with the counters AND the viewer's own
   * Yes/Maybe/No selection already painted, instead of firing two queries on
   * open and settling a round-trip later.
   */
  participations?: Participation[]
}

export default function EventDetailModal({ event, onClose, participations }: EventDetailModalProps) {
  const { t } = useTranslation('events')
  const { t: tP } = useTranslation('participation')
  const { t: tc } = useTranslation('common')
  const { user, canParticipateIn, isStaffOnlyForTeams, coachTeamIds, teamResponsibleIds, memberTeamIds, getGuestLevel } = useAuth()
  const { canManageTeam } = useTeamPermissions()
  const { effectiveIsAdmin } = useAdminMode()
  const [rosterOpen, setRosterOpen] = useState(false)
  const [signupsOpen, setSignupsOpen] = useState(false)
  const [sessionSheetOpen, setSessionSheetOpen] = useState(false)

  // ── Public signup link (migration 310) ────────────────────────────
  const confirm = useConfirm()
  const [shareToken, setShareToken] = useState<string | null>(event?.public_share_token ?? null)
  const [shareBusy, setShareBusy] = useState(false)
  // Re-seed when the modal is pointed at a different event, without a
  // render-phase write of fetched data (React #301).
  const [shareForEvent, setShareForEvent] = useState(event?.id)
  if (shareForEvent !== event?.id) {
    setShareForEvent(event?.id)
    setShareToken(event?.public_share_token ?? null)
  }
  // Mirrors the endpoint's own rule: admin, sport admin, or the event's creator.
  // The server enforces it; this only decides whether to render the controls.
  const canManageShare = !!event && (effectiveIsAdmin
    || (!!user && event.created_by != null && String(event.created_by) === String(user.id)))
  const publicSignupUrl = shareToken ? `${window.location.origin}/e/${shareToken}` : ''

  async function mintShareToken(rotating: boolean) {
    if (!event) return
    if (rotating && !(await confirm({ message: t('shareTokenRotateConfirm'), danger: true }))) return
    setShareBusy(true)
    try {
      const res = await kscwApi<{ public_share_token: string }>(
        `/events/${event.id}/share-token`, { method: 'POST' },
      )
      setShareToken(res.public_share_token)
      toast.success(t('shareTokenCreated'))
    } catch {
      toast.error(t('publicSignupError'))
    } finally {
      setShareBusy(false)
    }
  }

  async function revokeShareToken() {
    if (!event) return
    if (!(await confirm({ message: t('shareTokenRevokeConfirm'), danger: true }))) return
    setShareBusy(true)
    try {
      await kscwApi(`/events/${event.id}/share-token`, { method: 'DELETE' })
      setShareToken(null)
      toast.success(t('shareTokenRevoked'))
    } catch {
      toast.error(t('publicSignupError'))
    } finally {
      setShareBusy(false)
    }
  }

  // Migration 324: `invite_guests: false` drops the invited teams' guest players
  // from the audience. They keep READ access (the policy is untouched) — the
  // RSVP block is what changes, mirroring a training's excluded guest tier.
  const guestExcluded = !!event && isGuestExcludedFromEvent(event, { memberId: user?.id, memberTeamIds, getGuestLevel })
  const canParticipate = !!user && !!event && !guestExcluded && (
    !event.teams?.length || event.teams.some((tid) => canParticipateIn(teamId(tid)))
  )
  // Both questions span EVERY invited team — asking only `teams[0]` mislabels a
  // coach of the second team as a plain player (their RSVP then counts in the
  // player tally instead of the Staff section).
  const eventTeamIds = (event?.teams ?? []).map((tid) => teamId(tid))
  const isStaff = eventTeamIds.some((id) => canManageTeam(id))
  const isStaffParticipant = isStaffOnlyForTeams(eventTeamIds)

  // Fetch sessions for multi-session events
  const hasSessionMode = event?.participation_mode && event.participation_mode !== 'whole'
  const { data: sessionsRaw } = useCollection<EventSession>('event_sessions', {
    filter: event ? { event: { _eq: event.id } } : undefined,
    sort: ['sort_order', 'date', 'start_time'],
    limit: 100,
    enabled: !!user && !!event && !!hasSessionMode,
  })
  const sessions = sessionsRaw ?? []

  if (!event) return null

  const teams = asTeams(event.teams)

  const headerBroadcast = (
    <div className="flex items-center gap-2">
      {/* Members' door. Distinct from the `signup_url` block further down, which
          is the guests' door — see ShareActivityButton for why they must not be
          collapsed into one link. */}
      <ShareActivityButton kind="event" id={event.id} title={event.title} iconOnly />
      <CancelActivityButton
        kind="event"
        activityId={event.id}
        isCancelled={!!event.cancelled}
        teamIds={teams.map((tm) => String(tm.id))}
        variant="inline"
        onDone={onClose}
      />
      {user ? (
        <BroadcastButton
          activity={{
            type: 'event',
            id: Number(event.id),
            title: event.title,
            start_date: event.start_date,
            location: event.location,
            sport: null,
          }}
          member={{
            id: user.id,
            role: user.role ?? null,
            isCoachOf: coachTeamIds,
            isResponsibleOf: teamResponsibleIds,
          }}
        />
      ) : null}
    </div>
  )

  return (
    <>
      <Modal open={!!event} onClose={onClose} title={event.title} size="md" headerAction={headerBroadcast} disableAutoFocus>
        <div className="space-y-4">
          {/* Type badge and teams are two different kinds of fact, so they get
              two rows. Sharing one wrapping row let a 12-team event push the
              type chip and the team chips into one undifferentiated cloud. */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={event.event_type} />
              {event.cancelled && (
                <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700 dark:bg-red-900/30 dark:text-red-400">
                  {t('cancelled')}
                </span>
              )}
            </div>
            {teams.length > 0 && (
              // A plain comma list rather than chips: a club-wide event can
              // invite a dozen teams, and that many coloured pills read as a
              // block of noise rather than "who is invited". `trimBBTeamName`
              // is the same shortener TeamChip applies, so the names match the
              // chips used elsewhere (Herren 3 → H3, BB- prefix dropped).
              <p className="text-sm text-gray-700 dark:text-gray-300">
                <span className="font-medium text-gray-500 dark:text-gray-400">{t('teamsLabel')}</span>{' '}
                {teams.map((tm) => trimBBTeamName(tm.name)).join(', ')}
              </p>
            )}
          </div>

          {event.cancelled && event.cancel_reason && (
            <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400">
              {event.cancel_reason}
            </p>
          )}

          {/* Details */}
          <div className="space-y-2 text-sm text-gray-700 dark:text-gray-300">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" />
              <span>
                {formatDate(event.start_date)}
                {!isSameDay(event.start_date, event.end_date) && ` — ${formatDate(event.end_date)}`}
                {event.all_day && ` · ${t('allDay')}`}
              </span>
            </div>
            {!event.all_day && event.start_date && (
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" />
                <span>
                  {formatTime(event.start_date)}
                  {event.end_date && ` – ${formatTime(event.end_date)}`}
                </span>
              </div>
            )}
            {event.meeting_time && (
              <div className="flex items-center gap-2">
                <AlarmClock className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" />
                <span>{tc('meetingTime')}: {formatTime(event.meeting_time)}</span>
              </div>
            )}
            {event.location && (
              <div className="flex items-center gap-2">
                <MapPin className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" />
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.location)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand-600 hover:underline dark:text-brand-400"
                  onClick={(e) => e.stopPropagation()}
                >
                  {event.location} ↗
                </a>
              </div>
            )}
          </div>

          {/* Description */}
          {event.description && (
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {isHtml(event.description)
                ? <RichText html={event.description} />
                : <p>{event.description}</p>
              }
            </div>
          )}

          {/* Public signup link — deliberately a SHARE affordance, not a signup
              CTA. It exists so members can invite non-members (who have no
              account and so cannot RSVP). A member who followed it instead of
              using the RSVP buttons below would leave no participation row, and
              the event's own count and roster would silently under-report. */}
          {event.signup_url && (
            <div className="mt-3 flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-2 text-sm">
                <Share2 className="mt-0.5 h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" />
                <div>
                  <span className="font-medium">{t('signupLinkTitle')}</span>
                  <p className="text-xs text-muted-foreground">{t('signupLinkHint')}</p>
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  className="min-h-[44px] rounded-md border border-border px-3 text-sm hover:bg-accent"
                  onClick={(e) => {
                    e.stopPropagation()
                    navigator.clipboard.writeText(event.signup_url!)
                    toast.success(tc('copied'))
                  }}
                >
                  {t('signupLinkCopy')}
                </button>
                <a
                  href={event.signup_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="flex min-h-[44px] items-center rounded-md border border-border px-3 text-sm hover:bg-accent"
                >
                  {t('signupLinkOpen')} ↗
                </a>
              </div>
            </div>
          )}

          {/* Native public signup link (migration 310) — the guests' door.
              Managers only: minting it publishes a URL that reaches outside the
              club. Distinct from the members' share button in the header, and
              from `signup_url` above (the OpnForm door). */}
          {canManageShare && (
            <div className="mt-3 rounded-lg border border-border p-3">
              <div className="flex items-start gap-2 text-sm">
                <Link2 className="mt-0.5 h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" />
                <div className="min-w-0">
                  <span className="font-medium">{t('shareTokenTitle')}</span>
                  <p className="text-xs text-muted-foreground">{t('shareTokenHint')}</p>
                </div>
              </div>

              {shareToken ? (
                <>
                  <p className="mt-2 truncate rounded bg-muted px-2 py-1 font-mono text-xs" title={publicSignupUrl}>
                    {publicSignupUrl}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="min-h-[44px] rounded-md border border-border px-3 text-sm hover:bg-accent"
                      onClick={() => { navigator.clipboard.writeText(publicSignupUrl); toast.success(tc('copied')) }}
                    >
                      {t('signupLinkCopy')}
                    </button>
                    <button
                      type="button"
                      className="min-h-[44px] rounded-md border border-border px-3 text-sm hover:bg-accent disabled:opacity-50"
                      disabled={shareBusy}
                      onClick={() => void mintShareToken(true)}
                    >
                      {t('shareTokenRotate')}
                    </button>
                    <button
                      type="button"
                      className="min-h-[44px] rounded-md border border-border px-3 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-900/20"
                      disabled={shareBusy}
                      onClick={() => void revokeShareToken()}
                    >
                      {t('shareTokenRevoke')}
                    </button>
                  </div>
                </>
              ) : (
                <button
                  type="button"
                  className="mt-2 min-h-[44px] rounded-md border border-border px-3 text-sm hover:bg-accent disabled:opacity-50"
                  disabled={shareBusy}
                  onClick={() => void mintShareToken(false)}
                >
                  {t('shareTokenCreate')}
                </button>
              )}
            </div>
          )}

          {/* Targeting indicators */}
          {((event.invited_roles ?? []).length > 0 || (event.invited_members ?? []).length > 0) && (
            <div className="mt-3 space-y-2">
              {(event.invited_roles ?? []).length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground">{t('invitedRoles', { ns: 'invitations' })}</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {event.invited_roles!.map(role => (
                      <span key={role} className="rounded-full bg-purple-100 px-2 py-0.5 text-xs text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
                        {t(`role_${role}`, { ns: 'invitations' })}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Participation section */}
          {!event.cancelled && (
          <div className="space-y-3 border-t border-gray-200 pt-3 dark:border-gray-700">
            {/* Multi-session button + note */}
            {guestExcluded ? (
              <p className="text-sm italic text-gray-500 dark:text-gray-400">{t('guestNotInvited')}</p>
            ) : hasSessionMode && sessions.length > 0 ? (
              <>
                <button
                  onClick={() => setSessionSheetOpen(true)}
                  className="inline-flex min-h-[44px] items-center gap-1 rounded-full bg-brand-100 px-2.5 py-1 text-xs font-medium text-brand-700 hover:bg-brand-200 dark:bg-brand-900/30 dark:text-brand-400 dark:hover:bg-brand-900/50 sm:min-h-0"
                >
                  {t('sessionParticipation')}
                </button>
                {sessionSheetOpen && (
                  <SessionParticipationSheet
                    activityId={event.id}
                    sessions={sessions}
                    isStaff={isStaffParticipant}
                    onClose={() => setSessionSheetOpen(false)}
                  />
                )}
                {canParticipate && (
                  <EventSessionNote eventId={event.id} sessions={sessions} />
                )}
              </>
            ) : canParticipate ? (
              <EventParticipation event={event} isStaff={isStaff} isStaffParticipant={isStaffParticipant} participations={participations} />
            ) : null}

            {/* Summary + roster button */}
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <ParticipationSummary activityType="event" activityId={event.id} bars coachMemberIds={teams.flatMap(t => teamCoachIds(t))} participations={participations} />
              </div>
              <button
                onClick={() => setRosterOpen(true)}
                aria-label={tP('participation')}
                title={tP('participation')}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-brand-600 hover:bg-brand-50 dark:text-brand-400 dark:hover:bg-brand-900/20"
              >
                <Users className="h-5 w-5" />
              </button>
              {/* Admin-only: the merged view, which is the only place the guest
                  (OpnForm) half of the signups is visible at all. */}
              {effectiveIsAdmin && (
                <button
                  onClick={() => setSignupsOpen(true)}
                  aria-label={t('signupsTitle')}
                  title={t('signupsTitle')}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-brand-600 hover:bg-brand-50 dark:text-brand-400 dark:hover:bg-brand-900/20"
                >
                  <ClipboardList className="h-5 w-5" />
                </button>
              )}
            </div>
          </div>
          )}
        </div>
      </Modal>

      <ParticipationRosterModal
        open={rosterOpen}
        onClose={() => setRosterOpen(false)}
        activityType="event"
        activityId={event.id}
        activityDate={event.start_date}
        teamIds={(event.teams ?? []).map(t => teamId(t))}
        title={`${event.title} — ${formatDate(event.start_date)}`}
        respondBy={event.respond_by}
        maxPlayers={event.max_players}
        participationMode={event.participation_mode}
        eventSessions={hasSessionMode ? sessions : undefined}
        showRsvpTime={asTeams(event.teams).some(t => isFeatureEnabled(t.features_enabled, 'show_rsvp_time'))}
        allowMaybe={event.allow_maybe !== false}
        excludedGuestLevels={event.invite_guests === false ? ALL_GUEST_LEVELS : undefined}
        invitedRoles={event.invited_roles}
      />

      <EventSignupsModal
        open={signupsOpen}
        onClose={() => setSignupsOpen(false)}
        event={event}
      />
    </>
  )
}

function EventParticipation({ event, isStaff, isStaffParticipant, participations }: { event: Event; isStaff: boolean; isStaffParticipant: boolean; participations?: Participation[] }) {
  const { t } = useTranslation('participation')
  const { participation, effectiveStatus, hasAbsence, note: savedNote, setStatus, saveConfirmed, dismissConfirmed, isLoading: rsvpLoading } = useParticipation(
    'event',
    event.id,
    event.start_date?.split('T')[0],
    undefined,
    isStaffParticipant,
    participations,
  )
  const { absence } = useMyCoveringAbsence('event', event.start_date)
  const absenceLabel = absence?.type === 'weekly' ? 'declinedUnavailable' : 'absent'
  const absenceNoteText = useAbsenceNoteText(absence)
  const [noteText, setNoteText] = useState(savedNote)
  const [noteSaved, setNoteSaved] = useState(false)
  // Previously-synced note value. Held in state (not a ref) so the compare +
  // re-sync below is a plain adjust-state-during-render, not a render-phase ref
  // write. Seeded with `savedNote` — exactly what `useRef(savedNote)` held.
  const [prevNoteSync, setPrevNoteSync] = useState(savedNote)
  const serverGuestCount = participation?.guest_count ?? 0
  const [guestCount, setGuestCount] = useState(serverGuestCount)
  const [prevServerGuestCount, setPrevServerGuestCount] = useState(serverGuestCount)
  const [noteRequiredError, setNoteRequiredError] = useState(false)
  const [positionsRequiredError, setPositionsRequiredError] = useState(false)
  const requireNote = !!event.require_note_if_absent
  const allowMaybe = event.allow_maybe !== false
  const showPositions = isFeatureEnabled(event.features_enabled, 'position_preferences')
  const serverPos1: VolleyPosition | '' = participation?.position_1 || ''
  const serverPos2: VolleyPosition | '' = participation?.position_2 || ''
  const serverPos3: VolleyPosition | '' = participation?.position_3 || ''
  const [pos1, setPos1] = useState<VolleyPosition | ''>(serverPos1)
  const [pos2, setPos2] = useState<VolleyPosition | ''>(serverPos2)
  const [pos3, setPos3] = useState<VolleyPosition | ''>(serverPos3)
  const serverPosKey = `${serverPos1}|${serverPos2}|${serverPos3}`
  const [prevServerPosKey, setPrevServerPosKey] = useState(serverPosKey)

  // Sync position picks from the existing participation whenever the server
  // values change (they load async). Reset-on-value-change → done during render
  // (React's adjust-state-during-render pattern), same trigger as the effect.
  if (prevServerPosKey !== serverPosKey) {
    setPrevServerPosKey(serverPosKey)
    setPos1(serverPos1)
    setPos2(serverPos2)
    setPos3(serverPos3)
  }

  // Sync guest count from existing participation
  if (prevServerGuestCount !== serverGuestCount) {
    setPrevServerGuestCount(serverGuestCount)
    setGuestCount(serverGuestCount)
  }

  const effectiveSync = savedNote || absenceNoteText
  if (effectiveSync !== prevNoteSync) {
    setPrevNoteSync(effectiveSync)
    setNoteText(effectiveSync)
  }

  useEffect(() => {
    if (!saveConfirmed) return
    const timer = setTimeout(dismissConfirmed, 2000)
    return () => clearTimeout(timer)
  }, [saveConfirmed, dismissConfirmed])

  useEffect(() => {
    if (!noteSaved) return
    const timer = setTimeout(() => setNoteSaved(false), 2000)
    return () => clearTimeout(timer)
  }, [noteSaved])

  const positionsPayload = showPositions ? { position_1: pos1 || null, position_2: pos2 || null, position_3: pos3 || null } : undefined

  const saveNote = () => {
    if (noteText !== savedNote && effectiveStatus) {
      setStatus(effectiveStatus as 'confirmed' | 'tentative' | 'declined', noteText, guestCount, positionsPayload)
      setNoteSaved(true)
    }
  }

  async function handleGuestChange(delta: number) {
    const newCount = Math.max(0, guestCount + delta)
    setGuestCount(newCount)
    if (effectiveStatus) {
      await setStatus(effectiveStatus as 'confirmed' | 'tentative' | 'declined', noteText, newCount, positionsPayload)
    }
  }

  async function savePositions(p1: VolleyPosition | '', p2: VolleyPosition | '', p3: VolleyPosition | '') {
    if (p1 && p2 && p3) setPositionsRequiredError(false)
    if (effectiveStatus) {
      await setStatus(
        effectiveStatus as 'confirmed' | 'tentative' | 'declined',
        noteText,
        guestCount,
        { position_1: p1 || null, position_2: p2 || null, position_3: p3 || null },
      )
    }
  }

  return (
    <div className="space-y-2">
      {hasAbsence && (
        <p className="text-xs italic text-gray-500 dark:text-gray-400">{t(absenceLabel)}</p>
      )}
      <div className="relative flex items-center gap-2">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('yourStatus')}:</span>
        <div className="flex items-center gap-1.5">
          {(['confirmed', 'tentative', 'declined'] as const)
            .filter((s) => s !== 'tentative' || allowMaybe)
            .map((status) => {
            const labels = { confirmed: t('yes'), tentative: t('maybe'), declined: t('no') }
            return (
              <button
                key={status}
                onClick={() => {
                  if (requireNote && (status === 'declined' || status === 'tentative') && !noteText.trim()) {
                    setNoteRequiredError(true)
                    return
                  }
                  if (showPositions && status === 'confirmed' && (!pos1 || !pos2 || !pos3)) {
                    setPositionsRequiredError(true)
                    return
                  }
                  setNoteRequiredError(false)
                  setPositionsRequiredError(false)
                  setStatus(status, noteText, guestCount, showPositions ? { position_1: pos1 || null, position_2: pos2 || null, position_3: pos3 || null } : undefined)
                }}
                disabled={rsvpLoading}
                className={`rounded-full px-3 py-1 text-sm font-medium transition ${rsvpLoading ? 'opacity-50' : ''} ${rsvpButtonClass(status, effectiveStatus === status)}`}
              >
                {labels[status]}
              </button>
            )
          })}
        </div>
        {saveConfirmed && (
          <span className="absolute -top-7 left-1/2 -translate-x-1/2 flex items-center gap-1 whitespace-nowrap rounded-md bg-green-600 px-2 py-0.5 text-[11px] font-medium text-white shadow-lg animate-fade-in">
            <Check className="h-3 w-3" />
            {t('saved')}
          </span>
        )}
      </div>

      {/* Note field */}
      {(effectiveStatus || requireNote) && (
        <div className="relative">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 shrink-0 text-gray-400" />
            <input
              type="text"
              value={noteText}
              onChange={(e) => { setNoteText(e.target.value); setNoteRequiredError(false) }}
              onKeyDown={(e) => { if (e.key === 'Enter') saveNote() }}
              placeholder={requireNote ? t('noteRequiredError') : t('notePlaceholder')}
              className={`min-w-0 flex-1 rounded-md border bg-transparent px-2.5 py-1 text-sm text-gray-700 placeholder:text-gray-400 focus:border-brand-400 focus:outline-none dark:text-gray-300 dark:placeholder:text-gray-500 dark:focus:border-brand-500 ${
                noteRequiredError ? 'border-red-400 dark:border-red-500' : 'border-gray-200 dark:border-gray-600'
              }`}
            />
            <button
              onClick={saveNote}
              disabled={noteText === savedNote}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-green-600 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-green-400"
            >
              <Check className="h-4 w-4" />
            </button>
          </div>
          {noteRequiredError && (
            <p className="mt-0.5 ml-6 text-[11px] text-red-500 dark:text-red-400">{t('noteRequiredError')}</p>
          )}
        </div>
      )}

      {/* Position preferences — only when feature enabled and user confirmed */}
      {showPositions && effectiveStatus === 'confirmed' && (
        <div className="space-y-1.5">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('positions', 'Position Preferences')}</span>
          {([
            { label: '1.', value: pos1, set: setPos1 },
            { label: '2.', value: pos2, set: setPos2 },
            { label: '3.', value: pos3, set: setPos3 },
          ] as const).map(({ label, value, set }, i) => {
            const others = [pos1, pos2, pos3].filter((_, j) => j !== i).filter(Boolean)
            return (
              <div key={label} className="flex items-center gap-2">
                <span className="w-5 text-right text-xs font-medium text-gray-400">{label}</span>
                <select
                  value={value}
                  onChange={(e) => {
                    const v = e.target.value as VolleyPosition | ''
                    set(v)
                    const newPos = [pos1, pos2, pos3] as (VolleyPosition | '')[]
                    newPos[i] = v
                    savePositions(newPos[0], newPos[1], newPos[2])
                  }}
                  className="flex-1 rounded-md border border-gray-200 bg-transparent px-2.5 py-1 text-sm text-gray-700 focus:border-brand-400 focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:focus:border-brand-500"
                >
                  <option value="">{t('positionRequired', 'Select position...')}</option>
                  {VOLLEY_POSITIONS.map((pos) => (
                    <option key={pos} value={pos} disabled={others.includes(pos)}>{pos}</option>
                  ))}
                </select>
              </div>
            )
          })}
          {positionsRequiredError && (
            <p className="text-[11px] text-red-500 dark:text-red-400">{t('positionsRequiredError', 'All 3 positions are required')}</p>
          )}
        </div>
      )}

      {/* Guest counter — staff only */}
      {effectiveStatus && isStaff && (
        <div className="flex items-center gap-2">
          <UserPlus className="h-4 w-4 shrink-0 text-gray-400" />
          <span className="text-sm text-gray-500 dark:text-gray-400">{t('guests')}</span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => handleGuestChange(-1)}
              disabled={guestCount <= 0}
              className="flex h-7 w-7 items-center justify-center rounded-md bg-gray-100 text-sm font-medium text-gray-700 hover:bg-gray-200 disabled:opacity-30 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
            >
              −
            </button>
            <span className="min-w-[1.5rem] text-center text-sm font-medium text-gray-900 dark:text-gray-100">
              {guestCount}
            </span>
            <button
              onClick={() => handleGuestChange(1)}
              className="flex h-7 w-7 items-center justify-center rounded-md bg-gray-100 text-sm font-medium text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
            >
              +
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Note field for per-session events — saves the same note to all session participations */
function EventSessionNote({ eventId, sessions }: { eventId: string; sessions: EventSession[] }) {
  const { t } = useTranslation('participation')
  const { user } = useAuth()
  const { update } = useMutation<Participation>('participations')

  const { data: allPartsRaw, refetch } = useCollection<Participation>('participations', {
    filter: user && eventId ? {
      _and: [
        { member: { _eq: user.id } },
        { activity_type: { _eq: 'event' } },
        { activity_id: { _eq: eventId } },
        { session_id: { _in: sessions.map(s => s.id) } },
      ],
    } : undefined,
    all: true,
    enabled: !!user && !!eventId && sessions.length > 0,
  })
  const allParts = allPartsRaw ?? []

  const savedNote = allParts[0]?.note ?? ''
  const [noteText, setNoteText] = useState(savedNote)
  const [noteSaved, setNoteSaved] = useState(false)
  const noteInitRef = useRef(savedNote)

  if (savedNote !== noteInitRef.current) {
    noteInitRef.current = savedNote
    setNoteText(savedNote)
  }

  useEffect(() => {
    if (!noteSaved) return
    const timer = setTimeout(() => setNoteSaved(false), 2000)
    return () => clearTimeout(timer)
  }, [noteSaved])

  const saveNote = async () => {
    if (noteText === savedNote || allParts.length === 0) return
    await Promise.all(allParts.map(p => update(p.id, { note: noteText })))
    setNoteSaved(true)
    refetch()
  }

  // Only show if user has at least one session participation
  if (allParts.length === 0) return null

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <MessageSquare className="h-4 w-4 shrink-0 text-gray-400" />
        <input
          type="text"
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') saveNote() }}
          onBlur={saveNote}
          placeholder={t('notePlaceholder')}
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
      {noteSaved && (
        <span className="absolute -top-7 left-1/2 -translate-x-1/2 flex items-center gap-1 whitespace-nowrap rounded-md bg-green-600 px-2 py-0.5 text-[11px] font-medium text-white shadow-lg animate-fade-in">
          <Check className="h-3 w-3" />
          {t('saved')}
        </span>
      )}
    </div>
  )
}
