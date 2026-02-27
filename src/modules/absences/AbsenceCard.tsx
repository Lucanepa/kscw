import StatusBadge from '../../components/StatusBadge'
import { formatDate } from '../../utils/dateHelpers'
import type { Absence, Member } from '../../types'

interface AbsenceCardProps {
  absence: Absence & { expand?: { member?: Member } }
  onEdit: (absence: Absence) => void
  onDelete: (absenceId: string) => void
  showMemberName?: boolean
  canEdit: boolean
}

const affectsLabels: Record<string, string> = {
  trainings: 'Trainings',
  games: 'Spiele',
  all: 'Alles',
}

export default function AbsenceCard({ absence, onEdit, onDelete, showMemberName, canEdit }: AbsenceCardProps) {
  const memberName = absence.expand?.member?.name

  return (
    <div className="rounded-lg border bg-white px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={absence.reason} />
          <span className="text-sm text-gray-700">
            {formatDate(absence.start_date)}
            {absence.start_date !== absence.end_date && ` — ${formatDate(absence.end_date)}`}
          </span>
          {showMemberName && memberName && (
            <span className="text-sm font-medium text-gray-900">{memberName}</span>
          )}
        </div>
        {canEdit && (
          <div className="flex gap-2">
            <button
              onClick={() => onEdit(absence)}
              className="text-sm text-blue-600 hover:text-blue-800"
            >
              Bearbeiten
            </button>
            <button
              onClick={() => onDelete(absence.id)}
              className="text-sm text-red-600 hover:text-red-800"
            >
              Löschen
            </button>
          </div>
        )}
      </div>
      {absence.reason_detail && (
        <p className="mt-1 text-sm text-gray-500">{absence.reason_detail}</p>
      )}
      {absence.affects && absence.affects.length > 0 && (
        <div className="mt-2 flex gap-1">
          {absence.affects.map((a) => (
            <span key={a} className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
              {affectsLabels[a] ?? a}
            </span>
          ))}
        </div>
      )}
      {absence.approved && (
        <span className="mt-2 inline-block rounded bg-green-100 px-2 py-0.5 text-xs text-green-700">
          Genehmigt
        </span>
      )}
    </div>
  )
}
