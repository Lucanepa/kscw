import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import pb from '../../pb'
import StatusBadge from '../../components/StatusBadge'
import { getFileUrl } from '../../utils/pbFile'
import type { ExpandedMemberTeam } from '../../hooks/useTeamMembers'
import type { Team, Member } from '../../types'

interface MemberRowProps {
  memberTeam: ExpandedMemberTeam
  teamId: string
  teamSlug: string
  team?: Team | null
  canEdit?: boolean
  isAdmin?: boolean
  onTeamUpdate?: (updated: Partial<Team>) => void
}

const POSITIONS: Member['position'][] = ['setter', 'outside', 'middle', 'opposite', 'libero', 'coach', 'other']

const positionKeys: Record<string, string> = {
  setter: 'positionSetter',
  outside: 'positionOutside',
  middle: 'positionMiddle',
  opposite: 'positionOpposite',
  libero: 'positionLibero',
  coach: 'positionCoach',
  other: 'positionOther',
}

export const roleColors: Record<string, { bg: string; text: string }> = {
  captain: { bg: '#fef3c7', text: '#92400e' },
  coach: { bg: '#dbeafe', text: '#1e40af' },
  assistant: { bg: '#e0f2fe', text: '#075985' },
  team_responsible: { bg: '#ede9fe', text: '#5b21b6' },
}

type LeadershipRole = 'coach' | 'assistant' | 'captain' | 'team_responsible'
const LEADERSHIP_ROLES: LeadershipRole[] = ['coach', 'assistant', 'captain', 'team_responsible']
const roleI18nKeys: Record<LeadershipRole, string> = {
  coach: 'roleCoach',
  assistant: 'roleAssistant',
  captain: 'roleCaptain',
  team_responsible: 'roleTeamResponsible',
}

export function getMemberRole(memberId: string, team?: Team | null): string | null {
  if (!team) return null
  if (team.coach?.includes(memberId)) return 'coach'
  if (team.assistant?.includes(memberId)) return 'assistant'
  if (team.captain?.includes(memberId)) return 'captain'
  if (team.team_responsible?.includes(memberId)) return 'team_responsible'
  return null
}

export default function MemberRow({ memberTeam, teamId, teamSlug, team, canEdit, isAdmin, onTeamUpdate }: MemberRowProps) {
  const { t } = useTranslation('teams')
  const member = memberTeam.expand?.member
  const [editingField, setEditingField] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')

  if (!member) return null

  const displayName = [member.last_name, member.first_name].filter(Boolean).join(' ') || member.name || '—'
  const initials = `${member.first_name?.[0] ?? ''}${member.last_name?.[0] ?? ''}`.toUpperCase()
  const role = getMemberRole(member.id, team)

  const birthdate = member.birthdate
    ? new Date(member.birthdate).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : null

  async function saveField(field: string, value: string | number) {
    try {
      await pb.collection('members').update(member!.id, { [field]: value })
      // Update the local expand to reflect change immediately
      if (memberTeam.expand?.member) {
        ;(memberTeam.expand.member as Record<string, unknown>)[field] = value
      }
    } catch {
      // ignore
    }
    setEditingField(null)
  }

  async function toggleRole(roleKey: LeadershipRole) {
    if (!team || !onTeamUpdate) return
    const current: string[] = team[roleKey] ?? []
    const next = current.includes(member!.id)
      ? current.filter((id) => id !== member!.id)
      : [...current, member!.id]
    try {
      await pb.collection('teams').update(team.id, { [roleKey]: next })
      onTeamUpdate({ [roleKey]: next })
    } catch {
      // ignore
    }
  }

  function startEdit(field: string, currentValue: string | number) {
    setEditingField(field)
    setEditValue(String(currentValue ?? ''))
  }

  function handleKeyDown(e: React.KeyboardEvent, field: string) {
    if (e.key === 'Enter') {
      const val = field === 'number' ? (editValue ? parseInt(editValue, 10) : 0) : editValue
      saveField(field, val)
    } else if (e.key === 'Escape') {
      setEditingField(null)
    }
  }

  return (
    <tr className="border-b last:border-0 hover:bg-gray-50 dark:hover:bg-gray-700">
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          {member.photo ? (
            <img
              src={getFileUrl('members', member.id, member.photo)}
              alt={displayName}
              className="h-8 w-8 rounded-full object-cover"
            />
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-200 text-xs font-medium text-gray-600 dark:text-gray-400">
              {initials}
            </div>
          )}
          <Link
            to={`/teams/player/${member.id}?from=${teamSlug}`}
            className="text-sm font-medium text-gray-900 hover:text-brand-600 dark:text-gray-100"
          >
            {displayName}
          </Link>
        </div>
      </td>

      {/* Number — editable by coach */}
      <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
        {canEdit && editingField === 'number' ? (
          <input
            type="number"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => handleKeyDown(e, 'number')}
            onBlur={() => saveField('number', editValue ? parseInt(editValue, 10) : 0)}
            className="w-14 rounded border px-1.5 py-0.5 text-sm dark:bg-gray-700 dark:border-gray-600"
            autoFocus
          />
        ) : (
          <span
            className={canEdit ? 'cursor-pointer hover:text-brand-600' : ''}
            onClick={canEdit ? () => startEdit('number', member.number) : undefined}
          >
            {member.number || '—'}
          </span>
        )}
      </td>

      {/* Position — editable by coach */}
      <td className="hidden px-4 py-3 text-sm text-gray-500 sm:table-cell dark:text-gray-400">
        {canEdit && editingField === 'position' ? (
          <select
            value={editValue}
            onChange={(e) => { saveField('position', e.target.value) }}
            onBlur={() => setEditingField(null)}
            className="rounded border px-1.5 py-0.5 text-sm dark:bg-gray-700 dark:border-gray-600"
            autoFocus
          >
            {POSITIONS.map((p) => (
              <option key={p} value={p}>{positionKeys[p] ? t(positionKeys[p]) : p}</option>
            ))}
          </select>
        ) : (
          <span
            className={canEdit ? 'cursor-pointer hover:text-brand-600' : ''}
            onClick={canEdit ? () => startEdit('position', member.position) : undefined}
          >
            {positionKeys[member.position] ? t(positionKeys[member.position]) : member.position}
          </span>
        )}
      </td>

      <td className="hidden px-4 py-3 text-sm text-gray-500 md:table-cell dark:text-gray-400">
        {member.email || '—'}
      </td>
      <td className="hidden px-4 py-3 text-sm text-gray-500 md:table-cell dark:text-gray-400">
        {member.phone || '—'}
      </td>
      <td className="hidden px-4 py-3 text-sm text-gray-500 lg:table-cell dark:text-gray-400">
        {birthdate || '—'}
      </td>

      {/* Role — editable by admin only */}
      <td className="px-4 py-3">
        {isAdmin && editingField === 'role' ? (
          <div className="flex flex-wrap gap-1">
            {LEADERSHIP_ROLES.map((r) => {
              const active = (team?.[r] ?? []).includes(member.id)
              return (
                <button
                  key={r}
                  onClick={() => toggleRole(r)}
                  className={`rounded-full px-2 py-0.5 text-xs font-medium transition-colors ${
                    active
                      ? 'bg-brand-500 text-white'
                      : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-400'
                  }`}
                >
                  {t(roleI18nKeys[r])}
                </button>
              )
            })}
            <button
              onClick={() => setEditingField(null)}
              className="ml-1 text-xs text-gray-400 hover:text-gray-600"
            >
              ✓
            </button>
          </div>
        ) : (
          <span
            className={isAdmin ? 'cursor-pointer' : ''}
            onClick={isAdmin ? () => setEditingField('role') : undefined}
          >
            {role ? <StatusBadge status={role} colorMap={roleColors} /> : isAdmin ? <span className="text-xs text-gray-400 hover:text-brand-600">+</span> : null}
          </span>
        )}
      </td>
    </tr>
  )
}
