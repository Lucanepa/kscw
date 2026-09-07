import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Home as HomeIcon, Plane, ChevronLeft, ChevronRight } from 'lucide-react'
import {
  DndContext,
  useDraggable,
  useDroppable,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import TeamChip from '../../components/TeamChip'
import { cn } from '../../lib/utils'
import { formatDate, isSameDay, toDateKey } from '../../utils/dateUtils'
import { formatTime } from '../../utils/dateHelpers'
import type { CalendarEntry } from '../../types/calendar'
import type { Game } from '../../types'
import { opponentName } from './gameChipUtils'
import AbsenceBadge from './AbsenceBadge'
import CrossTeamBadge from './CrossTeamBadge'
import type { AbsentMember } from './utils/absencesByDate'
import type { CrossTeamConflict } from './hooks/useCrossTeamConflicts'
import {
  getWeekDays,
  getBlockPixelPosition,
  WEEK_START_HOUR,
  WEEK_END_HOUR,
} from './utils/weekView'
import { pixelDeltaToSnappedMinutes, applyTimeDelta } from './utils/weekDnd'

const PX_PER_HOUR = 48

export interface WeekViewMove {
  gameId: string | number
  newDate: string // YYYY-MM-DD
  newTime: string // HH:MM
}

interface WeekViewProps {
  entries: CalendarEntry[]
  weekStart: Date
  onWeekChange: (week: Date) => void
  onGameClick?: (game: Game) => void
  /** When provided, manual games owned by the caller become draggable. */
  canEdit?: (game: Game) => boolean
  onMove?: (move: WeekViewMove) => void
  /** date key (yyyy-MM-dd) -> members unavailable for games that day. */
  absencesByDate?: Map<string, AbsentMember[]>
  /** date key (yyyy-MM-dd) -> roster-sharing teams playing that day. */
  crossTeamByDate?: Map<string, CrossTeamConflict[]>
  /** True while the absence overlay is still fetching: `absencesByDate` is empty
   *  because the answer is unknown, NOT because nobody is away. Render a pending
   *  pill instead of the day's real count. */
  absencesPending?: boolean
  /** Same, for the cross-team overlay. */
  crossTeamPending?: boolean
}

export default function WeekView({
  entries,
  weekStart,
  onWeekChange,
  onGameClick,
  canEdit,
  onMove,
  absencesByDate,
  crossTeamByDate,
  absencesPending = false,
  crossTeamPending = false,
}: WeekViewProps) {
  const { t } = useTranslation('spielplanung')
  const days = useMemo(() => getWeekDays(weekStart), [weekStart])
  const today = new Date()
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  )

  const gamesByDay = useMemo(() => {
    const map = new Map<string, CalendarEntry[]>()
    for (const entry of entries) {
      if (entry.type !== 'game') continue
      if (!entry.startTime) continue
      const key = toDateKey(entry.date)
      const existing = map.get(key) ?? []
      existing.push(entry)
      map.set(key, existing)
    }
    return map
  }, [entries])

  const rows = Array.from({ length: WEEK_END_HOUR - WEEK_START_HOUR }, (_, i) => WEEK_START_HOUR + i)
  const railHeight = (WEEK_END_HOUR - WEEK_START_HOUR) * PX_PER_HOUR

  function goPrev() {
    const next = new Date(days[0])
    next.setDate(next.getDate() - 7)
    onWeekChange(next)
  }
  function goNext() {
    const next = new Date(days[0])
    next.setDate(next.getDate() + 7)
    onWeekChange(next)
  }
  function goToday() {
    onWeekChange(new Date())
  }

  function onDragEnd(ev: DragEndEvent) {
    if (!onMove) return
    const game = (ev.active.data.current as { game?: Game } | undefined)?.game
    if (!game) return
    const deltaMin = pixelDeltaToSnappedMinutes(ev.delta.y, PX_PER_HOUR)
    const currentTime = typeof game.time === 'string' ? game.time : ''
    if (!currentTime) return
    const newTime = applyTimeDelta(currentTime, deltaMin)
    const dropTarget = ev.over?.id
    const currentDateKey = typeof game.date === 'string' ? game.date : toDateKey(new Date(game.date as unknown as string))
    const newDate = typeof dropTarget === 'string' && dropTarget ? dropTarget : currentDateKey
    if (newDate === currentDateKey && newTime === currentTime) return
    onMove({ gameId: game.id, newDate, newTime })
  }

  const rangeLabel = `${formatDate(days[0], 'MMM d')} – ${formatDate(days[6], 'MMM d, yyyy')}`

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="space-y-3">
        {/* Nav bar */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={goPrev}
            aria-label={t('weekPrev')}
            className="rounded-md border border-gray-300 bg-white p-1.5 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:hover:bg-gray-700"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={goToday}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:hover:bg-gray-700"
          >
            {t('weekToday')}
          </button>
          <button
            type="button"
            onClick={goNext}
            aria-label={t('weekNext')}
            className="rounded-md border border-gray-300 bg-white p-1.5 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:hover:bg-gray-700"
          >
            <ChevronRight className="h-4 w-4" aria-hidden />
          </button>
          <span className="ml-2 text-sm font-medium text-gray-700 dark:text-gray-200">{rangeLabel}</span>
        </div>

        {/* Week grid */}
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
          <div
            className="grid min-w-[700px]"
            style={{ gridTemplateColumns: '50px repeat(7, 1fr)' }}
          >
            {/* Header row */}
            <div className="border-b border-r border-gray-200 bg-muted/30 dark:border-gray-700" />
            {days.map((d) => {
              const isToday = isSameDay(d, today)
              const absent = absencesByDate?.get(toDateKey(d)) ?? []
              const crossTeam = crossTeamByDate?.get(toDateKey(d)) ?? []
              return (
                <div
                  key={d.toISOString()}
                  className={cn(
                    'border-b border-r border-gray-200 p-2 text-center dark:border-gray-700',
                    isToday && 'bg-accent',
                  )}
                >
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    {formatDate(d, 'EEE')}
                  </div>
                  <div className={cn('text-sm font-semibold', isToday && 'text-accent-foreground')}>
                    {formatDate(d, 'd')}
                  </div>
                  {/* Mounted while an overlay is pending too — an unknown count
                      must not look like "nobody away / no conflict". */}
                  {(absent.length > 0 || crossTeam.length > 0 || absencesPending || crossTeamPending) && (
                    <div className="mt-0.5 flex justify-center gap-1">
                      {crossTeamPending ? (
                        <span
                          role="img"
                          aria-label={t('common:loading')}
                          className="h-3 w-5 animate-pulse rounded-full bg-sky-100 dark:bg-sky-900/40"
                        />
                      ) : crossTeam.length > 0 && <CrossTeamBadge conflicts={crossTeam} />}
                      {absencesPending ? (
                        <span
                          role="img"
                          aria-label={t('common:loading')}
                          className="h-3 w-5 animate-pulse rounded-full bg-amber-100 dark:bg-amber-900/40"
                        />
                      ) : absent.length > 0 && <AbsenceBadge absent={absent} />}
                    </div>
                  )}
                </div>
              )
            })}

            {/* Time rail */}
            <div
              className="relative border-r border-gray-200 dark:border-gray-700"
              style={{ height: railHeight }}
            >
              {rows.map((h, idx) => (
                <div
                  key={h}
                  className="absolute left-0 right-0 flex -translate-y-2 justify-end pr-1 text-[10px] text-muted-foreground"
                  style={{ top: idx * PX_PER_HOUR }}
                >
                  {String(h).padStart(2, '0')}:00
                </div>
              ))}
            </div>

            {/* Day columns */}
            {days.map((d) => {
              const dayGames = gamesByDay.get(toDateKey(d)) ?? []
              return (
                <DayColumn
                  key={d.toISOString()}
                  date={d}
                  isToday={isSameDay(d, today)}
                  railHeight={railHeight}
                  rows={rows}
                >
                  {dayGames.map((entry) => {
                    const game = entry.source as Game
                    const draggable = !!onMove && !!canEdit && canEdit(game) && game.source === 'manual'
                    return (
                      <GameBlock
                        key={entry.id}
                        entry={entry}
                        game={game}
                        draggable={draggable}
                        onClick={onGameClick}
                      />
                    )
                  })}
                </DayColumn>
              )
            })}
          </div>
        </div>
      </div>
    </DndContext>
  )
}

function DayColumn({
  date,
  isToday,
  railHeight,
  rows,
  children,
}: {
  date: Date
  isToday: boolean
  railHeight: number
  rows: number[]
  children: React.ReactNode
}) {
  const dateKey = toDateKey(date)
  const { setNodeRef, isOver } = useDroppable({ id: dateKey })
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'relative border-r border-gray-200 dark:border-gray-700',
        isToday && 'bg-accent/30',
        isOver && 'bg-accent/50 dark:bg-accent/40',
      )}
      style={{ height: railHeight }}
    >
      {rows.map((_h, idx) => (
        <div
          key={idx}
          className="absolute left-0 right-0 border-t border-gray-100 dark:border-gray-800"
          style={{ top: idx * PX_PER_HOUR }}
        />
      ))}
      {children}
    </div>
  )
}

function GameBlock({
  entry,
  game,
  draggable,
  onClick,
}: {
  entry: CalendarEntry
  game: Game
  draggable: boolean
  onClick?: (game: Game) => void
}) {
  const pos = getBlockPixelPosition(entry.startTime ?? '', PX_PER_HOUR)
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: String(game.id),
    disabled: !draggable,
    data: { game },
  })
  if (!pos) return null
  const isHome = game.type === 'home'
  const isManual = game.source === 'manual'
  const teamName = entry.teamNames[0] ?? '?'
  const opponent = opponentName(game)
  const time = game.time ? formatTime(game.time) : ''

  const style: React.CSSProperties = {
    top: pos.top,
    height: pos.height,
    transform: CSS.Translate.toString(transform),
    zIndex: isDragging ? 20 : undefined,
    opacity: isDragging ? 0.85 : 1,
    cursor: draggable ? (isDragging ? 'grabbing' : 'grab') : 'pointer',
    touchAction: draggable ? 'none' : undefined,
  }

  const ariaLabel = `${teamName}, ${isHome ? 'home' : 'away'}${time ? `, ${time}` : ''}, ${opponent}`

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'absolute left-1 right-1 overflow-hidden rounded-sm border-l-[3px] bg-muted/70 px-1.5 py-1 text-left text-[11px] leading-tight transition-colors hover:bg-muted',
        isHome
          ? 'border-emerald-500 dark:border-emerald-400'
          : 'border-blue-500 dark:border-blue-400',
        isManual && 'outline outline-1 outline-dashed outline-muted-foreground/60 outline-offset-[-1px]',
      )}
      style={style}
      onClick={onClick ? (e) => {
        if (isDragging) return
        e.stopPropagation()
        onClick(game)
      } : undefined}
      aria-label={ariaLabel}
      {...attributes}
      {...listeners}
    >
      <div className="flex items-center gap-1">
        <TeamChip team={teamName} size="xs" className="shrink-0 !px-1 !py-0 !text-[9px]" />
        {isHome ? (
          <HomeIcon className="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
        ) : (
          <Plane className="h-3 w-3 shrink-0 text-blue-600 dark:text-blue-400" aria-hidden />
        )}
        {time && <span className="shrink-0 font-semibold text-foreground">{time}</span>}
      </div>
      <div className="truncate text-muted-foreground">{opponent}</div>
    </div>
  )
}
