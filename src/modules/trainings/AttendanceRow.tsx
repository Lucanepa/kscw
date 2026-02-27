import StatusBadge from '../../components/StatusBadge'
import { getFileUrl } from '../../utils/pbFile'
import type { Member, TrainingAttendance, Absence } from '../../types'

interface AttendanceRowProps {
  member: Member
  attendance: TrainingAttendance | null
  activeAbsence: Absence | null
  onStatusChange: (memberId: string, status: TrainingAttendance['status']) => void
  canEdit: boolean
}

const statusOptions: { value: TrainingAttendance['status']; label: string; color: string }[] = [
  { value: 'present', label: '✅', color: 'bg-green-100 hover:bg-green-200 text-green-800' },
  { value: 'absent', label: '❌', color: 'bg-red-100 hover:bg-red-200 text-red-800' },
  { value: 'late', label: '⏰', color: 'bg-amber-100 hover:bg-amber-200 text-amber-800' },
  { value: 'excused', label: '📋', color: 'bg-brand-100 hover:bg-brand-200 text-brand-800' },
]

export default function AttendanceRow({
  member,
  attendance,
  activeAbsence,
  onStatusChange,
  canEdit,
}: AttendanceRowProps) {
  const initials = `${member.first_name?.[0] ?? ''}${member.last_name?.[0] ?? ''}`.toUpperCase()
  const currentStatus = attendance?.status

  return (
    <div className="flex items-center gap-4 border-b dark:border-gray-700 px-4 py-3 last:border-0">
      {/* Member info */}
      <div className="flex items-center gap-3">
        {member.photo ? (
          <img
            src={getFileUrl('members', member.id, member.photo)}
            alt={member.name}
            className="h-8 w-8 rounded-full object-cover"
          />
        ) : (
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-200 dark:bg-gray-600 text-xs font-medium text-gray-600 dark:text-gray-300">
            {initials}
          </div>
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{member.name}</p>
          {member.number > 0 && (
            <p className="text-xs text-gray-400">#{member.number}</p>
          )}
        </div>
      </div>

      {/* Absence indicator */}
      {activeAbsence && (
        <StatusBadge status={activeAbsence.reason} />
      )}

      {/* Status buttons */}
      <div className="ml-auto flex gap-2 sm:gap-1">
        {statusOptions.map((opt) => (
          <button
            key={opt.value}
            onClick={() => canEdit && onStatusChange(member.id, opt.value)}
            disabled={!canEdit}
            className={`rounded-lg px-3 py-2 text-base transition-colors sm:px-2 sm:py-1 sm:text-sm ${
              currentStatus === opt.value
                ? `${opt.color} ring-2 ring-offset-1 ring-gray-400`
                : canEdit
                  ? 'bg-gray-50 dark:bg-gray-900 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-400'
                  : 'bg-gray-50 dark:bg-gray-900 text-gray-300'
            }`}
            title={opt.value}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}
