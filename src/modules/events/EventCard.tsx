import { useTranslation } from 'react-i18next'
import StatusBadge from '../../components/StatusBadge'
import TeamChip from '../../components/TeamChip'
import ParticipationButton from '../../components/ParticipationButton'
import { useAuth } from '../../hooks/useAuth'
import { formatDate } from '../../utils/dateHelpers'
import type { Event, Team } from '../../types'

type EventExpanded = Event & { expand?: { teams?: Team[] } }

const eventTypeColors: Record<string, { bg: string; text: string }> = {
  verein: { bg: '#dbeafe', text: '#1e40af' },
  social: { bg: '#dcfce7', text: '#166534' },
  meeting: { bg: '#fef3c7', text: '#92400e' },
  tournament: { bg: '#fee2e2', text: '#991b1b' },
  other: { bg: '#f3f4f6', text: '#374151' },
}

interface EventCardProps {
  event: EventExpanded
  onEdit?: (event: Event) => void
  onDelete?: (eventId: string) => void
}

export default function EventCard({ event, onEdit, onDelete }: EventCardProps) {
  const { t } = useTranslation('events')
  const { user } = useAuth()
  const teams = event.expand?.teams ?? []

  return (
    <div className="rounded-lg border bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <StatusBadge status={event.event_type} colorMap={eventTypeColors} />
            <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">{event.title}</h3>
          </div>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {formatDate(event.start_date)}
            {event.start_date !== event.end_date && ` — ${formatDate(event.end_date)}`}
            {event.all_day && ` · ${t('allDay')}`}
          </p>
          {event.location && (
            <p className="mt-0.5 text-sm text-gray-400">{event.location}</p>
          )}
          {event.description && (
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{event.description}</p>
          )}
          {teams.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {teams.map((team) => (
                <TeamChip key={team.id} team={team.name} size="sm" />
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {user && (
            <ParticipationButton
              activityType="event"
              activityId={event.id}
              activityDate={event.start_date}
              compact
            />
          )}
          {onEdit && (
            <button
              onClick={() => onEdit(event)}
              className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
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
              className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-400"
              title={t('deleteEvent')}
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
