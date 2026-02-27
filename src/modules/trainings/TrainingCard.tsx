import TeamChip from '../../components/TeamChip'
import { formatDate, formatWeekday, formatTime } from '../../utils/dateHelpers'
import type { Training, Team, Hall, Member } from '../../types'

type TrainingExpanded = Training & {
  expand?: { team?: Team; hall?: Hall; coach?: Member }
}

interface TrainingCardProps {
  training: TrainingExpanded
  onOpenAttendance: (trainingId: string, teamId: string) => void
}

export default function TrainingCard({ training, onOpenAttendance }: TrainingCardProps) {
  const team = training.expand?.team
  const hall = training.expand?.hall
  const coach = training.expand?.coach

  return (
    <div className={`rounded-lg border bg-white p-4 ${training.cancelled ? 'opacity-60' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            {team && <TeamChip team={team.name} size="sm" />}
            <span className="text-sm font-medium text-gray-900">
              {formatWeekday(training.date)}, {formatDate(training.date)}
            </span>
          </div>
          <p className="mt-1 text-sm text-gray-500">
            {formatTime(training.start_time)} – {formatTime(training.end_time)}
            {hall && <span> · {hall.name}</span>}
            {coach && <span> · {coach.name}</span>}
          </p>
          {training.cancelled && (
            <span className="mt-1 inline-block rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
              Abgesagt{training.cancel_reason ? `: ${training.cancel_reason}` : ''}
            </span>
          )}
          {training.notes && !training.cancelled && (
            <p className="mt-1 text-sm text-gray-400">{training.notes}</p>
          )}
        </div>
        {!training.cancelled && (
          <button
            onClick={() => onOpenAttendance(training.id, training.team)}
            className="shrink-0 rounded-lg border px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Anwesenheit
          </button>
        )}
      </div>
    </div>
  )
}
