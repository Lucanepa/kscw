interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg'
  label?: string
}

const sizeMap = {
  sm: 'h-10 w-10',
  md: 'h-24 w-24',
  lg: 'h-32 w-32',
}

export default function LoadingSpinner({ size = 'md', label }: LoadingSpinnerProps) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center">
      <img
        src="/kscw_logo_vektoren.svg"
        alt="Loading..."
        className={`${sizeMap[size]} animate-spin`}
        style={{ animationDuration: '2s' }}
      />
      {label && (
        <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">{label}</p>
      )}
    </div>
  )
}
