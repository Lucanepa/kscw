import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import StatusBadge from '../../components/StatusBadge'
import { getFileUrl } from '../../utils/pbFile'
import type { ExpandedMemberTeam } from '../../hooks/useTeamMembers'

interface MemberRowProps {
  memberTeam: ExpandedMemberTeam
  teamId: string
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
  player: { bg: '#f3f4f6', text: '#374151' },
}

export default function MemberRow({ memberTeam, teamId }: MemberRowProps) {
  const { t } = useTranslation('teams')
  const member = memberTeam.expand?.member
  if (!member) return null

  const initials = `${member.first_name?.[0] ?? ''}${member.last_name?.[0] ?? ''}`.toUpperCase()

  return (
    <tr className="border-b last:border-0 hover:bg-gray-50 dark:hover:bg-gray-700">
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          {member.photo ? (
            <img
              src={getFileUrl('members', member.id, member.photo)}
              alt={member.name}
              className="h-8 w-8 rounded-full object-cover"
            />
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-200 text-xs font-medium text-gray-600 dark:text-gray-400">
              {initials}
            </div>
          )}
          <Link
            to={`/teams/player/${member.id}?from=${teamId}`}
            className="text-sm font-medium text-gray-900 hover:text-brand-600"
          >
            {member.name}
          </Link>
        </div>
      </td>
      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
        {member.number || '—'}
      </td>
      <td className="hidden px-4 py-3 text-sm text-gray-500 sm:table-cell dark:text-gray-400">
        {positionKeys[member.position] ? t(positionKeys[member.position]) : member.position}
      </td>
      <td className="px-4 py-3">
        <StatusBadge status={memberTeam.role} colorMap={roleColors} />
      </td>
    </tr>
  )
}
