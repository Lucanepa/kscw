import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Toaster } from 'sonner'
import { QueryProvider } from './lib/QueryProvider'
import { AuthProvider } from './hooks/AuthProvider'
import { ThemeProvider } from './hooks/ThemeProvider'
import { AdminModeProvider } from './hooks/AdminModeProvider'
import { ConfirmProvider } from './components/ConfirmDialogProvider'
import { PageReadyProvider } from './hooks/PageReadyProvider'
import BootOverlay from './components/BootOverlay'
import { TourProvider } from './modules/guide/TourProvider'
import { SentryErrorBoundary } from './lib/sentry'
import { reloadNow } from './lib/chunkReload'
import SchedulingLayout from './components/SchedulingLayout'
import AdminOrSpielplanerRoute from './components/AdminOrSpielplanerRoute'
import AdminRoute from './components/AdminRoute'
import MailboxRoute from './components/MailboxRoute'
import BasketballAdminRoute from './components/BasketballAdminRoute'
import SpielplanerOrAdminRoute from './components/SpielplanerOrAdminRoute'
// Auth pages — pre-SSO, admins still log in on this origin until cookie-session
// SSO (Phase 2) shares the member-app login across the .kscw.ch subdomains.
import LoginPage from './modules/auth/LoginPage'
import PendingPage from './modules/auth/PendingPage'
import SetPasswordPage from './modules/auth/SetPasswordPage'
// Scheduling pages
import PublicTerminplanungPage from './modules/gameScheduling/pages/PublicTerminplanungPage'
import OpponentFlowPage from './modules/gameScheduling/pages/OpponentFlowPage'
import ClubFlowPage from './modules/gameScheduling/pages/ClubFlowPage'
import BasketballClubFlowPage from './modules/gameScheduling/pages/BasketballClubFlowPage'
import AdminSetupPage from './modules/gameScheduling/pages/AdminSetupPage'
import AdminDashboardPage from './modules/gameScheduling/pages/AdminDashboardPage'
import MailboxPage from './modules/gameScheduling/pages/MailboxPage'
import BasketballPrepPage from './modules/gameScheduling/pages/BasketballPrepPage'
import BasketballCalendarPage from './modules/gameScheduling/pages/BasketballCalendarPage'
import BasketballSettingsPage from './modules/gameScheduling/pages/BasketballSettingsPage'
import SpielplanungPage from './modules/spielplanung/SpielplanungPage'
import ClosuresPage from './modules/hallenplan/ClosuresPage'
import HallsPage from './modules/hallenplan/HallsPage'
import SchedulingHome from './modules/gameScheduling/pages/SchedulingHome'

function SchedulingFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
      <div className="space-y-4 p-8 text-center">
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

/**
 * Standalone root for the Spielplanung subdomain (spielplanung.wiedisync.kscw.ch).
 * Same provider stack as the member `App`, but a scheduling-only route tree and
 * a minimal shell (no member navigation). Built via `VITE_APP_TARGET=scheduling`.
 */
export default function SchedulingApp() {
  useEffect(() => {
    document.title = 'Spielplanung — KSC Wiedikon'
  }, [])

  return (
    <SentryErrorBoundary fallback={() => <SchedulingFallback />}>
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
                      {/* Public opponent flow — bare, no shell (as on the member app) */}
                      <Route path="terminplanung" element={<PublicTerminplanungPage />} />
                      {/* Per-club portal (2027/28+): ONE link covering all the club's
                          teams. Static `club` segment outranks the dynamic :token, and
                          tokens are 32-hex so they never collide with the literal. */}
                      <Route path="terminplanung/club/:token" element={<ClubFlowPage />} />
                      {/* Basketball per-club portal. The invite mail embeds
                          /terminplanung/bb/<token>, which is TWO segments — the
                          dynamic `terminplanung/:token` below matches exactly one,
                          so without this route a pasted link fell through to the
                          catch-all. Static `bb` outranks the dynamic segment and
                          32-hex tokens never collide with the literal. */}
                      <Route path="terminplanung/bb/:token" element={<BasketballClubFlowPage />} />
                      <Route path="terminplanung/:token" element={<OpponentFlowPage />} />

                      {/* Auth (pre-SSO login on this origin) */}
                      <Route path="login" element={<LoginPage />} />
                      <Route path="pending" element={<PendingPage />} />
                      <Route path="set-password" element={<SetPasswordPage />} />

                      {/* `/` dispatches by access; bare so unauth bounces to /login
                          without flashing the shell (and no guard→/ redirect loop). */}
                      <Route index element={<SchedulingHome />} />

                      {/* Admin scheduling — minimal shell. The dashboard is the
                          section landing page; setup lives under /settings. */}
                      <Route element={<SchedulingLayout />}>
                        {/* Volleyball dashboard now lives under /volleyball; the bare
                            section root + the old /dashboard both redirect to it. */}
                        <Route
                          path="admin/terminplanung"
                          element={<Navigate to="/admin/terminplanung/volleyball" replace />}
                        />
                        <Route
                          path="admin/terminplanung/volleyball"
                          element={<AdminOrSpielplanerRoute><AdminDashboardPage /></AdminOrSpielplanerRoute>}
                        />
                        <Route
                          path="admin/terminplanung/settings"
                          element={<AdminOrSpielplanerRoute><AdminSetupPage /></AdminOrSpielplanerRoute>}
                        />
                        {/* Hall closures — same page the member app mounts at
                            /admin/hallenplan/closures; reached from the settings page. */}
                        <Route
                          path="admin/terminplanung/closures"
                          element={<AdminRoute><ClosuresPage /></AdminRoute>}
                        />
                        {/* Hall register — same page the member app mounts at
                            /admin/hallenplan/halls. */}
                        <Route
                          path="admin/terminplanung/halls"
                          element={<AdminRoute><HallsPage /></AdminRoute>}
                        />
                        {/* Mailbox tab — Volleyball/Basketball toggle inside (per-sport gating in the page). */}
                        <Route
                          path="admin/terminplanung/mailbox"
                          element={<MailboxRoute><MailboxPage /></MailboxRoute>}
                        />
                        {/* Basketball section — dashboard / planner / calendar / settings / mailbox. */}
                        <Route
                          path="admin/terminplanung/basketball"
                          element={<BasketballAdminRoute><BasketballPrepPage /></BasketballAdminRoute>}
                        />
                        {/* Same component as volleyball's dashboard, dispatched on sport —
                            one page, two bodies. See AdminDashboardPage. */}
                        <Route
                          path="admin/terminplanung/basketball/dashboard"
                          element={<BasketballAdminRoute><AdminDashboardPage sport="basketball" /></BasketballAdminRoute>}
                        />
                        <Route
                          path="admin/terminplanung/basketball/calendar"
                          element={<BasketballAdminRoute><BasketballCalendarPage /></BasketballAdminRoute>}
                        />
                        <Route
                          path="admin/terminplanung/basketball/settings"
                          element={<BasketballAdminRoute><BasketballSettingsPage /></BasketballAdminRoute>}
                        />
                        <Route
                          path="admin/terminplanung/basketball/mailbox"
                          element={<MailboxRoute><MailboxPage /></MailboxRoute>}
                        />
                        {/* Back-compat: the old dashboard URL now lives under /volleyball. */}
                        <Route
                          path="admin/terminplanung/dashboard"
                          element={<Navigate to="/admin/terminplanung/volleyball" replace />}
                        />
                        <Route
                          path="admin/spielplanung"
                          element={<SpielplanerOrAdminRoute><SpielplanungPage /></SpielplanerOrAdminRoute>}
                        />
                      </Route>

                      <Route path="*" element={<Navigate to="/" replace />} />
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
