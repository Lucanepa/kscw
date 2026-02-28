import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
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

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
})

export default function GameDetailModal({ game, onClose }: GameDetailModalProps) {
  const { t } = useTranslation('games')

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
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white shadow-xl sm:rounded-2xl dark:bg-gray-800"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b dark:border-gray-700 px-6 py-4">
          <div className="flex items-center gap-2">
            <span className="rounded bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-xs font-medium text-gray-600 dark:text-gray-400">
              {game.league}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {kscwTeam && <TeamChip team={kscwTeam} size="sm" />}
            <button
              onClick={onClose}
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 sm:min-h-0 sm:min-w-0 sm:p-1 dark:hover:bg-gray-700"
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
        </div>

        {/* Teams & Score */}
        <div className="px-6 py-6">
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1 text-right">
              <p className={`text-sm text-gray-900 dark:text-gray-100 ${game.type === 'home' ? 'font-semibold' : ''}`}>
                {game.home_team}
              </p>
            </div>

            <div className="shrink-0 text-center">
              {game.status === 'completed' || game.status === 'live' ? (
                <div className="font-mono text-3xl font-bold text-gray-900 dark:text-gray-100">
                  {game.home_score}
                  <span className="mx-1 text-gray-400 dark:text-gray-500">:</span>
                  {game.away_score}
                </div>
              ) : (
                <div className="text-2xl font-light text-gray-400 dark:text-gray-500">vs</div>
              )}
            </div>

            <div className="flex-1">
              <p className={`text-sm text-gray-900 dark:text-gray-100 ${game.type === 'away' ? 'font-semibold' : ''}`}>
                {game.away_team}
              </p>
            </div>
          </div>

          {/* Sets breakdown */}
          {sets.length > 0 && (
            <div className="mt-4 overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
              <table className="w-full text-center text-sm">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-900 text-xs text-gray-500 dark:text-gray-400">
                    <th className="px-3 py-2"></th>
                    {sets.map((_, i) => (
                      <th key={i} className="px-3 py-2">
                        {t('set')} {i + 1}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t dark:border-gray-700">
                    <td className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">{t('home')}</td>
                    {sets.map((s, i) => (
                      <td
                        key={i}
                        className={`px-3 py-2 ${s.home > s.away ? 'font-bold text-green-600 dark:text-green-400' : 'text-gray-700 dark:text-gray-300'}`}
                      >
                        {s.home}
                      </td>
                    ))}
                  </tr>
                  <tr className="border-t dark:border-gray-700">
                    <td className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">{t('away')}</td>
                    {sets.map((s, i) => (
                      <td
                        key={i}
                        className={`px-3 py-2 ${s.away > s.home ? 'font-bold text-green-600 dark:text-green-400' : 'text-gray-700 dark:text-gray-300'}`}
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

        {/* Game info */}
        <div className="space-y-3 border-t dark:border-gray-700 px-6 py-4">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {t('gameInfo')}
          </h4>
          <DetailRow label={t('date')} value={dateStr} />
          <DetailRow label={t('kickoff')} value={game.time || '–'} />
          <DetailRow label={t('gameType')} value={game.type === 'home' ? t('typeHome') : t('typeAway')} />
          {game.sv_game_id && <DetailRow label={t('gameNumber')} value={game.sv_game_id} />}
          {game.season && <DetailRow label={t('season')} value={game.season} />}
        </div>

        {/* Venue */}
        {hall && (
          <div className="space-y-3 border-t dark:border-gray-700 px-6 py-4">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              {t('venue')}
            </h4>
            <DetailRow label={t('hallLabel')} value={hall.name} />
            {hall.address && (
              <DetailRow label={t('address')} value={[hall.address, hall.city].filter(Boolean).join(', ')} />
            )}
            {hall.maps_url && (
              <div className="flex items-start gap-3 text-sm">
                <span className="w-20 shrink-0 text-gray-500 dark:text-gray-400">{t('map')}</span>
                <a
                  href={hall.maps_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand-600 hover:underline dark:text-brand-400"
                >
                  Google Maps ↗
                </a>
              </div>
            )}
          </div>
        )}

        {/* Referees */}
        {game.referees_json && game.referees_json.length > 0 && (
          <div className="space-y-3 border-t dark:border-gray-700 px-6 py-4">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              {t('referees')}
            </h4>
            {game.referees_json.map((ref, i) => (
              <DetailRow key={i} label={t(i === 0 ? 'referee1st' : 'referee2nd')} value={ref.name} />
            ))}
          </div>
        )}

        {/* Scorer / Täfeler */}
        {(game.scorer_team || game.scorer_person || game.taefeler_team || game.taefeler_person) && (
          <div className="space-y-3 border-t dark:border-gray-700 px-6 py-4">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              {t('scorerDuties')}
            </h4>
            {(game.scorer_team || game.scorer_person) && (
              <DetailRow
                label={t('scorer')}
                value={[game.scorer_team, game.scorer_person].filter(Boolean).join(' — ')}
              />
            )}
            {(game.taefeler_team || game.taefeler_person) && (
              <DetailRow
                label={t('taefeler')}
                value={[game.taefeler_team, game.taefeler_person].filter(Boolean).join(' — ')}
              />
            )}
            <DetailRow
              label={t('confirmed')}
              value={game.duty_confirmed ? t('common:yes') : t('common:no')}
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
      <span className="w-20 shrink-0 text-gray-500 dark:text-gray-400">{label}</span>
      <span className="text-gray-900 dark:text-gray-100">{value}</span>
    </div>
  )
}
