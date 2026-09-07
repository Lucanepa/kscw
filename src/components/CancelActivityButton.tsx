import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Ban, RotateCcw } from 'lucide-react'
import Modal from '@/components/Modal'
import { useAuth } from '../hooks/useAuth'
import { useTeamPermissions } from '../hooks/useTeamPermissions'
import { useAdminMode } from '../hooks/useAdminMode'
import { useMutation } from '../hooks/useMutation'

type ActivityKind = 'training' | 'event' | 'game'

interface CancelActivityButtonProps {
  kind: ActivityKind
  activityId: string
  isCancelled: boolean
  /** Teams the activity belongs to. Empty array = club-wide (admin only). */
  teamIds: string[]
  /** 'icon' = card action bar; 'inline' = labelled button for modal headers. */
  variant?: 'icon' | 'inline'
  /** Called after a successful patch so the parent can refetch or close. */
  onDone?: () => void
}

const COLLECTION: Record<ActivityKind, string> = {
  training: 'trainings',
  event: 'events',
  game: 'games',
}

// Per-kind i18n keys — keeps the label/confirm wiring flat instead of nesting
// ternaries over (isCancelled × kind). The reinstate *action* label is shared
// across kinds, so only reinstate confirmations vary here.
const CANCEL_KEYS: Record<ActivityKind, { action: string; confirm: string; reinstateConfirm: string }> = {
  training: { action: 'cancelTrainingAction', confirm: 'cancelTrainingConfirm', reinstateConfirm: 'reinstateTrainingConfirm' },
  event: { action: 'cancelEventAction', confirm: 'cancelEventConfirm', reinstateConfirm: 'reinstateEventConfirm' },
  game: { action: 'cancelGameAction', confirm: 'cancelGameConfirm', reinstateConfirm: 'reinstateGameConfirm' },
}

export default function CancelActivityButton({
  kind,
  activityId,
  isCancelled,
  teamIds,
  variant = 'icon',
  onDone,
}: CancelActivityButtonProps) {
  const { t } = useTranslation('common')
  const { teamResponsibleIds } = useAuth()
  const { canManageTeam } = useTeamPermissions()
  const { effectiveIsAdmin } = useAdminMode()
  const { update, isLoading } = useMutation(COLLECTION[kind])
  const [dialogOpen, setDialogOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')

  const canManage =
    effectiveIsAdmin ||
    teamIds.some((id) => canManageTeam(id) || teamResponsibleIds.includes(id))
  if (!canManage) return null

  const keys = CANCEL_KEYS[kind]
  const actionLabel = isCancelled ? t('reinstateAction') : t(keys.action)
  const confirmText = isCancelled ? t(keys.reinstateConfirm) : t(keys.confirm)

  async function handleConfirm() {
    setError('')
    try {
      if (isCancelled) {
        await update(
          activityId,
          kind === 'game'
            ? { status: 'scheduled' }
            : { cancelled: false, cancel_reason: '' },
        )
      } else {
        await update(
          activityId,
          kind === 'game'
            ? { status: 'cancelled' }
            : { cancelled: true, cancel_reason: reason.trim() },
        )
      }
      setDialogOpen(false)
      setReason('')
      onDone?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <>
      {variant === 'icon' ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setDialogOpen(true)
          }}
          title={actionLabel}
          aria-label={actionLabel}
          className={
            isCancelled
              ? 'rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200'
              : 'rounded-lg p-2 text-gray-500 hover:bg-red-50 hover:text-red-600 dark:text-gray-400 dark:hover:bg-red-900/20 dark:hover:text-red-400'
          }
        >
          {isCancelled ? <RotateCcw className="h-4 w-4" /> : <Ban className="h-4 w-4" />}
        </button>
      ) : (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setDialogOpen(true)
          }}
          className={
            isCancelled
              ? 'flex min-h-[36px] items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700'
              : 'flex min-h-[36px] items-center gap-1.5 rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20'
          }
        >
          {isCancelled ? <RotateCcw className="h-4 w-4" /> : <Ban className="h-4 w-4" />}
          {actionLabel}
        </button>
      )}

      <Modal open={dialogOpen} onClose={() => setDialogOpen(false)} title={actionLabel} size="sm">
        <div className="space-y-4" onClick={(e) => e.stopPropagation()}>
          <p className="text-sm text-gray-700 dark:text-gray-300">{confirmText}</p>

          {!isCancelled && kind !== 'game' && (
            <div className="space-y-1">
              <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('cancelReasonLabel')}
              </label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t('cancelReasonPlaceholder')}
                rows={2}
                className="w-full rounded-md border border-gray-300 bg-transparent px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-400 focus:outline-none dark:border-gray-600 dark:text-gray-100 dark:placeholder:text-gray-500"
              />
            </div>
          )}

          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setDialogOpen(false)}
              disabled={isLoading}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              {t('keepBtn')}
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={isLoading}
              className={
                isCancelled
                  ? 'rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50'
                  : 'rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50'
              }
            >
              {isCancelled ? t('reinstateConfirmBtn') : t('cancelConfirmBtn')}
            </button>
          </div>
        </div>
      </Modal>
    </>
  )
}
