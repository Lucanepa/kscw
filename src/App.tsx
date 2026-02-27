import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './hooks/useAuth'
import { ThemeProvider } from './hooks/useTheme'
import Layout from './components/Layout'
import AdminRoute from './components/AdminRoute'
import GamesPage from './modules/games/GamesPage'
import SpielplanungPage from './modules/spielplanung/SpielplanungPage'
import TrainingsPage from './modules/trainings/TrainingsPage'
import AbsencesPage from './modules/absences/AbsencesPage'
import ScorerPage from './modules/scorer/ScorerPage'
import CalendarPage from './modules/calendar/CalendarPage'
import TeamsPage from './modules/teams/TeamsPage'
import TeamDetail from './modules/teams/TeamDetail'
import PlayerProfile from './modules/teams/PlayerProfile'
import RosterEditor from './modules/teams/RosterEditor'
import EmbedGamesPage from './modules/games/EmbedGamesPage'

export default function App() {
  return (
    <ThemeProvider>
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          {/* Embed routes — no layout wrapper */}
          <Route path="embed/games" element={<EmbedGamesPage />} />

          <Route element={<Layout />}>
            <Route index element={<CalendarPage />} />
            <Route path="games" element={<GamesPage />} />
            <Route path="trainings" element={<TrainingsPage />} />
            <Route path="absences" element={<AbsencesPage />} />
            <Route path="scorer" element={<ScorerPage />} />
            <Route path="teams" element={<TeamsPage />} />
            <Route path="teams/:teamId" element={<TeamDetail />} />
            <Route path="teams/:teamId/roster/edit" element={<RosterEditor />} />
            <Route path="teams/player/:memberId" element={<PlayerProfile />} />
            <Route path="admin/spielplanung" element={<AdminRoute><SpielplanungPage /></AdminRoute>} />
            {/* Redirect old calendar route */}
            <Route path="calendar" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
    </ThemeProvider>
  )
}
