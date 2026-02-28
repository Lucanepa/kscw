import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'

export default function AuthRoute({ children }: { children: ReactNode }) {
  const { user, isApproved, isLoading } = useAuth()

  if (isLoading) return null
  if (!user) return <Navigate to="/login" replace />
  if (!isApproved) return <Navigate to="/pending" replace />

  return <>{children}</>
}
