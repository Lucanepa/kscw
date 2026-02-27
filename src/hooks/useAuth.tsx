import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import type { RecordModel } from 'pocketbase'
import pb from '../pb'
import type { Member } from '../types'

interface AuthContextValue {
  user: (RecordModel & Member) | null
  isAdmin: boolean
  isCoach: boolean
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

  useEffect(() => {
    setIsLoading(false)

    const unsubscribe = pb.authStore.onChange((_token, record) => {
      setUser(record as (RecordModel & Member) | null)
    })

    return unsubscribe
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    await pb.collection('members').authWithPassword(email, password)
  }, [])

  const logout = useCallback(() => {
    pb.authStore.clear()
  }, [])

  const isAdmin = user?.role === 'admin'
  const isCoach = user?.role === 'coach' || isAdmin

  return (
    <AuthContext.Provider value={{ user, isAdmin, isCoach, isLoading, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
