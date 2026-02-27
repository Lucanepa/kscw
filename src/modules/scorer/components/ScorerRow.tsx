import { useTranslation } from 'react-i18next'
import type { RecordModel } from 'pocketbase'
import type { Game, Member, Team, Hall } from '../../../types'
import TeamChip from '../../../components/TeamChip'
import AssignmentEditor from './AssignmentEditor'

interface ScorerRowProps {
  game: Game
  members: Member[]
  onUpdate: (gameId: string, fields: Partial<Game>) => void
  canEdit: boolean
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
})

function DutyStatus({ game }: { game: Game }) {
  const { t } = useTranslation('scorer')
  if (game.duty_confirmed) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
        <svg className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
        </svg>
        {t('statusConfirmed')}
      </span>
    )
  }
  if (game.scorer_person || game.taefeler_person) {
    return (
      <span className="rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-700">
        {t('statusAssigned')}
      </span>
    )
  }
  return (
    <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
      {t('statusOpen')}
    </span>
  )
}

export default function ScorerRow({ game, members, onUpdate, canEdit }: ScorerRowProps) {
  const { t } = useTranslation('scorer')
  const expanded = game as ExpandedGame
  const kscwTeam = expanded.expand?.kscw_team?.name ?? ''
  const dateStr = game.date ? dateFormatter.format(new Date(game.date)) : ''

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
      {/* Game info */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="text-sm text-gray-500 dark:text-gray-400">
          {dateStr} · {game.time}
        </div>
        {kscwTeam && <TeamChip team={kscwTeam} size="sm" />}
        <div className="text-sm font-medium">
          {game.home_team} – {game.away_team}
        </div>
        <span className="rounded bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-xs text-gray-500 dark:text-gray-400">{game.league}</span>
        <DutyStatus game={game} />
      </div>

      {/* Assignment editors */}
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <AssignmentEditor
          label={t('scorer')}
          teamValue={game.scorer_team ?? ''}
          personValue={game.scorer_person ?? ''}
          members={members}
          onTeamChange={(v) => onUpdate(game.id, { scorer_team: v })}
          onPersonChange={(v) => onUpdate(game.id, { scorer_person: v })}
          disabled={!canEdit}
        />
        <AssignmentEditor
          label={t('referee')}
          teamValue={game.taefeler_team ?? ''}
          personValue={game.taefeler_person ?? ''}
          members={members}
          onTeamChange={(v) => onUpdate(game.id, { taefeler_team: v })}
          onPersonChange={(v) => onUpdate(game.id, { taefeler_person: v })}
          disabled={!canEdit}
        />
        <div className="flex items-end">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={game.duty_confirmed ?? false}
              onChange={(e) => onUpdate(game.id, { duty_confirmed: e.target.checked })}
              disabled={!canEdit}
              className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-brand-600"
            />
            <span className={canEdit ? 'text-gray-700 dark:text-gray-300' : 'text-gray-400'}>{t('confirmed')}</span>
          </label>
        </div>
      </div>
    </div>
  )
}
