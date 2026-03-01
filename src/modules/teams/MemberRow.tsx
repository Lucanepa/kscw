import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import StatusBadge from '../../components/StatusBadge'
import { getFileUrl } from '../../utils/pbFile'
import type { ExpandedMemberTeam } from '../../hooks/useTeamMembers'
import type { Team } from '../../types'

interface MemberRowProps {
  memberTeam: ExpandedMemberTeam
  teamId: string
  team?: Team | null
}

const positionKeys: Record<string, string> = {
  setter: 'positionSetter',
  outside: 'positionOutside',
  middle: 'positionMiddle',
  opposite: 'positionOpposite',
  libero: 'positionLibero',
  coach: 'positionCoach',
  other: 'positionOther',
}

const roleColors: Record<string, { bg: string; text: string }> = {
  captain: { bg: '#fef3c7', text: '#92400e' },
  coach: { bg: '#dbeafe', text: '#1e40af' },
  assistant: { bg: '#e0f2fe', text: '#075985' },
  team_responsible: { bg: '#ede9fe', text: '#5b21b6' },
}

function getMemberRole(memberId: string, team?: Team | null): string | null {
  if (!team) return null
  if (team.coach?.includes(memberId)) return 'coach'
  if (team.assistant?.includes(memberId)) return 'assistant'
  if (team.captain?.includes(memberId)) return 'captain'
  if (team.team_responsible?.includes(memberId)) return 'team_responsible'
  return null
}

export default function MemberRow({ memberTeam, teamId, team }: MemberRowProps) {
  const { t } = useTranslation('teams')
  const member = memberTeam.expand?.member
  if (!member) return null

  const displayName = [member.first_name, member.last_name].filter(Boolean).join(' ') || member.name || '—'
  const initials = `${member.first_name?.[0] ?? ''}${member.last_name?.[0] ?? ''}`.toUpperCase()
  const role = getMemberRole(member.id, team)

  const birthdate = member.birthdate
    ? new Date(member.birthdate).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : null

  return (
    <tr className="border-b last:border-0 hover:bg-gray-50 dark:hover:bg-gray-700">
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          {member.photo ? (
            <img
              src={getFileUrl('members', member.id, member.photo)}
              alt={displayName}
              className="h-8 w-8 rounded-full object-cover"
            />
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-200 text-xs font-medium text-gray-600 dark:text-gray-400">
              {initials}
            </div>
          )}
          <Link
            to={`/teams/player/${member.id}?from=${teamId}`}
            className="text-sm font-medium text-gray-900 hover:text-brand-600 dark:text-gray-100"
          >
            {displayName}
          </Link>
        </div>
      </td>
      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
        {member.number || '—'}
      </td>
      <td className="hidden px-4 py-3 text-sm text-gray-500 sm:table-cell dark:text-gray-400">
        {positionKeys[member.position] ? t(positionKeys[member.position]) : member.position}
      </td>
      <td className="hidden px-4 py-3 text-sm text-gray-500 md:table-cell dark:text-gray-400">
        {member.email || '—'}
      </td>
      <td className="hidden px-4 py-3 text-sm text-gray-500 md:table-cell dark:text-gray-400">
        {member.phone || '—'}
      </td>
      <td className="hidden px-4 py-3 text-sm text-gray-500 lg:table-cell dark:text-gray-400">
        {birthdate || '—'}
      </td>
      <td className="px-4 py-3">
        {role && <StatusBadge status={role} colorMap={roleColors} />}
      </td>
    </tr>
  )
}
