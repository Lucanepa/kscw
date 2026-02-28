import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { Member, Team } from '../../../types'

export type DutyRole = 'scorer' | 'taefeler' | 'scorer_taefeler'

interface AssignmentEditorProps {
  label: string
  roleType: DutyRole
  teamValue: string
  personValue: string
  members: Member[]
  teams: Team[]
  onTeamChange: (teamId: string) => void
  onPersonChange: (memberId: string) => void
  disabled: boolean
}

export default function AssignmentEditor({
  label,
  roleType,
  teamValue,
  personValue,
  members,
  teams,
  onTeamChange,
  onPersonChange,
  disabled,
}: AssignmentEditorProps) {
  const { t } = useTranslation('scorer')

  const filteredMembers = useMemo(() => {
    let list = members.filter((m) => m.active)
    if (roleType === 'scorer' || roleType === 'scorer_taefeler') {
      list = list.filter((m) => m.scorer_licence)
    }
    return list.sort((a, b) =>
      `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`, 'de'),
    )
  }, [members, roleType])

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
    </div>
  )
}
