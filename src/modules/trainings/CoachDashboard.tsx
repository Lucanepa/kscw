import { useState } from 'react'
import { useAttendanceStats } from './useAttendanceStats'
import EmptyState from '../../components/EmptyState'
import { getCurrentSeason } from '../../utils/dateHelpers'

interface CoachDashboardProps {
  teamId: string
}

const trendColors: Record<string, string> = {
  present: 'bg-green-500',
  absent: 'bg-red-500',
  late: 'bg-amber-500',
  excused: 'bg-blue-500',
}

export default function CoachDashboard({ teamId }: CoachDashboardProps) {
  const [season, setSeason] = useState(getCurrentSeason())
  const { stats, isLoading } = useAttendanceStats(teamId, season)

  // Generate season options (current + previous 2)
  const currentSeason = getCurrentSeason()
  const startYear = parseInt(currentSeason.split('/')[0])
  const seasonOptions = [0, 1, 2].map((offset) => {
    const y = startYear - offset
    return `${y}/${String(y + 1).slice(2)}`
  })

  if (isLoading) {
    return <div className="py-8 text-center text-gray-500">Laden...</div>
  }

  return (
    <div>
      <div className="mb-6 flex items-center gap-4">
        <label className="text-sm font-medium text-gray-700">Saison</label>
        <select
          value={season}
          onChange={(e) => setSeason(e.target.value)}
          className="rounded-lg border px-3 py-1.5 text-sm"
        >
          {seasonOptions.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      {stats.length === 0 ? (
        <EmptyState
          icon="📊"
          title="Keine Daten"
          description="Noch keine Trainingsdaten für diese Saison vorhanden."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-white">
          <table className="w-full">
            <thead>
              <tr className="border-b bg-gray-50 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                <th className="px-4 py-3">Spieler</th>
                <th className="px-4 py-3 text-center">#Nr</th>
                <th className="px-4 py-3 text-center">Trainings</th>
                <th className="px-4 py-3 text-center">Anwesend</th>
                <th className="px-4 py-3 text-center">Abwesend</th>
                <th className="px-4 py-3 text-center">Quote</th>
                <th className="px-4 py-3">Trend</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((player) => (
                <tr key={player.memberId} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">
                    {player.memberName}
                  </td>
                  <td className="px-4 py-3 text-center text-sm text-gray-500">
                    {player.jerseyNumber || '—'}
                  </td>
                  <td className="px-4 py-3 text-center text-sm text-gray-500">
                    {player.total}
                  </td>
                  <td className="px-4 py-3 text-center text-sm text-green-600">
                    {player.present}
                  </td>
                  <td className="px-4 py-3 text-center text-sm text-red-600">
                    {player.absent}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs font-bold ${
                        player.percentage >= 80
                          ? 'bg-green-100 text-green-800'
                          : player.percentage >= 50
                            ? 'bg-amber-100 text-amber-800'
                            : 'bg-red-100 text-red-800'
                      }`}
                    >
                      {player.percentage}%
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      {player.trend.map((status, i) => (
                        <div
                          key={i}
                          className={`h-3 w-3 rounded-full ${trendColors[status] ?? 'bg-gray-300'}`}
                          title={status}
                        />
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
