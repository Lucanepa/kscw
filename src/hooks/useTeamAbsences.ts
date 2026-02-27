import { useState, useEffect, useCallback } from 'react'
import pb from '../pb'
import type { Absence, Member, MemberTeam } from '../types'

export type AbsenceWithMember = Absence & { expand?: { member?: Member } }

export function useTeamAbsences(teamId: string | null, startDate: string, endDate: string) {
  const [absences, setAbsences] = useState<AbsenceWithMember[]>([])
  const [memberMap, setMemberMap] = useState<Record<string, Member>>({})
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const fetch = useCallback(async () => {
    if (!teamId) {
      setAbsences([])
      setMemberMap({})
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    setError(null)
    try {
      const memberTeams = await pb.collection('member_teams').getFullList<MemberTeam>({
        filter: `team="${teamId}"`,
      })
      const memberIds = memberTeams.map((mt) => mt.member)

      if (memberIds.length === 0) {
        setAbsences([])
        setMemberMap({})
        setIsLoading(false)
        return
      }

      const memberFilter = memberIds.map((id) => `member="${id}"`).join(' || ')
      const result = await pb.collection('absences').getFullList<AbsenceWithMember>({
        filter: `(${memberFilter}) && end_date>="${startDate}" && start_date<="${endDate}"`,
        expand: 'member',
        sort: 'start_date',
      })

      const mMap: Record<string, Member> = {}
      for (const a of result) {
        if (a.expand?.member) {
          mMap[a.member] = a.expand.member
        }
      }

      setAbsences(result)
      setMemberMap(mMap)
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setIsLoading(false)
    }
  }, [teamId, startDate, endDate])

  useEffect(() => {
    fetch()
  }, [fetch])

  return { absences, memberMap, isLoading, error, refetch: fetch }
}
