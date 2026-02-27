import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../../../components/Modal'
import pb from '../../../pb'
import { useConflictChecker } from '../hooks/useConflictChecker'
import { minutesToTime, timeToMinutes } from '../../../utils/dateHelpers'
import type { Hall, HallSlot, Team } from '../../../types'

interface SlotEditorProps {
  slot: HallSlot | null
  prefill: { day: number; time: string; hall: string } | null
  halls: Hall[]
  teams: Team[]
  allSlots: HallSlot[]
  onClose: () => void
  onSaved: () => void
}

export default function SlotEditor({
  slot,
  prefill,
  halls,
  teams,
  allSlots,
  onClose,
  onSaved,
}: SlotEditorProps) {
  const { t } = useTranslation('hallenplan')

  const DAY_OPTIONS = [
    { value: 0, label: t('dayMonday') },
    { value: 1, label: t('dayTuesday') },
    { value: 2, label: t('dayWednesday') },
    { value: 3, label: t('dayThursday') },
    { value: 4, label: t('dayFriday') },
    { value: 5, label: t('daySaturday') },
    { value: 6, label: t('daySunday') },
  ]

  const TYPE_OPTIONS = [
    { value: 'training', label: t('typeTraining') },
    { value: 'game', label: t('typeGame') },
    { value: 'event', label: t('typeEvent') },
    { value: 'other', label: t('typeOther') },
  ]

  const defaultEnd = prefill?.time
    ? minutesToTime(timeToMinutes(prefill.time) + 90)
    : '19:30'

  const [form, setForm] = useState({
    hall: slot?.hall ?? prefill?.hall ?? (halls[0]?.id ?? ''),
    team: slot?.team ?? '',
    day_of_week: slot?.day_of_week ?? prefill?.day ?? 0,
    start_time: slot?.start_time ?? prefill?.time ?? '18:00',
    end_time: slot?.end_time ?? defaultEnd,
    slot_type: slot?.slot_type ?? ('training' as const),
    recurring: slot?.recurring ?? true,
    valid_from: slot?.valid_from ?? '',
    valid_until: slot?.valid_until ?? '',
    label: slot?.label ?? '',
    notes: slot?.notes ?? '',
  })

  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const conflicts = useConflictChecker(form, allSlots, slot?.id)

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSave() {
    if (!form.hall || !form.team) {
      setError(t('hallRequired') + ' / ' + t('common:team'))
      return
    }
    if (timeToMinutes(form.start_time) >= timeToMinutes(form.end_time)) {
      setError(t('common:endAfterStart'))
      return
    }

    setIsSaving(true)
    setError(null)
    try {
      if (slot) {
        await pb.collection('hall_slots').update(slot.id, form)
      } else {
        await pb.collection('hall_slots').create(form)
      }
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common:errorSaving'))
    } finally {
      setIsSaving(false)
    }
  }

  async function handleDelete() {
    if (!slot || !window.confirm(t('deleteSlotConfirm'))) return
    setIsSaving(true)
    try {
      await pb.collection('hall_slots').delete(slot.id)
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common:errorSaving'))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={slot ? t('editSlotTitle') : t('newSlotTitle')}
      size="lg"
    >
      <div className="space-y-4">
        {/* Row 1: Hall + Team */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">{t('hall')}</label>
            <select
              value={form.hall}
              onChange={(e) => update('hall', e.target.value)}
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            >
              <option value="">{t('selectPlaceholder')}</option>
              {halls.map((h) => (
                <option key={h.id} value={h.id}>{h.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">{t('team')}</label>
            <select
              value={form.team}
              onChange={(e) => update('team', e.target.value)}
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            >
              <option value="">{t('selectPlaceholder')}</option>
              {teams.map((tm) => (
                <option key={tm.id} value={tm.id}>{tm.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Row 2: Day + Type */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">{t('dayOfWeek')}</label>
            <select
              value={form.day_of_week}
              onChange={(e) => update('day_of_week', Number(e.target.value))}
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            >
              {DAY_OPTIONS.map((d) => (
                <option key={d.value} value={d.value}>{d.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">{t('slotType')}</label>
            <select
              value={form.slot_type}
              onChange={(e) => update('slot_type', e.target.value as typeof form.slot_type)}
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            >
              {TYPE_OPTIONS.map((tp) => (
                <option key={tp.value} value={tp.value}>{tp.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Row 3: Times */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">{t('startTime')}</label>
            <input
              type="time"
              value={form.start_time}
              onChange={(e) => update('start_time', e.target.value)}
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">{t('endTime')}</label>
            <input
              type="time"
              value={form.end_time}
              onChange={(e) => update('end_time', e.target.value)}
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
        </div>

        {/* Row 4: Recurring */}
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={form.recurring}
            onChange={(e) => update('recurring', e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-brand-600 focus:ring-brand-500"
          />
          <span className="text-sm text-gray-700 dark:text-gray-300">{t('recurring')}</span>
        </label>

        {/* Row 5: Validity dates (only if recurring) */}
        {form.recurring && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">{t('validFrom')}</label>
              <input
                type="date"
                value={form.valid_from}
                onChange={(e) => update('valid_from', e.target.value)}
                className="w-full rounded-md border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">{t('validTo')}</label>
              <input
                type="date"
                value={form.valid_until}
                onChange={(e) => update('valid_until', e.target.value)}
                className="w-full rounded-md border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>
          </div>
        )}

        {/* Row 6: Label */}
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">{t('label')}</label>
          <input
            type="text"
            value={form.label}
            onChange={(e) => update('label', e.target.value)}
            placeholder="e.g. Training H3, Home game vs. TVA"
            className="w-full rounded-md border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
        </div>

        {/* Row 7: Notes */}
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">{t('notes')}</label>
          <textarea
            value={form.notes}
            onChange={(e) => update('notes', e.target.value)}
            rows={3}
            className="w-full rounded-md border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
        </div>

        {/* Conflict warning */}
        {conflicts.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
            <p className="font-medium text-amber-800">{t('common:overlapDetected')}</p>
            <ul className="mt-1 list-inside list-disc text-sm text-amber-700">
              {conflicts.map((c) => (
                <li key={c.id}>
                  {DAY_OPTIONS[c.day_of_week]?.label} {c.start_time}–{c.end_time}
                  {c.label ? ` (${c.label})` : ''}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-between border-t pt-4">
          <div>
            {slot && (
              <button
                onClick={handleDelete}
                disabled={isSaving}
                className="rounded-md px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                {t('common:delete')}
              </button>
            )}
          </div>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="rounded-md border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              {t('common:cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="rounded-md bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
            >
              {isSaving ? t('common:saving') : t('common:save')}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
