import { useMemo } from 'react'
import { usePB } from '../../../hooks/usePB'
import type { Game, Training, Event, HallClosure, HallEvent, Team } from '../../../types'
import type { CalendarEntry, CalendarFilterState } from '../../../types/calendar'
import {
  parseDate,
  toDateKey,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
} from '../../../utils/dateUtils'
import { format } from 'date-fns'

interface UseCalendarDataOptions {
  filters: CalendarFilterState
  month: Date
  enabled?: boolean
}

/**
 * Compute a wide fetch range: from 1 month before to 1 month after the current month.
 * This lets month navigation stay instant (no re-fetch) for ±1 month.
 * When the user navigates further, the range shifts and a single re-fetch occurs.
 */
function useFetchRange(month: Date) {
  return useMemo(() => {
    // Round to quarter boundaries: Jan/Apr/Jul/Oct
    // This gives a stable 4-month window that only shifts every ~3 months of navigation
    const m = month.getMonth()
    const y = month.getFullYear()
    const quarterStart = Math.floor(m / 4) * 4 // 0, 4, 8
    const rangeStart = new Date(y, quarterStart - 1, 1) // 1 month before quarter
    const rangeEnd = new Date(y, quarterStart + 5, 0) // end of month after quarter+3
    return {
      start: format(rangeStart, 'yyyy-MM-dd'),
      end: format(rangeEnd, 'yyyy-MM-dd'),
    }
  }, [month])
}

function buildDateFilter(field: string, rangeStart: string, rangeEnd: string): string {
  return `${field} >= "${rangeStart}" && ${field} <= "${rangeEnd}"`
}

function addTeamFilter(base: string, teamIds: string[], field: string): string {
  if (teamIds.length === 0) return base
  const clauses = teamIds.map((id) => `${field} = "${id}"`).join(' || ')
  return `${base} && (${clauses})`
}

function gameToEntry(game: Game): CalendarEntry {
  const expandedTeam = (game.expand as { kscw_team?: Team })?.kscw_team
  const expandedHall = (game.expand as { hall?: { name: string } })?.hall

  return {
    id: game.id,
    type: 'game',
    title: `${game.home_team} - ${game.away_team}`,
    date: parseDate(game.date),
    startTime: game.time || null,
    endTime: null,
    allDay: false,
    location: expandedHall?.name ?? game.away_hall_json?.name ?? '',
    teamNames: expandedTeam ? [expandedTeam.name] : [],
    description: [game.league, game.round].filter(Boolean).join(' | '),
    source: game,
    gameType: game.type,
  }
}

function trainingToEntry(training: Training): CalendarEntry {
  const expandedTeam = (training.expand as { team?: Team })?.team
  const expandedHall = (training.expand as { hall?: { name: string } })?.hall

  return {
    id: training.id,
    type: 'training',
    title: `Training ${expandedTeam?.name ?? ''}`,
    date: parseDate(training.date),
    startTime: training.start_time || null,
    endTime: training.end_time || null,
    allDay: false,
    location: expandedHall?.name ?? '',
    teamNames: expandedTeam ? [expandedTeam.name] : [],
    description: training.cancelled
      ? `Abgesagt: ${training.cancel_reason ?? ''}`
      : training.notes ?? '',
    source: training,
  }
}

function eventToEntry(event: Event): CalendarEntry {
  return {
    id: event.id,
    type: 'event',
    title: event.title,
    date: parseDate(event.start_date),
    startTime: event.all_day ? null : event.start_date.split(' ')[1]?.slice(0, 5) ?? null,
    endTime: event.all_day ? null : event.end_date?.split(' ')[1]?.slice(0, 5) ?? null,
    allDay: event.all_day,
    location: event.location ?? '',
    teamNames: [],
    description: event.description ?? '',
    source: event,
  }
}

function closureToEntries(closure: HallClosure): CalendarEntry[] {
  const expandedHall = (closure.expand as { hall?: { name: string } })?.hall
  const hallName = expandedHall?.name ?? ''
  const start = parseDate(closure.start_date)
  const end = parseDate(closure.end_date)
  const days = eachDayOfInterval(start, end)

  return days.map((day) => ({
    id: `${closure.id}-${toDateKey(day)}`,
    type: 'closure' as const,
    title: `Hall closure: ${hallName}`,
    date: day,
    startTime: null,
    endTime: null,
    allDay: true,
    location: hallName,
    teamNames: [],
    description: closure.reason ?? '',
    source: closure,
  }))
}

function hallEventToEntry(he: HallEvent): CalendarEntry {
  return {
    id: he.id,
    type: 'hall',
    title: he.title,
    date: parseDate(he.date),
    startTime: he.start_time || null,
    endTime: he.end_time || null,
    allDay: he.all_day,
    location: he.location ?? '',
    teamNames: [],
    description: '',
    source: he,
  }
}

export function useCalendarData({ filters, month, enabled = true }: UseCalendarDataOptions) {
  // Fetch a wide range (stable ~6-month window) so month navigation is instant
  const fetchRange = useFetchRange(month)

  const monthStartDate = startOfMonth(month)
  const monthEndDate = endOfMonth(month)

  const noSourceFilter = filters.sources.length === 0
  const wantHome = noSourceFilter || filters.sources.includes('game-home')
  const wantAway = noSourceFilter || filters.sources.includes('game-away')
  const fetchGames = enabled && (wantHome || wantAway)
  const fetchTrainings = enabled && (noSourceFilter || filters.sources.includes('training'))
  const fetchClosures = enabled && (noSourceFilter || filters.sources.includes('closure'))
  const fetchEvents = enabled && (noSourceFilter || filters.sources.includes('event'))
  const fetchHallEvents = enabled && (noSourceFilter || filters.sources.includes('hall'))

  const { data: games, isLoading: gamesLoading } = usePB<Game>('games', {
    enabled: fetchGames,
    filter: addTeamFilter(
      buildDateFilter('date', fetchRange.start, fetchRange.end),
      filters.selectedTeamIds,
      'kscw_team',
    ),
    expand: 'kscw_team,hall',
    sort: 'date,time',
    all: true,
  })

  const { data: trainings, isLoading: trainingsLoading } = usePB<Training>('trainings', {
    enabled: fetchTrainings,
    filter: addTeamFilter(
      buildDateFilter('date', fetchRange.start, fetchRange.end),
      filters.selectedTeamIds,
      'team',
    ),
    expand: 'team,hall',
    sort: 'date,start_time',
    all: true,
  })

  const { data: closuresRaw, isLoading: closuresLoading } = usePB<HallClosure>('hall_closures', {
    enabled: fetchClosures,
    filter: `start_date <= "${fetchRange.end}" && end_date >= "${fetchRange.start}"`,
    expand: 'hall',
    all: true,
  })

  const { data: events, isLoading: eventsLoading } = usePB<Event>('events', {
    enabled: fetchEvents,
    filter: buildDateFilter('start_date', fetchRange.start, fetchRange.end),
    sort: 'start_date',
    all: true,
  })

  const { data: hallEvents, isLoading: hallEventsLoading } = usePB<HallEvent>('hall_events', {
    enabled: fetchHallEvents,
    filter: buildDateFilter('date', fetchRange.start, fetchRange.end),
    sort: 'date,start_time',
    all: true,
  })

  // Build all entries from wide-range data, then filter to current month
  const entries = useMemo(() => {
    const all: CalendarEntry[] = []

    if (fetchGames) {
      for (const g of games) {
        const entry = gameToEntry(g)
        if (wantHome && wantAway) {
          all.push(entry)
        } else if (wantHome && entry.gameType === 'home') {
          all.push(entry)
        } else if (wantAway && entry.gameType === 'away') {
          all.push(entry)
        }
      }
    }
    if (fetchTrainings) all.push(...trainings.map(trainingToEntry))
    if (fetchEvents) all.push(...events.map(eventToEntry))
    if (fetchClosures) {
      for (const c of closuresRaw) {
        all.push(...closureToEntries(c))
      }
    }
    if (fetchHallEvents) all.push(...hallEvents.map(hallEventToEntry))

    // Filter to current month client-side
    const filtered = all.filter((entry) => {
      return entry.date >= monthStartDate && entry.date <= monthEndDate
    })

    filtered.sort((a, b) => {
      const dateCmp = toDateKey(a.date).localeCompare(toDateKey(b.date))
      if (dateCmp !== 0) return dateCmp
      if (a.allDay && !b.allDay) return -1
      if (!a.allDay && b.allDay) return 1
      return (a.startTime ?? '').localeCompare(b.startTime ?? '')
    })

    return filtered
  }, [games, trainings, events, closuresRaw, hallEvents, fetchGames, fetchTrainings, fetchEvents, fetchClosures, fetchHallEvents, wantHome, wantAway, monthStartDate, monthEndDate])

  const closedDates = useMemo(() => {
    const dates = new Set<string>()
    for (const closure of closuresRaw) {
      const start = parseDate(closure.start_date)
      const end = parseDate(closure.end_date)
      for (const day of eachDayOfInterval(start, end)) {
        dates.add(toDateKey(day))
      }
    }
    return dates
  }, [closuresRaw])

  return {
    entries,
    closedDates,
    isLoading: gamesLoading || trainingsLoading || closuresLoading || eventsLoading || hallEventsLoading,
    error: null,
  }
}
