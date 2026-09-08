/**
 * SyncJobProgress — the bar and the log for a ClubDesk job, in one shape.
 *
 * All three ClubDesk jobs (sync down, sync up, fix groups) take minutes, run on
 * the host, and used to report exactly two things to the person who started them:
 * a spinner and, at the very end, a sentence. The bar that existed filled by PATH
 * STEP — 20% for step 1, plus half a slice while running — which describes where
 * the runner is and says nothing about where the job is. A ClubDesk login that had
 * hung and a scrape that was nearly finished drew the same picture.
 *
 * The dispatchers now write their own phase, percentage and last output lines to
 * clubdesk_member_sync (migration 355) and every status route returns them, so this
 * renders the job's OWN progress. One component for all three, because "why does
 * the sync up look different from the sync down" is the question that started this.
 *
 * ⚠ Every field is advisory and may be null: a dispatcher that predates the helper,
 * or one that could not reach the DB for a progress write, still runs and still
 * reports its state correctly. Null progress renders as an indeterminate bar, never
 * as 0% — "we do not know" and "nothing has happened" are different claims.
 */
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'

export interface JobProgress {
  /** The job is queued or running right now. */
  running: boolean
  /** 0-100 from the dispatcher, or null when it does not report. */
  progress: number | null
  /** What it is doing, in the dispatcher's own words. */
  phase: string | null
  /** The run's output, whole — see clubdesk-progress.sh. */
  log: string | null
  /** Terminal failure — rendered instead of the phase. */
  error?: string | null
  /** The job finished successfully. */
  done?: boolean
  /** Seconds since this browser started watching, for the mm:ss read-out. */
  elapsed?: number
}

export default function SyncJobProgress({
  running, progress, phase, log, error, done, elapsed, idleText,
}: JobProgress & { idleText?: string }) {
  const { t } = useTranslation('admin')
  const logRef = useRef<HTMLPreElement>(null)

  // Follow the tail — but only while the reader is AT the tail. The box carries the
  // whole run now, so scrolling up to read an earlier line is a thing people do, and
  // yanking them back to the bottom every three seconds would make that impossible.
  // 40px of slack, because "at the bottom" after a render is rarely exact.
  useEffect(() => {
    const el = logRef.current
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) {
      el.scrollTop = el.scrollHeight
    }
  }, [log])

  const pct = progress == null ? null : Math.max(0, Math.min(100, progress))
  const clock = elapsed == null
    ? null
    : `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="flex min-w-0 items-center gap-1.5">
          {error ? (
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-500" aria-hidden="true" />
          ) : done ? (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-500" aria-hidden="true" />
          ) : running ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-500" aria-hidden="true" />
          ) : null}
          <span className={`truncate ${
            error
              ? 'text-red-600 dark:text-red-400'
              : running
                ? 'text-blue-700 dark:text-blue-300'
                : 'text-gray-600 dark:text-gray-300'
          }`}>
            {error || phase || (running ? t('dhJobStarting') : idleText || t('dhJobIdle'))}
          </span>
        </span>
        <span className="shrink-0 tabular-nums text-gray-500 dark:text-gray-400">
          {pct != null && `${pct}%`}
          {pct != null && clock && ' · '}
          {clock}
        </span>
      </div>

      <div
        className="h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        // ⚠ Omitted, not zeroed, when the job does not report a number — that is
        // what tells a screen reader the bar is indeterminate.
        aria-valuenow={pct ?? undefined}
        aria-valuetext={error || phase || undefined}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-700 ${
            error
              ? 'bg-red-500'
              : done || pct === 100
                ? 'bg-green-500'
                : running
                  ? 'animate-pulse bg-blue-500'
                  : 'bg-gray-400 dark:bg-gray-500'
          }`}
          // An unreported percentage while running shows a third of the track
          // pulsing: honest about "something is happening, we cannot say how far".
          style={{ width: `${pct ?? (running ? 33 : 0)}%` }}
        />
      </div>

      {log && (
        <pre
          ref={logRef}
          aria-live="polite"
          aria-label={t('dhJobLogLabel')}
          className="max-h-72 overflow-auto rounded-md bg-gray-900 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-gray-100 dark:bg-gray-950"
        >
          {log}
        </pre>
      )}
    </div>
  )
}
