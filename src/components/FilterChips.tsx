import { getTeamColor } from '../utils/teamColors'

interface FilterChipOption {
  value: string
  label: string
  /** Tailwind classes for selected state (e.g. "bg-blue-100 text-blue-800 border-blue-200") */
  colorClasses?: string
}

interface FilterChipsProps {
  options: FilterChipOption[]
  selected: string[]
  onChange: (selected: string[]) => void
  multiple?: boolean
}

export default function FilterChips({
  options,
  selected,
  onChange,
  multiple = true,
}: FilterChipsProps) {
  function handleClick(value: string) {
    if (multiple) {
      if (selected.includes(value)) {
        onChange(selected.filter((v) => v !== value))
      } else {
        onChange([...selected, value])
      }
    } else {
      onChange(selected.includes(value) ? [] : [value])
    }
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const isSelected = selected.includes(option.value)

        if (option.colorClasses) {
          return (
            <button
              key={option.value}
              onClick={() => handleClick(option.value)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                isSelected
                  ? option.colorClasses
                  : 'border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100'
              }`}
            >
              {option.label}
            </button>
          )
        }

        const teamColor = getTeamColor(option.label)
        return (
          <button
            key={option.value}
            onClick={() => handleClick(option.value)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              !isSelected ? 'border border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100' : ''
            }`}
            style={
              isSelected
                ? {
                    backgroundColor: teamColor.bg,
                    color: teamColor.text,
                    borderWidth: '1px',
                    borderStyle: 'solid',
                    borderColor: teamColor.border,
                  }
                : undefined
            }
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
