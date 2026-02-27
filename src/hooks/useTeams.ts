import { usePB } from './usePB'
import type { Team } from '../types'

export function useTeams(sport?: 'volleyball' | 'basketball' | 'all') {
  const filter =
    sport && sport !== 'all'
      ? `active = true && sport = "${sport}"`
      : 'active = true'

  return usePB<Team>('teams', {
    filter,
    sort: 'name',
    perPage: 50,
  })
}
