import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, MessageSquare } from 'lucide-react'
import StatusBadge from '../../components/StatusBadge'
import TeamChip from '../../components/TeamChip'
import RichText from '../../components/RichText'
import ParticipationSummary from '../../components/ParticipationSummary'
import SessionParticipationSheet from '../../components/SessionParticipationSheet'
import { rsvpButtonClass } from '../../utils/participationColors'
import ParticipationWarningBadge from '../../components/ParticipationWarningBadge'
import { getEventWarnings } from '../../utils/participationWarnings'
import { useAuth } from '../../hooks/useAuth'
import { useCollection } from '../../lib/query'
import { useMutation } from '../../hooks/useMutation'
import { useRealtime } from '../../hooks/useRealtime'
import { useMyCoveringAbsence } from '../../hooks/useMyCoveringAbsence'
import { useAbsenceNoteText } from '../../hooks/useAbsenceNoteText'
import { formatDate, formatTime, getDeadlineDate } from '../../utils/dateHelpers'
import { asTeams, teamId, isHtml, isSameDay, isGuestExcludedFromEvent } from './eventHelpers'
import type { Event, EventSession, Participation } from '../../types'
import CancelActivityButton from '../../components/CancelActivityButton'

interface EventCardProps {
  event: Event
  onClick?: () => void
  onEdit?: (event: Event) => void
  onDelete?: (eventId: string) => void
  onOpenRoster?: (event: Event) => void
  /** Pre-fetched participations for this event (from batch query) */
  participations?: Participation[]
  /** Pre-fetched current user's participation (from batch query) */
  myParticipation?: Participation
  /** Called after a participation save — parent can refetch */
  onParticipationSaved?: () => void
}

/** Status shown on the card's left-edge banner. `mixed` is not a participation
 *  status — it's what a per-day event looks like when the member answered its
 *  sessions differently (some yes, some no), which has no single colour. */
type BannerStatus = Participation['status'] | 'mixed'

const statusBorderColor: Record<string, string> = {
  confirmed: 'bg-green-500 dark:bg-green-400',
  tentative: 'bg-yellow-500 dark:bg-yellow-400',
  declined: 'bg-red-500 dark:bg-red-400',
  waitlisted: 'bg-orange-500 dark:bg-orange-400',
  absent: 'bg-gray-400 dark:bg-gray-500',
  mixed: 'bg-gradient-to-b from-green-500 to-red-500 dark:from-green-400 dark:to-red-400',
}

export default function EventCard({ event, onClick, onEdit, onDelete, onOpenRoster, participations, myParticipation, onParticipationSaved }: EventCardProps) {
  const { t } = useTranslation('events')
  const { user, canParticipateIn, memberTeamIds, getGuestLevel } = useAuth()
  const teams = asTeams(event.teams)
  // Migration 324: `invite_guests: false` drops the invited teams' guest players
  // from the audience — they still SEE the event (the read policy is unchanged),
  // they just can't answer it. Same shape as a training's excluded guest tier.
  const guestExcluded = isGuestExcludedFromEvent(event, { memberId: user?.id, memberTeamIds, getGuestLevel })
  // Club-wide events (no teams): all logged-in users can RSVP
  // Team events: only members of those teams can RSVP
  const canRSVP = user && !guestExcluded && (
    !event.teams?.length || event.teams.some((tid) => canParticipateIn(teamId(tid)))
  )
  const warnings = getEventWarnings(participations ?? [], event.min_participants)

  // The banner used to read `myParticipation.status` — the batch-fetched SERVER
  // row — while the Yes/Maybe/No buttons right below it read their own optimistic
  // state. So the button flipped on click and the coloured strip only caught up a
  // refetch later (and for a brand-new RSVP appeared out of nowhere). The RSVP
  // control now reports the status it is actually displaying and the banner
  // follows it, so both change in the same frame.
  //
  // It also fixes per-day events: `myParticipation` is whichever of the member's
  // per-session rows the batch map happened to keep last, so a member who
  // confirmed day 1 and declined day 2 got an arbitrary colour. The session
  // control reports its aggregate instead ('mixed' when the days disagree).
  const rsvpControlsVisible = !!canRSVP && !event.cancelled
  const [liveStatus, setLiveStatus] = useState<BannerStatus | null | undefined>(undefined)
  const myStatus: BannerStatus | null = rsvpControlsVisible && liveStatus !== undefined
    ? liveStatus
    : (myParticipation?.status ?? null)

  // Roster / edit / delete. Extracted so the same markup can sit inline in the
  // header on >=sm and drop to a full-width footer row on a phone: four icon
  // buttons beside a nowrap title do not fit 375px, and the card's
  // overflow-hidden clipped the last one clean off rather than wrapping it.
  // `null` when the viewer manages nothing, so the footer's divider never
  // renders as a stray line under a plain member's card.
  const managementActions = (onOpenRoster || onEdit || onDelete) ? (
    <>
      {onOpenRoster && (
        <button
          onClick={() => onOpenRoster(event)}
          className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-600 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-300"
          title={t('viewRoster')}
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
          </svg>
        </button>
      )}
      {onEdit && (
        <button
          onClick={() => onEdit(event)}
          className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-600 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-300"
          title={t('editEvent')}
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
          </svg>
        </button>
      )}
      {onDelete && (
        <button
          onClick={() => onDelete(event.id)}
          className="rounded-lg p-2 text-gray-500 hover:bg-red-50 hover:text-red-600 dark:text-gray-400 dark:hover:bg-red-900/20 dark:hover:text-red-400"
          title={t('deleteEvent')}
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
          </svg>
        </button>
      )}
    </>
  ) : null

  return (
    <div
      data-tour="event-card"
      className={`flex items-stretch overflow-hidden rounded-xl border border-gray-200 bg-white shadow-card dark:border-gray-700 dark:bg-gray-800${onClick ? ' cursor-pointer transition-shadow hover:shadow-card-hover' : ''}${event.cancelled ? ' opacity-60' : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } } : undefined}
    >
      {/* Participation status vertical banner */}
      {user && myStatus && (
        <div className={`w-1 shrink-0 ${statusBorderColor[myStatus] ?? ''}`} />
      )}
      <div className="min-w-0 flex-1 p-3">
      {/* Top row: badge + title + actions */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <StatusBadge status={event.event_type} />
          <h2 className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{event.title}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {event.cancelled && (
            <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700 dark:bg-red-900/30 dark:text-red-400">
              {t('cancelled')}
            </span>
          )}
          <CancelActivityButton
            kind="event"
            activityId={event.id}
            isCancelled={!!event.cancelled}
            teamIds={asTeams(event.teams).map((tm) => String(tm.id))}
            variant="icon"
            onDone={onParticipationSaved}
          />
          {managementActions && (
            <div className="hidden items-center gap-1 sm:flex">{managementActions}</div>
          )}
        </div>
      </div>
      {/* Details */}
      <p className="mt-1.5 text-sm text-gray-600 dark:text-gray-400">
        {formatDate(event.start_date)}
        {!event.all_day && `, ${formatTime(event.start_date)}`}
        {!event.all_day && isSameDay(event.start_date, event.end_date)
          ? `–${formatTime(event.end_date)}`
          : !isSameDay(event.start_date, event.end_date) && (
            ` — ${formatDate(event.end_date)}${!event.all_day ? `, ${formatTime(event.end_date)}` : ''}`
          )}
        {event.all_day && ` · ${t('allDay')}`}
      </p>
      {event.location && (
        <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
          <a
            href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.location)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-brand-600 hover:underline dark:hover:text-brand-400"
            onClick={(e) => e.stopPropagation()}
          >
            {event.location} ↗
          </a>
        </p>
      )}
      {event.description && (
        isHtml(event.description)
          ? <RichText html={event.description} className="mt-1 text-sm text-gray-500 dark:text-gray-400" />
          : <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{event.description}</p>
      )}
      {event.cancelled && event.cancel_reason && (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">{event.cancel_reason}</p>
      )}
      {teams.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {teams.map((team) => (
            <TeamChip key={team.id} team={team.name} size="sm" />
          ))}
        </div>
      )}
      {((event.invited_roles ?? []).length > 0 || (event.invited_members ?? []).length > 0) && (
        <span className="inline-flex items-center gap-1 rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
          {t('targetedEvent', { ns: 'invitations' })}
        </span>
      )}

      {/* Bottom row: RSVP + participation bars */}
      {canRSVP && !event.cancelled && (
        <div data-tour="event-rsvp" className="mt-2.5 space-y-1.5" onClick={(e) => e.stopPropagation()}>
          <div className="flex flex-wrap items-end justify-between gap-2">
            {event.participation_mode && event.participation_mode !== 'whole' ? (
              <EventCardSessionParticipation
                event={event}
                onSaved={onParticipationSaved}
                onStatusChange={setLiveStatus}
              />
            ) : (
              <EventCardParticipation
                event={event}
                existingParticipation={myParticipation}
                onSaved={onParticipationSaved}
                onStatusChange={setLiveStatus}
              />
            )}
            <div className="flex items-center gap-2">
              {warnings.length > 0 && (
                <ParticipationWarningBadge warnings={warnings} namespace="participation" />
              )}
              <ParticipationSummary activityType="event" activityId={event.id} bars hideExtras participations={participations} />
            </div>
          </div>
        </div>
      )}
      {guestExcluded && !event.cancelled && (
        <p className="mt-2 text-xs italic text-gray-500 dark:text-gray-400">{t('guestNotInvited')}</p>
      )}
      {!canRSVP && warnings.length > 0 && (
        <div className="mt-2 flex items-center gap-2">
          <ParticipationWarningBadge warnings={warnings} namespace="participation" />
        </div>
      )}

      {/* Phone-only action row. The negative margin + padding pair lets the
          divider span the card's full width from inside the p-3 box. */}
      {managementActions && (
        <div
          className="-mx-3 mt-2.5 flex items-center justify-end gap-1 border-t border-gray-100 px-3 pt-1.5 sm:hidden dark:border-gray-700"
          onClick={(e) => e.stopPropagation()}
        >
          {managementActions}
        </div>
      )}
      </div>
    </div>
  )
}

/** Inline Yes/Maybe/No buttons for event cards — matches training/game card pattern, no dropdown overflow */
function EventCardParticipation({ event, existingParticipation, onSaved, onStatusChange }: { event: Event; existingParticipation?: Participation; onSaved?: () => void; onStatusChange?: (status: Participation['status'] | null) => void }) {
  const { t } = useTranslation('participation')
  const { user, isStaffOnlyForTeams } = useAuth()
  const isStaff = isStaffOnlyForTeams((event.teams ?? []).map((tm) => teamId(tm)))
  const { create, update } = useMutation<Participation>('participations')
  const { absence, hasAbsence } = useMyCoveringAbsence('event', event.start_date)
  const absenceLabel = absence?.type === 'weekly' ? 'declinedUnavailable' : 'absent'
  const absenceNoteText = useAbsenceNoteText(absence)

  const deadlinePassed = event.respond_by
    ? getDeadlineDate(event.respond_by, event.start_date ? formatTime(event.start_date) : undefined) < new Date()
    : false

  const [optimisticStatus, setOptimisticStatus] = useState<Participation['status'] | null>(null)
  const [saveConfirmed, setSaveConfirmed] = useState(false)
  const [noteText, setNoteText] = useState(existingParticipation?.note ?? '')
  const [noteError, setNoteError] = useState(false)
  const noteInitRef = useRef(existingParticipation?.note ?? '')
  const noteInputRef = useRef<HTMLInputElement>(null)

  // Sync note: prefer server note, otherwise prefill with absence label.
  const serverNote = existingParticipation?.note ?? ''
  const effectiveSync = serverNote || absenceNoteText
  if (effectiveSync !== noteInitRef.current) {
    noteInitRef.current = effectiveSync
    setNoteText(effectiveSync)
  }

  const serverStatus = existingParticipation?.status ?? null
  const displayStatus = optimisticStatus ?? serverStatus

  // Auto-dismiss confirmation after 2s
  useEffect(() => {
    if (!saveConfirmed) return
    const timer = setTimeout(() => setSaveConfirmed(false), 2000)
    return () => clearTimeout(timer)
  }, [saveConfirmed])

  // Report what these buttons are showing so the card's left-edge banner can
  // paint the same thing in the same frame. `displayStatus` already folds in the
  // optimistic value and reverts to the server row if the save throws, so the
  // banner self-corrects without any extra bookkeeping.
  useEffect(() => { onStatusChange?.(displayStatus) }, [displayStatus, onStatusChange])

  const setStatus = useCallback(async (status: Participation['status'], note?: string) => {
    if (!user) return
    const n = note ?? noteText
    // If note is required for decline/tentative and no note yet, focus the note input
    if (event.require_note_if_absent && (status === 'declined' || status === 'tentative') && !n.trim()) {
      setOptimisticStatus(status)
      setNoteError(true)
      setTimeout(() => noteInputRef.current?.focus(), 50)
      return
    }
    setOptimisticStatus(status)
    setSaveConfirmed(false)
    try {
      if (existingParticipation) {
        await update(existingParticipation.id, { status, note: n, guest_count: status === 'declined' ? 0 : (existingParticipation.guest_count ?? 0) })
      } else {
        await create({
          member: user.id,
          activity_type: 'event' as const,
          activity_id: event.id,
          status,
          note: n,
          guest_count: 0,
          is_staff: isStaff,
        })
      }
      setSaveConfirmed(true)
      onSaved?.()
    } catch {
      setOptimisticStatus(null)
    }
  }, [user, existingParticipation, event.id, event.require_note_if_absent, isStaff, noteText, create, update, onSaved])

  const saveNote = () => {
    if (noteText.trim() && displayStatus) {
      setNoteError(false)
      setStatus(displayStatus, noteText.trim())
    }
  }

  const isLocked = deadlinePassed

  return (
    <div className="space-y-1.5">
      {hasAbsence && (
        <p className="text-xs italic text-gray-500 dark:text-gray-400">{t(absenceLabel)}</p>
      )}
      <div className="relative flex flex-wrap items-center gap-1.5">
        {(['confirmed', 'tentative', 'declined'] as const)
          .filter((s) => s !== 'tentative' || event.allow_maybe !== false)
          // When deadline has passed: only render the user's selected choice (if any) in its color.
          .filter((s) => !isLocked || displayStatus === s)
          .map((status) => {
          const active = displayStatus === status
          const label = { confirmed: t('yes'), tentative: t('maybe'), declined: t('no') }
          return (
            <button
              key={status}
              onClick={() => !isLocked && setStatus(status)}
              disabled={isLocked}
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition ${isLocked ? 'cursor-not-allowed' : ''} ${rsvpButtonClass(status, active)}`}
            >
              {label[status]}
            </button>
          )
        })}

        {/* Save confirmation popover */}
        {saveConfirmed && (
          <span className="absolute -top-7 left-1/2 -translate-x-1/2 flex items-center gap-1 whitespace-nowrap rounded-md bg-green-600 px-2 py-0.5 text-[11px] font-medium text-white shadow-lg animate-fade-in">
            <Check className="h-3 w-3" />
            {t('saved')}
          </span>
        )}
      </div>

      {/* Deadline info */}
      {isLocked && (
        <p className="text-[10px] leading-tight text-red-500 dark:text-red-400">
          {t('deadlinePassed')}
        </p>
      )}
      {event.respond_by && !deadlinePassed && (
        <p data-tour="event-respond-by" className="text-[10px] leading-tight text-gray-400 dark:text-gray-500">
          {t('respondBy', { ns: 'events' })}: {formatDate(event.respond_by)}, {formatTime(event.respond_by) || (event.start_date ? formatTime(event.start_date) : '')}
        </p>
      )}

      {/* Note input — always visible once a status is set; required for declined/tentative when event.require_note_if_absent is on */}
      {displayStatus && (
        <div data-tour="event-note" className="flex items-center gap-1.5">
          <MessageSquare className="h-3.5 w-3.5 shrink-0 text-gray-400" />
          <input
            ref={noteInputRef}
            type="text"
            value={noteText}
            onChange={(e) => { setNoteText(e.target.value); setNoteError(false) }}
            onKeyDown={(e) => { if (e.key === 'Enter') saveNote() }}
            onBlur={saveNote}
            placeholder={t('notePlaceholder')}
            className={`min-w-0 flex-1 rounded-md border bg-transparent px-2 py-0.5 text-xs text-gray-700 placeholder:text-gray-400 focus:outline-none dark:text-gray-300 dark:placeholder:text-gray-500 ${
              noteError ? 'border-red-400 dark:border-red-500' : 'border-gray-200 focus:border-brand-400 dark:border-gray-600 dark:focus:border-brand-500'
            }`}
          />
        </div>
      )}
      {noteError && (
        <p className="text-[10px] text-red-500 dark:text-red-400">{t('noteRequiredError')}</p>
      )}
    </div>
  )
}

/** RSVP control for per-day / per-session events on the card.
 *  Two ways to answer, per product decision:
 *   - Quick Yes/Maybe/No writes that status to EVERY session at once (one
 *     participation row per session_id) — the "confirm all days" shortcut.
 *   - "Per day" opens the granular per-leg sheet.
 *  A per-day event must NEVER get a session-less whole-event row (the old card
 *  did that, which is why the roster's day tabs showed 0 while Overall showed
 *  N/2). Aggregate status: all-same → that button is active; mixed → no button
 *  active, and an "X/Y confirmed" hint shows. */
function EventCardSessionParticipation({ event, onSaved, onStatusChange }: { event: Event; onSaved?: () => void; onStatusChange?: (status: Participation['status'] | 'mixed' | null | undefined) => void }) {
  const { t } = useTranslation('participation')
  const { t: te } = useTranslation('events')
  const { user, isStaffOnlyForTeams } = useAuth()
  // Every invited team, not just `teams[0]` — a D1 coach on an H3 + D1 event
  // was classified as a player whenever H3 sorted first in the junction.
  const isStaff = isStaffOnlyForTeams((event.teams ?? []).map((tm) => teamId(tm)))
  const { create, update } = useMutation<Participation>('participations')
  const [sheetOpen, setSheetOpen] = useState(false)
  const [savingAll, setSavingAll] = useState(false)
  const [optimisticAll, setOptimisticAll] = useState<Participation['status'] | null>(null)

  const { data: sessionsRaw, isError: sessionsError } = useCollection<EventSession>('event_sessions', {
    filter: { event: { _eq: event.id } },
    sort: ['sort_order', 'date', 'start_time'],
    limit: 100,
    enabled: !!user,
  })
  const sessions = useMemo(() => sessionsRaw ?? [], [sessionsRaw])

  const { data: myRowsRaw, refetch, isError: myRowsError } = useCollection<Participation>('participations', {
    filter: user
      ? { _and: [
          { member: { _eq: user.id } },
          { activity_type: { _eq: 'event' } },
          { activity_id: { _eq: event.id } },
        ] }
      : { id: { _eq: -1 } },
    all: true,
    enabled: !!user,
  })
  const myRows = useMemo(() => myRowsRaw ?? [], [myRowsRaw])
  useRealtime<Participation>('participations', (e) => {
    if (e.record.activity_id === event.id && e.record.member === user?.id) refetch()
  })

  const myBySession = useMemo(() => {
    const m = new Map<string, Participation>()
    for (const p of myRows) if (p.session_id) m.set(String(p.session_id), p)
    return m
  }, [myRows])

  const total = sessions.length
  const statuses = sessions.map((s) => myBySession.get(String(s.id))?.status ?? null)
  const confirmedCount = statuses.filter((s) => s === 'confirmed').length
  const answeredCount = statuses.filter((s) => s != null).length
  const uniform = (val: Participation['status']) => total > 0 && statuses.every((s) => s === val)
  const aggregate: Participation['status'] | null =
    optimisticAll ?? (uniform('confirmed') ? 'confirmed' : uniform('declined') ? 'declined' : uniform('tentative') ? 'tentative' : null)
  const mixed = !aggregate && answeredCount > 0

  const deadlinePassed = event.respond_by
    ? getDeadlineDate(event.respond_by, event.start_date ? formatTime(event.start_date) : undefined) < new Date()
    : false
  const isLocked = deadlinePassed

  // Same reporter as the whole-event control, but the value that matters here is
  // the AGGREGATE across sessions — 'mixed' when the member answered the days
  // differently, which is exactly the case the banner used to render as an
  // arbitrary single colour. Declared above the `total === 0` early return so the
  // hook order stays stable.
  //
  // `undefined` while this control's own two queries are still in flight: it means
  // "I have nothing to say yet", so the banner keeps showing the batch-fetched
  // server row instead of blinking off and back on — which is the very lag this
  // change is here to remove.
  // ⚠ `isLoading` goes false on ERROR while `data` stays undefined, so a bare
  // `data === undefined` gate never releases after a failed fetch — a permanent
  // skeleton is worse than the wrong frame it replaced. Errors fall through.
  const sessionDataReady =
    (sessionsRaw !== undefined && myRowsRaw !== undefined) || sessionsError || myRowsError
  useEffect(() => {
    onStatusChange?.(sessionDataReady ? (aggregate ?? (mixed ? 'mixed' : null)) : undefined)
  }, [sessionDataReady, aggregate, mixed, onStatusChange])

  const setAll = useCallback(async (status: Participation['status']) => {
    // `myBySession` is empty until BOTH queries land, so a click in that window
    // would take the create() branch for every session — including the ones that
    // already have a row — and migration 246's partial unique index rejects those
    // mid-`Promise.all`, leaving the RSVP half-written with no toast. The render
    // gate below means no button exists to click yet; this is the belt.
    if (!user || savingAll || total === 0 || !sessionDataReady) return
    setOptimisticAll(status)
    setSavingAll(true)
    try {
      await Promise.all(sessions.map((s) => {
        const existing = myBySession.get(String(s.id))
        return existing
          ? update(existing.id, { status })
          : create({
              member: user.id,
              activity_type: 'event' as const,
              activity_id: event.id,
              status,
              note: '',
              guest_count: 0,
              is_staff: isStaff,
              session_id: s.id,
            })
      }))
      onSaved?.()
    } catch {
      setOptimisticAll(null)
    } finally {
      setSavingAll(false)
    }
  }, [user, savingAll, total, sessionDataReady, sessions, myBySession, update, create, event.id, isStaff, onSaved])

  // Until both queries land, `statuses` is all-null and `aggregate` is therefore
  // null — which the pill row below renders as three unselected buttons, i.e. a
  // definitive "you have not answered this event" for a member who did answer.
  // (Past the respond-by deadline it is worse: the `aggregate === s` filter strips
  // every pill and only "Deadline passed" remains.) Show the row's shape as
  // skeletons instead — same footprint, so nothing shifts when the real pills
  // arrive, and nothing claims an answer that has not been fetched yet.
  if (!sessionDataReady) return (
    <div className="flex flex-wrap items-center gap-1.5" aria-busy="true">
      {['w-10', 'w-14', 'w-9'].map((w) => (
        <span key={w} className={`h-5 ${w} animate-pulse rounded-full bg-gray-200 dark:bg-gray-700`} />
      ))}
      {!isLocked && <span className="h-5 w-16 animate-pulse rounded-full bg-gray-200 dark:bg-gray-700" />}
    </div>
  )

  if (total === 0) return null

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {(['confirmed', 'tentative', 'declined'] as const)
          .filter((s) => s !== 'tentative' || event.allow_maybe !== false)
          .filter((s) => !isLocked || aggregate === s)
          .map((status) => {
            const active = aggregate === status
            const label = { confirmed: t('yes'), tentative: t('maybe'), declined: t('no') }
            return (
              <button
                key={status}
                onClick={() => !isLocked && setAll(status)}
                disabled={isLocked || savingAll}
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition ${isLocked ? 'cursor-not-allowed' : ''} ${rsvpButtonClass(status, active)}`}
              >
                {label[status]}
              </button>
            )
          })}
        {!isLocked && (
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className="rounded-full bg-brand-100 px-2.5 py-0.5 text-xs font-medium text-brand-700 transition hover:bg-brand-200 dark:bg-brand-900/30 dark:text-brand-400 dark:hover:bg-brand-900/50"
          >
            {te('perDay', { defaultValue: 'Per day' })}
          </button>
        )}
      </div>
      {mixed && (
        <p className="text-[10px] leading-tight text-gray-400 dark:text-gray-500">
          {te('sessionsConfirmed', { confirmed: confirmedCount, total })}
        </p>
      )}
      {isLocked && (
        <p className="text-[10px] leading-tight text-red-500 dark:text-red-400">{t('deadlinePassed')}</p>
      )}
      {event.respond_by && !deadlinePassed && (
        <p className="text-[10px] leading-tight text-gray-400 dark:text-gray-500">
          {te('respondBy')}: {formatDate(event.respond_by)}, {formatTime(event.respond_by) || (event.start_date ? formatTime(event.start_date) : '')}
        </p>
      )}
      {sheetOpen && (
        <SessionParticipationSheet
          activityId={event.id}
          sessions={sessions}
          isStaff={isStaff}
          onClose={() => { setSheetOpen(false); onSaved?.() }}
        />
      )}
    </div>
  )
}

