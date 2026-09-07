import { useCallback } from 'react'
import { useAuth } from './useAuth'
import { useAdminMode } from './useAdminMode'

/**
 * "May I manage this team?", answered the way the rest of the app means it.
 *
 * This exists because `useAuth().isCoachOfOrAdmin` is MODE-BLIND: it folds
 * `hasAdminAccessToTeam` in, so it reads like a coach check while silently
 * granting every sport admin — with the admin-mode toggle off. A 2026-09-07
 * audit found 15 live bypasses, 8 of them that one helper, including four
 * call sites that had already written `effectiveIsAdmin && …` as the second
 * half of an `||` where the leaky first half made it dead code.
 *
 * `canManageTeam` is the corrected idiom, in one place:
 *   - a coach or team responsible of the team: always (their own team, no
 *     toggle involved — `coachTeamIds` is coaches ∪ responsibles);
 *   - an admin for that team's sport: only while admin mode is ON.
 *
 * Prefer this over composing the two helpers by hand at each call site.
 */
export function useTeamPermissions() {
  const { coachTeamIds, hasAdminAccessToTeam } = useAuth()
  const { effectiveIsAdmin } = useAdminMode()

  const canManageTeam = useCallback(
    (teamId: string | null | undefined) => {
      const id = String(teamId ?? '')
      if (!id) return false
      return coachTeamIds.includes(id) || (effectiveIsAdmin && hasAdminAccessToTeam(id))
    },
    [coachTeamIds, effectiveIsAdmin, hasAdminAccessToTeam],
  )

  return { canManageTeam }
}
