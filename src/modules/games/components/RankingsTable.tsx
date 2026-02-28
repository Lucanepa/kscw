import { useTranslation } from 'react-i18next'
import type { SvRanking } from '../../../types'
import TeamChip from '../../../components/TeamChip'
import { svTeamIds } from '../../../utils/teamColors'

interface RankingsTableProps {
  league: string
  rankings: SvRanking[]
}

export default function RankingsTable({ league, rankings }: RankingsTableProps) {
  const { t } = useTranslation('games')
  const sorted = [...rankings].sort((a, b) => a.rank - b.rank)

  return (
    <div>
      <h3 className="mb-3 text-lg font-semibold text-gray-800 dark:text-gray-200">{league}</h3>
      <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
              <th className="px-4 py-3 text-center">{t('rank')}</th>
              <th className="px-4 py-3">{t('teamCol')}</th>
              <th className="px-4 py-3 text-center">{t('played')}</th>
              <th className="hidden px-4 py-3 text-center sm:table-cell">{t('won')}</th>
              <th className="hidden px-4 py-3 text-center sm:table-cell">{t('lost')}</th>
              <th className="px-4 py-3 text-center">{t('sets')}</th>
              <th className="px-4 py-3 text-center">{t('points')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {sorted.map((row) => {
              const kscwTeam = svTeamIds[row.sv_team_id]
              const isKscw = !!kscwTeam

              return (
                <tr
                  key={row.id}
                  className={isKscw ? 'bg-brand-50 dark:bg-brand-900/20 font-semibold' : 'hover:bg-gray-50 dark:hover:bg-gray-700'}
                >
                  <td className="px-4 py-2.5 text-center text-gray-500 dark:text-gray-400">{row.rank}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      {isKscw && <TeamChip team={kscwTeam} size="sm" />}
                      <span className={isKscw ? 'text-brand-900 dark:text-brand-200' : 'text-gray-700 dark:text-gray-300'}>
                        {isKscw ? `KSC Wiedikon ${kscwTeam}` : (row.team_name || `Team ${row.sv_team_id}`)}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-center">{row.played}</td>
                  <td className="hidden px-4 py-2.5 text-center text-green-600 sm:table-cell">{row.won}</td>
                  <td className="hidden px-4 py-2.5 text-center text-red-500 sm:table-cell">{row.lost}</td>
                  <td className="px-4 py-2.5 text-center">
                    {row.sets_won}:{row.sets_lost}
                  </td>
                  <td className="px-4 py-2.5 text-center font-bold">{row.points}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
