import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { X } from 'lucide-react'
import Modal from '../../components/Modal'
import ConfirmDialog from '@/components/ConfirmDialog'
import { Button } from '../../components/ui/button'
import { getFileUrl } from '../../utils/fileUrl'
import { logActivity } from '../../utils/logActivity'
import { updateRecord, m2mUpdatePayload } from '../../lib/api'
import { useCollection } from '../../lib/query'
import { flattenMemberIds, memberFirstName } from '../../utils/relations'
import type { Team, Member } from '../../types'

type StaffRole = 'coach' | 'team_responsible'

interface ManageStaffModalProps {
  open: boolean
  onClose: () => void
  team: Team
  onTeamUpdate: (updated: Partial<Team>) => void
}

function displayName(m: Member | undefined): string {
  if (!m) return '—'
  return [m.last_name, (m.nickname || m.first_name)].filter(Boolean).join(' ') || '—'
}

/**
 * Admin-only editor for a team's coaches + team responsibles. Unlike the
 * MemberRow role dropdown this works for members WITHOUT a roster row
 * (non-playing staff) — any club member can be searched and attached.
 * Writes the M2M aliases in junction-object format ({ members_id }) so the
 * role-sync hook grants/revokes the LEADER policy as usual.
 */
export default function ManageStaffModal({ open, onClose, team, onTeamUpdate }: ManageStaffModalProps) {
  const { t } = useTranslation('teams')
  const [pendingRemove, setPendingRemove] = useState<{ id: string; role: StaffRole } | null>(null)
  const [busy, setBusy] = useState(false)

  // Unfiltered on membership so current staff always resolve to a name; the
  // search pool below narrows to active members.
  //
  // The roster used to be `useState<Member[]>([])` filled by an open-gated
  // effect, so `[]` meant three things at once: still downloading, request
  // failed, and nobody matches. That painted definitive answers over an
  // unloaded roster — "No results" for a coach who IS in the club, and an
  // em-dash name next to a live remove button. `isPending` (not `isLoading`)
  // is the gate: it stays true across the `enabled: open` flip, and goes
  // false on failure so a dead fetch shows an error, not a forever skeleton.
  const {
    data: allMembers = [],
    isPending: membersLoading,
    isError: membersError,
  } = useCollection<Member>('members', {
    sort: ['last_name'],
    fields: ['id', 'first_name', 'nickname', 'last_name', 'photo', 'kscw_membership_active'],
    all: true,
    enabled: open,
    // No staleTime on purpose: this modal is opened to act on the CURRENT roster,
    // and it replaced a per-open fetch. Caching it for a minute would hide a member
    // added elsewhere from the very screen you opened to find them.
  })

  const memberById = useMemo(() => {
    const map = new Map<string, Member>()
    for (const m of allMembers) map.set(String(m.id), m)
    return map
  }, [allMembers])

  const currentIds: Record<StaffRole, string[]> = {
    coach: flattenMemberIds(team.coach),
    team_responsible: flattenMemberIds(team.team_responsible),
  }

  async function setRole(role: StaffRole, nextIds: string[]) {
    // Re-send each surviving link with its junction row PK, otherwise Directus
    // re-inserts it and trips `teams_coaches_pair_uq` (migration 245).
    const junctionPayload = m2mUpdatePayload('members_id', nextIds, team[role])
    // Read the saved junctions back so a second toggle in the same session has
    // PKs for the links this call just created.
    const saved = await updateRecord<Team>('teams', team.id, { [role]: junctionPayload }, {
      fields: ['id', `${role}.id`, `${role}.members_id`],
    })
    logActivity('update', 'teams', team.id, { [role]: nextIds })
    onTeamUpdate({ [role]: saved[role] ?? junctionPayload } as Partial<Team>)
  }

  async function handleAdd(role: StaffRole, memberId: string) {
    if (busy || currentIds[role].includes(memberId)) return
    setBusy(true)
    try {
      await setRole(role, [...currentIds[role], memberId])
      toast.success(t('memberAdded', { name: displayName(memberById.get(memberId)) }))
    } catch {
      toast.error(t('common:errorSaving'))
    } finally {
      setBusy(false)
    }
  }

  async function handleRemove() {
    if (!pendingRemove || busy) return
    const { id, role } = pendingRemove
    setBusy(true)
    try {
      await setRole(role, currentIds[role].filter((mid) => mid !== id))
      toast.success(t('staffRemoved', { name: displayName(memberById.get(id)) }))
    } catch {
      toast.error(t('common:errorSaving'))
    } finally {
      setBusy(false)
      setPendingRemove(null)
    }
  }

  const roleLabel: Record<StaffRole, string> = {
    coach: t('roleCoach'),
    team_responsible: t('roleTeamResponsible'),
  }

  return (
    <Modal open={open} onClose={onClose} title={t('manageStaffTitle')} size="md">
      <p className="text-xs text-gray-500 dark:text-gray-400">{t('manageStaffHint')}</p>

      <StaffSection
        heading={t('coaches')}
        role="coach"
        currentIds={currentIds.coach}
        memberById={memberById}
        allMembers={allMembers}
        membersLoading={membersLoading}
        membersError={membersError}
        busy={busy}
        onAdd={handleAdd}
        onRemove={(id) => setPendingRemove({ id, role: 'coach' })}
      />

      <StaffSection
        heading={t('teamResponsibles')}
        role="team_responsible"
        currentIds={currentIds.team_responsible}
        memberById={memberById}
        allMembers={allMembers}
        membersLoading={membersLoading}
        membersError={membersError}
        busy={busy}
        onAdd={handleAdd}
        onRemove={(id) => setPendingRemove({ id, role: 'team_responsible' })}
      />

      <ConfirmDialog
        open={pendingRemove !== null}
        onClose={() => setPendingRemove(null)}
        onConfirm={handleRemove}
        title={t('removeStaffTitle')}
        message={t('removeStaffMessage', {
          name: displayName(pendingRemove ? memberById.get(pendingRemove.id) : undefined),
          role: pendingRemove ? roleLabel[pendingRemove.role] : '',
        })}
        confirmLabel={t('common:remove')}
        danger
      />
    </Modal>
  )
}

function StaffSection({ heading, role, currentIds, memberById, allMembers, membersLoading, membersError, busy, onAdd, onRemove }: {
  heading: string
  role: StaffRole
  currentIds: string[]
  memberById: Map<string, Member>
  allMembers: Member[]
  membersLoading: boolean
  membersError: boolean
  busy: boolean
  onAdd: (role: StaffRole, memberId: string) => void
  onRemove: (memberId: string) => void
}) {
  const { t } = useTranslation('teams')
  const [search, setSearch] = useState('')

  const searchLower = search.toLowerCase()
  const matches = search.length >= 2
    ? allMembers.filter((m) =>
        m.kscw_membership_active &&
        !currentIds.includes(String(m.id)) &&
        (displayName(m).toLowerCase().includes(searchLower) ||
          m.first_name?.toLowerCase().includes(searchLower) ||
          m.last_name?.toLowerCase().includes(searchLower)))
    : []

  return (
    <div className="mt-5">
      <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
        {heading} ({currentIds.length})
      </h3>

      {currentIds.length === 0 ? (
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t('noStaffYet')}</p>
      ) : (
        <ul className="mt-2 divide-y divide-gray-100 rounded-lg border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
          {currentIds.map((id) => {
            const m = memberById.get(id)
            // The junction gives the ids synchronously, the names arrive a
            // round-trip later. An unresolved row therefore means "roster not
            // loaded", not "member without a name" — keep '—' for the latter
            // and don't offer the destructive X against a row nobody can read
            // (the ConfirmDialog would ask "Remove — as coach?").
            const unresolved = membersLoading && !m
            return (
              <li key={id} className="flex min-h-[44px] items-center gap-3 px-3 py-1.5">
                <Avatar member={m} pending={unresolved} />
                <span className="min-w-0 flex-1 truncate text-sm text-gray-900 dark:text-gray-100">
                  {unresolved
                    ? <span className="block h-4 w-32 max-w-full animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
                    : displayName(m)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-9 w-9 shrink-0 p-0 text-gray-400 hover:text-red-600 dark:hover:text-red-400"
                  onClick={() => onRemove(id)}
                  disabled={busy || unresolved}
                  title={t('common:remove')}
                >
                  <X className="h-4 w-4" />
                </Button>
              </li>
            )
          })}
        </ul>
      )}

      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t('searchPlaceholder')}
        className="mt-2 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500"
      />
      {search.length >= 2 && (
        <div className="mt-1 max-h-44 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
          {/* Never claim "No results" against a pool that hasn't arrived — an
              admin who reads it goes off and creates a duplicate member. */}
          {membersLoading ? (
            <p className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{t('common:loading')}</p>
          ) : membersError ? (
            <p className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{t('common:error')}</p>
          ) : matches.length === 0 ? (
            <p className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">{t('noSearchResults')}</p>
          ) : (
            matches.slice(0, 10).map((m) => (
              <button
                key={m.id}
                onClick={() => { onAdd(role, String(m.id)); setSearch('') }}
                disabled={busy}
                className="flex min-h-[44px] w-full items-center gap-3 px-4 py-2 text-left text-sm text-gray-900 hover:bg-gray-50 disabled:pointer-events-none disabled:opacity-50 dark:text-gray-100 dark:hover:bg-gray-700"
              >
                <Avatar member={m} />
                <span>{displayName(m)}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

function Avatar({ member, pending }: { member: Member | undefined; pending?: boolean }) {
  if (pending && !member) {
    return <div className="h-6 w-6 shrink-0 animate-pulse rounded-full bg-gray-200 dark:bg-gray-700" aria-hidden="true" />
  }
  if (member?.photo) {
    return (
      <img
        src={getFileUrl('members', member.id, member.photo)}
        alt=""
        className="h-6 w-6 shrink-0 rounded-full object-cover"
      />
    )
  }
  return (
    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-200 text-xs text-gray-600 dark:bg-gray-600 dark:text-gray-300">
      {member ? `${memberFirstName(member)[0] ?? ''}${member.last_name?.[0] ?? ''}` : '?'}
    </div>
  )
}
