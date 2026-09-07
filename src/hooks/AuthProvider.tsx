/**
 * AuthProvider — the app-wide auth/team-context provider component.
 *
 * Split out of `hooks/useAuth.tsx` (which keeps the context + the `useAuth`
 * hook) so neither module exports both a React component and non-component
 * values — required by react-refresh/only-export-components (Fast Refresh).
 */

import { useEffect, useState, useCallback, useMemo, type ReactNode } from 'react'
import { readMe } from '@directus/sdk'
import { toast } from 'sonner'
import { client, login as apiLogin, logout as apiLogout, refreshAuth, isAuthenticated, setCurrentMemberId, setImpersonating, setActingMemberId, fetchItems, fetchAllItems, kscwApi } from '../lib/api'
import { clearDeviceKey, clearAllCachedDocuments } from '../lib/e2eeStore'
import { queryClient } from '../lib/query'
import { setSentryUser, captureAuthError, captureApiError, addBreadcrumb, clearBreadcrumbs, isTransientNetworkMessage } from '../lib/sentry'
import i18n from '../i18n'
import { backendLangToI18n } from '../utils/languageMap'
import { LICENCE_TYPES } from '../types'
import type { Member, Team, LicenceType } from '../types'
import { AuthContext, type AuthContextValue, type MemberUser, type HouseholdMember } from './useAuth'
import { bootstrapIdentityKey } from '../lib/identityBootstrap'

// ── Roles ───────────────────────────────────────────────────────────

/** Base roles carried on `members.role` — typed off the Member enum so a renamed
 *  role fails at compile time instead of silently never matching. */
type BaseRole = Member['role'][number]
const BASE_ROLES: readonly BaseRole[] = ['vorstand', 'admin', 'vb_admin', 'bb_admin', 'superuser', 'finance']
const isBaseRole = (r: string): r is BaseRole => (BASE_ROLES as readonly string[]).includes(r)
const isLicenceFlag = (r: string): r is LicenceType => (LICENCE_TYPES as readonly string[]).includes(r)

// Persists a read-only "View as" target across reloads (session-scoped).
const IMPERSONATE_KEY = 'wiedisync-impersonate'

// Remembers the last child a guardian used, per session owner. Keyed by the
// REAL member's id so a different login on a shared family phone never inherits
// the previous one's state.
//
// ⚠⚠ This is a HINT, never a restore. Cold start always boots as the guardian
// herself — see the init effect. Silently restoring a write-authority mode
// across a PWA relaunch is the worst mode error available here: a parent who
// opens the app days later and taps "going" would answer for whichever child
// she last used, with no signal that she had.
const ACTING_HINT_KEY = (realMemberId: string | number) => `wiedisync-acting-member:${realMemberId}`

// ── Provider ────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  // `realUser` is the actual logged-in member; `impersonatedMember` is set only
  // while a superadmin is viewing the app "as" someone else (read-only). The
  // whole app derives identity from `user` = the effective (impersonated ??
  // real) member, so every screen renders exactly what that member would see.
  const [realUser, setRealUser] = useState<MemberUser | null>(null)
  const [impersonatedMember, setImpersonatedMember] = useState<MemberUser | null>(null)
  // Household acting (migration 348): a guardian administering her children.
  // Mutually exclusive with impersonation — entering one clears the other, so
  // `user` never has to resolve a three-way precedence.
  const [householdMembers, setHouseholdMembers] = useState<HouseholdMember[]>([])
  const [actingMember, setActingMember] = useState<MemberUser | null>(null)
  const user = actingMember ?? impersonatedMember ?? realUser
  // True only while a session restore is actually running. With no auth-hint
  // cookie there is nothing to restore (the init effect below bails out), so it
  // starts false rather than flipping to false from inside that effect — every
  // consumer already gates on `isAuthenticated()` / `user`, so the value seen is
  // the same, just one render earlier.
  const [isLoading, setIsLoading] = useState(() => isAuthenticated())

  const [coachTeamIds, setCoachTeamIds] = useState<string[]>([])
  const [coachTeamNames, setCoachTeamNames] = useState<string[]>([])
  const [memberTeamIds, setMemberTeamIds] = useState<string[]>([])
  const [memberTeamNames, setMemberTeamNames] = useState<string[]>([])
  const [memberSports, setMemberSports] = useState<Set<'volleyball' | 'basketball'>>(new Set())
  const [teamSportById, setTeamSportById] = useState<Record<string, 'volleyball' | 'basketball'>>({})
  const [guestLevelByTeam, setGuestLevelByTeam] = useState<Record<string, number>>({})
  const [teamResponsibleIds, setTeamResponsibleIds] = useState<string[]>([])
  const [captainTeamIds, setCaptainTeamIds] = useState<string[]>([])
  const [spielplanerTeamIds, setSpielplanerTeamIds] = useState<string[]>([])
  const [isSpielplaner, setIsSpielplaner] = useState(false)
  const [teamsReady, setTeamsReady] = useState(false)
  const teamsLoading = !!user && !teamsReady

  // ── Fetch current member from Directus user ─────────────────────

  const fetchMember = useCallback(async (): Promise<MemberUser | null> => {
    try {
      const me = await client.request(readMe({ fields: ['id'] }))
      if (!me?.id) return null
      const members = await fetchItems<MemberUser>('members', {
        filter: { user: { _eq: me.id } },
        limit: 1,
      })
      return members[0] ?? null
    } catch {
      return null
    }
  }, [])

  // ── Load team context (single parallel fetch) ───────────────────

  const loadTeamContext = useCallback(async (memberId: string | number) => {
    try {
      // allSettled (not all): one failing query must NOT zero every role/team.
      // A rejected query degrades only its own dimension to [] and is logged;
      // the others still populate (previously a single transient failure made
      // the user look like they had no teams/roles at all).
      const settled = await Promise.allSettled([
        fetchAllItems<{ teams_id: number }>('teams_coaches', {
          filter: { members_id: { _eq: memberId } },
          fields: ['teams_id'],
        }),
        fetchAllItems<{ teams_id: number }>('teams_responsibles', {
          filter: { members_id: { _eq: memberId } },
          fields: ['teams_id'],
        }),
        // ⚠ Gate on the TEAM being active, never on member_teams.season.
        // `season` is a stamp written once at create time (no default, no
        // restamp trigger), while getCurrentSeason() flips on a calendar date
        // (Jun 1) and the rollover that writes the new rows is a MANUALLY
        // clicked admin endpoint with no cron. The two are uncoupled, so this
        // filter matched NOTHING for ~34h in 2026 (last 2025/26 row written
        // 31.05 20:45 UTC, cutover 31.05 22:00 UTC, first 2026/27 row 02.06
        // 08:39 UTC) — and an empty memberTeamIds denies RSVP club-wide,
        // empties /teams, and blanks guestLevelByTeam so guests read as full
        // players. `teams.active` is flipped in the SAME transaction that
        // clones the roster onto the new team id, so it can never disagree.
        // M2O walk, so no deep-M2M policy trap.
        fetchAllItems<{ team: number; guest_level: number }>('member_teams', {
          filter: { member: { _eq: memberId }, team: { active: { _eq: true } } },
          fields: ['team', 'guest_level'],
        }),
        fetchAllItems<Pick<Team, 'id' | 'name' | 'sport'>>('teams', {
          filter: { active: { _eq: true } },
          fields: ['id', 'name', 'sport'],
        }),
        // Captain is M2O on teams — filter teams where captain = this member
        fetchAllItems<{ id: number }>('teams', {
          filter: { captain: { _eq: memberId }, active: { _eq: true } },
          fields: ['id'],
        }),
        fetchAllItems<{ kscw_team: number }>('spielplaner_assignments', {
          filter: { member: { _eq: memberId } },
          fields: ['kscw_team'],
        }),
      ])
      const pick = <T,>(i: number, collection: string): T[] => {
        const r = settled[i]
        if (r.status === 'fulfilled') return r.value as T[]
        captureApiError(r.reason, { operation: 'loadTeamContext', collection })
        return []
      }
      const coachRows = pick<{ teams_id: number }>(0, 'teams_coaches')
      const trRows = pick<{ teams_id: number }>(1, 'teams_responsibles')
      const memberTeams = pick<{ team: number; guest_level: number }>(2, 'member_teams')
      const allTeams = pick<Pick<Team, 'id' | 'name' | 'sport'>>(3, 'teams')
      const captainTeams = pick<{ id: number }>(4, 'teams (captain)')
      const spielplanerRows = pick<{ kscw_team: number }>(5, 'spielplaner_assignments')

      const teamMap = new Map(allTeams.map(t => [String(t.id), t]))
      // Skip rows with null team FKs — they shouldn't exist, but if a coach/TR/member_teams row
      // is partially populated, `String(null)` = "null" pollutes _in arrays and trips Directus'
      // `Invalid numeric value` on integer-typed kscw_team filters.
      const coachTeamIdsRaw = coachRows.map(r => r.teams_id).filter((id): id is number => id != null)
      const trTeamIdsRaw = trRows.map(r => r.teams_id).filter((id): id is number => id != null)
      const memberTeamIdsRaw = memberTeams.map(mt => mt.team).filter((id): id is number => id != null)
      const captainTeamIdsRaw = captainTeams.map(t => t.id).filter((id): id is number => id != null)
      const coachIdSet = new Set([...coachTeamIdsRaw.map(String), ...trTeamIdsRaw.map(String)])

      // Intersect EVERY team list with the ACTIVE team map. The captain query
      // scopes itself (:110) and member_teams now walks team.active, but
      // teams_coaches / teams_responsibles / spielplaner_assignments have no
      // season column and are CLONED (not moved) on rollover — so after an
      // archive/rollover these junctions still point at the archived team.
      // teamMap holds only active teams; dropping ids not in it keeps these
      // lists consistent with captain/member handling and stops stale archived
      // ids leaking into every coach-scoped view (TrainingsPage auto-select,
      // GamesPage dashboard, HomePage filters).
      const activeCoachIds = [...coachIdSet].filter(id => teamMap.has(id))
      setCoachTeamIds(activeCoachIds)
      setCoachTeamNames(activeCoachIds.map(id => teamMap.get(id)?.name).filter((n): n is string => !!n))
      setTeamResponsibleIds(trTeamIdsRaw.map(String).filter(id => teamMap.has(id)))
      setCaptainTeamIds(captainTeamIdsRaw.map(String))
      setSpielplanerTeamIds(
        spielplanerRows.map(r => r.kscw_team).filter((id): id is number => id != null).map(String).filter(id => teamMap.has(id)),
      )
      // memberTeamIds was the ONE list not intersected here, so a team
      // deactivated while its rows still matched leaked into canParticipateIn /
      // canViewTeam / isApproved while memberTeamNames silently dropped it —
      // ids and names disagreeing in length.
      const activeMemberTeamIds = memberTeamIdsRaw.map(String).filter(id => teamMap.has(id))
      setMemberTeamIds(activeMemberTeamIds)
      setMemberTeamNames(activeMemberTeamIds.map(id => teamMap.get(id)?.name).filter((n): n is string => !!n))

      const sports = new Set<'volleyball' | 'basketball'>()
      for (const mt of memberTeams) {
        if (mt.team == null) continue
        const s = teamMap.get(String(mt.team))?.sport
        if (s === 'volleyball' || s === 'basketball') sports.add(s)
      }
      setMemberSports(sports)

      const glMap: Record<string, number> = {}
      for (const mt of memberTeams) {
        if (mt.team == null) continue
        glMap[String(mt.team)] = mt.guest_level ?? 0
      }
      setGuestLevelByTeam(glMap)

      const sportById: Record<string, 'volleyball' | 'basketball'> = {}
      for (const t of allTeams) {
        if (t.sport === 'volleyball' || t.sport === 'basketball') sportById[String(t.id)] = t.sport
      }
      setTeamSportById(sportById)
      setTeamsReady(true)
    } catch (err) {
      captureApiError(err, { operation: 'loadTeamContext', collection: 'member_teams' })
      setTeamsReady(true)
    }
  }, [])

  const loadHousehold = useCallback(async (): Promise<HouseholdMember[]> => {
    try {
      const r = await kscwApi<{ data: { managed: HouseholdMember[] } }>('/household/me')
      const managed = r?.data?.managed ?? []
      setHouseholdMembers(managed)
      return managed
    } catch {
      // A household is an enhancement; failing to load one must never block boot.
      setHouseholdMembers([])
      return []
    }
  }, [])

  // ── Init ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!isAuthenticated()) return
    ;(async () => {
      try {
        await refreshAuth()
        const member = await fetchMember()
        if (member) {
          setRealUser(member)
          setIsSpielplaner(!!member.is_spielplaner)
          setCurrentMemberId(member.id)
          addBreadcrumb('auth.init', { memberId: member.id })
          setSentryUser({ id: member.id, displayName: [member.first_name, member.last_name].filter(Boolean).join(' ').trim() || undefined })
          await loadTeamContext(member.id)
          // Household members, if any. ⚠ We load the LIST but deliberately do
          // NOT restore the last acting child: cold start is always the
          // guardian herself. The stored hint is surfaced as a one-tap
          // "Continue with <name>" affordance instead, so resuming is a choice
          // she makes, not a state she wakes up inside.
          void loadHousehold()
          // Restore a read-only "View as" session across reloads (superadmin only).
          const impId = sessionStorage.getItem(IMPERSONATE_KEY)
          if (impId && Array.isArray(member.role) && member.role.includes('superuser') && String(impId) !== String(member.id)) {
            try {
              const [target] = await fetchItems<MemberUser>('members', { filter: { id: { _eq: impId } }, limit: 1 })
              if (target) {
                setImpersonating(true)
                setImpersonatedMember(target)
                setCurrentMemberId(target.id)
                setTeamsReady(false)
                await loadTeamContext(target.id)
              } else {
                sessionStorage.removeItem(IMPERSONATE_KEY)
              }
            } catch { sessionStorage.removeItem(IMPERSONATE_KEY) }
          }
        } else {
          // Token refreshed but no linked member — clear auth
          await apiLogout()
        }
      } catch (err) {
        captureAuthError(err, { action: 'session_restore' })
        // A statusless fetch reject means the request never reached the server
        // — a dropped signal, a backgrounded tab, or an edge block (Cloudflare
        // renders a 403 statusless via CORS). The session is NOT known to be
        // bad, so tearing it down here logs out a member over a blip and the
        // reload re-fires this whole boot (~350 requests), which is what turns
        // a transient block into a sustained one. Keep the session and let the
        // normal retry paths recover.
        if (isTransientNetworkMessage(err instanceof Error ? err.message : String(err))) return
        // Refresh genuinely rejected — token is stale/invalid, clear everything
        await apiLogout()
        // Force reload to clear SDK internal state
        window.location.reload()
        return
      } finally {
        setIsLoading(false)
      }
    })()
  }, [fetchMember, loadTeamContext, loadHousehold])

  // Sync i18n to the REAL operator's language — a superadmin viewing "as" a
  // member keeps their own UI language rather than being flipped to the
  // impersonated member's (which could trap them in a language they don't read).
  useEffect(() => {
    if (realUser?.language) {
      const lang = backendLangToI18n(realUser.language)
      if (i18n.language !== lang) { i18n.changeLanguage(lang); localStorage.setItem('wiedisync-lang', lang) }
    }
  }, [realUser?.language])

  // Enrich Sentry user context once user + teams are fully loaded
  useEffect(() => {
    if (!user || !teamsReady) return
    setSentryUser({
      id: user.id,
      displayName: [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || undefined,
      roles: Array.isArray(user.role) ? user.role : [],
      memberTeamIds,
      coachTeamIds,
      primarySport: memberSports.size === 1 ? [...memberSports][0] : 'both',
      isAdmin: Array.isArray(user.role) && (
        user.role.includes('admin') || user.role.includes('superuser') ||
        user.role.includes('vb_admin') || user.role.includes('bb_admin')
      ),
    })
  }, [user, teamsReady, memberTeamIds, coachTeamIds, memberSports])

  // ── Actions ─────────────────────────────────────────────────────

  const login = useCallback(async (email: string, password: string) => {
    addBreadcrumb('auth.login_attempt')
    await apiLogin(email, password)
    const member = await fetchMember()
    if (member) {
      setRealUser(member)
      setIsSpielplaner(!!member.is_spielplaner)
      setCurrentMemberId(member.id)
      addBreadcrumb('auth.login_success', { memberId: member.id })
      setSentryUser({ id: member.id, displayName: [member.first_name, member.last_name].filter(Boolean).join(' ').trim() || undefined })
      await loadTeamContext(member.id)

      // Create or unlock the member's encryption key. This is the ONLY moment the app holds
      // the plaintext password — every other render restores the session from an httpOnly
      // cookie — so it is the only place this can happen without asking them to re-type it.
      //
      // Fire-and-forget on purpose: it must never block or fail a login. Nothing else in the
      // app depends on the key, and a member who cannot set one up simply cannot use the
      // identity-document feature until they log in again.
      void bootstrapIdentityKey(Number(member.id), password).catch(() => {})
    }
  }, [fetchMember, loadTeamContext])

  const logout = useCallback(async () => {
    // Wipe the E2EE material FIRST, while `realUser` still names whose device
    // key to drop — the state teardown below would erase that.
    //
    // Neither store was touched on logout until 2026-08-10 (audit 2026-08-08,
    // finding 15). The device key is imported with `deriveKey`/`deriveBits`,
    // exactly what `unwrapContentKey` needs, so key + cached ciphertext together
    // yield plaintext government-ID scans offline, same origin, no cookie.
    // Non-extractability stops the key being exfiltrated, not used — so a coach
    // who preloaded a squad on a shared club laptop and logged out left that
    // deck decryptable by the next person to use the browser profile.
    //
    // Awaited, not fire-and-forget: this is the one teardown whose failure is a
    // data-exposure, so it goes first and the rest of logout waits for it. Both
    // helpers swallow their own errors, so logout cannot be blocked by a wipe.
    try {
      if (realUser?.id) await clearDeviceKey(Number(realUser.id))
      await clearAllCachedDocuments()
    } catch { /* never block logout */ }

    apiLogout()
    setImpersonating(false)
    setImpersonatedMember(null)
    sessionStorage.removeItem(IMPERSONATE_KEY)
    // Household acting. apiLogout() already cleared the transport-level header
    // and swept the stored hints; this drops the React state that mirrors them,
    // so the next login on a shared family phone starts as nobody.
    setActingMemberId(null)
    setActingMember(null)
    setHouseholdMembers([])
    setCurrentMemberId(null)
    setSentryUser(null)
    setRealUser(null)
    setCoachTeamIds([]); setCoachTeamNames([])
    setTeamResponsibleIds([]); setCaptainTeamIds([])
    setSpielplanerTeamIds([])
    setIsSpielplaner(false)
    setMemberTeamIds([]); setMemberTeamNames([])
    setMemberSports(new Set()); setGuestLevelByTeam({}); setTeamSportById({})
    setTeamsReady(false)
    queryClient.clear()
  }, [realUser])

  const refreshTeamContext = useCallback(async () => {
    if (user?.id) await loadTeamContext(user.id)
  }, [user, loadTeamContext])

  const refreshUser = useCallback(async () => {
    const member = await fetchMember()
    if (member) setRealUser(member)
  }, [fetchMember])

  // ── Household acting ("use my daughter's account") ───────────────

  /**
   * Switch the whole app to a member this guardian administers, or back to
   * herself with `null`.
   *
   * ⚠⚠ queryClient.clear() is MANDATORY, not defensive, and on BOTH directions.
   * Query keys carry no identity and the client sets `placeholderData:
   * keepPreviousData`, so without it the previous child's roster paints under
   * the new child's name with `isLoading === false` — indistinguishable from
   * real data. This is the highest-probability silent bug in the whole feature.
   */
  const switchTo = useCallback(async (memberId: number | null) => {
    if (!realUser) return
    // Realtime is off while acting (the WS cannot carry the acting header), so
    // window-focus refetch is what keeps a guardian's screens current. Restored
    // to the default when she switches back to herself.
    queryClient.setDefaultOptions({
      queries: {
        ...(queryClient.getDefaultOptions().queries ?? {}),
        refetchOnWindowFocus: memberId != null,
      },
    })
    if (memberId == null) {
      setActingMemberId(null)
      setActingMember(null)
      setCurrentMemberId(realUser.id)
      try { localStorage.removeItem(ACTING_HINT_KEY(realUser.id)) } catch { /* storage unavailable */ }
      queryClient.clear()
      addBreadcrumb('auth.household_switch', { target: 'self' })
      setSentryUser({ id: realUser.id, displayName: [realUser.first_name, realUser.last_name].filter(Boolean).join(' ').trim() || undefined })
      setTeamsReady(false)
      await loadTeamContext(realUser.id)
      return
    }
    if (!householdMembers.some((m) => Number(m.id) === Number(memberId))) return

    // Set the header BEFORE fetching, so the member read resolves as the child.
    setActingMemberId(memberId)
    queryClient.clear()
    let target: MemberUser | null
    try {
      const rows = await fetchItems<MemberUser>('members', { filter: { id: { _eq: String(memberId) } }, limit: 1 })
      target = rows[0] ?? null
    } catch { target = null }
    if (!target) {
      setActingMemberId(null)
      toast.error(i18n.t('common:error'))
      return
    }
    // Acting and impersonation are mutually exclusive.
    setImpersonating(false)
    setImpersonatedMember(null)
    sessionStorage.removeItem(IMPERSONATE_KEY)

    setActingMember(target)
    setCurrentMemberId(target.id)
    try { localStorage.setItem(ACTING_HINT_KEY(realUser.id), String(memberId)) } catch { /* storage unavailable */ }
    addBreadcrumb('auth.household_switch', { target: target.id })
    // Drop the guardian's navigation trail so a crash on the child's screen is
    // not reported with the previous identity's breadcrumbs.
    clearBreadcrumbs()
    setSentryUser({ id: target.id, displayName: [target.first_name, target.last_name].filter(Boolean).join(' ').trim() || undefined })
    setTeamsReady(false)
    await loadTeamContext(target.id)
  }, [realUser, householdMembers, loadTeamContext])

  // One identity per device: a switch in another tab flips this one too, so a
  // parent with two tabs open can never be two children at once.
  useEffect(() => {
    if (!realUser) return
    const key = ACTING_HINT_KEY(realUser.id)
    const onStorage = (e: StorageEvent) => {
      if (e.key !== key) return
      const next = e.newValue ? Number(e.newValue) : null
      const current = actingMember ? Number(actingMember.id) : null
      if (next === current) return
      void switchTo(next)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [realUser, actingMember, switchTo])

  // ── Read-only impersonation ("View as member", superadmin only) ──
  const startImpersonation = useCallback(async (memberId: string) => {
    if (!(realUser?.role ?? []).includes('superuser')) return
    if (String(realUser?.id) === String(memberId)) return // no self-impersonation
    let target: MemberUser | null
    try {
      const rows = await fetchItems<MemberUser>('members', { filter: { id: { _eq: memberId } }, limit: 1 })
      target = rows[0] ?? null
    } catch { target = null }
    if (!target) { toast.error(i18n.t('common:error')); return }
    // Audit BEFORE flipping the read-only flag (this POST is a legitimate write).
    try {
      await kscwApi('/admin/impersonate', {
        method: 'POST',
        body: { action: 'start', target: target.id, target_name: [target.first_name, target.last_name].filter(Boolean).join(' ').trim() },
      })
    } catch { /* audit is best-effort — never block the view */ }
    setImpersonating(true)
    setImpersonatedMember(target)
    setCurrentMemberId(target.id)
    sessionStorage.setItem(IMPERSONATE_KEY, String(target.id))
    addBreadcrumb('auth.impersonate_start', { target: target.id })
    setTeamsReady(false)
    await loadTeamContext(target.id)
  }, [realUser, loadTeamContext])

  const stopImpersonation = useCallback(async () => {
    const target = impersonatedMember
    setImpersonating(false)
    setImpersonatedMember(null)
    sessionStorage.removeItem(IMPERSONATE_KEY)
    addBreadcrumb('auth.impersonate_stop', target ? { target: target.id } : {})
    if (realUser?.id) {
      setCurrentMemberId(realUser.id)
      setTeamsReady(false)
      await loadTeamContext(realUser.id)
    }
    if (target) {
      try { await kscwApi('/admin/impersonate', { method: 'POST', body: { action: 'stop', target: target.id } }) } catch { /* best-effort */ }
    }
  }, [impersonatedMember, realUser, loadTeamContext])

  // ── Derived ─────────────────────────────────────────────────────

  const roles = user?.role ?? []
  const isImpersonating = !!impersonatedMember
  // Gate the "View as" trigger on the REAL operator's role, so it stays correct
  // regardless of who is being impersonated.
  const canImpersonate = (realUser?.role ?? []).includes('superuser')
  const isSuperAdmin = roles.includes('superuser')
  const isGlobalAdmin = roles.includes('admin') || isSuperAdmin
  const isVbAdmin = roles.includes('vb_admin')
  const isBbAdmin = roles.includes('bb_admin')
  const isAdmin = isGlobalAdmin || isVbAdmin || isBbAdmin
  const isApproved = user?.coach_approved_team === true || isAdmin || memberTeamIds.length > 0 || coachTeamIds.length > 0
  // Core contact set the club register (ClubDesk) needs. Layout blocks the app
  // with the non-dismissable onboarding modal until every one of these is
  // filled (2026-07-28) — coaches/staff never pass the membership registration
  // form, so this gate is the only place their address ever gets collected.
  // Nationality checks the coded column; the legacy `nationalitaet` text is a
  // trigger-derived mirror of it and needs no fallback here.
  const filled = (v: unknown) => String(v ?? '').trim() !== ''
  const isProfileComplete = !!user?.language && filled(user?.first_name)
    && filled(user?.last_name) && filled(user?.phone) && filled(user?.birthdate)
    && filled(user?.adresse) && filled(user?.plz) && filled(user?.ort)
    && filled(user?.nationalitaet_codes)
  const isVorstand = roles.includes('vorstand') || isGlobalAdmin
  // 'finance' is an orthogonal role (treasurer / finance team). Global admins
  // implicitly have it; the finance dashboard opens for board OR finance.
  const isFinance = roles.includes('finance') || isGlobalAdmin
  const canAccessFinance = isVorstand || isFinance
  const isCoach = coachTeamIds.length > 0 || isGlobalAdmin
  const primarySport: 'volleyball' | 'basketball' | 'both' =
    memberSports.size === 1 ? [...memberSports][0] : 'both'

  const hasAdminAccessToSport = useCallback(
    (sport: 'volleyball' | 'basketball') => isGlobalAdmin || (sport === 'volleyball' ? isVbAdmin : isBbAdmin),
    [isGlobalAdmin, isVbAdmin, isBbAdmin],
  )
  const hasAdminAccessToTeam = useCallback(
    (teamId: string) => {
      const sport = teamSportById[teamId]
      return !sport ? isGlobalAdmin : hasAdminAccessToSport(sport)
    },
    [teamSportById, isGlobalAdmin, hasAdminAccessToSport],
  )
  /**
   * ⚠ MODE-BLIND, and the name now says so. This folds `hasAdminAccessToTeam`
   * in, so it is true for every sport admin regardless of the admin-mode
   * toggle. It was called `isCoachOf`, which read as a pure coach check and
   * hid 8 of the 15 bypasses a 2026-09-07 audit found.
   *
   * For "may this person manage this team", use `canManageTeam` from
   * `useTeamPermissions()` — it honours the toggle. Reach for this one only
   * where an admin genuinely should qualify with admin mode OFF.
   */
  const isCoachOfOrAdmin = useCallback(
    (teamId: string) => hasAdminAccessToTeam(teamId) || coachTeamIds.includes(teamId),
    [hasAdminAccessToTeam, coachTeamIds],
  )
  const canParticipateIn = useCallback(
    (teamId: string) => memberTeamIds.includes(teamId) || coachTeamIds.includes(teamId),
    [memberTeamIds, coachTeamIds],
  )
  const isStaffOnly = useCallback(
    (teamId: string) => teamsReady && coachTeamIds.includes(teamId) && !memberTeamIds.includes(teamId),
    [coachTeamIds, memberTeamIds, teamsReady],
  )
  /** Same question for an activity that invites SEVERAL teams: staff of at
   *  least one of them, on none of their rosters. The event surfaces used to
   *  ask `isStaffOnly(event.teams[0])`, which mislabels a D1 coach as a player
   *  the moment H3 happens to be first in the junction — their RSVP then lands
   *  in the player tally instead of the Staff section. */
  const isStaffOnlyForTeams = useCallback(
    (teamIds: string[]) => teamsReady
      && teamIds.some((id) => coachTeamIds.includes(id))
      && !teamIds.some((id) => memberTeamIds.includes(id)),
    [coachTeamIds, memberTeamIds, teamsReady],
  )
  const canViewTeam = useCallback(
    (teamId: string) => hasAdminAccessToTeam(teamId) || coachTeamIds.includes(teamId) || memberTeamIds.includes(teamId),
    [hasAdminAccessToTeam, coachTeamIds, memberTeamIds],
  )
  const getGuestLevel = useCallback((teamId: string) => guestLevelByTeam[teamId] ?? 0, [guestLevelByTeam])
  const isGuestIn = useCallback((teamId: string) => getGuestLevel(teamId) > 0, [getGuestLevel])

  const matchesRole = useCallback((role: string): boolean => {
    if (!user) return false
    if (isBaseRole(role)) {
      return (user.role ?? []).includes(role)
    }
    if (role === 'coach') return coachTeamIds.length > 0
    if (role === 'team_responsible') return teamResponsibleIds.length > 0
    if (role === 'captain') return captainTeamIds.length > 0
    if (isLicenceFlag(role)) {
      // Migration 067: licences are now per-flag booleans on the user record.
      return user[role] === true
    }
    if (role === 'is_spielplaner') return isSpielplaner
    return false
  }, [user, coachTeamIds, teamResponsibleIds, captainTeamIds, isSpielplaner])

  const value = useMemo<AuthContextValue>(() => ({
    user, isImpersonating, canImpersonate, realUser, startImpersonation, stopImpersonation,
    householdMembers, actingMember, isActingForOther: !!actingMember, switchTo,
    identityMemberId: user?.id ?? null,
    isSuperAdmin, isAdmin, isGlobalAdmin, isVbAdmin, isBbAdmin,
    hasAdminAccessToSport, hasAdminAccessToTeam, isApproved, isProfileComplete,
    isCoach, isCoachOfOrAdmin, canParticipateIn, isStaffOnly, isStaffOnlyForTeams, coachTeamIds, coachTeamNames,
    teamResponsibleIds, captainTeamIds, spielplanerTeamIds, is_spielplaner: isSpielplaner, matchesRole,
    memberTeamIds, memberTeamNames, teamsLoading, memberSports, primarySport,
    canViewTeam, isVorstand, isFinance, canAccessFinance, getGuestLevel, isGuestIn, isLoading, login, logout,
    refreshTeamContext, refreshUser,
  }), [
    user, isImpersonating, canImpersonate, realUser, startImpersonation, stopImpersonation,
    householdMembers, actingMember, switchTo,
    isSuperAdmin, isAdmin, isGlobalAdmin, isVbAdmin, isBbAdmin,
    hasAdminAccessToSport, hasAdminAccessToTeam, isApproved, isProfileComplete,
    isCoach, isCoachOfOrAdmin, canParticipateIn, isStaffOnly, isStaffOnlyForTeams, coachTeamIds, coachTeamNames,
    teamResponsibleIds, captainTeamIds, spielplanerTeamIds, isSpielplaner, matchesRole,
    memberTeamIds, memberTeamNames, teamsLoading, memberSports, primarySport,
    canViewTeam, isVorstand, isFinance, canAccessFinance, getGuestLevel, isGuestIn, isLoading, login, logout,
    refreshTeamContext, refreshUser,
  ])

  // The boot spinner now lives in a single <BootOverlay/> (rendered once at the
  // top of the app) that masks the whole app during session restore AND page
  // load — one continuous spinner instead of this block + Layout's separate one.
  // BootOverlay's authBooting (isAuthenticated() && isLoading) covers the restore
  // window, and Layout/AuthRoute gate their content on the same auth state, so
  // nothing unauthenticated flashes underneath the overlay.
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
