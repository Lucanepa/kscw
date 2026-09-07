import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, X } from 'lucide-react'
import Modal from '@/components/Modal'
import { useCollection } from '../lib/query'
import { useMutation } from '../hooks/useMutation'
import { useRealtime } from '../hooks/useRealtime'
import { useAuth } from '../hooks/useAuth'
import type { EventSession, Participation } from '../types'
import { currentLocale } from '../utils/dateHelpers'

interface Props {
  activityId: string
  sessions: EventSession[]
  onClose: () => void
  /** True when the viewer answers as staff (coach / TR of an invited team, on
   *  none of their rosters). MUST be threaded from the caller: this sheet used
   *  to hardcode `is_staff: false`, and since it is the only per-day RSVP path,
   *  every staff answer on a per-day event was stored as a player row — counted
   *  in the player tally on the card while the roster modal's Staff section
   *  (which reads `is_staff = true` rows) still said "Not responded". */
  isStaff?: boolean
}

function formatDateShort(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString(currentLocale(), { weekday: 'short', day: 'numeric', month: 'short' })
}

function SessionRow({
  session,
  status,
  loading,
  onSetStatus,
}: {
  session: EventSession
  status: Participation['status'] | null
  /** The RSVP fetch is still in flight, so `status` is "not known yet" rather
   *  than "answered nothing". See the gate in SessionParticipationSheet. */
  loading: boolean
  onSetStatus: (session: EventSession, status: Participation['status']) => void
}) {
  const { t } = useTranslation('participation')
  const dateStr = session.date?.split(' ')[0] ?? ''

  const buttons: { status: Participation['status']; icon: React.ReactNode; activeClass: string }[] = [
    { status: 'confirmed', icon: <Check className="h-4 w-4" />, activeClass: 'bg-green-500 text-white' },
    { status: 'declined', icon: <X className="h-4 w-4" />, activeClass: 'bg-red-500 text-white' },
  ]

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="flex-1">
        <div className="text-sm font-medium text-gray-800 dark:text-gray-200">
          {session.label || formatDateShort(dateStr)}
        </div>
        {session.start_time && (
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {session.start_time}{session.end_time ? `–${session.end_time}` : ''}
          </div>
        )}
        {!session.start_time && session.label && (
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {formatDateShort(dateStr)}
          </div>
        )}
      </div>
      <div className="flex gap-1.5">
        {buttons.map(({ status: btnStatus, icon, activeClass }) => (
          <button
            key={btnStatus}
            onClick={() => onSetStatus(session, btnStatus)}
            disabled={loading}
            aria-busy={loading}
            className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold transition-colors sm:h-8 sm:w-8 ${
              loading
                // A shade off the unselected pill in BOTH themes (it is
                // gray-100 / dark:gray-700), plus a pulse and no glyph at all.
                ? 'animate-pulse cursor-default bg-gray-200 text-transparent dark:bg-gray-800'
                : status === btnStatus
                  ? activeClass
                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:hover:bg-gray-600'
            }`}
            title={loading ? undefined : t(btnStatus)}
          >
            {icon}
          </button>
        ))}
      </div>
    </div>
  )
}

export default function SessionParticipationSheet({ activityId, sessions, onClose, isStaff = false }: Props) {
  const { t } = useTranslation('events')
  const { user } = useAuth()

  // Batch: fetch ALL of this user's participations for the event in one query
  // (was N queries — one per session row via useParticipation).
  const { data: rowsRaw, refetch, isLoading } = useCollection<Participation>('participations', {
    filter: user && activityId
      ? { _and: [
          { member: { _eq: user.id } },
          { activity_type: { _eq: 'event' } },
          { activity_id: { _eq: activityId } },
        ] }
      : { id: { _eq: -1 } },
    all: true,
    enabled: !!user && !!activityId,
  })
  // `rows` is `[]` until the fetch lands, so an unanswered-looking row means
  // "not loaded yet" just as much as it means "not answered" — indistinguishable
  // to the member, who saw every day's ✓/✗ pair painted neutral grey for one
  // round trip even after answering them all (cold open from HomePage →
  // EventDetailModal; the EventCard path shares this query key and mounts warm).
  // `isLoading` is TanStack v5's `isPending && isFetching`, i.e. true only on a
  // first load with no cached data — so the warm path still flashes nothing.
  const rows = rowsRaw ?? []

  useRealtime<Participation>('participations', (e) => {
    if (e.record.activity_id === activityId && e.record.member === user?.id) refetch()
  })

  const { create, update } = useMutation<Participation>('participations')
  // Optimistic status per session, shown immediately while the write is in-flight.
  const [optimistic, setOptimistic] = useState<Record<string, Participation['status']>>({})

  const bySession = useMemo(() => {
    const map = new Map<string, Participation>()
    for (const p of rows) {
      const sid = p.session_id ? String(p.session_id) : ''
      if (sid) map.set(sid, p)
    }
    return map
  }, [rows])

  const handleSetStatus = useCallback(async (session: EventSession, status: Participation['status']) => {
    if (!user) return
    const sid = String(session.id)
    setOptimistic((prev) => ({ ...prev, [sid]: status }))
    const revert = () => setOptimistic((prev) => {
      const next = { ...prev }
      delete next[sid]
      return next
    })
    const existing = bySession.get(sid)
    try {
      if (existing) {
        await update(existing.id, { status })
      } else {
        // `silentOnUnique` keeps the expected 400 below out of Sentry — it still
        // throws, so the recovery underneath runs either way.
        await create({
          member: user.id,
          activity_type: 'event',
          activity_id: activityId,
          status,
          note: '',
          guest_count: 0,
          is_staff: isStaff,
          session_id: session.id,
        }, { silentOnUnique: true })
      }
      return
    } catch (err) {
      if (!/has to be unique/i.test(err instanceof Error ? err.message : String(err))) {
        revert()
        return
      }
    }
    // A row for this day already exists that `bySession` never saw — a realtime
    // refetch landed between the read and the click, or a backend hook wrote it
    // first. `participations_activity_member_session_uq` rejects the create, and
    // reverting alone would drop the member's answer with nothing on screen to
    // say so. Re-read and update the real row instead (mirrors the same recovery
    // in useParticipation.ts).
    try {
      const { data: fresh } = await refetch()
      const row = fresh?.find((p) => (p.session_id ? String(p.session_id) : '') === sid)
      if (!row) {
        revert()
        return
      }
      await update(row.id, { status })
    } catch {
      revert()
    }
  }, [user, bySession, activityId, isStaff, create, update, refetch])

  return (
    <Modal open onClose={onClose} title={t('sessionParticipation')} size="sm">
      <div className="divide-y divide-gray-100 dark:divide-gray-700">
        {sessions.map((session) => {
          const sid = String(session.id)
          const status = optimistic[sid] ?? bySession.get(sid)?.status ?? null
          return (
            <SessionRow
              key={session.id}
              session={session}
              status={status}
              loading={isLoading}
              onSetStatus={handleSetStatus}
            />
          )
        })}
      </div>
    </Modal>
  )
}
