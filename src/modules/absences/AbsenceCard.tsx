import { useTranslation } from 'react-i18next'
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

export default function AbsenceCard({ absence, onEdit, onDelete, showMemberName, canEdit }: AbsenceCardProps) {
  const { t } = useTranslation('absences')
  const memberName = absence.expand?.member?.name

  const affectsLabels: Record<string, string> = {
    trainings: t('affectsTrainings'),
    games: t('affectsGames'),
    all: t('affectsAll'),
  }

  return (
    <div className="rounded-lg border dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={absence.reason} />
          <span className="text-sm text-gray-700 dark:text-gray-300">
            {formatDate(absence.start_date)}
            {absence.start_date !== absence.end_date && ` — ${formatDate(absence.end_date)}`}
          </span>
          {showMemberName && memberName && (
            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{memberName}</span>
          )}
        </div>
        {canEdit && (
          <div className="flex gap-2">
            <button
              onClick={() => onEdit(absence)}
              className="min-h-[44px] rounded px-3 py-2 text-sm text-brand-600 hover:bg-brand-50 hover:text-brand-700 sm:min-h-0 sm:py-1"
            >
              {t('common:edit')}
            </button>
            <button
              onClick={() => onDelete(absence.id)}
              className="min-h-[44px] rounded px-3 py-2 text-sm text-red-600 hover:bg-red-50 hover:text-red-800 sm:min-h-0 sm:py-1"
            >
              {t('common:delete')}
            </button>
          </div>
        )}
      </div>
      {absence.reason_detail && (
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{absence.reason_detail}</p>
      )}
      {absence.affects && absence.affects.length > 0 && (
        <div className="mt-2 flex gap-1">
          {absence.affects.map((a) => (
            <span key={a} className="rounded bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-xs text-gray-600 dark:text-gray-400">
              {affectsLabels[a] ?? a}
            </span>
          ))}
        </div>
      )}
      {absence.approved && (
        <span className="mt-2 inline-block rounded bg-green-100 px-2 py-0.5 text-xs text-green-700">
          {t('approved')}
        </span>
      )}
    </div>
  )
}
