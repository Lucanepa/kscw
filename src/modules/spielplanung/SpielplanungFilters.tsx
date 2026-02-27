import ViewToggle from '../../components/ViewToggle'
import FilterChips from '../../components/FilterChips'
import { useTeams } from '../../hooks/useTeams'
import type { SpielplanungFilterState, SportFilter, GameTypeFilter } from '../../types/calendar'

interface SpielplanungFiltersProps {
  filters: SpielplanungFilterState
  onChange: (filters: SpielplanungFilterState) => void
}

const sportOptions = [
  { value: 'all', label: 'Alle' },
  { value: 'volleyball', label: 'Volleyball' },
  { value: 'basketball', label: 'Basketball' },
]

const typeOptions = [
  { value: 'all', label: 'Alle' },
  { value: 'home', label: 'Heim' },
  { value: 'away', label: 'Auswärts' },
]

export default function SpielplanungFilters({ filters, onChange }: SpielplanungFiltersProps) {
  const sportForTeams = filters.sport === 'all' ? undefined : filters.sport
  const { data: teams } = useTeams(sportForTeams ?? 'all')

  const teamChipOptions = teams.map((t) => ({
    value: t.id,
    label: t.name,
  }))

  function handleSportChange(value: string) {
    onChange({
      ...filters,
      sport: value as SportFilter,
      selectedTeamIds: [],
    })
  }

  function handleTeamChange(selected: string[]) {
    onChange({ ...filters, selectedTeamIds: selected })
  }

  function handleTypeChange(value: string) {
    onChange({ ...filters, gameType: value as GameTypeFilter })
  }

  function handleAbsencesToggle() {
    onChange({ ...filters, showAbsences: !filters.showAbsences })
  }

  return (
    <div className="flex flex-wrap items-center gap-4">
      <ViewToggle options={sportOptions} value={filters.sport} onChange={handleSportChange} />

      {teamChipOptions.length > 0 && (
        <FilterChips
          options={teamChipOptions}
          selected={filters.selectedTeamIds}
          onChange={handleTeamChange}
        />
      )}

      <ViewToggle options={typeOptions} value={filters.gameType} onChange={handleTypeChange} />

      <label className="flex items-center gap-2 text-sm text-gray-600">
        <input
          type="checkbox"
          checked={filters.showAbsences}
          onChange={handleAbsencesToggle}
          className="rounded border-gray-300"
        />
        Absenzen anzeigen
      </label>
    </div>
  )
}
