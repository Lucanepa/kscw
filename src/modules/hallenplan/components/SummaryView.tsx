import { useMemo } from 'react'
import type { HallSlot, HallClosure, Hall } from '../../../types'
import { toISODate } from '../../../utils/dateHelpers'
import { timeToMinutes } from '../../../utils/dateHelpers'
import { getTeamColor } from '../../../utils/teamColors'
import { START_HOUR, END_HOUR } from '../utils/timeGrid'

const DAY_HEADERS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const
const SUMMARY_ROW_HEIGHT = 20 // px per 30-min row
const SUMMARY_INTERVAL = 30

const typeLabels: Record<string, string> = {
  training: 'Training',
  game: 'Spiel',
  event: 'Event',
  away: 'Auswärts',
  other: '',
}

interface CellInfo {
  teamName: string
  slotType: string
  label: string
  isAway: boolean
  isCancelled: boolean
  slotId: string
}

interface SummaryViewProps {
  slots: HallSlot[]
  closures: HallClosure[]
  weekDays: Date[]
  halls: Hall[]
}

export default function SummaryView({ slots, closures, weekDays, halls }: SummaryViewProps) {
  const visibleHalls = useMemo(() => {
    const hallsWithSlots = new Set(slots.map((s) => s.hall))
    const hallsWithClosures = new Set(closures.map((c) => c.hall))
    const activeHallIds = new Set([...hallsWithSlots, ...hallsWithClosures])
    return halls.filter((h) => activeHallIds.has(h.id))
  }, [halls, slots, closures])

  const visibleDays = useMemo(() => {
    const daysWithContent = new Set<number>()
    for (const s of slots) daysWithContent.add(s.day_of_week)
    for (const c of closures) {
      for (let i = 0; i < 7; i++) {
        const dayStr = toISODate(weekDays[i])
        if (dayStr >= c.start_date && dayStr <= c.end_date) daysWithContent.add(i)
      }
    }
    for (let i = 0; i < 5; i++) daysWithContent.add(i)
    return Array.from(daysWithContent).sort((a, b) => a - b)
  }, [slots, closures, weekDays])

  const timeRows = useMemo(() => {
    const rows: { time: string; minutes: number }[] = []
    for (let h = START_HOUR; h < END_HOUR; h++) {
      for (let m = 0; m < 60; m += SUMMARY_INTERVAL) {
        rows.push({
          time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
          minutes: h * 60 + m,
        })
      }
    }
    return rows
  }, [])

  // Build lookup: (dayIndex, hallId, rowMinutes) -> cell info (with slotId for merging)
  const cellData = useMemo(() => {
    const map = new Map<string, CellInfo>()

    for (const slot of slots) {
      const startMin = timeToMinutes(slot.start_time)
      const endMin = timeToMinutes(slot.end_time)
      const expanded = (slot as Record<string, unknown>).expand as Record<string, Record<string, unknown>> | undefined
      const teamName = (expanded?.team?.name as string) ?? ''

      for (let m = startMin; m < endMin; m += SUMMARY_INTERVAL) {
        const bucketMin = Math.floor(m / SUMMARY_INTERVAL) * SUMMARY_INTERVAL
        if (bucketMin < START_HOUR * 60 || bucketMin >= END_HOUR * 60) continue
        const key = `${slot.day_of_week}:${slot.hall}:${bucketMin}`
        if (!map.has(key)) {
          map.set(key, {
            teamName,
            slotType: slot.slot_type,
            label: slot.label || '',
            isAway: !!slot._virtual?.isAway,
            isCancelled: !!slot._virtual?.isCancelled,
            slotId: slot.id,
          })
        }
      }
    }
    return map
  }, [slots])

  const closureMap = useMemo(() => {
    const set = new Set<string>()
    for (const c of closures) {
      for (let i = 0; i < 7; i++) {
        const dayStr = toISODate(weekDays[i])
        if (dayStr >= c.start_date && dayStr <= c.end_date) {
          set.add(`${i}:${c.hall}`)
        }
      }
    }
    return set
  }, [closures, weekDays])

  const todayIndex = useMemo(() => {
    const today = toISODate(new Date())
    return weekDays.findIndex((d) => toISODate(d) === today)
  }, [weekDays])

  if (visibleHalls.length === 0) {
    return (
      <div className="rounded-lg bg-white p-8 text-center text-sm text-gray-500 shadow-sm dark:bg-gray-800 dark:text-gray-400">
        No data to display
      </div>
    )
  }

  const totalDataCols = visibleDays.length * visibleHalls.length
  const gridCols = `48px repeat(${totalDataCols}, 1fr)`

  /** Check if previous row has the same slot (for merging) */
  function isPrevSameSlot(dayIndex: number, hallId: string, minutes: number): boolean {
    const prevMin = minutes - SUMMARY_INTERVAL
    if (prevMin < START_HOUR * 60) return false
    const prevCell = cellData.get(`${dayIndex}:${hallId}:${prevMin}`)
    const currCell = cellData.get(`${dayIndex}:${hallId}:${minutes}`)
    if (!prevCell || !currCell) return false
    return prevCell.slotId === currCell.slotId
  }


  return (
    <div className="overflow-x-auto rounded-lg bg-white shadow-sm dark:bg-gray-800" style={{ touchAction: 'pan-x pinch-zoom' }}>
      {/* Day headers */}
      <div className="grid border-b border-gray-200 dark:border-gray-700" style={{ gridTemplateColumns: gridCols }}>
        <div className="border-r border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900" />
        {visibleDays.map((dayIndex) => {
          const day = weekDays[dayIndex]
          const dateStr = `${String(day.getDate()).padStart(2, '0')}.${String(day.getMonth() + 1).padStart(2, '0')}`
          return (
            <div
              key={dayIndex}
              className={`border-r border-gray-200 py-1 text-center last:border-r-0 dark:border-gray-700 ${
                dayIndex === todayIndex ? 'bg-brand-50 font-bold text-brand-700 dark:bg-brand-900/30 dark:text-brand-300' : 'text-gray-700 dark:text-gray-300'
              }`}
              style={{ gridColumn: `span ${visibleHalls.length}` }}
            >
              <div className="text-xs font-medium">{DAY_HEADERS[dayIndex]} {dateStr}</div>
            </div>
          )
        })}
      </div>

      {/* Hall sub-headers */}
      <div className="grid border-b border-gray-200 dark:border-gray-700" style={{ gridTemplateColumns: gridCols }}>
        <div className="border-r border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900" />
        {visibleDays.map((dayIndex) =>
          visibleHalls.map((hall, hi) => (
            <div
              key={`${dayIndex}-${hall.id}`}
              className={`border-r px-0.5 py-0.5 text-center text-[10px] font-medium text-gray-500 dark:text-gray-400 ${
                hi === visibleHalls.length - 1 ? 'border-r-gray-200 dark:border-r-gray-700' : 'border-r-gray-100 dark:border-r-gray-800'
              }`}
            >
              {hall.name}
            </div>
          )),
        )}
      </div>

      {/* Time rows */}
      {timeRows.map(({ time, minutes }) => {
        const isFullHour = minutes % 60 === 0
        return (
          <div
            key={time}
            className="grid"
            style={{ gridTemplateColumns: gridCols, height: SUMMARY_ROW_HEIGHT }}
          >
            <div
              className={`flex items-center justify-end border-r border-gray-200 bg-gray-50 pr-1 dark:border-gray-700 dark:bg-gray-900 ${
                isFullHour ? 'text-[10px] font-medium text-gray-500 dark:text-gray-400' : ''
              }`}
            >
              {isFullHour ? time : ''}
            </div>

            {visibleDays.map((dayIndex) =>
              visibleHalls.map((hall, hi) => {
                const key = `${dayIndex}:${hall.id}:${minutes}`
                const cell = cellData.get(key)
                const isClosed = closureMap.has(`${dayIndex}:${hall.id}`)
                const isLastInDay = hi === visibleHalls.length - 1
                const borderClass = isLastInDay
                  ? 'border-r border-r-gray-200 dark:border-r-gray-700'
                  : 'border-r border-r-gray-100 dark:border-r-gray-800'

                if (isClosed && !cell) {
                  return (
                    <div
                      key={`${dayIndex}-${hall.id}`}
                      className={`${borderClass} ${isFullHour ? 'border-t border-t-gray-200 dark:border-t-gray-700' : ''}`}
                      style={{
                        backgroundColor: 'rgba(156, 163, 175, 0.15)',
                        backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 3px, rgba(156,163,175,0.15) 3px, rgba(156,163,175,0.15) 6px)',
                      }}
                    />
                  )
                }

                if (cell) {
                  const color = cell.slotType === 'event'
                    ? { bg: '#e0f2fe', text: '#0c4a6e', border: '#7dd3fc' }
                    : getTeamColor(cell.teamName)
                  const opacity = cell.isAway ? '55' : cell.isCancelled ? '77' : 'cc'
                  // Only show text on the first row of a contiguous block
                  const isFirstRow = !isPrevSameSlot(dayIndex, hall.id, minutes)
                  const isContinuation = !isFirstRow
                  const displayText = isFirstRow
                    ? (cell.teamName || cell.label?.substring(0, 6) || '')
                    : ''
                  const displayType = isFirstRow && cell.slotType !== 'training'
                    ? typeLabels[cell.slotType] || ''
                    : ''

                  // Suppress horizontal borders within a merged block
                  const topBorder = isContinuation
                    ? ''
                    : isFullHour ? 'border-t border-t-gray-200 dark:border-t-gray-700' : ''

                  return (
                    <div
                      key={`${dayIndex}-${hall.id}`}
                      className={`overflow-hidden px-0.5 text-[8px] font-bold leading-tight ${borderClass} ${topBorder} ${cell.isCancelled ? 'line-through' : ''}`}
                      style={{
                        backgroundColor: color.bg + opacity,
                        color: color.text,
                      }}
                      title={`${cell.teamName || cell.label} — ${typeLabels[cell.slotType] || cell.slotType}`}
                    >
                      {displayText && <span className="truncate">{displayText}</span>}
                      {displayType && <span className="ml-0.5 font-normal opacity-80">{displayType}</span>}
                    </div>
                  )
                }

                return (
                  <div
                    key={`${dayIndex}-${hall.id}`}
                    className={`${borderClass} ${
                      isFullHour ? 'border-t border-t-gray-200 dark:border-t-gray-700' : ''
                    }`}
                  />
                )
              }),
            )}
          </div>
        )
      })}

    </div>
  )
}
