const defaultColors: Record<string, { bg: string; text: string }> = {
  present: { bg: '#dcfce7', text: '#166534' },
  absent: { bg: '#fee2e2', text: '#991b1b' },
  late: { bg: '#fef3c7', text: '#92400e' },
  excused: { bg: '#dbeafe', text: '#1e40af' },
  injury: { bg: '#fee2e2', text: '#991b1b' },
  vacation: { bg: '#e0f2fe', text: '#075985' },
  work: { bg: '#ffedd5', text: '#9a3412' },
  personal: { bg: '#f3e8ff', text: '#6b21a8' },
  other: { bg: '#f3f4f6', text: '#374151' },
}

const labelMap: Record<string, string> = {
  present: 'Anwesend',
  absent: 'Abwesend',
  late: 'Verspätet',
  excused: 'Entschuldigt',
  injury: 'Verletzung',
  vacation: 'Ferien',
  work: 'Arbeit',
  personal: 'Persönlich',
  other: 'Anderes',
}

interface StatusBadgeProps {
  status: string
  colorMap?: Record<string, { bg: string; text: string }>
  className?: string
}

export default function StatusBadge({ status, colorMap, className = '' }: StatusBadgeProps) {
  const colors = (colorMap ?? defaultColors)[status] ?? defaultColors.other

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}
      style={{ backgroundColor: colors.bg, color: colors.text }}
    >
      {labelMap[status] ?? status}
    </span>
  )
}
