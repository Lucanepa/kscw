import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Pencil, ChevronDown, Check, Download, FileText, Image as ImageIcon, FileType, X, HelpCircle, Hourglass, Minus, Users, UserCog } from 'lucide-react'
import Modal from '@/components/Modal'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useMultiTeamMembers } from '../hooks/useTeamMembers'
import { useTeamParticipations, useAllEventParticipations } from '../hooks/useParticipation'
import { useFineRules } from '../hooks/useFines'
import IssueFineModal from '../modules/fines/IssueFineModal'
import { useAuth } from '../hooks/useAuth'
import { useAdminMode } from '../hooks/useAdminMode'
import { useMutation } from '../hooks/useMutation'
import { useCollection } from '../lib/query'
import { fetchAllItems } from '../lib/api'
import { getFileUrl } from '../utils/fileUrl'
import { resolveSessionTargets, statusWrites, noteWrites, uniformValue, allConfirmed } from '../utils/participationSessions'
import type { SessionTarget } from '../utils/participationSessions'
import type { Participation, Absence, Member, Team, EventSession } from '../types'
import { asObj, flattenMemberIds, disambiguateFirstNames, memberFirstName } from '../utils/relations'
import { currentLocale, formatDate, getDeadlineDate, formatRelativeTime, formatDateTimeCompact } from '../utils/dateHelpers'
import { absenceCoversActivity } from '../utils/absenceHelpers'
import { getPositionI18nKey } from '../utils/memberPositions'
import {
  exportRosterCsv,
  exportRosterImage,
  exportRosterPdf,
  isMultiTeamExport,
  type RosterExportMeta,
  type RosterExportRow,
} from '../utils/rosterExport'

interface ParticipationRosterModalProps {
  open: boolean
  onClose: () => void
  activityType: Participation['activity_type']
  activityId: string | null
  activityDate: string
  teamIds: string[]
  title: string
  respondBy?: string
  activityStartTime?: string
  maxPlayers?: number
  eventSessions?: EventSession[]
  participationMode?: 'whole' | 'per_day' | 'per_session' | ''
  showRsvpTime?: boolean
  allowMaybe?: boolean
  /** Guest levels excluded from this activity. Trainings pick tiers
   *  (`excluded_guest_levels`); events answer one yes/no (`invite_guests`) and
   *  pass the whole ladder. Members of those levels are dropped from the roster
   *  — they can't reply (UI hides buttons + server rejects), so showing them as
   *  "not responded" just inflates the list. */
  excludedGuestLevels?: number[]
  /** `events.invited_roles` — the roles this event was targeted at. Drives the
   *  role half of the filter row; absent/empty (every event on prod today) means
   *  no role dropdown is offered at all. */
  invitedRoles?: string[] | null
  /** Optional override for the activity-kind line shown above the title in
   *  PNG/PDF exports and prepended to CSV metadata. Defaults to the
   *  translated activity type ("Training" / "Game" / "Event"). Game call
   *  sites pass `"<home> vs <away>"` so the export header carries the
   *  matchup without disturbing the modal's on-screen title. */
  activityKind?: string
}

/**
 * Fold game guests (migration 271) into the team roster, first occurrence wins.
 *
 * One merged list rather than a separate "Guests" block: a coach reading this modal
 * is picking who plays on Saturday, and a borrowed player is a candidate on exactly
 * the same terms as a rostered one. The origin badge on the row carries the "this
 * one is on loan" signal without splitting the list they have to scan.
 */
function mergeGameGuests(roster: Member[], guests: Member[]): Member[] {
  if (guests.length === 0) return roster
  const seen = new Set(roster.map((m) => String(m.id)))
  return [...roster, ...guests.filter((g) => !seen.has(String(g.id)))]
}

/** Editor label for somebody who is NOT on this roster (an admin, a coach of
 *  another team): first name + last initial. `disambiguateFirstNames` can't help
 *  here — it only knows the roster — so the initial is always included.
 *  Nobody is named by their full legal name in this modal or in its exports. */
function editorLabelFor(m: Pick<Member, 'first_name' | 'last_name'> & { nickname?: string | null }): string | null {
  const first = ((m.nickname && m.nickname.trim()) || m.first_name || '').trim()
  const last = (m.last_name ?? '').trim()
  if (!first && !last) return null
  return first ? (last ? `${first} ${last[0]}.` : first) : last
}

/** `invited_roles` values that are a function ON A TEAM rather than a column on
 *  `members` — resolved from the coach / team_responsible / captain junctions. */
const TEAM_FUNCTION_ROLES: Record<string, 'coach' | 'tr' | 'captain'> = {
  coach: 'coach',
  team_responsible: 'tr',
  captain: 'captain',
}

/** Sort comparator: by first_name then last_name, locale-aware + case-insensitive. */
function byFirstThenLastName<T extends { first_name?: string | null; last_name?: string | null }>(a: T, b: T): number {
  const cmp = (a.first_name ?? '').localeCompare(b.first_name ?? '', undefined, { sensitivity: 'base' })
  if (cmp !== 0) return cmp
  return (a.last_name ?? '').localeCompare(b.last_name ?? '', undefined, { sensitivity: 'base' })
}

function formatSessionLabel(session: EventSession): string {
  const dateStr = session.date?.split(' ')[0] ?? ''
  const d = new Date(dateStr + 'T00:00:00')
  const datePart = d.toLocaleDateString(currentLocale(), { weekday: 'short', day: 'numeric', month: 'short' })
  if (session.label) return session.label
  if (session.start_time) return `${datePart} ${session.start_time}${session.end_time ? '–' + session.end_time : ''}`
  return datePart
}

/** Capitalize the first character (locale-aware) — Intl.RelativeTimeFormat
 *  emits lowercase ("last month", "vor einem monat"), but we render this as a
 *  standalone sub-label under the member's name where sentence-case reads better. */
function capitalizeFirst(s: string): string {
  if (!s) return s
  return s.charAt(0).toLocaleUpperCase() + s.slice(1)
}

/** Clickable relative timestamp that toggles to absolute dd.mm.yy HH:mm on tap */
function RsvpTimestamp({ datetime, locale }: { datetime: string; locale: string }) {
  const [showAbsolute, setShowAbsolute] = useState(false)
  return (
    <button
      type="button"
      onClick={() => setShowAbsolute(v => !v)}
      className="truncate text-[11px] text-gray-400 hover:text-gray-500 dark:text-gray-500 dark:hover:text-gray-400"
    >
      {showAbsolute ? formatDateTimeCompact(datetime) : capitalizeFirst(formatRelativeTime(datetime, locale))}
    </button>
  )
}

/** Colored status "brick" — a filled circle + glyph mirroring the
 *  ParticipationSummary counters (green ✓ / yellow ? / red ✗ / orange ⧗) so a
 *  coach can read RSVP state at a glance without a wide text badge. No-response
 *  renders a muted gray circle with a dash. The full textual label rides along
 *  in `title`/`aria-label` so the meaning isn't colour-only. */
function RsvpBrick({ status, label }: { status: Participation['status'] | null; label: string }) {
  const meta: Record<string, { bg: string; Icon: typeof Check }> = {
    confirmed: { bg: 'bg-green-600 dark:bg-green-500', Icon: Check },
    tentative: { bg: 'bg-yellow-500', Icon: HelpCircle },
    declined: { bg: 'bg-red-600 dark:bg-red-500', Icon: X },
    waitlisted: { bg: 'bg-orange-500', Icon: Hourglass },
  }
  const m = status ? meta[status] : undefined
  if (!m) {
    return (
      <span
        title={label}
        aria-label={label}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-200 text-gray-400 dark:bg-gray-700 dark:text-gray-500"
      >
        <Minus className="h-3.5 w-3.5" />
      </span>
    )
  }
  const Icon = m.Icon
  return (
    <span
      title={label}
      aria-label={label}
      className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-white ${m.bg}`}
    >
      <Icon className="h-3.5 w-3.5" />
    </span>
  )
}

/** Left-edge accent colour for a roster row, keyed to RSVP status (gray when
 *  there's no response). Pairs with RsvpBrick so status reads from both the row
 *  edge and the trailing glyph. */
function statusBarClass(status: Participation['status'] | null): string {
  switch (status) {
    case 'confirmed': return 'border-l-green-500'
    case 'tentative': return 'border-l-yellow-500'
    case 'declined': return 'border-l-red-500'
    case 'waitlisted': return 'border-l-orange-500'
    default: return 'border-l-gray-300 dark:border-l-gray-600'
  }
}

/** Status → hex color for the PNG/PDF snapshot's per-session breakdown cells,
 *  mirroring the on-screen summary counters (green ✓ / amber ? / red ✗ /
 *  orange ⧗ / gray – for no response). Plain function because the snapshot is
 *  inlined DOM with no Tailwind class resolution. */
function exportStatusColor(status: string | null): string {
  switch (status) {
    case 'confirmed': return '#16a34a'
    case 'tentative': return '#ca8a04'
    case 'declined': return '#dc2626'
    case 'waitlisted': return '#ea580c'
    default: return '#6b7280'
  }
}

export default function ParticipationRosterModal({
  open,
  onClose,
  activityType,
  activityId,
  activityDate,
  teamIds,
  title,
  respondBy,
  activityStartTime,
  maxPlayers,
  eventSessions,
  participationMode,
  showRsvpTime = true,
  allowMaybe = true,
  excludedGuestLevels,
  invitedRoles,
  activityKind,
}: ParticipationRosterModalProps) {
  const { t, i18n } = useTranslation('participation')
  const { t: te } = useTranslation('events')
  const { t: ta } = useTranslation('absences')
  const { t: tt } = useTranslation('teams')
  // Role chips reuse the `invitations` namespace's `role_*` keys — the same
  // labels EventForm offers when picking the audience and EventDetailModal
  // shows as the event's targeting chips.
  const { t: tv } = useTranslation('invitations')
  const { members, teamsByMember, isLoading: membersLoading } = useMultiTeamMembers(teamIds)

  // Players this game was opened to from outside its own roster (migration 271).
  // They have no `member_teams` row on this team, so `useMultiTeamMembers` above
  // cannot see them — yet they RSVP to this game and must show up in the same list
  // as everyone else, because the coach reads this list to pick a squad.
  const { data: gameGuestRows } = useCollection<{
    id: string
    member: Member | string
    via_team: { id: string | number; name?: string } | string | null
  }>('game_guests', {
    filter: { game: { _eq: activityId ?? '' } },
    fields: ['id', 'member.*', 'via_team.id', 'via_team.name'],
    all: true,
    enabled: open && activityType === 'game' && !!activityId,
  })

  const gameGuests: Member[] = useMemo(
    () => (gameGuestRows ?? [])
      .map((r) => asObj<Member>(r.member))
      .filter((m): m is Member => m !== null)
      .map((m) => ({ ...m, id: String(m.id) })),
    [gameGuestRows],
  )

  /** memberId → the team they were borrowed from ('' when invited individually). */
  const gameGuestOrigin = useMemo(() => {
    const map = new Map<string, string>()
    for (const r of gameGuestRows ?? []) {
      const mid = String(asObj<Member>(r.member)?.id ?? '')
      if (!mid) continue
      const team = asObj<{ id: string | number; name?: string }>(r.via_team)
      map.set(mid, team?.name ?? '')
    }
    return map
  }, [gameGuestRows])

  const [absences, setAbsences] = useState<Absence[]>([])
  const [staffMembers, setStaffMembers] = useState<Member[]>([])
  // Staff participation rows (is_staff=true) for this activity. Tracked
  // separately because `useTeamParticipations` filters by roster member IDs —
  // a coach/TR not in member_teams won't appear in that query at all, so
  // their RSVP status would otherwise render as "Keine Antwort" in the
  // staff section even after they clicked Yes/Maybe/No.
  const [staffParticipationRows, setStaffParticipationRows] = useState<Participation[]>([])
  const [activeSessionTab, setActiveSessionTab] = useState<string | null>(null) // null = overall
  const [statusFilter, setStatusFilter] = useState<string | null>(null) // null = "All"
  // Team filter (multi-team events only). `null` = all teams; a non-empty Set
  // narrows the ENTIRE modal (counts, list, staff, export) to members belonging
  // to at least one selected team.
  const [selectedTeams, setSelectedTeams] = useState<Set<string> | null>(null)
  // Guest filter (multi-team events with guests). Narrows the whole modal to
  // guest players (member_teams.guest_level > 0), combinable with the team filter.
  const [guestsOnly, setGuestsOnly] = useState(false)
  // Role filter (role-targeted events only). `null` = all roles; a non-empty Set
  // keeps members holding at least one selected role. ANDed with the team filter.
  const [selectedRoles, setSelectedRoles] = useState<Set<string> | null>(null)

  // Fetch team leadership roles (coach, captain, team_responsible)
  const { data: teamsRaw } = useCollection<Team>('teams', {
    filter: teamIds.length > 0 ? { id: { _in: teamIds } } : undefined,
    // M2M fields MUST be expanded via `<rel>.members_id`. Bare `coach`/
    // `team_responsible` return junction row IDs that look like member
    // IDs but aren't → ghost-staff bug.
    fields: ['id', 'name', 'captain', 'coach.members_id', 'team_responsible.members_id'],
    enabled: teamIds.length > 0 && open,
  })
  const teams = useMemo(() => teamsRaw ?? [], [teamsRaw])
  // `leadershipRoles`: memberId → role (first-wins). `leadershipTeamsByMember`:
  // memberId → the set of invited teams they coach / are TR for, so the team
  // filter can narrow the staff section too.
  const { leadershipRoles, leadershipTeamsByMember } = useMemo(() => {
    const roleMap = new Map<string, string>()
    const teamMap = new Map<string, Set<string>>()
    const addTeam = (id: string, teamId: string) => {
      const s = teamMap.get(id)
      if (s) s.add(teamId)
      else teamMap.set(id, new Set([teamId]))
    }
    for (const team of teams) {
      const tid = String(team.id)
      for (const id of flattenMemberIds(team.coach)) { if (!roleMap.has(id)) roleMap.set(id, 'coach'); addTeam(id, tid) }
      for (const id of flattenMemberIds(team.captain)) { if (!roleMap.has(id)) roleMap.set(id, 'captain'); addTeam(id, tid) }
      for (const id of flattenMemberIds(team.team_responsible)) { if (!roleMap.has(id)) roleMap.set(id, 'tr'); addTeam(id, tid) }
    }
    return { leadershipRoles: roleMap, leadershipTeamsByMember: teamMap }
  }, [teams])
  const teamNameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const team of teams) m.set(String(team.id), team.name ?? String(team.id))
    return m
  }, [teams])

  const { user, isCoachOf, teamResponsibleIds } = useAuth()
  const { effectiveIsAdmin } = useAdminMode()
  // Hoisted so the memo below can depend on the id itself rather than on the
  // whole (identity-unstable) `user` object.
  const currentUserId = user?.id

  const isStaffForActivity = teamIds.some(id => isCoachOf(id) || teamResponsibleIds.includes(id))
  const canEditRoster = isStaffForActivity || effectiveIsAdmin

  const [editingMemberId, setEditingMemberId] = useState<string | null>(null)
  const [savingMemberIds, setSavingMemberIds] = useState<Set<string>>(new Set())
  const { create, update, remove } = useMutation<Participation>('participations')

  // Reset filters + editing state when the modal opens. The modal is NOT
  // remounted between activities (it stays mounted and takes a new activityId),
  // so this reset is load-bearing — it just runs during render now (React's
  // "adjust state while rendering" pattern) instead of in an effect. Same
  // trigger as the old `useEffect(..., [open])`: a false→true transition.
  const [prevOpen, setPrevOpen] = useState(open)
  if (prevOpen !== open) {
    setPrevOpen(open)
    if (open) {
      setStatusFilter(null)
      setSelectedTeams(null)
      setGuestsOnly(false)
      setSelectedRoles(null)
      setEditingMemberId(null)
    }
  }

  // Late-signin fine prompt — when a leader confirms a member past respondBy
  // for a single-team activity with a configured late_signin rule, pop
  // IssueFineModal pre-filled. Multi-team activities (events) skip the prompt
  // (ambiguous which team's rule applies).
  const [lateConfirmFor, setLateConfirmFor] = useState<{ memberId: string; memberName: string; teamId: string } | null>(null)
  const singleTeamId = teamIds.length === 1 ? String(teamIds[0]) : null
  const { data: lateSigninRules } = useFineRules(singleTeamId ?? undefined, {
    enabled: open && canEditRoster && singleTeamId != null,
  })
  const lateSigninRuleEnabled = (lateSigninRules ?? []).some(
    (r) => r.category === 'late_signin' && r.enabled,
  )

  // For club-wide events (no team), fetch all participations and resolve members from them
  const [clubWideMembers, setClubWideMembers] = useState<Member[]>([])
  const [clubWideLoading, setClubWideLoading] = useState(false)
  const isClubWide = teamIds.length === 0

  const hasSessionMode = participationMode && participationMode !== 'whole' && eventSessions && eventSessions.length > 0

  // Club-wide: fetch all participations for the event, then resolve member info
  const { data: clubWideParticipationsRaw, isLoading: clubWidePartsLoading } = useCollection<Participation>('participations', {
    filter: isClubWide && activityId ? {
      _and: [
        { activity_type: { _eq: activityType } },
        { activity_id: { _eq: activityId } },
      ],
    } : undefined,
    all: true,
    enabled: isClubWide && !!activityId && open,
  })
  const clubWideParticipations = clubWideParticipationsRaw ?? []

  // The synchronous prologue of the club-wide member fetch (clear the resolved
  // members when there's nothing to resolve, spinner on otherwise) runs during
  // render — React's adjust-state-while-rendering pattern, same as `prevOpen`
  // above. It lands BEFORE the fetch effect below and before paint, so the
  // previous event's club-wide roster is never shown while the new fetch is in
  // flight. `prevClubWideKey` starts null so it also runs on the first render,
  // matching the mount run of the effect it replaces.
  const clubWideKey = `${isClubWide}|${open}|${clubWideParticipations.length}`
  const [prevClubWideKey, setPrevClubWideKey] = useState<string | null>(null)
  if (prevClubWideKey !== clubWideKey) {
    setPrevClubWideKey(clubWideKey)
    if (!isClubWide || !open || clubWideParticipations.length === 0) setClubWideMembers([])
    else setClubWideLoading(true)
  }

  useEffect(() => {
    if (!isClubWide || !open || clubWideParticipations.length === 0) return
    const uniqueMemberIds = [...new Set(clubWideParticipations.map(p => p.member))]
    fetchAllItems<Member>('members', {
      filter: { id: { _in: uniqueMemberIds } },
      // `user` is load-bearing, exactly as in the staff fetch below: without it
      // `member.user` is undefined, getEditAttribution() reads that as "this
      // member cannot self-edit", and EVERY row of a club-wide roster printed a
      // bogus "Edited to <status> by <the member themselves>" line. The
      // team-based path never hit it because it fetches `member.*`.
      // `role` + the licence booleans back the role filter (invited_roles); all
      // of these are club-wide readable (MEMBER_VISIBLE_FIELDS).
      fields: [
        'id', 'nickname', 'first_name', 'last_name', 'photo', 'user', 'role',
        'scorer_vb', 'referee_vb', 'otr1_bb', 'otr2_bb', 'otn1_bb', 'otn2_bb', 'referee_bb',
      ],
    })
      .then(m => setClubWideMembers(m.sort(byFirstThenLastName)))
      .catch(() => setClubWideMembers([]))
      .finally(() => setClubWideLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isClubWide, open, clubWideParticipations.length])

  // Excluded guests can't reply (UI hides buttons + server rejects participations.create),
  // so dropping them from the roster keeps "not responded" counts honest.
  // Games: hard rule from commit af71850 — any guest_level > 0 cannot participate.
  // Trainings: per-activity excludedGuestLevels list. Events: all three tiers
  // when `invite_guests` is off (migration 324).
  const excludedSet = useMemo(() => {
    if (!excludedGuestLevels?.length) return null
    return new Set(excludedGuestLevels.map((n) => Number(n)))
  }, [excludedGuestLevels])

  // Full roster (guest-excluded, NOT team-filtered). Drives the participation /
  // absence FETCHES and the staff-vs-player split — those must stay stable when
  // the team filter changes so counts recompute from already-loaded data
  // instead of triggering a refetch flash.
  const rosterMembers: Member[] = isClubWide
    ? clubWideMembers
    : mergeGameGuests(
        members
          .filter((mt) => {
            const lvl = Number((mt as { guest_level?: number }).guest_level ?? 0)
            if (lvl > 0 && activityType === 'game') return false
            if (excludedSet && lvl > 0 && excludedSet.has(lvl)) return false
            return true
          })
          .map((mt) => asObj<Member>(mt.member))
          .filter((m): m is Member => m !== null)
          .map(m => ({ ...m, id: String(m.id) })),
        gameGuests,
      ).sort(byFirstThenLastName)

  const rosterMemberIds = rosterMembers.map((m) => m.id)

  // ── Team buckets for the filter ──────────────────────────────────────────
  //
  // A club-wide event invites nobody in particular, so `teamIds` is empty,
  // `useMultiTeamMembers` has nothing to key on and `teamsByMember` comes back
  // empty — which is why the 108-person Photoday roster could only be sliced by
  // response. Resolve the respondents' OWN teams straight off the junction
  // instead: a single-level `member _in` filter, never a walk through
  // `members.member_teams`, which is the deep-M2M-vs-policy silent-[] trap.
  // `member_teams` is club-wide readable (MEMBER_POLICY), so this works for an
  // ordinary member opening the roster, not just staff.
  const { data: clubWideTeamRows } = useCollection<{
    member: string | number
    team: { id: string | number; name?: string; active?: boolean } | string | number | null
  }>('member_teams', {
    filter: { member: { _in: rosterMemberIds.length > 0 ? rosterMemberIds : [-1] } },
    fields: ['member', 'team.id', 'team.name', 'team.active'],
    all: true,
    enabled: isClubWide && open && rosterMemberIds.length > 0,
  })

  const { clubWideTeamsByMember, clubWideTeamNames } = useMemo(() => {
    const byMember = new Map<string, string[]>()
    const names = new Map<string, string>()
    for (const row of clubWideTeamRows ?? []) {
      const team = asObj<{ id: string | number; name?: string; active?: boolean }>(row.team)
      // Gate on `teams.active`, never on `member_teams.season`: rosters are
      // CLONED forward at rollover and the old junction rows are never deleted,
      // so an inactive team is last season's membership and would offer a dead
      // bucket in the dropdown.
      if (!team || team.active === false) continue
      const tid = String(team.id)
      // `member` comes back as a scalar FK for the field list above, but read it
      // the way the rest of this file reads relations so a widened `fields:`
      // (which would expand it into an object) can't silently key every row
      // under "[object Object]".
      const mid = String(asObj<Member>(row.member)?.id ?? row.member)
      names.set(tid, team.name ?? tid)
      const arr = byMember.get(mid)
      if (arr) { if (!arr.includes(tid)) arr.push(tid) }
      else byMember.set(mid, [tid])
    }
    return { clubWideTeamsByMember: byMember, clubWideTeamNames: names }
  }, [clubWideTeamRows])

  const effectiveTeamsByMember = isClubWide ? clubWideTeamsByMember : teamsByMember
  const effectiveTeamNameById = isClubWide ? clubWideTeamNames : teamNameById
  // What the team dropdown offers: the event's invited teams normally, the teams
  // the respondents actually belong to when the event is club-wide.
  const filterTeamIds: string[] = isClubWide
    ? [...clubWideTeamNames.keys()].sort((a, b) =>
        (clubWideTeamNames.get(a) ?? '').localeCompare(clubWideTeamNames.get(b) ?? '', undefined, { sensitivity: 'base' }))
    : teamIds.map(String)

  // One bucket is not a filter — a single-team activity keeps the dropdown hidden
  // exactly as before. `null`/empty Set = all teams (no narrowing).
  const teamFilterActive = filterTeamIds.length > 1 && selectedTeams != null && selectedTeams.size > 0
  const memberInSelectedTeams = useCallback((memberTeamIds: string[] | undefined): boolean => {
    if (!teamFilterActive) return true
    if (!memberTeamIds || memberTeamIds.length === 0) return false
    return memberTeamIds.some((tid) => selectedTeams!.has(String(tid)))
  }, [teamFilterActive, selectedTeams])

  // ── Role buckets (role-targeted events) ──────────────────────────────────
  const roleOptions = useMemo(() => [...new Set((invitedRoles ?? []).map(String))], [invitedRoles])
  const roleFilterAvailable = roleOptions.length > 0
  const roleFilterActive = roleFilterAvailable && selectedRoles != null && selectedRoles.size > 0

  // coach / team_responsible / captain aren't columns on `members` — they're
  // junctions on `teams`. The team-scoped `teams` query above only covers the
  // event's own teams, so resolve them club-wide, and only when a leadership
  // role is actually one of the buckets being offered.
  const needsLeadershipRoles = roleFilterAvailable && roleOptions.some((r) => r in TEAM_FUNCTION_ROLES)
  const { data: allActiveTeamsRaw } = useCollection<Team>('teams', {
    filter: { active: { _eq: true } },
    fields: ['id', 'captain', 'coach.members_id', 'team_responsible.members_id'],
    all: true,
    enabled: open && needsLeadershipRoles,
  })
  const roleHolders = useMemo(() => {
    const holders = { coach: new Set<string>(), tr: new Set<string>(), captain: new Set<string>() }
    for (const team of allActiveTeamsRaw ?? []) {
      for (const id of flattenMemberIds(team.coach)) holders.coach.add(String(id))
      for (const id of flattenMemberIds(team.team_responsible)) holders.tr.add(String(id))
      for (const id of flattenMemberIds(team.captain)) holders.captain.add(String(id))
    }
    return holders
  }, [allActiveTeamsRaw])

  /** Does this member hold `role`, in the same sense `matchesRole()` means it for
   *  the logged-in user? Three shapes: a team function (junction on `teams`), a
   *  base account role (the `members.role` array), or a licence flag (its own
   *  boolean column, migration 067). `is_spielplaner` is deliberately NOT
   *  club-wide readable, so it resolves to false rather than throwing a 403. */
  const memberMatchesRole = useCallback((m: Member, role: string): boolean => {
    const fn = TEAM_FUNCTION_ROLES[role]
    if (fn) return roleHolders[fn].has(String(m.id))
    if (Array.isArray(m.role) && (m.role as string[]).includes(role)) return true
    // `otn_bb` is the coarse legacy chip; Basketplan issues the two levels.
    if (role === 'otn_bb') return m.otn1_bb === true || m.otn2_bb === true
    return (m as unknown as Record<string, unknown>)[role] === true
  }, [roleHolders])

  // Guest players (member_teams.guest_level > 0) → memberId → level. Surfaced
  // with a "Guest <level>" badge in each row so a coach can tell core players
  // from guests borrowed off another team, and used by the guest filter. Empty
  // when club-wide (no team junction context). `guestMemberIds` aliases the
  // Map's key set (Map.has === Set.has for membership checks).
  const guestLevels = useMemo(() => {
    const m = new Map<string, number>()
    if (isClubWide) return m
    for (const mt of members) {
      const lvl = Number((mt as { guest_level?: number }).guest_level ?? 0)
      const mid = String(asObj<Member>(mt.member)?.id ?? '')
      if (mid && lvl > 0) m.set(mid, lvl)
    }
    return m
  }, [members, isClubWide])
  const guestMemberIds = guestLevels

  // Filtered view — narrows the summary counts, the visible list, the waitlist
  // and the export to the selected team(s) and/or guests. Passthrough when no
  // filter is active (single-team or "All").
  const teamFilteredMembers: Member[] = (teamFilterActive || guestsOnly)
    ? rosterMembers.filter((m) => {
        const isGuest = guestLevels.has(String(m.id))
        // "Guests" bucket: every guest player (guest_level > 0), team-independent.
        if (guestsOnly && isGuest) return true
        // Team bucket: CORE (non-guest) members of a selected team. Guests
        // borrowed onto a team are deliberately excluded here — they live in
        // the separate "Guests" bucket — so filtering "H3" shows H3's own
        // roster rather than H3 + everyone borrowed onto it.
        if (teamFilterActive && !isGuest && memberInSelectedTeams(effectiveTeamsByMember.get(String(m.id)))) return true
        return false
      })
    : rosterMembers

  // Roles narrow ON TOP of the team/guest selection (AND), so "D1" + "Coach"
  // reads as "D1's coaches" rather than "D1 plus every coach in the club".
  // Within the role dropdown itself the selections are OR-ed, like teams.
  const memberList: Member[] = roleFilterActive
    ? teamFilteredMembers.filter((m) => [...selectedRoles!].some((r) => memberMatchesRole(m, r)))
    : teamFilteredMembers

  // For regular (non-session) mode, filter by session tab if active
  const { participations: regularParticipations, isLoading: regularLoading } = useTeamParticipations(
    activityType,
    activityId ?? '',
    isClubWide ? [] : rosterMemberIds, // skip for club-wide (we use clubWideParticipations)
    hasSessionMode ? (activeSessionTab ?? undefined) : undefined,
  )

  // For session mode overall tab: fetch ALL participations across sessions
  const { participations: allParticipations, isLoading: allLoading } = useAllEventParticipations(
    hasSessionMode && activeSessionTab === null && !isClubWide ? (activityId ?? '') : '',
    isClubWide ? [] : rosterMemberIds,
  )

  const participations = isClubWide
    ? clubWideParticipations
    : hasSessionMode && activeSessionTab === null
      ? allParticipations
      : regularParticipations
  const participationsLoading = isClubWide
    ? clubWidePartsLoading
    : hasSessionMode && activeSessionTab === null
      ? allLoading
      : regularLoading
  const isLoading = (isClubWide ? clubWideLoading || clubWidePartsLoading : membersLoading) || participationsLoading

  // O(1) participation lookups per member — avoids the O(members × participations)
  // linear scans in getMemberStatus / statusLabelText / the per-row render.
  // `first`   = first row per member (any), mirrors `.find(p => p.member === id)`.
  // `preferred` = non-staff row if present else the first row, mirrors
  //              `.find(non-staff) ?? .find(any)` used for visible/edited status.
  const participationByMember = useMemo(() => {
    const first = new Map<string, Participation>()
    const preferred = new Map<string, Participation>()
    for (const p of participations) {
      if (!first.has(p.member)) first.set(p.member, p)
      if (!p.is_staff && !preferred.has(p.member)) preferred.set(p.member, p)
    }
    for (const [member, p] of first) {
      if (!preferred.has(member)) preferred.set(member, p)
    }
    return { first, preferred }
  }, [participations])

  // Session-mode events (per_day / per_session) keep ONE row per (member,
  // session) — `session_id` is part of the row's identity — so every staff
  // write has to say which day it means:
  //
  //   • CREATE must carry `session_id`. Without it Directus writes a
  //     session-less row that no per-day view can see (they all key off
  //     `session_id`), so the roster still reads "Not responded" — it looks
  //     like the RSVP never saved. The next attempt then 400s on migration
  //     246's `(activity_type, activity_id, member) WHERE session_id IS NULL`
  //     partial unique. Cost: 3 invisible orphan rows on the Trainingsweekend.
  //   • The lookup must ignore other sessions' rows. `regularParticipations` is
  //     already session-filtered, but the club-wide fetch is NOT — an unscoped
  //     `.find` would grab Saturday's row while the coach is editing Friday and
  //     silently flip the wrong day.
  const activeSessionId = hasSessionMode && activeSessionTab ? activeSessionTab : null
  const isOverallSessionTab = !!hasSessionMode && activeSessionTab === null

  // The rows a single edit writes to. On a day tab (or a non-session activity)
  // that's exactly one row; on the Overall tab of a per-day event it's every
  // day at once, so a leader doesn't have to walk the tabs repeating the same
  // answer. Each day still gets its OWN row — that is the storage model — this
  // only fans the write out. Same shape as `setAll` in EventCard's session
  // control. `participations` is `allParticipations` on the Overall tab, so the
  // existing rows for every day are already in hand. Decision logic lives in
  // `utils/participationSessions.ts` (unit-tested there).
  // Staff-only leaders are NOT in `participations` — that fetch is
  // `member IN <roster ids>` and they have no `member_teams` row — so their
  // rows come from the separate `is_staff` query. Edits have to see both pools:
  // without the staff rows a save can't find the existing row, so every click
  // CREATEs and hits migration 246's partial unique.
  const editableParticipations = useMemo(
    () => (staffParticipationRows.length > 0 ? [...participations, ...staffParticipationRows] : participations),
    [participations, staffParticipationRows],
  )
  // Members rendered in the Staff section — the roster's own writers pass
  // `is_staff: false`, and a row created for one of these people has to carry
  // `true` or it lands in the player tally.
  const staffMemberIdSet = useMemo(
    () => new Set(staffMembers.map((m) => String(m.id))),
    [staffMembers],
  )

  const sessionTargets = useCallback(
    (memberId: string): SessionTarget[] => resolveSessionTargets(memberId, editableParticipations, {
      isOverall: isOverallSessionTab,
      activeSessionId,
      sessions: eventSessions,
    }),
    [editableParticipations, isOverallSessionTab, activeSessionId, eventSessions],
  )

  // Staff-side note edit. Creates a participation row with `status: null` if
  // none exists yet (lets a coach attach context like "Out for the season"
  // to a player who hasn't RSVPed). Saving an empty string explicitly
  // clears the note AND suppresses the absence-reason fallback in the
  // display — without that, clearing a row whose note was never set
  // visually leaves the absence reason showing because the row's `.note`
  // stayed null/undefined and the fallback re-applied.
  const handleNoteChange = useCallback(async (memberId: string, newNote: string) => {
    if (!activityId) return
    const trimmed = (newNote ?? '').trim()
    const changes = noteWrites(sessionTargets(memberId), trimmed)
    if (changes.length === 0) return

    setSavingMemberIds(prev => new Set(prev).add(memberId))
    try {
      await Promise.all(changes.map(({ sessionId, row }) => row
        ? update(row.id, { note: trimmed })
        : create({
            member: memberId,
            activity_type: activityType,
            activity_id: activityId,
            status: null as unknown as Participation['status'],
            note: trimmed,
            guest_count: 0,
            is_staff: staffMemberIdSet.has(String(memberId)),
            ...(sessionId ? { session_id: sessionId } : {}),
          })))
    } catch {
      // useMutation handles logging; UI reverts via refetch
    } finally {
      setSavingMemberIds(prev => {
        const next = new Set(prev)
        next.delete(memberId)
        return next
      })
    }
  }, [activityId, activityType, sessionTargets, staffMemberIdSet, create, update])

  const handleStatusChange = useCallback(async (memberId: string, newStatus: string) => {
    setEditingMemberId(null)
    if (!activityId) return

    const targets = sessionTargets(memberId)
    const changes = statusWrites(targets, newStatus)
    if (changes.length === 0) return
    // Only "already confirmed" suppresses the late-signin prompt below; on the
    // Overall tab that means confirmed on EVERY day.
    const wasConfirmed = allConfirmed(targets)

    setSavingMemberIds(prev => new Set(prev).add(memberId))
    try {
      await Promise.all(changes.map(({ sessionId, row }) => {
        // Clear → delete the record; otherwise update in place or create one.
        if (newStatus === '') return row ? remove(row.id) : undefined
        if (row) return update(row.id, { status: newStatus })
        return create({
          member: memberId,
          activity_type: activityType,
          activity_id: activityId,
          status: newStatus,
          note: '',
          guest_count: 0,
          is_staff: staffMemberIdSet.has(String(memberId)),
          ...(sessionId ? { session_id: sessionId } : {}),
        })
      }))

      // Late-signin fine prompt — pop AFTER the participation update has
      // succeeded so the leader's RSVP edit is already saved if they skip the
      // fine prompt. Conditions: leader-driven confirm (not self), single-team
      // activity with a late_signin rule, and we're past respondBy.
      if (
        newStatus === 'confirmed'
        && !wasConfirmed
        && canEditRoster
        && singleTeamId
        // Staff aren't on the roster the fine would be issued against — a
        // late-signin fine is a player rule, not a coach one.
        && !staffMemberIdSet.has(String(memberId))
        && lateSigninRuleEnabled
        && respondBy
        && new Date() > new Date(respondBy)
        && String(memberId) !== String(currentUserId ?? '')
      ) {
        const member = members.find((mm) => mm.id === memberId)
          ?? clubWideMembers.find((mm) => mm.id === memberId)
          ?? staffMembers.find((mm) => mm.id === memberId)
        const memberName = member
          ? `${member.first_name ?? ''} ${member.last_name ?? ''}`.trim() || `#${memberId}`
          : `#${memberId}`
        setLateConfirmFor({ memberId, memberName, teamId: singleTeamId })
      }
    } catch {
      // useMutation logs the error; UI reverts via refetch
    } finally {
      setSavingMemberIds(prev => {
        const next = new Set(prev)
        next.delete(memberId)
        return next
      })
    }
  }, [activityId, activityType, sessionTargets, staffMemberIdSet, create, update, remove, canEditRoster, singleTeamId, lateSigninRuleEnabled, respondBy, currentUserId, members, clubWideMembers, staffMembers])

  // Staff participations (coaches/team_responsible who aren't in member_teams).
  // Use `useCollection` so the modal auto-refreshes when any staff member
  // RSVPs — the create/update mutations invalidate the 'participations'
  // collection key, which also matches this query.
  const { data: staffPartsRaw } = useCollection<Participation>('participations', {
    all: true,
    enabled: !!user && open && !!activityId && !isClubWide,
    filter: {
      _and: [
        { activity_type: { _eq: activityType } },
        { activity_id: { _eq: activityId } },
        { is_staff: { _eq: true } },
      ],
    },
  })

  // Resolve staff member objects (for display) when the staff participation
  // set changes. Seeds from BOTH (a) existing is_staff participation rows,
  // and (b) the team's coach + team_responsible junctions — so leaders who
  // haven't RSVPed yet still appear in the staff section (otherwise a coach
  // like Michelle Howald, who has no `member_teams` row and no participation
  // row yet, is invisible to roster managers).
  //
  // The synchronous half (derive the staff-only participation rows + the member
  // IDs to resolve) runs during render via React's adjust-state-while-rendering
  // pattern; only the network call stays in an effect. Two things this preserves
  // exactly:
  //   * the guard is a bare `return` — when the modal is closed or club-wide we
  //     do NOT clear `staffMembers` / `staffParticipationRows` (the rows must
  //     survive the close animation and the club-wide path, which has its own
  //     source), whereas the fetch's `.catch` DOES clear both. That asymmetry is
  //     kept verbatim.
  //   * the trigger set is the old dep array (raw queries, not the derived
  //     `leadershipRoles` Map — see WIEDISYNC-3Y note below), compared by
  //     identity, so the fetch fires exactly when it used to.
  // `staffFetchIds` (null = nothing to fetch) is what carries the derived IDs
  // from render into the effect, so the two halves can't drift apart.
  const staffDeps = [open, activityId, activityType, isClubWide, rosterMemberIds.join(','), staffPartsRaw, teamsRaw] as const
  const [prevStaffDeps, setPrevStaffDeps] = useState<readonly unknown[] | null>(null)
  const [staffFetchIds, setStaffFetchIds] = useState<string[] | null>(null)
  if (prevStaffDeps === null || staffDeps.some((v, i) => !Object.is(v, prevStaffDeps[i]))) {
    setPrevStaffDeps(staffDeps)
    // Guard: bare return — deliberately does not clear the staff state.
    if (user && open && activityId && !isClubWide) {
      const staffParts = staffPartsRaw ?? []
      const memberIdSet = new Set(rosterMemberIds.map(String))
      const staffOnlyParts = staffParts.filter((p) => !memberIdSet.has(String(p.member)))
      setStaffParticipationRows(staffOnlyParts)

      const leadershipIds: string[] = []
      for (const [id, role] of leadershipRoles) {
        // captain is normally in member_teams already; only coach + TR
        // typically live outside the regular roster
        if ((role === 'coach' || role === 'tr') && !memberIdSet.has(String(id))) {
          leadershipIds.push(String(id))
        }
      }
      const staffMemberIds = [...new Set([
        ...leadershipIds,
        ...staffOnlyParts.map((p) => String(p.member)),
      ])]

      if (staffMemberIds.length === 0) {
        setStaffMembers([])
        setStaffFetchIds(null)
      } else {
        // New array identity on every trigger → the effect re-fetches exactly as
        // often as the old effect did (it also refetched on every dep change).
        setStaffFetchIds(staffMemberIds)
      }
    }
  }

  // Depend on the raw teams query rather than the derived `leadershipRoles`
  // Map: when teamIds is empty, `teams = teamsRaw ?? []` is a fresh array
  // literal each render, which makes the `leadershipRoles` useMemo identity
  // unstable and re-fires this effect on every render → mobile Vaul Drawer
  // setState → render → setState loop (WIEDISYNC-3Y). Hence `staffDeps` above
  // keys on `teamsRaw` / `staffPartsRaw`, and this effect only on the derived IDs.
  useEffect(() => {
    if (!staffFetchIds || staffFetchIds.length === 0) return
    fetchAllItems<Member>('members', {
      filter: { id: { _in: staffFetchIds } },
      // `user` is required so getEditAttribution() can suppress the
      // "Edited by …" line when a coach/TR edits their own row.
      fields: ['id', 'nickname', 'first_name', 'last_name', 'photo', 'user'],
    })
      .then((members) => setStaffMembers(members.sort(byFirstThenLastName)))
      .catch(() => {
        setStaffMembers([])
        setStaffParticipationRows([])
      })
  }, [staffFetchIds])

  // For the overall tab, compute per-member session counts. Staff are included
  // from their own row pool so the Staff section gets the same "1/2 confirmed"
  // badge (and the same all-days pencil) as the roster.
  const memberSessionCounts = useMemo(() => {
    if (!hasSessionMode || activeSessionTab !== null) return new Map<string, { confirmed: number; total: number }>()
    const map = new Map<string, { confirmed: number; total: number }>()
    const totalSessions = eventSessions!.length
    const countFrom = (rows: Participation[], memberId: string) => {
      const mine = rows.filter((p) => String(p.member) === String(memberId))
      map.set(memberId, { confirmed: mine.filter((p) => p.status === 'confirmed').length, total: totalSessions })
    }
    for (const m of memberList) countFrom(allParticipations, m.id)
    for (const m of staffMembers) countFrom(staffParticipationRows, String(m.id))
    return map
  }, [hasSessionMode, activeSessionTab, eventSessions, memberList, allParticipations, staffMembers, staffParticipationRows])

  // Fetch absences overlapping activity date (same pattern as AttendanceSheet).
  // Keyed on the full roster (not the team-filtered list) so switching teams
  // reuses the already-loaded absences instead of refetching.
  const memberIdsKey = rosterMemberIds.join(',')
  // Promise-chain (not async/await) on purpose: this runs from an effect, and
  // `setAbsences` must land in a callback rather than in the effect's own
  // synchronous continuation. Same request, same result.
  const fetchAbsences = useCallback(() => {
    if (!user || !activityDate || rosterMemberIds.length === 0) return
    const dateStr = activityDate.split(' ')[0]
    fetchAllItems<Absence>('absences', {
      filter: {
        _and: [
          { member: { _in: rosterMemberIds } },
          { start_date: { _lte: dateStr } },
          { end_date: { _gte: dateStr } },
        ],
      },
    })
      .then(setAbsences)
      .catch(() => { /* ignore */ })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, activityDate, memberIdsKey])

  useEffect(() => {
    if (user && open && activityDate) fetchAbsences()
  }, [user, open, fetchAbsences, activityDate])

  // Members who are both players (in memberList) and staff (coach/TR) should be
  // treated as players — their is_staff participation counts as player participation.
  const memberIdSet = new Set(memberList.map(m => m.id))

  // Best-status priority for member-level dedupe; mirrors ParticipationSummary.
  const statusPriority: Record<string, number> = { confirmed: 4, tentative: 3, waitlisted: 2, declined: 1 }

  // Player participations: aligned with `ParticipationSummary` (card-row
  // source of truth) so the modal counts and the card counts can't drift.
  // Algorithm:
  //   1. Dedupe by `p.member`, keeping the best-status row per member
  //      (confirmed > tentative > waitlisted > declined). A player who
  //      somehow has both a player-RSVP row AND an `is_staff` row for
  //      the same training collapses to one entry.
  //   2. Drop `is_staff` rows from the player tally — those are
  //      coach/TR presence markers, not player RSVPs. Player-coaches
  //      get counted via `playerCoachConfirmed` further down.
  //   3. Restrict to members currently on the roster (`memberIdSet`),
  //      so a confirmed RSVP from an excluded guest can't leak in.
  // Pre-fix this filter was `!p.is_staff || memberIdSet.has(p.member)`
  // which both let excluded guests through AND double-counted player-
  // coaches with two rows — surfacing as "14 Confirmed" while the card
  // and the visible roster both showed 13.
  const playerParticipations = (() => {
    const byMember = new Map<string, Participation>()
    for (const p of participations) {
      if (!memberIdSet.has(p.member)) continue
      const existing = byMember.get(p.member)
      if (!existing || (statusPriority[p.status] ?? 0) > (statusPriority[existing.status] ?? 0)) {
        byMember.set(p.member, p)
      }
    }
    return Array.from(byMember.values()).filter(p => !p.is_staff)
  })()

  // For the overall tab on multi-session events, deduplicate by member so summary
  // counts reflect unique people, not slot-count. (`statusPriority` declared above
  // for the `playerParticipations` dedupe; reused here for multi-session collapse.)
  const summaryParticipations = (hasSessionMode && activeSessionTab === null)
    ? (() => {
        const byMember = new Map<string, Participation>()
        for (const p of playerParticipations) {
          const existing = byMember.get(p.member)
          if (!existing || (statusPriority[p.status] ?? 0) > (statusPriority[existing.status] ?? 0)) {
            byMember.set(p.member, p)
          }
        }
        return Array.from(byMember.values())
      })()
    : playerParticipations

  const confirmedParts = summaryParticipations.filter(p => p.status === 'confirmed')
  const confirmed = confirmedParts.length
  const confirmedGuests = confirmedParts.reduce((sum, p) => sum + (p.guest_count ?? 0), 0)
  const tentativeParts = summaryParticipations.filter(p => p.status === 'tentative')
  const tentative = tentativeParts.length
  const tentativeGuests = tentativeParts.reduce((sum, p) => sum + (p.guest_count ?? 0), 0)
  // Count absent members without a participation record as declined too.
  // Only consider absences that actually cover this activity (date range +
  // day-of-week for weekly + affects bitmap) — `absences` is fetched only
  // by date range, so weekly Mon-only absences would otherwise mark members
  // absent on Tuesdays.
  const coveringAbsenceByMember = new Map<string, Absence>()
  for (const a of absences) {
    if (activityDate && absenceCoversActivity(a, activityType, activityDate)) {
      coveringAbsenceByMember.set(String(a.member), a)
    }
  }
  const absentMemberIds = new Set(coveringAbsenceByMember.keys())
  const absentWithoutParticipation = memberList.filter(m =>
    absentMemberIds.has(String(m.id)) && !summaryParticipations.some(p => String(p.member) === String(m.id))
  ).length
  const declined = summaryParticipations.filter(p => p.status === 'declined').length + absentWithoutParticipation
  const waitlistedParts = summaryParticipations.filter(p => p.status === 'waitlisted')
    .sort((a, b) => (a.waitlisted_at ?? '').localeCompare(b.waitlisted_at ?? ''))
  const waitlisted = waitlistedParts.length
  const notResponded = memberList.length - summaryParticipations.length - absentWithoutParticipation
  const totalGuests = confirmedGuests + tentativeGuests

  // Staff participations come from the dedicated fetch above. The main
  // `participations` array is filtered by `member IN <roster ids>` at query
  // time (see `useTeamParticipations`), so a coach not in member_teams
  // won't appear there even if they have an `is_staff=true` row.
  const staffParticipations = staffParticipationRows.filter(p => !memberIdSet.has(p.member))
  // When a team filter is active, narrow the staff section to coaches / TR of a
  // selected team. Staff with no resolvable team (e.g. a manually-added
  // is_staff RSVP by a non-leader) are hidden while filtering — they can't be
  // attributed to the selected team(s).
  const staffMemberInSelectedTeams = (id: string): boolean =>
    memberInSelectedTeams([...(leadershipTeamsByMember.get(String(id)) ?? effectiveTeamsByMember.get(String(id)) ?? [])])
  // Never list a player-coach in the staff section: they already appear in the
  // player list with a "(Coach)" badge (and their confirmed player row feeds
  // "Staff present"). `staffMembers` is seeded async from the coach/TR
  // junctions and can momentarily carry a leader before the roster loads;
  // without this render-time exclusion that leader lingers as a duplicate
  // "(Staff) — No response" row (surfaced for member 8 on the Trainingsweekend
  // export). `visibleStaffParticipations` already excludes roster members via
  // `staffParticipations`; this brings the member-object list in line.
  const visibleStaffMembers = (teamFilterActive
    ? staffMembers.filter((sm) => staffMemberInSelectedTeams(sm.id))
    : staffMembers
  ).filter((sm) => !memberIdSet.has(String(sm.id)))
  const visibleStaffParticipations = teamFilterActive
    ? staffParticipations.filter((p) => staffMemberInSelectedTeams(p.member))
    : staffParticipations
  // "Coach present" = staff-only confirmed + player-coaches confirmed (coach only — captain/TR don't count).
  // Player-coach lookup walks the FULL participations list (not `summaryParticipations`,
  // which now excludes `is_staff` rows): a coach who has only an `is_staff` confirmed
  // marker would otherwise lose their badge after the v4.6.7 dedupe tightening.
  // Set-based dedupe so a coach with both player + staff confirmed rows counts once.
  // Per-day events keep one row per (member, day), so counting ROWS would report
  // a coach who said yes to both weekend days as two people. Scoped to the day in
  // view; the Overall tab counts anyone confirmed on at least one day.
  const staffConfirmedIds = new Set<string>()
  for (const p of visibleStaffParticipations) {
    if (p.status !== 'confirmed') continue
    if (activeSessionId && String(p.session_id ?? '') !== String(activeSessionId)) continue
    staffConfirmedIds.add(String(p.member))
  }
  const staffOnlyConfirmed = staffConfirmedIds.size
  const playerCoachConfirmedIds = new Set<string>()
  for (const p of participations) {
    if (p.status === 'confirmed' && memberIdSet.has(p.member) && leadershipRoles.get(p.member) === 'coach') {
      playerCoachConfirmedIds.add(p.member)
    }
  }
  const playerCoachConfirmed = playerCoachConfirmedIds.size
  const staffConfirmed = staffOnlyConfirmed + playerCoachConfirmed

  const deadlinePassed = respondBy
    ? getDeadlineDate(respondBy, activityStartTime) < new Date()
    : false

  function getInitials(member: Member) {
    return `${memberFirstName(member)[0] ?? ''}${(member.last_name ?? '')[0] ?? ''}`.toUpperCase()
  }

  function getMemberStatus(memberId: string): Participation['status'] | null {
    // Prefer the player (non-staff) row — for player-coaches who carry both an
    // `is_staff` presence marker and a separate player RSVP, the player row is
    // what the roster modal is rendering ("did this person say they're coming
    // as a player?"). Matches the dedupe applied to `playerParticipations` so
    // visible-list status, summary counts, and export rows stay coherent.
    const p = participationByMember.preferred.get(memberId)
    // Explicit user RSVP wins over an absence overlay: the BEFORE UPDATE
    // trigger (migration 038) clears `auto_declined_by` to NULL the moment a
    // user changes `status`, so a row with a null marker is definitively
    // user-owned — its status is sacred even if a covering absence still
    // exists. Only fall back to the absence-driven decline when there is no
    // participation row, OR the row was last touched by the auto-decline
    // hook (marker still set).
    if (p && p.auto_declined_by == null) return p.status
    if (coveringAbsenceByMember.has(String(memberId))) return 'declined'
    return p?.status ?? null
  }

  const reasonLabels: Record<string, string> = {
    injury: ta('reasonInjury'),
    vacation: ta('reasonVacation'),
    work: ta('reasonWork'),
    personal: ta('reasonPersonal'),
    other: ta('reasonOther'),
  }

  function getMemberAbsenceReason(memberId: string): string | null {
    const absence = coveringAbsenceByMember.get(String(memberId))
    if (!absence) return null
    // Weekly absences are recurring "every Wednesday I work late" type
    // patterns — the user's reason field on those typically defaults to
    // 'other' because none of the one-off reasons (injury / vacation /
    // work / personal) really fit a recurring schedule conflict.
    // Surface the absence TYPE for weekly absences instead of the reason
    // string ("Weekly unavailability" reads as actual information; "Other"
    // reads as "we don't know").
    if (absence.type === 'weekly') {
      return ta('weeklyUnavailability')
    }
    return reasonLabels[absence.reason] ?? null
  }

  // Session-scoped, like the player rows: an unscoped `.find` hands back
  // whichever day happens to sit first in the fetch, so Saturday's answer would
  // render on Sunday's tab. On the Overall tab a shared answer shows only when
  // every day agrees (mixed → blank, the row's own badge carries the counts).
  function getStaffMemberStatus(memberId: string): Participation['status'] | null {
    const targets = sessionTargets(memberId)
    if (isOverallSessionTab) {
      return (uniformValue(targets, 'status') || null) as Participation['status'] | null
    }
    return targets[0]?.row?.status ?? null
  }

  /**
   * Does one person belong under the active status chip?
   *
   * Shared by the roster block, the waitlist section and the Staff section —
   * the chip's own count is roster-only, so a section that ignored the filter
   * put a row on screen the count did not include ("No response (6)" listing a
   * confirmed coach as the 7th row). `waitlisted` deliberately matches no chip:
   * the filter offers Confirmed / Maybe / Declined / No response, so a
   * waitlisted player only belongs under "All".
   */
  const matchesStatusFilter = (status: Participation['status'] | null, memberId: string): boolean => {
    if (statusFilter === null) return true
    if (statusFilter === 'confirmed') return status === 'confirmed'
    if (statusFilter === 'tentative') return status === 'tentative'
    // An absence with no participation row of its own reads as declined —
    // mirrors `absentWithoutParticipation` in the counts above.
    if (statusFilter === 'declined') return status === 'declined' || (absentMemberIds.has(String(memberId)) && !participations.some(p => String(p.member) === String(memberId)))
    if (statusFilter === 'no_response') return status === null && !absentMemberIds.has(String(memberId))
    return true
  }

  const filteredMemberList = useMemo(() => {
    if (statusFilter === null) return memberList
    return memberList.filter((m) => matchesStatusFilter(getMemberStatus(m.id), m.id))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, memberList, participations, absences])

  // Same narrowing for the two sections that render below the roster block.
  const filteredStaffMembers = statusFilter === null
    ? visibleStaffMembers
    : visibleStaffMembers.filter((sm) => matchesStatusFilter(getStaffMemberStatus(sm.id), sm.id))
  const filteredWaitlistedParts = statusFilter === null
    ? waitlistedParts
    : waitlistedParts.filter((wp) => matchesStatusFilter('waitlisted', wp.member))

  // ---- Edit attribution (migration 046) ------------------------------------
  // Map directus_users.id → display name for the "Edited by …" line. Seeded
  // from the team's own roster + staff so most edits resolve without an extra
  // query; supplemented by `externalEditorNames` below for editor IDs that
  // belong to people outside this team (e.g. an admin editing the roster from
  // another team's perspective). Cheap rebuild because `members` only changes
  // when the team set or roster shape changes.
  const [externalEditorNames, setExternalEditorNames] = useState<Map<string, string>>(new Map())

  // Short display names: first name only, disambiguated with last-name initials.
  // Declared here rather than next to its render sites because the attribution
  // map below is keyed off it.
  const displayNames = useMemo(
    () => disambiguateFirstNames([...memberList, ...staffMembers]),
    [memberList, staffMembers],
  )

  // Editor labels for the "Edited by …" lines. These used to spell out the full
  // legal name while the row above them showed only "Aaliyah" — two different
  // naming conventions two lines apart. Everyone on the roster now reads with the
  // exact label their own row carries; an editor from outside the roster (an
  // admin, a coach of another team) gets the same shape, first name + last
  // initial, built in the fetch below.
  const editorNameByUserId = useMemo(() => {
    const m = new Map<string, string>()
    const all = [...memberList, ...staffMembers]
    for (const member of all) {
      if (!member.user) continue
      m.set(member.user, displayNames.get(String(member.id)) || memberFirstName(member) || t('staffFallback', { defaultValue: 'Staff' }))
    }
    for (const [uid, label] of externalEditorNames) {
      if (!m.has(uid)) m.set(uid, label)
    }
    return m
  }, [memberList, staffMembers, displayNames, externalEditorNames, t])

  // Fetch display names for editor user IDs that don't belong to anyone on
  // the roster — typically admins (or coaches of a different team) editing
  // from outside. Without this, attribution rows fall back to "Staff", which
  // is what surfaced in WIEDISYNC roster screenshots showing
  // "Edited to Maybe by Staff".
  useEffect(() => {
    if (!open || !user) return
    const known = new Set<string>()
    for (const m of memberList) if (m.user) known.add(m.user)
    for (const m of staffMembers) if (m.user) known.add(m.user)
    for (const [uid] of externalEditorNames) known.add(uid)
    const missing = new Set<string>()
    for (const p of participations) {
      if (p.last_status_edited_by && !known.has(p.last_status_edited_by)) missing.add(p.last_status_edited_by)
      if (p.last_note_edited_by && !known.has(p.last_note_edited_by)) missing.add(p.last_note_edited_by)
    }
    if (missing.size === 0) return
    const ids = [...missing]
    fetchAllItems<Member>('members', {
      filter: { user: { _in: ids } },
      // `nickname` so an outside editor reads under the same name the app shows
      // them by everywhere else (migration 215).
      fields: ['user', 'nickname', 'first_name', 'last_name'],
    })
      .then((rows) => {
        if (rows.length === 0) return
        setExternalEditorNames((prev) => {
          const next = new Map(prev)
          for (const r of rows) {
            const uid = (r as Member & { user?: string }).user
            if (!uid || next.has(uid)) continue
            const label = editorLabelFor(r)
            if (label) next.set(uid, label)
          }
          return next
        })
      })
      .catch(() => {
        // Silent: falling back to the generic "Staff" label is acceptable.
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, participations, memberList, staffMembers])

  /** Returns per-field attribution lines (migration 047).
   *  - `status`: surfaced when `last_status_edited_by` differs from the
   *    member's own `user` field (third-party staff status edit).
   *  - `note`: same logic, against `last_note_edited_*`.
   *  Either side may be null independently; a row can show only the note
   *  attribution if the coach edited the note while the player set their
   *  own status. Members with no linked directus_users account (shell
   *  records) can't self-edit, so any populated tracker is by definition a
   *  staff edit. */
  function getEditAttribution(member: Member, p: Participation | null): {
    status: { name: string; status: string; at: string } | null
    note: { name: string; at: string } | null
  } {
    const editorName = (uid: string) =>
      editorNameByUserId.get(uid) ?? t('staffFallback', { defaultValue: 'Staff' })
    // App-wide format: `dd.mm.yyyy, HH:MM` (Swiss dot date + 24h time).
    // formatDateTimeCompact (= formatDateCompactZurich + formatTimeZurich)
    // is hardcoded to `de-CH` so the format is uniform regardless of the
    // user's browser language. See `INFRA.md → Time & Date Formatting`.
    const fmtAt = (iso: string) => formatDateTimeCompact(iso)
    let statusAttr: { name: string; status: string; at: string } | null = null
    let noteAttr: { name: string; at: string } | null = null
    if (p?.last_status_edited_by && p.last_status_edited_at && (!member.user || member.user !== p.last_status_edited_by)) {
      statusAttr = {
        name: editorName(p.last_status_edited_by),
        status: statusLabelText(member.id, p.status ?? null),
        at: fmtAt(p.last_status_edited_at),
      }
    }
    if (p?.last_note_edited_by && p.last_note_edited_at && (!member.user || member.user !== p.last_note_edited_by)) {
      noteAttr = {
        name: editorName(p.last_note_edited_by),
        at: fmtAt(p.last_note_edited_at),
      }
    }
    return { status: statusAttr, note: noteAttr }
  }

  // ---- Export ---------------------------------------------------------------
  const printRef = useRef<HTMLDivElement>(null)
  const [exporting, setExporting] = useState<null | 'csv' | 'png' | 'pdf'>(null)

  function statusLabelText(memberId: string, baseStatus: Participation['status'] | null): string {
    if (!baseStatus) return t('notResponded')
    // Only render the absence-flavoured label when the decline was actually
    // driven by the absence: row missing, or row still carries the auto
    // marker (cron wrote it). A user-set status overrides absence overlay.
    const p = participationByMember.first.get(memberId)
    const isAbsenceDecline = absentMemberIds.has(memberId) && baseStatus === 'declined' && (p == null || p.auto_declined_by != null)
    if (isAbsenceDecline) {
      const isWeekly = coveringAbsenceByMember.get(String(memberId))?.type === 'weekly'
      return t(isWeekly ? 'declinedUnavailable' : 'declinedAbsence')
    }
    // A row the deadline sweep wrote (migration 352) would otherwise read as a
    // flat "Declined", which is exactly the wrong story: this member never said
    // anything at all, and the late_signin fine hanging off it is for the
    // silence, not for a refusal the coach could have planned around. Checked
    // AFTER the absence branch — a covering absence is the better explanation
    // when a later absence lands on top of a swept row and both markers stand.
    if (baseStatus === 'declined' && p?.auto_declined_deadline) return t('declinedNoResponse')
    return t(baseStatus)
  }

  /** The name printed on an exported row. The SAME label the on-screen roster
   *  shows — first name, with just enough of the surname to tell two people
   *  apart — so a PDF handed round the club reads like the list it was taken
   *  from, and nobody's full legal name leaves the app on a shared document. */
  function exportName(m: Member, role?: string): string {
    const base = displayNames.get(String(m.id)) || memberFirstName(m) || (m.last_name ?? '').trim()
    const suffix = role === 'coach' ? ` (${t('roleCoach')})` : role === 'captain' ? ` (${t('roleCaptainAbbr')})` : role === 'tr' ? ` (${t('roleTeamRespAbbr')})` : ''
    return base + suffix
  }

  const translatePositions = useCallback((positions: string[] | undefined): string => {
    return (positions ?? []).map((p) => {
      const key = getPositionI18nKey(p)
      return key ? tt(key) : p
    }).join(', ')
  }, [tt])

  // Ordered session list for the export's per-day breakdown — only populated on
  // the Overall tab of a per-day / per-session event. `eventSessions` already
  // arrives sorted (parent sorts by sort_order/date/start_time); re-sorted
  // defensively so the export columns are stable regardless of caller.
  const exportSessions = useMemo(() => {
    if (!hasSessionMode || activeSessionTab !== null) return null
    return [...(eventSessions ?? [])].sort(
      (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
        || (a.date ?? '').localeCompare(b.date ?? '')
        || (a.start_time ?? '').localeCompare(b.start_time ?? ''),
    )
  }, [hasSessionMode, activeSessionTab, eventSessions])

  // memberId → sessionId → non-staff participation, for the per-day export cells.
  // Sourced from `participations` (which on the Overall tab holds every session's
  // rows, whether team-scoped or club-wide) so each member's per-day status is
  // resolvable without an extra fetch.
  const sessionParticipationByMember = useMemo(() => {
    const map = new Map<string, Map<string, Participation>>()
    if (!exportSessions) return map
    for (const p of participations) {
      if (p.is_staff || !p.session_id) continue
      let inner = map.get(String(p.member))
      if (!inner) { inner = new Map(); map.set(String(p.member), inner) }
      inner.set(String(p.session_id), p)
    }
    return map
  }, [exportSessions, participations])

  const exportRows = useMemo<RosterExportRow[]>(() => {
    const formatAttribution = (member: Member, p: Participation | null): string => {
      const { status: statusAttr, note: noteAttr } = getEditAttribution(member, p)
      const lines: string[] = []
      if (statusAttr) lines.push(t('editedByOn', { defaultValue: 'Edited to {{status}} by {{name}} on {{at}}', ...statusAttr }))
      if (noteAttr) lines.push(t('noteEditedByOn', { defaultValue: 'Note edited by {{name}} on {{at}}', ...noteAttr }))
      return lines.join('\n')
    }
    // Map memberId → guest_level from the `members` (member_teams junction)
    // prop. Used to suffix `(Guest)` on roster exports so a coach scanning a
    // PDF can tell at a glance which entries are guest players from another
    // team rather than core roster.
    const guestLevelByMember = new Map<string, number>()
    for (const mt of members) {
      const lvl = Number((mt as { guest_level?: number }).guest_level ?? 0)
      const mid = String(asObj<Member>(mt.member)?.id ?? '')
      if (mid) guestLevelByMember.set(mid, lvl)
    }
    const isGuestMember = (m: Member): boolean => (guestLevelByMember.get(String(m.id)) ?? 0) > 0
    // Per-day status list for a member on the Overall tab of a session event.
    // Undefined when not a session-overall export → callers fall back to the
    // single-status column.
    const buildSessionStatuses = (memberId: string): RosterExportRow['sessionStatuses'] => {
      if (!exportSessions) return undefined
      const inner = sessionParticipationByMember.get(String(memberId))
      return exportSessions.map((s) => {
        const st = inner?.get(String(s.id))?.status ?? null
        return { label: formatSessionLabel(s), status: st, statusLabel: st ? t(st) : t('notResponded') }
      })
    }
    // Team label for the export's Team column + grouping. Players come from the
    // roster junction, staff from the coach/TR junctions (they have no
    // `member_teams` row). Empty for club-wide activities — there is no team.
    const teamLabel = (memberId: string, staff = false): string => {
      const ids = staff
        ? [...(leadershipTeamsByMember.get(String(memberId)) ?? [])]
        : (teamsByMember.get(String(memberId)) ?? [])
      const names = ids
        .map((tid) => teamNameById.get(String(tid)))
        .filter((n): n is string => !!n)
      return [...new Set(names)].sort().join(', ')
    }
    // Guest players are marked in the NAME, next to the coach / captain / TR
    // suffixes — the export used to carry a separate ✓ column saying the same
    // thing beside a "Guests" (plus-ones) column, which read as a duplicate.
    const nameWithGuest = (m: Member, role?: string): string =>
      exportName(m, role) + (isGuestMember(m) ? ` (${t('guestBadge')})` : '')
    // Grouped by team, then alphabetically inside each team. Single-team exports
    // are unaffected (one group), so this is just the row sort with a leading
    // key. Guests sort under their host team like anyone else.
    //
    // Sorted by FIRST name, matching the on-screen list: the export used to sort
    // by surname because it printed surnames, and a surname sort over a column
    // that now reads "Aaliyah" / "Aditya" is a sort on an invisible key — the
    // reader just sees an unordered list.
    const byTeamThenName = (a: Member, b: Member) => {
      const cmp = teamLabel(a.id).localeCompare(teamLabel(b.id), undefined, { sensitivity: 'base' })
      return cmp !== 0 ? cmp : byFirstThenLastName(a, b)
    }
    const sortedMembers = [...filteredMemberList].sort(byTeamThenName)
    const rows: RosterExportRow[] = sortedMembers.map((m) => {
      const p = participationByMember.preferred.get(m.id) ?? null
      const status = getMemberStatus(m.id)
      const absenceReason = getMemberAbsenceReason(m.id)
      const role = leadershipRoles.get(m.id)
      const ts = p?.date_updated ?? p?.date_created ?? ''
      const sessionStatuses = buildSessionStatuses(m.id)
      return {
        name: nameWithGuest(m, role),
        team: teamLabel(m.id),
        section: 'roster' as const,
        jerseyNumber: m.number && m.number > 0 ? m.number : null,
        positions: translatePositions(m.position),
        // Session-overall: fold the per-day breakdown into `status` so the CSV
        // (which only reads `status`) still carries it; the PNG/PDF snapshot
        // renders the richer colored `sessionStatuses` lines instead.
        status: sessionStatuses
          ? sessionStatuses.map((s) => `${s.label}: ${s.statusLabel}`).join(' / ')
          : statusLabelText(m.id, status),
        sessionStatuses,
        guests: p?.guest_count ?? 0,
        isGuest: isGuestMember(m),
        // Custom note wins over absence-reason fallback even when cleared
        // to empty — staff explicit clear should remove the displayed note.
        // Absence reason is only surfaced when participation has no note set.
        note: (p?.note ?? null) != null ? (p!.note ?? '') : (absenceReason ?? ''),
        rsvpAt: ts ? formatDateTimeCompact(ts) : '',
        editedBy: formatAttribution(m, p),
      }
    })
    // Waitlist + staff, appended so the export reflects everything visible in
    // the modal. ⚠ The rule is "the export mirrors the modal", NOT "the export
    // is the whole roster": gating these on `statusFilter === null` once
    // dropped every coach and every waitlisted player from a "Confirmed" sheet
    // while they stayed on screen. Both sections are now narrowed by the same
    // `matchesStatusFilter` the roster block uses, so the two stay in step —
    // feed them the FILTERED lists, never the raw ones.
    {
      const waitlistRows: { m: Member; wp: Participation; role: string | undefined }[] = []
      for (const wp of filteredWaitlistedParts) {
        const m = memberList.find((mm) => mm.id === wp.member)
        if (!m) continue
        waitlistRows.push({ m, wp, role: leadershipRoles.get(m.id) })
      }
      waitlistRows.sort((a, b) => byTeamThenName(a.m, b.m))
      for (const { m, wp, role } of waitlistRows) {
        const ts = wp.date_updated ?? wp.date_created ?? ''
        rows.push({
          name: nameWithGuest(m, role),
          team: teamLabel(m.id),
          section: 'waitlist' as const,
          jerseyNumber: m.number && m.number > 0 ? m.number : null,
          positions: translatePositions(m.position),
          status: t('waitlisted'),
          guests: wp.guest_count ?? 0,
          isGuest: isGuestMember(m),
          note: wp.note || '',
          rsvpAt: ts ? formatDateTimeCompact(ts) : '',
          editedBy: formatAttribution(m, wp),
        })
      }
      const sortedStaff = [...filteredStaffMembers].sort(byFirstThenLastName)
      for (const sm of sortedStaff) {
        const myStaffRows = visibleStaffParticipations.filter((p) => String(p.member) === String(sm.id))
        // On a day tab the export must speak for THAT day — the staff fetch
        // isn't session-filtered, so an unscoped `[0]` prints Saturday's answer
        // on Sunday's export.
        const sp = (activeSessionId
          ? myStaffRows.find((p) => String(p.session_id ?? '') === String(activeSessionId))
          : myStaffRows[0]) ?? null
        const ts = sp?.date_updated ?? sp?.date_created ?? ''
        // Per-day breakdown for the Overall tab of a session event — staff rows
        // live in their own pool, so `sessionParticipationByMember` (built from
        // the roster fetch) can't answer for them.
        const staffSessionStatuses = exportSessions?.map((s) => {
          const st = myStaffRows.find((p) => String(p.session_id ?? '') === String(s.id))?.status ?? null
          return { label: formatSessionLabel(s), status: st, statusLabel: st ? t(st) : t('notResponded') }
        })
        rows.push({
          name: exportName(sm) + ` (${t('staff')})`,
          team: teamLabel(sm.id, true),
          section: 'staff' as const,
          jerseyNumber: sm.number && sm.number > 0 ? sm.number : null,
          positions: translatePositions(sm.position),
          status: staffSessionStatuses
            ? staffSessionStatuses.map((s) => `${s.label}: ${s.statusLabel}`).join(' / ')
            : (sp?.status ? t(sp.status) : t('notResponded')),
          sessionStatuses: staffSessionStatuses,
          guests: sp?.guest_count ?? 0,
          isGuest: false,
          note: sp?.note || '',
          rsvpAt: ts ? formatDateTimeCompact(ts) : '',
          editedBy: formatAttribution(sm, sp),
        })
      }
    }
    return rows
  // `displayNames` is what the Name column prints now, so a change to it has to
  // rebuild the rows — it is derived from memberList/staffMembers, but reached
  // through the `exportName` function declaration rather than read here directly.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredMemberList, participations, absences, leadershipRoles, leadershipTeamsByMember, teamsByMember, teamNameById, statusFilter, filteredWaitlistedParts, filteredStaffMembers, visibleStaffParticipations, memberList, displayNames, t, translatePositions, exportSessions, sessionParticipationByMember])

  // Position breakdown of the same population that exportRows covers — counts
  // each member once per declared position (a setter/outside hybrid contributes
  // to both buckets). Stable order preserved by inserting in iteration order.
  const positionSummary = useMemo<{ position: string; label: string; count: number }[]>(() => {
    // Same population as `exportRows` — the roster block plus whatever the
    // waitlist and Staff sections still show under the active filter.
    const membersForExport: Member[] = [...filteredMemberList]
    for (const wp of filteredWaitlistedParts) {
      const m = memberList.find((mm) => mm.id === wp.member)
      if (m) membersForExport.push(m)
    }
    for (const sm of filteredStaffMembers) membersForExport.push(sm)
    const counts = new Map<string, number>()
    for (const m of membersForExport) {
      for (const p of m.position ?? []) {
        counts.set(p, (counts.get(p) ?? 0) + 1)
      }
    }
    // Stable position ordering — same as the existing positionOrder convention
    // (S, O, M, D, L, …) so the strip reads consistently across exports.
    const order = ['setter', 'outside', 'middle', 'opposite', 'libero', 'point_guard', 'shooting_guard', 'small_forward', 'power_forward', 'center', 'guest', 'other']
    return order
      .filter((pos) => counts.has(pos))
      .map((pos) => {
        const key = getPositionI18nKey(pos)
        return {
          position: pos,
          label: key ? tt(key) : pos,
          count: counts.get(pos) ?? 0,
        }
      })
  }, [filteredMemberList, filteredWaitlistedParts, filteredStaffMembers, memberList, tt])

  // Team column + grouping only earn their space when the export actually spans
  // several teams — on a single-team roster the column would repeat one value.
  const exportMultiTeam = isMultiTeamExport(exportRows)

  const exportMeta = useMemo<RosterExportMeta>(() => {
    const filterLabel =
      statusFilter === null ? t('all')
      : statusFilter === 'no_response' ? t('notResponded')
      : t(statusFilter)
    // Filename must be English regardless of UI locale (exports-always-English).
    const tEn = i18n.getFixedT('en', 'participation')
    const filterLabelEn =
      statusFilter === null ? tEn('all')
      : statusFilter === 'no_response' ? tEn('notResponded')
      : tEn(statusFilter)
    const positionsSummaryText = positionSummary.length > 0
      ? positionSummary.map((p) => `${p.count} ${p.label}`).join(', ')
      : ''
    const fallbackKind =
      activityType === 'training' ? t('kindTraining', { defaultValue: 'Training' })
      : activityType === 'game' ? t('kindGame', { defaultValue: 'Game' })
      : t('kindEvent', { defaultValue: 'Event' })
    // A specific session tab exports just that day; label it in the header so
    // the sheet isn't mistaken for the whole event. The Overall tab shows the
    // per-day breakdown in the table instead, so no single label there.
    const activeSession = hasSessionMode && activeSessionTab
      ? (eventSessions ?? []).find((s) => s.id === activeSessionTab)
      : undefined
    return {
      activityKind: activityKind || fallbackKind,
      activityTitle: title,
      activityDate: formatDate(activityDate.split(' ')[0]),
      filterLabel,
      filterLabelEn,
      exportedAt: formatDateTimeCompact(new Date().toISOString()),
      totalCount: exportRows.length,
      positionsSummary: positionsSummaryText,
      sessionLabel: activeSession ? formatSessionLabel(activeSession) : '',
    }
  }, [activityKind, activityType, title, activityDate, statusFilter, exportRows.length, positionSummary, t, i18n, hasSessionMode, activeSessionTab, eventSessions])

  const handleExport = useCallback(async (format: 'csv' | 'png' | 'pdf') => {
    if (exporting) return
    setExporting(format)
    try {
      if (format === 'csv') {
        exportRosterCsv(exportRows, exportMeta)
      } else if (format === 'png') {
        if (printRef.current) await exportRosterImage(printRef.current, exportMeta)
      } else if (format === 'pdf') {
        if (printRef.current) await exportRosterPdf(printRef.current, exportMeta)
      }
    } catch (err) {
      console.error('Roster export failed', err)
      // Stale-bundle dynamic-import failures get a clear actionable message;
      // anything else falls through to a generic notice.
      const message = (err instanceof Error && err.name === 'ExportLibraryError')
        ? err.message
        : t('exportFailed', { defaultValue: 'Export failed. Please try again.' })
      toast.error(message)
    } finally {
      setExporting(null)
    }
  }, [exporting, exportRows, exportMeta, t])

  const statusLabels: Record<string, string> = {
    confirmed: t('confirmed'),
    tentative: t('tentative'),
    declined: t('declined'),
    waitlisted: t('waitlisted'),
  }

  return (
    <Modal open={open} onClose={onClose} title={title} size="lg">
      {/* Session tabs */}
      {hasSessionMode && (
        <div className="mb-4 flex gap-1 overflow-x-auto rounded-lg border border-gray-200 bg-gray-50 p-1 dark:border-gray-600 dark:bg-gray-800">
          <button
            onClick={() => setActiveSessionTab(null)}
            className={`shrink-0 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              activeSessionTab === null
                ? 'bg-brand-500 text-white shadow-sm'
                : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200'
            }`}
          >
            {te('overallView')}
          </button>
          {eventSessions!.map((session) => (
            <button
              key={session.id}
              onClick={() => setActiveSessionTab(session.id)}
              className={`shrink-0 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                activeSessionTab === session.id
                  ? 'bg-brand-500 text-white shadow-sm'
                  : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200'
              }`}
            >
              {formatSessionLabel(session)}
            </button>
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="py-8 text-center text-gray-500 dark:text-gray-400">...</div>
      ) : (<>
      {/* Summary header */}
      <div className="mb-4 flex flex-wrap gap-3 text-sm">
        <span className="text-green-600 dark:text-green-400">
          {confirmed}{confirmedGuests > 0 && `+${confirmedGuests}`} {t('confirmed')}
        </span>
        <span className="text-yellow-600 dark:text-yellow-400">
          {tentative}{tentativeGuests > 0 && `+${tentativeGuests}`} {t('tentative')}
        </span>
        <span className="text-red-600 dark:text-red-400">{declined} {t('declined')}</span>
        {waitlisted > 0 && (
          <span className="text-orange-600 dark:text-orange-400">{waitlisted} {t('waitlisted')}</span>
        )}
        <span className="text-gray-500 dark:text-gray-400">{notResponded} {t('notResponded')}</span>
        {totalGuests > 0 && (
          <span className="text-brand-600 dark:text-brand-400">
            {totalGuests} {t('guests')}
          </span>
        )}
        {staffConfirmed > 0 && (
          <span className="text-brand-600 dark:text-brand-400">
            {staffConfirmed} {t('staffPresent')}
          </span>
        )}
      </div>

      {/* Team + status filter + export — dropdown menus. Gated on the FULL
          roster (not the team-filtered list) so the team dropdown stays
          reachable even when a selected team happens to have zero members. */}
      {rosterMembers.length > 0 && (() => {
        const filterOptions = [
          { key: null, label: t('all'), count: memberList.length, dotClass: 'bg-gray-400 dark:bg-gray-500' },
          { key: 'confirmed', label: t('confirmed'), count: confirmed, dotClass: 'bg-green-500' },
          { key: 'tentative', label: t('tentative'), count: tentative, dotClass: 'bg-yellow-500' },
          { key: 'declined', label: t('declined'), count: declined, dotClass: 'bg-red-500' },
          { key: 'no_response', label: t('notResponded'), count: notResponded, dotClass: 'bg-gray-400 dark:bg-gray-500' },
        ] as const
        const active = filterOptions.find((o) => o.key === statusFilter) ?? filterOptions[0]
        // Per-team roster counts for the team-filter dropdown (a shared player
        // counts under each of their teams).
        const teamMemberCounts = new Map<string, number>()
        for (const mem of rosterMembers) {
          // Guests are tallied under the "Guests" bucket, not their host team,
          // so a team's count matches what selecting that team now shows (core
          // roster only).
          if (guestMemberIds.has(String(mem.id))) continue
          for (const tid of effectiveTeamsByMember.get(String(mem.id)) ?? []) {
            teamMemberCounts.set(tid, (teamMemberCounts.get(tid) ?? 0) + 1)
          }
        }
        // Offered whenever there is more than one bucket to choose between —
        // which now includes club-wide and role-targeted events, whose buckets
        // are the teams the respondents themselves belong to.
        const showTeamFilter = filterTeamIds.length > 1
        const labelParts: string[] = []
        if (teamFilterActive) {
          labelParts.push(selectedTeams!.size === 1
            ? (effectiveTeamNameById.get(String([...selectedTeams!][0])) ?? t('allTeams', { defaultValue: 'All teams' }))
            : t('teamsCount', { count: selectedTeams!.size, defaultValue: '{{count}} teams' }))
        }
        if (guestsOnly) labelParts.push(t('guestsFilterLabel', { defaultValue: 'Guests' }))
        const teamTriggerLabel = labelParts.length > 0
          ? labelParts.join(' · ')
          : t('allTeams', { defaultValue: 'All teams' })
        const toggleTeam = (teamId: string) => {
          setSelectedTeams((prev) => {
            const next = new Set(prev ?? [])
            if (next.has(teamId)) next.delete(teamId)
            else next.add(teamId)
            // Empty or every-team-selected both collapse to "all" (null).
            if (next.size === 0 || next.size === filterTeamIds.length) return null
            return next
          })
        }
        // Role buckets, offered only when the event actually targets roles.
        const roleMemberCounts = new Map<string, number>()
        if (roleFilterAvailable) {
          for (const role of roleOptions) {
            roleMemberCounts.set(role, rosterMembers.reduce((n, mem) => n + (memberMatchesRole(mem, role) ? 1 : 0), 0))
          }
        }
        const roleTriggerLabel = roleFilterActive
          ? (selectedRoles!.size === 1
              ? tv(`role_${[...selectedRoles!][0]}`, { ns: 'invitations' })
              : t('rolesCount', { count: selectedRoles!.size, defaultValue: '{{count}} roles' }))
          : t('allRoles', { defaultValue: 'All roles' })
        const toggleRole = (role: string) => {
          setSelectedRoles((prev) => {
            const next = new Set(prev ?? [])
            if (next.has(role)) next.delete(role)
            else next.add(role)
            if (next.size === 0 || next.size === roleOptions.length) return null
            return next
          })
        }
        return (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {showTeamFilter && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex min-h-[36px] items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                  >
                    <Users className="h-4 w-4 text-gray-400" />
                    <span>{teamTriggerLabel}</span>
                    <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-[220px]">
                  <DropdownMenuLabel>{t('filterByTeam', { defaultValue: 'Filter by team' })}</DropdownMenuLabel>
                  <DropdownMenuCheckboxItem
                    checked={!teamFilterActive}
                    onSelect={(e) => { e.preventDefault(); setSelectedTeams(null) }}
                    className="cursor-pointer"
                  >
                    <span className="flex-1">{t('allTeams', { defaultValue: 'All teams' })}</span>
                    <span className="text-xs text-gray-400 dark:text-gray-500">{rosterMembers.length}</span>
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuSeparator />
                  {filterTeamIds.map((tid) => {
                    const id = String(tid)
                    return (
                      <DropdownMenuCheckboxItem
                        key={id}
                        checked={selectedTeams?.has(id) ?? false}
                        onSelect={(e) => { e.preventDefault(); toggleTeam(id) }}
                        className="cursor-pointer"
                      >
                        <span className="flex-1 break-words">{effectiveTeamNameById.get(id) ?? id}</span>
                        <span className="text-xs text-gray-400 dark:text-gray-500">{teamMemberCounts.get(id) ?? 0}</span>
                      </DropdownMenuCheckboxItem>
                    )
                  })}
                  {guestMemberIds.size > 0 && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuCheckboxItem
                        checked={guestsOnly}
                        onSelect={(e) => { e.preventDefault(); setGuestsOnly((v) => !v) }}
                        className="cursor-pointer"
                      >
                        <span className="flex-1">{t('guestsFilterLabel', { defaultValue: 'Guests' })}</span>
                        <span className="text-xs text-gray-400 dark:text-gray-500">{guestMemberIds.size}</span>
                      </DropdownMenuCheckboxItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {roleFilterAvailable && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex min-h-[36px] items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                  >
                    <UserCog className="h-4 w-4 text-gray-400" />
                    <span>{roleTriggerLabel}</span>
                    <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-[220px]">
                  <DropdownMenuLabel>{t('filterByRole', { defaultValue: 'Filter by role' })}</DropdownMenuLabel>
                  <DropdownMenuCheckboxItem
                    checked={!roleFilterActive}
                    onSelect={(e) => { e.preventDefault(); setSelectedRoles(null) }}
                    className="cursor-pointer"
                  >
                    <span className="flex-1">{t('allRoles', { defaultValue: 'All roles' })}</span>
                    <span className="text-xs text-gray-400 dark:text-gray-500">{rosterMembers.length}</span>
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuSeparator />
                  {roleOptions.map((role) => (
                    <DropdownMenuCheckboxItem
                      key={role}
                      checked={selectedRoles?.has(role) ?? false}
                      onSelect={(e) => { e.preventDefault(); toggleRole(role) }}
                      className="cursor-pointer"
                    >
                      <span className="flex-1 break-words">{tv(`role_${role}`, { ns: 'invitations' })}</span>
                      <span className="text-xs text-gray-400 dark:text-gray-500">{roleMemberCounts.get(role) ?? 0}</span>
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="inline-flex min-h-[36px] items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${active.dotClass}`} />
                  <span>{active.label}</span>
                  <span className="text-gray-400 dark:text-gray-500">({active.count})</span>
                  <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-[200px]">
                {filterOptions.map((opt) => (
                  <DropdownMenuItem
                    key={opt.key ?? 'all'}
                    onClick={() => setStatusFilter(opt.key)}
                    className="flex cursor-pointer items-center gap-2"
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${opt.dotClass}`} />
                    <span className="flex-1">{opt.label}</span>
                    <span className="text-xs text-gray-400 dark:text-gray-500">{opt.count}</span>
                    {statusFilter === opt.key && <Check className="h-4 w-4 text-brand-600 dark:text-gold-400" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Export — staff/admin only */}
            {canEditRoster && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    disabled={exporting !== null || exportRows.length === 0}
                    className="inline-flex min-h-[36px] items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                  >
                    {exporting !== null ? (
                      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-300 border-t-brand-500" />
                    ) : (
                      <Download className="h-4 w-4" />
                    )}
                    <span>{t('export', { defaultValue: 'Export' })}</span>
                    <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[180px]">
                  <DropdownMenuItem onClick={() => handleExport('csv')} className="flex cursor-pointer items-center gap-2">
                    <FileText className="h-4 w-4 text-gray-500 dark:text-gray-400" />
                    <span className="flex-1">{t('exportCsv', { defaultValue: 'CSV' })}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleExport('png')} className="flex cursor-pointer items-center gap-2">
                    <ImageIcon className="h-4 w-4 text-gray-500 dark:text-gray-400" />
                    <span className="flex-1">{t('exportPng', { defaultValue: 'PNG image' })}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleExport('pdf')} className="flex cursor-pointer items-center gap-2">
                    <FileType className="h-4 w-4 text-gray-500 dark:text-gray-400" />
                    <span className="flex-1">{t('exportPdf', { defaultValue: 'PDF' })}</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )
      })()}

      {/* Hidden printable view for PNG/PDF export.
          Portalled to document.body so it escapes the Vaul Drawer / Radix
          Dialog ancestor — those carry a `transform` during open + at rest,
          which turns `position: fixed` into a relative anchor and clipped
          the snapshot to a blank rectangle.
          Hiding strategy: outer wrapper clips via `width: 0; height: 0;
          overflow: hidden;` while the INNER node (the one passed to
          html-to-image) gets clean normal-flow styles — no `opacity: 0`,
          no `position: fixed; left: -10000px`. html-to-image clones the
          inner node with its computed styles inlined; if those styles
          carry a hide hack the snapshot inherits it (opacity:0 → blank
          alpha; off-screen position → content paints outside the SVG
          foreignObject's canvas). The outer wrapper does the hiding and
          gets discarded by the cloner because we hand it the inner ref. */}
      {canEditRoster && createPortal(
        <div
          aria-hidden="true"
          style={{
            position: 'fixed',
            left: 0,
            top: 0,
            width: 0,
            height: 0,
            overflow: 'hidden',
            pointerEvents: 'none',
            zIndex: -1,
          }}
        >
        <div
          ref={printRef}
          style={{
            width: '960px',
            backgroundColor: '#ffffff',
            color: '#111827',
            padding: '24px',
            fontFamily: 'Arial, Helvetica, sans-serif',
          }}
        >
          <div style={{ borderBottom: '2px solid #e5e7eb', paddingBottom: '12px', marginBottom: '16px' }}>
            <p style={{ fontSize: '11px', fontWeight: 600, color: '#6b7280', letterSpacing: '0.08em', textTransform: 'uppercase', margin: '0 0 4px' }}>
              {exportMeta.activityKind}
            </p>
            <h1 style={{ fontSize: '20px', fontWeight: 600, margin: 0 }}>{exportMeta.activityTitle}</h1>
            <p style={{ fontSize: '13px', color: '#6b7280', margin: '6px 0 0' }}>
              {exportMeta.activityDate} &middot; {exportMeta.sessionLabel ? `${exportMeta.sessionLabel} · ` : ''}{t('filter', { defaultValue: 'Filter' })}: {exportMeta.filterLabel} ({exportMeta.totalCount})
            </p>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', marginBottom: '12px', fontSize: '12px' }}>
            <span style={{ color: '#16a34a' }}>{confirmed}{confirmedGuests > 0 ? `+${confirmedGuests}` : ''} {t('confirmed')}</span>
            <span style={{ color: '#ca8a04' }}>{tentative}{tentativeGuests > 0 ? `+${tentativeGuests}` : ''} {t('tentative')}</span>
            <span style={{ color: '#dc2626' }}>{declined} {t('declined')}</span>
            {waitlisted > 0 && <span style={{ color: '#ea580c' }}>{waitlisted} {t('waitlisted')}</span>}
            <span style={{ color: '#6b7280' }}>{notResponded} {t('notResponded')}</span>
            {staffConfirmed > 0 && <span style={{ color: '#4f46e5' }}>{staffConfirmed} {t('staffPresent')}</span>}
          </div>

          {positionSummary.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '16px', fontSize: '12px' }}>
              {positionSummary.map((p) => (
                <span
                  key={p.position}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '3px 10px',
                    borderRadius: '999px',
                    backgroundColor: '#f3f4f6',
                    color: '#374151',
                    border: '1px solid #e5e7eb',
                    // Keep multi-word labels ("Outside hitter", "Middle blocker")
                    // on one line — nowrap on the pill AND the label span (the
                    // label is a flex item, so it needs its own nowrap), plus
                    // flexShrink:0 so a tight chip row can't squeeze it into a
                    // wrap. html-to-image inlines computed styles per element,
                    // so belt-and-braces here survives the snapshot clone.
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                  }}
                >
                  <strong style={{ fontVariantNumeric: 'tabular-nums', color: '#111827' }}>{p.count}</strong>
                  <span style={{ whiteSpace: 'nowrap' }}>{p.label}</span>
                </span>
              ))}
            </div>
          )}

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ backgroundColor: '#f3f4f6', borderBottom: '1px solid #d1d5db' }}>
                {exportMultiTeam && <th style={{ textAlign: 'left', padding: '8px' }}>{t('team', { defaultValue: 'Team' })}</th>}
                <th style={{ textAlign: 'left', padding: '8px', width: '40px' }}>#</th>
                <th style={{ textAlign: 'left', padding: '8px' }}>{t('name', { defaultValue: 'Name' })}</th>
                <th style={{ textAlign: 'left', padding: '8px' }}>{t('positions', { defaultValue: 'Positions' })}</th>
                <th style={{ textAlign: 'left', padding: '8px' }}>{t('status', { defaultValue: 'Status' })}</th>
                {/* No "Guest" tick column — a guest player is marked in the name,
                    like the coach / captain / TR suffixes. This column sat next to
                    "Guests" (plus-ones) and read as a duplicate of it. */}
                <th style={{ textAlign: 'left', padding: '8px', width: '60px' }}>{t('guests')}</th>
                <th style={{ textAlign: 'left', padding: '8px' }}>{t('note', { defaultValue: 'Note' })}</th>
                <th style={{ textAlign: 'left', padding: '8px' }}>RSVP</th>
              </tr>
            </thead>
            <tbody>
              {exportRows.map((r, i) => (
                // `data-export-row` (EXPORT_ROW_ATTR in rosterExport.ts) marks the
                // row as un-splittable: the PDF pager ends a page on one of these
                // boundaries instead of slicing the last row across the fold.
                <tr
                  key={i}
                  data-export-row=""
                  style={{
                    // Heavier rule where the team changes, so the groups read as
                    // blocks even though the team name is printed only once.
                    borderBottom: '1px solid #e5e7eb',
                    ...(exportMultiTeam && i > 0 && r.team !== exportRows[i - 1]?.team
                      ? { borderTop: '2px solid #d1d5db' }
                      : {}),
                  }}
                >
                  {exportMultiTeam && (
                    // Printed once per group — repeating "H3" down fourteen rows
                    // is noise; the rule above marks where the next group starts.
                    <td style={{ padding: '6px 8px', fontWeight: 600, color: '#4b5563', verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                      {r.team !== exportRows[i - 1]?.team ? r.team : ''}
                    </td>
                  )}
                  <td style={{ padding: '6px 8px', color: '#6b7280', fontVariantNumeric: 'tabular-nums', verticalAlign: 'top' }}>{r.jerseyNumber ?? ''}</td>
                  <td style={{ padding: '6px 8px', verticalAlign: 'top' }}>
                    {r.name}
                    {r.editedBy && (
                      <div style={{ marginTop: '2px', fontSize: '10px', fontStyle: 'italic', color: '#9ca3af' }}>
                        {r.editedBy.split('\n').map((line, idx) => (
                          <div key={idx}>{line}</div>
                        ))}
                      </div>
                    )}
                  </td>
                  <td style={{ padding: '6px 8px', color: '#6b7280', verticalAlign: 'top' }}>{r.positions}</td>
                  <td style={{ padding: '6px 8px', verticalAlign: 'top' }}>
                    {r.sessionStatuses
                      ? r.sessionStatuses.map((s, k) => (
                          <div key={k} style={{ whiteSpace: 'nowrap', lineHeight: 1.5 }}>
                            <span style={{ color: '#6b7280' }}>{s.label}: </span>
                            <span style={{ color: exportStatusColor(s.status), fontWeight: 500 }}>{s.statusLabel}</span>
                          </div>
                        ))
                      : r.status}
                  </td>
                  <td style={{ padding: '6px 8px', color: '#6b7280', fontVariantNumeric: 'tabular-nums', verticalAlign: 'top' }}>{r.guests > 0 ? `+${r.guests}` : ''}</td>
                  <td style={{ padding: '6px 8px', color: '#6b7280', verticalAlign: 'top' }}>{r.note}</td>
                  <td style={{ padding: '6px 8px', color: '#9ca3af', fontSize: '11px', verticalAlign: 'top' }}>{r.rsvpAt}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <p style={{ marginTop: '16px', fontSize: '11px', color: '#9ca3af', textAlign: 'right' }}>
            {t('exportedAt', { defaultValue: 'Exported' })} {exportMeta.exportedAt}
          </p>
        </div>
        </div>,
        document.body,
      )}

      {/* Deadline banner */}
      {respondBy && (
        <div className={`mb-4 rounded-lg px-3 py-2 text-sm ${
          deadlinePassed
            ? 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400'
            : 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400'
        }`}>
          {t('respondBy')}: {formatDate(respondBy.split(' ')[0])}{(() => {
            const [, rbTime] = (respondBy || '').split(' ')
            return rbTime && rbTime !== '00:00:00' ? `, ${rbTime.slice(0, 5)}` : ''
          })()}
          {deadlinePassed && ` — ${t('deadlinePassed')}`}
        </div>
      )}

      {/* Max players indicator for tournaments */}
      {maxPlayers != null && maxPlayers > 0 && (() => {
        const totalConfirmed = confirmed + confirmedGuests
        return (
          <div className={`mb-4 rounded-lg px-3 py-2 text-sm ${
            totalConfirmed >= maxPlayers
              ? 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400'
              : 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400'
          }`}>
            {totalConfirmed >= maxPlayers
              ? t('full')
              : t('spotsLeft', { count: maxPlayers - totalConfirmed })}
            {` (${totalConfirmed}/${maxPlayers})`}
          </div>
        )
      })()}

      {/* Member list */}
      {memberList.length === 0 ? (
        <div className="py-8 text-center text-gray-500 dark:text-gray-400">{t('noResponses')}</div>
      ) : (
        <div className="rounded-lg border dark:border-gray-700">
          {filteredMemberList.map((member) => {
            const status = getMemberStatus(member.id)
            const participation = participationByMember.first.get(member.id)

            return (
              <div
                key={member.id}
                className={`border-b border-b-gray-200 border-l-4 last:border-b-0 dark:border-b-gray-700 ${statusBarClass(status)}`}
              >
                <div className="flex min-h-[44px] items-center gap-3 px-3 py-2 sm:min-h-0">
                {/* Avatar */}
                {member.photo ? (
                  <img
                    src={getFileUrl('members', member.id, member.photo)}
                    alt=""
                    className="h-8 w-8 shrink-0 rounded-full object-cover"
                  />
                ) : (
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-200 text-xs font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-400">
                    {getInitials(member)}
                  </div>
                )}

                {/* Name */}
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm text-gray-900 dark:text-gray-100">
                    {displayNames.get(String(member.id)) ?? memberFirstName(member)}
                    {participation && (participation.guest_count ?? 0) > 0 && (
                      <span className="ml-1 text-xs text-brand-600 dark:text-brand-400">
                        +{participation.guest_count} {t('guests')}
                      </span>
                    )}
                  </p>
                  {showRsvpTime && (participation?.date_updated || participation?.date_created) && (
                    <RsvpTimestamp datetime={participation.date_updated ?? participation.date_created!} locale={i18n.language} />
                  )}
                  {participation?.position_1 && (
                    <p className="truncate text-xs text-gray-400">
                      {[participation.position_1, participation.position_2, participation.position_3].filter(Boolean).join(' > ')}
                    </p>
                  )}
                </div>

                {/* Characteristic column (captain / coach / TR / guest) — own fixed-width
                    slot so the badges line up vertically across all rows */}
                <div className="flex w-14 shrink-0 flex-wrap items-center justify-center gap-1">
                  {leadershipRoles.has(member.id) && (
                    <span className="inline-block rounded bg-brand-100 px-1 py-px text-[10px] font-medium leading-tight text-brand-700 dark:bg-brand-900/30 dark:text-brand-400">
                      {leadershipRoles.get(member.id) === 'coach' ? t('roleCoach') : leadershipRoles.get(member.id) === 'captain' ? t('roleCaptainAbbr') : t('roleTeamRespAbbr')}
                    </span>
                  )}
                  {guestLevels.has(member.id) && (() => {
                    const lvl = guestLevels.get(member.id) ?? 0
                    return (
                      <span
                        title={lvl > 0 ? t('guestLevel', { level: lvl, defaultValue: 'Guest level {{level}}' }) : t('guestBadge')}
                        className="inline-block rounded bg-amber-100 px-1 py-px text-[10px] font-medium leading-tight text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                      >
                        {t('guestBadge')}{lvl > 0 ? ` ${lvl}` : ''}
                      </span>
                    )
                  })()}
                  {/* Invited to THIS game from another team (migration 271). Distinct
                      colour from the amber team-guest badge above: that one means
                      "trains with us, may not play league games", this one means the
                      opposite — invited precisely so they can play. */}
                  {gameGuestOrigin.has(member.id) && (
                    <span
                      title={gameGuestOrigin.get(member.id)
                        ? t('gameGuestFrom', { team: gameGuestOrigin.get(member.id) })
                        : t('gameGuestIndividual')}
                      className="inline-block rounded bg-sky-100 px-1 py-px text-[10px] font-medium leading-tight text-sky-700 dark:bg-sky-900/30 dark:text-sky-400"
                    >
                      {gameGuestOrigin.get(member.id) || t('gameGuestBadge')}
                    </span>
                  )}
                </div>

                {/* Status badge + edit controls */}
                {isOverallSessionTab ? (
                  // Session count badge + the same pencil as a day tab — editing
                  // here applies the pick to EVERY day (see `sessionTargets`),
                  // which is the whole point: a leader answering for someone
                  // shouldn't have to walk the tabs saying the same thing twice.
                  <div className="flex shrink-0 items-center justify-end gap-1">
                    {(() => {
                      const counts = memberSessionCounts.get(member.id)
                      if (!counts) return <span className="text-xs text-gray-400 dark:text-gray-500">{t('notResponded')}</span>
                      return (
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          counts.confirmed === counts.total
                            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                            : counts.confirmed > 0
                              ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                              : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
                        }`}>
                          {te('sessionsConfirmed', { confirmed: counts.confirmed, total: counts.total })}
                        </span>
                      )
                    })()}
                    {canEditRoster && editingMemberId !== member.id && !savingMemberIds.has(member.id) && (
                      <button
                        type="button"
                        onClick={() => setEditingMemberId(member.id)}
                        aria-label={t('editAllDays')}
                        title={t('editAllDays')}
                        className="inline-flex h-7 w-7 items-center justify-center rounded text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {savingMemberIds.has(member.id) && (
                      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-300 border-t-brand-500" />
                    )}
                  </div>
                ) : (
                  // RSVP brick + optional pencil. The textual status moved to the
                  // note line beneath ("Reason: note"); the row's left bar mirrors
                  // the same colour so status reads at a glance without a wide badge.
                  // When this member is being edited the controls render full-width on
                  // their own row below, so the pencil hides to avoid a dead affordance.
                  <div className="flex w-16 shrink-0 items-center justify-end gap-1">
                    <RsvpBrick status={status} label={statusLabelText(member.id, status)} />
                    {canEditRoster && editingMemberId !== member.id && !savingMemberIds.has(member.id) && (
                      <button
                        type="button"
                        onClick={() => setEditingMemberId(member.id)}
                        className="inline-flex h-7 w-7 items-center justify-center rounded text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {savingMemberIds.has(member.id) && (
                      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-300 border-t-brand-500" />
                    )}
                  </div>
                )}
                </div>
                {/* Inline edit panel — its own full-width row so the status dropdown and
                    note input have room without crushing the member's name into a single
                    vertical column on mobile. Status auto-saves on `onChange`, note on
                    `onBlur`. The wrapper `onBlur` only closes when focus leaves the whole
                    panel (tabbing between the select and the input keeps it open). */}
                {editingMemberId === member.id && (
                  <div
                    className="flex items-center gap-2 px-3 pb-2 pl-14"
                    onBlur={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                        setTimeout(() => setEditingMemberId(prev => prev === member.id ? null : prev), 150)
                      }
                    }}
                  >
                    {isOverallSessionTab && (
                      <span className="shrink-0 rounded-full bg-brand-100 px-2 py-0.5 text-[11px] font-medium text-brand-700 dark:bg-brand-900/30 dark:text-brand-400">
                        {t('allDays')}
                      </span>
                    )}
                    <select
                      autoFocus
                      // On the Overall tab the dropdown shows the shared answer
                      // only when every day agrees — a mixed member starts blank
                      // rather than pretending one of the days speaks for all.
                      defaultValue={isOverallSessionTab
                        ? uniformValue(sessionTargets(member.id), 'status')
                        : participationByMember.preferred.get(member.id)?.status ?? participationByMember.first.get(member.id)?.status ?? ''}
                      onChange={(e) => handleStatusChange(member.id, e.target.value)}
                      className="shrink-0 rounded-md border border-gray-300 bg-white px-1.5 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                    >
                      <option value="">{t('clearStatus')}</option>
                      <option value="confirmed">{t('confirmed')}</option>
                      {allowMaybe && <option value="tentative">{t('tentative')}</option>}
                      <option value="declined">{t('declined')}</option>
                    </select>
                    <input
                      type="text"
                      placeholder={t('addNotePlaceholder', { defaultValue: 'Note…' })}
                      defaultValue={isOverallSessionTab
                        ? uniformValue(sessionTargets(member.id), 'note')
                        : participationByMember.preferred.get(member.id)?.note ?? participationByMember.first.get(member.id)?.note ?? ''}
                      // Only write when the field was actually edited. Without
                      // this, opening the pencil on a member whose days carry
                      // DIFFERENT notes (box renders blank — see
                      // `uniformValue`) and clicking away would blank
                      // every day's note.
                      onBlur={(e) => { if (e.target.value !== e.target.defaultValue) handleNoteChange(member.id, e.target.value) }}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur() }}
                      className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                    />
                  </div>
                )}
                {/* Note on its own row — skip if note is just a duplicate of position preferences.
                    Custom participation.note wins over absence-reason fallback even when cleared
                    to empty: staff explicit clear should remove the displayed note. Absence reason
                    is only surfaced when participation has no note set at all (null/undefined). */}
                {(() => {
                  const absenceReason = getMemberAbsenceReason(member.id)
                  const customNote = participation?.note
                  // Explicit empty-string clear (staff removed the note) suppresses
                  // both the note and the absence-reason fallback.
                  if (customNote === '') return null
                  let noteText = customNote ?? null
                  // Don't echo the position-preferences string back as a note.
                  if (noteText && participation?.position_1) {
                    const posStr = [participation.position_1, participation.position_2, participation.position_3].filter(Boolean).join(' > ')
                    if (noteText === posStr) noteText = null
                  }
                  // Compose "Reason: note" — reason alone when there's no note, note
                  // alone when there's no covering absence. The brick + left bar
                  // already carry the status, so "Declined" isn't repeated here.
                  const body = absenceReason && noteText
                    ? `${absenceReason}: ${noteText}`
                    : (absenceReason ?? noteText)
                  if (!body) return null
                  return <p className="break-words px-3 pb-2 pl-14 text-xs italic text-gray-400">{body}</p>
                })()}
                {/* Staff edit attribution (migration 047) — independent lines
                    for status and note edits. Each surfaces only when its
                    tracker resolves to a user other than the member's own;
                    self-edits stay clean. Generic "Staff" fallback when the
                    editor isn't on any of the team rosters we loaded. */}
                {(() => {
                  const { status: statusAttr, note: noteAttr } = getEditAttribution(member, participation ?? null)
                  if (!statusAttr && !noteAttr) return null
                  return (
                    <div className="px-3 pb-2 pl-14 text-[11px] italic text-gray-400 dark:text-gray-500">
                      {statusAttr && (
                        <p className="break-words">
                          {t('editedByOn', { defaultValue: 'Edited to {{status}} by {{name}} on {{at}}', ...statusAttr })}
                        </p>
                      )}
                      {noteAttr && (
                        <p className="break-words">
                          {t('noteEditedByOn', { defaultValue: 'Note edited by {{name}} on {{at}}', ...noteAttr })}
                        </p>
                      )}
                    </div>
                  )
                })()}
              </div>
            )
          })}

          {/* Waitlist section */}
          {filteredWaitlistedParts.length > 0 && (
            <>
              <div className="border-b bg-orange-50 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-orange-600 dark:border-gray-700 dark:bg-orange-900/20 dark:text-orange-400">
                {t('waitlisted')} ({filteredWaitlistedParts.length})
              </div>
              {filteredWaitlistedParts.map((wp, idx) => {
                const member = memberList.find(m => m.id === wp.member)
                if (!member) return null
                return (
                  <div
                    key={wp.id}
                    className="flex min-h-[44px] items-center gap-3 border-b border-b-gray-200 border-l-4 border-l-orange-500 px-3 py-2 last:border-b-0 dark:border-b-gray-700 sm:min-h-0"
                  >
                    <span className="w-5 shrink-0 text-center text-xs font-medium text-orange-500 dark:text-orange-400">
                      #{idx + 1}
                    </span>
                    {member.photo ? (
                      <img
                        src={getFileUrl('members', member.id, member.photo)}
                        alt=""
                        className="h-8 w-8 shrink-0 rounded-full object-cover"
                      />
                    ) : (
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-orange-100 text-xs font-medium text-orange-600 dark:bg-orange-900/30 dark:text-orange-400">
                        {getInitials(member)}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm text-gray-900 dark:text-gray-100">
                        {displayNames.get(String(member.id)) ?? memberFirstName(member)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {editingMemberId === wp.member ? (
                        <select
                          autoFocus
                          defaultValue={wp.status}
                          onChange={(e) => handleStatusChange(wp.member, e.target.value)}
                          onBlur={() => setTimeout(() => setEditingMemberId(prev => prev === wp.member ? null : prev), 150)}
                          className="rounded-md border border-gray-300 bg-white px-1.5 py-0.5 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                        >
                          <option value="">{t('clearStatus')}</option>
                          <option value="confirmed">{t('confirmed')}</option>
                          {allowMaybe && <option value="tentative">{t('tentative')}</option>}
                          <option value="declined">{t('declined')}</option>
                        </select>
                      ) : (
                        <>
                          <RsvpBrick status="waitlisted" label={statusLabels.waitlisted} />
                          {canEditRoster && !savingMemberIds.has(wp.member) && (
                            <button
                              type="button"
                              onClick={() => setEditingMemberId(wp.member)}
                              className="inline-flex h-7 w-7 items-center justify-center rounded text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                          )}
                          {savingMemberIds.has(wp.member) && (
                            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-300 border-t-brand-500" />
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </>
          )}

          {/* Staff section — coaches/team_responsible not in roster */}
          {filteredStaffMembers.length > 0 && (
            <>
              <div className="border-b bg-gray-50 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                {t('staff')}
              </div>
              {filteredStaffMembers.map((member) => {
                const status = getStaffMemberStatus(member.id)
                // Same write path as the roster rows — `sessionTargets` resolves
                // the day in view (or every day on the Overall tab) out of the
                // combined pool, so a coach's own answer is found instead of
                // duplicated.
                const targets = sessionTargets(member.id)
                const sp = targets.find((tg) => tg.row)?.row ?? null
                const ts = sp?.date_updated ?? sp?.date_created
                return (
                  <div
                    key={member.id}
                    className={`border-b border-b-gray-200 border-l-4 last:border-b-0 dark:border-b-gray-700 ${statusBarClass(status)}`}
                  >
                    <div className="flex min-h-[44px] items-center gap-3 px-3 py-2 sm:min-h-0">
                      {member.photo ? (
                        <img
                          src={getFileUrl('members', member.id, member.photo)}
                          alt=""
                          className="h-8 w-8 shrink-0 rounded-full object-cover"
                        />
                      ) : (
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-medium text-brand-600 dark:bg-brand-900/30 dark:text-brand-400">
                          {getInitials(member)}
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="break-words text-sm text-gray-900 dark:text-gray-100">
                          {displayNames.get(String(member.id)) ?? memberFirstName(member)}
                        </p>
                        {showRsvpTime && ts && (
                          <RsvpTimestamp datetime={ts} locale={i18n.language} />
                        )}
                      </div>
                      {isOverallSessionTab ? (
                        <div className="flex shrink-0 items-center justify-end gap-1">
                          {(() => {
                            const counts = memberSessionCounts.get(String(member.id))
                            if (!counts) return <span className="text-xs text-gray-400 dark:text-gray-500">{t('notResponded')}</span>
                            return (
                              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                                counts.confirmed === counts.total
                                  ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                                  : counts.confirmed > 0
                                    ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                                    : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
                              }`}>
                                {te('sessionsConfirmed', { confirmed: counts.confirmed, total: counts.total })}
                              </span>
                            )
                          })()}
                          {canEditRoster && editingMemberId !== member.id && !savingMemberIds.has(member.id) && (
                            <button
                              type="button"
                              onClick={() => setEditingMemberId(member.id)}
                              aria-label={t('editAllDays')}
                              title={t('editAllDays')}
                              className="inline-flex h-7 w-7 items-center justify-center rounded text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                          )}
                          {savingMemberIds.has(member.id) && (
                            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-300 border-t-brand-500" />
                          )}
                        </div>
                      ) : (
                        <div className="flex w-16 shrink-0 items-center justify-end gap-1">
                          <RsvpBrick status={status} label={status ? (statusLabels[status] ?? t('notResponded')) : t('notResponded')} />
                          {canEditRoster && editingMemberId !== member.id && !savingMemberIds.has(member.id) && (
                            <button
                              type="button"
                              onClick={() => setEditingMemberId(member.id)}
                              className="inline-flex h-7 w-7 items-center justify-center rounded text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                          )}
                          {savingMemberIds.has(member.id) && (
                            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-300 border-t-brand-500" />
                          )}
                        </div>
                      )}
                    </div>
                    {editingMemberId === member.id && (
                      <div
                        className="flex items-center gap-2 px-3 pb-2 pl-14"
                        onBlur={(e) => {
                          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                            setTimeout(() => setEditingMemberId(prev => prev === member.id ? null : prev), 150)
                          }
                        }}
                      >
                        {isOverallSessionTab && (
                          <span className="shrink-0 rounded-full bg-brand-100 px-2 py-0.5 text-[11px] font-medium text-brand-700 dark:bg-brand-900/30 dark:text-brand-400">
                            {t('allDays')}
                          </span>
                        )}
                        <select
                          autoFocus
                          defaultValue={isOverallSessionTab ? uniformValue(targets, 'status') : (targets[0]?.row?.status ?? '')}
                          onChange={(e) => handleStatusChange(member.id, e.target.value)}
                          className="shrink-0 rounded-md border border-gray-300 bg-white px-1.5 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                        >
                          <option value="">{t('clearStatus')}</option>
                          <option value="confirmed">{t('confirmed')}</option>
                          {allowMaybe && <option value="tentative">{t('tentative')}</option>}
                          <option value="declined">{t('declined')}</option>
                        </select>
                        <input
                          type="text"
                          placeholder={t('addNotePlaceholder', { defaultValue: 'Note…' })}
                          defaultValue={isOverallSessionTab ? uniformValue(targets, 'note') : (targets[0]?.row?.note ?? '')}
                          onBlur={(e) => { if (e.target.value !== e.target.defaultValue) handleNoteChange(member.id, e.target.value) }}
                          onKeyDown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur() }}
                          className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                        />
                      </div>
                    )}
                    {(() => {
                      const note = isOverallSessionTab ? uniformValue(targets, 'note') : (targets[0]?.row?.note ?? '')
                      if (!note) return null
                      return <p className="break-words px-3 pb-2 pl-14 text-xs italic text-gray-400">{note}</p>
                    })()}
                  </div>
                )
              })}
            </>
          )}
        </div>
      )}
      </>)}
      {lateConfirmFor && singleTeamId && (
        <IssueFineModal
          open={!!lateConfirmFor}
          onClose={() => setLateConfirmFor(null)}
          memberId={lateConfirmFor.memberId}
          memberName={lateConfirmFor.memberName}
          teamId={lateConfirmFor.teamId}
          category="late_signin"
          activityType={activityType as 'training' | 'game' | 'event'}
          activityId={activityId ?? undefined}
          activityDate={activityDate}
          onSuccess={() => setLateConfirmFor(null)}
        />
      )}
    </Modal>
  )
}
