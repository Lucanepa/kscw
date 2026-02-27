import TeamChip from '../../../components/TeamChip'
import { teamColors } from '../../../utils/teamColors'

const TEAM_ORDER = Object.keys(teamColors)

interface TeamFilterBarProps {
  selected: string[]
  onChange: (selected: string[]) => void
  multiSelect?: boolean
  showAll?: boolean
}

export default function TeamFilterBar({
  selected,
  onChange,
  multiSelect = true,
  showAll = true,
}: TeamFilterBarProps) {
  const allSelected = selected.length === 0

  function handleClick(team: string) {
    if (multiSelect) {
      if (selected.includes(team)) {
        onChange(selected.filter((t) => t !== team))
      } else {
        onChange([...selected, team])
      }
    } else {
      onChange(selected.includes(team) ? [] : [team])
    }
  }

  return (
    <div className="flex gap-2 overflow-x-auto pb-2">
      {showAll && (
        <button
          onClick={() => onChange([])}
          className={`shrink-0 rounded-full border px-3 py-1 text-sm font-semibold transition-opacity ${
            allSelected
              ? 'border-gray-400 bg-gray-600 text-white'
              : 'border-gray-300 bg-gray-100 text-gray-500 opacity-50 hover:opacity-75'
          }`}
        >
          Alle
        </button>
      )}
      {TEAM_ORDER.map((team) => (
        <button
          key={team}
          onClick={() => handleClick(team)}
          className={`shrink-0 transition-opacity ${
            !allSelected && !selected.includes(team) ? 'opacity-40 hover:opacity-70' : ''
          }`}
        >
          <TeamChip team={team} />
        </button>
      ))}
    </div>
  )
}
