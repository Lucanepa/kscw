import { usePB } from '../../../hooks/usePB'
import type { Hall, HallSlot, HallClosure, Team } from '../../../types'

export function useHallenplanData(selectedHallId: string, mondayStr: string, sundayStr: string) {
  const { data: halls, isLoading: hallsLoading } = usePB<Hall>('halls', {
    sort: 'name',
    perPage: 50,
  })

  const { data: teams, isLoading: teamsLoading } = usePB<Team>('teams', {
    filter: 'active = true',
    sort: 'name',
    perPage: 50,
  })

  const hallFilter = selectedHallId ? `hall = "${selectedHallId}" && ` : ''
  const dateFilter = `(valid_from <= "${sundayStr}" || valid_from = "") && (valid_until >= "${mondayStr}" || valid_until = "")`

  const {
    data: slots,
    isLoading: slotsLoading,
    refetch: refetchSlots,
  } = usePB<HallSlot>('hall_slots', {
    filter: `${hallFilter}${dateFilter}`,
    expand: 'team,hall',
    perPage: 200,
    sort: 'day_of_week,start_time',
  })

  const closureDateFilter = `start_date <= "${sundayStr}" && end_date >= "${mondayStr}"`

  const {
    data: closures,
    isLoading: closuresLoading,
    refetch: refetchClosures,
  } = usePB<HallClosure>('hall_closures', {
    filter: `${hallFilter}${closureDateFilter}`,
    expand: 'hall',
    perPage: 100,
  })

  const refetch = () => {
    refetchSlots()
    refetchClosures()
  }

  const isLoading = hallsLoading || teamsLoading || slotsLoading || closuresLoading

  return { halls, teams, slots, closures, isLoading, refetch }
}
