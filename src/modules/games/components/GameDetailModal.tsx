import { useEffect } from 'react'
import type { RecordModel } from 'pocketbase'
import type { Game, Team, Hall } from '../../../types'
import TeamChip from '../../../components/TeamChip'

interface GameDetailModalProps {
  game: Game | null
  onClose: () => void
}

type ExpandedGame = Game & {
  expand?: {
    kscw_team?: Team & RecordModel
    hall?: Hall & RecordModel
  }
}

function parseSets(json: unknown): Array<{ home: number; away: number }> {
  if (!Array.isArray(json)) return []
  return json.filter(
    (s): s is { home: number; away: number } =>
      typeof s === 'object' && s !== null && 'home' in s && 'away' in s,
  )
}

const dateFormatter = new Intl.DateTimeFormat('de-CH', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
})

export default function GameDetailModal({ game, onClose }: GameDetailModalProps) {
  useEffect(() => {
    if (!game) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [game, onClose])

  if (!game) return null

  const expanded = game as ExpandedGame
  const hall = expanded.expand?.hall
  const kscwTeam = expanded.expand?.kscw_team?.name ?? ''
  const sets = parseSets(game.sets_json)
  const dateStr = game.date ? dateFormatter.format(new Date(game.date)) : ''

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div className="flex items-center gap-2">
            <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
              {game.league}
            </span>
            {game.round && (
              <span className="text-xs text-gray-400">Runde {game.round}</span>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>

        {/* Teams & Score */}
        <div className="px-6 py-6">
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1 text-right">
              <div className="flex items-center justify-end gap-2">
                {kscwTeam && game.type === 'home' && <TeamChip team={kscwTeam} size="sm" />}
              </div>
              <p className={`mt-1 text-sm ${game.type === 'home' ? 'font-semibold' : ''}`}>
                {game.home_team}
              </p>
            </div>

            <div className="shrink-0 text-center">
              {game.status === 'completed' || game.status === 'live' ? (
                <div className="font-mono text-3xl font-bold">
                  {game.home_score}
                  <span className="mx-1 text-gray-300">:</span>
                  {game.away_score}
                </div>
              ) : (
                <div className="text-2xl font-light text-gray-300">vs</div>
              )}
            </div>

            <div className="flex-1">
              <div className="flex items-center gap-2">
                {kscwTeam && game.type === 'away' && <TeamChip team={kscwTeam} size="sm" />}
              </div>
              <p className={`mt-1 text-sm ${game.type === 'away' ? 'font-semibold' : ''}`}>
                {game.away_team}
              </p>
            </div>
          </div>

          {/* Sets breakdown */}
          {sets.length > 0 && (
            <div className="mt-4 overflow-hidden rounded-lg border border-gray-200">
              <table className="w-full text-center text-sm">
                <thead>
                  <tr className="bg-gray-50 text-xs text-gray-500">
                    <th className="px-3 py-2"></th>
                    {sets.map((_, i) => (
                      <th key={i} className="px-3 py-2">
                        Satz {i + 1}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t">
                    <td className="px-3 py-2 text-left text-xs font-medium text-gray-500">Heim</td>
                    {sets.map((s, i) => (
                      <td
                        key={i}
                        className={`px-3 py-2 ${s.home > s.away ? 'font-bold text-green-600' : ''}`}
                      >
                        {s.home}
                      </td>
                    ))}
                  </tr>
                  <tr className="border-t">
                    <td className="px-3 py-2 text-left text-xs font-medium text-gray-500">Gast</td>
                    {sets.map((s, i) => (
                      <td
                        key={i}
                        className={`px-3 py-2 ${s.away > s.home ? 'font-bold text-green-600' : ''}`}
                      >
                        {s.away}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Details */}
        <div className="space-y-3 border-t px-6 py-4">
          <DetailRow label="Datum" value={dateStr} />
          <DetailRow label="Anpfiff" value={game.time || '–'} />
          {hall && (
            <>
              <DetailRow label="Halle" value={hall.name} />
              {hall.address && (
                <DetailRow label="Adresse" value={`${hall.address}, ${hall.city || ''}`} />
              )}
              {hall.maps_url && (
                <div className="flex items-start gap-3 text-sm">
                  <span className="w-20 shrink-0 text-gray-500">Karte</span>
                  <a
                    href={hall.maps_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline"
                  >
                    Google Maps
                  </a>
                </div>
              )}
            </>
          )}
          <DetailRow label="Status" value={statusLabel(game.status)} />
        </div>

        {/* Scorer / Täfeler */}
        {(game.scorer_team || game.scorer_person || game.taefeler_team || game.taefeler_person) && (
          <div className="space-y-3 border-t px-6 py-4">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-500">
              Schreibereinsätze
            </h4>
            {(game.scorer_team || game.scorer_person) && (
              <DetailRow
                label="Schreiber"
                value={[game.scorer_team, game.scorer_person].filter(Boolean).join(' — ')}
              />
            )}
            {(game.taefeler_team || game.taefeler_person) && (
              <DetailRow
                label="Täfeler"
                value={[game.taefeler_team, game.taefeler_person].filter(Boolean).join(' — ')}
              />
            )}
            <DetailRow
              label="Bestätigt"
              value={game.duty_confirmed ? 'Ja' : 'Nein'}
            />
          </div>
        )}
      </div>
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-3 text-sm">
      <span className="w-20 shrink-0 text-gray-500">{label}</span>
      <span className="text-gray-900">{value}</span>
    </div>
  )
}

function statusLabel(status: Game['status']): string {
  switch (status) {
    case 'scheduled':
      return 'Geplant'
    case 'live':
      return 'Live'
    case 'completed':
      return 'Beendet'
    case 'postponed':
      return 'Verschoben'
    default:
      return status
  }
}
