import type { SvRanking } from '../../../types'
import TeamChip from '../../../components/TeamChip'
import { svTeamIds } from '../../../utils/teamColors'

interface RankingsTableProps {
  league: string
  rankings: SvRanking[]
}

export default function RankingsTable({ league, rankings }: RankingsTableProps) {
  const sorted = [...rankings].sort((a, b) => a.rank - b.rank)

  return (
    <div>
      <h3 className="mb-3 text-lg font-semibold text-gray-800">{league}</h3>
      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
              <th className="px-4 py-3 text-center">#</th>
              <th className="px-4 py-3">Team</th>
              <th className="px-4 py-3 text-center">Sp.</th>
              <th className="px-4 py-3 text-center">S</th>
              <th className="px-4 py-3 text-center">N</th>
              <th className="px-4 py-3 text-center">Sätze</th>
              <th className="px-4 py-3 text-center">Pkt.</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {sorted.map((row) => {
              const kscwTeam = svTeamIds[row.sv_team_id]
              const isKscw = !!kscwTeam

              return (
                <tr
                  key={row.id}
                  className={isKscw ? 'bg-blue-50 font-semibold' : 'hover:bg-gray-50'}
                >
                  <td className="px-4 py-2.5 text-center text-gray-500">{row.rank}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      {isKscw && <TeamChip team={kscwTeam} size="sm" />}
                      <span className={isKscw ? 'text-blue-900' : 'text-gray-700'}>
                        {isKscw ? `KSC Wiedikon ${kscwTeam}` : `Team ${row.sv_team_id}`}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-center">{row.played}</td>
                  <td className="px-4 py-2.5 text-center text-green-600">{row.won}</td>
                  <td className="px-4 py-2.5 text-center text-red-500">{row.lost}</td>
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
