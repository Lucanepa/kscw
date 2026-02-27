import { useMemo } from 'react'
import { usePB } from '../../../hooks/usePB'
import type { Game, Training, Event, HallClosure, Team } from '../../../types'
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

function buildDateFilter(field: string, monthStart: string, monthEnd: string): string {
  return `${field} >= "${monthStart}" && ${field} <= "${monthEnd}"`
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
    location: expandedHall?.name ?? '',
    teamNames: expandedTeam ? [expandedTeam.name] : [],
    description: [game.league, game.round].filter(Boolean).join(' | '),
    source: game,
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

export function useCalendarData({ filters, month, enabled = true }: UseCalendarDataOptions) {
  const monthStart = format(startOfMonth(month), 'yyyy-MM-dd')
  const monthEnd = format(endOfMonth(month), 'yyyy-MM-dd')

  const fetchGames = enabled && (filters.sources.length === 0 || filters.sources.includes('game'))
  const fetchTrainings = enabled && (filters.sources.length === 0 || filters.sources.includes('training'))
  const fetchClosures = enabled && (filters.sources.length === 0 || filters.sources.includes('closure'))
  const fetchEvents = enabled && (filters.sources.length === 0 || filters.sources.includes('event'))

  const { data: games, isLoading: gamesLoading } = usePB<Game>('games', {
    enabled: fetchGames,
    filter: addTeamFilter(
      buildDateFilter('date', monthStart, monthEnd),
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
      buildDateFilter('date', monthStart, monthEnd),
      filters.selectedTeamIds,
      'team',
    ),
    expand: 'team,hall',
    sort: 'date,start_time',
    all: true,
  })

  const { data: closuresRaw, isLoading: closuresLoading } = usePB<HallClosure>('hall_closures', {
    enabled: fetchClosures,
    filter: `start_date <= "${monthEnd}" && end_date >= "${monthStart}"`,
    expand: 'hall',
    all: true,
  })

  const { data: events, isLoading: eventsLoading } = usePB<Event>('events', {
    enabled: fetchEvents,
    filter: buildDateFilter('start_date', monthStart, monthEnd),
    sort: 'start_date',
    all: true,
  })

  const entries = useMemo(() => {
    const all: CalendarEntry[] = []

    if (fetchGames) all.push(...games.map(gameToEntry))
    if (fetchTrainings) all.push(...trainings.map(trainingToEntry))
    if (fetchEvents) all.push(...events.map(eventToEntry))
    if (fetchClosures) {
      for (const c of closuresRaw) {
        all.push(...closureToEntries(c))
      }
    }

    all.sort((a, b) => {
      const dateCmp = toDateKey(a.date).localeCompare(toDateKey(b.date))
      if (dateCmp !== 0) return dateCmp
      if (a.allDay && !b.allDay) return -1
      if (!a.allDay && b.allDay) return 1
      return (a.startTime ?? '').localeCompare(b.startTime ?? '')
    })

    return all
  }, [games, trainings, events, closuresRaw, fetchGames, fetchTrainings, fetchEvents, fetchClosures])

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
    isLoading: gamesLoading || trainingsLoading || closuresLoading || eventsLoading,
    error: null,
  }
}
