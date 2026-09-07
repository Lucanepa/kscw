import { useState, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '@/components/Modal'
import LocationCombobox from '@/components/LocationCombobox'
import { useAuth } from '../../hooks/useAuth'
import { useAdminMode } from '../../hooks/useAdminMode'
import { useMutation } from '../../hooks/useMutation'
import { useCollection } from '../../lib/query'
import { logActivity } from '../../utils/logActivity'
import { parseRespondByTime, toUtcIsoFromDatetimeLocal, todayLocal } from '../../utils/dateHelpers'
import { Button } from '@/components/ui/button'
import { FormInput, FormTextarea, FormField } from '@/components/FormField'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import DatePicker from '@/components/ui/DatePicker'
import { Switch } from '@/components/ui/switch'
import { MeetingTimeSelect } from '@/components/MeetingTimeSelect'
import type { Training, Team, Hall, HallSlot, SlotClaim, TeamSettings } from '../../types'
import type { RecurringEditScope } from './RecurringEditDialog'
import { fetchAllItems, fetchItem, updateRecord, flattenM2MTeams } from '../../lib/api'
import { asObj, relId } from '../../utils/relations'

// day_of_week in DB: 0=Mon, 1=Tue, ..., 6=Sun
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

/** Convert JS Date.getDay() (0=Sun) to DB day_of_week (0=Mon) */
function jsToDbDay(jsDay: number): number {
  return (jsDay + 6) % 7
}

interface SlotOption {
  key: string        // 'slot-{id}' or 'claim-{id}'
  label: string
  startTime: string
  endTime: string
  hallId: string
  hallSlotId: string // only for regular slots
  type: 'regular' | 'claimed'
}

interface TrainingFormProps {
  open: boolean
  training?: Training | null
  editScope?: RecurringEditScope
  defaultTeamId?: string | null
  /** Preset `is_trial` when creating a new training (e.g. from the "+ New trial training" button). */
  defaultIsTrial?: boolean
  onSave: () => void
  onCancel: () => void
}

export default function TrainingForm({ open, training, editScope = 'this', defaultTeamId, defaultIsTrial = false, onSave, onCancel }: TrainingFormProps) {
  const { t } = useTranslation('trainings')
  const { t: tc } = useTranslation('common')
  const { create, update, isLoading: isMutating } = useMutation<Training>('trainings')
  const { hasAdminAccessToTeam, coachTeamIds } = useAuth()
  const { effectiveIsAdmin } = useAdminMode()

  const { data: allTeamsRaw } = useCollection<Team>('teams', { filter: { active: { _eq: true } }, sort: ['name'], limit: 50 })
  const allTeams = allTeamsRaw ?? []
  const { data: hallsRaw } = useCollection<Hall>('halls', { sort: ['name'], limit: 50 })
  const halls = hallsRaw ?? []

  // Non-admin coaches only see their own teams; admins in admin mode see all teams they have access to
  const teams = useMemo(
    () => allTeams.filter((t) => (effectiveIsAdmin && hasAdminAccessToTeam(t.id)) || coachTeamIds.includes(t.id)),
    [allTeams, effectiveIsAdmin, hasAdminAccessToTeam, coachTeamIds],
  )

  const [teamId, setTeamId] = useState('')
  const [date, setDate] = useState('')
  const [startTime, setStartTime] = useState('')
  const [endTime, setEndTime] = useState('')
  const [hallId, setHallId] = useState('')
  const [hallName, setHallName] = useState('')
  const [notes, setNotes] = useState('')
  const [cancelled, setCancelled] = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  const [respondBy, setRespondBy] = useState('')
  const [respondByTime, setRespondByTime] = useState('')
  const [minParticipants, setMinParticipants] = useState('')
  const [maxParticipants, setMaxParticipants] = useState('')
  const [requireNoteIfAbsent, setRequireNoteIfAbsent] = useState(false)
  const [autoCancelOnMin, setAutoCancelOnMin] = useState(false)
  const [excludedGuestLevels, setExcludedGuestLevels] = useState<number[]>([])
  const [respondByDefaultDays, setRespondByDefaultDays] = useState<number | null>(null)
  const [autoConfirmRsvp, setAutoConfirmRsvp] = useState<boolean | null>(null)
  const [teamAutoConfirmDefault, setTeamAutoConfirmDefault] = useState(false)
  const [isTrial, setIsTrial] = useState(false)
  const [meetingOffset, setMeetingOffset] = useState<number | null>(10)
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  // Slot mode state
  const [slotMode, setSlotMode] = useState<'auto' | 'manual'>('auto')
  const [selectedSlotKey, setSelectedSlotKey] = useState('')

  // Track the teamId for which defaults were last applied (new training only)
  const defaultsAppliedForTeam = useRef<string | null>(null)

  // The team's recurring training slots + its active claims. These were two
  // `fetchAllItems` calls in an un-flagged effect writing `useState<[]>`, so an
  // empty list meant BOTH "not fetched yet" and "this team has no slot" — the
  // form asserted "No hall slot for this day" for the whole round-trip — and a
  // team A→B switch kept A's rows on screen (and could auto-apply A's times to
  // B's training) until B's landed. Keyed queries fix both halves: `data` is
  // `undefined` rather than the previous team's rows while a new team loads,
  // and the fetch flags tell "unknown" apart from "none".
  const { data: teamSlotsRaw, isFetching: slotsFetching, isPending: slotsPending, isPlaceholderData: slotsStale } = useCollection<HallSlot>('hall_slots', {
    filter: { _and: [{ teams: { teams_id: { _eq: teamId } } }, { slot_type: { _eq: 'training' } }, { recurring: { _eq: true } }] },
    sort: ['day_of_week', 'start_time'],
    fields: ['*', 'teams.teams_id'],
    all: true,
    enabled: !!teamId,
  })
  const { data: teamClaimsRaw, isFetching: claimsFetching, isPending: claimsPending, isPlaceholderData: claimsStale } = useCollection<SlotClaim>('slot_claims', {
    filter: { _and: [{ claimed_by_team: { _eq: teamId } }, { status: { _eq: 'active' } }, { date: { _gte: todayLocal() } }] },
    sort: ['date', 'start_time'],
    all: true,
    enabled: !!teamId,
  })
  // Must stay memoised: `slotOptions` below depends on these by identity and the
  // render-phase auto-select compares `prevSlotOptions` by identity — a fresh
  // `[]` on every render would setState on every render (React #301).
  const teamSlots = useMemo(() => flattenM2MTeams(teamSlotsRaw ?? []), [teamSlotsRaw])
  const teamClaims = useMemo<SlotClaim[]>(() => teamClaimsRaw ?? [], [teamClaimsRaw])
  // `isPending` also covers the frame before a newly keyed fetch is marked
  // in-flight. It goes false on error too, so a FAILED fetch falls back to the
  // real "no slot" panel instead of a permanent skeleton — the same fail-open
  // the old `.catch(() => setTeamSlots([]))` had.
  // ⚠ `isPlaceholderData` is load-bearing, not belt-and-braces. src/lib/query.tsx:83
  // sets `placeholderData: keepPreviousData` GLOBALLY, so on a team A→B switch these
  // queries hand back team A's rows — not undefined. Without this flag `slotOptions`
  // would briefly describe the previous team, and the auto-apply below would write
  // that team's start time, end time and hall into this form.
  const slotsLoading =
    !!teamId && (slotsFetching || claimsFetching || slotsPending || claimsPending || slotsStale || claimsStale)

  // Pre-fill defaults from team settings when creating a new training and teamId changes
  useEffect(() => {
    // Only apply defaults for new trainings (not edits)
    if (training) return
    if (!teamId) return
    // Don't re-apply for the same team
    if (defaultsAppliedForTeam.current === teamId) return

    defaultsAppliedForTeam.current = teamId
    fetchItem<{ features_enabled: TeamSettings }>('teams', teamId, { fields: ['features_enabled'] })
      .then((team) => {
        const s = team.features_enabled ?? {}
        if (s.training_min_participants !== undefined) {
          setMinParticipants(String(s.training_min_participants))
        }
        if (s.training_auto_cancel_on_min !== undefined) {
          setAutoCancelOnMin(s.training_auto_cancel_on_min)
        }
        if (s.training_require_note_if_absent !== undefined) {
          setRequireNoteIfAbsent(s.training_require_note_if_absent)
        }
        // respond_by is a date in TrainingForm — store days offset for use when date is set
        if (s.training_respond_by_days !== undefined) {
          setRespondByDefaultDays(s.training_respond_by_days)
        }
        setTeamAutoConfirmDefault(s.training_auto_confirm === true)
      })
      .catch(() => { /* silently ignore */ })
  }, [teamId, training])

  // For edit mode: load team default so the hint label is correct
  useEffect(() => {
    if (!training || !teamId) return
    fetchItem<{ features_enabled: TeamSettings }>('teams', teamId, { fields: ['features_enabled'] })
      .then((team) => {
        const s = team.features_enabled ?? {}
        setTeamAutoConfirmDefault(s.training_auto_confirm === true)
      })
      .catch(() => { /* silent */ })
  }, [training, teamId])

  // Build matching slot options for the selected date
  const slotOptions = useMemo<SlotOption[]>(() => {
    if (!teamId || !date || slotMode === 'manual') return []
    const dayOfWeek = jsToDbDay(new Date(date).getDay())

    const regularOptions: SlotOption[] = teamSlots
      .filter((s) => {
        if (s.day_of_week !== dayOfWeek) return false
        if (s.valid_from && date < s.valid_from.split(' ')[0]) return false
        if (s.valid_until && date > s.valid_until.split(' ')[0]) return false
        return true
      })
      .map((s) => ({
        key: `slot-${s.id}`,
        label: `${tc(DAY_KEYS[s.day_of_week])} ${s.start_time.slice(0, 5)}–${s.end_time.slice(0, 5)}${asObj<Hall>(s.hall)?.name ? `, ${asObj<Hall>(s.hall)!.name}` : ''}`,
        startTime: s.start_time,
        endTime: s.end_time,
        hallId: s.hall,
        hallSlotId: s.id,
        type: 'regular',
      }))

    const claimOptions: SlotOption[] = teamClaims
      .filter((c) => c.date.split(' ')[0] === date)
      .map((c) => ({
        key: `claim-${c.id}`,
        label: `${c.start_time.slice(0, 5)}–${c.end_time.slice(0, 5)}${asObj<Hall>(c.hall)?.name ? `, ${asObj<Hall>(c.hall)!.name}` : ''}`,
        startTime: c.start_time,
        endTime: c.end_time,
        hallId: c.hall,
        hallSlotId: '',
        type: 'claimed',
      }))

    return [...regularOptions, ...claimOptions]
  }, [teamId, date, slotMode, teamSlots, teamClaims, tc])

  // Auto-select slot when options change. Adjust-state-during-render, keyed on
  // the `slotOptions` identity exactly like the old effect's single dependency
  // (`slotMode` / `selectedSlotKey` are still read as latest values, not deps).
  // `prevSlotOptions` starts as null so this also fires on the first render,
  // mirroring the old effect's mount run.
  // Held back while the slots/claims are in flight: an empty `slotOptions` then
  // means "unknown", and acting on it used to clear a seeded selection and, on a
  // team switch, overwrite the form's times/hall from the PREVIOUS team's slot.
  // Skipping the comparison leaves `prevSlotOptions` stale, so it fires exactly
  // once when the real rows land.
  const [prevSlotOptions, setPrevSlotOptions] = useState<SlotOption[] | null>(null)
  if (!slotsLoading && prevSlotOptions !== slotOptions) {
    setPrevSlotOptions(slotOptions)
    if (slotMode !== 'auto' || slotOptions.length === 0) {
      if (slotMode === 'auto') setSelectedSlotKey('')
    } else if (selectedSlotKey && slotOptions.some((o) => o.key === selectedSlotKey)) {
      // Current selection is still valid — keep it
    } else if (slotOptions.length === 1) {
      // Auto-select if exactly one option
      applySlot(slotOptions[0])
    } else {
      setSelectedSlotKey('')
    }
  }

  function applySlot(option: SlotOption) {
    setSelectedSlotKey(option.key)
    setStartTime(option.startTime)
    setEndTime(option.endTime)
    setHallId(option.hallId)
  }

  function switchToManual() {
    setSlotMode('manual')
    setSelectedSlotKey('')
  }

  function switchToAuto() {
    setSlotMode('auto')
    // Will re-trigger auto-select via the effect above
  }

  // Seed the form from `training` (edit) or the create-mode defaults. This was a
  // `useEffect` on [training, open]; it is pure prop→state seeding, so it now
  // runs during render (React's adjust-state-during-render). `prevSeed` starts
  // as null so it also fires on the first render, mirroring the old effect's
  // mount run — which is load-bearing (it applies `defaultTeamId` / `defaultIsTrial`).
  const [prevSeed, setPrevSeed] = useState<{ training: Training | null | undefined; open: boolean } | null>(null)
  if (prevSeed === null || prevSeed.training !== training || prevSeed.open !== open) {
    setPrevSeed({ training, open })
    if (training) {
      setTeamId(relId(training.team))
      setDate(training.date.split(' ')[0])
      setStartTime(training.start_time)
      setEndTime(training.end_time)
      setHallId(training.hall_name ? '__other__' : relId(training.hall))
      setHallName(training.hall_name ?? '')
      setNotes(training.notes ?? '')
      setCancelled(training.cancelled)
      setCancelReason(training.cancel_reason ?? '')
      const rbParsed = parseRespondByTime(training.respond_by, training.start_time)
      setRespondBy(rbParsed?.date ?? '')
      setRespondByTime(rbParsed?.time ?? '')
      setMinParticipants(training.min_participants ? String(training.min_participants) : '')
      setMaxParticipants(training.max_participants ? String(training.max_participants) : '')
      setRequireNoteIfAbsent(!!training.require_note_if_absent)
      setAutoCancelOnMin(!!training.auto_cancel_on_min)
      const rawExcluded = (training as Training & { excluded_guest_levels?: unknown }).excluded_guest_levels
      const parsedExcluded = Array.isArray(rawExcluded)
        ? rawExcluded
        : typeof rawExcluded === 'string' ? (() => { try { const v = JSON.parse(rawExcluded); return Array.isArray(v) ? v : [] } catch { return [] } })() : []
      setExcludedGuestLevels(parsedExcluded.map((n: unknown) => Number(n)).filter((n: number) => [1, 2, 3].includes(n)))
      const rawAcr = (training as Training).auto_confirm_rsvp
      setAutoConfirmRsvp(rawAcr === true ? true : rawAcr === false ? false : null)
      setIsTrial(!!training.is_trial)
      setMeetingOffset(training.meeting_offset_minutes ?? null)
      // Edit mode: if training has a hall_slot, start in auto mode with it pre-selected
      if (training.hall_slot) {
        setSlotMode('auto')
        setSelectedSlotKey(`slot-${training.hall_slot}`)
      } else {
        setSlotMode('manual')
        setSelectedSlotKey('')
      }
    } else {
      setTeamId(defaultTeamId ?? '')
      setDate('')
      setStartTime('')
      setEndTime('')
      setHallId('')
      setHallName('')
      setNotes('')
      setCancelled(false)
      setCancelReason('')
      setRespondBy('')
      setRespondByTime('')
      setMinParticipants('')
      setMaxParticipants('')
      setRequireNoteIfAbsent(false)
      setAutoCancelOnMin(false)
      setExcludedGuestLevels([])
      setRespondByDefaultDays(null)
      setAutoConfirmRsvp(null)
      setTeamAutoConfirmDefault(false)
      setIsTrial(defaultIsTrial)
      setSlotMode('auto')
      setSelectedSlotKey('')
    }
    setError('')
  }

  // The create-mode half of the seeding above also cleared the "defaults already
  // applied" guard. That is a ref write, which must not happen during render, so
  // it stays in an effect — placed exactly where the old seeding effect was, so
  // it still runs AFTER the team-defaults effect within the same commit (the
  // original ordering: the guard was only observed as cleared on the next pass).
  useEffect(() => {
    if (!training) defaultsAppliedForTeam.current = null
  }, [training, open])

  // When a date is selected on a new training, apply respond_by offset from team
  // defaults. Adjust-state-during-render on the same three values the old effect
  // used as deps; its mount run was a no-op (`date` starts empty).
  const [prevRespondBySeed, setPrevRespondBySeed] = useState({ date, respondByDefaultDays, respondBy })
  if (
    prevRespondBySeed.date !== date ||
    prevRespondBySeed.respondByDefaultDays !== respondByDefaultDays ||
    prevRespondBySeed.respondBy !== respondBy
  ) {
    setPrevRespondBySeed({ date, respondByDefaultDays, respondBy })
    if (
      !training &&
      date &&
      respondByDefaultDays !== null &&
      respondByDefaultDays > 0 &&
      // Only set if respondBy hasn't been manually set yet
      !respondBy
    ) {
      const d = new Date(date + 'T00:00:00')
      d.setDate(d.getDate() - respondByDefaultDays)
      setRespondBy(d.toISOString().slice(0, 10))
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (!teamId || !date || !startTime || !endTime) {
      setError(tc('required'))
      return
    }

    // Resolve hall_slot relation: only for regular slots in auto mode.
    // Coerce empty-string IDs to null — Postgres rejects `""` for an integer
    // FK ("invalid input syntax for type integer", WIEDISYNC-3N) and an
    // empty SlotOption.hallSlotId is semantically "no slot" anyway.
    const activeSlot = slotOptions.find((o) => o.key === selectedSlotKey)
    const hallSlotId = slotMode === 'auto' && activeSlot?.type === 'regular' && activeSlot.hallSlotId
      ? activeSlot.hallSlotId
      : null

    const data = {
      team: teamId,
      date,
      start_time: startTime,
      end_time: endTime,
      hall: hallId === '__other__' ? null : (hallId || null),
      hall_name: hallId === '__other__' ? hallName : '',
      hall_slot: hallSlotId,
      notes,
      cancelled,
      cancel_reason: cancelled ? cancelReason : '',
      respond_by: respondBy
        ? toUtcIsoFromDatetimeLocal(`${respondBy}T${respondByTime || startTime || '23:59'}`)
        : null,
      min_participants: minParticipants ? Number(minParticipants) : null,
      max_participants: maxParticipants ? Number(maxParticipants) : null,
      require_note_if_absent: requireNoteIfAbsent,
      auto_cancel_on_min: autoCancelOnMin,
      excluded_guest_levels: excludedGuestLevels,
      auto_confirm_rsvp: autoConfirmRsvp,
      is_trial: isTrial,
      meeting_offset_minutes: meetingOffset,
    }

    setIsLoading(true)
    try {
      if (training) {
        await update(training.id, data)

        // Bulk update siblings if editing recurring
        if (editScope !== 'this' && training.hall_slot) {
          await bulkUpdateSiblings(training, data)
        }
      } else {
        await create(data)
      }
      onSave()
    } catch {
      setError(tc('errorSaving'))
    } finally {
      setIsLoading(false)
    }
  }

  async function bulkUpdateSiblings(
    source: Training,
    data: Record<string, unknown>,
  ) {
    // Fields to propagate (exclude date-specific fields)
    const bulkData: Record<string, unknown> = {
      start_time: data.start_time,
      end_time: data.end_time,
      hall: data.hall,
      notes: data.notes,
      respond_by: data.respond_by,
      min_participants: data.min_participants,
      max_participants: data.max_participants,
      require_note_if_absent: data.require_note_if_absent,
      auto_cancel_on_min: data.auto_cancel_on_min,
      excluded_guest_levels: data.excluded_guest_levels,
      auto_confirm_rsvp: data.auto_confirm_rsvp,
      meeting_offset_minutes: data.meeting_offset_minutes,
    }

    // Find sibling trainings with same hall_slot, excluding the one we already updated
    const filter = { _and: [{ hall_slot: { _eq: source.hall_slot } }, { id: { _neq: source.id } }, { date: { _gte: todayLocal() } }] }

    // Resolve the siblings to update: 'same_day' keeps only the source's weekday
    // (no day-of-week filter in Directus → fetch all + filter client-side); the
    // default ('all recurring') updates every future sibling sharing the slot.
    const allSiblings = await fetchAllItems<Training>('trainings', {
      filter,
      sort: ['date'],
    })
    const siblings = editScope === 'same_day'
      ? allSiblings.filter((t) => new Date(t.date).getDay() === new Date(source.date).getDay())
      : allSiblings

    // Apply in parallel chunks instead of a serial await loop (an "all recurring"
    // edit was dozens of sequential PATCHes). allSettled so one failed sibling
    // doesn't abort the rest of the series; a failure is still surfaced so the
    // user isn't left thinking every occurrence saved.
    const CHUNK_SIZE = 10
    let failures = 0
    for (let i = 0; i < siblings.length; i += CHUNK_SIZE) {
      const results = await Promise.allSettled(
        siblings.slice(i, i + CHUNK_SIZE).map(async (sibling) => {
          await updateRecord('trainings', sibling.id, bulkData)
          logActivity('update', 'trainings', sibling.id, bulkData)
        }),
      )
      failures += results.filter((r) => r.status === 'rejected').length
    }
    if (failures > 0) {
      throw new Error(`bulkUpdateSiblings: ${failures} sibling update(s) failed`)
    }
  }

  const scopeLabel = editScope === 'all'
    ? t('editAllRecurring')
    : editScope === 'same_day'
      ? t('editSameDay')
      : ''

  const loading = isLoading || isMutating

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={training ? t('editTraining') : t('newTraining')}
      size="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {training && editScope !== 'this' && (
          <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
            {scopeLabel}
          </div>
        )}

        <FormField label={tc('team')}>
          <Select value={teamId} onValueChange={setTeamId}>
            <SelectTrigger className="min-h-[44px]">
              <SelectValue placeholder={tc('select')} />
            </SelectTrigger>
            <SelectContent>
              {teams.map((t) => (
                <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>

        <DatePicker
          label={tc('date')}
          value={date}
          onChange={setDate}
        />

        {/* Slot mode toggle — only show when team has any configured hall slots.
            Kept mounted (disabled + dimmed) while the slots are still loading so
            it does not INSERT itself under a thumb already aiming at the date
            picker or the time fields below. */}
        {teamId && (slotsLoading || teamSlots.length > 0) && (
          <div
            className={`inline-flex w-full rounded-lg bg-gray-100 p-1 dark:bg-gray-800 ${slotsLoading ? 'opacity-60' : ''}`}
            aria-busy={slotsLoading}
          >
            <button
              type="button"
              onClick={switchToAuto}
              disabled={slotsLoading}
              className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${
                slotMode === 'auto'
                  ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-gray-100'
                  : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200'
              }`}
            >
              {t('slotModeAuto')}
            </button>
            <button
              type="button"
              onClick={switchToManual}
              disabled={slotsLoading}
              className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${
                slotMode === 'manual'
                  ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-gray-100'
                  : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200'
              }`}
            >
              {t('slotModeManual')}
            </button>
          </div>
        )}

        {/* Slot mode indicator — auto-mode informational box (no inline switch link, toggle handles that) */}
        {slotMode === 'auto' && teamId && date && (
          <div>
            {/* `slotOptions.length === 0` only means "no slot on this weekday"
                once the team's slots and claims have actually been fetched. */}
            {slotsLoading ? (
              <div className="h-9 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" aria-hidden="true" />
            ) : slotOptions.length === 0 ? (
              <div className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                {t('noSlotForDay')}
              </div>
            ) : slotOptions.length === 1 ? (
              <div className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800 dark:bg-green-900/20 dark:text-green-300">
                {slotOptions[0].type === 'claimed' ? t('claimedSlot') : t('slotDetected')}: {slotOptions[0].label}
              </div>
            ) : (
              <div className="space-y-2 rounded-lg bg-green-50 px-3 py-2 dark:bg-green-900/20">
                <div className="text-sm text-green-800 dark:text-green-300">{t('slotDetected')}</div>
                {slotOptions.map((opt) => (
                  <label key={opt.key} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                    <input
                      type="radio"
                      name="slotOption"
                      checked={selectedSlotKey === opt.key}
                      onChange={() => applySlot(opt)}
                      className="text-brand-500"
                    />
                    <span>
                      {opt.type === 'claimed' ? `${t('claimedSlot')}: ` : `${t('regularSlot')}: `}
                      {opt.label}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Time and hall fields — read-only when a slot is active */}
        {(() => {
          // Also treated as slot-governed while the slots are still loading and a
          // date is set: until they land it is unknown whether a slot owns these
          // fields, and a slot that lands overwrites whatever was typed here.
          const slotActive = slotMode === 'auto' && (!!selectedSlotKey || (slotsLoading && !!date))
          return (
            <>
              <div className="grid grid-cols-2 gap-4">
                <FormInput
                  label={tc('from')}
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  required
                  readOnly={slotActive}
                  className={slotActive ? 'opacity-60' : ''}
                />
                <FormInput
                  label={tc('to')}
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  required
                  readOnly={slotActive}
                  className={slotActive ? 'opacity-60' : ''}
                />
              </div>

              <div>
                <FormField label={tc('hall')}>
                  <Select value={hallId} onValueChange={(v) => { setHallId(v); if (v !== '__other__') setHallName('') }} disabled={slotActive}>
                    <SelectTrigger className={`min-h-[44px] ${slotActive ? 'opacity-60' : ''}`}>
                      <SelectValue placeholder={tc('select')} />
                    </SelectTrigger>
                    <SelectContent>
                      {halls.map((h) => (
                        <SelectItem key={h.id} value={h.id}>{h.name}</SelectItem>
                      ))}
                      <SelectItem value="__other__">{tc('otherHall')}</SelectItem>
                    </SelectContent>
                  </Select>
                </FormField>
                {hallId === '__other__' && (
                  <div className="mt-2">
                    <LocationCombobox
                      value={hallName}
                      onChange={setHallName}
                      onSelect={(r) => setHallName(r.name)}
                      placeholder={tc('hallNamePlaceholder')}
                    />
                  </div>
                )}
              </div>
            </>
          )
        })()}

        <div className="grid grid-cols-2 gap-4">
          <FormInput
            label={t('minParticipants')}
            type="number"
            value={minParticipants}
            onChange={(e) => setMinParticipants(e.target.value)}
            min={0}
          />
          <FormInput
            label={t('maxParticipants')}
            type="number"
            value={maxParticipants}
            onChange={(e) => setMaxParticipants(e.target.value)}
            min={0}
          />
        </div>

        <MeetingTimeSelect
          value={meetingOffset}
          onChange={setMeetingOffset}
          startClock={startTime}
        />

        {minParticipants && Number(minParticipants) > 0 && (
          <div className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
            <Switch checked={autoCancelOnMin} onCheckedChange={setAutoCancelOnMin} className="mt-0.5" />
            <div>
              <span>{t('autoCancelOnMin')}</span>
              <p className="text-xs text-gray-500 dark:text-gray-400">{t('autoCancelOnMinHint')}</p>
            </div>
          </div>
        )}

        <FormTextarea
          label={tc('notes')}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
        />

        <div className="space-y-2">
          <DatePicker
            label={t('respondBy')}
            value={respondBy}
            onChange={(v) => {
              setRespondBy(v)
              if (v && !respondByTime) setRespondByTime(startTime?.slice(0, 5) || '')
            }}
            max={date}
            helperText={t('respondByHint')}
          />
          {respondBy && (
            <FormInput
              label={t('respondByTime')}
              type="time"
              value={respondByTime || startTime?.slice(0, 5) || ''}
              onChange={(e) => setRespondByTime(e.target.value)}
            />
          )}
        </div>

        <div className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <Switch checked={requireNoteIfAbsent} onCheckedChange={setRequireNoteIfAbsent} />
          <div>
            <span>{t('requireNoteIfAbsent', { ns: 'participation' })}</span>
            <p className="text-xs text-muted-foreground">{t('requireNoteIfAbsentHint', { ns: 'participation' })}</p>
          </div>
        </div>

        <div className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <Switch checked={isTrial} onCheckedChange={setIsTrial} />
          <div>
            <span>{t('isTrialTraining')}</span>
            <p className="text-xs text-muted-foreground">{t('isTrialTrainingHint')}</p>
          </div>
        </div>

        <div className="space-y-1.5 text-sm text-gray-700 dark:text-gray-300">
          <div>
            <span className="font-medium">{t('excludedGuestLevels')}</span>
            <p className="text-xs text-muted-foreground">{t('excludedGuestLevelsHint')}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setExcludedGuestLevels((prev) => prev.length === 3 ? [] : [1, 2, 3])}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                excludedGuestLevels.length === 3
                  ? 'border-orange-500 bg-orange-100 text-orange-700 dark:border-orange-600 dark:bg-orange-900/30 dark:text-orange-300'
                  : 'border-gray-300 bg-transparent text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800'
              }`}
            >
              {t('excludeAllGuests')}
            </button>
            {[1, 2, 3].map((lvl) => {
              const active = excludedGuestLevels.includes(lvl)
              return (
                <button
                  key={lvl}
                  type="button"
                  onClick={() => setExcludedGuestLevels((prev) => active ? prev.filter((l) => l !== lvl) : [...prev, lvl].sort())}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                    active
                      ? 'border-orange-500 bg-orange-100 text-orange-700 dark:border-orange-600 dark:bg-orange-900/30 dark:text-orange-300'
                      : 'border-gray-300 bg-transparent text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800'
                  }`}
                >
                  G{lvl}
                </button>
              )
            })}
          </div>
        </div>

        <div className="space-y-1.5 text-sm text-gray-700 dark:text-gray-300">
          <div>
            <span className="font-medium">{t('autoConfirmRsvp')}</span>
            <p className="text-xs text-muted-foreground">
              {t('autoConfirmRsvpHint', { default: teamAutoConfirmDefault ? t('on', { defaultValue: 'On' }) : t('off', { defaultValue: 'Off' }) })}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {([
              { value: null, label: t('useTeamDefault') },
              { value: true, label: t('on', { defaultValue: 'On' }) },
              { value: false, label: t('off', { defaultValue: 'Off' }) },
            ] as { value: boolean | null; label: string }[]).map((opt) => {
              const active = autoConfirmRsvp === opt.value
              return (
                <button
                  key={String(opt.value)}
                  type="button"
                  onClick={() => setAutoConfirmRsvp(opt.value)}
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

        {training && (
          <div>
            <Button
              type="button"
              variant={cancelled ? 'destructive' : 'outline'}
              onClick={() => setCancelled(!cancelled)}
              className={!cancelled ? 'border-red-300 text-red-600 hover:bg-red-50 hover:text-red-700 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20 dark:hover:text-red-300' : ''}
            >
              {cancelled ? t('trainingCancelled') : t('cancelTraining')}
            </Button>
            {cancelled && (
              <FormTextarea
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                rows={2}
                placeholder={t('cancelReason')}
                className="mt-2"
              />
            )}
          </div>
        )}

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="ghost" type="button" onClick={onCancel}>
            {tc('cancel')}
          </Button>
          <Button type="submit" loading={loading}>
            {loading ? tc('saving') : tc('save')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
