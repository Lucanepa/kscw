import TeamChip from '../../../components/TeamChip'
import { getTeamColor } from '../../../utils/teamColors'
import ConflictBadge from './ConflictBadge'
import type { PositionedSlot } from '../utils/timeGrid'

const typeLabels: Record<string, string> = {
  training: 'Training',
  game: 'Spiel',
  event: 'Event',
  other: '',
}

interface SlotBlockProps {
  positioned: PositionedSlot
  teamName: string
  hasConflict: boolean
  isAdmin: boolean
  onClick: () => void
}

export default function SlotBlock({ positioned, teamName, hasConflict, isAdmin, onClick }: SlotBlockProps) {
  const { slot, top, height, left, width } = positioned
  const color = getTeamColor(teamName)
  const showDetails = height >= 48 // at least 2 rows (1 hour)
  const showTime = height >= 36

  return (
    <div
      className={`absolute z-20 overflow-hidden rounded-md border-l-4 px-1.5 py-0.5 text-xs leading-tight shadow-sm transition-all ${
        isAdmin ? 'cursor-pointer hover:brightness-95' : ''
      }`}
      style={{
        top,
        height: height - 2, // 2px gap
        left: `${left}%`,
        width: `calc(${width}% - 2px)`,
        backgroundColor: color.bg + 'e6', // slight transparency
        color: color.text,
        borderColor: color.border,
      }}
      onClick={isAdmin ? onClick : undefined}
      title={`${teamName} — ${slot.start_time}–${slot.end_time}${slot.label ? ` — ${slot.label}` : ''}`}
    >
      <div className="relative">
        {hasConflict && <ConflictBadge />}
        <div className="flex items-center gap-1">
          <TeamChip team={teamName} size="sm" />
          {showDetails && slot.slot_type !== 'training' && (
            <span className="opacity-80">{typeLabels[slot.slot_type]}</span>
          )}
        </div>
        {showTime && (
          <div className="mt-0.5 opacity-80">
            {slot.start_time}–{slot.end_time}
          </div>
        )}
        {showDetails && slot.label && (
          <div className="mt-0.5 truncate font-medium">{slot.label}</div>
        )}
      </div>
    </div>
  )
}
