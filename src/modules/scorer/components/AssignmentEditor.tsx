import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { Member, Team } from '../../../types'

interface AssignmentEditorProps {
  label: string
  requireLicence: boolean
  teamValue: string
  personValue: string
  members: Member[]
  teams: Team[]
  onTeamChange: (teamId: string) => void
  onPersonChange: (memberId: string) => void
  disabled: boolean
  showContact?: boolean
  selfAssignButton?: boolean
  onSelfAssign?: () => void
}

export default function AssignmentEditor({
  label,
  requireLicence,
  teamValue,
  personValue,
  members,
  teams,
  onTeamChange,
  onPersonChange,
  disabled,
  showContact,
  selfAssignButton,
  onSelfAssign,
}: AssignmentEditorProps) {
  const { t } = useTranslation('scorer')

  const filteredMembers = useMemo(() => {
    let list = members.filter((m) => m.active)
    if (requireLicence) {
      list = list.filter((m) => m.scorer_licence)
    }
    return list.sort((a, b) =>
      `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`, 'de'),
    )
  }, [members, requireLicence])

  const assignedPerson = useMemo(() => {
    if (!personValue) return null
    return members.find((m) => m.id === personValue) ?? null
  }, [members, personValue])

  return (
    <div className="space-y-1.5">
      <span className="block text-xs font-medium text-gray-500 dark:text-gray-400">{label}</span>
      <select
        value={teamValue}
        onChange={(e) => onTeamChange(e.target.value)}
        disabled={disabled}
        className="min-h-[44px] w-full rounded border border-gray-300 px-2 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 disabled:bg-gray-50 disabled:text-gray-500 dark:disabled:bg-gray-900 dark:disabled:text-gray-400"
      >
        <option value="">{t('selectTeam')}</option>
        {teams.map((team) => (
          <option key={team.id} value={team.id}>
            {team.name}
          </option>
        ))}
      </select>
      <select
        value={personValue}
        onChange={(e) => onPersonChange(e.target.value)}
        disabled={disabled}
        className="min-h-[44px] w-full rounded border border-gray-300 px-2 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 disabled:bg-gray-50 disabled:text-gray-500 dark:disabled:bg-gray-900 dark:disabled:text-gray-400"
      >
        <option value="">{t('selectPerson')}</option>
        {filteredMembers.map((m) => (
          <option key={m.id} value={m.id}>
            {m.first_name} {m.last_name}
          </option>
        ))}
      </select>

      {/* Contact info for admins/coaches */}
      {showContact && assignedPerson && (
        <div className="rounded border border-gray-200 px-2 py-1.5 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
          {assignedPerson.phone && (
            <a href={`tel:${assignedPerson.phone}`} className="flex items-center gap-1 hover:text-brand-600 dark:hover:text-brand-400">
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z" />
              </svg>
              {assignedPerson.phone}
            </a>
          )}
          {assignedPerson.email && (
            <a href={`mailto:${assignedPerson.email}`} className="flex items-center gap-1 hover:text-brand-600 dark:hover:text-brand-400">
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
              </svg>
              {assignedPerson.email}
            </a>
          )}
        </div>
      )}

      {/* Self-assign button for regular users */}
      {selfAssignButton && !personValue && (
        <button
          onClick={onSelfAssign}
          className="mt-1 w-full rounded-lg bg-brand-50 px-3 py-2 text-sm font-medium text-brand-700 hover:bg-brand-100 dark:bg-brand-900/20 dark:text-brand-400 dark:hover:bg-brand-900/40"
        >
          {t('selfAssign')}
        </button>
      )}
    </div>
  )
}
