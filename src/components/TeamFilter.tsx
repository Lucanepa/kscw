import { usePB } from '../hooks/usePB'
import TeamChip from './TeamChip'
import type { Team } from '../types'

interface TeamFilterProps {
  selected: string | null
  onChange: (teamId: string | null) => void
}

export default function TeamFilter({ selected, onChange }: TeamFilterProps) {
  const { data: teams } = usePB<Team>('teams', { filter: 'active=true', sort: 'name', perPage: 50 })

  return (
    <div className="flex flex-wrap gap-2">
      <button
        onClick={() => onChange(null)}
        className={`rounded-full px-3 py-1 text-sm font-medium transition-colors ${
          selected === null
            ? 'bg-gray-900 text-white'
            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
        }`}
      >
        Alle
      </button>
      {teams.map((team) => (
        <button key={team.id} onClick={() => onChange(team.id)}>
          <TeamChip
            team={team.name}
            size="sm"
            className={selected === team.id ? 'ring-2 ring-offset-1 ring-gray-400' : 'opacity-60 hover:opacity-100'}
          />
        </button>
      ))}
    </div>
  )
}
