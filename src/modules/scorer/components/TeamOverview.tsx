import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { Game, Member } from '../../../types'
import type { ExpandedGame } from './ScorerRow'
import { DutyStatus } from './ScorerRow'
import TeamChip from '../../../components/TeamChip'

interface TeamOverviewProps {
  games: Game[]
  members: Member[]
}

interface DutyEntry {
  game: ExpandedGame
  dutyType: 'scorer' | 'taefeler' | 'scorer_taefeler'
  teamName: string
  memberName: string | null
}

const dateFormatter = new Intl.DateTimeFormat('de-CH', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
})

export default function TeamOverview({ games, members }: TeamOverviewProps) {
  const { t } = useTranslation('scorer')

  const memberMap = useMemo(() => {
    const map = new Map<string, Member>()
    for (const m of members) map.set(m.id, m)
    return map
  }, [members])

  // Group duties by team
  const teamDuties = useMemo(() => {
    const map = new Map<string, DutyEntry[]>()

    for (const game of games) {
      const eg = game as ExpandedGame

      // Combined mode
      if (game.scorer_taefeler_duty_team) {
        const teamName = eg.expand?.scorer_taefeler_duty_team?.name ?? '?'
        const member = game.scorer_taefeler_member ? memberMap.get(game.scorer_taefeler_member) : null
        const entry: DutyEntry = {
          game: eg,
          dutyType: 'scorer_taefeler',
          teamName,
          memberName: member ? `${member.first_name} ${member.last_name}` : null,
        }
        if (!map.has(teamName)) map.set(teamName, [])
        map.get(teamName)!.push(entry)
      }

      // Separate: scorer
      if (game.scorer_duty_team) {
        const teamName = eg.expand?.scorer_duty_team?.name ?? '?'
        const member = game.scorer_member ? memberMap.get(game.scorer_member) : null
        const entry: DutyEntry = {
          game: eg,
          dutyType: 'scorer',
          teamName,
          memberName: member ? `${member.first_name} ${member.last_name}` : null,
        }
        if (!map.has(teamName)) map.set(teamName, [])
        map.get(teamName)!.push(entry)
      }

      // Separate: taefeler
      if (game.taefeler_duty_team) {
        const teamName = eg.expand?.taefeler_duty_team?.name ?? '?'
        const member = game.taefeler_member ? memberMap.get(game.taefeler_member) : null
        const entry: DutyEntry = {
          game: eg,
          dutyType: 'taefeler',
          teamName,
          memberName: member ? `${member.first_name} ${member.last_name}` : null,
        }
        if (!map.has(teamName)) map.set(teamName, [])
        map.get(teamName)!.push(entry)
      }
    }

    // Sort entries within each team by date
    for (const entries of map.values()) {
      entries.sort((a, b) => a.game.date.localeCompare(b.game.date) || a.game.time.localeCompare(b.game.time))
    }

    // Sort teams alphabetically
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b, 'de'))
  }, [games, memberMap])

  if (teamDuties.length === 0) {
    return (
      <div className="py-12 text-center text-gray-500 dark:text-gray-400">
        <p>{t('overviewEmpty')}</p>
      </div>
    )
  }

  const dutyLabel: Record<string, string> = {
    scorer: t('scorer'),
    taefeler: t('referee'),
    scorer_taefeler: t('scorerTaefeler'),
  }

  return (
    <div className="mt-6 grid gap-6 md:grid-cols-2">
      {teamDuties.map(([teamName, entries]) => (
        <div key={teamName} className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
          <div className="flex items-center gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
            <TeamChip team={teamName} />
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {t('dutyCount', { count: entries.length })}
            </span>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-700">
            {entries.map((entry, i) => (
              <div key={`${entry.game.id}-${entry.dutyType}-${i}`} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {dateFormatter.format(new Date(entry.game.date))} · {entry.game.time}
                  </div>
                  <div className="truncate text-sm font-medium dark:text-gray-200">
                    {entry.game.home_team} – {entry.game.away_team}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <span className="block text-xs text-gray-500 dark:text-gray-400">{dutyLabel[entry.dutyType]}</span>
                  <span className={`text-sm ${entry.memberName ? 'font-medium dark:text-gray-200' : 'text-red-500'}`}>
                    {entry.memberName ?? t('unassigned')}
                  </span>
                </div>
                <DutyStatus game={entry.game} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
