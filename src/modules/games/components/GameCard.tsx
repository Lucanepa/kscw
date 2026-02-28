import { useTranslation } from 'react-i18next'
import type { RecordModel } from 'pocketbase'
import type { Game, Team, Hall } from '../../../types'
import TeamChip from '../../../components/TeamChip'

interface GameCardProps {
  game: Game
  onClick?: (game: Game) => void
  variant?: 'card' | 'compact'
}

type ExpandedGame = Game & {
  expand?: {
    kscw_team?: Team & RecordModel
    hall?: Hall & RecordModel
  }
}

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

function StatusBadge({ status }: { status: Game['status'] }) {
  const { t } = useTranslation('games')

  switch (status) {
    case 'live':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
          {t('statusLive')}
        </span>
      )
    case 'postponed':
      return (
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
          {t('statusPostponed')}
        </span>
      )
    case 'completed':
      return (
        <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700">
          {t('statusCompleted')}
        </span>
      )
    default:
      return null
  }
}

export default function GameCard({ game, onClick, variant = 'card' }: GameCardProps) {
  const expanded = game as ExpandedGame
  const expandedHall = expanded.expand?.hall
  const hallInfo = expandedHall
    ? [expandedHall.name, expandedHall.city].filter(Boolean).join(', ')
    : game.away_hall_json
      ? [game.away_hall_json.name, game.away_hall_json.city].filter(Boolean).join(', ')
      : ''
  const kscwTeamName = expanded.expand?.kscw_team?.name ?? ''
  const dateStr = game.date ? dateFormatter.format(new Date(game.date)) : ''

  if (variant === 'compact') {
    return (
      <div
        onClick={() => onClick?.(game)}
        className={`flex items-center gap-4 border-b border-gray-100 dark:border-gray-700 px-4 py-3 ${onClick ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700' : ''}`}
      >
        <div className="w-28 shrink-0 text-sm text-gray-500 dark:text-gray-400">
          <div>{dateStr}</div>
          <div>{game.time}</div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm">
            <span className={`text-gray-900 dark:text-gray-100 ${game.type === 'home' ? 'font-semibold' : ''}`}>{game.home_team}</span>
            <span className="text-gray-400 dark:text-gray-500">–</span>
            <span className={`text-gray-900 dark:text-gray-100 ${game.type === 'away' ? 'font-semibold' : ''}`}>{game.away_team}</span>
          </div>
          <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{game.league}</div>
        </div>
        {game.status === 'completed' && (
          <div className="shrink-0 text-right font-mono text-lg font-bold text-gray-900 dark:text-white">
            {game.home_score}:{game.away_score}
          </div>
        )}
        <StatusBadge status={game.status} />
      </div>
    )
  }

  return (
    <div
      onClick={() => onClick?.(game)}
      className={`rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 shadow-sm transition-shadow ${onClick ? 'cursor-pointer hover:shadow-md' : ''}`}
    >
      {/* Top: date+time left, team chip right */}
      <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
        <span>
          {dateStr} {game.time && `· ${game.time}`}
        </span>
        <div className="flex items-center gap-2">
          <StatusBadge status={game.status} />
          {kscwTeamName && <TeamChip team={kscwTeamName} size="sm" />}
        </div>
      </div>

      {/* Teams */}
      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1 text-right">
          <span className={`truncate text-sm text-gray-900 dark:text-gray-100 ${game.type === 'home' ? 'font-semibold' : ''}`}>
            {game.home_team}
          </span>
        </div>

        {game.status === 'completed' || game.status === 'live' ? (
          <div className="shrink-0 text-center">
            <div className="font-mono text-2xl font-bold leading-none text-gray-900 dark:text-white">
              {game.home_score}
              <span className="mx-1 text-gray-400 dark:text-gray-500">:</span>
              {game.away_score}
            </div>
          </div>
        ) : (
          <div className="shrink-0 px-3 text-center text-lg font-light text-gray-400 dark:text-gray-500">vs</div>
        )}

        <div className="min-w-0 flex-1">
          <span className={`truncate text-sm text-gray-900 dark:text-gray-100 ${game.type === 'away' ? 'font-semibold' : ''}`}>
            {game.away_team}
          </span>
        </div>
      </div>

      {/* Bottom: league left, hall right */}
      <div className="mt-3 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
        <span className="truncate">{game.league}</span>
        {hallInfo && <span className="truncate text-right">{hallInfo}</span>}
      </div>
    </div>
  )
}
