import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import pb from '../../pb'
import { useTeamMembers } from '../../hooks/useTeamMembers'
import { useAuth } from '../../hooks/useAuth'
import TeamChip from '../../components/TeamChip'
import EmptyState from '../../components/EmptyState'
import MemberRow from './MemberRow'
import type { Team } from '../../types'

export default function TeamDetail() {
  const { teamId } = useParams<{ teamId: string }>()
  const { isCoach } = useAuth()
  const [team, setTeam] = useState<Team | null>(null)
  const [loading, setLoading] = useState(true)
  const { members, isLoading: membersLoading } = useTeamMembers(teamId)

  useEffect(() => {
    if (!teamId) return
    setLoading(true)
    pb.collection('teams')
      .getOne<Team>(teamId)
      .then(setTeam)
      .catch(() => setTeam(null))
      .finally(() => setLoading(false))
  }, [teamId])

  if (loading || membersLoading) {
    return <div className="py-12 text-center text-gray-500 dark:text-gray-400">Laden...</div>
  }

  if (!team) {
    return <EmptyState icon="❌" title="Team nicht gefunden" />
  }

  return (
    <div>
      <div className="mb-6 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <Link to="/teams" className="hover:text-gray-700 dark:text-gray-300">Teams</Link>
        <span>/</span>
        <span className="text-gray-900 dark:text-gray-100">{team.full_name}</span>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <TeamChip team={team.name} />
            <h1 className="text-xl font-bold text-gray-900 sm:text-2xl dark:text-gray-100">{team.full_name}</h1>
          </div>
          <div className="mt-2 flex gap-4 text-sm text-gray-500 dark:text-gray-400">
            <span>{team.league}</span>
            <span>{team.season}</span>
            <span>{team.sport === 'volleyball' ? 'Volleyball' : 'Basketball'}</span>
          </div>
        </div>

        {isCoach && (
          <Link
            to={`/teams/${teamId}/roster/edit`}
            className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600"
          >
            Kader bearbeiten
          </Link>
        )}
      </div>

      <div className="mt-8">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Kader ({members.length})</h2>

        {members.length === 0 ? (
          <EmptyState
            icon="👤"
            title="Keine Spieler"
            description="Diesem Team sind noch keine Spieler zugewiesen."
            action={
              isCoach ? (
                <Link
                  to={`/teams/${teamId}/roster/edit`}
                  className="text-sm text-brand-600 hover:text-brand-700"
                >
                  Spieler hinzufügen
                </Link>
              ) : undefined
            }
          />
        ) : (
          <div className="mt-4 overflow-x-auto rounded-lg border bg-white dark:bg-gray-800">
            <table className="w-full">
              <thead>
                <tr className="border-b bg-gray-50 dark:bg-gray-900 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  <th className="px-4 py-3">Spieler</th>
                  <th className="px-4 py-3">#Nr</th>
                  <th className="hidden px-4 py-3 sm:table-cell">Position</th>
                  <th className="px-4 py-3">Rolle</th>
                </tr>
              </thead>
              <tbody>
                {members.map((mt) => (
                  <MemberRow key={mt.id} memberTeam={mt} teamId={team.id} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
