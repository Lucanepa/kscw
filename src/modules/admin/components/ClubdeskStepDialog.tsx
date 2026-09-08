/**
 * ClubdeskStepDialog — one shell for all five steps of the ClubDesk sync path.
 *
 * Before this, a step meant one of three different things depending on which step
 * it was: sync down ran inline in the path card with a fake bar, decide happened in
 * a table further down the page, and sync up and fix groups each opened a dialog of
 * their own design. Same runner, same lock, same five-step sequence — three
 * interfaces. So the answer to "what is happening right now" depended on which step
 * you were on, and two of the five could only tell you "running…".
 *
 * Every step now opens THIS: the same header (which step, of how many), the same
 * live progress bar and log (SyncJobProgress, fed by whichever job that step runs),
 * the same place for errors, and a footer that says what to do next. What differs
 * between steps is the body — the proposals to decide, the push to review, the group
 * changes to preview — which is the only thing that SHOULD differ.
 *
 * ⚠ Closing never cancels. The jobs run on the host; the dialog is a window onto
 * one, not the thing driving it. The footer says so, because a dialog that looks
 * like it owns a run invites people to keep it open "so it does not stop".
 */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { LucideIcon } from 'lucide-react'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import SyncJobProgress, { type JobProgress } from './SyncJobProgress'

export default function ClubdeskStepDialog({
  open, onOpenChange, step, total, title, description, icon: Icon,
  job, children, footer, dismissible = true,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** 1-based position in the path — the eyebrow reads "Step 3 of 5". */
  step: number
  total: number
  title: string
  description?: string
  icon?: LucideIcon
  /**
   * The job this step runs, if any. Omitted for a step that runs nothing (the
   * decision step is a person reading a table, and a progress bar over it would be
   * a lie about what is happening).
   */
  job?: JobProgress
  children?: ReactNode
  footer?: ReactNode
  /** False while a write is in flight — closing mid-push must not be offered. */
  dismissible?: boolean
}) {
  const { t } = useTranslation('admin')
  return (
    <Dialog open={open} onOpenChange={(v) => { if (dismissible || v) onOpenChange(v) }}>
      <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {t('dhPathProgress', { step, total })}
          </p>
          <DialogTitle className="flex items-center gap-2">
            {Icon && <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />}
            {title}
          </DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        {job && <SyncJobProgress {...job} />}

        {children}

        {footer && (
          <DialogFooter className="flex-col gap-2 sm:flex-row">{footer}</DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
