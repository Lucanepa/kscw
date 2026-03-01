import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import type { RecordModel } from 'pocketbase'
import pb from '../pb'
import i18n from '../i18n'
import { pbLangToI18n } from '../utils/languageMap'
import type { Member, Team } from '../types'

interface AuthContextValue {
  user: (RecordModel & Member) | null
  isSuperAdmin: boolean
  isAdmin: boolean
  isApproved: boolean
  isProfileComplete: boolean
  isCoach: boolean
  isCoachOf: (teamId: string) => boolean
  coachTeamIds: string[]
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
  const [coachTeamIds, setCoachTeamIds] = useState<string[]>([])

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

  // Sync i18n language from user's stored preference
  useEffect(() => {
    if (user?.language) {
      const lang = pbLangToI18n(user.language)
      if (i18n.language !== lang) {
        i18n.changeLanguage(lang)
        localStorage.setItem('kscw-lang', lang)
      }
    }
  }, [user?.language])

  // Fetch teams where user has a leadership role (coach, team_responsible)
  useEffect(() => {
    if (!user?.id) {
      setCoachTeamIds([])
      return
    }

    const uid = user.id
    pb.collection('teams')
      .getFullList<Team>({
        filter: `active=true && (coach~"${uid}" || team_responsible~"${uid}")`,
      })
      .then((teams) => {
        setCoachTeamIds(teams.map((t) => t.id))
      })
      .catch(() => setCoachTeamIds([]))
  }, [user?.id])

  const login = useCallback(async (email: string, password: string) => {
    await pb.collection('members').authWithPassword(email, password)
  }, [])

  const logout = useCallback(() => {
    pb.authStore.clear()
  }, [])

  const roles = user?.role ?? []
  const isSuperAdmin = roles.includes('superuser')
  const isAdmin = roles.includes('admin') || isSuperAdmin
  const isApproved = user?.approved === true || isAdmin
  const isProfileComplete = !!user?.language
  const isVorstand = roles.includes('vorstand') || isAdmin

  const isCoach = coachTeamIds.length > 0 || isAdmin

  const isCoachOf = useCallback(
    (teamId: string) => isAdmin || coachTeamIds.includes(teamId),
    [isAdmin, coachTeamIds],
  )

  return (
    <AuthContext.Provider value={{ user, isSuperAdmin, isAdmin, isApproved, isProfileComplete, isCoach, isCoachOf, coachTeamIds, isVorstand, isLoading, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
