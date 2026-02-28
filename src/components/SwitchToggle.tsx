interface SwitchToggleProps {
  enabled: boolean
  onChange: () => void
  labelLeft: string
  labelRight: string
  size?: 'sm' | 'md'
}

export default function SwitchToggle({ enabled, onChange, labelLeft, labelRight, size = 'sm' }: SwitchToggleProps) {
  const isMd = size === 'md'

  return (
    <button
      type="button"
      onClick={onChange}
      className="flex w-full items-center justify-between gap-2"
    >
      <span className={`${isMd ? 'text-base' : 'text-sm'} text-gray-600 dark:text-gray-400`}>
        {enabled ? labelRight : labelLeft}
      </span>
      <div
        className={`relative inline-flex shrink-0 cursor-pointer items-center rounded-full transition-colors ${
          isMd ? 'h-7 w-12' : 'h-5 w-9'
        } ${enabled ? 'bg-brand-500' : 'bg-gray-300 dark:bg-gray-600'}`}
      >
        <span
          className={`inline-block rounded-full bg-white shadow-sm transition-transform ${
            isMd ? 'h-5 w-5' : 'h-3.5 w-3.5'
          }`}
          style={{
            transform: `translateX(${enabled ? (isMd ? '22px' : '16px') : '2px'})`,
          }}
        />
      </div>
    </button>
  )
}
