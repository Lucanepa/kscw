import TeamChip from '../../../components/TeamChip'
import { getTeamColor } from '../../../utils/teamColors'
import ConflictBadge from './ConflictBadge'
import type { PositionedSlot } from '../utils/timeGrid'

const typeLabels: Record<string, string> = {
  training: 'Training',
  game: 'Spiel',
  event: 'Event',
  away: 'Auswärts',
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
  const isVirtual = !!slot._virtual
  const isAway = !!slot._virtual?.isAway
  const isCancelled = !!slot._virtual?.isCancelled
  const isHallEvent = slot._virtual?.source === 'hall_event'

  const color = isHallEvent
    ? { bg: '#e0f2fe', text: '#0c4a6e', border: '#7dd3fc' } // cyan for hall events
    : getTeamColor(teamName)

  const showDetails = height >= 48
  const showTime = height >= 36
  const clickable = isVirtual || isAdmin

  // Virtual slots get dashed border; away games get striped bg
  const borderStyle = isVirtual ? 'border-dashed' : ''

  const bgOpacity = isAway ? '66' : isCancelled ? '88' : 'e6'

  const awayStripes = isAway
    ? {
        backgroundImage: `repeating-linear-gradient(45deg, transparent, transparent 4px, ${color.border}33 4px, ${color.border}33 8px)`,
      }
    : undefined

  return (
    <div
      className={`absolute z-20 overflow-hidden rounded-md border-l-4 ${borderStyle} px-1.5 py-0.5 text-xs leading-tight shadow-sm transition-all ${
        clickable ? 'cursor-pointer hover:brightness-95' : ''
      }`}
      style={{
        top,
        height: height - 2,
        left: `${left}%`,
        width: `calc(${width}% - 2px)`,
        backgroundColor: color.bg + bgOpacity,
        color: color.text,
        borderColor: color.border,
        ...awayStripes,
      }}
      onClick={clickable ? onClick : undefined}
      title={`${teamName || slot.label} — ${slot.start_time}–${slot.end_time}${slot.label ? ` — ${slot.label}` : ''}`}
    >
      <div className="relative">
        {hasConflict && <ConflictBadge />}
        {/* Auto indicator for virtual slots */}
        {isVirtual && (
          <span
            className="absolute -right-0.5 -top-0.5 z-30 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-white/80 dark:bg-gray-800/80"
            title="Auto"
          >
            <svg className="h-2.5 w-2.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>
          </span>
        )}
        <div className="flex items-center gap-1">
          {teamName ? (
            <TeamChip team={teamName} size="sm" />
          ) : (
            showDetails && <span className="truncate font-medium">{slot.label}</span>
          )}
          {showDetails && slot.slot_type !== 'training' && teamName && (
            <span className={`opacity-80 ${isCancelled ? 'line-through' : ''}`}>
              {typeLabels[slot.slot_type]}
            </span>
          )}
        </div>
        {showTime && (
          <div className={`mt-0.5 opacity-80 ${isCancelled ? 'line-through' : ''}`}>
            {slot.start_time}–{slot.end_time}
          </div>
        )}
        {showDetails && slot.label && teamName && (
          <div className={`mt-0.5 truncate font-medium ${isCancelled ? 'line-through text-gray-500' : ''}`}>
            {slot.label}
          </div>
        )}
      </div>
    </div>
  )
}
