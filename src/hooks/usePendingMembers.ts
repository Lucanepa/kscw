import { usePB } from './usePB'
import type { Member } from '../types'

export function usePendingMembers(teamId?: string) {
  const filter = teamId
    ? `approved=false && requested_team="${teamId}"`
    : 'approved=false'

  return usePB<Member>('members', {
    filter,
    sort: '-created',
    all: true,
    enabled: !!teamId,
  })
}
