import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider } from './hooks/useAuth'
import { ThemeProvider } from './hooks/useTheme'
import Layout from './components/Layout'
import AdminRoute from './components/AdminRoute'
import SuperAdminRoute from './components/SuperAdminRoute'
import GamesPage from './modules/games/GamesPage'
import SpielplanungPage from './modules/spielplanung/SpielplanungPage'
import TrainingsPage from './modules/trainings/TrainingsPage'
import AbsencesPage from './modules/absences/AbsencesPage'
import ScorerPage from './modules/scorer/ScorerPage'
import CalendarPage from './modules/calendar/CalendarPage'
import HomePage from './modules/home/HomePage'
import TeamsPage from './modules/teams/TeamsPage'
import TeamDetail from './modules/teams/TeamDetail'
import PlayerProfile from './modules/teams/PlayerProfile'
import RosterEditor from './modules/teams/RosterEditor'
import DatabasePage from './modules/admin/DatabasePage'
import EmbedGamesPage from './modules/games/EmbedGamesPage'
import LoginPage from './modules/auth/LoginPage'
import SignUpPage from './modules/auth/SignUpPage'
import ProfilePage from './modules/auth/ProfilePage'
import EventsPage from './modules/events/EventsPage'
import DatenschutzPage from './modules/legal/DatenschutzPage'
import ImpressumPage from './modules/legal/ImpressumPage'
import AuthRoute from './components/AuthRoute'

export default function App() {
  return (
    <ThemeProvider>
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          {/* Standalone routes — no layout wrapper */}
          <Route path="embed/games" element={<EmbedGamesPage />} />
          <Route path="login" element={<LoginPage />} />
          <Route path="signup" element={<SignUpPage />} />

          <Route element={<Layout />}>
            <Route index element={<HomePage />} />
            <Route path="calendar" element={<CalendarPage />} />
            <Route path="games" element={<GamesPage />} />
            <Route path="trainings" element={<AuthRoute><TrainingsPage /></AuthRoute>} />
            <Route path="absences" element={<AuthRoute><AbsencesPage /></AuthRoute>} />
            <Route path="scorer" element={<AuthRoute><ScorerPage /></AuthRoute>} />
            <Route path="teams" element={<TeamsPage />} />
            <Route path="teams/:teamId" element={<TeamDetail />} />
            <Route path="teams/:teamId/roster/edit" element={<AuthRoute><RosterEditor /></AuthRoute>} />
            <Route path="teams/player/:memberId" element={<PlayerProfile />} />
            <Route path="events" element={<EventsPage />} />
            <Route path="datenschutz" element={<DatenschutzPage />} />
            <Route path="impressum" element={<ImpressumPage />} />
            <Route path="profile" element={<AuthRoute><ProfilePage /></AuthRoute>} />
            <Route path="admin/spielplanung" element={<AdminRoute><SpielplanungPage /></AdminRoute>} />
            <Route path="admin/database" element={<SuperAdminRoute><DatabasePage /></SuperAdminRoute>} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
    </ThemeProvider>
  )
}
