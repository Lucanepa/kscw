import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useTeamAbsences } from '../../hooks/useTeamAbsences'
import StatusBadge from '../../components/StatusBadge'
import EmptyState from '../../components/EmptyState'
import { formatDate, toISODate } from '../../utils/dateHelpers'

interface TeamAbsenceViewProps {
  teamId: string
}

export default function TeamAbsenceView({ teamId }: TeamAbsenceViewProps) {
  const { t } = useTranslation('absences')
  const today = toISODate(new Date())
  const fourWeeksLater = toISODate(new Date(Date.now() + 28 * 24 * 60 * 60 * 1000))

  const [startDate, setStartDate] = useState(today)
  const [endDate, setEndDate] = useState(fourWeeksLater)

  const { absences, memberMap, isLoading } = useTeamAbsences(teamId, startDate, endDate)

  const groupedByMember = useMemo(() => {
    const groups: Record<string, typeof absences> = {}
    for (const a of absences) {
      if (!groups[a.member]) groups[a.member] = []
      groups[a.member].push(a)
    }
    return groups
  }, [absences])

  // All team members from the memberMap, including those without absences
  const memberIds = Object.keys(memberMap)
  const membersWithAbsences = new Set(Object.keys(groupedByMember))
  const availableMembers = memberIds.filter((id) => !membersWithAbsences.has(id))

  if (isLoading) {
    return <div className="py-8 text-center text-gray-500 dark:text-gray-400">{t('common:loading')}</div>
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400">{t('fromTo')}</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="rounded-lg border dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400">{t('until')}</label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="rounded-lg border dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 px-3 py-1.5 text-sm"
          />
        </div>
      </div>

      {absences.length === 0 && availableMembers.length === 0 ? (
        <EmptyState
          icon="✅"
          title={t('noTeamAbsences')}
          description={t('noTeamAbsencesDescription')}
        />
      ) : (
        <div className="space-y-4">
          {/* Members with absences */}
          {Object.entries(groupedByMember).map(([memberId, memberAbsences]) => {
            const member = memberMap[memberId]
            return (
              <div key={memberId} className="rounded-lg border dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
                <h3 className="font-medium text-gray-900 dark:text-gray-100">{member?.name ?? t('common:unknown')}</h3>
                <div className="mt-2 space-y-2">
                  {memberAbsences.map((a) => (
                    <div key={a.id} className="flex flex-wrap items-center gap-2 text-sm">
                      <StatusBadge status={a.reason} />
                      <span className="text-gray-600 dark:text-gray-400">
                        {formatDate(a.start_date)}
                        {a.start_date !== a.end_date && ` — ${formatDate(a.end_date)}`}
                      </span>
                      {a.reason_detail && (
                        <span className="text-gray-400">({a.reason_detail})</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )
          })}

          {/* Members without absences */}
          {availableMembers.length > 0 && (
            <div className="rounded-lg border dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
              <h3 className="text-sm font-medium text-green-700">{t('common:available')}</h3>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {availableMembers.map((id) => memberMap[id]?.name).filter(Boolean).join(', ')}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
