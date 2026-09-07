import { Fragment, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { ChevronDown } from 'lucide-react'
import type { Game, Ranking } from '../../../types'
import TeamChip from '../../../components/TeamChip'
import Modal from '@/components/Modal'
import { teamIds } from '../../../utils/teamColors'
import { getPromotionColor, promotionBorderColors } from '../../../utils/leaguePromotion'
import { formatNumberSwiss } from '../../../utils/formatNumber'
import { useCollection } from '../../../lib/query'
import { formatDateCompact, formatTime } from '../../../utils/dateHelpers'

interface RankingsTableProps {
  league: string
  rankings: Ranking[]
  /** Hide sets/points/quotient columns (homepage sidebar) */
  compact?: boolean
}

export default function RankingsTable({ league, rankings, compact }: RankingsTableProps) {
  const { t } = useTranslation('games')
  const navigate = useNavigate()
  const sorted = [...rankings].sort((a, b) => a.rank - b.rank)
  const isBasketball = rankings.some((r) => r.team_id.startsWith('bb_'))
  const totalTeams = sorted.length
  const [breakdown, setBreakdown] = useState<{ row: Ranking; mode: 'win' | 'loss' } | null>(null)
  const [expandedTeamId, setExpandedTeamId] = useState<string | null>(null)

  // Fetch all games for this league (skip in compact/homepage mode — no accordion).
  // Deferred until the first row is expanded: the games only feed the accordion
  // drill-down, so an unexpanded table (the common case, one per league on the
  // rankings tab) never fires this 500-row query.
  // Scope to the season of the table being shown so old-season games don't leak in.
  const tableSeason = rankings[0]?.season
  const { data: leagueGamesRaw, isLoading: leagueGamesLoading } = useCollection<Game>('games', {
    filter: tableSeason
      ? { _and: [{ league: { _eq: league } }, { season: { _eq: tableSeason } }] }
      : { league: { _eq: league } },
    sort: ['-date', '-time'],
    limit: 500,
    enabled: !compact && expandedTeamId !== null,
  })
  const leagueGames = leagueGamesRaw ?? []

  // Set of KSCW team names in this league's rankings
  const kscwTeamNames = useMemo(() => {
    const names = new Set<string>()
    for (const r of rankings) {
      if (teamIds[r.team_id]) {
        names.add(r.team_name)
      }
    }
    return names
  }, [rankings])

  function getTeamLabel(row: Ranking): string {
    const kscwTeam = teamIds[row.team_id]
    return kscwTeam ? `KSC Wiedikon ${kscwTeam}` : (row.team_name || `Team ${row.team_id}`)
  }

  function hasBreakdownData(row: Ranking): boolean {
    return (
      typeof row.wins_clear === 'number'
      && typeof row.wins_narrow === 'number'
      && typeof row.defeats_clear === 'number'
      && typeof row.defeats_narrow === 'number'
    )
  }

  /** Get games to show for an expanded row */
  function getGamesForRow(row: Ranking): Game[] {
    const isKscw = !!teamIds[row.team_id]
    const teamName = row.team_name

    if (isKscw) {
      // KSCW team: show ALL their games
      return leagueGames.filter(
        (g) => g.home_team === teamName || g.away_team === teamName,
      )
    } else {
      // Opponent: show only games against any KSCW team
      return leagueGames.filter(
        (g) =>
          (g.home_team === teamName && kscwTeamNames.has(g.away_team)) ||
          (g.away_team === teamName && kscwTeamNames.has(g.home_team)),
      )
    }
  }

  function toggleExpanded(teamId: string) {
    setExpandedTeamId((prev) => (prev === teamId ? null : teamId))
  }

  const winsClear = breakdown?.row.wins_clear ?? 0
  const winsNarrow = breakdown?.row.wins_narrow ?? 0
  const lossesClear = breakdown?.row.defeats_clear ?? 0
  const lossesNarrow = breakdown?.row.defeats_narrow ?? 0

  // Count visible columns for the expanded row colspan
  const colCount = isBasketball ? 7 : 6 + 2 /* sets+SQ on sm */ + 2 /* pf:pa+PQ on lg */

  return (
    <>
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-card overflow-hidden">
        <div className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-4 py-3">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">{league}</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b dark:border-gray-700 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                <th className={`${compact ? 'w-10 px-3' : 'w-8 px-2'} py-2.5 text-center`}>{t('rank')}</th>
                <th className={`${compact ? 'w-12 px-3' : 'w-10 px-2'} py-2.5 text-center`}>{t('points')}</th>
                <th className={`${compact ? 'px-3' : 'px-2'} py-2.5`}>{t('teamCol')}</th>
                <th className={`${compact ? 'w-12 px-3' : 'w-10 px-2'} py-2.5 text-center`}>{t('played')}</th>
                <th className={`${compact ? 'w-12 px-3' : 'w-10 px-2'} py-2.5 text-center ${isBasketball ? 'hidden sm:table-cell' : ''}`}>{t('won')}</th>
                <th className={`${compact ? 'w-12 px-3' : 'w-10 px-2'} py-2.5 text-center ${isBasketball ? 'hidden sm:table-cell' : ''}`}>{t('lost')}</th>
                {!compact && (isBasketball ? (
                  <>
                    <th className="w-16 px-2 py-2.5 text-center">{t('pointsFor')} : {t('pointsAgainst')}</th>
                  </>
                ) : (
                  <>
                    <th className="hidden w-20 px-2 py-2.5 text-center sm:table-cell">{t('sets')}</th>
                    <th className="hidden w-12 px-2 py-2.5 text-center sm:table-cell">{t('setsQuotient', { defaultValue: 'SQ' })}</th>
                    <th className="hidden w-24 px-2 py-2.5 text-center lg:table-cell">{t('pointsFor')} : {t('pointsAgainst')}</th>
                    <th className="hidden w-12 px-2 py-2.5 text-center lg:table-cell">{t('pointsQuotient', { defaultValue: 'PQ' })}</th>
                  </>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {sorted.map((row) => {
                const kscwTeam = teamIds[row.team_id]
                const isKscw = !!kscwTeam
                const promoColor = getPromotionColor(league, row.rank, totalTeams, row.team_name, sorted)
                const promoBorder = promoColor ? promotionBorderColors[promoColor] : ''
                const canShowBreakdown = !compact && !isBasketball && hasBreakdownData(row)
                const isExpanded = !compact && expandedTeamId === row.team_id
                const rowGames = isExpanded ? getGamesForRow(row) : []

                return (
                  <Fragment key={row.id}>
                    <tr
                      className={`cursor-pointer select-none transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/30 ${isKscw ? 'bg-brand-50 dark:bg-brand-900/20 font-semibold' : ''} ${promoBorder}`}
                      onClick={() => compact ? navigate('/games?tab=rankings') : toggleExpanded(row.team_id)}
                    >
                      <td className={`${compact ? 'px-3 py-3' : 'px-2 py-2'} text-center text-gray-500 dark:text-gray-400`}>{row.rank}</td>
                      <td className={`${compact ? 'px-3 py-3' : 'px-2 py-2'} text-center font-bold text-gray-900 dark:text-gray-100`}>{row.points}</td>
                      <td className={`${compact ? 'px-3 py-3' : 'max-w-0 px-2 py-2'}`}>
                        <div className="flex items-center gap-1.5 min-w-0">
                          {isKscw ? (
                            <TeamChip team={kscwTeam} label={`KSC Wiedikon ${kscwTeam}`} size="sm" />
                          ) : (
                            <span className={`${compact ? 'whitespace-nowrap' : 'truncate'} text-gray-700 dark:text-gray-300`}>
                              {row.team_name || `Team ${row.team_id}`}
                            </span>
                          )}
                          {!compact && <ChevronDown className={`ml-auto h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />}
                        </div>
                      </td>
                      <td className={`${compact ? 'px-3 py-3' : 'px-2 py-2'} text-center text-gray-700 dark:text-gray-300`}>{row.played}</td>
                      <td className={`${compact ? 'px-3 py-3' : 'px-2 py-2'} text-center text-green-600 dark:text-green-400 ${isBasketball ? 'hidden sm:table-cell' : ''}`}>
                        {canShowBreakdown ? (
                          <>
                            <button
                              type="button"
                              className="mx-auto min-h-[36px] rounded px-1.5 hover:bg-gray-100 sm:hidden dark:hover:bg-gray-700"
                              onClick={(e) => { e.stopPropagation(); setBreakdown({ row, mode: 'win' }) }}
                              aria-label={`${t('won')} ${getTeamLabel(row)}`}
                            >
                              {row.won}
                            </button>
                            <div className="hidden flex-col items-center leading-tight sm:flex">
                              <span>{row.won}</span>
                              <span className="text-[10px] font-normal text-gray-500 dark:text-gray-400">
                                {`${row.wins_clear ?? 0}/${row.wins_narrow ?? 0}`}
                              </span>
                            </div>
                          </>
                        ) : row.won}
                      </td>
                      <td className={`${compact ? 'px-3 py-3' : 'px-2 py-2'} text-center text-red-500 dark:text-red-400 ${isBasketball ? 'hidden sm:table-cell' : ''}`}>
                        {canShowBreakdown ? (
                          <>
                            <button
                              type="button"
                              className="mx-auto min-h-[36px] rounded px-1.5 hover:bg-gray-100 sm:hidden dark:hover:bg-gray-700"
                              onClick={(e) => { e.stopPropagation(); setBreakdown({ row, mode: 'loss' }) }}
                              aria-label={`${t('lost')} ${getTeamLabel(row)}`}
                            >
                              {row.lost}
                            </button>
                            <div className="hidden flex-col items-center leading-tight sm:flex">
                              <span>{row.lost}</span>
                              <span className="text-[10px] font-normal text-gray-500 dark:text-gray-400">
                                {`${row.defeats_clear ?? 0}/${row.defeats_narrow ?? 0}`}
                              </span>
                            </div>
                          </>
                        ) : row.lost}
                      </td>
                      {!compact && (isBasketball ? (
                        <>
                          <td className="px-2 py-2 text-center text-gray-700 dark:text-gray-300">
                            {formatNumberSwiss(row.points_won)}&nbsp;:&nbsp;{formatNumberSwiss(row.points_lost)}
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="hidden px-2 py-2 text-center text-gray-700 dark:text-gray-300 sm:table-cell">
                            {row.sets_won}&nbsp;:&nbsp;{row.sets_lost}
                          </td>
                          <td className="hidden px-2 py-2 text-center tabular-nums text-gray-500 dark:text-gray-400 sm:table-cell">
                            {row.sets_lost > 0 ? (row.sets_won / row.sets_lost).toFixed(2) : row.sets_won > 0 ? '∞' : '–'}
                          </td>
                          <td className="hidden px-2 py-2 text-center text-gray-700 dark:text-gray-300 lg:table-cell">
                            {formatNumberSwiss(row.points_won)}&nbsp;:&nbsp;{formatNumberSwiss(row.points_lost)}
                          </td>
                          <td className="hidden px-2 py-2 text-center tabular-nums text-gray-500 dark:text-gray-400 lg:table-cell">
                            {row.points_lost > 0 ? (row.points_won / row.points_lost).toFixed(2) : row.points_won > 0 ? '∞' : '–'}
                          </td>
                        </>
                      ))}
                    </tr>
                    {isExpanded && (
                      <tr key={`${row.id}-games`}>
                        <td colSpan={colCount} className="p-0">
                          <div className="bg-gray-50 dark:bg-gray-900/50 px-3 py-2">
                            {/* `rowGames` is empty both while the deferred games query is
                                in flight and when the team really has no fixtures. The query
                                only starts on this tap (`enabled` above), so without this gate
                                the first expansion of every league table claims "No data". */}
                            {leagueGamesLoading ? (
                              <div className="space-y-1" aria-busy="true">
                                {[0, 1, 2].map((i) => (
                                  <div key={i} className="h-8 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
                                ))}
                              </div>
                            ) : rowGames.length === 0 ? (
                              <p className="py-2 text-center text-xs text-gray-400">{t('common:noData')}</p>
                            ) : (
                              <div className="space-y-1">
                                {rowGames.map((g) => {
                                  const teamName = row.team_name
                                  const isHome = g.home_team === teamName
                                  const opponent = isHome ? g.away_team : g.home_team
                                  const completed = g.status === 'completed'
                                  const isWin = completed && (
                                    (isHome && g.home_score > g.away_score) ||
                                    (!isHome && g.away_score > g.home_score)
                                  )
                                  const isLoss = completed && (
                                    (isHome && g.home_score < g.away_score) ||
                                    (!isHome && g.away_score < g.home_score)
                                  )
                                  const isFuture = g.status === 'scheduled'
                                  const score = completed
                                    ? (isHome ? `${g.home_score}:${g.away_score}` : `${g.away_score}:${g.home_score}`)
                                    : ''

                                  return (
                                    <div
                                      key={g.id}
                                      className="flex items-center gap-2 rounded px-2 py-1 text-xs"
                                    >
                                      <div className="w-16 shrink-0 text-gray-500 dark:text-gray-400">
                                        <div>{g.date ? formatDateCompact(g.date) : ''}</div>
                                        {g.time && <div>{formatTime(g.time)}</div>}
                                      </div>
                                      <span className="w-4 shrink-0 text-center text-[10px] text-gray-400">
                                        {isHome ? 'H' : 'A'}
                                      </span>
                                      <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-300">
                                        {opponent}
                                      </span>
                                      {isFuture ? (
                                        <span className="shrink-0 text-[10px] font-bold text-brand-600 dark:text-brand-400">
                                          {t('comeAndSupport')}
                                        </span>
                                      ) : (
                                        <span className={`shrink-0 font-mono font-semibold ${
                                          isWin ? 'text-green-600 dark:text-green-400'
                                            : isLoss ? 'text-red-500 dark:text-red-400'
                                            : 'text-gray-500 dark:text-gray-400'
                                        }`}>
                                          {score}
                                        </span>
                                      )}
                                    </div>
                                  )
                                })}
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
      <Modal
        open={!!breakdown}
        onClose={() => setBreakdown(null)}
        title={breakdown ? `${getTeamLabel(breakdown.row)} - ${breakdown.mode === 'win' ? t('won') : t('lost')}` : ''}
        size="sm"
      >
        {!breakdown ? null : !hasBreakdownData(breakdown.row) ? (
          <p className="text-sm text-gray-600 dark:text-gray-300">{t('breakdownUnavailable')}</p>
        ) : (
          <div className="space-y-3">
            {breakdown.mode === 'win' ? (
              <>
                <div className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2 text-sm dark:border-gray-700">
                  <span className="text-gray-700 dark:text-gray-200">{t('winsClear')}</span>
                  <strong className="text-gray-900 dark:text-gray-100">{winsClear}</strong>
                </div>
                <div className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2 text-sm dark:border-gray-700">
                  <span className="text-gray-700 dark:text-gray-200">{t('winsNarrow')}</span>
                  <strong className="text-gray-900 dark:text-gray-100">{winsNarrow}</strong>
                </div>
                <div className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 text-sm dark:bg-gray-700/40">
                  <span className="text-gray-700 dark:text-gray-200">{t('breakdownTotal')}</span>
                  <strong className="text-gray-900 dark:text-gray-100">{breakdown.row.won}</strong>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2 text-sm dark:border-gray-700">
                  <span className="text-gray-700 dark:text-gray-200">{t('lossesClear')}</span>
                  <strong className="text-gray-900 dark:text-gray-100">{lossesClear}</strong>
                </div>
                <div className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2 text-sm dark:border-gray-700">
                  <span className="text-gray-700 dark:text-gray-200">{t('lossesNarrow')}</span>
                  <strong className="text-gray-900 dark:text-gray-100">{lossesNarrow}</strong>
                </div>
                <div className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 text-sm dark:bg-gray-700/40">
                  <span className="text-gray-700 dark:text-gray-200">{t('breakdownTotal')}</span>
                  <strong className="text-gray-900 dark:text-gray-100">{breakdown.row.lost}</strong>
                </div>
              </>
            )}
          </div>
        )}
      </Modal>
    </>
  )
}
