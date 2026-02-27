import { useState, useMemo } from 'react'
import type { Game, Member } from '../../types'
import { usePB } from '../../hooks/usePB'
import { useRealtime } from '../../hooks/useRealtime'
import { useAuth } from '../../hooks/useAuth'
import pb from '../../pb'
import TeamFilterBar from '../games/components/TeamFilterBar'
import ScorerRow from './components/ScorerRow'
import LoadingSpinner from '../../components/LoadingSpinner'

type StatusFilter = 'all' | 'open' | 'assigned' | 'confirmed'

const STATUS_OPTIONS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'Alle' },
  { key: 'open', label: 'Offen' },
  { key: 'assigned', label: 'Eingeteilt' },
  { key: 'confirmed', label: 'Bestätigt' },
]

function buildTeamFilter(teams: string[]): string {
  if (teams.length === 0) return ''
  const clauses = teams.map((t) => `kscw_team.name ~ "${t}"`)
  return `(${clauses.join(' || ')})`
}

export default function ScorerPage() {
  const { isAdmin, isCoach } = useAuth()
  const canEdit = isAdmin || isCoach

  const [selectedTeams, setSelectedTeams] = useState<string[]>([])
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

  const today = useMemo(() => new Date().toISOString().split('T')[0], [])
  const teamFilter = buildTeamFilter(selectedTeams)

  const scorerFilter = useMemo(() => {
    const parts = [
      `type = "home"`,
      `date >= "${today}"`,
      `status != "completed"`,
      `status != "postponed"`,
    ]
    if (teamFilter) parts.push(teamFilter)
    return parts.join(' && ')
  }, [teamFilter, today])

  const {
    data: games,
    isLoading: gamesLoading,
    refetch,
  } = usePB<Game>('games', {
    filter: scorerFilter,
    sort: '+date,+time',
    expand: 'kscw_team,hall',
    perPage: 100,
  })

  const { data: members } = usePB<Member>('members', {
    filter: 'active = true',
    sort: '+last_name,+first_name',
    perPage: 500,
  })

  // Realtime updates for collaborative editing
  useRealtime<Game>('games', () => {
    refetch()
  }, ['update'])

  // Client-side status filtering
  const filteredGames = useMemo(() => {
    if (statusFilter === 'all') return games
    return games.filter((g) => {
      const hasAssignment = !!(g.scorer_person || g.taefeler_person)
      switch (statusFilter) {
        case 'open':
          return !hasAssignment
        case 'assigned':
          return hasAssignment && !g.duty_confirmed
        case 'confirmed':
          return g.duty_confirmed
        default:
          return true
      }
    })
  }, [games, statusFilter])

  async function handleUpdate(gameId: string, fields: Partial<Game>) {
    try {
      await pb.collection('games').update(gameId, fields)
      refetch()
    } catch (err) {
      console.error('Failed to update game:', err)
    }
  }

  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 sm:text-2xl dark:text-gray-100">Schreibereinsätze</h1>
      <p className="mt-1 text-gray-600 dark:text-gray-400">Schreiber- und Täfeler-Einteilung pro Heimspiel.</p>

      <div className="mt-6 space-y-4">
        <TeamFilterBar selected={selectedTeams} onChange={setSelectedTeams} />

        {/* Status filter */}
        <div className="flex flex-wrap gap-2">
          {STATUS_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              onClick={() => setStatusFilter(opt.key)}
              className={`rounded-full px-3 py-2 text-sm font-medium transition-colors sm:py-1 ${
                statusFilter === opt.key
                  ? 'bg-brand-100 text-brand-700'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6">
        {gamesLoading && <LoadingSpinner />}

        {!gamesLoading && filteredGames.length === 0 && (
          <div className="py-12 text-center text-gray-500 dark:text-gray-400">
            <p>Keine Spiele gefunden.</p>
            <p className="mt-1 text-sm">Versuche, die Filter anzupassen.</p>
          </div>
        )}

        {!gamesLoading && filteredGames.length > 0 && (
          <div className="space-y-3">
            {filteredGames.map((g) => (
              <ScorerRow
                key={g.id}
                game={g}
                members={members}
                onUpdate={handleUpdate}
                canEdit={canEdit}
              />
            ))}
          </div>
        )}
      </div>

      {!canEdit && (
        <p className="mt-6 text-sm text-gray-500 dark:text-gray-400">
          Nur Trainer und Admins können Einsätze bearbeiten.
        </p>
      )}
    </div>
  )
}
