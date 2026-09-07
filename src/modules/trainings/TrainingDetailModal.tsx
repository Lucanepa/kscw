import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '@/components/Modal'
import TeamChip from '../../components/TeamChip'
import ParticipationSummary from '../../components/ParticipationSummary'
import { rsvpButtonClass } from '../../utils/participationColors'
import ParticipationRosterModal from '../../components/ParticipationRosterModal'
import { useAuth } from '../../hooks/useAuth'
import { useTeamPermissions } from '../../hooks/useTeamPermissions'
import { useParticipation } from '../../hooks/useParticipation'
import { useMyCoveringAbsence } from '../../hooks/useMyCoveringAbsence'
import { useAbsenceNoteText } from '../../hooks/useAbsenceNoteText'
import { formatDate, formatWeekday, formatTime, getDeadlineDate, meetingTimeFromOffset } from '../../utils/dateHelpers'
import BroadcastButton from '../broadcast/BroadcastButton'
import ShareActivityButton from '../../components/ShareActivityButton'
import { sanitizeUrl } from '../../utils/sanitizeUrl'
import { isFeatureEnabled } from '../../utils/featureToggles'
import type { Training, Team, Hall, Member } from '../../types'
import { asObj, relId, teamCoachIds, memberDisplayName } from '../../utils/relations'
import CancelActivityButton from '../../components/CancelActivityButton'
import { MapPin, Clock, MessageSquare, User, Users, Calendar, Check, UserPlus, AlarmClock } from 'lucide-react'

type TrainingExpanded = Training & {
  team: Team | string
  hall: Hall | string
  coach: Member | string
}

interface TrainingDetailModalProps {
  training: TrainingExpanded | null
  onClose: () => void
}

export default function TrainingDetailModal({ training, onClose }: TrainingDetailModalProps) {
  const { t } = useTranslation('trainings')
  const { t: tc } = useTranslation('common')
  const { user, canParticipateIn, isStaffOnly, coachTeamIds, teamResponsibleIds } = useAuth()
  const { canManageTeam } = useTeamPermissions()
  const [rosterOpen, setRosterOpen] = useState(false)

  const teamId = relId(training?.team)
  const canParticipate = !!user && !!teamId && canParticipateIn(teamId)
  const isStaff = !!teamId && canManageTeam(teamId)

  if (!training) return null

  const team = asObj<Team>(training.team)
  const hall = asObj<Hall>(training.hall)
  const coach = asObj<Member>(training.coach)

  const actionRow = (
    <>
      <ShareActivityButton
        kind="training"
        id={training.id}
        title={team?.name ?? t('title')}
        iconOnly
      />
      <CancelActivityButton
        kind="training"
        activityId={training.id}
        isCancelled={!!training.cancelled}
        teamIds={teamId ? [teamId] : []}
        variant="inline"
        onDone={onClose}
      />
      {user ? (
        <BroadcastButton
          activity={{
            type: 'training',
            id: Number(training.id),
            title: team?.name ?? t('title'),
            start_date: training.date && training.start_time
              ? `${training.date}T${training.start_time}`
              : training.date,
            location: hall?.name ?? training.hall_name,
            teamName: team?.name,
            sport: (team?.sport as 'volleyball' | 'basketball' | undefined) ?? null,
            teamId: teamId ? Number(teamId) : undefined,
          }}
          member={{
            id: user.id,
            role: user.role ?? null,
            isCoachOf: coachTeamIds,
            isResponsibleOf: teamResponsibleIds,
          }}
        />
      ) : null}
    </>
  )

  return (
    <>
      <Modal open={!!training} onClose={onClose} title={t('title')} size="sm" disableAutoFocus>
        <div className="space-y-4">
          {/* Team + Date header */}
          <div className="flex items-center gap-2">
            {team && <TeamChip team={team.name} size="sm" />}
            {training.is_trial && (
              <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-semibold text-brand-700 dark:bg-brand-900/30 dark:text-brand-300">
                {t('trialBadge')}
              </span>
            )}
            {training.cancelled && (
              <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700 dark:bg-red-900/30 dark:text-red-400">
                {t('cancelled')}
              </span>
            )}
            {!training.cancelled && training.auto_shortened_by_game != null && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                {t('shortenedBadge')}
              </span>
            )}
          </div>

          {/* Details */}
          <div className="space-y-2 text-sm text-gray-700 dark:text-gray-300">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" />
              <span>{formatWeekday(training.date)}, {formatDate(training.date)}</span>
            </div>
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" />
              <span>{formatTime(training.start_time)} – {formatTime(training.end_time)}</span>
            </div>
            {meetingTimeFromOffset(training.start_time, training.meeting_offset_minutes) && (
              <div className="flex items-center gap-2">
                <AlarmClock className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" />
                <span>
                  {tc('meetingTime')}: {meetingTimeFromOffset(training.start_time, training.meeting_offset_minutes)}
                </span>
              </div>
            )}
            {(hall || training.hall_name) && (
              <div className="flex items-center gap-2">
                <MapPin className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" />
                {hall?.maps_url && sanitizeUrl(hall.maps_url) ? (
                  <a
                    href={sanitizeUrl(hall.maps_url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-brand-600 hover:underline dark:text-brand-400"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {hall.name} ↗
                  </a>
                ) : hall?.address ? (
                  <a
                    href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([hall.address, hall.city].filter(Boolean).join(', '))}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-brand-600 hover:underline dark:text-brand-400"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {hall.name} ↗
                  </a>
                ) : (
                  <span>{hall?.name || training.hall_name}</span>
                )}
              </div>
            )}
            {coach && (
              <div className="flex items-center gap-2">
                <User className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" />
                <span>{memberDisplayName(coach)}</span>
              </div>
            )}
          </div>

          {/* Cancellation reason */}
          {training.cancelled && training.cancel_reason && (
            <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400">
              {training.cancel_reason}
            </p>
          )}

          {/* Auto-shortened by home game */}
          {!training.cancelled && training.auto_shortened_by_game != null && (
            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
              {t('shortenedHint')}
            </p>
          )}

          {/* Notes */}
          {training.notes && !training.cancelled && (
            <p className="text-sm text-gray-500 dark:text-gray-400">{training.notes}</p>
          )}

          {/* Participation section */}
          {!training.cancelled && (
            <div className="space-y-3 border-t border-gray-200 pt-3 dark:border-gray-700">
              {/* Participation buttons */}
              {canParticipate && (
                <TrainingParticipation training={training} isStaff={isStaff} isStaffParticipant={!!teamId && isStaffOnly(teamId)} />
              )}

              {/* Summary + roster button */}
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <ParticipationSummary activityType="training" activityId={training.id} bars coachMemberIds={teamCoachIds(team)} />
                </div>
                <button
                  onClick={() => setRosterOpen(true)}
                  aria-label={t('participation')}
                  title={t('participation')}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-brand-600 hover:bg-brand-50 dark:text-brand-400 dark:hover:bg-brand-900/20"
                >
                  <Users className="h-5 w-5" />
                </button>
              </div>
            </div>
          )}

          {/* Actions — kept at the bottom so they never overlap the title */}
          <div className="flex flex-wrap items-center gap-2 border-t border-gray-200 pt-3 dark:border-gray-700">
            {actionRow}
          </div>
        </div>
      </Modal>

      {teamId && (
        <ParticipationRosterModal
          open={rosterOpen}
          onClose={() => setRosterOpen(false)}
          activityType="training"
          activityId={training.id}
          activityDate={training.date}
          teamIds={teamId ? [teamId] : []}
          title={`${team?.name ?? ''} — ${formatDate(training.date)}`}
          respondBy={training.respond_by}
          activityStartTime={training.start_time}
          showRsvpTime={isFeatureEnabled(asObj<Team>(training.team)?.features_enabled, 'show_rsvp_time')}
          excludedGuestLevels={Array.isArray(training.excluded_guest_levels) ? training.excluded_guest_levels : []}
        />
      )}
    </>
  )
}

function TrainingParticipation({ training, isStaff, isStaffParticipant }: { training: TrainingExpanded; isStaff: boolean; isStaffParticipant: boolean }) {
  const { t } = useTranslation('participation')
  const { t: tTrainings } = useTranslation('trainings')
  const { getGuestLevel } = useAuth()
  const myGuestLevel = getGuestLevel(relId(training.team))
  const excludedGuestLevels = Array.isArray(training.excluded_guest_levels) ? training.excluded_guest_levels : []
  const guestExcluded = myGuestLevel > 0 && excludedGuestLevels.map((n: number) => Number(n)).includes(myGuestLevel)

  const deadlinePassed = training.respond_by
    ? getDeadlineDate(training.respond_by, training.start_time) < new Date()
    : false

  const { participation, effectiveStatus, hasAbsence, note: savedNote, setStatus, saveConfirmed, dismissConfirmed } = useParticipation(
    'training',
    training.id,
    training.date,
    undefined,
    isStaffParticipant,
  )
  const { absence } = useMyCoveringAbsence('training', training.date)
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
  const requireNote = !!training.require_note_if_absent

  // Sync guest count from existing participation
  if (prevServerGuestCount !== serverGuestCount) {
    setPrevServerGuestCount(serverGuestCount)
    setGuestCount(serverGuestCount)
  }
  // Sync note text when server data loads/changes — fall back to absence label.
  const effectiveSync = savedNote || absenceNoteText
  if (effectiveSync !== prevNoteSync) {
    setPrevNoteSync(effectiveSync)
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
      setStatus(effectiveStatus as 'confirmed' | 'tentative' | 'declined', noteText, guestCount)
      setNoteSaved(true)
    }
  }

  async function handleGuestChange(delta: number) {
    const newCount = Math.max(0, guestCount + delta)
    setGuestCount(newCount)
    if (effectiveStatus) {
      await setStatus(effectiveStatus as 'confirmed' | 'tentative' | 'declined', noteText, newCount)
    }
  }

  const isLocked = deadlinePassed

  if (guestExcluded) {
    return <p className="text-sm italic text-gray-500 dark:text-gray-400">{tTrainings('guestExcluded')}</p>
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
            // When deadline has passed: only render the user's selected choice (if any) in its color.
            .filter((s) => !isLocked || effectiveStatus === s)
            .map((status) => {
            const labels = { confirmed: t('yes'), tentative: t('maybe'), declined: t('no') }
            const active = effectiveStatus === status
            return (
              <button
                key={status}
                disabled={isLocked}
                onClick={() => {
                  if (isLocked) return
                  if (requireNote && (status === 'declined' || status === 'tentative') && !noteText.trim()) {
                    setNoteRequiredError(true)
                    return
                  }
                  setNoteRequiredError(false)
                  setStatus(status, noteText, guestCount)
                }}
                className={`rounded-full px-3 py-1 text-sm font-medium transition ${isLocked ? 'cursor-not-allowed' : ''} ${rsvpButtonClass(status, active)}`}
              >
                {labels[status]}
              </button>
            )
          })}
        </div>
        {/* Save confirmation popover */}
        {saveConfirmed && (
          <span className="absolute -top-7 left-1/2 -translate-x-1/2 flex items-center gap-1 whitespace-nowrap rounded-md bg-green-600 px-2 py-0.5 text-[11px] font-medium text-white shadow-lg animate-fade-in">
            <Check className="h-3 w-3" />
            {t('saved')}
          </span>
        )}
      </div>
      {/* Deadline info */}
      {training.respond_by && (
        deadlinePassed ? (
          <p className="text-xs text-red-500 dark:text-red-400">{t('deadlinePassed')}</p>
        ) : (
          <p className="text-xs text-gray-400 dark:text-gray-500">
            {tTrainings('respondBy')}: {formatDate(training.respond_by)}, {formatTime(training.respond_by) || formatTime(training.start_time)}
          </p>
        )
      )}
      {/* Participation note */}
      {(effectiveStatus || requireNote) && (
        <div className="relative">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 shrink-0 text-gray-400" />
            <input
              type="text"
              value={noteText}
              onChange={(e) => { setNoteText(e.target.value); setNoteRequiredError(false) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveNote()
              }}
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
      {/* Guest counter — coaches/TR only */}
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
