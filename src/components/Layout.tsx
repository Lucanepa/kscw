import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../hooks/useAuth'
import { useTheme } from '../hooks/useTheme'
import { useIsDesktop } from '../hooks/useMediaQuery'
import { getFileUrl } from '../utils/pbFile'
import BottomTabBar from './BottomTabBar'
import MoreSheet from './MoreSheet'

function useNavItems() {
  const { t } = useTranslation('nav')
  return {
    navItems: [
      { to: '/', label: t('calendar'), icon: '📅' },
      { to: '/games', label: t('games'), icon: '🏆' },
      { to: '/trainings', label: t('trainings'), icon: '🎯' },
      { to: '/absences', label: t('absences'), icon: '👤' },
      { to: '/scorer', label: t('scorer'), icon: '📝' },
      { to: '/events', label: t('events'), icon: '🎉' },
      { to: '/teams', label: t('teams'), icon: '👥' },
    ],
    adminItems: [
      { to: '/admin/spielplanung', label: t('gameplan'), icon: '📋' },
    ],
  }
}

export default function Layout() {
  const [sidebarExpanded, setSidebarExpanded] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const { user, isAdmin, logout } = useAuth()
  const { theme, toggleTheme } = useTheme()
  const { t } = useTranslation('nav')
  const isDesktop = useIsDesktop()
  const { navItems, adminItems } = useNavItems()

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-900">
      {/* Backdrop overlay when sidebar is expanded */}
      {isDesktop && sidebarExpanded && (
        <div
          className="fixed inset-0 z-30 bg-black/30"
          onClick={() => setSidebarExpanded(false)}
        />
      )}

      {/* Desktop sidebar */}
      {isDesktop && (
        <>
          {/* Collapsed rail — always visible */}
          <div
            className={`flex w-16 shrink-0 flex-col items-center py-4 shadow-lg ${
              theme === 'light' ? 'bg-white' : 'bg-brand-900 dark:bg-brand-950'
            }`}
          >
            <button
              onClick={() => setSidebarExpanded(true)}
              className="rounded-lg p-1.5 transition-colors hover:bg-gray-100 dark:hover:bg-brand-800"
            >
              <img
                src={theme === 'light' ? '/kscw_blau.png' : '/kscw_weiss.png'}
                alt="KSCW"
                className="h-8 w-auto"
              />
            </button>
          </div>

          {/* Expanded sidebar — overlays on top */}
          <aside
            className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col shadow-lg transition-transform duration-200 ${
              sidebarExpanded ? 'translate-x-0' : '-translate-x-full'
            } ${theme === 'light' ? 'bg-white' : 'bg-brand-900 dark:bg-brand-950'}`}
          >
            <div className={`flex h-16 items-center gap-3 border-b px-6 ${
              theme === 'light' ? 'border-gray-200' : 'border-brand-800'
            }`}>
              <button
                onClick={() => setSidebarExpanded(false)}
                className="rounded-lg p-1.5 transition-colors hover:bg-gray-100 dark:hover:bg-brand-800"
              >
                <img
                  src={theme === 'light' ? '/kscw_blau.png' : '/kscw_weiss.png'}
                  alt="KSCW"
                  className="h-8 w-auto"
                />
              </button>
            </div>

            <nav className="flex-1 overflow-y-auto p-4">
              <ul className="space-y-1">
                {navItems.map((item) => (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      onClick={() => setSidebarExpanded(false)}
                      className={({ isActive }) =>
                        `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                          theme === 'light'
                            ? isActive
                              ? 'bg-brand-50 text-brand-700'
                              : 'text-gray-700 hover:bg-gray-100'
                            : isActive
                              ? 'border-l-2 border-gold-400 bg-brand-800 text-gold-400'
                              : 'text-gray-300 hover:bg-brand-800 hover:text-white'
                        }`
                      }
                      end={item.to === '/'}
                    >
                      <span>{item.icon}</span>
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>

              {isAdmin && (
                <>
                  <div className={`my-3 border-t ${
                    theme === 'light' ? 'border-gray-200' : 'border-brand-800'
                  }`} />
                  <p className={`mb-1 px-3 text-xs font-semibold uppercase tracking-wider ${
                    theme === 'light' ? 'text-gray-400' : 'text-gray-500'
                  }`}>
                    Admin
                  </p>
                  <ul className="space-y-1">
                    {adminItems.map((item) => (
                      <li key={item.to}>
                        <NavLink
                          to={item.to}
                          onClick={() => setSidebarExpanded(false)}
                          className={({ isActive }) =>
                            `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                              theme === 'light'
                                ? isActive
                                  ? 'bg-brand-50 text-brand-700'
                                  : 'text-gray-700 hover:bg-gray-100'
                                : isActive
                                  ? 'border-l-2 border-gold-400 bg-brand-800 text-gold-400'
                                  : 'text-gray-300 hover:bg-brand-800 hover:text-white'
                            }`
                          }
                        >
                          <span>{item.icon}</span>
                          {item.label}
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </nav>

            <div className={`border-t p-4 ${
              theme === 'light' ? 'border-gray-200' : 'border-brand-800'
            }`}>
              <button
                onClick={toggleTheme}
                className={`mb-3 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${
                  theme === 'light'
                    ? 'text-gray-600 hover:bg-gray-100'
                    : 'text-gray-400 hover:bg-brand-800 hover:text-white'
                }`}
              >
                {theme === 'dark' ? (
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                  </svg>
                ) : (
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                  </svg>
                )}
                {theme === 'dark' ? t('lightMode') : t('darkMode')}
              </button>

              {user ? (
                <div className="space-y-2">
                  <NavLink
                    to="/profile"
                    onClick={() => setSidebarExpanded(false)}
                    className={({ isActive }) =>
                      `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                        theme === 'light'
                          ? isActive
                            ? 'bg-brand-50 text-brand-700'
                            : 'text-gray-700 hover:bg-gray-100'
                          : isActive
                            ? 'bg-brand-800 text-gold-400'
                            : 'text-gray-300 hover:bg-brand-800 hover:text-white'
                      }`
                    }
                  >
                    {user.photo ? (
                      <img
                        src={getFileUrl('members', user.id, user.photo)}
                        alt=""
                        className="h-7 w-7 rounded-full object-cover"
                      />
                    ) : (
                      <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                        theme === 'light'
                          ? 'bg-gray-200 text-gray-500'
                          : 'bg-brand-800 text-gray-400'
                      }`}>
                        {`${user.first_name?.[0] ?? ''}${user.last_name?.[0] ?? ''}`.toUpperCase()}
                      </div>
                    )}
                    <span className="truncate">{user.name || user.email}</span>
                  </NavLink>
                  <button
                    onClick={logout}
                    className={`w-full rounded-lg px-3 py-1.5 text-left text-sm ${
                      theme === 'light'
                        ? 'text-gray-500 hover:bg-gray-100 hover:text-gray-700'
                        : 'text-gray-400 hover:bg-brand-800 hover:text-white'
                    }`}
                  >
                    {t('logout')}
                  </button>
                </div>
              ) : (
                <NavLink
                  to="/login"
                  onClick={() => setSidebarExpanded(false)}
                  className={`block text-center text-sm ${
                    theme === 'light'
                      ? 'text-brand-600 hover:text-brand-800'
                      : 'text-gold-400 hover:text-gold-300'
                  }`}
                >
                  {t('signIn')}
                </NavLink>
              )}
            </div>
          </aside>
        </>
      )}

      {/* Main content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <main className={`flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 ${
          !isDesktop ? 'pb-24' : ''
        }`}>
          <Outlet />
        </main>
      </div>

      {/* Mobile bottom tab bar */}
      {!isDesktop && (
        <BottomTabBar
          onMoreTap={() => setMoreOpen(true)}
          moreActive={moreOpen}
        />
      )}

      {/* More sheet */}
      {moreOpen && <MoreSheet onClose={() => setMoreOpen(false)} />}
    </div>
  )
}
