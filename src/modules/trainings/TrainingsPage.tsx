import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useAuth } from '../../hooks/useAuth'
import { useTeamPermissions } from '../../hooks/useTeamPermissions'
import { useDeepLinkedActivity, DEEP_LINK_FIELDS } from '../../hooks/useDeepLinkedActivity'
import { useAdminMode } from '../../hooks/useAdminMode'
import { useActivitiesWithParticipations } from '../../lib/query'
import { useRealtime } from '../../hooks/useRealtime'
import { useDebouncedRefetch } from '../../hooks/useDebouncedRefetch'
import { useMutation } from '../../hooks/useMutation'
import { todayLocal, formatDate } from '../../utils/dateHelpers'
import TeamFilter from '../../components/TeamFilter'
import EmptyState from '../../components/EmptyState'
import VolleyballIcon from '../../components/VolleyballIcon'
import ConfirmDialog from '@/components/ConfirmDialog'
import ParticipationRosterModal from '../../components/ParticipationRosterModal'
import TrainingCard from './TrainingCard'
import TrainingDetailModal from './TrainingDetailModal'
import TrainingForm from './TrainingForm'
import RecurringTrainingModal from './RecurringTrainingModal'
import RecurringEditDialog from './RecurringEditDialog'
import type { RecurringEditScope } from './RecurringEditDialog'
import { isFeatureEnabled } from '../../utils/featureToggles'
import CoachDashboard from './CoachDashboard'
import TabBar from '../../components/TabBar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { Training, Team, Hall, Member, Participation } from '../../types'
import { asObj, relId } from '../../utils/relations'
import { TourPageButton } from '../guide/TourPageButton'
import { useReportPageLoading } from '../../hooks/usePageReady'

type TrainingExpanded = Training & {
  team: Team | string
  hall: Hall | string
  coach: Member | string
}

export default function TrainingsPage() {
  const { t } = useTranslation('trainings')
  const { t: tc } = useTranslation('common')
  const { user, isCoach, memberTeamIds, coachTeamIds, teamsLoading } = useAuth()
  const { canManageTeam } = useTeamPermissions()
  // Merge member + coach teams for visibility
  const allUserTeamIds = useMemo(() => [...new Set([...memberTeamIds, ...coachTeamIds])], [memberTeamIds, coachTeamIds])
  const { effectiveIsAdmin, effectiveIsVorstand } = useAdminMode()
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null)
  const [autoSelected, setAutoSelected] = useState(false)
  const [showPast, setShowPast] = useState(false)

  // ── Share link (`/trainings/:trainingId`) ──────────────────────────
  //
  // The list renders RSVP inline on each card and has no detail modal of its
  // own, so a link opens the same TrainingDetailModal the home page uses. The
  // page's team filter and "show past" are bypassed by the by-id fetch.
  const { trainingId } = useParams()
  const navigate = useNavigate()
  const { item: linkedTraining, notFound: linkedTrainingMissing } = useDeepLinkedActivity<TrainingExpanded>(
    'trainings', trainingId, [...DEEP_LINK_FIELDS.trainings],
  )
  useEffect(() => {
    if (linkedTrainingMissing) {
      toast.error(tc('linkNotAvailable'))
      navigate('/trainings', { replace: true })
    }
  }, [linkedTrainingMissing, navigate, tc])

  const today = useMemo(() => todayLocal(), [])

  // Auto-select user's first team on initial load. Done during render (React's
  // sanctioned "adjust state while rendering" pattern) rather than in an effect:
  // same one-shot semantics, but the auto-selected team is already in place on
  // the first committed render, so the queries below never fire once with the
  // un-narrowed filter and then again with the team filter.
  if (!autoSelected && allUserTeamIds.length > 0) {
    setAutoSelected(true)
    setSelectedTeam(allUserTeamIds[0])
  }

  // Non-admins: always scope to own teams + coached teams
  const effectiveFilter = useMemo((): Record<string, unknown> | undefined => {
    const conditions: Record<string, unknown>[] = []
    if (selectedTeam) conditions.push({ team: { _eq: selectedTeam } })
    else if (!effectiveIsAdmin && allUserTeamIds.length > 0) {
      conditions.push({ team: { _in: allUserTeamIds } })
    }
    if (!showPast) conditions.push({ date: { _gte: today } })
    if (conditions.length === 0) return undefined
    return conditions.length === 1 ? conditions[0] : { _and: conditions }
  }, [selectedTeam, effectiveIsAdmin, allUserTeamIds, showPast, today])

  const [activeTab, setActiveTab] = useState<'trainings' | 'dashboard'>('trainings')
  const [formOpen, setFormOpen] = useState(false)
  const [editingTraining, setEditingTraining] = useState<Training | null>(null)
  const [editScope, setEditScope] = useState<RecurringEditScope>('this')
  const [recurringEditDialogOpen, setRecurringEditDialogOpen] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [recurringOpen, setRecurringOpen] = useState(false)
  const [rosterTraining, setRosterTraining] = useState<{ id: string; teamId: string; date: string; teamName?: string; showRsvpTime?: boolean; excludedGuestLevels?: number[] } | null>(null)
  const recurringSelectionMade = useRef(false)

  // Single round-trip: trainings + their participations in one request.
  // Eliminates the old waterfall (trainings → trainingIds → participations)
  // that caused ~1s of empty cards on mobile.
  const {
    data: combined,
    isLoading,
    refetch,
  } = useActivitiesWithParticipations<TrainingExpanded, Participation>('training', {
    filter: effectiveFilter,
    sort: ['date'],
    limit: 50,
    fields: ['*', 'team.*', 'team.coach.members_id', 'team.team_responsible.members_id', 'hall.*', 'coach.*'],
    enabled: !teamsLoading,
  })
  const trainings = combined?.items ?? []
  const allParticipations = combined?.participations ?? []

  // Build maps: activityId → participations[], activityId → user's participation
  const { participationsByActivity, myParticipationByActivity } = useMemo(() => {
    const byActivity = new Map<string, Participation[]>()
    const myByActivity = new Map<string, Participation>()
    for (const p of allParticipations) {
      const list = byActivity.get(p.activity_id) ?? []
      list.push(p)
      byActivity.set(p.activity_id, list)
      if (user && p.member === user.id) {
        myByActivity.set(p.activity_id, p)
      }
    }
    return { participationsByActivity: byActivity, myParticipationByActivity: myByActivity }
  }, [allParticipations, user])

  const { remove } = useMutation<Training>('trainings')

  // ⚠ Both handlers refetch the WHOLE page payload — `POST /kscw/activities/training/
  // with-participations`, which reads participations through `ItemsService` under the
  // caller's accountability, i.e. the same permission engine that stalled on 26.08.2026.
  // Two guards, because it used to have neither:
  //   · debounce, so a cascade that rewrites a week of trainings costs one refetch
  //     rather than one per row (see `useDebouncedRefetch`);
  //   · an activity_type guard, so a teammate's RSVP on a GAME or an EVENT no longer
  //     re-POSTs this page's trainings. A delete frame carries only primary keys, so
  //     `activity_type` is absent there — fall through and refetch, since an
  //     unidentifiable delete may well be one of ours.
  const debouncedRefetch = useDebouncedRefetch(refetch)
  useRealtime('trainings', debouncedRefetch)
  useRealtime<Participation>('participations', (e) => {
    if (e.record.activity_type && e.record.activity_type !== 'training') return
    debouncedRefetch()
  })

  function handleEdit(training: Training) {
    setEditingTraining(training)
    if (training.hall_slot) {
      // Recurring training — ask what scope to edit
      setRecurringEditDialogOpen(true)
    } else {
      // Non-recurring — edit directly
      setEditScope('this')
      setFormOpen(true)
    }
  }

  function handleRecurringEditSelect(scope: RecurringEditScope) {
    recurringSelectionMade.current = true
    setEditScope(scope)
    setRecurringEditDialogOpen(false)
    setFormOpen(true)
  }

  function handleFormSave() {
    setFormOpen(false)
    setEditingTraining(null)
    setEditScope('this')
    refetch()
  }

  async function handleDelete() {
    if (!deletingId) return
    await remove(deletingId)
    setDeletingId(null)
    refetch()
  }

  // Report to app boot gate — see usePageReady.tsx
  useReportPageLoading(teamsLoading || isLoading)

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-gray-900 sm:text-2xl dark:text-gray-100">{t('title')}</h1>
            <TourPageButton />
          </div>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t('subtitle')}</p>
        </div>
        {(isCoach || effectiveIsAdmin) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button data-tour="new-training">{t('newTraining')}</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => {
                  setEditingTraining(null)
                  setEditScope('this')
                  setFormOpen(true)
                }}
              >
                {t('newSingleTraining')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setRecurringOpen(true)}>
                {t('newRecurringTraining')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <div className="mt-6" data-tour="team-filter">
        <TeamFilter selected={selectedTeam} onChange={setSelectedTeam} limitToTeamIds={(effectiveIsAdmin || effectiveIsVorstand) ? undefined : allUserTeamIds} groupBySport={effectiveIsAdmin || effectiveIsVorstand} />
      </div>

      {/* Tabs (coach view) */}
      {(isCoach || effectiveIsAdmin) && selectedTeam && (
        <div className="mt-4" data-tour="training-tabs">
          <TabBar
            tabs={[
              { key: 'trainings' as const, label: t('tabTrainings') },
              { key: 'dashboard' as const, label: t('tabCoachDashboard') },
            ]}
            active={activeTab}
            onChange={setActiveTab}
          />
        </div>
      )}

      {/* Content */}
      <div className="mt-6">
        {activeTab === 'dashboard' && selectedTeam ? (
          <div data-tour="coach-dashboard"><CoachDashboard teamId={selectedTeam} /></div>
        ) : (teamsLoading || isLoading) ? (
          null
        ) : trainings.length === 0 ? (
          <EmptyState
            icon={<VolleyballIcon className="h-10 w-10" />}
            title={t('noTrainings')}
            description={t('noTrainingsDescription')}
          />
        ) : (
          <div className="space-y-4">
            {!showPast && (
              <button
                data-tour="older-trainings"
                onClick={() => setShowPast(true)}
                className="w-full rounded-md border border-gray-200 bg-gray-50 px-4 py-2 text-sm font-medium text-gray-500 transition-colors hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700"
              >
                {t('showPast')}
              </button>
            )}
            {showPast && (
              <button
                onClick={() => setShowPast(false)}
                className="w-full rounded-md border border-brand-200 bg-brand-50 px-4 py-2 text-sm font-medium text-brand-700 transition-colors hover:bg-brand-100 dark:border-brand-700 dark:bg-brand-900/40 dark:text-brand-300 dark:hover:bg-brand-900/60"
              >
                {t('hidePast')}
              </button>
            )}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-tour="training-card">
            {trainings.map((training) => (
              <TrainingCard
                key={training.id}
                training={training}
                participations={participationsByActivity.get(training.id)}
                myParticipation={myParticipationByActivity.get(training.id)}
                onParticipationSaved={refetch}
                onOpenRoster={(id, teamId, date) => setRosterTraining({
                  id,
                  teamId,
                  date,
                  // Names the activity in the modal heading AND in the PNG/PDF
                  // export header — a generic "Participation" there left the
                  // printed sheet with nothing identifying it.
                  teamName: asObj<Team>(training.team)?.name ?? '',
                  showRsvpTime: isFeatureEnabled(asObj<Team>(training.team)?.features_enabled, 'show_rsvp_time'),
                  excludedGuestLevels: Array.isArray(training.excluded_guest_levels) ? training.excluded_guest_levels : [],
                })}
                onEdit={canManageTeam(relId(training.team)) ? handleEdit : undefined}
                onDelete={canManageTeam(relId(training.team)) ? setDeletingId : undefined}
              />
            ))}
            </div>
          </div>
        )}
      </div>

      <RecurringEditDialog
        open={recurringEditDialogOpen}
        onClose={() => {
          setRecurringEditDialogOpen(false)
          // Only clear editingTraining if user cancelled (not when a scope was selected)
          if (recurringSelectionMade.current) {
            recurringSelectionMade.current = false
          } else {
            setEditingTraining(null)
          }
        }}
        onSelect={handleRecurringEditSelect}
      />

      <TrainingForm
        open={formOpen}
        training={editingTraining}
        editScope={editScope}
        defaultTeamId={selectedTeam}
        onSave={handleFormSave}
        onCancel={() => {
          setFormOpen(false)
          setEditingTraining(null)
          setEditScope('this')
        }}
      />

      <RecurringTrainingModal
        open={recurringOpen}
        onClose={() => setRecurringOpen(false)}
        onGenerated={refetch}
        selectedTeamId={selectedTeam}
      />

      <ConfirmDialog
        open={deletingId !== null}
        onClose={() => setDeletingId(null)}
        onConfirm={handleDelete}
        title={t('deleteTraining')}
        message={t('deleteConfirm')}
        confirmLabel={t('deleteTraining')}
        danger
      />

      <ParticipationRosterModal
        open={rosterTraining !== null}
        onClose={() => setRosterTraining(null)}
        activityType="training"
        activityId={rosterTraining?.id ?? ''}
        activityDate={rosterTraining?.date ?? ''}
        teamIds={rosterTraining?.teamId ? [rosterTraining.teamId] : []}
        title={rosterTraining
          ? [rosterTraining.teamName, formatDate(rosterTraining.date)].filter(Boolean).join(' — ')
          : t('participation')}
        showRsvpTime={rosterTraining?.showRsvpTime}
        excludedGuestLevels={rosterTraining?.excludedGuestLevels}
      />

      <TrainingDetailModal
        training={linkedTraining}
        onClose={() => navigate('/trainings', { replace: true })}
      />
    </div>
  )
}
