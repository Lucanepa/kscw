import { useState, useEffect, useCallback } from 'react'
import pb from '../pb'
import type { Member, MemberTeam } from '../types'

export type ExpandedMemberTeam = MemberTeam & { expand?: { member?: Member } }

export function useTeamMembers(teamId: string | undefined, season?: string) {
  const [members, setMembers] = useState<ExpandedMemberTeam[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const fetch = useCallback(async () => {
    if (!teamId) {
      setMembers([])
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    setError(null)
    try {
      const filter = season
        ? `team="${teamId}" && season="${season}"`
        : `team="${teamId}"`
      const result = await pb.collection('member_teams').getFullList<ExpandedMemberTeam>({
        filter,
        expand: 'member',
        sort: 'role,member',
      })
      setMembers(result)
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setIsLoading(false)
    }
  }, [teamId, season])

  useEffect(() => {
    fetch()
  }, [fetch])

  return { members, isLoading, error, refetch: fetch }
}
