import { useState, useEffect, useCallback } from 'react'
import pb from '../../pb'
import { getSeasonDateRange } from '../../utils/dateHelpers'
import type { Training, TrainingAttendance, Member } from '../../types'

export interface PlayerStats {
  memberId: string
  memberName: string
  jerseyNumber: number
  total: number
  present: number
  absent: number
  late: number
  excused: number
  percentage: number
  trend: ('present' | 'absent' | 'late' | 'excused')[]
}

type AttendanceExpanded = TrainingAttendance & { expand?: { member?: Member } }

export function useAttendanceStats(teamId: string | null, season: string) {
  const [stats, setStats] = useState<PlayerStats[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const fetch = useCallback(async () => {
    if (!teamId) {
      setStats([])
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    setError(null)
    try {
      const { start, end } = getSeasonDateRange(season)

      const trainings = await pb.collection('trainings').getFullList<Training>({
        filter: `team="${teamId}" && date>="${start}" && date<="${end}" && cancelled=false`,
        sort: 'date',
      })

      if (trainings.length === 0) {
        setStats([])
        setIsLoading(false)
        return
      }

      const trainingIds = trainings.map((t) => t.id)
      const trainingFilter = trainingIds.map((id) => `training="${id}"`).join(' || ')

      const attendance = await pb.collection('training_attendance').getFullList<AttendanceExpanded>({
        filter: trainingFilter,
        expand: 'member',
      })

      // Build per-member stats
      const memberStats: Record<string, PlayerStats> = {}

      for (const a of attendance) {
        const member = a.expand?.member
        if (!member) continue

        if (!memberStats[a.member]) {
          memberStats[a.member] = {
            memberId: a.member,
            memberName: member.name,
            jerseyNumber: member.number,
            total: 0,
            present: 0,
            absent: 0,
            late: 0,
            excused: 0,
            percentage: 0,
            trend: [],
          }
        }

        const s = memberStats[a.member]
        s.total++
        if (a.status === 'present') s.present++
        else if (a.status === 'absent') s.absent++
        else if (a.status === 'late') s.late++
        else if (a.status === 'excused') s.excused++
      }

      // Build trend (last 5 trainings) for each member
      const lastTrainings = trainings.slice(-5)
      for (const memberId of Object.keys(memberStats)) {
        const trend: PlayerStats['trend'] = []
        for (const t of lastTrainings) {
          const record = attendance.find((a) => a.member === memberId && a.training === t.id)
          trend.push(record?.status ?? 'absent')
        }
        memberStats[memberId].trend = trend
      }

      // Calculate percentage and sort
      const result = Object.values(memberStats).map((s) => ({
        ...s,
        percentage: s.total > 0 ? Math.round(((s.present + s.late) / s.total) * 100) : 0,
      }))
      result.sort((a, b) => b.percentage - a.percentage)

      setStats(result)
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setIsLoading(false)
    }
  }, [teamId, season])

  useEffect(() => {
    fetch()
  }, [fetch])

  return { stats, isLoading, error, refetch: fetch }
}
