/**
 * ClubdeskProposals — the sync-down review queue.
 *
 * Since migration 321 the ClubDesk sync-down does not write to `members` at all.
 * It stages every change it wants to make as a row in `clubdesk_sync_proposals`,
 * and this table is where a superadmin resolves them:
 *
 *   Accept — ClubDesk's value is written into wiedisync.
 *   Refuse — ours stands. The proposal becomes a tombstone so detection never
 *            asks again, and (when we actually hold a value to assert) the member
 *            is flagged so the next sync-up corrects ClubDesk instead of leaving
 *            the two systems knowingly divergent.
 *
 * ⚠ The two actions are NOT symmetric and the UI should not pretend otherwise:
 * accepting changes our database, refusing changes ClubDesk's — eventually, and
 * only via a push somebody still has to approve.
 *
 * ⚠ The BUTTONS are therefore labelled with the system that WINS, not with the
 * verb: "Wiedisync" is refuse (ours stands), "ClubDesk" is accept (theirs is
 * written in). "Accept"/"Refuse" said nothing about which of two visible values
 * the click was approving; the source name says it in the same word as the
 * column it comes from. Order matches the columns — Wiedisync, then ClubDesk —
 * so the leftmost, easiest-to-hit button is the one that does NOT touch our
 * data. `create` rows get their own tooltip: there is nothing to overwrite, the
 * choice is whether the member is created at all.
 *
 * `rule` is shown as a "why" column because it is the only thing that makes the
 * decision informed: a `fill` is the register offering something we lack, an
 * `overwrite` is a genuine disagreement on a register column, a `set_true` is a
 * qualification the register asserts, and a `conflict` (migration 338) is a
 * disagreement on a contact column that used to have nowhere to be decided —
 * it appeared in Data Health's "Needs syncing" board, which could only ever
 * answer "keep ours" and could not remember that it had.
 *
 * ⚠⚠ One field is not like the others: `email` is the member's LOGIN identity.
 * Accepting ClubDesk's address changes where that person signs in, so the row
 * says so and the bulk confirm counts them separately — a select-all must not be
 * able to move somebody's login silently.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { kscwApi } from '../../../lib/api'
import { formatDateZurich } from '../../../utils/dateHelpers'
import { useConfirm } from '@/components/ConfirmProvider'
import { cdFieldLabel } from '../utils/clubdeskFieldLabels'

export interface Proposal {
  id: number
  member_id: number | null
  member_name: string
  clubdesk_id: string
  field: string | null
  current_value: string | null
  proposed_value: string | null
  rule: 'fill' | 'overwrite' | 'set_true' | 'create' | 'conflict'
  email: string | null
  detected_at: string
}

interface ProposalsResp {
  proposals: Proposal[]
  counts: Record<string, number>
  total: number
}

// Dates arrive ISO (the detection pass stores them that way so the accept path
// never has to guess a locale) but must READ Swiss — CLAUDE.md date rule.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
/**
 * ⚠ `t` is threaded through for the booleans. A `set_true` proposal stores the
 * literal strings 'false' and 'true', and the table printed them raw — a
 * lowercase machine value in a column of sentence-case text, and unreadable as
 * "does this member hold the licence" besides.
 */
function display(v: string | null, t: (k: string) => string): string {
  const s = String(v ?? '').trim()
  if (!s) return '—'
  if (s === 'true') return t('common:yes')
  if (s === 'false') return t('common:no')
  return ISO_DATE.test(s) ? formatDateZurich(s) : s
}

export default function ClubdeskProposals({ onDone, onCountChange, reloadKey = 0, embedded = false }: {
  onDone?: () => void | Promise<void>
  /**
   * Rendered inside the sync path's step 2 dialog, which already carries the
   * step's own title and description — so the card border and the heading are
   * dropped and the table alone is shown. It is the same component either way:
   * a second "compact proposals" table is how two lists start disagreeing.
   */
  embedded?: boolean
  /** Reported upward so the sync path can gate its decision step on the count. */
  onCountChange?: (n: number) => void
  /**
   * Bumped by the page whenever a sync-down finishes. Without it this table
   * keeps its MOUNT-TIME snapshot: the one operation that rewrites the proposal
   * queue is the very one that left the rows on screen stale, and the sync
   * banner above refreshes while the table below does not — so the path reads
   * "1. Sync down ✓ → 2. Decide (2)" against two rows the sync already closed,
   * and clicking one 409s (already_decided). Deciding a row reloads through
   * `load()` and must NOT bump this, or the two would drive each other.
   */
  reloadKey?: number
}) {
  const { t } = useTranslation('admin')
  const [data, setData] = useState<ProposalsResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState<number | 'bulk' | null>(null)
  const confirm = useConfirm()

  // ⚠ The state updates live in an async IIFE inside the effect rather than in a
  // function the effect calls. A synchronous setState from an effect body is the
  // cascading-render bug react-hooks/set-state-in-effect exists to catch, and the
  // rule reads the call site, not what the callee does first. `alive` is the
  // usual unmount guard.
  const apply = useCallback((r: ProposalsResp) => {
    setData(r)
    setError(null)
    onCountChange?.(r.total)
    // Drop selections for rows that no longer exist, or a bulk action would send
    // ids the server has already decided.
    setSelected((prev) => {
      const live = new Set(r.proposals.map((p) => p.id))
      return new Set([...prev].filter((id) => live.has(id)))
    })
  }, [onCountChange])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const r = await kscwApi<ProposalsResp>('/clubdesk-sync/proposals')
        if (alive) apply(r)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [apply, reloadKey])

  // Manual refetch after a decision — never called from an effect, so it may set
  // state directly. It deliberately leaves `loading` alone: the table stays on
  // screen and swaps its rows.
  const load = useCallback(async () => {
    try {
      apply(await kscwApi<ProposalsResp>('/clubdesk-sync/proposals'))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [apply])

  const rows = data?.proposals ?? []
  const allSelected = rows.length > 0 && selected.size === rows.length

  const decide = useCallback(async (ids: number[], decision: 'accept' | 'refuse') => {
    if (!ids.length) return
    // ⚠⚠ Accepting an email moves the member's LOGIN address. Refusing is safe
    // (ours stands), and so is accepting anything else, so this asks only where
    // it matters — and it counts the emails inside a mixed bulk selection, which
    // is the case a select-all creates and the row-level warning cannot cover.
    if (decision === 'accept') {
      const emails = (data?.proposals ?? []).filter((p) => ids.includes(p.id) && p.field === 'email')
      if (emails.length && !(await confirm({
        title: t('dhProposalEmailConfirmTitle'),
        message: t('dhProposalEmailConfirm', {
          count: emails.length,
          names: emails.map((p) => p.member_name).join(', '),
        }),
        confirmLabel: t('dhProposalEmailConfirmLabel'),
        danger: true,
      }))) return
    }
    setBusy(ids.length === 1 ? ids[0] : 'bulk')
    try {
      const r = await kscwApi<{ decided: number; skipped: number; flagged_for_push: number }>(
        '/clubdesk-sync/proposals/decide',
        { method: 'POST', body: { ids, decision } },
      )
      toast.success(decision === 'accept'
        ? t('dhProposalAccepted', { count: r.decided })
        : t('dhProposalRefused', { count: r.decided }))
      // Refusing only queues a push when we hold a value worth asserting, so this
      // count is genuinely different from `decided` and worth surfacing.
      if (r.flagged_for_push > 0) toast.info(t('dhProposalFlagged', { count: r.flagged_for_push }))
      if (r.skipped > 0) toast.warning(t('dhProposalSkipped', { count: r.skipped }))
      setSelected(new Set())
      await load()
      await onDone?.()
    } catch (e) {
      // ⚠ `already_decided` is staleness, not failure: every id in the click had
      // already been decided (a second admin, or this tab left open across a
      // sync-down, which re-detects and can close a row on its own). The rows on
      // screen are the thing that is wrong, so re-read them and say so plainly —
      // a red toast reading "API …/decide: 409" tells the operator nothing about
      // what to do, and the answer is always "here is the current list".
      if ((e as { code?: string })?.code === 'already_decided') {
        toast.info(t('dhProposalAlreadyDecided'))
        setSelected(new Set())
        await load()
        await onDone?.()
      } else {
        toast.error(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setBusy(null)
    }
  }, [load, onDone, t, confirm, data])

  const ruleLabel = useMemo(() => ({
    fill: t('dhProposalRuleFill'),
    overwrite: t('dhProposalRuleOverwrite'),
    set_true: t('dhProposalRuleSetTrue'),
    create: t('dhProposalRuleCreate'),
    conflict: t('dhProposalRuleConflict'),
  }), [t])

  if (loading && !data) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-6 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        {t('dhProposalLoading')}
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-900/20 dark:text-red-400">
        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        {error}
      </div>
    )
  }

  if (!rows.length) {
    return (
      <div className="rounded-lg border border-gray-200 px-4 py-6 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
        {t('dhProposalNone')}
      </div>
    )
  }

  return (
    <div className={embedded ? '' : 'rounded-lg border border-gray-200 dark:border-gray-700'}>
      <div className={`flex flex-wrap items-center justify-between gap-2 ${
        embedded ? 'pb-2' : 'border-b border-gray-200 px-4 py-3 dark:border-gray-700'
      }`}>
        {embedded ? <span /> : (
          <div>
            <h3 className="text-sm font-medium text-gray-900 dark:text-white">
              {t('dhProposalTitle', { count: rows.length })}
            </h3>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              {t('dhProposalHint')}
            </p>
          </div>
        )}
        {selected.size > 0 && (
          <div className="flex items-center gap-2">
            <Button
              type="button" size="sm" variant="outline"
              disabled={busy !== null} aria-busy={busy === 'bulk'}
              title={t('dhProposalRefuseTitle')}
              onClick={() => void decide([...selected], 'refuse')}
            >
              {t('dhProposalRefuseN', { count: selected.size })}
            </Button>
            <Button
              type="button" size="sm" variant="outline"
              disabled={busy !== null} aria-busy={busy === 'bulk'}
              title={t('dhProposalAcceptTitle')}
              onClick={() => void decide([...selected], 'accept')}
            >
              {t('dhProposalAcceptN', { count: selected.size })}
            </Button>
          </div>
        )}
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  checked={allSelected}
                  aria-label={t('dhProposalSelectAll')}
                  onCheckedChange={(v) =>
                    setSelected(v ? new Set(rows.map((r) => r.id)) : new Set())}
                />
              </TableHead>
              <TableHead>{t('dhProposalColMember')}</TableHead>
              <TableHead>{t('dhProposalColField')}</TableHead>
              <TableHead className="hidden sm:table-cell">{t('dhProposalColOurs')}</TableHead>
              <TableHead>{t('dhProposalColClubdesk')}</TableHead>
              <TableHead className="hidden md:table-cell">{t('dhProposalColWhy')}</TableHead>
              <TableHead className="w-32 text-right">{t('dhProposalColAction')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((p) => (
              <TableRow key={p.id} className="min-h-11">
                <TableCell>
                  <Checkbox
                    checked={selected.has(p.id)}
                    aria-label={t('dhProposalSelectOne', { name: p.member_name })}
                    onCheckedChange={(v) => setSelected((prev) => {
                      const next = new Set(prev)
                      if (v) next.add(p.id); else next.delete(p.id)
                      return next
                    })}
                  />
                </TableCell>
                <TableCell className="whitespace-normal break-words font-medium">
                  {p.member_name || '—'}
                  {p.rule === 'create' && p.email && (
                    <span className="block text-xs font-normal text-gray-500 dark:text-gray-400">{p.email}</span>
                  )}
                </TableCell>
                <TableCell className="whitespace-normal break-words">
                  {p.rule === 'create' ? t('dhProposalNewMember') : cdFieldLabel(t, p.field)}
                  {p.field === 'email' && (
                    <span className="mt-0.5 block text-xs font-normal text-amber-700 dark:text-amber-400">
                      {t('dhProposalEmailWarning')}
                    </span>
                  )}
                </TableCell>
                <TableCell className="hidden whitespace-normal break-words text-gray-500 sm:table-cell dark:text-gray-400">
                  {display(p.current_value, t)}
                </TableCell>
                <TableCell className="whitespace-normal break-words">{display(p.proposed_value, t)}</TableCell>
                <TableCell className="hidden text-xs text-gray-500 md:table-cell dark:text-gray-400">
                  {ruleLabel[p.rule]}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex flex-col justify-end gap-1 sm:flex-row">
                    <Button
                      type="button" size="sm" variant="outline"
                      disabled={busy !== null} aria-busy={busy === p.id}
                      title={t(p.rule === 'create' ? 'dhProposalRefuseCreateTitle' : 'dhProposalRefuseTitle')}
                      onClick={() => void decide([p.id], 'refuse')}
                    >
                      {t('dhProposalRefuse')}
                    </Button>
                    <Button
                      type="button" size="sm" variant="outline"
                      disabled={busy !== null} aria-busy={busy === p.id}
                      title={t(p.rule === 'create' ? 'dhProposalAcceptCreateTitle' : 'dhProposalAcceptTitle')}
                      onClick={() => void decide([p.id], 'accept')}
                    >
                      {t('dhProposalAccept')}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
