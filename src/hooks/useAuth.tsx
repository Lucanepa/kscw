import { createContext, useContext, useEffect, useState, useCallback, useMemo, type ReactNode } from 'react'
import type { RecordModel } from 'pocketbase'
import pb from '../pb'
import type { Member, MemberTeam } from '../types'

interface MyTeamRole {
  teamId: string
  role: MemberTeam['role']
}

interface AuthContextValue {
  user: (RecordModel & Member) | null
  isSuperAdmin: boolean
  isAdmin: boolean
  isApproved: boolean
  isCoach: boolean
  isCoachOf: (teamId: string) => boolean
  coachTeamIds: string[]
  myTeamRoles: MyTeamRole[]
  isVorstand: boolean
  isLoading: boolean
  login: (email: string, password: string) => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<(RecordModel & Member) | null>(
    pb.authStore.record as (RecordModel & Member) | null,
  )
  const [isLoading, setIsLoading] = useState(true)
  const [myTeamRoles, setMyTeamRoles] = useState<MyTeamRole[]>([])

  // Auth refresh
  useEffect(() => {
    if (pb.authStore.isValid) {
      pb.collection('members').authRefresh()
        .catch(() => pb.authStore.clear())
        .finally(() => setIsLoading(false))
    } else {
      setIsLoading(false)
    }

    const unsubscribe = pb.authStore.onChange((_token, record) => {
      setUser(record as (RecordModel & Member) | null)
    })

    return unsubscribe
  }, [])

  // Fetch user's team roles from member_teams
  useEffect(() => {
    if (!user?.id) {
      setMyTeamRoles([])
      return
    }

    pb.collection('member_teams')
      .getFullList<MemberTeam>({ filter: `member="${user.id}"` })
      .then((records) => {
        setMyTeamRoles(records.map((r) => ({ teamId: r.team, role: r.role })))
      })
      .catch(() => setMyTeamRoles([]))
  }, [user?.id])

  const login = useCallback(async (email: string, password: string) => {
    await pb.collection('members').authWithPassword(email, password)
  }, [])

  const logout = useCallback(() => {
    pb.authStore.clear()
  }, [])

  const roles = user?.role ?? []
  const isSuperAdmin = roles.includes('superadmin')
  const isAdmin = roles.includes('admin') || isSuperAdmin
  const isApproved = user?.approved !== false
  const isVorstand = roles.includes('vorstand') || isAdmin

  // Team-scoped coach: derived from member_teams, not members.role
  const coachTeamIds = useMemo(
    () => myTeamRoles
      .filter((r) => r.role === 'coach' || r.role === 'assistant' || r.role === 'team_responsible')
      .map((r) => r.teamId),
    [myTeamRoles],
  )

  const isCoach = coachTeamIds.length > 0 || isAdmin

  const isCoachOf = useCallback(
    (teamId: string) => isAdmin || coachTeamIds.includes(teamId),
    [isAdmin, coachTeamIds],
  )

  return (
    <AuthContext.Provider value={{ user, isSuperAdmin, isAdmin, isApproved, isCoach, isCoachOf, coachTeamIds, myTeamRoles, isVorstand, isLoading, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
