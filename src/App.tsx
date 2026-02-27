import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider } from './hooks/useAuth'
import Layout from './components/Layout'
import HallenplanPage from './modules/hallenplan/HallenplanPage'
import GamesPage from './modules/games/GamesPage'
import SpielplanungPage from './modules/spielplanung/SpielplanungPage'
import TrainingsPage from './modules/trainings/TrainingsPage'
import AbsencesPage from './modules/absences/AbsencesPage'
import ScorerPage from './modules/scorer/ScorerPage'
import CalendarPage from './modules/calendar/CalendarPage'
import TeamsPage from './modules/teams/TeamsPage'

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<HallenplanPage />} />
            <Route path="games" element={<GamesPage />} />
            <Route path="spielplanung" element={<SpielplanungPage />} />
            <Route path="trainings" element={<TrainingsPage />} />
            <Route path="absences" element={<AbsencesPage />} />
            <Route path="scorer" element={<ScorerPage />} />
            <Route path="calendar" element={<CalendarPage />} />
            <Route path="teams" element={<TeamsPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
