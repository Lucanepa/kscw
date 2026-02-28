import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import TeamChip from '../../components/TeamChip'
import type { CalendarEntry } from '../../types/calendar'
import type { Training, Event as KscwEvent } from '../../types'
import { formatDate } from '../../utils/dateUtils'

interface CalendarEntryModalProps {
  entry: CalendarEntry | null
  onClose: () => void
}

export default function CalendarEntryModal({ entry, onClose }: CalendarEntryModalProps) {
  const { t } = useTranslation('calendar')

  useEffect(() => {
    if (!entry) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [entry, onClose])

  if (!entry) return null

  const typeLabels: Record<CalendarEntry['type'], string> = {
    game: t('typeGame'),
    training: t('typeTraining'),
    closure: t('typeClosure'),
    event: t('typeEvent'),
    hall: t('typeHall'),
  }

  const typeBadgeStyles: Record<CalendarEntry['type'], string> = {
    game: 'bg-brand-100 text-brand-800 dark:bg-brand-900/40 dark:text-brand-300',
    training: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
    closure: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
    event: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
    hall: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-300',
  }

  const dateStr = formatDate(entry.date, 'EEEE, MMMM d, yyyy')

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white shadow-xl sm:rounded-2xl dark:bg-gray-800"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b dark:border-gray-700 px-6 py-4">
          <span className={`rounded px-2 py-0.5 text-xs font-medium ${typeBadgeStyles[entry.type]}`}>
            {typeLabels[entry.type]}
          </span>
          <button
            onClick={onClose}
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 sm:min-h-0 sm:min-w-0 sm:p-1 dark:hover:bg-gray-700"
          >
            <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>

        {/* Title */}
        <div className="px-6 py-5">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {entry.title}
          </h3>
          {entry.teamNames.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {entry.teamNames.map((name) => (
                <TeamChip key={name} team={name} size="sm" />
              ))}
            </div>
          )}
        </div>

        {/* Details */}
        <div className="space-y-3 border-t dark:border-gray-700 px-6 py-4">
          <DetailRow label={t('common:date')} value={dateStr} />

          {entry.allDay ? (
            <DetailRow label={t('common:type')} value={t('common:allDay')} />
          ) : entry.startTime ? (
            <DetailRow
              label={t('common:from')}
              value={entry.endTime ? `${entry.startTime} – ${entry.endTime}` : entry.startTime}
            />
          ) : null}

          {entry.location && (
            <DetailRow label={t('common:hall')} value={entry.location} />
          )}

          {entry.description && (
            <DetailRow label={t('common:details')} value={entry.description} />
          )}

          {/* Training-specific fields */}
          {entry.type === 'training' && renderTrainingDetails(entry.source as Training, t)}

          {/* Event-specific fields */}
          {entry.type === 'event' && renderEventDetails(entry.source as KscwEvent, t)}
        </div>
      </div>
    </div>
  )
}

function renderTrainingDetails(training: Training, t: (key: string) => string) {
  if (!training) return null
  return (
    <>
      {training.cancelled && (
        <DetailRow label={t('common:status')} value={training.cancel_reason || 'Cancelled'} />
      )}
      {training.coach && (
        <DetailRow label="Coach" value={training.coach} />
      )}
      {training.notes && !training.cancelled && (
        <DetailRow label={t('common:notes')} value={training.notes} />
      )}
    </>
  )
}

function renderEventDetails(event: KscwEvent, t: (key: string) => string) {
  if (!event) return null

  const typeMap: Record<string, string> = {
    verein: 'Club',
    social: 'Social',
    meeting: 'Meeting',
    tournament: 'Tournament',
    other: 'Other',
  }

  return (
    <>
      {event.event_type && (
        <DetailRow label={t('common:type')} value={typeMap[event.event_type] ?? event.event_type} />
      )}
      {event.description && (
        <DetailRow label={t('common:details')} value={event.description} />
      )}
    </>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-3 text-sm">
      <span className="w-20 shrink-0 text-gray-500 dark:text-gray-400">{label}</span>
      <span className="text-gray-900 dark:text-gray-100">{value}</span>
    </div>
  )
}
