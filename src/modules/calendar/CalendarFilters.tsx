import { useTranslation } from 'react-i18next'
import FilterChips from '../../components/FilterChips'
import { useTeams } from '../../hooks/useTeams'
import type { CalendarFilterState, SourceFilter } from '../../types/calendar'

interface CalendarFiltersProps {
  filters: CalendarFilterState
  onChange: (filters: CalendarFilterState) => void
  allowedSources?: SourceFilter[]
}

export default function CalendarFilters({ filters, onChange, allowedSources }: CalendarFiltersProps) {
  const { t } = useTranslation('calendar')

  const allSourceOptions = [
    { value: 'game', label: t('sourceGames'), colorClasses: 'bg-brand-100 text-brand-800 border-brand-200' },
    { value: 'training', label: t('sourceTrainings'), colorClasses: 'bg-green-100 text-green-800 border-green-200' },
    { value: 'closure', label: t('sourceClosures'), colorClasses: 'bg-red-100 text-red-800 border-red-200' },
    { value: 'event', label: t('sourceEvents'), colorClasses: 'bg-purple-100 text-purple-800 border-purple-200' },
  ]
  const sourceOptions = allowedSources
    ? allSourceOptions.filter((o) => allowedSources.includes(o.value as SourceFilter))
    : allSourceOptions
  const { data: teams } = useTeams()

  const teamChipOptions = teams.map((t) => ({
    value: t.id,
    label: t.name,
  }))

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
      <FilterChips
        options={sourceOptions}
        selected={filters.sources}
        onChange={(sources) => onChange({ ...filters, sources: sources as SourceFilter[] })}
      />

      {teamChipOptions.length > 0 && (
        <div className="border-t border-gray-200 pt-3 sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0 dark:border-gray-700">
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
