import { useTranslation } from 'react-i18next'
import { Users, Pencil, Trash2 } from 'lucide-react'
import type { Game, Team, Hall, BaseRecord } from '../../../types'
import { formatDateCompact, formatTime } from '../../../utils/dateHelpers'
import { leagueShort } from '../../../utils/leagueShort'
import TeamChip from '../../../components/TeamChip'
import { teamNameToColorKey } from '../../../utils/teamColors'
import VolleyballIcon from '../../../components/VolleyballIcon'
import BasketballIcon from '../../../components/BasketballIcon'
import ParticipationSummary from '../../../components/ParticipationSummary'
import ParticipationWarningBadge from '../../../components/ParticipationWarningBadge'
import type { Warning } from '../../../utils/participationWarnings'
import { useAuth } from '../../../hooks/useAuth'
import { useTeamPermissions } from '../../../hooks/useTeamPermissions'
import { useIsCalledUpToGame } from '../../../hooks/useUserVisibleGameIds'
import type { Participation } from '../../../types'
import { asObj, relId, teamCoachIds } from '../../../utils/relations'
import CancelActivityButton from '../../../components/CancelActivityButton'
import ActivityParticipation from '../../../components/ActivityParticipation'

function parseSets(json: unknown): Array<{ home: number; away: number }> {
  if (!Array.isArray(json)) return []
  return json.filter(
    (s): s is { home: number; away: number } =>
      typeof s === 'object' && s !== null && 'home' in s && 'away' in s,
  )
}

interface GameCardProps {
  game: Game
  onClick?: (game: Game) => void
  variant?: 'card' | 'compact'
  /** Pre-fetched participations for this game (from batch query) */
  participations?: Participation[]
  /** Pre-fetched current user's participation (from batch query) */
  myParticipation?: Participation
  warnings?: Warning[]
  /** Called after a participation save — parent can refetch */
  onParticipationSaved?: () => void
  onOpenRoster?: (game: Game) => void
  onEdit?: (game: Game) => void
  onDelete?: (id: string) => void
}

type ExpandedGame = Game & {
  kscw_team: (Team & BaseRecord) | string
  hall: (Hall & BaseRecord) | string
}

function StatusBadge({ status }: { status: Game['status'] }) {
  const { t } = useTranslation('games')

  switch (status) {
    case 'live':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700 dark:bg-red-900/30 dark:text-red-400">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
          {t('statusLive')}
        </span>
      )
    case 'postponed':
      return (
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
          {t('statusPostponed')}
        </span>
      )
    case 'completed':
      return (
        <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700 dark:bg-green-900/30 dark:text-green-400">
          {t('statusCompleted')}
        </span>
      )
    case 'cancelled':
      return (
        <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700 dark:bg-red-900/30 dark:text-red-400">
          {t('statusCancelled')}
        </span>
      )
    default:
      return null
  }
}

export default function GameCard({ game, onClick, variant = 'card', participations, myParticipation, warnings, onParticipationSaved, onOpenRoster, onEdit, onDelete }: GameCardProps) {
  const { t } = useTranslation('games')
  const { user, canParticipateIn, isStaffOnly, isGuestIn } = useAuth()
  const { canManageTeam } = useTeamPermissions()
  // A called-up player (migration 271) has no member_teams row on the team whose
  // fixture this is, so canParticipateIn — which is team-scoped — says no. They were
  // borrowed precisely so they can answer it, hence the OR.
  const isCalledUp = useIsCalledUpToGame(user?.id, game.id)
  // relId, not the raw value: surfaces that expand `kscw_team.*` (the games list)
  // hand us the team OBJECT, and every one of these checks compares against an
  // array of id strings — so they all quietly answered false there.
  const teamIdForPerms = relId(game.kscw_team)
  const canParticipate = !!user && !!teamIdForPerms && (canParticipateIn(teamIdForPerms) || isCalledUp)
  const canManage = !!user && canManageTeam(teamIdForPerms)
  const canDelete = canManage && game.source === 'manual'
  const expanded = game as unknown as ExpandedGame
  const expandedHall = asObj<Hall & BaseRecord>(expanded.hall)
  const hallInfo = expandedHall
    ? [expandedHall.name, expandedHall.city].filter(Boolean).join(', ')
    : game.away_hall_json
      ? [game.away_hall_json.name, game.away_hall_json.city].filter(Boolean).join(', ')
      : ''
  const kscwTeamObj = asObj<Team & BaseRecord>(expanded.kscw_team)
  const rawTeamName = kscwTeamObj?.name ?? ''
  const teamSport = kscwTeamObj?.sport as 'volleyball' | 'basketball' | undefined
  const isBB = teamSport === 'basketball' || game.source === 'basketplan'
  const kscwTeamName = rawTeamName && teamSport ? teamNameToColorKey(rawTeamName, teamSport) : rawTeamName
  // Show OUR side from the linked team's VM-owned name (teams.full_name) so the
  // games list mirrors VM even when the SV API caption lags — e.g. a junior team
  // moving Stärkeklasse (DU23-1 → DU23-2). Opponent side keeps the SV caption.
  // Falls back to the stored string when kscw_team isn't expanded.
  const kscwFullLabel = kscwTeamObj?.full_name || (rawTeamName ? `KSC Wiedikon ${rawTeamName}` : '')
  const homeLabel = game.type === 'home' && kscwFullLabel ? kscwFullLabel : game.home_team
  const awayLabel = game.type === 'away' && kscwFullLabel ? kscwFullLabel : game.away_team

  if (variant === 'compact') {
    const short = game.date ? formatDateCompact(game.date) : ''
    const hasScore = game.status === 'completed' || game.status === 'live'
    const homeWon = Number(game.home_score) > Number(game.away_score)
    const awayWon = Number(game.away_score) > Number(game.home_score)
    const kscwWon = game.type === 'home' ? homeWon : awayWon
    const kscwLost = game.type === 'home' ? awayWon : homeWon
    const sets = parseSets(game.sets_json)

    return (
      <>
        {/* Mobile: flex row */}
        <div
          onClick={() => onClick?.(game)}
          className={`border-b border-gray-100 dark:border-gray-700 md:hidden ${onClick ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700' : ''}`}
        >
          <div className="flex items-center gap-2 px-4 py-2.5">
            <div className="w-16 shrink-0 text-xs text-gray-500 dark:text-gray-400">
              <div>{short}</div>
              {game.time && <div>{formatTime(game.time)}</div>}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {isBB
                ? <BasketballIcon className="h-5 w-5" filled />
                : <VolleyballIcon className="h-5 w-5" filled />}
              {kscwTeamName && <TeamChip team={kscwTeamName} size="xs" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className={`truncate text-sm text-gray-900 dark:text-gray-100 ${game.type === 'home' ? 'font-bold' : ''}`}>
                {homeLabel}
              </p>
              <p className={`truncate text-sm text-gray-900 dark:text-gray-100 ${game.type === 'away' ? 'font-bold' : ''}`}>
                {awayLabel}
              </p>
            </div>
            {hasScore && (
              <div className="shrink-0 text-right font-mono text-sm font-bold leading-snug">
                <div className={game.type === 'home' ? (kscwWon ? 'text-green-500' : kscwLost ? 'text-red-500' : 'text-gray-400') : 'text-gray-400'}>{game.home_score}</div>
                <div className={game.type === 'away' ? (kscwWon ? 'text-green-500' : kscwLost ? 'text-red-500' : 'text-gray-400') : 'text-gray-400'}>{game.away_score}</div>
              </div>
            )}
            {game.status !== 'completed' && <StatusBadge status={game.status} />}
          </div>
        </div>

        {/* Desktop: uses display:contents so cells participate in parent grid */}
        <div
          onClick={() => onClick?.(game)}
          className={`col-span-full hidden md:grid md:grid-cols-subgrid items-center gap-x-3 border-b border-gray-100 px-5 py-3 dark:border-gray-700 ${onClick ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700' : ''}`}
        >
          {/* Col 1: Date + time */}
          <div className="text-xs text-gray-500 dark:text-gray-400">
            <div>{short}</div>
            {game.time && <div>{formatTime(game.time)}</div>}
          </div>

          {/* Col 2: Sport icon */}
          <div>
            {isBB
              ? <BasketballIcon className="h-5 w-5" filled />
              : <VolleyballIcon className="h-5 w-5" filled />}
          </div>

          {/* Col 3: Team chip */}
          <div>
            {kscwTeamName ? <TeamChip team={kscwTeamName} size="xs" /> : null}
          </div>

          {/* Col 4: Total score (left of team names) */}
          <div className="text-right font-mono text-sm font-bold">
            {hasScore ? (
              <>
                <p className={`leading-5 ${game.type === 'home' ? (kscwWon ? 'text-green-500' : kscwLost ? 'text-red-500' : 'text-gray-400') : 'text-gray-400'}`}>{game.home_score}</p>
                <p className={`leading-5 ${game.type === 'away' ? (kscwWon ? 'text-green-500' : kscwLost ? 'text-red-500' : 'text-gray-400') : 'text-gray-400'}`}>{game.away_score}</p>
              </>
            ) : (
              game.status !== 'completed' && <StatusBadge status={game.status} />
            )}
          </div>

          {/* Col 5: Team names */}
          <div className="min-w-0">
            <p className={`truncate text-sm leading-5 text-gray-900 dark:text-gray-100 ${game.type === 'home' ? 'font-bold' : ''}`}>
              {homeLabel}
            </p>
            <p className={`truncate text-sm leading-5 text-gray-900 dark:text-gray-100 ${game.type === 'away' ? 'font-bold' : ''}`}>
              {awayLabel}
            </p>
          </div>

          {/* Col 6: Set scores — two rows aligned with teams */}
          <div>
            {hasScore && sets.length > 0 && (
              <>
                <div className="flex items-center gap-1 leading-5">
                  {sets.map((s, i) => {
                    const homeSetWon = s.home > s.away
                    return (
                      <span
                        key={i}
                        className={`inline-flex h-5 w-7 items-center justify-center rounded text-xs font-mono tabular-nums ${
                          homeSetWon === (game.type === 'home')
                            ? 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                            : 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                        }`}
                      >
                        {s.home}
                      </span>
                    )
                  })}
                </div>
                <div className="flex items-center gap-1 leading-5">
                  {sets.map((s, i) => {
                    const homeSetWon = s.home > s.away
                    return (
                      <span
                        key={i}
                        className={`inline-flex h-5 w-7 items-center justify-center rounded text-xs font-mono tabular-nums ${
                          homeSetWon !== (game.type === 'home')
                            ? 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                            : 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                        }`}
                      >
                        {s.away}
                      </span>
                    )
                  })}
                </div>
              </>
            )}
          </div>

          {/* Col 7: League */}
          <div>
            {game.league && (
              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500 dark:bg-gray-700 dark:text-gray-400">
                {leagueShort(game.league)}
              </span>
            )}
          </div>

          {/* Col 8: Hall */}
          <div className="truncate text-xs text-gray-500 dark:text-gray-400">
            {hallInfo}
          </div>
        </div>
      </>
    )
  }

  const statusBorderColor: Record<string, string> = {
    confirmed: 'bg-green-500 dark:bg-green-400',
    tentative: 'bg-yellow-500 dark:bg-yellow-400',
    declined: 'bg-red-500 dark:bg-red-400',
    waitlisted: 'bg-orange-500 dark:bg-orange-400',
    absent: 'bg-gray-400 dark:bg-gray-500',
  }
  const myStatus = myParticipation?.status ?? null

  return (
    <div
      data-tour="game-card"
      onClick={() => onClick?.(game)}
      className={`flex items-stretch overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-card transition-shadow ${onClick ? 'cursor-pointer hover:shadow-card-hover' : ''}${game.status === 'cancelled' ? ' opacity-60' : ''}`}
    >
      {/* Participation status vertical banner */}
      {user && myStatus && (
        <div className={`w-1 shrink-0 ${statusBorderColor[myStatus] ?? ''}`} />
      )}
      {/* min-w-0: a flex item defaults to min-width:auto and so refuses to shrink
          below its min-content, which the card's overflow-hidden then clips
          instead of wrapping. */}
      <div className="min-w-0 flex-1 p-3">
      {/* Top-right action bar: warning + H/A badge + roster/edit/delete */}
      <div className="flex shrink-0 items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
        {game.status === 'scheduled' && warnings && warnings.length > 0 && (
          <ParticipationWarningBadge warnings={warnings} namespace="participation" />
        )}
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold leading-none ${
          game.type === 'home'
            ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'
            : 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300'
        }`}>
          {game.type === 'home' ? t('typeHomeShort') : t('typeAwayShort')}
        </span>
        {(game.status === 'scheduled' || game.status === 'cancelled') && (
          <CancelActivityButton
            kind="game"
            activityId={game.id}
            isCancelled={game.status === 'cancelled'}
            teamIds={teamIdForPerms ? [teamIdForPerms] : []}
            variant="icon"
            onDone={onParticipationSaved}
          />
        )}
        {onOpenRoster && (
          <button
            onClick={() => onOpenRoster(game)}
            className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-600 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-300"
            title={t('viewRoster')}
            aria-label={t('viewRoster')}
          >
            <Users className="h-4 w-4" />
          </button>
        )}
        {onEdit && canManage && (
          <button
            onClick={() => onEdit(game)}
            className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-600 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-300"
            title={t('editGame')}
            aria-label={t('editGame')}
          >
            <Pencil className="h-4 w-4" />
          </button>
        )}
        {onDelete && canDelete && (
          <button
            onClick={() => onDelete(game.id)}
            className="rounded-lg p-2 text-gray-500 hover:bg-red-50 hover:text-red-600 dark:text-gray-400 dark:hover:bg-red-900/20 dark:hover:text-red-400"
            title={t('deleteGame')}
            aria-label={t('deleteGame')}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="flex gap-3">
        {/* Left: date, time, league, chip */}
        <div className="w-20 shrink-0 space-y-0.5 text-xs text-gray-500 dark:text-gray-400">
          <div className="font-medium text-gray-700 dark:text-gray-300">{game.date ? formatDateCompact(game.date) : ''}</div>
          {game.time && <div>{formatTime(game.time)}</div>}
          <div className="whitespace-pre-line">{leagueShort(game.league)}</div>
          {kscwTeamName && (
            <div className="flex items-center gap-1 pt-0.5">
              {isBB
                ? <BasketballIcon className="h-3.5 w-3.5" filled />
                : <VolleyballIcon className="h-3.5 w-3.5" filled />}
              <TeamChip team={kscwTeamName} size="xs" />
            </div>
          )}
        </div>

        {/* Right: teams stacked + hall */}
        <div className="min-w-0 flex-1">
          <p className={`truncate text-sm text-gray-900 dark:text-gray-100 ${game.type === 'home' ? 'font-bold' : ''}`}>
            {homeLabel}
          </p>
          <p className={`truncate text-sm text-gray-900 dark:text-gray-100 ${game.type === 'away' ? 'font-bold' : ''}`}>
            {awayLabel}
          </p>
          <div className="mt-1 flex items-center gap-2">
            <StatusBadge status={game.status} />
            {hallInfo && <span className="truncate text-xs text-gray-500 dark:text-gray-400">{hallInfo}</span>}
          </div>
          {game.status === 'scheduled' && (
            <div className="mt-1.5 flex flex-wrap items-end gap-2">
              {canParticipate && (
                <ActivityParticipation
                  kind="game"
                  activityId={game.id}
                  date={game.date}
                  respondBy={game.respond_by}
                  activityTime={game.time}
                  existingParticipation={myParticipation}
                  isStaff={!!teamIdForPerms && isStaffOnly(teamIdForPerms)}
                  guestExcluded={!!teamIdForPerms && isGuestIn(teamIdForPerms)}
                  onSaved={onParticipationSaved}
                />
              )}
              <ParticipationSummary activityType="game" activityId={game.id} bars alwaysShow participations={participations ?? []} coachMemberIds={teamCoachIds(kscwTeamObj)} />
            </div>
          )}
        </div>
      </div>
      </div>
    </div>
  )
}
