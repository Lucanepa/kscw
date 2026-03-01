import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../hooks/useAuth'
import { useTheme } from '../../hooks/useTheme'
import ProfileEditModal from './ProfileEditModal'
import pb from '../../pb'
import type { Team } from '../../types'

export default function PendingPage() {
  const { user, isApproved, isProfileComplete, isLoading, logout } = useAuth()
  const { theme } = useTheme()
  const { t } = useTranslation('auth')
  const navigate = useNavigate()
  const [team, setTeam] = useState<Team | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  // If not logged in, go to login
  useEffect(() => {
    if (!isLoading && !user) navigate('/login', { replace: true })
  }, [user, isLoading, navigate])

  // If already approved, go home
  useEffect(() => {
    if (!isLoading && user && isApproved) navigate('/', { replace: true })
  }, [user, isApproved, isLoading, navigate])

  // Fetch the requested team name
  useEffect(() => {
    if (!user?.requested_team) return
    pb.collection('teams')
      .getOne<Team>(user.requested_team)
      .then(setTeam)
      .catch(() => setTeam(null))
  }, [user?.requested_team])

  async function handleRefresh() {
    setRefreshing(true)
    try {
      await pb.collection('members').authRefresh()
    } catch {
      // ignore
    } finally {
      setRefreshing(false)
    }
  }

  if (isLoading || !user) return null

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 dark:bg-gray-900">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <img
            src={theme === 'light' ? '/kscw_blau.png' : '/kscw_weiss.png'}
            alt="KSC Wiedikon"
            className="h-16 w-auto"
          />
        </div>

        <div className="rounded-xl bg-white p-6 shadow-lg sm:p-8 dark:bg-gray-800">
          {/* Hourglass icon */}
          <div className="mb-4 flex justify-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/30">
              <svg className="h-8 w-8 text-amber-600 dark:text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
          </div>

          <h1 className="mb-2 text-center text-xl font-bold text-gray-900 dark:text-gray-100">
            {t('pendingApproval')}
          </h1>

          <p className="mb-6 text-center text-sm text-gray-500 dark:text-gray-400">
            {t('pendingDescription')}
          </p>

          {/* User info */}
          <div className="mb-6 space-y-2 rounded-lg bg-gray-50 p-4 dark:bg-gray-700/50">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500 dark:text-gray-400">{t('firstName')}</span>
              <span className="font-medium text-gray-900 dark:text-gray-100">{user.first_name} {user.last_name}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500 dark:text-gray-400">{t('email')}</span>
              <span className="font-medium text-gray-900 dark:text-gray-100">{user.email}</span>
            </div>
            {team && (
              <div className="flex justify-between text-sm">
                <span className="text-gray-500 dark:text-gray-400">{t('requestedTeam')}</span>
                <span className="font-medium text-gray-900 dark:text-gray-100">{team.name}</span>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="space-y-3">
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="w-full rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
            >
              {refreshing ? t('checking') : t('refreshStatus')}
            </button>

            <button
              onClick={logout}
              className="w-full rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              {t('logout')}
            </button>
          </div>
        </div>
      </div>
      {/* Onboarding modal for unapproved users who haven't set language */}
      {user && !isProfileComplete && (
        <ProfileEditModal
          open
          onClose={() => {}}
          onboarding
        />
      )}
    </div>
  )
}
