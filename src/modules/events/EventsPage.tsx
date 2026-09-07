import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { PartyPopper } from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { useTeamPermissions } from '../../hooks/useTeamPermissions'
import { useDeepLinkedActivity, DEEP_LINK_FIELDS } from '../../hooks/useDeepLinkedActivity'
import { useAdminMode } from '../../hooks/useAdminMode'
import { useCollection } from '../../lib/query'
import { useMutation } from '../../hooks/useMutation'
import { useUserVisibleEventIds } from '../../hooks/useUserVisibleEventIds'
import { todayLocal, toZurichDateString, formatDate } from '../../utils/dateHelpers'
import { useMyDuties, type MyDuty } from '../../hooks/useMyDuties'
import { useRealtime } from '../../hooks/useRealtime'
import { useReportPageLoading } from '../../hooks/usePageReady'
import EmptyState from '../../components/EmptyState'
import ConfirmDialog from '@/components/ConfirmDialog'
import ParticipationRosterModal from '../../components/ParticipationRosterModal'
import TeamFilter from '../../components/TeamFilter'
import EventCard from './EventCard'
import DutyEventCard from './DutyEventCard'
import EventDetailModal from './EventDetailModal'
import EventForm from './EventForm'
import { Button } from '@/components/ui/button'
import { isFeatureEnabled } from '../../utils/featureToggles'
import { asTeams, teamId, ALL_GUEST_LEVELS } from './eventHelpers'
import type { Event, EventSession, Participation } from '../../types'
import { TourPageButton } from '../guide/TourPageButton'

/**
 * Runtime shape of one `events_members` entry. `Event['invited_members']` is declared
 * as `string[]` (the un-expanded shape), but this page expands `invited_members.members_id`,
 * so an entry can also be a junction object whose `members_id` is a raw id or an object.
 */
type InvitedMemberRef =
  | string
  | number
  | { members_id?: string | number | { id?: string | number } | null }

export default function EventsPage() {
  const { t } = useTranslation('events')
  const { t: tc } = useTranslation('common')
  const { user, isCoach, memberTeamIds, coachTeamIds, teamsLoading, matchesRole } = useAuth()
  const { canManageTeam } = useTeamPermissions()
  const { effectiveIsAdmin, effectiveIsVorstand } = useAdminMode()
  // Merge member + coach teams for visibility
  const allUserTeamIds = useMemo(() => [...new Set([...memberTeamIds, ...coachTeamIds])], [memberTeamIds, coachTeamIds])
  const [formOpen, setFormOpen] = useState(false)
  const [editingEvent, setEditingEvent] = useState<Event | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [rosterEvent, setRosterEvent] = useState<Event | null>(null)
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null)
  const [showPast, setShowPast] = useState(false)
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null)

  // ── Share link (`/events/:eventId`) ────────────────────────────────
  //
  // Derived into the modal rather than pushed into `selectedEvent` state: a
  // render-phase write of fetched data is the "Too many re-renders" trap
  // (React #301), and this way there is exactly one source for what's open.
  const { eventId } = useParams()
  const navigate = useNavigate()
  const { item: linkedEvent, notFound: linkedEventMissing } = useDeepLinkedActivity<Event>(
    'events', eventId, [...DEEP_LINK_FIELDS.events],
  )
  const modalEvent = selectedEvent ?? linkedEvent
  useEffect(() => {
    // Deleted, or targeted at an audience this member isn't in — deliberately
    // the same message for both, so a link can't be used to probe for events.
    if (linkedEventMissing) {
      toast.error(tc('linkNotAvailable'))
      navigate('/events', { replace: true })
    }
  }, [linkedEventMissing, navigate, tc])

  const today = useMemo(() => todayLocal(), [])

  // Per-day / per-session events: the roster modal needs the session list to
  // render its per-leg tabs (mirrors EventDetailModal). Fetched lazily for the
  // event whose roster is currently open; without it `hasSessionMode` is false
  // inside the modal and the per-day view never appears.
  const rosterHasSessionMode = !!rosterEvent?.participation_mode && rosterEvent.participation_mode !== 'whole'
  const { data: rosterSessionsRaw } = useCollection<EventSession>('event_sessions', {
    filter: rosterEvent ? { event: { _eq: rosterEvent.id } } : undefined,
    sort: ['sort_order', 'date', 'start_time'],
    limit: 100,
    enabled: !!rosterEvent && rosterHasSessionMode,
  })
  const rosterSessions = rosterSessionsRaw ?? []

  // Resolve event IDs via junctions (single-level filter) rather than walking
  // `events.teams.teams_id` / `events.invited_members.members_id` — those paths
  // conflict with the events policy's own alias walk and silently return [] for
  // non-admins. See [feedback_directus_m2m_double_walk] in CLAUDE.md.
  const teamFilterIds = useMemo(
    () => (selectedTeam ? [selectedTeam] : allUserTeamIds),
    [selectedTeam, allUserTeamIds],
  )
  const { teamEventIds, invitedEventIds, isLoading: eventIdsLoading } = useUserVisibleEventIds(
    teamFilterIds,
    user?.id,
    !effectiveIsAdmin,
  )

  // Show events for selected team, or all user teams + club-wide events
  const eventFilter = useMemo((): Record<string, unknown> => {
    const conditions: Record<string, unknown>[] = []
    if (!showPast) {
      conditions.push({
        _or: [
          { end_date: { _gte: today } },
          { _and: [{ end_date: { _null: true } }, { start_date: { _gte: today } }] },
        ],
      })
    }
    // Admins fetch ALL events — no audience filtering needed at API level
    if (!effectiveIsAdmin) {
      const audienceEventIds = [...new Set([...teamEventIds, ...invitedEventIds])]
      const audienceConds: Record<string, unknown>[] = [
        { teams: { _null: true } },  // Club-wide events
        { id: { _in: audienceEventIds.length > 0 ? audienceEventIds : [-1] } },
        { invited_roles: { _nnull: true } },  // Role-targeted (filter client-side)
      ]
      conditions.push({ _or: audienceConds })
    }
    if (conditions.length === 0) return {}
    return conditions.length === 1 ? conditions[0] : { _and: conditions }
  }, [showPast, today, effectiveIsAdmin, teamEventIds, invitedEventIds])

  const { data: eventsRaw, isLoading, refetch } = useCollection<Event>('events', {
    filter: eventFilter,
    sort: ['start_date'],
    limit: 50,
    // `teams.id` / `invited_members.id` are the JUNCTION row PKs — EventForm has
    // to send them back on save or Directus re-inserts every unchanged link and
    // trips the composite unique index (migration 245). See `m2mUpdatePayload`.
    fields: ['*', 'teams.id', 'teams.teams_id.*', 'teams.teams_id.coach.members_id', 'teams.teams_id.team_responsible.members_id', 'invited_members.id', 'invited_members.members_id', 'invited_roles', 'send_email_invite'],
    enabled: !teamsLoading && (effectiveIsAdmin || !eventIdsLoading),
  })
  const events = eventsRaw ?? []

  const visibleEvents = useMemo(() => {
    if (effectiveIsAdmin) return events  // Admins see everything
    return events.filter(event => {
      const evtTeamIds = (event.teams ?? []).map(t => teamId(t))
      const hasTeams = evtTeamIds.length > 0
      const hasRoles = (event.invited_roles ?? []).length > 0
      const invitedMemberIds = (event.invited_members ?? []).map((m: InvitedMemberRef) => {
        if (typeof m !== 'object') return String(m)
        const ref = m.members_id
        const id = typeof ref === 'object' && ref !== null ? ref.id : ref
        return String(id ?? ref ?? m)
      })
      const hasMembers = invitedMemberIds.length > 0

      // No targeting = club-wide
      if (!hasTeams && !hasRoles && !hasMembers) return true
      // Team match
      if (hasTeams && evtTeamIds.some(id => allUserTeamIds.includes(id))) return true
      // Role match
      if (hasRoles && event.invited_roles!.some(r => matchesRole(r))) return true
      // Direct invite
      if (hasMembers && user && invitedMemberIds.includes(String(user.id))) return true
      return false
    })
  }, [events, allUserTeamIds, user, matchesRole, effectiveIsAdmin])

  // The member's own duty games, interleaved with real events as read-only
  // cards. Duties are always upcoming, so they're hidden while viewing past.
  const { duties: myDuties } = useMyDuties()
  type EventRow = { kind: 'event'; date: string; event: Event }
  type DutyRow = { kind: 'duty'; date: string; duty: MyDuty }
  const rows = useMemo<(EventRow | DutyRow)[]>(() => {
    const list: (EventRow | DutyRow)[] = visibleEvents.map((e) => ({
      kind: 'event' as const, date: e.start_date ? toZurichDateString(e.start_date) : '', event: e,
    }))
    if (!showPast) {
      for (const d of myDuties) {
        if (d.game.date) list.push({ kind: 'duty' as const, date: String(d.game.date).slice(0, 10), duty: d })
      }
    }
    list.sort((a, b) => a.date.localeCompare(b.date))
    return list
  }, [visibleEvents, myDuties, showPast])

  const { remove } = useMutation<Event>('events')

  useRealtime('events', () => refetch())

  // Batch-fetch ALL participations for visible events in ONE request
  const eventIds = useMemo(() => visibleEvents.map((e) => e.id), [visibleEvents])
  const participationFilter = useMemo((): Record<string, unknown> => {
    // Use an impossible-match sentinel (not '') when there are no events: a realtime
    // refetch bypasses `enabled`, and fetchItems drops a falsy filter — without the
    // sentinel an empty list would fetch ALL participations unfiltered (limit:-1).
    if (eventIds.length === 0) return { _and: [{ activity_type: { _eq: 'event' } }, { activity_id: { _in: [-1] } }] }
    return { _and: [{ activity_type: { _eq: 'event' } }, { activity_id: { _in: eventIds } }] }
  }, [eventIds])

  const { data: allParticipationsRaw, isLoading: participationsLoading, refetch: refetchParticipations } = useCollection<Participation>('participations', {
    filter: participationFilter,
    fields: ['id', 'activity_id', 'activity_type', 'member', 'status', 'note', 'session_id', 'guest_count', 'is_staff', 'waitlisted_at', 'date_created', 'date_updated'],
    all: true,
    enabled: eventIds.length > 0,
  })
  const allParticipations = allParticipationsRaw ?? []

  // Hold the full-page spinner until ALL primary data the cards render from has
  // landed: team context, the resolved visible-event IDs, the events themselves,
  // and the batched participations (RSVP counts on every card). The participations
  // query is `enabled: eventIds.length > 0`, so when there are no events it's
  // disabled and contributes `isLoading: false` — never hangs the gate.
  const pageLoading = teamsLoading || (!effectiveIsAdmin && eventIdsLoading) || isLoading || participationsLoading

  // Report to app boot gate — see usePageReady.tsx
  useReportPageLoading(pageLoading)

  useRealtime('participations', () => refetchParticipations())

  const { participationsByEvent, myParticipationByEvent } = useMemo(() => {
    const byEvent = new Map<string, Participation[]>()
    const myByEvent = new Map<string, Participation>()
    for (const p of allParticipations) {
      const list = byEvent.get(p.activity_id) ?? []
      list.push(p)
      byEvent.set(p.activity_id, list)
      if (user && p.member === user.id) {
        myByEvent.set(p.activity_id, p)
      }
    }
    return { participationsByEvent: byEvent, myParticipationByEvent: myByEvent }
  }, [allParticipations, user])

  function handleEdit(event: Event) {
    setEditingEvent(event)
    setFormOpen(true)
  }

  function handleFormSave() {
    setFormOpen(false)
    setEditingEvent(null)
    // No manual refetch: the save mutation invalidates the events cache and the
    // useRealtime('events') subscription below also refetches — a manual call
    // here just fires a third redundant round-trip.
  }

  async function handleDelete() {
    if (!deletingId) return
    await remove(deletingId)
    setDeletingId(null)
    // remove() invalidates the events cache (and realtime refetches too); no
    // manual refetch needed.
  }

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-gray-900 sm:text-2xl dark:text-gray-100">{t('title')}</h1>
          <TourPageButton />
          <button
            onClick={() => setShowPast((v) => !v)}
            className={`min-h-[36px] rounded-full px-2.5 py-1.5 text-xs font-medium transition-colors ${
              showPast
                ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300'
                : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
            }`}
          >
            {t('showPast')}
          </button>
        </div>
        {!teamsLoading && isCoach && (
          <Button
            data-tour="new-event"
            onClick={() => {
              setEditingEvent(null)
              setFormOpen(true)
            }}
          >
            {t('newEvent')}
          </Button>
        )}
      </div>

      {!teamsLoading && allUserTeamIds.length > 1 && (
        <div className="mt-6" data-tour="event-team-filter">
          <TeamFilter selected={selectedTeam} onChange={setSelectedTeam} limitToTeamIds={(effectiveIsAdmin || effectiveIsVorstand) ? undefined : allUserTeamIds} groupBySport={effectiveIsAdmin || effectiveIsVorstand} />
        </div>
      )}

      <div className="mt-6">
        {pageLoading ? null : rows.length === 0 ? (
          <EmptyState
            icon={<PartyPopper className="h-10 w-10" />}
            title={t('noEvents')}
            description={t('noEventsDescription')}
          />
        ) : (
          <div className="space-y-3" data-tour="event-card">
            {rows.map((row) => {
              if (row.kind === 'duty') {
                return <DutyEventCard key={`duty-${row.duty.game.id}-${row.duty.role}`} duty={row.duty} />
              }
              const event = row.event
              // Coaches can only edit events linked to their teams (or club-wide with no teams)
              // Admins can edit all events
              const canEdit = !teamsLoading && (effectiveIsAdmin || (isCoach && (
                event.teams.length === 0 ||
                event.teams.some((tid) => canManageTeam(teamId(tid)))
              )))
              return (
                <EventCard
                  key={event.id}
                  event={event}
                  onClick={() => setSelectedEvent(event)}
                  onEdit={canEdit ? handleEdit : undefined}
                  onDelete={canEdit ? setDeletingId : undefined}
                  onOpenRoster={setRosterEvent}
                  participations={participationsByEvent.get(event.id)}
                  myParticipation={myParticipationByEvent.get(event.id)}
                  onParticipationSaved={refetchParticipations}
                />
              )
            })}
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

      <EventDetailModal
        event={modalEvent}
        onClose={() => {
          // Opened from the URL → drop the id so the modal doesn't reopen on the
          // next render; opened from a card → just clear the state.
          if (selectedEvent) setSelectedEvent(null)
          else navigate('/events', { replace: true })
        }}
      />

      <ParticipationRosterModal
        open={rosterEvent !== null}
        onClose={() => setRosterEvent(null)}
        activityType="event"
        activityId={rosterEvent?.id ?? ''}
        activityDate={rosterEvent?.start_date ?? ''}
        teamIds={(rosterEvent?.teams ?? []).map(t => teamId(t))}
        // The event's own name, like EventDetailModal — a generic "Participation"
        // heading left the PNG/PDF export with nothing identifying it.
        title={rosterEvent
          ? [rosterEvent.title, formatDate(rosterEvent.start_date)].filter(Boolean).join(' — ')
          : t('participation')}
        respondBy={rosterEvent?.respond_by}
        maxPlayers={rosterEvent?.max_players}
        participationMode={rosterEvent?.participation_mode}
        eventSessions={rosterHasSessionMode ? rosterSessions : undefined}
        showRsvpTime={asTeams(rosterEvent?.teams).some(t => isFeatureEnabled(t.features_enabled, 'show_rsvp_time'))}
        allowMaybe={rosterEvent?.allow_maybe !== false}
        excludedGuestLevels={rosterEvent?.invite_guests === false ? ALL_GUEST_LEVELS : undefined}
        invitedRoles={rosterEvent?.invited_roles}
      />
    </div>
  )
}
