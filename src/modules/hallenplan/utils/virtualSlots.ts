import type { Game, Training, HallEvent, HallSlot, Hall, VirtualSlotMeta } from '../../../types'
import { toISODate, timeToMinutes, minutesToTime } from '../../../utils/dateHelpers'

/** Games occupy the hall from 1h before start, game itself lasts ~2h → 3h total */
const GAME_WARMUP_MINUTES = 60
const GAME_TOTAL_DURATION = 180

/**
 * Converts a home/away game into a virtual HallSlot for the Hallenplan.
 * Home games → placed on game.hall
 * Away games → placed on team's training hall (frees up the slot visually)
 */
export function gameToVirtualSlot(
  game: Game,
  weekDays: Date[],
  teamTrainingHalls: Map<string, string>,
): HallSlot | null {
  const gameDate = game.date.slice(0, 10)
  const dayIndex = weekDays.findIndex((d) => toISODate(d) === gameDate)
  if (dayIndex === -1) return null

  const gameTime = game.time?.slice(0, 5)
  if (!gameTime) return null

  const gameMinutes = timeToMinutes(gameTime)
  const startMinutes = Math.max(gameMinutes - GAME_WARMUP_MINUTES, 0)
  const endMinutes = Math.min(startMinutes + GAME_TOTAL_DURATION, 22 * 60)

  const isAway = game.type === 'away'
  const hallId = isAway ? (teamTrainingHalls.get(game.kscw_team) || '') : game.hall
  if (!hallId) return null

  const expanded = (game as Record<string, unknown>).expand as Record<string, unknown> | undefined

  return {
    id: `game-${game.id}`,
    collectionId: '',
    collectionName: 'virtual',
    created: '',
    updated: '',
    hall: hallId,
    team: game.kscw_team,
    day_of_week: dayIndex,
    start_time: minutesToTime(startMinutes),
    end_time: minutesToTime(endMinutes),
    slot_type: isAway ? 'away' : 'game',
    recurring: false,
    valid_from: gameDate,
    valid_until: gameDate,
    label: isAway
      ? `Auswärts: ${game.home_team} vs ${game.away_team}`
      : `${game.home_team} vs ${game.away_team}`,
    notes: game.league || '',
    expand: expanded ? { team: expanded.kscw_team } : undefined,
    _virtual: {
      source: 'game',
      sourceId: game.id,
      sourceRecord: game,
      isAway,
    },
  } as HallSlot
}

/**
 * Converts a training record into a virtual HallSlot for the Hallenplan.
 */
export function trainingToVirtualSlot(
  training: Training,
  weekDays: Date[],
): HallSlot | null {
  const trainingDate = training.date.slice(0, 10)
  const dayIndex = weekDays.findIndex((d) => toISODate(d) === trainingDate)
  if (dayIndex === -1) return null
  if (!training.start_time || !training.end_time) return null

  const expanded = (training as Record<string, unknown>).expand as Record<string, unknown> | undefined

  return {
    id: `training-${training.id}`,
    collectionId: '',
    collectionName: 'virtual',
    created: '',
    updated: '',
    hall: training.hall,
    team: training.team,
    day_of_week: dayIndex,
    start_time: training.start_time.slice(0, 5),
    end_time: training.end_time.slice(0, 5),
    slot_type: 'training',
    recurring: false,
    valid_from: trainingDate,
    valid_until: trainingDate,
    label: training.cancelled
      ? `Abgesagt${training.cancel_reason ? ': ' + training.cancel_reason : ''}`
      : '',
    notes: training.notes || '',
    expand: expanded ? { team: expanded.team } : undefined,
    _virtual: {
      source: 'training',
      sourceId: training.id,
      sourceRecord: training,
      isCancelled: training.cancelled,
    },
  } as HallSlot
}

/** Patterns to match hall names in GCal event titles/locations */
const HALLE_PATTERNS: [RegExp, string][] = [
  [/Halle\s*(KWI\s*)?A/i, 'KWI A'],
  [/Halle\s*(KWI\s*)?B/i, 'KWI B'],
  [/Halle\s*(KWI\s*)?C/i, 'KWI C'],
]

/** Resolves which hall IDs a GCal event belongs to based on title/location */
function resolveHallEventHalls(event: HallEvent, halls: Hall[]): string[] {
  const text = `${event.title} ${event.location || ''}`
  const matched: string[] = []
  for (const [pattern, hallName] of HALLE_PATTERNS) {
    if (pattern.test(text)) {
      const hall = halls.find((h) => h.name === hallName)
      if (hall) matched.push(hall.id)
    }
  }
  // Default: if no specific hall matched, use all KWI halls
  if (matched.length === 0) {
    return halls.filter((h) => h.name.startsWith('KWI')).map((h) => h.id)
  }
  return matched
}

/**
 * Converts a GCal hall event into one or more virtual HallSlots.
 * May return multiple if the event maps to multiple KWI halls.
 */
export function hallEventToVirtualSlots(
  event: HallEvent,
  weekDays: Date[],
  halls: Hall[],
): HallSlot[] {
  const eventDate = event.date.slice(0, 10)
  const dayIndex = weekDays.findIndex((d) => toISODate(d) === eventDate)
  if (dayIndex === -1) return []

  const hallIds = resolveHallEventHalls(event, halls)

  const startTime = event.all_day || !event.start_time ? '10:00' : event.start_time.slice(0, 5)
  const endTime = event.all_day || !event.end_time ? '22:00' : event.end_time.slice(0, 5)

  return hallIds.map((hallId) => ({
    id: `hall-event-${event.id}-${hallId}`,
    collectionId: '',
    collectionName: 'virtual',
    created: '',
    updated: '',
    hall: hallId,
    team: '',
    day_of_week: dayIndex,
    start_time: startTime,
    end_time: endTime,
    slot_type: 'event' as const,
    recurring: false,
    valid_from: eventDate,
    valid_until: eventDate,
    label: event.title,
    notes: event.location || '',
    _virtual: {
      source: 'hall_event' as const,
      sourceId: event.id,
      sourceRecord: event,
    },
  }) as HallSlot)
}

/**
 * Merges real hall_slots with virtual slots, deduplicating recurring slots
 * that have a corresponding training instance for the same day.
 */
export function mergeVirtualSlots(
  realSlots: HallSlot[],
  virtualSlots: HallSlot[],
): HallSlot[] {
  // Find training virtuals linked to a recurring hall_slot → suppress the template
  const suppressedSlotDays = new Set<string>()
  for (const vs of virtualSlots) {
    if (vs._virtual?.source === 'training') {
      const training = vs._virtual.sourceRecord as Training
      if (training.hall_slot) {
        suppressedSlotDays.add(`${training.hall_slot}-${vs.day_of_week}`)
      }
    }
  }

  const filteredReal = realSlots.filter((slot) => {
    if (!slot.recurring) return true
    const key = `${slot.id}-${slot.day_of_week}`
    return !suppressedSlotDays.has(key)
  })

  return [...filteredReal, ...virtualSlots]
}
