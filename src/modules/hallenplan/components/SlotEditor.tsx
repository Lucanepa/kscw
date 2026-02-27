import { useState } from 'react'
import Modal from '../../../components/Modal'
import pb from '../../../pb'
import { useConflictChecker } from '../hooks/useConflictChecker'
import { minutesToTime, timeToMinutes } from '../../../utils/dateHelpers'
import type { Hall, HallSlot, Team } from '../../../types'

const DAY_OPTIONS = [
  { value: 0, label: 'Montag' },
  { value: 1, label: 'Dienstag' },
  { value: 2, label: 'Mittwoch' },
  { value: 3, label: 'Donnerstag' },
  { value: 4, label: 'Freitag' },
  { value: 5, label: 'Samstag' },
  { value: 6, label: 'Sonntag' },
]

const TYPE_OPTIONS = [
  { value: 'training', label: 'Training' },
  { value: 'game', label: 'Spiel' },
  { value: 'event', label: 'Event' },
  { value: 'other', label: 'Sonstiges' },
]

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
      setError('Halle und Team sind Pflichtfelder.')
      return
    }
    if (timeToMinutes(form.start_time) >= timeToMinutes(form.end_time)) {
      setError('Endzeit muss nach Startzeit liegen.')
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
      setError(err instanceof Error ? err.message : 'Fehler beim Speichern')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleDelete() {
    if (!slot || !window.confirm('Diesen Slot wirklich löschen?')) return
    setIsSaving(true)
    try {
      await pb.collection('hall_slots').delete(slot.id)
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fehler beim Löschen')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={slot ? 'Slot bearbeiten' : 'Neuer Slot'}
      size="lg"
    >
      <div className="space-y-4">
        {/* Row 1: Hall + Team */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Halle</label>
            <select
              value={form.hall}
              onChange={(e) => update('hall', e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">-- Wählen --</option>
              {halls.map((h) => (
                <option key={h.id} value={h.id}>{h.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Team</label>
            <select
              value={form.team}
              onChange={(e) => update('team', e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">-- Wählen --</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Row 2: Day + Type */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Wochentag</label>
            <select
              value={form.day_of_week}
              onChange={(e) => update('day_of_week', Number(e.target.value))}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {DAY_OPTIONS.map((d) => (
                <option key={d.value} value={d.value}>{d.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Typ</label>
            <select
              value={form.slot_type}
              onChange={(e) => update('slot_type', e.target.value as typeof form.slot_type)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {TYPE_OPTIONS.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Row 3: Times */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Startzeit</label>
            <input
              type="time"
              value={form.start_time}
              onChange={(e) => update('start_time', e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Endzeit</label>
            <input
              type="time"
              value={form.end_time}
              onChange={(e) => update('end_time', e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* Row 4: Recurring */}
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={form.recurring}
            onChange={(e) => update('recurring', e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          <span className="text-sm text-gray-700">Wiederkehrend</span>
        </label>

        {/* Row 5: Validity dates (only if recurring) */}
        {form.recurring && (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Gültig von</label>
              <input
                type="date"
                value={form.valid_from}
                onChange={(e) => update('valid_from', e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Gültig bis</label>
              <input
                type="date"
                value={form.valid_until}
                onChange={(e) => update('valid_until', e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </div>
        )}

        {/* Row 6: Label */}
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Bezeichnung</label>
          <input
            type="text"
            value={form.label}
            onChange={(e) => update('label', e.target.value)}
            placeholder="z.B. Training H3, Heimspiel vs. TVA"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        {/* Row 7: Notes */}
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Notizen</label>
          <textarea
            value={form.notes}
            onChange={(e) => update('notes', e.target.value)}
            rows={3}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        {/* Conflict warning */}
        {conflicts.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
            <p className="font-medium text-amber-800">Überlappung erkannt:</p>
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
                Löschen
              </button>
            )}
          </div>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Abbrechen
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {isSaving ? 'Speichern...' : 'Speichern'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
