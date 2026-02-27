import { useState } from 'react'
import { useAuth } from '../../hooks/useAuth'
import { usePB } from '../../hooks/usePB'
import { useRealtime } from '../../hooks/useRealtime'
import TeamFilter from '../../components/TeamFilter'
import EmptyState from '../../components/EmptyState'
import TrainingCard from './TrainingCard'
import AttendanceSheet from './AttendanceSheet'
import CoachDashboard from './CoachDashboard'
import LoadingSpinner from '../../components/LoadingSpinner'
import type { Training, Team, Hall, Member } from '../../types'

type TrainingExpanded = Training & {
  expand?: { team?: Team; hall?: Hall; coach?: Member }
}

export default function TrainingsPage() {
  const { isCoach } = useAuth()
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'trainings' | 'dashboard'>('trainings')
  const [attendanceTraining, setAttendanceTraining] = useState<string | null>(null)
  const [attendanceTeam, setAttendanceTeam] = useState<string | null>(null)

  const { data: trainings, isLoading, refetch } = usePB<TrainingExpanded>('trainings', {
    filter: selectedTeam ? `team="${selectedTeam}"` : '',
    sort: '-date',
    expand: 'team,hall,coach',
    perPage: 50,
  })

  useRealtime('trainings', () => refetch())

  function handleOpenAttendance(trainingId: string, teamId: string) {
    setAttendanceTraining(trainingId)
    setAttendanceTeam(teamId)
  }

  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 sm:text-2xl dark:text-gray-100">Trainings</h1>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Trainingsübersicht mit Anwesenheitskontrolle</p>

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
              Trainings
            </button>
            <button
              onClick={() => setActiveTab('dashboard')}
              className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === 'dashboard' ? 'bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 shadow-sm' : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
              }`}
            >
              Coach Dashboard
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
            title="Keine Trainings"
            description={selectedTeam ? 'Keine Trainings für dieses Team.' : 'Wähle ein Team, um Trainings zu sehen.'}
          />
        ) : (
          <div className="space-y-3">
            {trainings.map((training) => (
              <TrainingCard
                key={training.id}
                training={training}
                onOpenAttendance={handleOpenAttendance}
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
    </div>
  )
}
