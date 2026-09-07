import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '@/components/Modal'
import TeamChip from '../../../components/TeamChip'
import { useTeamPermissions } from '../../../hooks/useTeamPermissions'
import { formatDate } from '../../../utils/dateHelpers'
import { logActivity } from '../../../utils/logActivity'
import type { HallSlot, Hall, Team, SlotClaim } from '../../../types'
import { updateRecord } from '../../../lib/api'

interface Props {
  slot: HallSlot
  claim: SlotClaim
  halls: Hall[]
  teams: Team[]
  onClose: () => void
  onReleased: () => void
}

function DetailRow({ label, value }: { label: string; value: string }) {
  if (!value) return null
  return (
    <div className="flex gap-3 py-1.5">
      <span className="w-28 shrink-0 text-sm font-medium text-gray-500 dark:text-gray-400">{label}</span>
      <span className="text-sm text-gray-900 dark:text-gray-100">{value}</span>
    </div>
  )
}

export default function ClaimDetailModal({ slot, claim, halls, teams, onClose, onReleased }: Props) {
  const { t } = useTranslation('hallenplan')
  const { canManageTeam } = useTeamPermissions()
  const [releasing, setReleasing] = useState(false)
  const [confirmRelease, setConfirmRelease] = useState(false)

  const hallName = halls.find((h) => h.id === slot.hall)?.name ?? ''
  const originalTeams = teams.filter((tm) => slot.team?.includes(tm.id))
  const claimingTeam = teams.find((tm) => tm.id === claim.claimed_by_team)

  // Resolve claiming member name from expanded relation
  const claimedByMember = typeof claim.claimed_by_member === 'object' && claim.claimed_by_member != null
    ? (claim.claimed_by_member as { first_name?: string; last_name?: string; nickname?: string | null })
    : null
  const memberName = claimedByMember
    ? `${claimedByMember.nickname || claimedByMember.first_name || ''} ${claimedByMember.last_name || ''}`.trim()
    : ''

  // `isAdmin ||` was mode-blind too — canManageTeam covers the sport admin, in admin mode.
  const canRelease = canManageTeam(claim.claimed_by_team)

  async function handleRelease() {
    setReleasing(true)
    try {
      await updateRecord('slot_claims', claim.id, { status: 'revoked' })
      logActivity('update', 'slot_claims', claim.id, { status: 'revoked' })
      onReleased()
    } catch {
      setReleasing(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={t('claimDetailTitle')} size="sm">
      <div className="space-y-1">
        <DetailRow label={t('hall')} value={hallName} />
        <DetailRow label={t('date')} value={claim.date ? formatDate(claim.date.slice(0, 10)) : ''} />
        <DetailRow label={t('startTime')} value={slot.start_time} />
        <DetailRow label={t('endTime')} value={slot.end_time} />

        {originalTeams.length > 0 && (
          <div className="flex gap-3 py-1.5">
            <span className="w-28 shrink-0 text-sm font-medium text-gray-500 dark:text-gray-400">
              {t('claimOriginalTeam')}
            </span>
            <span className="flex flex-wrap items-center gap-1">
              {originalTeams.map((tm) => (
                <TeamChip key={tm.id} team={tm.name} size="sm" />
              ))}
            </span>
          </div>
        )}

        <DetailRow
          label={t('reason')}
          value={
            claim.freed_reason === 'cancelled_training'
              ? t('claimReasonCancelled')
              : claim.freed_reason === 'away_game'
                ? t('claimReasonAway')
                : t('slotFreed')
          }
        />
      </div>

      <div className="mt-4 space-y-1 border-t border-gray-200 pt-4 dark:border-gray-700">
        {claimingTeam && (
          <div className="flex gap-3 py-1.5">
            <span className="w-28 shrink-0 text-sm font-medium text-gray-500 dark:text-gray-400">
              {t('claimClaimedBy')}
            </span>
            <div className="flex items-center gap-2">
              <TeamChip team={claimingTeam.name} size="sm" />
              {memberName && (
                <span className="text-xs text-gray-500 dark:text-gray-400">({memberName})</span>
              )}
            </div>
          </div>
        )}
        <DetailRow label={t('claimClaimedAt')} value={claim.created ? formatDate(claim.created.slice(0, 10)) : ''} />
        {claim.notes && <DetailRow label={t('claimNotes')} value={claim.notes} />}
      </div>

      {canRelease && (
        <div className="mt-4 border-t border-gray-200 pt-4 dark:border-gray-700">
          {confirmRelease ? (
            <div className="space-y-2">
              <p className="text-sm text-gray-600 dark:text-gray-400">{t('claimReleaseConfirm')}</p>
              <div className="flex justify-end gap-2">
                <button
                  className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                  onClick={() => setConfirmRelease(false)}
                >
                  {t('common:cancel')}
                </button>
                <button
                  className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                  onClick={handleRelease}
                  disabled={releasing}
                >
                  {releasing ? '...' : t('claimRelease')}
                </button>
              </div>
            </div>
          ) : (
            <button
              className="w-full rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20"
              onClick={() => setConfirmRelease(true)}
            >
              {t('claimRelease')}
            </button>
          )}
        </div>
      )}
    </Modal>
  )
}
