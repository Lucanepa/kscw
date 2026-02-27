import { useCallback } from 'react'
import { usePB } from './usePB'
import { useMutation } from './useMutation'
import { useAuth } from './useAuth'
import type { Participation, Absence } from '../types'

export function useParticipation(
  activityType: Participation['activity_type'],
  activityId: string,
  activityDate?: string,
) {
  const { user } = useAuth()

  const { data: participations, refetch } = usePB<Participation>('participations', {
    filter: user && activityId
      ? `member="${user.id}" && activity_type="${activityType}" && activity_id="${activityId}"`
      : '',
    perPage: 1,
    enabled: !!user && !!activityId,
  })

  const { data: absences } = usePB<Absence>('absences', {
    filter: user && activityDate
      ? `member="${user.id}" && start_date<="${activityDate}" && end_date>="${activityDate}"`
      : '',
    perPage: 1,
    enabled: !!user && !!activityDate,
  })

  const { create, update, remove } = useMutation<Participation>('participations')

  const participation = participations[0] ?? null
  const hasAbsence = absences.length > 0

  const setStatus = useCallback(async (status: Participation['status'], note = '') => {
    if (!user) return
    if (participation) {
      await update(participation.id, { status, note })
    } else {
      await create({
        member: user.id,
        activity_type: activityType,
        activity_id: activityId,
        status,
        note,
      })
    }
    refetch()
  }, [user, participation, activityType, activityId, create, update, refetch])

  const clearStatus = useCallback(async () => {
    if (participation) {
      await remove(participation.id)
      refetch()
    }
  }, [participation, remove, refetch])

  return {
    participation,
    hasAbsence,
    effectiveStatus: hasAbsence ? 'absent' as const : participation?.status ?? null,
    setStatus,
    clearStatus,
    refetch,
  }
}

export function useTeamParticipations(
  activityType: Participation['activity_type'],
  activityId: string,
  memberIds: string[],
) {
  const memberFilter = memberIds.length > 0
    ? memberIds.map((id) => `member="${id}"`).join(' || ')
    : 'member=""'

  const { data, refetch, isLoading } = usePB<Participation>('participations', {
    filter: activityId
      ? `(${memberFilter}) && activity_type="${activityType}" && activity_id="${activityId}"`
      : '',
    perPage: 200,
    enabled: !!activityId && memberIds.length > 0,
  })

  return { participations: data, refetch, isLoading }
}
