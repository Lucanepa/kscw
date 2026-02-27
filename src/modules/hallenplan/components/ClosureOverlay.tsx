import { TOTAL_ROWS, SLOT_HEIGHT } from '../utils/timeGrid'

interface ClosureOverlayProps {
  reason: string
  hallName?: string
}

export default function ClosureOverlay({ reason, hallName }: ClosureOverlayProps) {
  const label = hallName ? `${hallName}: ${reason}` : reason

  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-center pt-2"
      style={{
        height: TOTAL_ROWS * SLOT_HEIGHT,
        backgroundColor: 'rgba(156, 163, 175, 0.15)',
        backgroundImage:
          'repeating-linear-gradient(45deg, transparent, transparent 8px, rgba(156, 163, 175, 0.2) 8px, rgba(156, 163, 175, 0.2) 16px)',
      }}
    >
      <span className="rounded bg-gray-200/80 px-2 py-0.5 text-xs italic text-gray-600">
        Gesperrt: {label}
      </span>
    </div>
  )
}
