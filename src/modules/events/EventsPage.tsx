import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../hooks/useAuth'
import { usePB } from '../../hooks/usePB'
import { useMutation } from '../../hooks/useMutation'
import { useRealtime } from '../../hooks/useRealtime'
import EmptyState from '../../components/EmptyState'
import ConfirmDialog from '../../components/ConfirmDialog'
import LoadingSpinner from '../../components/LoadingSpinner'
import EventCard from './EventCard'
import EventForm from './EventForm'
import type { Event, Team } from '../../types'

type EventExpanded = Event & { expand?: { teams?: Team[] } }

export default function EventsPage() {
  const { t } = useTranslation('events')
  const { isCoach } = useAuth()
  const [formOpen, setFormOpen] = useState(false)
  const [editingEvent, setEditingEvent] = useState<Event | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const { data: events, isLoading, refetch } = usePB<EventExpanded>('events', {
    sort: '-start_date',
    expand: 'teams',
    perPage: 50,
  })

  const { remove } = useMutation<Event>('events')

  useRealtime('events', () => refetch())

  function handleEdit(event: Event) {
    setEditingEvent(event)
    setFormOpen(true)
  }

  function handleFormSave() {
    setFormOpen(false)
    setEditingEvent(null)
    refetch()
  }

  async function handleDelete() {
    if (!deletingId) return
    await remove(deletingId)
    setDeletingId(null)
    refetch()
  }

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900 sm:text-2xl dark:text-gray-100">{t('title')}</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t('subtitle')}</p>
        </div>
        {isCoach && (
          <button
            onClick={() => {
              setEditingEvent(null)
              setFormOpen(true)
            }}
            className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600"
          >
            {t('newEvent')}
          </button>
        )}
      </div>

      <div className="mt-6">
        {isLoading ? (
          <LoadingSpinner />
        ) : events.length === 0 ? (
          <EmptyState
            icon="🎉"
            title={t('noEvents')}
            description={t('noEventsDescription')}
          />
        ) : (
          <div className="space-y-3">
            {events.map((event) => (
              <EventCard
                key={event.id}
                event={event}
                onEdit={isCoach ? handleEdit : undefined}
                onDelete={isCoach ? setDeletingId : undefined}
              />
            ))}
          </div>
        )}
      </div>

      <EventForm
        open={formOpen}
        event={editingEvent}
        onSave={handleFormSave}
        onCancel={() => {
          setFormOpen(false)
          setEditingEvent(null)
        }}
      />

      <ConfirmDialog
        open={deletingId !== null}
        onClose={() => setDeletingId(null)}
        onConfirm={handleDelete}
        title={t('deleteEvent')}
        message={t('deleteConfirm')}
        confirmLabel={t('deleteEvent')}
        danger
      />
    </div>
  )
}
