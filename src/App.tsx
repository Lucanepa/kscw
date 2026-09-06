import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { SCHEDULING_ORIGIN } from './lib/api'
import { Toaster } from 'sonner'
import { QueryProvider } from './lib/QueryProvider'
import { AuthProvider } from './hooks/AuthProvider'
import { ThemeProvider } from './hooks/ThemeProvider'
import { AdminModeProvider } from './hooks/AdminModeProvider'
import { ConfirmProvider } from './components/ConfirmDialogProvider'
import { PageReadyProvider } from './hooks/PageReadyProvider'
import { TourProvider } from './modules/guide/TourProvider'
import Layout from './components/Layout'
import { NotificationsProvider } from './components/NotificationsStoreProvider'
import BootOverlay from './components/BootOverlay'
import AdminRoute from './components/AdminRoute'
import GlobalAdminRoute from './components/GlobalAdminRoute'
import SuperAdminRoute from './components/SuperAdminRoute'
import GamesPage from './modules/games/GamesPage'
import LivePage from './modules/live/LivePage'
import TrainingsPage from './modules/trainings/TrainingsPage'
import AbsencesPage from './modules/absences/AbsencesPage'
import ScorerPage from './modules/scorer/ScorerPage'
import CalendarPage from './modules/calendar/CalendarPage'
import HomePage from './modules/home/HomePage'
import TeamsPage from './modules/teams/TeamsPage'
import TeamDetail from './modules/teams/TeamDetail'
import PlayerProfile from './modules/teams/PlayerProfile'
import RosterEditor from './modules/teams/RosterEditor'
import InfraHealthPage from './modules/admin/InfraHealthPage'
import DataHealthPage from './modules/admin/DataHealthPage'
import TransfersPage from './modules/admin/TransfersPage'
import AuditLogPage from './modules/admin/AuditLogPage'
import HouseholdsPage from './modules/admin/HouseholdsPage'
import RefereeExpensesPage from './modules/admin/RefereeExpensesPage'
import ClubStatsPage from './modules/admin/ClubStatsPage'
import AdminHubPage from './modules/admin/AdminHubPage'
import VolleyFeedbackPage from './modules/admin/VolleyFeedbackPage'
import AnmeldungenPage from './modules/admin/AnmeldungenPage'
import EmailTemplatesPage from './modules/admin/EmailTemplatesPage'
import HallenplanPage from './modules/hallenplan/HallenplanPage'
import ClosuresPage from './modules/hallenplan/ClosuresPage'
import HallsPage from './modules/hallenplan/HallsPage'
import EmbedGamesPage from './modules/games/EmbedGamesPage'
import LoginPage from './modules/auth/LoginPage'
import SignUpPage from './modules/auth/SignUpPage'
import PendingPage from './modules/auth/PendingPage'
import ProfilePage from './modules/auth/ProfilePage'
import ProfileEditPage from './modules/auth/ProfileEditPage'
import EventsPage from './modules/events/EventsPage'
import FormsPage from './modules/forms/FormsPage'
import FormBuilderPage from './modules/forms/FormBuilderPage'
import PublicFormPage from './modules/forms/PublicFormPage'
import PublicEventSignupPage from './modules/events/PublicEventSignupPage'
import FinesPage from './modules/fines/FinesPage'
import FinancePage from './modules/finance/FinancePage'
import FinanceDuesPage from './modules/finance/FinanceDuesPage'
import ExpenseUploadPage from './modules/finance/ExpenseUploadPage'
import DatenschutzPage from './modules/legal/DatenschutzPage'
import ImpressumPage from './modules/legal/ImpressumPage'
import AuthRoute from './components/AuthRoute'
import FinanceRoute from './components/FinanceRoute'
import TkRoute from './components/TkRoute'
const TkExpensesPage = lazy(() => import('./modules/finance/TkExpensesPage'))
import ScorerAssignPage from './modules/scorer/ScorerAssignPage'
import VolleyRefereesPage from './modules/admin/VolleyRefereesPage'
import BugfixDashboardPage from './modules/admin/BugfixDashboardPage'
import StatusPage from './modules/admin/StatusPage'
import ExplorePage from './modules/admin/ExplorePage'
import SqlWorkspacePage from './modules/admin/SqlWorkspacePage'
import ErrorLogsPage from './modules/admin/ErrorLogsPage'
const AnimatedUIPage = lazy(() => import('./modules/admin/AnimatedUIPage'))
import AnnouncementsPage from './modules/admin/AnnouncementsPage'
import NewsArchivePage from './modules/news/NewsArchivePage'

import JoinPage from './modules/auth/JoinPage'
import SetPasswordPage from './modules/auth/SetPasswordPage'
import FeedbackPage from './modules/feedback/FeedbackPage'
import ChangelogPage from './modules/changelog/ChangelogPage'
import SupportPage from './modules/support/SupportPage'
import { SentryErrorBoundary } from './lib/sentry'
import { maybeReloadOnStaleChunk, reloadNow } from './lib/chunkReload'
import NotFoundPage from '@/modules/common/NotFoundPage'

const GuidePage = lazy(() => import('./modules/guide/GuidePage'))
const HallenfinderPage = lazy(() => import('./modules/hallenfinder/HallenfinderPage'))
const JsExportPage = lazy(() => import('./modules/jsexport/JsExportPage'))
const InboxPage = lazy(() => import('./modules/messaging/pages/InboxPage'))
const ConversationPage = lazy(() => import('./modules/messaging/pages/ConversationPage'))
const MessagingSettingsPage = lazy(() => import('./modules/messaging/pages/MessagingSettingsPage'))
const AdminReportsPage = lazy(() => import('./modules/admin/AdminReportsPage'))
const AdminMailboxPage = lazy(() => import('./modules/admin/AdminMailboxPage'))
const EmailsGaragePage = lazy(() => import('./modules/admin/EmailsGaragePage'))

// Stale lazy-import chunk recovery (deploy rotates hashed chunk names → a tab on
// an older bundle fails to import a now-missing chunk). Detection + one-time
// reload live in ./lib/chunkReload so the entry bootstrap (main.tsx) and these
// in-app handlers share one regex and one reload-loop cooldown.
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (event) => {
    if (maybeReloadOnStaleChunk(event.reason)) event.preventDefault()
  })
  window.addEventListener('error', (event) => {
    if (maybeReloadOnStaleChunk(event.error || event.message)) event.preventDefault()
  })
}

function SentryFallback({ error }: { error?: unknown } = {}) {
  if (typeof window !== 'undefined' && maybeReloadOnStaleChunk(error)) {
    return null
  }
  // Error boundary — cannot rely on i18n being loaded. Plain English + a
  // compact DE translation as bilingual fallback for the Swiss audience.
  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
      <div className="text-center space-y-4 p-8">
        <h1 className="text-2xl font-bold">Something went wrong</h1>
        <p className="text-muted-foreground">An unexpected error occurred. Etwas ist schiefgelaufen.</p>
        <button
          className="rounded-md bg-brand-600 px-4 py-2 text-white hover:bg-brand-700"
          onClick={() => reloadNow()}
        >
          Reload page
        </button>
      </div>
    </div>
  )
}

// Game scheduling moved to its own subdomain (SCHEDULING_ORIGIN). These old
// member-app routes redirect there — seamless via the shared .kscw.ch session
// cookie (SSO), and old opponent invite links keep working. On localhost / when
// SCHEDULING_ORIGIN is unset it equals the current origin → show a notice rather
// than loop.
function SchedulingRedirect() {
  if (typeof window !== 'undefined') {
    const base = SCHEDULING_ORIGIN.replace(/\/$/, '')
    if (base !== window.location.origin) {
      window.location.replace(base + window.location.pathname + window.location.search)
      return null
    }
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-8 text-center text-foreground">
      <p className="text-muted-foreground">Game scheduling has moved to its own app.</p>
    </div>
  )
}

export default function App() {
  return (
    <SentryErrorBoundary fallback={({ error }) => <SentryFallback error={error} />}>
    <QueryProvider>
    <ThemeProvider>
    <AuthProvider>
      <AdminModeProvider>
      <ConfirmProvider>
      <BrowserRouter>
      <TourProvider>
      <PageReadyProvider>
        <BootOverlay />
        <Routes>
          {/* Standalone routes — no layout wrapper */}
          <Route path="embed/games" element={<EmbedGamesPage />} />
          <Route path="login" element={<LoginPage />} />
          <Route path="signup" element={<SignUpPage />} />
          <Route path="pending" element={<PendingPage />} />

          <Route path="join/:token" element={<JoinPage />} />
          <Route path="set-password" element={<SetPasswordPage />} />
          <Route path="terminplanung" element={<SchedulingRedirect />} />
          {/* `terminplanung/:token` matches exactly ONE segment, so the two-segment
              club-portal links (volleyball `/club/<token>`, basketball `/bb/<token>`)
              need their own entries — this app has no catch-all, so an unmatched
              path renders a blank page instead of redirecting. SchedulingRedirect
              itself is untouched: it already forwards the full pathname.
              ⚠ The one-segment volleyball OPPONENT link must stay listed too: it is
              the live flow, and dropping it turned a pasted opponent link into a
              blank page instead of a redirect. */}
          <Route path="terminplanung/:token" element={<SchedulingRedirect />} />
          <Route path="terminplanung/club/:token" element={<SchedulingRedirect />} />
          <Route path="terminplanung/bb/:token" element={<SchedulingRedirect />} />
          {/* Safety net for any future scheduling link shape. The three explicit routes
              above stay exactly as they are — this only catches depths nobody has
              enumerated yet, which is how each of those came to be added in the first
              place. SchedulingRedirect forwards the whole pathname, so depth is
              irrelevant to it. Must precede the catch-all below, or a pasted opponent
              link would get the 404 page instead of the redirect it needs. */}
          <Route path="terminplanung/*" element={<SchedulingRedirect />} />
          <Route path="f/:slug" element={<PublicFormPage />} />
          {/* Guests' door — no AuthRoute by design. The token IS the
              authorisation; the page sends anyone with a session to /events/:id
              instead, because an external signup writes no participation row. */}
          <Route path="e/:token" element={<PublicEventSignupPage />} />

          {/* One notification store for the whole authenticated shell. Layout (the
              bell), HomePage (the news feed) and NewsArchivePage all read it, and
              HomePage renders inside Layout's Outlet — so calling the hook in each
              meant two concurrent fetches AND, the part users saw, two separate
              states: marking a news item read did not decrement the bell badge.
              Provided here rather than inside Layout because Layout consumes it. */}
          <Route element={<NotificationsProvider><Layout /></NotificationsProvider>}>
            <Route index element={<AuthRoute><HomePage /></AuthRoute>} />
            <Route path="calendar" element={<AuthRoute><CalendarPage /></AuthRoute>} />
            <Route path="games" element={<GamesPage />} />
            {/* Share links. Behind AuthRoute even for games, whose list is public:
                the detail modal carries the RSVP roster, so the link must not
                widen what an anonymous visitor can read. AuthRoute sends them
                through /login?next=… and back here. */}
            <Route path="games/:gameId" element={<AuthRoute><GamesPage /></AuthRoute>} />
            {/* Public spectator page — no AuthRoute. Most viewers in the hall are
                not logged in, and `live_scores` is granted to the Public policy. */}
            <Route path="live" element={<LivePage />} />
            <Route path="trainings" element={<AuthRoute><TrainingsPage /></AuthRoute>} />
            <Route path="trainings/:trainingId" element={<AuthRoute><TrainingsPage /></AuthRoute>} />
            <Route path="absences" element={<AuthRoute><AbsencesPage /></AuthRoute>} />
            <Route path="scorer" element={<AuthRoute><ScorerPage /></AuthRoute>} />
            <Route path="teams" element={<AuthRoute><TeamsPage /></AuthRoute>} />
            <Route path="teams/:teamSlug" element={<AuthRoute><TeamDetail /></AuthRoute>} />
            <Route path="teams/:teamSlug/roster/edit" element={<AuthRoute><RosterEditor /></AuthRoute>} />
            <Route path="teams/player/:memberId" element={<AuthRoute><PlayerProfile /></AuthRoute>} />
            <Route path="events" element={<AuthRoute><EventsPage /></AuthRoute>} />
            <Route path="events/:eventId" element={<AuthRoute><EventsPage /></AuthRoute>} />
            <Route path="forms" element={<AuthRoute><FormsPage /></AuthRoute>} />
            <Route path="js-export" element={<AuthRoute><Suspense fallback={null}><JsExportPage /></Suspense></AuthRoute>} />
            <Route path="forms/new" element={<AuthRoute><FormBuilderPage /></AuthRoute>} />
            <Route path="forms/:formId/edit" element={<AuthRoute><FormBuilderPage /></AuthRoute>} />
            <Route path="fines" element={<AuthRoute><FinesPage /></AuthRoute>} />
            <Route path="finance/dues" element={<AuthRoute><FinanceDuesPage /></AuthRoute>} />
            <Route path="finance/expense" element={<AuthRoute><ExpenseUploadPage /></AuthRoute>} />
            <Route path="finance/tk-expenses" element={<TkRoute><Suspense fallback={null}><TkExpensesPage /></Suspense></TkRoute>} />
            <Route path="datenschutz" element={<DatenschutzPage />} />
            <Route path="impressum" element={<ImpressumPage />} />
            <Route path="feedback" element={<FeedbackPage />} />
            <Route path="changelog" element={<ChangelogPage />} />
            <Route path="support" element={<AuthRoute><SupportPage /></AuthRoute>} />
            <Route path="guide" element={<AuthRoute><Suspense fallback={null}><GuidePage /></Suspense></AuthRoute>} />
            <Route path="profile" element={<AuthRoute><ProfilePage /></AuthRoute>} />
            <Route path="profile/edit" element={<AuthRoute><ProfileEditPage /></AuthRoute>} />
            <Route path="inbox" element={<AuthRoute><Suspense fallback={null}><InboxPage /></Suspense></AuthRoute>} />
            <Route path="inbox/:conversationId" element={<AuthRoute><Suspense fallback={null}><ConversationPage /></Suspense></AuthRoute>} />
            <Route path="options/messaging" element={<AuthRoute><Suspense fallback={null}><MessagingSettingsPage /></Suspense></AuthRoute>} />
            {/* Admin hub — every admin destination in one searchable table. AdminRoute
                (isAdmin) is the right gate: isGlobalAdmin ⊆ isAdmin, so anyone with
                a single admin entry passes it. */}
            <Route path="admin" element={<AdminRoute><AdminHubPage /></AdminRoute>} />
            <Route path="admin/spielplanung" element={<SchedulingRedirect />} />
            <Route path="admin/hallenplan" element={<AdminRoute><HallenplanPage /></AdminRoute>} />
            <Route path="admin/hallenplan/closures" element={<AdminRoute><ClosuresPage /></AdminRoute>} />
            <Route path="admin/hallenplan/halls" element={<AdminRoute><HallsPage /></AdminRoute>} />
            <Route path="admin/hallenfinder" element={<AuthRoute><Suspense fallback={null}><HallenfinderPage /></Suspense></AuthRoute>} />
            <Route path="admin/terminplanung" element={<SchedulingRedirect />} />
            <Route path="admin/terminplanung/settings" element={<SchedulingRedirect />} />
            <Route path="admin/terminplanung/dashboard" element={<SchedulingRedirect />} />
            <Route path="admin/scorer-assign" element={<AdminRoute><ScorerAssignPage /></AdminRoute>} />
            <Route path="admin/vb-referees" element={<AdminRoute><VolleyRefereesPage /></AdminRoute>} />
            <Route path="admin/referee-expenses" element={<AdminRoute><RefereeExpensesPage /></AdminRoute>} />
            <Route path="admin/finance" element={<FinanceRoute><FinancePage /></FinanceRoute>} />
            <Route path="admin/club-stats" element={<AdminRoute><ClubStatsPage /></AdminRoute>} />
            <Route path="admin/volley-feedback" element={<AdminRoute><VolleyFeedbackPage /></AdminRoute>} />
            <Route path="admin/anmeldungen" element={<AdminRoute><AnmeldungenPage /></AdminRoute>} />
            <Route path="admin/email-templates" element={<AdminRoute><EmailTemplatesPage /></AdminRoute>} />
            {/* Emails Garage — mailbox credential store. AdminRoute (isAdmin =
                admin | superuser | vb_admin | bb_admin) mirrors the server's READ
                gate; the endpoint additionally scopes rows by sport and refuses
                writes to anyone but a global admin. Widening one without the
                other shows links that bounce or 403s people on their own page. */}
            <Route path="admin/emails-garage" element={<AdminRoute><Suspense fallback={null}><EmailsGaragePage /></Suspense></AdminRoute>} />
            <Route path="admin/explore" element={<AdminRoute><ExplorePage /></AdminRoute>} />
            <Route path="admin/announcements" element={<AdminRoute><AnnouncementsPage /></AdminRoute>} />
            <Route path="admin/reports" element={<AdminRoute><Suspense fallback={null}><AdminReportsPage /></Suspense></AdminRoute>} />
            {/* Club mailbox. GlobalAdminRoute (admin || superuser) mirrors the
                server's authForAccount('admin') exactly — notably NOT vorstand,
                is_spielplaner, vb_admin or bb_admin, so neither AdminRoute nor
                VorstandRoute is correct here. Widen both sides together. */}
            <Route path="admin/mailbox" element={<GlobalAdminRoute><Suspense fallback={null}><AdminMailboxPage /></Suspense></GlobalAdminRoute>} />
            <Route path="news" element={<AuthRoute><NewsArchivePage /></AuthRoute>} />
            <Route path="admin/infra" element={<SuperAdminRoute><InfraHealthPage /></SuperAdminRoute>} />
            <Route path="admin/data-health" element={<SuperAdminRoute><DataHealthPage /></SuperAdminRoute>} />
            {/* International transfers. AdminRoute, NOT SuperAdminRoute like its
                neighbour: this is per-sport casework and the people who do it are
                the sport TK (vb_admin / bb_admin), whom SuperAdminRoute excludes.
                AdminRoute (admin | superuser | vb_admin | bb_admin) is also
                exactly the set that already holds `members` read+update with
                fields=* via KSCW Sport Admin, so the gate and the grant line up
                and nobody can reach a page whose toggles would 403. */}
            <Route path="admin/transfers" element={<AdminRoute><TransfersPage /></AdminRoute>} />
            {/* /admin/clubdesk-sync was merged into Data health on 2026-08-13 —
                the two pages were halves of one job (aggregate counts here,
                detail there). Kept as a redirect, not deleted: the old path is in
                bookmarks, in notification links and in the user guide PDFs.
                `replace` so Back doesn't bounce off it. */}
            <Route path="admin/clubdesk-sync" element={<Navigate to="/admin/data-health" replace />} />
            <Route path="admin/households" element={<SuperAdminRoute><HouseholdsPage /></SuperAdminRoute>} />
            <Route path="admin/audit-log" element={<SuperAdminRoute><AuditLogPage /></SuperAdminRoute>} />
            <Route path="admin/error-logs" element={<SuperAdminRoute><ErrorLogsPage /></SuperAdminRoute>} />
            <Route path="admin/sql" element={<SuperAdminRoute><SqlWorkspacePage /></SuperAdminRoute>} />
            <Route path="admin/animated-ui" element={<AdminRoute><Suspense fallback={null}><AnimatedUIPage /></Suspense></AdminRoute>} />
            <Route path="bugfixes" element={<SuperAdminRoute><BugfixDashboardPage /></SuperAdminRoute>} />
            <Route path="status" element={<AuthRoute><StatusPage /></AuthRoute>} />
            {/* Catch-all. Until this existed, an unmatched path rendered a literally
                BLANK page — which is why the terminplanung routes above had to be
                enumerated one by one, each after someone hit that blank screen. Inside
                <Layout> on purpose: the header and nav survive, so a mistyped URL is
                one click from recovery rather than a dead end.
                Last route in the tree — React Router ranks by specificity, but keeping
                it last makes the intent unmistakable to the next reader. */}
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </PageReadyProvider>
      </TourProvider>
      </BrowserRouter>
      <Toaster richColors position="top-center" />
      </ConfirmProvider>
      </AdminModeProvider>
    </AuthProvider>
    </ThemeProvider>
    </QueryProvider>
    </SentryErrorBoundary>
  )
}
