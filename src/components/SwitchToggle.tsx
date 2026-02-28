import { type ReactNode } from 'react'

interface SwitchToggleProps {
  enabled: boolean
  onChange: () => void
  labelLeft?: string
  labelRight?: string
  iconOff: ReactNode
  iconOn: ReactNode
  size?: 'sm' | 'md'
}

export default function SwitchToggle({
  enabled,
  onChange,
  labelLeft,
  labelRight,
  iconOff,
  iconOn,
  size = 'sm',
}: SwitchToggleProps) {
  const isMd = size === 'md'

  return (
    <button
      type="button"
      onClick={onChange}
      className="flex items-center gap-2"
    >
      {(labelLeft || labelRight) && (
        <span className={`${isMd ? 'text-base' : 'text-sm'} text-gray-600 dark:text-gray-400`}>
          {enabled ? labelRight : labelLeft}
        </span>
      )}
      <div
        className={`relative inline-flex shrink-0 cursor-pointer items-center rounded-full transition-colors ${
          isMd ? 'h-12 w-[5.25rem]' : 'h-11 w-[4.5rem]'
        } bg-gray-300 dark:bg-gray-600`}
      >
        <span
          className={`inline-flex items-center justify-center overflow-hidden rounded-full bg-white shadow-sm transition-transform ${
            isMd ? 'h-9 w-9' : 'h-8 w-8'
          }`}
          style={{
            transform: `translateX(${enabled ? (isMd ? '2.75rem' : '2.125rem') : '0.375rem'})`,
          }}
        >
          <span className={`${isMd ? 'h-7 w-7' : 'h-5 w-5'} text-gray-600`}>
            {enabled ? iconOn : iconOff}
          </span>
        </span>
      </div>
    </button>
  )
}
