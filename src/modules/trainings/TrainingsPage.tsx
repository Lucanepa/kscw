import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../hooks/useAuth'
import { usePB } from '../../hooks/usePB'
import { useRealtime } from '../../hooks/useRealtime'
import { useMutation } from '../../hooks/useMutation'
import TeamFilter from '../../components/TeamFilter'
import EmptyState from '../../components/EmptyState'
import ConfirmDialog from '../../components/ConfirmDialog'
import TrainingCard from './TrainingCard'
import TrainingForm from './TrainingForm'
import RecurringTrainingModal from './RecurringTrainingModal'
import AttendanceSheet from './AttendanceSheet'
import CoachDashboard from './CoachDashboard'
import LoadingSpinner from '../../components/LoadingSpinner'
import type { Training, Team, Hall, Member } from '../../types'

type TrainingExpanded = Training & {
  expand?: { team?: Team; hall?: Hall; coach?: Member }
}

export default function TrainingsPage() {
  const { t } = useTranslation('trainings')
  const { isCoach, isCoachOf } = useAuth()
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'trainings' | 'dashboard'>('trainings')
  const [attendanceTraining, setAttendanceTraining] = useState<string | null>(null)
  const [attendanceTeam, setAttendanceTeam] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [editingTraining, setEditingTraining] = useState<Training | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [recurringOpen, setRecurringOpen] = useState(false)

  const { data: trainings, isLoading, refetch } = usePB<TrainingExpanded>('trainings', {
    filter: selectedTeam ? `team="${selectedTeam}"` : '',
    sort: '-date',
    expand: 'team,hall,coach',
    perPage: 50,
  })

  const { remove } = useMutation<Training>('trainings')

  useRealtime('trainings', () => refetch())

  function handleOpenAttendance(trainingId: string, teamId: string) {
    setAttendanceTraining(trainingId)
    setAttendanceTeam(teamId)
  }

  function handleEdit(training: Training) {
    setEditingTraining(training)
    setFormOpen(true)
  }

  function handleFormSave() {
    setFormOpen(false)
    setEditingTraining(null)
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
          <div className="flex gap-2">
            <button
              onClick={() => setRecurringOpen(true)}
              className="rounded-lg border border-brand-500 px-4 py-2 text-sm font-medium text-brand-600 hover:bg-brand-50 dark:border-brand-400 dark:text-brand-400 dark:hover:bg-brand-900/20"
            >
              {t('recurringTitle')}
            </button>
            <button
              onClick={() => {
                setEditingTraining(null)
                setFormOpen(true)
              }}
              className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600"
            >
              {t('newTraining')}
            </button>
          </div>
        )}
      </div>

      <div className="mt-6">
        <TeamFilter selected={selectedTeam} onChange={setSelectedTeam} />
      </div>

      {/* Tabs (coach view) */}
      {isCoach && selectedTeam && (
        <div className="mt-4">
          <div className="flex gap-1 rounded-lg bg-gray-100 dark:bg-gray-700 p-1">
            <button
              onClick={() => setActiveTab('trainings')}
              className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === 'trainings' ? 'bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 shadow-sm' : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
              }`}
            >
              {t('tabTrainings')}
            </button>
            <button
              onClick={() => setActiveTab('dashboard')}
              className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === 'dashboard' ? 'bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 shadow-sm' : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
              }`}
            >
              {t('tabCoachDashboard')}
            </button>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="mt-6">
        {activeTab === 'dashboard' && selectedTeam ? (
          <CoachDashboard teamId={selectedTeam} />
        ) : isLoading ? (
          <LoadingSpinner />
        ) : trainings.length === 0 ? (
          <EmptyState
            icon="🎯"
            title={t('noTrainings')}
            description={t('noTrainingsDescription')}
          />
        ) : (
          <div className="space-y-3">
            {trainings.map((training) => (
              <TrainingCard
                key={training.id}
                training={training}
                onOpenAttendance={handleOpenAttendance}
                onEdit={isCoachOf(training.team) ? handleEdit : undefined}
                onDelete={isCoachOf(training.team) ? setDeletingId : undefined}
              />
            ))}
          </div>
        )}
      </div>

      <AttendanceSheet
        trainingId={attendanceTraining}
        teamId={attendanceTeam}
        onClose={() => {
          setAttendanceTraining(null)
          setAttendanceTeam(null)
        }}
      />

      <TrainingForm
        open={formOpen}
        training={editingTraining}
        onSave={handleFormSave}
        onCancel={() => {
          setFormOpen(false)
          setEditingTraining(null)
        }}
      />

      <RecurringTrainingModal
        open={recurringOpen}
        onClose={() => setRecurringOpen(false)}
        onGenerated={refetch}
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
    </div>
  )
}
