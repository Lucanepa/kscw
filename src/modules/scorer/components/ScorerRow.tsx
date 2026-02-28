import { useTranslation } from 'react-i18next'
import type { RecordModel } from 'pocketbase'
import type { Game, Member, Team, Hall } from '../../../types'
import TeamChip from '../../../components/TeamChip'
import AssignmentEditor from './AssignmentEditor'
import { downloadICal } from '../../../utils/icalGenerator'
import type { CalendarEntry } from '../../../types/calendar'

interface ScorerRowProps {
  game: Game
  members: Member[]
  teams: Team[]
  onUpdate: (gameId: string, fields: Partial<Game>) => void
  canEdit: boolean
}

export type ExpandedGame = Game & {
  expand?: {
    kscw_team?: Team & RecordModel
    hall?: Hall & RecordModel
    scorer_member?: Member & RecordModel
    taefeler_member?: Member & RecordModel
    scorer_taefeler_member?: Member & RecordModel
    scorer_duty_team?: Team & RecordModel
    taefeler_duty_team?: Team & RecordModel
    scorer_taefeler_duty_team?: Team & RecordModel
  }
}

const dateFormatter = new Intl.DateTimeFormat('de-CH', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
})

export function hasAnyAssignment(game: Game): boolean {
  return !!(game.scorer_member || game.taefeler_member || game.scorer_taefeler_member)
}

function isCombinedMode(game: Game): boolean {
  return !!game.scorer_taefeler_member || !!game.scorer_taefeler_duty_team
}

export function DutyStatus({ game }: { game: Game }) {
  const { t } = useTranslation('scorer')
  if (game.duty_confirmed) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
        <svg className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
        </svg>
        {t('statusConfirmed')}
      </span>
    )
  }
  if (hasAnyAssignment(game)) {
    return (
      <span className="rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">
        {t('statusAssigned')}
      </span>
    )
  }
  return (
    <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400">
      {t('statusOpen')}
    </span>
  )
}

function handleExportICal(game: ExpandedGame) {
  const hallName = game.expand?.hall?.name ?? ''
  const entry: CalendarEntry = {
    id: `duty-${game.id}`,
    type: 'game',
    title: `Schreiberdienst: ${game.home_team} vs ${game.away_team}`,
    date: new Date(game.date),
    startTime: game.time,
    endTime: null,
    allDay: false,
    location: hallName,
    teamNames: [],
    description: `${game.home_team} vs ${game.away_team}\n${game.league}`,
    source: game,
  }
  downloadICal([entry], `schreiberdienst-${game.date}.ics`)
}

export default function ScorerRow({ game, members, teams, onUpdate, canEdit }: ScorerRowProps) {
  const { t } = useTranslation('scorer')
  const expanded = game as ExpandedGame
  const kscwTeam = expanded.expand?.kscw_team?.name ?? ''
  const dateStr = game.date ? dateFormatter.format(new Date(game.date)) : ''
  const combined = isCombinedMode(game)

  function toggleMode() {
    if (combined) {
      // Switch to separate: clear combined fields
      onUpdate(game.id, {
        scorer_taefeler_member: '',
        scorer_taefeler_duty_team: '',
      })
    } else {
      // Switch to combined: clear separate fields
      onUpdate(game.id, {
        scorer_member: '',
        scorer_duty_team: '',
        taefeler_member: '',
        taefeler_duty_team: '',
      })
    }
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
      {/* Game info */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-sm text-gray-500 dark:text-gray-400">
          {dateStr} · {game.time}
        </div>
        {kscwTeam && <TeamChip team={kscwTeam} size="sm" />}
        <div className="text-sm font-medium dark:text-gray-200">
          {game.home_team} – {game.away_team}
        </div>
        <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-700 dark:text-gray-400">
          {game.league}
        </span>
        <DutyStatus game={game} />
        <button
          onClick={() => handleExportICal(expanded)}
          title={t('exportICal')}
          className="ml-auto rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        </button>
      </div>

      {/* Mode toggle */}
      {canEdit && (
        <div className="mt-3 flex gap-1">
          <button
            onClick={() => combined && toggleMode()}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              !combined
                ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/30 dark:text-brand-400'
                : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:hover:bg-gray-600'
            }`}
          >
            {t('separate')}
          </button>
          <button
            onClick={() => !combined && toggleMode()}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              combined
                ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/30 dark:text-brand-400'
                : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:hover:bg-gray-600'
            }`}
          >
            {t('combined')}
          </button>
        </div>
      )}

      {/* Assignment editors */}
      <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {combined ? (
          <AssignmentEditor
            label={t('scorerTaefeler')}
            roleType="scorer_taefeler"
            teamValue={game.scorer_taefeler_duty_team ?? ''}
            personValue={game.scorer_taefeler_member ?? ''}
            members={members}
            teams={teams}
            onTeamChange={(v) => onUpdate(game.id, { scorer_taefeler_duty_team: v })}
            onPersonChange={(v) => onUpdate(game.id, { scorer_taefeler_member: v })}
            disabled={!canEdit}
          />
        ) : (
          <>
            <AssignmentEditor
              label={t('scorer')}
              roleType="scorer"
              teamValue={game.scorer_duty_team ?? ''}
              personValue={game.scorer_member ?? ''}
              members={members}
              teams={teams}
              onTeamChange={(v) => onUpdate(game.id, { scorer_duty_team: v })}
              onPersonChange={(v) => onUpdate(game.id, { scorer_member: v })}
              disabled={!canEdit}
            />
            <AssignmentEditor
              label={t('referee')}
              roleType="taefeler"
              teamValue={game.taefeler_duty_team ?? ''}
              personValue={game.taefeler_member ?? ''}
              members={members}
              teams={teams}
              onTeamChange={(v) => onUpdate(game.id, { taefeler_duty_team: v })}
              onPersonChange={(v) => onUpdate(game.id, { taefeler_member: v })}
              disabled={!canEdit}
            />
          </>
        )}
        <div className="flex items-end">
          <label className="flex min-h-[44px] items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={game.duty_confirmed ?? false}
              onChange={(e) => onUpdate(game.id, { duty_confirmed: e.target.checked })}
              disabled={!canEdit}
              className="h-5 w-5 rounded border-gray-300 text-brand-600 dark:border-gray-600"
            />
            <span className={canEdit ? 'text-gray-700 dark:text-gray-300' : 'text-gray-400 dark:text-gray-500'}>
              {t('confirmed')}
            </span>
          </label>
        </div>
      </div>
    </div>
  )
}
