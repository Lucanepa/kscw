import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import pb from '../../pb'
import { usePB } from '../../hooks/usePB'
import { useAuth } from '../../hooks/useAuth'
import TeamChip from '../../components/TeamChip'
import StatusBadge from '../../components/StatusBadge'
import EmptyState from '../../components/EmptyState'
import { getFileUrl } from '../../utils/pbFile'
import { formatDate, getCurrentSeason, getSeasonDateRange } from '../../utils/dateHelpers'
import type { Member, MemberTeam, Team, Absence, TrainingAttendance } from '../../types'

type ExpandedMemberTeam = MemberTeam & { expand?: { team?: Team } }

export default function PlayerProfile() {
  const { memberId } = useParams<{ memberId: string }>()
  const { isCoach } = useAuth()
  const [member, setMember] = useState<Member | null>(null)
  const [loading, setLoading] = useState(true)

  const { data: memberTeams } = usePB<ExpandedMemberTeam>('member_teams', {
    filter: memberId ? `member="${memberId}"` : '',
    expand: 'team',
    perPage: 20,
  })

  const season = getCurrentSeason()
  const { start, end } = getSeasonDateRange(season)

  const { data: absences } = usePB<Absence>('absences', {
    filter: memberId ? `member="${memberId}" && end_date>="${new Date().toISOString().split('T')[0]}"` : '',
    sort: 'start_date',
    perPage: 20,
  })

  const [attendanceStats, setAttendanceStats] = useState<{ total: number; present: number } | null>(null)

  useEffect(() => {
    if (!memberId) return
    setLoading(true)
    pb.collection('members')
      .getOne<Member>(memberId)
      .then(setMember)
      .catch(() => setMember(null))
      .finally(() => setLoading(false))
  }, [memberId])

  useEffect(() => {
    if (!memberId) return
    pb.collection('training_attendance')
      .getFullList<TrainingAttendance>({
        filter: `member="${memberId}" && training.date>="${start}" && training.date<="${end}"`,
      })
      .then((records) => {
        setAttendanceStats({
          total: records.length,
          present: records.filter((r) => r.status === 'present' || r.status === 'late').length,
        })
      })
      .catch(() => setAttendanceStats(null))
  }, [memberId, start, end])

  if (loading) {
    return <div className="py-12 text-center text-gray-500 dark:text-gray-400">Laden...</div>
  }

  if (!member) {
    return <EmptyState icon="❌" title="Spieler nicht gefunden" />
  }

  const initials = `${member.first_name?.[0] ?? ''}${member.last_name?.[0] ?? ''}`.toUpperCase()
  const attendancePct = attendanceStats && attendanceStats.total > 0
    ? Math.round((attendanceStats.present / attendanceStats.total) * 100)
    : null

  return (
    <div>
      <div className="mb-6 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <Link to="/teams" className="hover:text-gray-700 dark:text-gray-300">Teams</Link>
        <span>/</span>
        <span className="text-gray-900 dark:text-gray-100">{member.name}</span>
      </div>

      {/* Header */}
      <div className="flex items-start gap-6">
        {member.photo ? (
          <img
            src={getFileUrl('members', member.id, member.photo)}
            alt={member.name}
            className="h-24 w-24 rounded-full object-cover"
          />
        ) : (
          <div className="flex h-24 w-24 items-center justify-center rounded-full bg-gray-200 text-2xl font-bold text-gray-500 dark:text-gray-400">
            {initials}
          </div>
        )}
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{member.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-gray-500 dark:text-gray-400">
            {member.number && <span>#{member.number}</span>}
            <span className="capitalize">{member.position}</span>
            <StatusBadge status={member.role} />
          </div>
          {isCoach && (
            <div className="mt-2 flex flex-wrap gap-3 text-sm text-gray-500 dark:text-gray-400">
              {member.email && <span>{member.email}</span>}
              {member.phone && <span>{member.phone}</span>}
              {member.license_nr && <span>Lizenz: {member.license_nr}</span>}
            </div>
          )}
        </div>
      </div>

      {/* Teams */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Teams</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {memberTeams.map((mt) => (
            <Link key={mt.id} to={`/teams/${mt.team}`}>
              <TeamChip team={mt.expand?.team?.name ?? '?'} />
            </Link>
          ))}
          {memberTeams.length === 0 && (
            <p className="text-sm text-gray-500 dark:text-gray-400">Keinem Team zugewiesen</p>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Statistiken ({season})</h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          <div className="rounded-lg border bg-white dark:bg-gray-800 p-4">
            <p className="text-sm text-gray-500 dark:text-gray-400">Trainings besucht</p>
            <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-100">
              {attendanceStats ? `${attendanceStats.present}/${attendanceStats.total}` : '—'}
            </p>
          </div>
          <div className="rounded-lg border bg-white dark:bg-gray-800 p-4">
            <p className="text-sm text-gray-500 dark:text-gray-400">Anwesenheitsquote</p>
            <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-100">
              {attendancePct !== null ? `${attendancePct}%` : '—'}
            </p>
          </div>
          <div className="rounded-lg border bg-white dark:bg-gray-800 p-4">
            <p className="text-sm text-gray-500 dark:text-gray-400">Aktive Absenzen</p>
            <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-100">{absences.length}</p>
          </div>
        </div>
      </div>

      {/* Active Absences */}
      {absences.length > 0 && (
        <div className="mt-8">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Aktuelle Absenzen</h2>
          <div className="mt-3 space-y-2">
            {absences.map((a) => (
              <div key={a.id} className="flex items-center gap-3 rounded-lg border bg-white dark:bg-gray-800 px-4 py-3">
                <StatusBadge status={a.reason} />
                <span className="text-sm text-gray-700 dark:text-gray-300">
                  {formatDate(a.start_date)}
                  {a.start_date !== a.end_date && ` — ${formatDate(a.end_date)}`}
                </span>
                {a.reason_detail && (
                  <span className="text-sm text-gray-400">{a.reason_detail}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
