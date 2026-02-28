import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'

export default function SuperAdminRoute({ children }: { children: ReactNode }) {
  const { isSuperAdmin, isLoading } = useAuth()

  if (isLoading) return null
  if (!isSuperAdmin) return <Navigate to="/" replace />

  return <>{children}</>
}
