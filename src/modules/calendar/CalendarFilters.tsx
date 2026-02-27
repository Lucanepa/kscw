import FilterChips from '../../components/FilterChips'
import { useTeams } from '../../hooks/useTeams'
import type { CalendarFilterState, SourceFilter } from '../../types/calendar'

interface CalendarFiltersProps {
  filters: CalendarFilterState
  onChange: (filters: CalendarFilterState) => void
}

const sourceOptions = [
  { value: 'game', label: 'Spiele', colorClasses: 'bg-blue-100 text-blue-800 border-blue-200' },
  { value: 'training', label: 'Trainings', colorClasses: 'bg-green-100 text-green-800 border-green-200' },
  { value: 'closure', label: 'Hallensperren', colorClasses: 'bg-red-100 text-red-800 border-red-200' },
  { value: 'event', label: 'Events', colorClasses: 'bg-purple-100 text-purple-800 border-purple-200' },
]

export default function CalendarFilters({ filters, onChange }: CalendarFiltersProps) {
  const { data: teams } = useTeams()

  const teamChipOptions = teams.map((t) => ({
    value: t.id,
    label: t.name,
  }))

  return (
    <div className="flex flex-wrap items-center gap-4">
      <FilterChips
        options={sourceOptions}
        selected={filters.sources}
        onChange={(sources) => onChange({ ...filters, sources: sources as SourceFilter[] })}
      />

      {teamChipOptions.length > 0 && (
        <div className="border-l border-gray-200 pl-4">
          <FilterChips
            options={teamChipOptions}
            selected={filters.selectedTeamIds}
            onChange={(ids) => onChange({ ...filters, selectedTeamIds: ids })}
          />
        </div>
      )}
    </div>
  )
}
