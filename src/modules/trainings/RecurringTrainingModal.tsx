import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../../components/Modal'
import { usePB } from '../../hooks/usePB'
import { formatDate, toISODate } from '../../utils/dateHelpers'
import pb from '../../pb'
import type { HallSlot, Team, Hall } from '../../types'

type SlotExpanded = HallSlot & { expand?: { team?: Team; hall?: Hall } }

interface RecurringTrainingModalProps {
  open: boolean
  onClose: () => void
  onGenerated: () => void
}

export default function RecurringTrainingModal({ open, onClose, onGenerated }: RecurringTrainingModalProps) {
  const { t } = useTranslation('trainings')
  const { t: tc } = useTranslation('common')

  const { data: slots } = usePB<SlotExpanded>('hall_slots', {
    filter: 'slot_type="training"',
    sort: 'day_of_week,start_time',
    expand: 'team,hall',
    perPage: 100,
  })

  const [selectedSlot, setSelectedSlot] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [generated, setGenerated] = useState(0)

  const slot = slots.find((s) => s.id === selectedSlot)

  const previewDates = useMemo(() => {
    if (!slot || !startDate || !endDate) return []
    const dates: string[] = []
    const start = new Date(startDate)
    const end = new Date(endDate)
    const targetDay = slot.day_of_week // 0=Sunday, 1=Monday, etc.

    const current = new Date(start)
    // Advance to first matching day
    while (current.getDay() !== targetDay && current <= end) {
      current.setDate(current.getDate() + 1)
    }

    while (current <= end) {
      dates.push(toISODate(current))
      current.setDate(current.getDate() + 7)
    }
    return dates
  }, [slot, startDate, endDate])

  async function handleGenerate() {
    if (!slot || previewDates.length === 0) return
    setLoading(true)
    setError('')
    setGenerated(0)

    try {
      let count = 0
      for (const date of previewDates) {
        await pb.collection('trainings').create({
          team: slot.team,
          hall_slot: slot.id,
          date,
          start_time: slot.start_time,
          end_time: slot.end_time,
          hall: slot.hall,
          cancelled: false,
        })
        count++
      }
      setGenerated(count)
      onGenerated()
    } catch {
      setError(tc('errorSaving'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('recurringTitle')} size="md">
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{t('selectSlot')}</label>
          <select
            value={selectedSlot}
            onChange={(e) => setSelectedSlot(e.target.value)}
            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
          >
            <option value="">{tc('select')}</option>
            {slots.map((s) => (
              <option key={s.id} value={s.id}>
                {s.expand?.team?.name ?? '?'} — {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][s.day_of_week]} {s.start_time}–{s.end_time} ({s.expand?.hall?.name ?? '?'})
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{tc('from')}</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{tc('to')}</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              min={startDate}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            />
          </div>
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

        {generated > 0 && (
          <p className="text-sm font-medium text-green-600 dark:text-green-400">
            {t('trainingsGenerated', { count: generated })}
          </p>
        )}

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
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
