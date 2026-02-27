import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'

export default function CoachRoute({ children }: { children: ReactNode }) {
  const { isCoach, isLoading } = useAuth()

  if (isLoading) return null
  if (!isCoach) return <Navigate to="/" replace />

  return <>{children}</>
}
