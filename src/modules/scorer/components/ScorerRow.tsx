import { useState } from 'react'
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
  userId?: string
  userTeamIds?: string[]
  userHasLicence?: boolean
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

/** Game has scorer+taefeler (separate) assignments */
function isSeparateMode(game: Game): boolean {
  return !!(game.scorer_duty_team || game.scorer_member || game.taefeler_duty_team || game.taefeler_member)
}

/** Game has a combined scorer_taefeler assignment */
function isCombinedMode(game: Game): boolean {
  return !!(game.scorer_taefeler_duty_team || game.scorer_taefeler_member)
}

export function hasAnyAssignment(game: Game): boolean {
  return !!(game.scorer_member || game.taefeler_member || game.scorer_taefeler_member)
}

/** All required slots for this game are filled */
export function isFullyAssigned(game: Game): boolean {
  if (isCombinedMode(game)) {
    return !!game.scorer_taefeler_member
  }
  if (isSeparateMode(game)) {
    return !!(game.scorer_member && game.taefeler_member)
  }
  return false
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

type AssignRole = 'scorer' | 'taefeler' | 'scorer_taefeler'

export default function ScorerRow({
  game,
  members,
  teams,
  onUpdate,
  canEdit,
  userId,
  userTeamIds = [],
  userHasLicence = false,
}: ScorerRowProps) {
  const { t } = useTranslation('scorer')
  const expanded = game as ExpandedGame
  const kscwTeam = expanded.expand?.kscw_team?.name ?? ''
  const dateStr = game.date ? dateFormatter.format(new Date(game.date)) : ''

  const separate = isSeparateMode(game)
  const combined = isCombinedMode(game)

  // Self-assign confirmation state
  const [confirmRole, setConfirmRole] = useState<AssignRole | null>(null)

  // Can this user self-assign to a role?
  function canSelfAssign(role: AssignRole): boolean {
    if (!userId || game.duty_confirmed) return false
    // scorer and scorer_taefeler need licence
    if ((role === 'scorer' || role === 'scorer_taefeler') && !userHasLicence) return false
    let dutyTeamId: string | undefined
    let currentPerson: string | undefined
    if (role === 'scorer') {
      dutyTeamId = game.scorer_duty_team
      currentPerson = game.scorer_member
    } else if (role === 'taefeler') {
      dutyTeamId = game.taefeler_duty_team
      currentPerson = game.taefeler_member
    } else {
      dutyTeamId = game.scorer_taefeler_duty_team
      currentPerson = game.scorer_taefeler_member
    }
    if (currentPerson) return false
    if (!dutyTeamId) return false
    return userTeamIds.includes(dutyTeamId)
  }

  function handleSelfAssign(role: AssignRole) {
    if (!userId) return
    const fields: Partial<Game> = {}
    if (role === 'scorer') fields.scorer_member = userId
    else if (role === 'taefeler') fields.taefeler_member = userId
    else fields.scorer_taefeler_member = userId

    // Auto-confirm if all slots will be filled
    if (role === 'scorer' && game.taefeler_member) fields.duty_confirmed = true
    if (role === 'taefeler' && game.scorer_member) fields.duty_confirmed = true
    if (role === 'scorer_taefeler') fields.duty_confirmed = true

    onUpdate(game.id, fields)
    setConfirmRole(null)
  }

  // Admin update with auto-confirm
  function handleAdminUpdate(gameId: string, fields: Partial<Game>) {
    if (separate) {
      const nextScorer = 'scorer_member' in fields ? fields.scorer_member : game.scorer_member
      const nextTaefeler = 'taefeler_member' in fields ? fields.taefeler_member : game.taefeler_member
      if (nextScorer && nextTaefeler && !game.duty_confirmed) {
        fields.duty_confirmed = true
      }
    } else if (combined) {
      const nextMember = 'scorer_taefeler_member' in fields ? fields.scorer_taefeler_member : game.scorer_taefeler_member
      if (nextMember && !game.duty_confirmed) {
        fields.duty_confirmed = true
      }
    }
    onUpdate(gameId, fields)
  }

  const roleLabel = (role: AssignRole) =>
    role === 'scorer' ? t('scorer') : role === 'taefeler' ? t('referee') : t('scorerTaefeler')

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

      {/* Assignment editors */}
      <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {combined ? (
          /* Combined mode: single scorer/taefeler slot */
          <AssignmentEditor
            label={t('scorerTaefeler')}
            requireLicence
            teamValue={game.scorer_taefeler_duty_team ?? ''}
            personValue={game.scorer_taefeler_member ?? ''}
            members={members}
            teams={teams}
            onTeamChange={(v) => handleAdminUpdate(game.id, { scorer_taefeler_duty_team: v })}
            onPersonChange={(v) => handleAdminUpdate(game.id, { scorer_taefeler_member: v })}
            disabled={!canEdit || game.duty_confirmed}
            showContact={canEdit}
            selfAssignButton={canSelfAssign('scorer_taefeler')}
            onSelfAssign={() => setConfirmRole('scorer_taefeler')}
          />
        ) : (
          /* Separate mode (default): scorer + taefeler */
          <>
            <AssignmentEditor
              label={t('scorer')}
              requireLicence
              teamValue={game.scorer_duty_team ?? ''}
              personValue={game.scorer_member ?? ''}
              members={members}
              teams={teams}
              onTeamChange={(v) => handleAdminUpdate(game.id, { scorer_duty_team: v })}
              onPersonChange={(v) => handleAdminUpdate(game.id, { scorer_member: v })}
              disabled={!canEdit || game.duty_confirmed}
              showContact={canEdit}
              selfAssignButton={canSelfAssign('scorer')}
              onSelfAssign={() => setConfirmRole('scorer')}
            />
            <AssignmentEditor
              label={t('referee')}
              requireLicence={false}
              teamValue={game.taefeler_duty_team ?? ''}
              personValue={game.taefeler_member ?? ''}
              members={members}
              teams={teams}
              onTeamChange={(v) => handleAdminUpdate(game.id, { taefeler_duty_team: v })}
              onPersonChange={(v) => handleAdminUpdate(game.id, { taefeler_member: v })}
              disabled={!canEdit || game.duty_confirmed}
              showContact={canEdit}
              selfAssignButton={canSelfAssign('taefeler')}
              onSelfAssign={() => setConfirmRole('taefeler')}
            />
          </>
        )}

        {/* Confirmed badge / admin-only unconfirm */}
        <div className="flex items-end">
          {game.duty_confirmed ? (
            <div className="flex min-h-[44px] items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-3 py-1.5 text-sm font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
                <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                {t('confirmed')}
              </span>
              {canEdit && (
                <button
                  onClick={() => onUpdate(game.id, { duty_confirmed: false })}
                  className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
                  title={t('unconfirm')}
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          ) : (
            <span className="flex min-h-[44px] items-center text-sm text-gray-400 dark:text-gray-500" />
          )}
        </div>
      </div>

      {/* Self-assign confirmation popup */}
      {confirmRole && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="mx-4 w-full max-w-sm rounded-lg bg-white p-6 shadow-xl dark:bg-gray-800">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('confirmSelfAssignTitle')}
            </h3>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              {t('confirmSelfAssignMessage', {
                role: roleLabel(confirmRole),
                game: `${game.home_team} – ${game.away_team}`,
                date: dateStr,
              })}
            </p>
            <div className="mt-4 flex justify-end gap-3">
              <button
                onClick={() => setConfirmRole(null)}
                className="rounded-lg px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                {t('cancelAction')}
              </button>
              <button
                onClick={() => handleSelfAssign(confirmRole)}
                className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600"
              >
                {t('confirmAction')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
