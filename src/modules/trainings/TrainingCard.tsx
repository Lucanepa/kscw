import { useTranslation } from 'react-i18next'
import TeamChip from '../../components/TeamChip'
import ParticipationButton from '../../components/ParticipationButton'
import { useAuth } from '../../hooks/useAuth'
import { formatDate, formatWeekday, formatTime } from '../../utils/dateHelpers'
import type { Training, Team, Hall, Member } from '../../types'

type TrainingExpanded = Training & {
  expand?: { team?: Team; hall?: Hall; coach?: Member }
}

interface TrainingCardProps {
  training: TrainingExpanded
  onOpenAttendance: (trainingId: string, teamId: string) => void
  onEdit?: (training: Training) => void
  onDelete?: (trainingId: string) => void
}

export default function TrainingCard({ training, onOpenAttendance, onEdit, onDelete }: TrainingCardProps) {
  const { t } = useTranslation('trainings')
  const { user } = useAuth()
  const team = training.expand?.team
  const hall = training.expand?.hall
  const coach = training.expand?.coach

  return (
    <div className={`rounded-lg border dark:border-gray-700 bg-white dark:bg-gray-800 p-4 ${training.cancelled ? 'opacity-60' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            {team && <TeamChip team={team.name} size="sm" />}
            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {formatWeekday(training.date)}, {formatDate(training.date)}
            </span>
          </div>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {formatTime(training.start_time)} – {formatTime(training.end_time)}
            {hall && <span> · {hall.name}</span>}
            {coach && <span> · {coach.name}</span>}
          </p>
          {training.cancelled && (
            <span className="mt-1 inline-block rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
              {t('cancelled')}{training.cancel_reason ? `: ${training.cancel_reason}` : ''}
            </span>
          )}
          {training.notes && !training.cancelled && (
            <p className="mt-1 text-sm text-gray-400">{training.notes}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {user && !training.cancelled && (
            <ParticipationButton
              activityType="training"
              activityId={training.id}
              activityDate={training.date}
              compact
            />
          )}
          {!training.cancelled && (
            <button
              onClick={() => onOpenAttendance(training.id, training.team)}
              className="min-h-[44px] rounded-lg border px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 sm:min-h-0 sm:py-1.5 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              {t('attendance')}
            </button>
          )}
          {onEdit && (
            <button
              onClick={() => onEdit(training)}
              className="rounded-lg p-2.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 sm:p-1.5 dark:hover:bg-gray-700 dark:hover:text-gray-300"
              title={t('editTraining')}
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
              </svg>
            </button>
          )}
          {onDelete && (
            <button
              onClick={() => onDelete(training.id)}
              className="rounded-lg p-2.5 text-gray-400 hover:bg-red-50 hover:text-red-600 sm:p-1.5 dark:hover:bg-red-900/20 dark:hover:text-red-400"
              title={t('deleteTraining')}
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
