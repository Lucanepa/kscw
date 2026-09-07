import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useParams, Link } from 'react-router-dom'
import { Move, Check, X as XIcon, XCircle, User, ZoomIn, ZoomOut, MessageSquare, ChevronDown, ChevronUp } from 'lucide-react'
import { logActivity } from '../../utils/logActivity'
import { useTeamMembers } from '../../hooks/useTeamMembers'
import { useTeamIdentityDocs } from '../../hooks/useTeamIdentityDocs'
import type { ExpandedMemberTeam } from '../../hooks/useTeamMembers'
import { useAuth } from '../../hooks/useAuth'
import { useTeamPermissions } from '../../hooks/useTeamPermissions'
import { useAdminMode } from '../../hooks/useAdminMode'
import { usePendingMembers } from '../../hooks/usePendingMembers'
import { useCollection } from '../../lib/query'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import TeamChip from '../../components/TeamChip'
import EmptyState from '../../components/EmptyState'
import { sanitizeUrl } from '../../utils/sanitizeUrl'
import VolleyballIcon from '../../components/VolleyballIcon'
import BasketballIcon from '../../components/BasketballIcon'
import MemberRow from './MemberRow'
import { getMemberRole } from './memberRole'
import ManageStaffModal from './ManageStaffModal'
import TeamIdentityRepair from './TeamIdentityRepair'
import TeamIdentityAccessModal from './TeamIdentityAccessModal'
import { getFileUrl } from '../../utils/fileUrl'
import { coercePositions } from '../../utils/memberPositions'
import { getCurrentSeason } from '../../utils/dateHelpers'
import ImageLightbox from '../../components/ImageLightbox'
import type { Team, Member, Sponsor } from '../../types'
import { asObj, flattenMemberIds, memberDisplayName } from '../../utils/relations'
import PollsSection from '../polls/PollsSection'
import TeamScheduleCalendar from '../gameScheduling/components/TeamScheduleCalendar'
import TeamCalendar from '../calendar/TeamCalendar'
import { isFeatureEnabled } from '../../utils/featureToggles'
import { messagingFeatureEnabled } from '../../utils/messagingFeatureFlag'
import TeamMessagesTab from '../messaging/components/TeamMessagesTab'
import { useConversationsContext } from '../messaging/ConversationsProvider'
import { createRecord, fetchAllItems, fetchItems, updateRecord } from '../../lib/api'
import { useReportPageLoading } from '../../hooks/usePageReady'

type SortKey = 'name' | 'number' | 'position' | 'email' | 'phone' | 'birthdate' | 'identity' | 'role'
type SortDir = 'asc' | 'desc'

// Stable empty identities — kept module-level so the derived values below don't
// invalidate the memos that depend on them on every render.
const EMPTY_IDS: string[] = []
const EMPTY_EXTRA_COACHES: ExpandedMemberTeam[] = []

// Parse "x% y%" or "x% y% zoom" from team_picture_pos
function parsePicturePos(pos: string) {
  const parts = pos.split(' ').map((v) => parseFloat(v))
  const x = !isNaN(parts[0]) ? parts[0] : 50
  const y = !isNaN(parts[1]) ? parts[1] : 50
  const z = parts.length >= 3 && !isNaN(parts[2]) ? parts[2] : 1.0
  return { x, y, z }
}

export default function TeamDetail() {
  const { t } = useTranslation('teams')
  const { teamSlug } = useParams<{ teamSlug: string }>()
  const { user, hasAdminAccessToTeam, canViewTeam } = useAuth()
  const { canManageTeam } = useTeamPermissions()
  const { effectiveIsAdmin } = useAdminMode()
  const [team, setTeam] = useState<Team | null>(null)
  const [loading, setLoading] = useState(true)
  // Back into "loading" as soon as the slug changes — the fetch effect below used
  // to do this with a `setLoading(true)` in its body. Done during render so the
  // page can't paint the previous team's roster for a frame before the effect runs.
  const [prevTeamSlug, setPrevTeamSlug] = useState(teamSlug)
  if (prevTeamSlug !== teamSlug) {
    setPrevTeamSlug(teamSlug)
    if (teamSlug) setLoading(true)
  }
  const teamId = team?.id
  const { members, isLoading: membersLoading } = useTeamMembers(teamId)
  // Was `isCoachOf(id) || (effectiveIsAdmin && hasAdminAccessToTeam(id))` — the leaky
  // first half made the mode-aware second half dead code for exactly the admins it
  // was written to constrain.
  const canManage = canManageTeam(teamId ?? '')
  // Who has an identity document on file. Staff-only, and `null` (unknown) hides the column.
  const identityDocs = useTeamIdentityDocs(teamId, canManage)
  const { data: pendingMembers, refetch: refetchPending } = usePendingMembers(canManage ? teamId : undefined)

  // Team join requests from existing members
  interface TeamRequest { id: string; member: Member | string; team: string; status: string }
  const { data: teamRequestsRaw, refetch: refetchTeamRequests } = useCollection<TeamRequest>('team_requests', {
    filter: canManage && teamId ? { _and: [{ team: { _eq: teamId } }, { status: { _eq: 'pending' } }] } : { id: { _eq: -1 } },
    fields: ['*', 'member.*'],
    limit: 50,
    enabled: canManage && !!teamId,
  })
  const teamRequests = teamRequestsRaw ?? []

  const [teamSponsors, setTeamSponsors] = useState<Sponsor[]>([])
  // Staff (coaches + team responsibles) attached only via the M2M aliases with no
  // member_teams row — fetched separately so they still appear in the Staff section.
  const [fetchedExtraCoaches, setFetchedExtraCoaches] = useState<ExpandedMemberTeam[]>([])

  useEffect(() => {
    if (!team?.id) return
    fetchAllItems<Sponsor>('sponsors', { filter: { _and: [{ active: { _eq: true } }, { teams: { teams_id: { _eq: team.id } } }] }, sort: ['sort_order'] })
      .then(setTeamSponsors)
      .catch(() => {})
  }, [team?.id])

  // Staff member IDs with no member_teams row for this team. Pure derivation —
  // the old code computed this inside the effect below and setState([])'d for the
  // "nothing to fetch" cases.
  const missingStaffIds = useMemo(() => {
    if (!team) return EMPTY_IDS
    const presentIds = new Set(members.map((mt) => String(asObj<Member>(mt.member)?.id ?? mt.member)))
    const staffIds = [...new Set([...flattenMemberIds(team.coach), ...flattenMemberIds(team.team_responsible)])]
    return staffIds.filter((id) => !presentIds.has(id))
  }, [team, members])

  // Fetch staff member records (coaches + team responsibles) that have no
  // member_teams row for this team, so the Staff section is complete even for
  // non-playing staff who never appear on the roster.
  useEffect(() => {
    if (!team || missingStaffIds.length === 0) return
    let cancelled = false
    fetchAllItems<Member>('members', { filter: { id: { _in: missingStaffIds } }, fields: ['*'] })
      .then((rows) => {
        if (cancelled) return
        setFetchedExtraCoaches(rows.map((m) => ({
          id: `coach-${m.id}`,
          member: m,
          team: String(team.id),
          season: team.season,
          guest_level: 0,
        } as unknown as ExpandedMemberTeam)))
      })
      .catch(() => { if (!cancelled) setFetchedExtraCoaches([]) })
    return () => { cancelled = true }
  }, [team, missingStaffIds])

  // Nothing to fetch (no team, or every staff member is already on the roster) →
  // `[]`, exactly what the old effect's `setExtraCoaches([])` branches produced.
  const extraCoaches = missingStaffIds.length === 0 ? EMPTY_EXTRA_COACHES : fetchedExtraCoaches

  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [manageStaffOpen, setManageStaffOpen] = useState(false)
  const [accessOpen, setAccessOpen] = useState(false)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [adjustingCrop, setAdjustingCrop] = useState(false)
  const [cropPos, setCropPos] = useState({ x: 50, y: 50 })
  const [zoom, setZoom] = useState(1.0)
  const cropContainerRef = useRef<HTMLDivElement>(null)
  const draggingCrop = useRef(false)

  // Initialize crop position + zoom from team data. Adjusting state during render
  // (identity-compared on `team_picture_pos`, the old effect's only dependency)
  // instead of in an effect — same trigger, one fewer render.
  const picturePos = team?.team_picture_pos
  const [prevPicturePos, setPrevPicturePos] = useState(picturePos)
  if (prevPicturePos !== picturePos) {
    setPrevPicturePos(picturePos)
    if (picturePos) {
      const { x, y, z } = parsePicturePos(picturePos)
      setCropPos({ x, y })
      setZoom(z)
    }
  }

  function updateCropFromPointer(clientX: number, clientY: number) {
    const rect = cropContainerRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100))
    const y = Math.max(0, Math.min(100, ((clientY - rect.top) / rect.height) * 100))
    setCropPos({ x: Math.round(x), y: Math.round(y) })
  }

  const handleCropPointerDown = useCallback((e: React.PointerEvent) => {
    if (!adjustingCrop) return
    e.preventDefault()
    draggingCrop.current = true
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    updateCropFromPointer(e.clientX, e.clientY)
  }, [adjustingCrop])

  const handleCropPointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggingCrop.current) return
    updateCropFromPointer(e.clientX, e.clientY)
  }, [])

  const handleCropPointerUp = useCallback(() => {
    draggingCrop.current = false
  }, [])

  async function saveCropPosition() {
    if (!team) return
    const pos = `${cropPos.x}% ${cropPos.y}% ${zoom}`
    try {
      await updateRecord('teams', team.id, { team_picture_pos: pos })
      logActivity('update', 'teams', team.id, { team_picture_pos: pos })
      setTeam((prev) => prev ? { ...prev, team_picture_pos: pos } : prev)
    } catch { /* ignore */ }
    setAdjustingCrop(false)
  }

  function cancelCropAdjust() {
    if (team?.team_picture_pos) {
      const { x, y, z } = parsePicturePos(team.team_picture_pos)
      setCropPos({ x, y })
      setZoom(z)
    } else {
      setCropPos({ x: 50, y: 50 })
      setZoom(1.0)
    }
    setAdjustingCrop(false)
  }

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const sortMembers = useCallback((list: typeof members) => {
    const sorted = [...list]
    const dir = sortDir === 'asc' ? 1 : -1
    sorted.sort((a, b) => {
      const ma = asObj<Member>(a.member)
      const mb = asObj<Member>(b.member)
      if (!ma || !mb) return 0
      let cmp = 0
      switch (sortKey) {
        case 'name':
          cmp = (ma.last_name ?? '').localeCompare(mb.last_name ?? '') || (ma.first_name ?? '').localeCompare(mb.first_name ?? '')
          break
        case 'number':
          cmp = (ma.number || 999) - (mb.number || 999)
          break
        case 'position':
          cmp = coercePositions(ma.position).join(',').localeCompare(coercePositions(mb.position).join(','))
          break
        case 'email':
          cmp = (ma.email ?? '').localeCompare(mb.email ?? '')
          break
        case 'phone':
          cmp = (ma.hide_phone ? '' : ma.phone ?? '').localeCompare(mb.hide_phone ? '' : mb.phone ?? '')
          break
        case 'birthdate':
          cmp = (ma.birthdate_visibility === 'hidden' ? '' : ma.birthdate ?? '').localeCompare(mb.birthdate_visibility === 'hidden' ? '' : mb.birthdate ?? '')
          break
        case 'identity': {
          // Ascending puts the people still owing a document at the top — that is the
          // question this column is asked to answer, not "who uploaded first".
          const ua = identityDocs?.get(String(ma.id)) ?? ''
          const ub = identityDocs?.get(String(mb.id)) ?? ''
          cmp = (ua ? 1 : 0) - (ub ? 1 : 0) || ua.localeCompare(ub)
          break
        }
        case 'role': {
          const ra = getMemberRole(ma.id, team) ?? ''
          const rb = getMemberRole(mb.id, team) ?? ''
          cmp = ra.localeCompare(rb)
          break
        }
      }
      return cmp * dir
    })
    return sorted
  }, [sortKey, sortDir, team, identityDocs])

  // Staff = coaches + team responsibles. A staff member with no real playing
  // position is non-playing staff and must NOT be listed among the players.
  // Player-staff (a coach/TR who also has a playing position) are intentionally
  // shown in BOTH the staff section and the roster, flagged by their role badge.
  const staffIdSet = useMemo(
    () => new Set([...flattenMemberIds(team?.coach), ...flattenMemberIds(team?.team_responsible)]),
    [team],
  )
  const isPureStaff = useCallback((mt: ExpandedMemberTeam) => {
    const member = asObj<Member>(mt.member)
    if (!member) return false
    if (!staffIdSet.has(String(member.id))) return false
    return coercePositions(member.position).filter((p) => p !== 'other').length === 0
  }, [staffIdSet])

  const rosterMembers = useMemo(() => sortMembers(members.filter(mt => (Number(mt.guest_level) || 0) === 0 && !isPureStaff(mt))), [members, sortMembers, isPureStaff])
  const guestMembers = useMemo(() => sortMembers(members.filter(mt => (Number(mt.guest_level) || 0) > 0 && !isPureStaff(mt))), [members, sortMembers, isPureStaff])
  // Staff section: every coach + team responsible. Player-staff who also appear
  // in the roster are shown in both places (hence duplicated, by design); staff
  // with no roster row are fetched separately above. Deduped.
  const coachMembers = useMemo(() => {
    const fromRoster = members.filter((mt) => {
      const m = asObj<Member>(mt.member)
      return !!m && staffIdSet.has(String(m.id))
    })
    const seen = new Set(fromRoster.map((mt) => String(asObj<Member>(mt.member)?.id ?? mt.member)))
    const extras = extraCoaches.filter((mt) => !seen.has(String(asObj<Member>(mt.member)?.id ?? mt.member)))
    return sortMembers([...fromRoster, ...extras])
  }, [members, extraCoaches, staffIdSet, sortMembers])

  // Busy guards — prevent mobile double-tap / re-render from firing twice.
  const inFlightApprove = useRef<Set<string>>(new Set())
  const inFlightReject = useRef<Set<string>>(new Set())

  async function handleApprove(member: Member) {
    if (inFlightApprove.current.has(String(member.id))) return
    inFlightApprove.current.add(String(member.id))
    try {
      // Create member_teams FIRST — Postgres trigger blocks coach_approved_team=true without it.
      // Skip insert if a row already exists; unique constraint (migration 044) is the hard backstop.
      const existing = await fetchAllItems<{ id: string }>('member_teams', {
        filter: { _and: [{ member: { _eq: member.id } }, { team: { _eq: teamId! } }] },
        fields: ['id'],
      })
      if (!existing.length) {
        try {
          const mt = await createRecord<{id: string}>('member_teams', {
            member: member.id,
            team: teamId!,
            // The team's OWN season, not the wall clock — see RosterEditor.
            season: team?.season ?? getCurrentSeason(),
          }, { silentOnUnique: true })
          logActivity('create', 'member_teams', mt.id, { member: member.id, team: teamId })
        } catch (err) {
          if (!/has to be unique/i.test(err instanceof Error ? err.message : '')) throw err
        }
      }
      await updateRecord('members', member.id, { coach_approved_team: true })
      logActivity('update', 'members', member.id, { coach_approved_team: true })
      refetchPending()
    } catch {
      toast.error(t('common:errorSaving'))
    } finally {
      inFlightApprove.current.delete(String(member.id))
    }
  }

  async function handleReject(memberId: string) {
    if (inFlightReject.current.has(String(memberId))) return
    inFlightReject.current.add(String(memberId))
    try {
      await updateRecord('members', memberId, {
        kscw_membership_active: false,
        wiedisync_active: false,
        requested_team: null,
      })
      logActivity('update', 'members', memberId, { rejected: true })
      refetchPending()
    } catch {
      toast.error(t('common:errorSaving'))
    } finally {
      inFlightReject.current.delete(String(memberId))
    }
  }

  // Track selected guest_level per team request
  const [requestGuestLevels, setRequestGuestLevels] = useState<Record<string, number>>({})

  function setRequestGuestLevel(requestId: string, level: number) {
    setRequestGuestLevels((prev) => ({ ...prev, [requestId]: level }))
  }

  const inFlightApproveReq = useRef<Set<string>>(new Set())
  async function handleApproveRequest(request: TeamRequest) {
    const member = asObj<Member>(request.member)
    if (!member) return
    if (inFlightApproveReq.current.has(String(request.id))) return
    inFlightApproveReq.current.add(String(request.id))
    const guestLevel = requestGuestLevels[request.id] ?? 0
    try {
      // If a member_teams row exists for (member, team), update its guest_level rather
      // than create a duplicate. Unique constraint (migration 044) is the hard backstop.
      const existing = await fetchAllItems<{ id: string; guest_level: number }>('member_teams', {
        filter: { _and: [{ member: { _eq: member.id } }, { team: { _eq: teamId! } }] },
        fields: ['id', 'guest_level'],
      })
      if (existing.length) {
        if (Number(existing[0].guest_level ?? 0) !== guestLevel) {
          await updateRecord('member_teams', existing[0].id, { guest_level: guestLevel })
          logActivity('update', 'member_teams', existing[0].id, { guest_level: guestLevel })
        }
      } else {
        try {
          const mt = await createRecord<{id: string}>('member_teams', {
            member: member.id,
            team: teamId!,
            // The team's OWN season, not the wall clock — see RosterEditor.
            season: team?.season ?? getCurrentSeason(),
            guest_level: guestLevel,
          }, { silentOnUnique: true })
          logActivity('create', 'member_teams', mt.id, { member: member.id, team: teamId, guest_level: guestLevel })
        } catch (err) {
          if (!/has to be unique/i.test(err instanceof Error ? err.message : '')) throw err
        }
      }
      await updateRecord('team_requests', request.id, { status: 'approved' })
      refetchTeamRequests()
    } catch {
      toast.error(t('common:errorSaving'))
    } finally {
      inFlightApproveReq.current.delete(String(request.id))
    }
  }

  async function handleRejectRequest(requestId: string) {
    try {
      await updateRecord('team_requests', requestId, { status: 'rejected' })
      refetchTeamRequests()
    } catch {
      toast.error(t('common:errorSaving'))
    }
  }

  useEffect(() => {
    if (!teamSlug) return
    // Scope to the active (current-season) team — after the June-1 season rollover
    // there are two same-name rows (e.g. H3 2025/26 archived + 2026/27 active);
    // without active=true Directus returns the oldest (inactive) row, surfacing
    // last season's roster + guest levels. See INFRA.md → Season rollover.
    // `coach.id` / `team_responsible.id` are the JUNCTION row PKs — the staff
    // editors send them back on save so unchanged links update instead of
    // re-inserting (migration 245's pair uniques). See `m2mUpdatePayload`.
    fetchItems<Team>('teams', { filter: { _and: [{ name: { _eq: teamSlug } }, { active: { _eq: true } }] }, limit: 1, fields: ['*', 'coach.id', 'coach.members_id', 'team_responsible.id', 'team_responsible.members_id'] })
      .then((items) => setTeam(items[0] ?? null))
      .catch(() => setTeam(null))
      .finally(() => setLoading(false))
  }, [teamSlug])

  // Report to app boot gate — see usePageReady.tsx
  useReportPageLoading(loading || membersLoading)

  if (loading || membersLoading) {
    return null
  }

  if (!team || !canViewTeam(team.id)) {
    return <EmptyState icon={<XCircle className="h-10 w-10" />} title={t('noTeams')} />
  }

  return (
    <div>
      <div className="mb-6 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <Link to="/teams" className="hover:text-gray-700 dark:text-gray-300">{t('title')}</Link>
        <span>/</span>
        <span className="text-gray-900 dark:text-gray-100">{team.full_name}</span>
      </div>

      {team.team_picture && (
        <>
          <div
            ref={cropContainerRef}
            className="group relative mb-6 overflow-hidden rounded-lg"
            onPointerDown={handleCropPointerDown}
            onPointerMove={handleCropPointerMove}
            onPointerUp={handleCropPointerUp}
            style={{
              touchAction: adjustingCrop ? 'none' : 'auto',
              background: zoom < 1 ? 'linear-gradient(90deg, #4A55A2 0%, #3a4590 15%, #2a3580 50%, #3a4590 85%, #4A55A2 100%)' : undefined,
            }}
          >
            <img
              src={getFileUrl('teams', team.id, team.team_picture)}
              alt={team.full_name}
              className={`h-48 w-full sm:h-64 ${zoom < 1 ? 'object-contain' : 'object-cover'} ${adjustingCrop ? 'cursor-crosshair' : 'cursor-pointer'}`}
              style={{
                objectPosition: `${cropPos.x}% ${cropPos.y}%`,
                transform: zoom !== 1 ? `scale(${zoom})` : undefined,
                transformOrigin: `${cropPos.x}% ${cropPos.y}%`,
              }}
              onClick={adjustingCrop ? undefined : () => setLightboxOpen(true)}
              draggable={false}
            />
            {adjustingCrop && (
              <div className="absolute inset-0 border-2 border-dashed border-white/60 bg-black/10">
                <div
                  className="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-brand-500 shadow"
                  style={{ left: `${cropPos.x}%`, top: `${cropPos.y}%` }}
                />
              </div>
            )}
            {/* Crop controls for coaches */}
            {canManage && !adjustingCrop && (
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); setAdjustingCrop(true) }}
                className="absolute bottom-2 right-2 flex items-center gap-1.5 rounded-lg bg-black/50 px-3 py-1.5 text-xs font-medium text-white opacity-0 transition-opacity group-hover:opacity-100"
              >
                <Move className="h-3.5 w-3.5" />
                {t('adjustCrop')}
              </button>
            )}
            {adjustingCrop && (
              <div
                className="absolute bottom-2 left-2 right-2 flex items-end justify-between gap-2"
                onPointerDown={(e) => e.stopPropagation()}
              >
                {/* Zoom controls */}
                <div className="flex items-center gap-2 rounded-lg bg-black/60 px-3 py-1.5">
                  <button
                    onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(1)))}
                    className="rounded p-0.5 text-white hover:bg-white/20"
                    title={t('zoomOut')}
                  >
                    <ZoomOut className="h-4 w-4" />
                  </button>
                  <input
                    type="range"
                    min="0.5"
                    max="2"
                    step="0.1"
                    value={zoom}
                    onChange={(e) => setZoom(+e.target.value)}
                    className="h-1 w-20 cursor-pointer accent-brand-500 sm:w-28"
                  />
                  <button
                    onClick={() => setZoom((z) => Math.min(2, +(z + 0.1).toFixed(1)))}
                    className="rounded p-0.5 text-white hover:bg-white/20"
                    title={t('zoomIn')}
                  >
                    <ZoomIn className="h-4 w-4" />
                  </button>
                  <span className="min-w-[3ch] text-center text-xs text-white/80">{Math.round(zoom * 100)}%</span>
                </div>
                {/* Save/Cancel */}
                <div className="flex gap-2">
                  <button
                    onClick={saveCropPosition}
                    className="flex items-center gap-1 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700"
                  >
                    <Check className="h-3.5 w-3.5" />
                    {t('common:save')}
                  </button>
                  <button
                    onClick={cancelCropAdjust}
                    className="flex items-center gap-1 rounded-lg bg-gray-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700"
                  >
                    <XIcon className="h-3.5 w-3.5" />
                    {t('common:cancel')}
                  </button>
                </div>
              </div>
            )}
          </div>
          <ImageLightbox
            src={getFileUrl('teams', team.id, team.team_picture)}
            alt={team.full_name}
            open={lightboxOpen}
            onClose={() => setLightboxOpen(false)}
          />
        </>
      )}

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <TeamChip team={team.name} />
            <h1 className="text-xl font-bold text-gray-900 sm:text-2xl dark:text-gray-100">{team.full_name}</h1>
            {team.social_url && sanitizeUrl(team.social_url) && (
              <a
                href={sanitizeUrl(team.social_url)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-400 transition-colors hover:text-brand-500"
                title="Social"
              >
                <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z" />
                </svg>
              </a>
            )}
          </div>
          <div className="mt-2 flex gap-4 text-sm text-gray-500 dark:text-gray-400">
            <span>{team.league}</span>
            <span>{team.season}</span>
            <span className="inline-flex items-center gap-1">
              {team.sport === 'basketball'
                ? <BasketballIcon className="h-4 w-4" filled />
                : <VolleyballIcon className="h-4 w-4" filled />}
              {team.sport === 'volleyball' ? 'Volleyball' : 'Basketball'}
            </span>
          </div>
        </div>

        {canManageTeam(teamId ?? '') && (
          <Link
            to={`/teams/${teamSlug}/roster/edit`}
            className="inline-flex items-center justify-center rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-600"
          >
            {t('editTeam')}
          </Link>
        )}
      </div>

      {/* Pending member requests (signup + team join requests) */}
      {canManage && (pendingMembers.length > 0 || teamRequests.length > 0) && (
        <div className="mt-6 rounded-lg border-2 border-amber-300 bg-amber-50 p-4 dark:border-amber-600 dark:bg-amber-900/20">
          <h3 className="text-sm font-semibold text-amber-800 dark:text-amber-300">
            {t('pendingRequests', { count: pendingMembers.length + teamRequests.length })}
          </h3>
          <div className="mt-3 space-y-3">
            {/* Signup requests */}
            {pendingMembers.map((member) => (
              <div key={member.id} className="rounded-lg bg-white p-3 dark:bg-gray-800">
                <p className="font-medium text-gray-900 dark:text-gray-100">
                  {memberDisplayName(member)}
                </p>
                <p className="truncate text-sm text-gray-500 dark:text-gray-400">{member.email}</p>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <Button
                    size="sm"
                    onClick={() => handleApprove(member)}
                    className="w-full bg-green-600 hover:bg-green-700 dark:bg-green-600 dark:hover:bg-green-700"
                  >
                    {t('approve')}
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => handleReject(member.id)}
                    className="w-full"
                  >
                    {t('reject')}
                  </Button>
                </div>
              </div>
            ))}
            {/* Team join requests from existing members */}
            {teamRequests.map((req) => {
              const member = asObj<Member>(req.member)
              const selectedLevel = requestGuestLevels[req.id] ?? 0
              return (
                <div key={req.id} className="rounded-lg bg-white p-3 dark:bg-gray-800">
                  <p className="font-medium text-gray-900 dark:text-gray-100">
                    {memberDisplayName(member)}
                  </p>
                  <p className="truncate text-sm text-gray-500 dark:text-gray-400">
                    {member?.email} · {t('teamJoinRequest')}
                  </p>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <Button
                      size="sm"
                      onClick={() => handleApproveRequest(req)}
                      className="w-full bg-green-600 hover:bg-green-700 dark:bg-green-600 dark:hover:bg-green-700"
                    >
                      {t('approve')}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => handleRejectRequest(req.id)}
                      className="w-full"
                    >
                      {t('reject')}
                    </Button>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-gray-500 dark:text-gray-400">{t('joinAs')}</span>
                    {[0, 1, 2, 3].map((level) => (
                      <button
                        key={level}
                        onClick={() => setRequestGuestLevel(req.id, level)}
                        className={`rounded border px-2 py-0.5 text-xs font-medium transition-colors ${
                          selectedLevel === level
                            ? 'border-brand-500 bg-brand-500 text-white'
                            : 'border-gray-300 text-gray-600 hover:border-brand-400 dark:border-gray-600 dark:text-gray-400 dark:hover:border-brand-500'
                        }`}
                      >
                        {level === 0 ? t('rolePlayer') : `${t('positionGuest')} L${level}`}
                      </button>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Coaches */}
      {(coachMembers.length > 0 || (effectiveIsAdmin && hasAdminAccessToTeam(team.id))) && (
        <div className="mt-8">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('staff')} ({coachMembers.length})</h2>
            {effectiveIsAdmin && hasAdminAccessToTeam(team.id) && (
              <Button variant="outline" size="sm" onClick={() => setManageStaffOpen(true)}>
                {t('manageStaff')}
              </Button>
            )}
          </div>
          {coachMembers.length > 0 && (
            <RosterTable
              members={coachMembers}
              team={team}
              canManage={canManage}
              isAdmin={effectiveIsAdmin && hasAdminAccessToTeam(team.id)}
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
              onTeamUpdate={(updated) => setTeam((prev) => prev ? { ...prev, ...updated } : prev)}
              identityDocs={identityDocs}
              canEditRole={false}
            />
          )}
        </div>
      )}

      {/* Staff-only, and self-hiding when there is nothing to repair. Sits above the roster
          because the identity column below is exactly where the gap becomes visible. */}
      <TeamIdentityRepair teamId={teamId} enabled={canManage} />

      <div className="mt-8">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('currentRoster', { count: rosterMembers.length })}</h2>
          {/* Staff-only, and only once the identity column has an answer — same gate as the
              column itself, so the button never offers a view the server will refuse. */}
          {canManage && identityDocs !== null && identityDocs.size > 0 && (
            <Button variant="outline" size="sm" onClick={() => setAccessOpen(true)}>
              {t('identityAccessButton')}
            </Button>
          )}
        </div>

        {members.length === 0 ? (
          <EmptyState
            icon={<User className="h-10 w-10" />}
            title={t('noMembers')}
            description={t('noMembersDescription')}
            action={
              canManageTeam(teamId ?? '') ? (
                <Link
                  to={`/teams/${teamSlug}/roster/edit`}
                  className="text-sm text-brand-600 hover:text-brand-700"
                >
                  {t('addPlayer')}
                </Link>
              ) : undefined
            }
          />
        ) : (
          <RosterTable
            members={rosterMembers}
            team={team}
            canManage={canManage}
            isAdmin={effectiveIsAdmin && hasAdminAccessToTeam(team.id)}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
            onTeamUpdate={(updated) => setTeam((prev) => prev ? { ...prev, ...updated } : prev)}
            identityDocs={identityDocs}
          />
        )}
      </div>

      {/* Guests */}
      {guestMembers.length > 0 && (
        <div className="mt-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('participation:guests')} ({guestMembers.length})</h2>
          <RosterTable
            members={guestMembers}
            team={team}
            canManage={canManage}
            isAdmin={effectiveIsAdmin && hasAdminAccessToTeam(team.id)}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
            onTeamUpdate={(updated) => setTeam((prev) => prev ? { ...prev, ...updated } : prev)}
            identityDocs={identityDocs}
            showGuestColumn
          />
        </div>
      )}

      {/* Game schedule — proposed + confirmed games (volleyball, members) */}
      {/* Team calendar — the member calendar (/calendar), scoped to this team.
          Games, trainings, events and hall closures, in the same visual language a
          player already knows from the calendar page. */}
      <TeamCalendar team={team} />

      {/* Still-open game negotiations — the one scheduling fact a calendar cannot
          show, because the date is still several candidates wide. Renders nothing
          once everything is agreed. */}
      <TeamScheduleCalendar team={team} variant="proposals" />

      {/* Polls */}
      {teamId && isFeatureEnabled(team.features_enabled, 'polls') && (
        <div className="mt-8">
          <PollsSection teamId={teamId} canManage={canManage} />
        </div>
      )}

      {/* Nachrichten */}
      {messagingFeatureEnabled(user?.id) && team && (
        <TeamMessagesSection teamId={String(team.id)} />
      )}

      {/* Sponsors */}
      {teamSponsors.length > 0 && (
        <div className="mt-8">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('sponsors')}</h2>
          <div className="mt-3 flex flex-wrap items-center gap-6">
            {teamSponsors.map((sp) => (
              <div key={sp.id} className="flex flex-col items-center gap-2">
                {sp.logo && (
                  <img
                    src={getFileUrl('sponsors', sp.id, sp.logo)}
                    alt={sp.name}
                    className="h-12 w-auto object-contain"
                  />
                )}
                <span className="text-sm text-gray-500 dark:text-gray-400">{sp.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {effectiveIsAdmin && hasAdminAccessToTeam(team.id) && (
        <ManageStaffModal
          open={manageStaffOpen}
          onClose={() => setManageStaffOpen(false)}
          team={team}
          onTeamUpdate={(updated) => setTeam((prev) => prev ? { ...prev, ...updated } : prev)}
        />
      )}

      {canManage && (
        <TeamIdentityAccessModal teamId={teamId} open={accessOpen} onOpenChange={setAccessOpen} />
      )}
    </div>
  )
}

// Shared roster table (staff / roster / guests). Replaces the three duplicated
// raw <table> + SortHeader blocks with the shadcn <Table> primitive; the guest
// variant renders an extra guest-level column right after the player column.
function RosterTable({
  members,
  team,
  canManage,
  isAdmin,
  sortKey,
  sortDir,
  onSort,
  onTeamUpdate,
  identityDocs,
  canEditRole = true,
  showGuestColumn = false,
}: {
  members: ExpandedMemberTeam[]
  team: Team
  canManage: boolean
  isAdmin: boolean
  sortKey: SortKey
  sortDir: SortDir
  onSort: (key: SortKey) => void
  onTeamUpdate: (updated: Partial<Team>) => void
  /** member id → upload timestamp; `null` = unknown, and the column is then not rendered. */
  identityDocs: Map<string, string> | null
  canEditRole?: boolean
  showGuestColumn?: boolean
}) {
  const { t } = useTranslation('teams')
  // Staff-only, and only once we actually have an answer — see useTeamIdentityDocs.
  const showIdentity = canManage && identityDocs !== null
  return (
    <div className="mt-4 rounded-lg border bg-white dark:bg-gray-800">
      <Table>
        <TableHeader>
          <TableRow className="bg-gray-50 dark:bg-gray-900 text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">
            <SortHeader label={t('playerCol')} sortKey="name" current={sortKey} dir={sortDir} onClick={onSort} />
            {showGuestColumn && (
              <TableHead className="px-4 py-3 text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('guestCol')}</TableHead>
            )}
            <SortHeader label={t('numberCol')} sortKey="number" current={sortKey} dir={sortDir} onClick={onSort} className="text-center" />
            <SortHeader label={t('positionCol')} sortKey="position" current={sortKey} dir={sortDir} onClick={onSort} className="hidden sm:table-cell" />
            {canManage && <SortHeader label={t('emailCol')} sortKey="email" current={sortKey} dir={sortDir} onClick={onSort} className="hidden md:table-cell" />}
            {canManage && <SortHeader label={t('phoneCol')} sortKey="phone" current={sortKey} dir={sortDir} onClick={onSort} className="hidden md:table-cell" />}
            {canManage && <SortHeader label={t('birthdateCol')} sortKey="birthdate" current={sortKey} dir={sortDir} onClick={onSort} className="hidden lg:table-cell" />}
            {showIdentity && <SortHeader label={t('identityCol')} sortKey="identity" current={sortKey} dir={sortDir} onClick={onSort} className="text-center" />}
            <SortHeader label={t('roleCol')} sortKey="role" current={sortKey} dir={sortDir} onClick={onSort} />
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((mt) => (
            <MemberRow
              key={mt.id as string}
              memberTeam={mt}
              teamId={team.id}
              teamSlug={team.name}
              team={team}
              canEdit={canManage}
              isAdmin={isAdmin}
              canEditRole={canEditRole}
              showContact={canManage}
              showIdentity={showIdentity}
              identityUploadedAt={identityDocs?.get(String(asObj<Member>(mt.member)?.id ?? mt.member)) ?? null}
              showGuestColumn={showGuestColumn}
              onTeamUpdate={onTeamUpdate}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function SortHeader({ label, sortKey: key, current, dir, onClick, className = '' }: {
  label: string
  sortKey: SortKey
  current: SortKey
  dir: SortDir
  onClick: (key: SortKey) => void
  className?: string
}) {
  const active = current === key
  return (
    <TableHead
      className={`px-4 py-3 text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400 cursor-pointer select-none hover:text-gray-700 dark:hover:text-gray-200 ${className}`}
      onClick={() => onClick(key)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active && (
          <svg className="h-3 w-3" viewBox="0 0 12 12" fill="currentColor">
            {dir === 'asc'
              ? <path d="M6 3L10 9H2z" />
              : <path d="M6 9L2 3h8z" />}
          </svg>
        )}
      </span>
    </TableHead>
  )
}

function TeamMessagesSection({ teamId }: { teamId: string }) {
  const { t } = useTranslation('messaging')
  const { user } = useAuth()
  const { conversations, isLoading, markRead, toggleMute } = useConversationsContext()
  const [open, setOpen] = useState(true)
  const conv = useMemo(
    () => conversations.find(c => c.type === 'team' && String(c.team) === String(teamId)) ?? null,
    [conversations, teamId],
  )
  const teamChatEnabled = user?.communications_team_chat_enabled === true

  // Hide the whole section for non-participants: team chat is on but, once the
  // conversation list has loaded, the caller has no conversation for this team
  // (i.e. they aren't a member of it). Members who turned team chat off still
  // see the section so the "enable team chat" banner can prompt them.
  if (teamChatEnabled && !isLoading && !conv) return null

  return (
    <section className="mt-6 rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 font-semibold text-sm">
          <MessageSquare className="h-4 w-4" />
          {t('tabLabel')}
        </span>
        {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>
      {open && (
        <div className="border-t border-border">
          <TeamMessagesTab
            conv={conv}
            teamChatEnabled={teamChatEnabled}
            isLoading={isLoading}
            onMarkRead={markRead}
            onToggleMute={toggleMute}
          />
        </div>
      )}
    </section>
  )
}
