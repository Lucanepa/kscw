import { useState, useMemo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '@/components/Modal'
import { flattenM2MTeams } from '../../lib/api'
import { useAuth } from '../../hooks/useAuth'
import { useAdminMode } from '../../hooks/useAdminMode'
import { seasonEndDate } from '../../utils/season'
import { useCollection } from '../../lib/query'
import { formatDate, formatDateCompact, toISODate, toUtcIsoFromDatetimeLocal } from '../../utils/dateHelpers'
import { logActivity } from '../../utils/logActivity'
import type { HallSlot, HallClosure, Team, Hall } from '../../types'
import type { TeamSettings } from '../../types'
import TeamChip from '../../components/TeamChip'
import DatePicker from '@/components/ui/DatePicker'
import { Switch } from '@/components/ui/switch'
import { MeetingTimeSelect } from '@/components/MeetingTimeSelect'
import { createRecords, fetchAllItems, fetchItem } from '../../lib/api'
import { relId, asObj } from '../../utils/relations'

type SlotExpanded = HallSlot & {
  hall: Hall | string
}

interface RecurringTrainingModalProps {
  open: boolean
  onClose: () => void
  onGenerated: () => void
  selectedTeamId?: string | null
}

// May 31 of the current season — see src/utils/season.ts for the Jun 1 cutover.
const getSeasonEndDate = seasonEndDate

export default function RecurringTrainingModal({ open, onClose, onGenerated, selectedTeamId }: RecurringTrainingModalProps) {
  const { t } = useTranslation('trainings')
  const { t: tc } = useTranslation('common')

  const { hasAdminAccessToTeam, coachTeamIds } = useAuth()
  const { effectiveIsAdmin } = useAdminMode()

  // Local team picker state — used when no selectedTeamId is provided and user has 2+ teams
  const [localTeamId, setLocalTeamId] = useState<string | null>(null)
  const activeTeamId = selectedTeamId ?? localTeamId

  // Fetch teams the user can manage (for the team picker)
  const { data: teamsRaw } = useCollection<Team>('teams', {
    filter: { active: { _eq: true } },
    sort: ['name'],
    limit: 50,
  })
  const managedTeams = useMemo(() => {
    if (!teamsRaw) return []
    return teamsRaw.filter(t =>
      (effectiveIsAdmin && hasAdminAccessToTeam(t.id)) || coachTeamIds.includes(t.id),
    )
  }, [teamsRaw, effectiveIsAdmin, hasAdminAccessToTeam, coachTeamIds])

  // Show team picker when no external team is selected and user manages 2+ teams
  const needsTeamPicker = !selectedTeamId && managedTeams.length >= 2

  // Manual mode needs a concrete team even when the picker never shows — a
  // coach of exactly one team picks nothing.
  const soloTeamId = !selectedTeamId && managedTeams.length === 1 ? managedTeams[0].id : null
  const manualTeamId = activeTeamId ?? soloTeamId

  // Team name lookup for slot labels (flattenM2MTeams strips expanded objects to IDs)
  const teamNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const t of teamsRaw ?? []) map.set(t.id, t.name)
    return map
  }, [teamsRaw])

  const { data: allSlotsRaw } = useCollection<SlotExpanded>('hall_slots', {
    filter: { slot_type: { _eq: 'training' } },
    sort: ['day_of_week', 'start_time'],
    limit: 100,
    fields: ['*', 'hall.*', 'teams.teams_id'],
  })
  const allSlots = flattenM2MTeams(allSlotsRaw ?? [])

  // Filter by selected team, or fall back to coach's teams (non-admin)
  // Sort: current/past slots first (by valid_from asc), then future slots (by valid_from asc)
  const slots = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10)
    const scoped = activeTeamId
      ? allSlots.filter((s) => s.team?.includes(activeTeamId))
      : allSlots.filter((s) => s.team?.some(t => (effectiveIsAdmin && hasAdminAccessToTeam(t)) || coachTeamIds.includes(t)))
    // Expired slots are dead weight: every date they could offer is in the past,
    // so last season's Monday sat in this list next to the live one, generating
    // nothing. Indefinite slots and slots with no end date always stay.
    const filtered = scoped.filter((s) => s.indefinite || !s.valid_until || s.valid_until.slice(0, 10) >= today)
    return [...filtered].sort((a, b) => {
      if (a.day_of_week !== b.day_of_week) return a.day_of_week - b.day_of_week
      if (a.start_time !== b.start_time) return a.start_time.localeCompare(b.start_time)
      const aFuture = (a.valid_from?.slice(0, 10) || '') > today ? 1 : 0
      const bFuture = (b.valid_from?.slice(0, 10) || '') > today ? 1 : 0
      if (aFuture !== bFuture) return aFuture - bFuture
      return (a.valid_from || '').localeCompare(b.valid_from || '')
    })
  }, [activeTeamId, allSlots, effectiveIsAdmin, hasAdminAccessToTeam, coachTeamIds])

  const { data: hallsRaw } = useCollection<Hall>('halls', { sort: ['name'], limit: 50 })
  const halls = hallsRaw ?? []
  const { data: closuresRaw } = useCollection<HallClosure>('hall_closures', { all: true })
  const closures = closuresRaw ?? []

  const [selectedSlot, setSelectedSlot] = useState('')
  // 'slot' generates from a recurring `hall_slots` row; 'manual' is a free-form
  // series for a team that has no slot, or needs one outside its slots.
  const [mode, setMode] = useState<'slot' | 'manual'>('slot')
  const [manualDay, setManualDay] = useState(0)
  const [manualStart, setManualStart] = useState('18:00')
  const [manualEnd, setManualEnd] = useState('19:30')
  // Stamped with the team it was fetched for, so a team switch cannot briefly
  // filter the preview against the previous team's trainings while the new
  // fetch is still in flight.
  const [teamTrainings, setTeamTrainings] = useState<
    { teamId: string; rows: { date: string; start_time: string | null }[] } | null
  >(null)
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [untilSeasonEnd, setUntilSeasonEnd] = useState(false)
  const [hallId, setHallId] = useState('')
  const [notes, setNotes] = useState('')
  const [respondByAmount, setRespondByAmount] = useState('')
  const [respondByUnit, setRespondByUnit] = useState<'hours' | 'days' | 'weeks' | 'months'>('days')
  const [minParticipants, setMinParticipants] = useState('')
  const [maxParticipants, setMaxParticipants] = useState('')
  const [requireNoteIfAbsent, setRequireNoteIfAbsent] = useState(false)
  const [meetingOffset, setMeetingOffset] = useState<number | null>(10)
  const [autoCancelOnMin, setAutoCancelOnMin] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [generated, setGenerated] = useState(0)
  const [skipped, setSkipped] = useState(0)
  const [existingDates, setExistingDates] = useState<Set<string>>(new Set())
  const [done, setDone] = useState(false)

  // Track which team's defaults have been applied (stores teamId or empty string)
  const defaultsAppliedFor = useRef('')

  // Pre-fill from team defaults when a team is selected (via prop or local picker)
  useEffect(() => {
    if (!open) {
      defaultsAppliedFor.current = ''
      return
    }
    if (!activeTeamId) return
    // Re-apply when team changes
    if (defaultsAppliedFor.current === activeTeamId) return

    defaultsAppliedFor.current = activeTeamId
    fetchItem<{ features_enabled: TeamSettings }>('teams', activeTeamId, { fields: ['features_enabled'] })
      .then((team) => {
        const s = team.features_enabled ?? {}
        if (s.training_respond_by_days !== undefined) {
          setRespondByAmount(String(s.training_respond_by_days))
          setRespondByUnit('days')
        }
        if (s.training_min_participants !== undefined) {
          setMinParticipants(String(s.training_min_participants))
        }
        if (s.training_auto_cancel_on_min !== undefined) {
          setAutoCancelOnMin(s.training_auto_cancel_on_min)
        }
        if (s.training_require_note_if_absent !== undefined) {
          setRequireNoteIfAbsent(s.training_require_note_if_absent)
        }
      })
      .catch(() => { /* silently ignore — defaults stay empty */ })
  }, [open, activeTeamId])

  function resetModalState() {
    setLocalTeamId(null)
    setSelectedSlot('')
    setMode('slot')
    setManualDay(0)
    setManualStart('18:00')
    setManualEnd('19:30')
    setTeamTrainings(null)
    setStartDate('')
    setEndDate('')
    setUntilSeasonEnd(false)
    setHallId('')
    setNotes('')
    setRespondByAmount('')
    setRespondByUnit('days')
    setMinParticipants('')
    setMaxParticipants('')
    setRequireNoteIfAbsent(false)
    setAutoCancelOnMin(false)
    setLoading(false)
    setError('')
    setGenerated(0)
    setSkipped(0)
    setExistingDates(new Set())
    setDone(false)
  }

  function handleClose() {
    resetModalState()
    onClose()
  }

  const slot = slots.find((s) => s.id === selectedSlot)

  // The series definition, whichever mode produced it. Everything downstream
  // (preview, duplicate check, payload) reads these instead of `slot`.
  const genTeamId = mode === 'slot' ? (slot?.team?.[0] ?? null) : manualTeamId
  const genDay = mode === 'slot' ? (slot?.day_of_week ?? null) : manualDay
  const genStart = mode === 'slot' ? (slot?.start_time ?? '') : manualStart
  const genEnd = mode === 'slot' ? (slot?.end_time ?? '') : manualEnd
  const genHallSlotId = mode === 'slot' ? (slot?.id ?? null) : null

  // No slot selected → no existing dates. React's adjust-state-during-render
  // pattern, replacing the `setExistingDates(new Set())` that used to run
  // synchronously inside the effect below.
  const slotId = slot?.id ?? null
  const [prevSlotId, setPrevSlotId] = useState<string | null>(slotId)
  if (prevSlotId !== slotId) {
    setPrevSlotId(slotId)
    if (!slot) setExistingDates(new Set())
  }

  // Fetch existing training dates for selected slot's team to prevent duplicates
  useEffect(() => {
    if (!slot) return
    const teamIds = Array.isArray(slot.team) ? slot.team : [slot.team]
    fetchAllItems<{ date: string }>('trainings', {
      filter: { _and: [{ team: { _in: teamIds } }, { hall_slot: { _eq: slot.id } }] },
      fields: ['date'],
    }).then((trainings) => {
      setExistingDates(new Set(trainings.map((t) => t.date.slice(0, 10))))
    }).catch(() => setExistingDates(new Set()))
  }, [slot?.id, slot?.team]) // eslint-disable-line react-hooks/exhaustive-deps

  // Manual mode has no `hall_slot` to key duplicates on, so the rule is "same
  // team, same date, same start time". Matched client-side because a
  // `start_time` filter would have to guess between the 'HH:MM' an <input
  // type=time> yields and the 'HH:MM:SS' Postgres stores.
  useEffect(() => {
    if (mode !== 'manual' || !manualTeamId) return
    const teamId = manualTeamId
    let cancelled = false
    fetchAllItems<{ date: string; start_time: string }>('trainings', {
      filter: { _and: [{ team: { _eq: teamId } }, { date: { _gte: toISODate(new Date()) } }] },
      fields: ['date', 'start_time'],
    })
      .then((rows) => { if (!cancelled) setTeamTrainings({ teamId, rows }) })
      .catch(() => { if (!cancelled) setTeamTrainings({ teamId, rows: [] }) })
    return () => { cancelled = true }
  }, [mode, manualTeamId])

  const takenDates = useMemo(() => {
    if (mode === 'slot') return existingDates
    // Not loaded yet, or loaded for another team → assume nothing is taken.
    // `handleGenerate` re-reads before writing, so a duplicate is skipped there.
    if (!manualTeamId || teamTrainings?.teamId !== manualTeamId) return new Set<string>()
    const hhmm = manualStart.slice(0, 5)
    return new Set(
      teamTrainings.rows
        .filter((tr) => (tr.start_time ?? '').slice(0, 5) === hhmm)
        .map((tr) => tr.date.slice(0, 10)),
    )
  }, [mode, existingDates, teamTrainings, manualTeamId, manualStart])

  // When slot changes, default the hall to the slot's hall
  const slotHallId = relId(slot?.hall)
  const effectiveHallId = hallId || slotHallId || ''

  const effectiveEndDate = untilSeasonEnd ? getSeasonEndDate() : endDate

  const previewDates = useMemo(() => {
    if (!genTeamId || genDay == null || !genStart || !genEnd) return []
    if (genEnd <= genStart) return []
    if (!startDate || !effectiveEndDate) return []
    const dates: string[] = []
    const today = toISODate(new Date())
    const start = new Date(startDate)
    const end = new Date(effectiveEndDate)
    // DB: 0=Mon..6=Sun → convert to JS: 0=Sun..6=Sat
    const targetJsDay = (genDay + 1) % 7
    const closureHallId = effectiveHallId || slotHallId || ''

    const current = new Date(start)
    // Advance to first matching day
    while (current.getDay() !== targetJsDay && current <= end) {
      current.setDate(current.getDate() + 1)
    }

    while (current <= end) {
      const dateStr = toISODate(current)
      // Never generate trainings in the past
      if (dateStr >= today) {
        // Skip dates where the hall is closed
        const isClosed = closures.some(
          (c) => c.hall === closureHallId && c.start_date <= dateStr && c.end_date >= dateStr,
        )
        if (!isClosed && !takenDates.has(dateStr)) dates.push(dateStr)
      }
      current.setDate(current.getDate() + 7)
    }
    return dates
  }, [genTeamId, genDay, genStart, genEnd, startDate, effectiveEndDate, effectiveHallId, slotHallId, closures, takenDates])

  function computeRespondBy(trainingDate: string, trainingStartTime: string): string {
    if (!respondByAmount) return ''
    const amount = Number(respondByAmount)
    if (!amount || amount <= 0) return ''
    const time = trainingStartTime || '23:59'
    // Start from the UTC instant that corresponds to the training's Zurich-local start
    const startUtc = new Date(toUtcIsoFromDatetimeLocal(`${trainingDate}T${time}`))
    switch (respondByUnit) {
      case 'hours': startUtc.setHours(startUtc.getHours() - amount); break
      case 'days': startUtc.setDate(startUtc.getDate() - amount); break
      case 'weeks': startUtc.setDate(startUtc.getDate() - amount * 7); break
      case 'months': startUtc.setMonth(startUtc.getMonth() - amount); break
    }
    return startUtc.toISOString()
  }

  /** Dates the team already has for this series — re-read right before the
   *  write so a parallel generation cannot double-book. */
  async function fetchTakenDates(): Promise<Set<string>> {
    if (mode === 'slot') {
      if (!slot) return new Set()
      const teamIds = Array.isArray(slot.team) ? slot.team : [slot.team]
      const existing = await fetchAllItems<{ date: string }>('trainings', {
        filter: { _and: [{ team: { _in: teamIds } }, { hall_slot: { _eq: slot.id } }] },
        fields: ['date'],
      })
      return new Set(existing.map((t) => t.date.slice(0, 10)))
    }
    if (!manualTeamId) return new Set()
    const rows = await fetchAllItems<{ date: string; start_time: string }>('trainings', {
      filter: { _and: [{ team: { _eq: manualTeamId } }, { date: { _gte: toISODate(new Date()) } }] },
      fields: ['date', 'start_time'],
    })
    const hhmm = manualStart.slice(0, 5)
    return new Set(
      rows.filter((r) => (r.start_time ?? '').slice(0, 5) === hhmm).map((r) => r.date.slice(0, 10)),
    )
  }

  async function handleGenerate() {
    if (!genTeamId || previewDates.length === 0) return
    setLoading(true)
    setError('')
    setGenerated(0)
    setSkipped(0)

    try {
      const existingSet = await fetchTakenDates()

      const skipCount = previewDates.filter((date) => existingSet.has(date)).length
      const datesToCreate = previewDates.filter((date) => !existingSet.has(date))

      // Create every occurrence in ONE batch request instead of N parallel POSTs
      // (a full-season generation was ~30 separate calls).
      let count = 0
      if (datesToCreate.length > 0) {
        const payloads = datesToCreate.map((date) => ({
          team: genTeamId,
          // null in manual mode — the series is not tied to a recurring slot,
          // so nothing frees it when a training is cancelled.
          hall_slot: genHallSlotId,
          date,
          start_time: genStart,
          end_time: genEnd,
          hall: effectiveHallId || null,
          cancelled: false,
          notes,
          respond_by: computeRespondBy(date, genStart) || null,
          min_participants: minParticipants ? Number(minParticipants) : null,
          max_participants: maxParticipants ? Number(maxParticipants) : null,
          require_note_if_absent: requireNoteIfAbsent,
          meeting_offset_minutes: meetingOffset,
        }))
        const created = await createRecords<{ id: string }>('trainings', payloads)
        created.forEach((rec, i) => {
          logActivity('create', 'trainings', rec.id, { team: genTeamId, date: datesToCreate[i], hall: effectiveHallId })
        })
        count = created.length
      }
      setGenerated(count)
      setSkipped(skipCount)
      setDone(true)
      onGenerated()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message
        : (err as { errors?: { message?: string }[] })?.errors?.[0]?.message ?? JSON.stringify(err)
      setError(`${tc('errorSaving')}: ${msg}`)
    } finally {
      setLoading(false)
    }
  }

  const inputCls = 'mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none'
  const labelCls = 'block text-sm font-medium text-gray-700 dark:text-gray-300'

  if (done) {
    // `slot.team` is flattened to bare ids by `flattenM2MTeams`, so this has to
    // go through the name lookup rather than `asObj`.
    const teamName = teamNameById.get(genTeamId ?? '') ?? ''
    const hallName = halls.find((h) => h.id === effectiveHallId)?.name ?? ''
    return (
      <Modal open={open} onClose={handleClose} title={t('recurringTitle')} size="sm">
        <div className="space-y-4 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
            <svg className="h-6 w-6 text-green-600 dark:text-green-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
          </div>
          <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('trainingsGenerated', { count: generated })}
          </p>
          <div className="space-y-1 text-sm text-gray-600 dark:text-gray-400">
            {teamName && <div className="flex justify-center"><TeamChip team={teamName} size="sm" /></div>}
            {hallName && <p>{hallName}</p>}
            {previewDates.length > 0 && (
              <p>{formatDate(previewDates[0])} — {formatDate(previewDates[previewDates.length - 1])}</p>
            )}
          </div>
          {skipped > 0 && (
            <p className="text-sm text-amber-600 dark:text-amber-400">
              {t('trainingsSkipped', { count: skipped })}
            </p>
          )}
          <div className="pt-2">
            <button
              onClick={handleClose}
              className="rounded-lg bg-brand-500 px-6 py-2 text-sm font-medium text-white hover:bg-brand-600"
            >
              {tc('close')}
            </button>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal open={open} onClose={handleClose} title={t('recurringTitle')} size="md">
      <div data-tour="recurring-setup" className="space-y-4">
        {needsTeamPicker && (() => {
          const vb = managedTeams.filter(t => t.sport === 'volleyball')
          const bb = managedTeams.filter(t => t.sport === 'basketball')
          const hasBoth = vb.length > 0 && bb.length > 0
          return (
            <div>
              <label className={labelCls}>{tc('team')}</label>
              <select
                value={localTeamId ?? ''}
                onChange={(e) => {
                  setLocalTeamId(e.target.value || null)
                  setSelectedSlot('')
                  setHallId('')
                  setStartDate('')
                  setEndDate('')
                }}
                className={inputCls}
              >
                <option value="">{tc('select')}</option>
                {hasBoth ? (
                  <>
                    <optgroup label="Volleyball">
                      {vb.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </optgroup>
                    <optgroup label="Basketball">
                      {bb.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </optgroup>
                  </>
                ) : (
                  managedTeams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)
                )}
              </select>
            </div>
          )
        })()}

        <div className="inline-flex w-full rounded-lg bg-gray-100 p-1 dark:bg-gray-800">
          {([
            ['slot', t('useSlot')],
            ['manual', t('enterManually')],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setMode(value)
                // Manual mode has no slot to seed the range from.
                if (value === 'manual' && !startDate) setStartDate(toISODate(new Date()))
              }}
              className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                mode === value
                  ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-gray-100'
                  : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === 'manual' && (
          <>
            <p className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-600 dark:bg-gray-800 dark:text-gray-400">
              {t('manualHint')}
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <label className={labelCls}>{t('weekday')}</label>
                <select
                  value={manualDay}
                  onChange={(e) => setManualDay(Number(e.target.value))}
                  className={inputCls}
                >
                  {['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((key, i) => (
                    <option key={key} value={i}>{tc(key)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelCls}>{t('manualStartTime')}</label>
                <input
                  type="time"
                  value={manualStart}
                  onChange={(e) => setManualStart(e.target.value)}
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>{t('manualEndTime')}</label>
                <input
                  type="time"
                  value={manualEnd}
                  onChange={(e) => setManualEnd(e.target.value)}
                  className={inputCls}
                />
              </div>
            </div>
            {manualEnd <= manualStart && (
              <p className="text-sm text-amber-600 dark:text-amber-400">{t('manualEndAfterStart')}</p>
            )}
          </>
        )}

        {mode === 'slot' && (
        <div>
          <label className={labelCls}>{t('selectSlot')}</label>
          <select
            value={selectedSlot}
            disabled={needsTeamPicker && !localTeamId}
            onChange={(e) => {
              const id = e.target.value
              setSelectedSlot(id)
              setHallId('')
              const picked = slots.find((s) => s.id === id)
              if (picked) {
                const today = toISODate(new Date())
                const validFrom = picked.valid_from?.slice(0, 10) || today
                setStartDate(validFrom < today ? today : validFrom)
                if (picked.indefinite) {
                  setUntilSeasonEnd(true)
                  setEndDate(getSeasonEndDate())
                } else if (picked.valid_until) {
                  setEndDate(picked.valid_until.slice(0, 10))
                  setUntilSeasonEnd(false)
                }
              }
            }}
            className={inputCls}
          >
            <option value="">{tc('select')}</option>
            {slots.map((s) => {
              const today = new Date().toISOString().slice(0, 10)
              const from = s.valid_from?.slice(0, 10) || ''
              const until = s.valid_until?.slice(0, 10) || ''
              const isFuture = from > today
              const hasEnd = !s.indefinite && until
              const dateSuffix = isFuture && hasEnd
                ? ` [${t('slotFrom')} ${formatDateCompact(from)} ${t('slotUntil')} ${formatDateCompact(until)}]`
                : isFuture
                  ? ` [${t('slotFrom')} ${formatDateCompact(from)}]`
                  : hasEnd
                    ? ` [${t('slotUntil')} ${formatDateCompact(until)}]`
                    : ''
              const teamLabel = activeTeamId ? '' : `${teamNameById.get(s.team?.[0] ?? '') ?? '?'} — `
              return (
                <option key={s.id} value={s.id}>
                  {teamLabel}{tc(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'][s.day_of_week])} {s.start_time.slice(0, 5)}–{s.end_time.slice(0, 5)} ({asObj<Hall>(s.hall)?.name ?? '?'}){dateSuffix}
                </option>
              )
            })}
          </select>
          {slots.length === 0 && (!needsTeamPicker || localTeamId) && (
            <p className="mt-2 text-sm text-amber-600 dark:text-amber-400">{t('noSlotsForTeam')}</p>
          )}
        </div>
        )}

        <div>
          <label className={labelCls}>{tc('hall')}</label>
          <select
            value={effectiveHallId}
            onChange={(e) => setHallId(e.target.value)}
            className={inputCls}
          >
            <option value="">{tc('select')}</option>
            {halls.map((h) => (
              <option key={h.id} value={h.id}>{h.name}</option>
            ))}
          </select>
        </div>

        <div className={`grid grid-cols-1 items-end gap-4 ${untilSeasonEnd ? 'sm:grid-cols-2' : 'sm:grid-cols-3'}`}>
          <DatePicker
            label={tc('from')}
            value={startDate}
            onChange={setStartDate}
            min={toISODate(new Date())}
          />
          {!untilSeasonEnd && (
            <DatePicker
              label={tc('to')}
              value={endDate}
              onChange={(v) => { setEndDate(v); setUntilSeasonEnd(false) }}
              min={startDate}
            />
          )}
          <div className="flex items-end">
            <div className="flex min-h-[44px] w-full items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300">
              <Switch
                checked={untilSeasonEnd}
                onCheckedChange={(checked) => {
                  setUntilSeasonEnd(checked)
                  if (checked) setEndDate(getSeasonEndDate())
                }}
              />
              {t('untilSeasonEnd')}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>{t('minParticipants')}</label>
            <input
              type="number"
              value={minParticipants}
              onChange={(e) => setMinParticipants(e.target.value)}
              min={0}
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>{t('maxParticipants')}</label>
            <input
              type="number"
              value={maxParticipants}
              onChange={(e) => setMaxParticipants(e.target.value)}
              min={0}
              className={inputCls}
            />
          </div>
        </div>

        <MeetingTimeSelect
          value={meetingOffset}
          onChange={setMeetingOffset}
          startClock={genStart || undefined}
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

        <div>
          <label className={labelCls}>{t('respondBy')}</label>
          <div className="mt-1 grid grid-cols-3 gap-2">
            <input
              type="number"
              value={respondByAmount}
              onChange={(e) => setRespondByAmount(e.target.value)}
              min={0}
              placeholder="0"
              className="appearance-none rounded-lg border px-3 py-2 text-sm [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            />
            <select
              value={respondByUnit}
              onChange={(e) => setRespondByUnit(e.target.value as 'hours' | 'days' | 'weeks' | 'months')}
              className="rounded-lg border px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            >
              <option value="hours">{t('respondByHours')}</option>
              <option value="days">{t('respondByDays')}</option>
              <option value="weeks">{t('respondByWeeks')}</option>
              <option value="months">{t('respondByMonths')}</option>
            </select>
            <span className="flex items-center justify-center text-sm text-gray-500 dark:text-gray-400">{t('respondByBefore')}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <Switch checked={requireNoteIfAbsent} onCheckedChange={setRequireNoteIfAbsent} />
          <div>
            <span>{t('requireNoteIfAbsent', { ns: 'participation' })}</span>
            <p className="text-xs text-muted-foreground">{t('requireNoteIfAbsentHint', { ns: 'participation' })}</p>
          </div>
        </div>

        <div>
          <label className={labelCls}>{tc('notes')}</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className={inputCls}
          />
        </div>

        {previewDates.length > 0 && (
          <div>
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('generatePreview')} ({previewDates.length})
            </p>
            <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border bg-gray-50 p-2 dark:border-gray-600 dark:bg-gray-800">
              {previewDates.map((d) => (
                <p key={d} className="py-0.5 text-sm text-gray-600 dark:text-gray-400">{formatDate(d)}</p>
              ))}
            </div>
          </div>
        )}

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={handleClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            {tc('close')}
          </button>
          <button
            onClick={handleGenerate}
            disabled={loading || previewDates.length === 0}
            className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {loading ? tc('saving') : t('generate')}
          </button>
        </div>
      </div>
    </Modal>
  )
}
