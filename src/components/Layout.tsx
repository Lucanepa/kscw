import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'

const navItems = [
  { to: '/', label: 'Hallenplan', icon: '🏟️' },
  { to: '/games', label: 'Spiele & Resultate', icon: '🏆' },
  { to: '/spielplanung', label: 'Spielplanung', icon: '📋' },
  { to: '/trainings', label: 'Trainings', icon: '🎯' },
  { to: '/absences', label: 'Absenzen', icon: '👤' },
  { to: '/scorer', label: 'Schreibereinsätze', icon: '📝' },
  { to: '/calendar', label: 'Kalender', icon: '📅' },
  { to: '/teams', label: 'Teams', icon: '👥' },
]

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const { user, logout } = useAuth()

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-30 flex w-64 flex-col bg-white shadow-lg transition-transform lg:static lg:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-16 items-center gap-3 border-b px-6">
          <span className="text-2xl">🏐</span>
          <span className="text-lg font-bold text-gray-900">KSCW</span>
        </div>

        <nav className="flex-1 overflow-y-auto p-4">
          <ul className="space-y-1">
            {navItems.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  onClick={() => setSidebarOpen(false)}
                  className={({ isActive }) =>
                    `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                      isActive
                        ? 'bg-blue-50 text-blue-700'
                        : 'text-gray-700 hover:bg-gray-100'
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
        </nav>

        <div className="border-t p-4">
          {user ? (
            <div className="flex items-center justify-between">
              <span className="truncate text-sm text-gray-600">{user.name || user.email}</span>
              <button
                onClick={logout}
                className="text-sm text-gray-500 hover:text-gray-700"
              >
                Logout
              </button>
            </div>
          ) : (
            <NavLink
              to="/login"
              className="block text-center text-sm text-blue-600 hover:text-blue-800"
            >
              Anmelden
            </NavLink>
          )}
        </div>
      </aside>

      {/* Main content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-16 items-center gap-4 border-b bg-white px-6 lg:px-8">
          <button
            onClick={() => setSidebarOpen(true)}
            className="text-gray-600 lg:hidden"
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        </header>

        <main className="flex-1 overflow-y-auto p-6 lg:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
