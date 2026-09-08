/**
 * ClubdeskSyncPath — the ClubDesk sync order, as a thing you follow rather than
 * a thing you have to remember.
 *
 * The order is not a convention, it is forced by how the pieces read each other:
 *
 *   1. Sync down    refreshes `clubdesk_export` (TRUNCATE + reload) and stages
 *                   proposals — the SQL pass stages fill/overwrite/set_true/
 *                   create, and this runner then calls
 *                   /clubdesk-sync/proposals/detect to stage the `conflict`
 *                   rows, which are computed in JS off the same drift function
 *                   that renders them (migration 338). EVERYTHING downstream reads that table — the
 *                   sync-up preview computes drift against it and its stale-link
 *                   guard checks membership in it; the group checks read
 *                   `gruppen_bracketed` from it. Run anything on a stale export
 *                   and it acts on yesterday's register.
 *   2. Decide       accept/refuse. A refusal flags the member for push, so it has
 *                   to happen BEFORE the up or the refusal misses that push.
 *                   ⚠ The sync-down also SKIPS members with a pending push, so a
 *                   queued member raises no proposals until the push lands —
 *                   which is why decide-then-push is one unit, not two.
 *   3. Sync up      pushes wiedisync → ClubDesk and clears the pending flags.
 *   4. Sync down    REQUIRED again, and not just for freshness: a CREATE only
 *                   closes its loop here. The new contact gets a ClubDesk [Id],
 *                   and the linker reads the pushed Wiedisync ID back to set
 *                   members.clubdesk_id. Until then the member sits at
 *                   "pushed, awaiting link" and is deliberately excluded from the
 *                   create set so it cannot be duplicated.
 *   5. Fix groups   LAST. The scraper finds a contact by typing the wiedisync
 *                   UUID into ClubDesk's Filtern box, which needs the contact to
 *                   exist AND carry that ID — i.e. after the create was pushed
 *                   and linked. Earlier it fails with `uuid did not resolve`,
 *                   silently, every run.
 *
 * ⚠ Deliberately NOT a single automatic button. Step 2 is a human decision, and
 * step 5 writes group allocations into the club's legal register behind its own
 * preview→commit gate. This component runs what can be run and stops where a
 * person is actually required — it never advances past those two on its own.
 *
 * ⚠ The three jobs are mutually exclusive server-side (409 down_in_progress /
 * up_in_progress / grp_in_progress) — one ClubDesk login, one lock. The runner
 * therefore polls one step to completion before offering the next.
 *
 * ⚠ …and the lock is club-wide, not tab-wide: the nightly cron, a second admin,
 * or this admin's other tab can hold it. So the runner does not merely *react*
 * to a 409, it WATCHES the lock (GET /clubdesk-member-sync every 15s) and says
 * so before you click. When a 409 does land it is never re-thrown as
 * "API /clubdesk-member-sync: 409" — that string was the entire user-facing
 * explanation until 08.09.2026, on a page whose own second button was the thing
 * causing it (four such 409s on 07.09.2026, both doors fired within 12 seconds).
 * A down-busy 409 is now ADOPTED: the job the runner wanted is already running,
 * so it follows that run to completion instead of failing the step.
 *
 * ── One step, one shell (08.09.2026) ────────────────────────────────────────
 * Every step now opens the SAME dialog (ClubdeskStepDialog): the step's number,
 * a live progress bar and log fed by whichever job it runs, its own body, one
 * footer. It used to be three different experiences — the downs ran inline under
 * a bar filled by STEP INDEX, decide was a table elsewhere on the page, and the
 * up and the group fix each opened a dialog of their own — so "what is happening
 * right now" had a different answer, or no answer, depending on which step you
 * were on. This component owns all five and mounts the two that carry their own
 * review UI, rather than the page mounting them beside it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ArrowDownToLine, ArrowUpFromLine, Check, ListChecks, Loader2, RotateCcw, Wrench } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { kscwApi } from '../../../lib/api'
import { formatDateTimeCompact } from '../../../utils/dateHelpers'
import { detectClubdeskConflicts } from '../utils/clubdeskConflicts'
import { classifySyncFailure, SYNC_FAILURE_KEY } from '../utils/syncFailure'
import type { FixClass } from '../utils/clubdeskFindings'
import ClubdeskStepDialog from './ClubdeskStepDialog'
import SyncJobProgress, { type JobProgress } from './SyncJobProgress'
import ClubdeskProposals from './ClubdeskProposals'
import ClubdeskSyncUpModal from './ClubdeskSyncUpModal'
import ClubdeskFixGroups from './ClubdeskFixGroups'

export type PathStep = 'down1' | 'decide' | 'up' | 'down2' | 'groups' | 'done'

const STEPS: PathStep[] = ['down1', 'decide', 'up', 'down2', 'groups']

const ICON: Record<PathStep, typeof Check> = {
  down1: ArrowDownToLine,
  decide: ListChecks,
  up: ArrowUpFromLine,
  down2: ArrowDownToLine,
  groups: Wrench,
  done: Check,
}

interface SyncStatus {
  state: string
  message: string | null
  /** ⚠ Last SUCCESS, never merely the last finish — see migration 336. */
  last_success_at?: string | null
  up_state?: string
  /** Live progress of the sync-down itself (migration 355) — advisory, may be null. */
  phase?: string | null
  progress?: number | null
  log?: string | null
}

/** The two states that hold the ClubDesk lock. */
const BUSY = ['queued', 'running']
const isBusy = (state?: string | null) => BUSY.includes(state || '')

/** How long a sync-down is given before the runner calls it stalled. */
const DOWN_TIMEOUT_MS = 300_000

/**
 * A 409 the server raised because the ClubDesk lock is held, told apart by
 * WHICH direction holds it.
 *
 * ⚠ Two shapes, deliberately both handled. The sync-up block carries
 * `code: 'up_in_progress'`; the sync-down block predates the code field and
 * answers with `state` alone (`{ error, state: 'running' }`). Reading only the
 * code would silently mis-file the commonest case of all as "unknown error".
 */
function lockConflict(e: unknown): 'down' | 'up' | null {
  const err = e as { status?: number; body?: { code?: string; state?: string } }
  if (err?.status !== 409) return null
  // `code` first: the down-block response also carries a state, and a bare state
  // check would name the wrong direction.
  if (err.body?.code === 'up_in_progress') return 'up'
  if (err.body?.code === 'down_in_progress') return 'down'
  if (isBusy(err.body?.state)) return 'down'
  return null
}

/** Readable text for any other failure — never the bare `API <path>: <status>`. */
function apiMessage(e: unknown): string {
  const err = e as { body?: { error?: string } }
  return err?.body?.error || (e instanceof Error ? e.message : String(e))
}

export default function ClubdeskSyncPath({
  pendingProposals, fixAvailable, pendingPush, proposalsReload,
  onProposalCountChange, onDone, onRefresh,
}: {
  /** Open proposals — step 2 cannot pass while this is non-zero. */
  pendingProposals: number
  /** Group findings the fix can act on, per class — step 5 is skipped when all zero. */
  fixAvailable: Record<FixClass, number>
  /**
   * Members the sync-up would actually carry: flagged for push, plus unlinked
   * ones the CREATE set would build. Zero means step 3 has nothing to do.
   *
   * ⚠ Without this the path DEAD-ENDS. Steps 3 and 5 open a review body, and a
   * step that opens on "Nothing to push — everything is in sync" gives the runner
   * nothing to advance on: you close it and the marker is still on step 3,
   * forever. Knowing the step is a no-op BEFORE offering it is what keeps the
   * chain moving.
   *
   * ⚠⚠ It must therefore come from the SAME predicate the push previews
   * (`pending_push` off /clubdesk-needs-sync), never from the worklist statuses.
   * Counting `not_linked` rows looked equivalent and was not: a member already
   * created in ClubDesk and awaiting link-back still reads `not_linked` while
   * being deliberately excluded from the CREATE set, so the runner parked here
   * with an empty review body — and step 4, the sync down that clears exactly
   * that state, was the unreachable step behind it (25.08.2026, three members).
   */
  pendingPush: number
  /** Bumped by the page when a job may have rewritten the proposal queue. */
  proposalsReload: number
  /** The proposals table owns the count; the decision gate reads it. */
  onProposalCountChange: (n: number) => void
  /** Re-run the page's checks AND the proposal queue after a sync job settles. */
  onDone?: () => void | Promise<void>
  /**
   * Re-run the page's checks only. ⚠ Deciding a proposal must NOT go through
   * `onDone`: that bumps `proposalsReload`, and the table asking for a reload from
   * inside its own callback makes the two refetch each other.
   */
  onRefresh?: () => void | Promise<void>
}) {
  const { t } = useTranslation('admin')
  const [step, setStep] = useState<PathStep>('down1')
  /** Which step's dialog is open — null when the card alone is showing. */
  const [openStep, setOpenStep] = useState<PathStep | null>(null)
  const [running, setRunning] = useState(false)
  const [active, setActive] = useState(false)
  /** The last sync-down this runner drove finished cleanly — drives the footer. */
  const [downDone, setDownDone] = useState(false)
  /**
   * A group-fix COMMIT has landed in this session.
   *
   * ⚠⚠ Step 5 cannot be gated on its findings going away, because they cannot: the
   * group checks read `clubdesk_export.gruppen_bracketed`, which is written by the
   * sync DOWN, and the commit writes to ClubDesk. Our copy of the register is one
   * sync behind until the next down — so a run that did exactly what was asked
   * (08.09.2026: 7 assigned, 2 removed, no skips) left the path reading
   * "5. Fix groups (9)" with no way to finish. The commit itself is the signal.
   */
  const [groupsCommitted, setGroupsCommitted] = useState(false)
  /** Wall-clock start of the step this runner is polling — drives the elapsed read-out. */
  const [startedAt, setStartedAt] = useState<number | null>(null)
  /** Ticks only while a step is in flight — `elapsed` is derived from it below. */
  const [now, setNow] = useState(() => Date.now())
  /**
   * The server-side lock, as last seen. Held by the nightly cron, another admin,
   * or this admin's other tab just as easily as by this runner — which is why it
   * is watched rather than merely reacted to. Carries the sync-down's live phase,
   * percentage and log tail (migration 355) so the bar shows the JOB's progress.
   */
  const [lock, setLock] = useState<{
    down: string; up: string; message: string | null; lastSuccess: string | null
    phase: string | null; progress: number | null; log: string | null
  }>({ down: 'idle', up: 'idle', message: null, lastSuccess: null, phase: null, progress: null, log: null })
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const readStatus = useCallback((s: SyncStatus) => {
    setLock((l) => ({
      ...l,
      down: s.state || 'idle',
      up: s.up_state || 'idle',
      // Carried, not toasted: the failure an operator most needs to read is
      // the one they navigated away from and came back to.
      message: s.state === 'failed' ? (s.message || null) : null,
      lastSuccess: s.last_success_at ?? l.lastSuccess,
      phase: s.phase ?? null,
      progress: s.progress ?? null,
      log: s.log ?? null,
    }))
  }, [])

  // ⚠ Best-effort and silent on failure: a non-superadmin, or a backend that
  // predates the fields, must not paint an error onto a page that is fine. The
  // 15s cadence matches how long a queued run takes to be claimed by the host
  // dispatcher cron, so "someone else is syncing" appears within one tick — but
  // it drops to 4s while anything is actually moving, because that is when the
  // phase and the log are worth reading.
  const watching = running || isBusy(lock.down) || isBusy(lock.up) || openStep !== null
  useEffect(() => {
    let on = true
    const poll = () => {
      kscwApi<SyncStatus>('/clubdesk-member-sync')
        .then((s) => { if (on) readStatus(s) })
        .catch(() => { /* not a superadmin, or transient — leave the panel blank */ })
    }
    poll()
    const id = setInterval(poll, watching ? 4000 : 15_000)
    return () => { on = false; clearInterval(id) }
  }, [readStatus, watching])

  // Elapsed seconds while a step is in flight. Ticks only then, so an idle page
  // holds no timer. ⚠ The clock is a ticking `now` and the elapsed value is
  // DERIVED, never written back from the effect — a setElapsed(0) in the effect
  // body is the cascading-render write react-hooks/set-state-in-effect rejects.
  useEffect(() => {
    if (startedAt === null) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [startedAt])
  // Clamped: `now` is one tick stale at the instant a run starts.
  const elapsed = startedAt === null ? 0 : Math.max(0, Math.round((now - startedAt) / 1000))

  /** A ClubDesk job is running that this runner did not start. */
  const foreignDown = !running && isBusy(lock.down)
  const upHolding = isBusy(lock.up)

  // Poll a job to completion. The server refuses concurrent jobs, so the runner
  // must not offer the next step until this settles.
  const runSyncDown = useCallback(async (): Promise<boolean> => {
    setRunning(true)
    setDownDone(false)
    setStartedAt(Date.now())
    try {
      try {
        await kscwApi('/clubdesk-member-sync', { method: 'POST' })
      } catch (e) {
        const held = lockConflict(e)
        // The sync-up holds the lock, and a down run landing between the push's
        // dry-run preview and its commit would swap the ClubDesk snapshot out
        // from under a set that already passed review. Nothing to adopt — the
        // wrong job is running. Say which one, and stop.
        if (held === 'up') { toast.info(t('clubdeskSyncBlockedByUp')); return false }
        // ADOPTED, not failed. A sync-down is already queued or running — the
        // nightly cron, another admin, or this admin's other tab — and it is the
        // very job this step wanted. Refusing here would leave the runner parked
        // on step 1 while the thing it asked for completes in the background.
        // Fall through to the same poll loop and follow that run home.
        if (held === 'down') toast.info(t('dhPathAdoptedRun'))
        // ⚠ Anything else is a real failure and must carry the server's own
        // sentence, never `API /clubdesk-member-sync: 409`.
        else { toast.error(apiMessage(e)); return false }
      }
      const deadline = Date.now() + DOWN_TIMEOUT_MS
      for (;;) {
        // 3s: the dialog is showing this job's own phase and log now, and a
        // five-second gap between lines reads as a stall in a live log.
        await new Promise((r) => setTimeout(r, 3000))
        if (!alive.current) return false
        const s = await kscwApi<SyncStatus>('/clubdesk-member-sync')
        // Keep the panel, the bar and the log live off the same poll — no second timer.
        readStatus(s)
        if (s.state === 'done') return true
        // ⚠ The raw line, classified — 'Sync failed' alone cannot tell "ClubDesk
        // is down, try later" from "our scraper is broken", which is the whole
        // difference between waiting and calling for help.
        if (s.state === 'failed') {
          toast.error(t(SYNC_FAILURE_KEY[classifySyncFailure(s.message)]))
          return false
        }
        if (Date.now() > deadline) { toast.error(t('dhPathTimeout')); return false }
      }
    } catch (e) {
      toast.error(apiMessage(e))
      return false
    } finally {
      if (alive.current) { setRunning(false); setStartedAt(null) }
    }
  }, [t, readStatus])

  // ⚠ DERIVED, not corrected in an effect. The decision gate opens the moment
  // nothing is pending, and writing that back through setState inside an effect
  // is the cascading-render bug react-hooks/set-state-in-effect exists to catch
  // (the same trap ClubdeskProposals hit). `step` stores how far the user has
  // got; `resolve` says what that means given live counts.
  // Chained so a run with nothing to do in the middle still reaches the end:
  // decide with no proposals falls through to the push, a push with nothing
  // queued falls through to the second down, and no group findings means done.
  const fixableCount = useMemo(
    () => Object.values(fixAvailable).reduce((a, b) => a + b, 0), [fixAvailable])
  const resolve = useCallback((s: PathStep): PathStep => {
    let c = s
    if (c === 'decide' && pendingProposals === 0) c = 'up'
    if (c === 'up' && pendingPush === 0) c = 'down2'
    if (c === 'groups' && (fixableCount === 0 || groupsCommitted)) c = 'done'
    return c
  }, [pendingProposals, pendingPush, fixableCount, groupsCommitted])
  const current = resolve(step)

  /**
   * Run the sync-down for a step and, if it worked, move the marker on.
   *
   * ⚠ Conflicts are staged HERE rather than by the sync-down's SQL pass: the
   * comparison is JS (accents, phone shapes, country aliases, AHV digits-only,
   * either-address email), and a second implementation in SQL would disagree
   * with the one that draws the finding. ⚠ Never fatal — a failed staging must
   * not undo a sync-down that already succeeded, so it reports and the path
   * carries on; the next down re-detects.
   */
  const runDownStep = useCallback(async (which: 'down1' | 'down2') => {
    const ok = await runSyncDown()
    if (!ok) return
    try {
      const r = await detectClubdeskConflicts()
      // ⚠ `capped` first: it also reports staged 0, and reporting that as
      // "nothing to decide" turns the loudest data fault into silence.
      if (r?.capped) toast.warning(t('dhPathConflictsCapped', { count: r.considered, cap: r.cap }))
      else if (r && r.staged > 0) toast.info(t('dhPathConflictsStaged', { count: r.staged }))
    } catch (e) {
      toast.warning(e instanceof Error ? e.message : String(e))
    }
    setDownDone(true)
    await onDone?.()
    // After the FIRST down the decision gate is next; after the second, groups.
    // The gate then opens by itself through `resolve` once nothing is pending.
    setStep(which === 'down1' ? 'decide' : 'groups')
  }, [runSyncDown, onDone, t])

  /** Open a step, starting its job when the step IS a job. */
  const openAt = useCallback((s: PathStep) => {
    setActive(true)
    setOpenStep(s)
    // ⚠ Started from the click, never from an effect on `openStep`. A run kicked
    // off by an effect is a synchronous setState during render-commit — the
    // cascading-render write react-hooks/set-state-in-effect rejects — and it also
    // re-fires on every re-open. The user asked for this step; this is the ask.
    if (s === 'down1' || s === 'down2') void runDownStep(s)
  }, [runDownStep])

  /** Footer "next step": advance the marker and open whatever comes next. */
  const goNext = useCallback(() => {
    const i = STEPS.indexOf(current)
    const nextRaw = i < 0 || i + 1 >= STEPS.length ? 'done' : STEPS[i + 1]
    const nx = resolve(nextRaw)
    setStep(nx)
    if (nx === 'done') { setOpenStep(null); return }
    openAt(nx)
  }, [current, resolve, openAt])

  const label = useMemo(() => ({
    down1: t('dhPathStep1'),
    decide: t('dhPathStep2', { count: pendingProposals }),
    up: pendingPush === 0 ? t('dhPathStep3Empty') : t('dhPathStep3'),
    down2: t('dhPathStep4'),
    groups: fixableCount === 0 ? t('dhPathStep5Empty') : t('dhPathStep5', { count: fixableCount }),
    done: t('dhPathDone'),
  }), [t, pendingProposals, fixableCount, pendingPush])

  /** The step's one-line "what this does", shown under its title in the dialog. */
  const stepHint: Record<PathStep, string> = useMemo(() => ({
    down1: t('dhStepHintDown1'),
    decide: t('dhStepHintDecide'),
    up: t('dhStepHintUp'),
    down2: t('dhStepHintDown2'),
    groups: t('dhStepHintGroups'),
    done: '',
  }), [t])

  // ⚠ 'done' is deliberately not in STEPS, so indexOf would give -1 and render
  // every step as still-pending at the exact moment they are all complete.
  const stepIndex = current === 'done' ? STEPS.length : STEPS.indexOf(current)
  const blocked = current === 'decide' && pendingProposals > 0

  // Path progress — where you are in the FIVE STEPS. Deliberately not the same
  // number as the running job's own percentage: when a job is running the card
  // shows that instead (below), because "the sync is 40% through" and "you are on
  // step 1 of 5" are different questions and only one of them was ever answered.
  const slice = 100 / STEPS.length
  const pathPct = Math.min(100, Math.round(stepIndex * slice + (running ? slice / 2 : 0)))

  // ⚠ "Step 5 of 5" is wrong at the end — the fifth step is finished, not open.
  const progressText = current === 'done'
    ? t('dhPathDone')
    : t('dhPathProgress', { step: stepIndex + 1, total: STEPS.length })

  // The "Do the next step" button must not fire into a held lock — that is the
  // 409 this whole panel exists to stop producing. Only the two sync-down steps
  // touch it directly; step 3 and step 5 open a review body that carries its own
  // block, so they stay clickable.
  const stepUsesLock = current === 'down1' || current === 'down2'
  const lockHeld = stepUsesLock && (foreignDown || upHolding)

  /** The sync-down job, in the shape every step dialog and the card render. */
  const downJob: JobProgress = {
    running: running || foreignDown,
    progress: lock.progress,
    // ⚠ A queued job has not STARTED — the host dispatcher is a once-a-minute cron,
    // so for up to 60 seconds there is nothing to report and the bar showed a
    // wordless "Starting…" that looked like a hang (asked as "so where do i see the
    // progress?", 08.09.2026). Waiting for a cron tick is a fact worth saying.
    phase: lock.phase || (lock.down === 'queued' ? t('dhJobQueued') : null),
    log: lock.log,
    error: lock.message
      ? `${t(SYNC_FAILURE_KEY[classifySyncFailure(lock.message)])} — ${lock.message}`
      : null,
    done: downDone && !running,
    elapsed: running ? elapsed : undefined,
  }
  /** Live in the card while THIS runner drives a down, or while any run holds the lock. */
  const cardJob = running || foreignDown ? downJob : null

  const isDownStep = openStep === 'down1' || openStep === 'down2'

  return (
    <div className="rounded-lg border border-gray-200 px-4 py-3 dark:border-gray-700">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-gray-900 dark:text-white">{t('dhPathTitle')}</h3>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{t('dhPathHint')}</p>
        </div>
        {current === 'done' ? (
          <Button
            type="button" size="sm" variant="outline"
            onClick={() => { setStep('down1'); setActive(false); setDownDone(false); setGroupsCommitted(false) }}
            className="gap-1.5"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            {t('dhPathRestart')}
          </Button>
        ) : (
          <Button
            type="button" size="sm"
            variant={active ? 'default' : 'outline'}
            disabled={running || blocked || lockHeld}
            aria-busy={running}
            onClick={() => openAt(current)}
            className="gap-1.5"
          >
            {running || lockHeld
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              : <Check className="h-3.5 w-3.5" aria-hidden="true" />}
            {running
              ? t('dhPathRunning')
              : lockHeld
                ? t('dhPathLocked')
                : blocked ? t('dhPathWaiting') : t('dhPathNext')}
          </Button>
        )}
      </div>

      <ol className="mt-3 flex flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
        {STEPS.map((s, i) => {
          const Icon = ICON[s]
          const done = i < stepIndex
          const isCurrent = i === stepIndex
          return (
            <li
              key={s}
              aria-current={isCurrent ? 'step' : undefined}
              className={`flex min-h-11 items-center gap-1.5 text-xs sm:min-h-0 ${
                isCurrent
                  ? 'font-medium text-gray-900 dark:text-white'
                  : done
                    ? 'text-green-600 dark:text-green-400'
                    : 'text-gray-400 dark:text-gray-500'
              }`}
            >
              {done
                ? <Check className="h-3.5 w-3.5" aria-hidden="true" />
                : <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
              <span>{label[s]}</span>
              {isCurrent && blocked && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                  {t('dhPathYourTurn')}
                </span>
              )}
            </li>
          )
        })}
      </ol>

      {/* One bar, two jobs to answer for: while a ClubDesk run holds the lock the
          card shows THAT run's own progress and log (the same component the step
          dialog uses); otherwise it shows where you are in the path. */}
      <div className="mt-3">
        {cardJob ? (
          <SyncJobProgress {...cardJob} />
        ) : (
          <>
            <div
              className="h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={STEPS.length}
              aria-valuenow={stepIndex}
              aria-valuetext={progressText}
            >
              <div
                className={`h-full rounded-full transition-[width] duration-500 ${
                  current === 'done' ? 'bg-green-500' : 'bg-gray-400 dark:bg-gray-500'
                }`}
                style={{ width: `${pathPct}%` }}
              />
            </div>
            <p className="mt-1.5 text-xs" aria-live="polite">
              {/* ⚠ First, because it is the one state that looks like a failure and
                  is not: ClubDesk has been written, and the group findings keep
                  showing the old allocations until a sync down re-reads them. */}
              {groupsCommitted && fixableCount > 0 ? (
                <span className="text-gray-500 dark:text-gray-400">{t('dhPathGroupsWritten')}</span>
              ) : upHolding ? (
                <span className="text-amber-700 dark:text-amber-300">{t('clubdeskSyncBlockedByUp')}</span>
              ) : lock.message ? (
                // Explanation AND the raw line: a classifier that swallowed the
                // original would be a prettier version of the problem it exists to fix.
                <span className="text-red-600 dark:text-red-400">
                  {t(SYNC_FAILURE_KEY[classifySyncFailure(lock.message)])}
                  <span className="ml-1 break-words text-[11px] text-gray-500 dark:text-gray-400" title={lock.message}>
                    {lock.message}
                  </span>
                </span>
              ) : (
                <span className="text-gray-500 dark:text-gray-400">
                  {progressText}
                  {lock.lastSuccess ? ` · ${t('clubdeskLastSync', { time: formatDateTimeCompact(lock.lastSuccess) })}` : ''}
                </span>
              )}
            </p>
          </>
        )}
      </div>

      {/* ── Step 1 / 4: the sync down, watched live ─────────────────────────── */}
      <ClubdeskStepDialog
        open={isDownStep}
        onOpenChange={(v) => { if (!v) setOpenStep(null) }}
        step={openStep === 'down2' ? 4 : 1}
        total={STEPS.length}
        title={openStep === 'down2' ? label.down2 : label.down1}
        description={openStep === 'down2' ? stepHint.down2 : stepHint.down1}
        icon={ArrowDownToLine}
        job={downJob}
      >
        <p className="text-xs text-gray-500 dark:text-gray-400">{t('dhStepCloseHint')}</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={() => setOpenStep(null)}>
            {t('dhStepClose')}
          </Button>
          {!running && !downDone && (
            <Button
              type="button" variant="outline"
              onClick={() => { if (openStep === 'down1' || openStep === 'down2') void runDownStep(openStep) }}
              disabled={foreignDown || upHolding}
            >
              {t('dhPathRestart')}
            </Button>
          )}
          <Button type="button" onClick={goNext} disabled={running || !downDone} className="gap-1.5">
            <Check className="h-4 w-4" aria-hidden="true" />
            {t('dhStepNext')}
          </Button>
        </div>
      </ClubdeskStepDialog>

      {/* ── Step 2: the decision, which is a person reading a table ─────────── */}
      <ClubdeskStepDialog
        open={openStep === 'decide'}
        onOpenChange={(v) => { if (!v) setOpenStep(null) }}
        step={2}
        total={STEPS.length}
        title={label.decide}
        description={stepHint.decide}
        icon={ListChecks}
      >
        <ClubdeskProposals
          embedded
          onDone={onRefresh}
          onCountChange={onProposalCountChange}
          reloadKey={proposalsReload}
        />
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={() => setOpenStep(null)}>
            {t('dhStepClose')}
          </Button>
          <Button
            type="button" onClick={goNext} disabled={pendingProposals > 0}
            title={pendingProposals > 0 ? t('dhStepDecideFirst') : undefined}
            className="gap-1.5"
          >
            <Check className="h-4 w-4" aria-hidden="true" />
            {t('dhStepNext')}
          </Button>
        </div>
      </ClubdeskStepDialog>

      {/* ── Steps 3 and 5: their own review bodies, this shell ──────────────── */}
      <ClubdeskSyncUpModal
        open={openStep === 'up'}
        onOpenChange={(v) => { if (!v) setOpenStep(null) }}
        step={3}
        total={STEPS.length}
        title={label.up}
        description={stepHint.up}
        onNext={goNext}
        onDone={onDone}
      />
      <ClubdeskFixGroups
        open={openStep === 'groups'}
        onOpenChange={(v) => { if (!v) setOpenStep(null) }}
        step={5}
        total={STEPS.length}
        title={label.groups}
        description={stepHint.groups}
        available={fixAvailable}
        onCommitted={() => setGroupsCommitted(true)}
        onDone={onDone}
      />
    </div>
  )
}
