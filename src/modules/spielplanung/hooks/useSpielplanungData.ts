import { useMemo } from 'react'
import { usePB } from '../../../hooks/usePB'
import type { Game, HallClosure, Team } from '../../../types'
import type { CalendarEntry, SpielplanungFilterState } from '../../../types/calendar'
import { parseDate, toDateKey, eachDayOfInterval } from '../../../utils/dateUtils'

interface UseSpielplanungDataOptions {
  filters: SpielplanungFilterState
  seasonStart: string
  seasonEnd: string
}

function buildGameFilter(
  filters: SpielplanungFilterState,
  seasonStart: string,
  seasonEnd: string,
): string {
  const parts: string[] = []
  parts.push(`date >= "${seasonStart}" && date <= "${seasonEnd}"`)

  if (filters.sport !== 'all') {
    parts.push(`kscw_team.sport = "${filters.sport}"`)
  }

  if (filters.selectedTeamIds.length > 0) {
    const teamClauses = filters.selectedTeamIds
      .map((id) => `kscw_team = "${id}"`)
      .join(' || ')
    parts.push(`(${teamClauses})`)
  }

  if (filters.gameType !== 'all') {
    parts.push(`type = "${filters.gameType}"`)
  }

  return parts.join(' && ')
}

function gameToCalendarEntry(game: Game): CalendarEntry {
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

export function useSpielplanungData({
  filters,
  seasonStart,
  seasonEnd,
}: UseSpielplanungDataOptions) {
  const gameFilter = buildGameFilter(filters, seasonStart, seasonEnd)

  const {
    data: games,
    isLoading: gamesLoading,
    error: gamesError,
  } = usePB<Game>('games', {
    filter: gameFilter,
    expand: 'kscw_team,hall',
    sort: 'date,time',
    all: true,
  })

  const {
    data: closures,
    isLoading: closuresLoading,
    error: closuresError,
  } = usePB<HallClosure>('hall_closures', {
    filter: `start_date <= "${seasonEnd}" && end_date >= "${seasonStart}"`,
    expand: 'hall',
    all: true,
  })

  const entries = useMemo(() => games.map(gameToCalendarEntry), [games])

  const closedDates = useMemo(() => {
    const dates = new Set<string>()
    for (const closure of closures) {
      const start = parseDate(closure.start_date)
      const end = parseDate(closure.end_date)
      for (const day of eachDayOfInterval(start, end)) {
        dates.add(toDateKey(day))
      }
    }
    return dates
  }, [closures])

  return {
    games,
    entries,
    closures,
    closedDates,
    isLoading: gamesLoading || closuresLoading,
    error: gamesError || closuresError,
  }
}
