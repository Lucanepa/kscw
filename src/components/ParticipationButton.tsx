import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, X, HelpCircle, Hourglass } from 'lucide-react'
import { useParticipation } from '../hooks/useParticipation'
import { useMyCoveringAbsence } from '../hooks/useMyCoveringAbsence'
import { getDeadlineDate } from '../utils/dateHelpers'
import { useMutation } from '../hooks/useMutation'
import { useAuth } from '../hooks/useAuth'
import type { Participation, EventSession } from '../types'
import SessionParticipationSheet from './SessionParticipationSheet'

interface ParticipationButtonProps {
  activityType: Participation['activity_type']
  activityId: string
  activityDate?: string
  teamId?: string
  compact?: boolean
  respondBy?: string
  activityStartTime?: string
  maxPlayers?: number
  confirmedCount?: number
  sessionId?: string
  /** For multi-session events: pass mode + sessions to show session sheet */
  participationMode?: 'whole' | 'per_day' | 'per_session' | ''
  eventSessions?: EventSession[]
  /** When true, declining or tentative requires a note */
  requireNoteIfAbsent?: boolean
  /** When false, the "Maybe/Tentative" option is hidden */
  allowMaybe?: boolean
  /** Pre-fetched participation — skips internal API call when provided */
  existingParticipation?: Participation
  /** Called after a successful save — parent can refetch data */
  onSaved?: () => void
}

const statusStyles = {
  confirmed: { icon: <Check className="h-3.5 w-3.5" />, bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-700 dark:text-green-400' },
  declined: { icon: <X className="h-3.5 w-3.5" />, bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-700 dark:text-red-400' },
  tentative: { icon: <HelpCircle className="h-3.5 w-3.5" />, bg: 'bg-yellow-100 dark:bg-yellow-900/30', text: 'text-yellow-700 dark:text-yellow-400' },
  waitlisted: { icon: <Hourglass className="h-3.5 w-3.5" />, bg: 'bg-orange-100 dark:bg-orange-900/30', text: 'text-orange-700 dark:text-orange-400' },
}

/** Shared data interface for both hooked and prefetched modes */
interface ParticipationData {
  participation: Participation | null
  /** True only in hooked mode, while the saved answer is still being fetched. */
  isLoading: boolean
  effectiveStatus: Participation['status'] | null
  setStatus: (status: Participation['status'], note?: string, guestCount?: number) => Promise<void>
  saveConfirmed: boolean
  dismissConfirmed: () => void
}

/**
 * Entry point: routes to hooked or prefetched version based on props.
 * This avoids conditional hooks — each branch always calls the same hooks.
 */
export default function ParticipationButton(props: ParticipationButtonProps) {
  if (props.existingParticipation !== undefined) {
    return <PrefetchedParticipationButton {...props} />
  }
  return <HookedParticipationButton {...props} />
}

/** Uses useParticipation hook to fetch data (for detail modals / standalone use) */
function HookedParticipationButton(props: ParticipationButtonProps) {
  const { t } = useTranslation('participation')
  const { isStaffOnly } = useAuth()
  const isStaff = !!props.teamId && isStaffOnly(props.teamId)
  const { participation, effectiveStatus, setStatus, saveConfirmed, dismissConfirmed, isLoading } = useParticipation(
    props.activityType,
    props.activityId,
    props.activityDate,
    props.sessionId,
    isStaff,
  )
  // Show buttons even when an absence covers — clicking flips status; the
  // BEFORE UPDATE trigger detaches `auto_declined_by`, leaving a clean manual
  // override. The label below the buttons just communicates the state.
  const { absence, hasAbsence } = useMyCoveringAbsence(props.activityType, props.activityDate)
  const absenceLabel = absence?.type === 'weekly' ? 'declinedUnavailable' : 'absent'
  return (
    <div className="space-y-1">
      {hasAbsence && (
        <p className="text-xs italic text-gray-500 dark:text-gray-400">{t(absenceLabel)}</p>
      )}
      <ParticipationButtonInner
        {...props}
        data={{ participation, isLoading, effectiveStatus, setStatus, saveConfirmed, dismissConfirmed }}
      />
    </div>
  )
}

/** Uses pre-fetched participation + useMutation for writes (for list cards) */
function PrefetchedParticipationButton(props: ParticipationButtonProps) {
  const { user, isStaffOnly } = useAuth()
  const isStaff = !!props.teamId && isStaffOnly(props.teamId)
  const { create, update } = useMutation<Participation>('participations')
  const [optimisticStatus, setOptimisticStatus] = useState<Participation['status'] | null>(null)
  const [saveConfirmed, setSaveConfirmed] = useState(false)

  const participation = props.existingParticipation ?? null
  const serverStatus = participation?.status ?? null
  const effectiveStatus = optimisticStatus ?? serverStatus

  const setStatus = useCallback(async (status: Participation['status'], note = '', guestCount = 0) => {
    if (!user) return
    setOptimisticStatus(status)
    setSaveConfirmed(false)
    try {
      if (participation) {
        await update(participation.id, { status, note, guest_count: guestCount })
      } else {
        await create({
          member: user.id,
          activity_type: props.activityType,
          activity_id: props.activityId,
          status,
          note,
          guest_count: guestCount,
          is_staff: isStaff,
          ...(props.sessionId ? { session_id: props.sessionId } : {}),
        })
      }
      setSaveConfirmed(true)
      props.onSaved?.()
    } catch {
      setOptimisticStatus(null)
    }
  }, [user, participation, props.activityType, props.activityId, props.sessionId, isStaff, create, update, props.onSaved])

  const dismissConfirmed = useCallback(() => setSaveConfirmed(false), [])

  return (
    <ParticipationButtonInner
      {...props}
      data={{ participation, isLoading: false, effectiveStatus, setStatus, saveConfirmed, dismissConfirmed }}
    />
  )
}

/** Shared UI — receives participation data from either provider */
function ParticipationButtonInner({
  activityId,
  teamId,
  compact = false,
  respondBy,
  activityStartTime,
  maxPlayers,
  confirmedCount,
  participationMode,
  eventSessions,
  requireNoteIfAbsent = false,
  allowMaybe = true,
  data: { participation, isLoading, effectiveStatus, setStatus, saveConfirmed, dismissConfirmed },
}: ParticipationButtonProps & { data: ParticipationData }) {
  const { t } = useTranslation('participation')
  const { isGuestIn, isStaffOnly, isActingForOther, user } = useAuth()
  // The per-day sheet writes its own rows, so it needs the same staff
  // classification the whole-event path applies (both wrappers derive it from
  // `teamId` before handing the props down).
  const isStaff = !!teamId && isStaffOnly(teamId)
  const [menuOpen, setMenuOpen] = useState(false)
  const [sessionSheetOpen, setSessionSheetOpen] = useState(false)
  // Guest count is seeded from the existing participation and re-synced whenever
  // the server value changes (see the adjust-during-render block below).
  const serverGuestCount = participation?.guest_count ?? 0
  const [guestCount, setGuestCount] = useState(serverGuestCount)

  // Note-required flow: pending status waiting for note input
  const [pendingStatus, setPendingStatus] = useState<'declined' | 'tentative' | null>(null)
  const [noteText, setNoteText] = useState('')
  const [noteError, setNoteError] = useState(false)
  const noteInputRef = useRef<HTMLTextAreaElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // Debounce the guest-count server write so rapid +/- taps issue one mutation,
  // not one per tap (which can race).
  const guestWriteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Sync guest count from existing participation — reset-on-value-change, so it
  // runs during render (React's adjust-state-during-render pattern) on exactly
  // the trigger the effect used (server guest_count changed).
  const [prevServerGuestCount, setPrevServerGuestCount] = useState(serverGuestCount)
  if (prevServerGuestCount !== serverGuestCount) {
    setPrevServerGuestCount(serverGuestCount)
    setGuestCount(serverGuestCount)
  }

  // Auto-dismiss save confirmation after 2s
  useEffect(() => {
    if (!saveConfirmed) return
    const timer = setTimeout(dismissConfirmed, 2000)
    return () => clearTimeout(timer)
  }, [saveConfirmed, dismissConfirmed])

  // Focus note input when it appears
  useEffect(() => {
    if (pendingStatus && noteInputRef.current) {
      noteInputRef.current.focus()
    }
  }, [pendingStatus])

  // Focus the first RSVP option when the menu opens (keyboard access)
  useEffect(() => {
    if (menuOpen && !pendingStatus) {
      menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    }
  }, [menuOpen, pendingStatus])

  // Flush any pending debounced guest-count write on unmount
  useEffect(() => () => { if (guestWriteTimer.current) clearTimeout(guestWriteTimer.current) }, [])

  const hasSessionMode = participationMode && participationMode !== 'whole' && eventSessions && eventSessions.length > 0

  // ⚠ The anti-mistake device for household guardians (migration 348).
  // While a parent is acting for one of her children, the child's NAME goes
  // inside the RSVP labels themselves — so it is under her thumb at the exact
  // instant of the decision. This beats a confirmation dialog, because a parent
  // doing a dozen RSVPs a week taps through dialogs blind by the second day.
  // Together with the banner colour and the banner name, it is the third of
  // three simultaneous answers to "which child am I?".
  const actingName = isActingForOther ? (user?.first_name || '') : ''
  const statusLabels: Record<string, string> = actingName
    ? {
      confirmed: t('rsvpConfirmedFor', { name: actingName }),
      declined: t('rsvpDeclinedFor', { name: actingName }),
      tentative: t('rsvpTentativeFor', { name: actingName }),
      waitlisted: t('waitlisted'),
    }
    : {
      confirmed: t('confirmed'),
      declined: t('declined'),
      tentative: t('tentative'),
      waitlisted: t('waitlisted'),
    }

  const deadlinePassed = respondBy
    ? getDeadlineDate(respondBy, activityStartTime) < new Date()
    : false
  const isFull = maxPlayers != null && confirmedCount != null && confirmedCount >= maxPlayers

  const currentStyle = effectiveStatus ? statusStyles[effectiveStatus as keyof typeof statusStyles] : null

  async function handleSelect(status: Participation['status']) {
    // If note is required for decline/tentative, show note input instead of immediately saving
    if (requireNoteIfAbsent && (status === 'declined' || status === 'tentative')) {
      setPendingStatus(status)
      setNoteText(participation?.note ?? '')
      setNoteError(false)
      // Keep menu open but switch to note input view
      return
    }
    setMenuOpen(false)
    await setStatus(status, '', status === 'declined' ? 0 : guestCount)
  }

  async function handleNoteSubmit() {
    if (!noteText.trim()) {
      setNoteError(true)
      return
    }
    setNoteError(false)
    const status = pendingStatus!
    setPendingStatus(null)
    setMenuOpen(false)
    await setStatus(status, noteText.trim(), status === 'declined' ? 0 : guestCount)
  }

  function handleNoteCancel() {
    setPendingStatus(null)
    setNoteText('')
    setNoteError(false)
  }

  function handleGuestChange(delta: number) {
    const newCount = Math.max(0, guestCount + delta)
    setGuestCount(newCount)
    if (effectiveStatus && effectiveStatus !== 'declined') {
      const status = effectiveStatus as Participation['status']
      const note = participation?.note ?? ''
      if (guestWriteTimer.current) clearTimeout(guestWriteTimer.current)
      guestWriteTimer.current = setTimeout(() => {
        guestWriteTimer.current = null
        setStatus(status, note, newCount)
      }, 500)
    }
  }

  // Multi-session mode: render session-aware button
  if (hasSessionMode) {
    return (
      <>
        <button
          onClick={() => setSessionSheetOpen(true)}
          className="inline-flex min-h-[44px] items-center gap-1 rounded-full bg-brand-100 px-2.5 py-1 text-xs font-medium text-brand-700 hover:bg-brand-200 dark:bg-brand-900/30 dark:text-brand-400 dark:hover:bg-brand-900/50 sm:min-h-0"
        >
          {t('events:sessionParticipation')}
        </button>
        {sessionSheetOpen && (
          <SessionParticipationSheet
            activityId={activityId}
            sessions={eventSessions!}
            isStaff={isStaff}
            onClose={() => setSessionSheetOpen(false)}
          />
        )}
      </>
    )
  }

  return (
    <div className="relative">
      <button
        onClick={() => !deadlinePassed && setMenuOpen(!menuOpen)}
        disabled={deadlinePassed || isLoading}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        className={`inline-flex min-h-[44px] items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors sm:min-h-0 ${
          deadlinePassed
            ? 'cursor-not-allowed bg-gray-100 text-gray-400 ring-1 ring-red-400 dark:bg-gray-700 dark:text-gray-500 dark:ring-red-500'
            : currentStyle
              ? `${currentStyle.bg} ${currentStyle.text}`
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
        }`}
      >
        {currentStyle ? (
          <>
            {currentStyle.icon} {!compact && statusLabels[effectiveStatus!]}
            {guestCount > 0 && (
              <span className="ml-0.5 text-[10px] opacity-75">+{guestCount}</span>
            )}
          </>
        ) : (
          <>{t('rsvp')}</>
        )}
      </button>

      {deadlinePassed && !compact && (
        <p className="mt-0.5 text-[10px] leading-tight text-red-500 dark:text-red-400">
          {t('deadlinePassed')}
        </p>
      )}

      {menuOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => { setMenuOpen(false); handleNoteCancel() }} />
          <div
            ref={menuRef}
            role="menu"
            aria-orientation="vertical"
            tabIndex={-1}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setMenuOpen(false); handleNoteCancel(); return }
              if (!pendingStatus && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault()
                const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
                if (items.length === 0) return
                const idx = items.findIndex((el) => el === document.activeElement)
                const nextIdx = e.key === 'ArrowDown'
                  ? (idx + 1) % items.length
                  : (idx - 1 + items.length) % items.length
                items[idx === -1 ? 0 : nextIdx]?.focus()
              }
            }}
            className="absolute right-0 top-full z-20 mt-1 w-56 rounded-lg border bg-white py-1 shadow-lg outline-none dark:border-gray-600 dark:bg-gray-800"
          >
            {/* Note input view — shown when note is required for decline/tentative */}
            {pendingStatus ? (
              <div className="px-3 py-2">
                <p className="mb-1.5 text-xs font-medium text-gray-700 dark:text-gray-300">
                  {statusLabels[pendingStatus]} — {t('requireNoteIfAbsentHint')}
                </p>
                <textarea
                  ref={noteInputRef}
                  value={noteText}
                  onChange={(e) => { setNoteText(e.target.value); setNoteError(false) }}
                  placeholder={t('notePlaceholder')}
                  rows={2}
                  className={`w-full rounded-md border px-2 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 dark:bg-gray-700 dark:text-gray-100 dark:placeholder:text-gray-500 ${
                    noteError ? 'border-red-400 dark:border-red-500' : 'border-gray-300 dark:border-gray-600'
                  }`}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      handleNoteSubmit()
                    }
                  }}
                />
                {noteError && (
                  <p className="mt-0.5 text-[11px] text-red-500 dark:text-red-400">{t('noteRequiredError')}</p>
                )}
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={handleNoteCancel}
                    className="flex-1 rounded-md border border-gray-300 px-2 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                  >
                    {t('cancel', { ns: 'common' })}
                  </button>
                  <button
                    onClick={handleNoteSubmit}
                    className="flex-1 rounded-md bg-brand-600 px-2 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
                  >
                    {t('save', { ns: 'common' })}
                  </button>
                </div>
              </div>
            ) : (
              <>
                {(['confirmed', 'tentative', 'declined'] as const)
                  .filter((s) => s !== 'tentative' || allowMaybe)
                  .map((status) => {
                  const style = statusStyles[status]
                  // Guests can't confirm when full (they'll be waitlisted server-side)
                  // Licenced players CAN confirm when full (server bumps a guest)
                  const isGuestForTeam = teamId ? isGuestIn(teamId) : false
                  const isDisabledConfirmed = status === 'confirmed' && isFull && isGuestForTeam && effectiveStatus !== 'confirmed'

                  return (
                    <button
                      key={status}
                      role="menuitem"
                      onClick={() => !isDisabledConfirmed && handleSelect(status)}
                      disabled={isDisabledConfirmed}
                      className={`flex w-full items-center gap-2 px-3 py-3 text-left text-sm transition-colors sm:py-2 ${
                        isDisabledConfirmed
                          ? 'cursor-not-allowed opacity-40'
                          : 'hover:bg-gray-100 dark:hover:bg-gray-700'
                      } ${
                        effectiveStatus === status ? 'font-medium' : ''
                      } ${style.text}`}
                    >
                      {style.icon} {statusLabels[status]}
                      {isDisabledConfirmed && (
                        <span className="text-[10px] opacity-60">({t('waitlistHint')})</span>
                      )}
                    </button>
                  )
                })}

                {/* Guest counter — shown when confirmed or tentative */}
                {effectiveStatus && effectiveStatus !== 'declined' && (
                  <div className="border-t px-3 py-2 dark:border-gray-700">
                    <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">{t('guests')}</p>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleGuestChange(-1)}
                        disabled={guestCount <= 0}
                        aria-label={t('decreaseGuests', { defaultValue: 'Remove guest' })}
                        className="flex h-7 w-7 items-center justify-center rounded-md bg-gray-100 text-sm font-medium text-gray-700 hover:bg-gray-200 disabled:opacity-30 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                      >
                        −
                      </button>
                      <span className="min-w-[1.5rem] text-center text-sm font-medium text-gray-900 dark:text-gray-100" aria-live="polite">
                        {guestCount}
                      </span>
                      <button
                        onClick={() => handleGuestChange(1)}
                        aria-label={t('increaseGuests', { defaultValue: 'Add guest' })}
                        className="flex h-7 w-7 items-center justify-center rounded-md bg-gray-100 text-sm font-medium text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                      >
                        +
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}

    </div>
  )
}
