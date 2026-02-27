interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg'
  label?: string
}

const sizeMap = {
  sm: 'h-8 w-8',
  md: 'h-12 w-12',
  lg: 'h-16 w-16',
}

export default function LoadingSpinner({ size = 'md', label }: LoadingSpinnerProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12">
      <img
        src="/kscw_logo_vektoren.svg"
        alt="Laden..."
        className={`${sizeMap[size]} animate-spin`}
        style={{ animationDuration: '2s' }}
      />
      {label && (
        <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">{label}</p>
      )}
    </div>
  )
}
