interface ConflictBadgeProps {
  tooltip?: string
}

export default function ConflictBadge({ tooltip }: ConflictBadgeProps) {
  return (
    <span
      className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-orange-500 text-xs font-bold text-white shadow-sm"
      title={tooltip ?? 'Überlappung'}
    >
      !
    </span>
  )
}
