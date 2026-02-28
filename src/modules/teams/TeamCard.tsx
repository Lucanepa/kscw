import { Link } from 'react-router-dom'
import TeamChip from '../../components/TeamChip'
import { getFileUrl } from '../../utils/pbFile'
import type { Team } from '../../types'

interface TeamCardProps {
  team: Team
  memberCount: number
}

export default function TeamCard({ team, memberCount }: TeamCardProps) {
  return (
    <Link
      to={`/teams/${team.id}`}
      className="relative block overflow-hidden rounded-lg border bg-white dark:bg-gray-800 p-5 shadow-sm transition-shadow hover:shadow-md"
      style={{ borderLeftWidth: '4px', borderLeftColor: team.color || '#6b7280' }}
    >
      {team.team_picture && (
        <img
          src={getFileUrl('teams', team.id, team.team_picture)}
          alt=""
          className="absolute inset-0 h-full w-full object-cover opacity-10"
        />
      )}
      <div className="relative">
        <div className="flex items-start justify-between">
          <div>
            <TeamChip team={team.name} />
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{team.full_name}</p>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
          <span>{team.league}</span>
          <span>{team.season}</span>
          <span>{memberCount} players</span>
        </div>
      </div>
    </Link>
  )
}
