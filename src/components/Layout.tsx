import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useTheme } from '../hooks/useTheme'
import { useIsDesktop } from '../hooks/useMediaQuery'
import BottomTabBar from './BottomTabBar'
import MoreSheet from './MoreSheet'

const navItems = [
  { to: '/', label: 'Kalender', icon: '📅' },
  { to: '/games', label: 'Spiele & Resultate', icon: '🏆' },
  { to: '/trainings', label: 'Trainings', icon: '🎯' },
  { to: '/absences', label: 'Absenzen', icon: '👤' },
  { to: '/scorer', label: 'Schreibereinsätze', icon: '📝' },
  { to: '/teams', label: 'Teams', icon: '👥' },
]

const adminItems = [
  { to: '/admin/spielplanung', label: 'Spielplanung', icon: '📋' },
]

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const { user, isAdmin, logout } = useAuth()
  const { theme, toggleTheme } = useTheme()
  const isDesktop = useIsDesktop()

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-900">
      {/* Desktop: sidebar overlay for intermediate sizes */}
      {isDesktop && sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Desktop sidebar */}
      {isDesktop && (
        <aside
          className={`flex w-64 flex-col shadow-lg ${
            theme === 'light' ? 'bg-white' : 'bg-brand-900 dark:bg-brand-950'
          }`}
        >
          <div className={`flex h-16 items-center gap-3 border-b px-6 ${
            theme === 'light' ? 'border-gray-200' : 'border-brand-800'
          }`}>
            <img
              src={theme === 'light' ? '/kscw_blau.png' : '/kscw_weiss.png'}
              alt="KSCW"
              className="h-8 w-auto"
            />
          </div>

          <nav className="flex-1 overflow-y-auto p-4">
            <ul className="space-y-1">
              {navItems.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
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
              {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
            </button>

            {user ? (
              <div className="flex items-center justify-between">
                <span className={`truncate text-sm ${
                  theme === 'light' ? 'text-gray-600' : 'text-gray-400'
                }`}>
                  {user.name || user.email}
                </span>
                <button
                  onClick={logout}
                  className={`text-sm ${
                    theme === 'light'
                      ? 'text-gray-500 hover:text-gray-700'
                      : 'text-gray-400 hover:text-white'
                  }`}
                >
                  Logout
                </button>
              </div>
            ) : (
              <NavLink
                to="/login"
                className={`block text-center text-sm ${
                  theme === 'light'
                    ? 'text-brand-600 hover:text-brand-800'
                    : 'text-gold-400 hover:text-gold-300'
                }`}
              >
                Anmelden
              </NavLink>
            )}
          </div>
        </aside>
      )}

      {/* Main content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Desktop header */}
        {isDesktop && (
          <header className="flex h-16 items-center gap-4 border-b bg-white px-8 dark:border-gray-700 dark:bg-gray-800" />
        )}

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
