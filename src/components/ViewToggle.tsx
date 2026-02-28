interface ViewToggleOption {
  value: string
  label: string
}

interface ViewToggleProps {
  options: ViewToggleOption[]
  value: string
  onChange: (value: string) => void
}

export default function ViewToggle({ options, value, onChange }: ViewToggleProps) {
  return (
    <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5 dark:border-gray-600 dark:bg-gray-700">
      {options.map((option) => (
        <button
          key={option.value}
          onClick={() => onChange(option.value)}
          className={`min-h-[44px] rounded-md px-3 py-2 text-sm font-medium transition-colors sm:min-h-0 sm:py-1.5 ${
            value === option.value
              ? 'bg-gold-400 text-brand-900 shadow-sm'
              : 'text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
