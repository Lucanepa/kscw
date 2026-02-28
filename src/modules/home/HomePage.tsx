import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useTheme } from '../../hooks/useTheme'
import { useAuth } from '../../hooks/useAuth'
import { usePB } from '../../hooks/usePB'
import { formatDate, formatTime, formatWeekday } from '../../utils/dateHelpers'
import LoadingSpinner from '../../components/LoadingSpinner'
import TeamChip from '../../components/TeamChip'
import GameDetailModal from '../games/components/GameDetailModal'
import type { Game, Event, Team, Training, Hall, Member, MemberTeam } from '../../types'
import type { RecordModel } from 'pocketbase'

type ExpandedGame = Game & {
  expand?: { kscw_team?: Team & RecordModel; hall?: RecordModel }
}

type EventExpanded = Event & { expand?: { teams?: Team[] } }

type TrainingExpanded = Training & {
  expand?: { team?: Team; hall?: Hall; coach?: Member }
}

type MemberTeamExpanded = MemberTeam & { expand?: { team?: Team } }

const eventTypeColors: Record<string, { bg: string; text: string }> = {
  verein: { bg: '#dbeafe', text: '#1e40af' },
  social: { bg: '#dcfce7', text: '#166534' },
  meeting: { bg: '#fef3c7', text: '#92400e' },
  tournament: { bg: '#fee2e2', text: '#991b1b' },
  other: { bg: '#f3f4f6', text: '#374151' },
}

export default function HomePage() {
  const { t } = useTranslation('home')
  const { theme } = useTheme()
  const { user } = useAuth()
  const [selectedGame, setSelectedGame] = useState<ExpandedGame | null>(null)
  const [showAllGames, setShowAllGames] = useState(false)
  const [showAllResults, setShowAllResults] = useState(false)

  const today = useMemo(() => new Date().toISOString().split('T')[0], [])

  // Fetch user's team memberships (only when logged in)
  const { data: memberTeams } = usePB<MemberTeamExpanded>('member_teams', {
    filter: user ? `member="${user.id}"` : '',
    expand: 'team',
    perPage: 20,
    enabled: !!user,
  })

  const userTeamIds = useMemo(() => memberTeams.map((mt) => mt.team), [memberTeams])
  const hasTeams = userTeamIds.length > 0

  // Build team filter for games
  const teamGameFilter = useMemo(() => {
    if (!hasTeams) return ''
    return userTeamIds.map((id) => `kscw_team="${id}"`).join(' || ')
  }, [userTeamIds, hasTeams])

  // Next 5 upcoming games (all)
  const { data: allNextGames, isLoading: gamesLoading } = usePB<ExpandedGame>('games', {
    filter: `status = "scheduled" && date >= "${today}"`,
    sort: '+date,+time',
    expand: 'kscw_team,hall',
    perPage: 5,
  })

  // Next 5 upcoming games (my teams only)
  const { data: myNextGames } = usePB<ExpandedGame>('games', {
    filter: `status = "scheduled" && date >= "${today}" && (${teamGameFilter})`,
    sort: '+date,+time',
    expand: 'kscw_team,hall',
    perPage: 5,
    enabled: hasTeams && !showAllGames,
  })

  // Latest 5 results (all)
  const { data: allLatestResults, isLoading: resultsLoading } = usePB<ExpandedGame>('games', {
    filter: `status = "completed"`,
    sort: '-date,-time',
    expand: 'kscw_team,hall',
    perPage: 5,
  })

  // Latest 5 results (my teams only)
  const { data: myLatestResults } = usePB<ExpandedGame>('games', {
    filter: `status = "completed" && (${teamGameFilter})`,
    sort: '-date,-time',
    expand: 'kscw_team,hall',
    perPage: 5,
    enabled: hasTeams && !showAllResults,
  })

  // Next trainings for user's teams
  const trainingFilter = useMemo(() => {
    if (!hasTeams) return ''
    const teamPart = userTeamIds.map((id) => `team="${id}"`).join(' || ')
    return `(${teamPart}) && date >= "${today}" && cancelled = false`
  }, [userTeamIds, hasTeams, today])

  const { data: nextTrainings, isLoading: trainingsLoading } = usePB<TrainingExpanded>('trainings', {
    filter: trainingFilter,
    sort: '+date,+start_time',
    expand: 'team,hall,coach',
    perPage: 3,
    enabled: hasTeams,
  })

  // Decide which games/results to show
  const nextGames = hasTeams && !showAllGames ? myNextGames : allNextGames
  const latestResults = hasTeams && !showAllResults ? myLatestResults : allLatestResults

  // Upcoming events
  const { data: events, isLoading: eventsLoading } = usePB<EventExpanded>('events', {
    filter: `end_date >= "${today}"`,
    sort: '+start_date',
    expand: 'teams',
    perPage: 10,
  })

  return (
    <div>
      {/* Hero */}
      <div className="flex flex-col items-center pb-6 pt-2 text-center">
        <img
          src={theme === 'light' ? '/kscw_blau.png' : '/kscw_weiss.png'}
          alt="KSC Wiedikon"
          className="h-20 w-auto sm:h-24"
        />
        <h1 className="mt-3 text-2xl font-bold text-gray-900 sm:text-3xl dark:text-gray-100">
          KSC Wiedikon
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {t('subtitle')}
        </p>
      </div>

      {/* Content grid: events left, games right */}
      <div className="grid gap-6 lg:grid-cols-5">
        {/* Events — left column (wider) */}
        <div className="lg:col-span-2">
          <SectionHeader
            title={t('events')}
            linkTo="/events"
            linkLabel={t('allEvents')}
          />
          {eventsLoading ? (
            <LoadingSpinner />
          ) : events.length === 0 ? (
            <EmptyCard message={t('noEvents')} />
          ) : (
            <div className="space-y-3">
              {events.map((event) => (
                <EventRow key={event.id} event={event} />
              ))}
            </div>
          )}
        </div>

        {/* Games — right column */}
        <div className="space-y-6 lg:col-span-3">
          {/* Next trainings (logged-in only) */}
          {hasTeams && (
            <div>
              <SectionHeader title={t('nextTrainings')} linkTo="/trainings" linkLabel={t('allTrainings')} />
              {trainingsLoading ? (
                <LoadingSpinner />
              ) : nextTrainings.length === 0 ? (
                <EmptyCard message={t('noTrainings')} />
              ) : (
                <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
                  {nextTrainings.map((tr) => (
                    <CompactTrainingRow key={tr.id} training={tr} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Latest results */}
          <div>
            <SectionHeader
              title={t('latestResults')}
              linkTo="/games"
              linkLabel={t('allResults')}
              filterToggle={hasTeams ? {
                active: !showAllResults,
                label: t('myTeams'),
                onToggle: () => setShowAllResults((v) => !v),
              } : undefined}
            />
            {resultsLoading ? (
              <LoadingSpinner />
            ) : latestResults.length === 0 ? (
              <EmptyCard message={t('noResults')} />
            ) : (
              <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
                {latestResults.map((g) => (
                  <CompactGameRow key={g.id} game={g} showScore onClick={() => setSelectedGame(g)} />
                ))}
              </div>
            )}
          </div>

          {/* Next games */}
          <div>
            <SectionHeader
              title={t('nextGames')}
              linkTo="/games"
              linkLabel={t('allGames')}
              filterToggle={hasTeams ? {
                active: !showAllGames,
                label: t('myTeams'),
                onToggle: () => setShowAllGames((v) => !v),
              } : undefined}
            />
            {gamesLoading ? (
              <LoadingSpinner />
            ) : nextGames.length === 0 ? (
              <EmptyCard message={t('noUpcoming')} />
            ) : (
              <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
                {nextGames.map((g) => (
                  <CompactGameRow key={g.id} game={g} showScore={false} onClick={() => setSelectedGame(g)} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <GameDetailModal game={selectedGame} onClose={() => setSelectedGame(null)} />
    </div>
  )
}

/* ---------- Sub-components ---------- */

function SectionHeader({
  title,
  linkTo,
  linkLabel,
  filterToggle,
}: {
  title: string
  linkTo: string
  linkLabel: string
  filterToggle?: { active: boolean; label: string; onToggle: () => void }
}) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
        {filterToggle && (
          <button
            onClick={filterToggle.onToggle}
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
              filterToggle.active
                ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300'
                : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
            }`}
          >
            {filterToggle.active ? filterToggle.label : filterToggle.label}
          </button>
        )}
      </div>
      <Link
        to={linkTo}
        className="text-sm font-medium text-brand-600 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300"
      >
        {linkLabel} →
      </Link>
    </div>
  )
}

function EmptyCard({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
      {message}
    </div>
  )
}

function CompactGameRow({ game, showScore, onClick }: { game: ExpandedGame; showScore: boolean; onClick?: () => void }) {
  const kscwTeam = game.expand?.kscw_team?.name ?? ''
  const dateStr = game.date ? formatDate(game.date) : ''

  return (
    <div
      className="flex cursor-pointer items-center gap-3 border-b border-gray-100 px-4 py-3 last:border-b-0 hover:bg-gray-50 active:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-700/50 dark:active:bg-gray-700"
      onClick={onClick}
    >
      {/* Date & time */}
      <div className="w-24 shrink-0 text-xs text-gray-500 dark:text-gray-400">
        <div>{dateStr}</div>
        {game.time && <div>{formatTime(game.time)}</div>}
      </div>

      {/* Teams */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm">
          <span className={`truncate text-gray-900 dark:text-gray-100 ${game.type === 'home' ? 'font-semibold' : ''}`}>
            {game.home_team}
          </span>
          <span className="shrink-0 text-gray-400 dark:text-gray-500">–</span>
          <span className={`truncate text-gray-900 dark:text-gray-100 ${game.type === 'away' ? 'font-semibold' : ''}`}>
            {game.away_team}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <span className="text-xs text-gray-400 dark:text-gray-500">{game.league}</span>
          {kscwTeam && <TeamChip team={kscwTeam} size="sm" />}
        </div>
      </div>

      {/* Score */}
      {showScore && game.status === 'completed' && (
        <div className="shrink-0 font-mono text-lg font-bold text-gray-900 dark:text-white">
          {game.home_score}:{game.away_score}
        </div>
      )}
    </div>
  )
}

function CompactTrainingRow({ training }: { training: TrainingExpanded }) {
  const team = training.expand?.team
  const hall = training.expand?.hall
  const dateStr = training.date ? formatDate(training.date) : ''
  const weekday = training.date ? formatWeekday(training.date) : ''

  return (
    <div className="flex items-center gap-3 border-b border-gray-100 px-4 py-3 last:border-b-0 dark:border-gray-700">
      {/* Date & time */}
      <div className="w-24 shrink-0 text-xs text-gray-500 dark:text-gray-400">
        <div>{weekday}, {dateStr}</div>
        <div>{formatTime(training.start_time)} – {formatTime(training.end_time)}</div>
      </div>

      {/* Info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {team && <TeamChip team={team.name} size="sm" />}
          {hall && <span className="text-sm text-gray-700 dark:text-gray-300">{hall.name}</span>}
        </div>
        {training.notes && (
          <p className="mt-0.5 truncate text-xs text-gray-400 dark:text-gray-500">{training.notes}</p>
        )}
      </div>
    </div>
  )
}

function EventRow({ event }: { event: EventExpanded }) {
  const { t } = useTranslation('events')
  const teams = event.expand?.teams ?? []
  const colors = eventTypeColors[event.event_type] ?? eventTypeColors.other

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-start gap-3">
        {/* Date badge */}
        <div className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-lg bg-brand-50 dark:bg-brand-900/40">
          <span className="text-lg font-bold leading-none text-brand-600 dark:text-brand-400">
            {new Date(event.start_date).getDate()}
          </span>
          <span className="text-[10px] font-medium uppercase text-brand-500 dark:text-brand-400">
            {new Date(event.start_date).toLocaleString('de-CH', { month: 'short' })}
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase"
              style={{ backgroundColor: colors.bg, color: colors.text }}
            >
              {t(event.event_type === 'verein' ? 'club' : event.event_type)}
            </span>
            <h3 className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
              {event.title}
            </h3>
          </div>
          {event.location && (
            <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">{event.location}</p>
          )}
          {event.description && (
            <p className="mt-1 line-clamp-2 text-xs text-gray-500 dark:text-gray-400">
              {event.description}
            </p>
          )}
          {teams.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {teams.map((team) => (
                <TeamChip key={team.id} team={team.name} size="sm" />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
