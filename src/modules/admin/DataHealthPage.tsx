// src/modules/admin/DataHealthPage.tsx
//
// The club's one health destination. Until 2026-08-13 this page and
// /admin/clubdesk-sync were two halves of the same job: the ClubDesk findings were
// AGGREGATE alarm rows here ("24 missing a group") whose only affordance was
// "the detail lives on the other page", and the detail lived on a page that had no
// idea what else was wrong. Merging them deletes that split — the aggregates are
// gone and this page renders the real lists.
//
// LAYOUT
//   Header  — fix groups, and when the last push ran. The manual "Sync down"
//             and "Sync up" buttons were REMOVED on 08.09.2026: the sync path
//             below runs both in the only order that works, and having a second
//             door onto the same one-login-one-lock job produced nothing but
//             409s (four on 07.09.2026, both doors fired within 12 seconds).
//   Tabs    — All · Volleyball · Basketball · Unassigned · Club-wide.
//             The four member tabs bucket by SECTION; "Unassigned" is its own tab
//             because a member whose section cannot be derived would otherwise
//             hide inside 'both' (see utils/sportTabs.ts).
//             "Club-wide" holds the checks that have no section at all: games,
//             scorer licences, and the structural ClubDesk gaps.
//
// ⚠ One fetch owns the group findings (this page), passed down to both the table
// and the "Fix groups" button. Two fetches would let the button act on a list the
// operator is not looking at.

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { formatTimeZurich } from '../../utils/dateHelpers'
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight,
  Wrench, XCircle, RefreshCcw, ScrollText, Download, ArrowUpFromLine,
} from 'lucide-react'
import { toXlsx, downloadBlob } from './utils/exportResults'
import { Checkbox } from '../../components/ui/checkbox'
import { useConfirm } from '../../components/ConfirmProvider'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import ClubdeskSyncPath from './components/ClubdeskSyncPath'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

/** Top-level page section. Functional, unlike the sport axis it replaced. */
type Section = 'clubdesk' | 'club'
import ClubdeskGroupCheck from './components/ClubdeskGroupCheck'
import {
  EMPTY_GROUP_CHECK, type FixClass, type GroupCheckResp,
} from './utils/clubdeskFindings'
import ClubdeskNeedsSync, { type NeedsSyncRow } from './components/ClubdeskNeedsSync'
import {
  SPORT_TABS, inTab, EMPTY_FACETS, type MemberFacets, type SportTab,
} from './utils/sportTabs'
import { kscwApi } from '../../lib/api'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '../../components/ui/table'
import { useReportPageLoading } from '../../hooks/usePageReady'
import {
  runAllChecks, autoFix, autoFixAll, manualFix, linkClubdesk, deactivateMember, flagClubdeskDrift,
  flagClubdeskDriftBulk, resolveStaleLink, eraseRetentionData,
  type CollectionHealth, type DataIssue, type IssueKey,
} from './utils/dataHealthChecks'

// Stable issueKey → i18n label key. Labels are resolved here (not in the check
// logic) so every issue is localized in all 5 locales.
const ISSUE_LABEL_KEY: Record<IssueKey, string> = {
  missingDate: 'dhIssueMissingDate',
  missingAwayTeam: 'dhIssueMissingAwayTeam',
  missingTime: 'dhIssueMissingTime',
  nonPaddedTime: 'dhIssueNonPaddedTime',
  duplicateFixture: 'dhIssueDuplicateFixture',
  noTeamAssignment: 'dhIssueNoTeamAssignment',
  missingSex: 'dhIssueMissingSex',
  clubdeskNameMatch: 'dhIssueClubdeskNameMatch',
  clubdeskDeparted: 'dhIssueClubdeskDeparted',
  clubdeskStale: 'dhIssueClubdeskStale',
  clubdeskStaleSuppressed: 'dhIssueClubdeskStaleSuppressed',
  retentionDue: 'dhIssueRetentionDue',
  retentionUndated: 'dhIssueRetentionUndated',
  clubdeskDrift: 'dhIssueClubdeskDrift',
  clubdeskDriftBlocked: 'dhIssueClubdeskDriftBlocked',
  clubdeskFill: 'dhIssueClubdeskFill',
  clubdeskHonoraryDrift: 'dhIssueClubdeskHonoraryDrift',
  clubdeskNameDrift: 'dhIssueClubdeskNameDrift',
  feeShouldBeFree: 'dhIssueFeeShouldBeFree',
  feePassivCategory: 'dhIssueFeePassivCategory',
  feeAmountMismatch: 'dhIssueFeeAmountMismatch',
  feeNoRegisterAmount: 'dhIssueFeeNoRegisterAmount',
  feeNoCategory: 'dhIssueFeeNoCategory',
  feeUnmappedCategory: 'dhIssueFeeUnmappedCategory',
  scorerNotInVm: 'dhIssueScorerNotInVm',
  scorerVmWriterNotFlagged: 'dhIssueScorerVmWriterNotFlagged',
  scorerCdVbScNotFlagged: 'dhIssueScorerCdVbScNotFlagged',
  scorerCheckFailed: 'dhIssueScorerCheckFailed',
}

function severityIcon(severity: DataIssue['severity']) {
  return severity === 'error'
    ? <XCircle className="h-4 w-4 shrink-0 text-red-500" aria-hidden="true" />
    : <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
}

/** errors-before-warnings score; higher = more urgent. */
function urgency(h: CollectionHealth): number {
  const errors = h.issues.filter((i) => i.severity === 'error').length
  return errors * 1000 + h.issues.length
}

function CollectionCard({
  health,
  onFixed,
}: {
  health: CollectionHealth
  onFixed: () => void
}) {
  const { t } = useTranslation('admin')
  const confirm = useConfirm()
  const [expanded, setExpanded] = useState(health.issues.length > 0)
  const [fixingId, setFixingId] = useState<string | null>(null)
  const [fixingAll, setFixingAll] = useState(false)
  const [manualFixingId, setManualFixingId] = useState<string | null>(null)
  // Multi-select for "Mark for sync-up" — holds selected issue.ids (drift/fill
  // rows only). Cleared after a bulk mark; a rescan then drops the marked rows.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkMarking, setBulkMarking] = useState(false)

  const hasIssues = health.issues.length > 0
  const fixableCount = health.issues.filter((i) => i.autoFixable).length
  const errorCount = health.issues.filter((i) => i.severity === 'error').length
  const warningCount = health.issues.filter((i) => i.severity === 'warning').length
  const panelId = `dh-panel-${health.collection}`

  // Errors first, then alphabetical by stable issueKey so like issues cluster.
  const sortedIssues = [...health.issues].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1
    return a.issueKey.localeCompare(b.issueKey)
  })

  // Aggregate rows carry their full per-member list; the row shows only a count,
  // so this is the only way to see WHO. English headers — exports-always-English.
  async function handleExport(issue: DataIssue) {
    if (!issue.exportRows) return
    try {
      const { columns, rows, filename } = issue.exportRows
      const blob = await toXlsx(columns, rows)
      downloadBlob(blob, `${filename}_${new Date().toISOString().slice(0, 10)}.xlsx`)
    } catch {
      toast.error(t('dhExportFailed'))
    }
  }

  async function handleFixOne(issue: DataIssue) {
    setFixingId(issue.id)
    try {
      await autoFix(issue)
      toast.success(`${t('dhFixed')}: ${issue.detail}`)
      onFixed()
    } catch {
      toast.error(t('dhFixFailed'))
    } finally {
      setFixingId(null)
    }
  }

  async function handleManualFix(issue: DataIssue, value: string) {
    setManualFixingId(issue.id)
    try {
      await manualFix(issue, value)
      toast.success(`${t('dhFixed')}: ${issue.detail}`)
      onFixed()
    } catch {
      toast.error(t('dhFixFailed'))
    } finally {
      setManualFixingId(null)
    }
  }

  async function handleLinkClubdesk(issue: DataIssue) {
    setManualFixingId(issue.id)
    try {
      await linkClubdesk(issue)
      toast.success(`${t('dhFixed')}: ${issue.detail}`)
      onFixed()
    } catch {
      toast.error(t('dhFixFailed'))
    } finally {
      setManualFixingId(null)
    }
  }

  async function handleFlagDrift(issue: DataIssue) {
    setManualFixingId(issue.id)
    try {
      await flagClubdeskDrift(issue)
      toast.success(`${t('dhMarkedForSync')}: ${issue.detail}`)
      onFixed()
    } catch (err) {
      const code = (err as { code?: string; body?: { code?: string } })?.code
        ?? (err as { body?: { code?: string } })?.body?.code
      if (code === 'no_drift') {
        // Drift resolved since the scan (sync-down ran / another admin) —
        // informational, and rescan to drop the stale row.
        toast.info(t('dhDriftGone'))
        onFixed()
      } else if (code === 'blank_risk') {
        toast.warning(t('dhDriftBlankRisk'))
      } else {
        toast.error(t('dhFixFailed'))
      }
    } finally {
      setManualFixingId(null)
    }
  }

  // Rows that can be marked for sync-up (drift + fill). Name-drift rows are
  // excluded by construction — they carry no manualKind (the push can't send names).
  const markable = health.issues.filter((i) => i.manualKind === 'clubdeskDriftFlag')
  const selectedMarkable = markable.filter((i) => selected.has(i.id))

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  const toggleSelectAll = () => {
    setSelected((prev) =>
      prev.size === markable.length ? new Set() : new Set(markable.map((i) => i.id)))
  }

  async function handleBulkMark() {
    if (!selectedMarkable.length) return
    setBulkMarking(true)
    try {
      // One POST for the whole selection — /clubdesk-drift/flag takes an array and
      // filters blank-risk itself, so there's no per-row fan-out.
      const { flagged, skipped_blank_risk } = await flagClubdeskDriftBulk(selectedMarkable)
      if (flagged > 0) {
        toast.success(t('dhBulkMarked', { count: flagged }))
      } else {
        // Nothing survived (all resolved or all blank-risk) — informational.
        toast.info(t('dhDriftGone'))
      }
      if (skipped_blank_risk > 0) toast.warning(t('dhBulkBlankRisk', { count: skipped_blank_risk }))
      setSelected(new Set())
      onFixed()
    } catch {
      toast.error(t('dhFixFailed'))
    } finally {
      setBulkMarking(false)
    }
  }

  // ⚠ Confirm first: this is the one row action on this page that DELETES data —
  // it drops every active-team roster row for the member on top of flipping them
  // to not-a-member. The server re-verifies the departed condition, but it cannot
  // second-guess a mis-click on a 200-row list.
  async function handleDeactivate(issue: DataIssue) {
    const ok = await confirm({
      title: t('dhDeactivate'),
      message: t('dhConfirmDeactivate', { name: issue.detail }),
      confirmLabel: t('dhDeactivate'),
      danger: true,
    })
    if (!ok) return
    setManualFixingId(issue.id)
    try {
      await deactivateMember(issue)
      toast.success(`${t('dhFixed')}: ${issue.detail}`)
      onFixed()
    } catch {
      toast.error(t('dhFixFailed'))
    } finally {
      setManualFixingId(null)
    }
  }

  // Broken link (the ClubDesk contact was deleted): unlink keeps the member and
  // frees them to be re-created on the next sync-up; deactivate treats the
  // deletion as the departure. Both confirm — one changes the club register's
  // identity link, the other drops rosters.
  async function handleStale(issue: DataIssue, action: 'unlink' | 'deactivate') {
    const ok = await confirm({
      title: action === 'unlink' ? t('dhUnlink') : t('dhDeactivate'),
      message: t(action === 'unlink' ? 'dhConfirmUnlink' : 'dhConfirmDeactivate', { name: issue.detail }),
      confirmLabel: action === 'unlink' ? t('dhUnlink') : t('dhDeactivate'),
      danger: action === 'deactivate',
    })
    if (!ok) return
    setManualFixingId(issue.id)
    try {
      await resolveStaleLink(issue, action)
      toast.success(`${t('dhFixed')}: ${issue.detail}`)
      onFixed()
    } catch (err) {
      const code = (err as { code?: string; body?: { code?: string } })?.code
        ?? (err as { body?: { code?: string } })?.body?.code
      if (code === 'not_stale') {
        // A sync-down landed between the scan and the click — the link is live
        // again. Informational, and rescan so the row disappears.
        toast.info(t('dhStaleGone'))
        onFixed()
      } else if (code === 'down_in_progress' || code === 'export_empty' || code === 'export_incomplete') {
        toast.warning(t('dhStaleSnapshotUnusable'))
      } else {
        toast.error(t('dhFixFailed'))
      }
    } finally {
      setManualFixingId(null)
    }
  }

  // ⚠ The only irreversible action on this page: it destroys personal data
  // outright rather than flipping a flag. Confirms with the member's name and
  // the exact field list, and the server re-derives eligibility before writing.
  async function handleRetentionErase(issue: DataIssue) {
    const ok = await confirm({
      title: t('dhErase'),
      message: t('dhConfirmErase', { name: issue.detail }),
      confirmLabel: t('dhErase'),
      danger: true,
    })
    if (!ok) return
    setManualFixingId(issue.id)
    try {
      await eraseRetentionData(issue)
      toast.success(`${t('dhFixed')}: ${issue.detail}`)
      onFixed()
    } catch (err) {
      const code = (err as { code?: string; body?: { code?: string } })?.code
        ?? (err as { body?: { code?: string } })?.body?.code
      if (code === 'already_erased' || code === 'not_due' || code === 'still_active') {
        toast.info(t('dhEraseGone'))
        onFixed()
      } else if (code === 'has_login') {
        toast.warning(t('dhEraseHasLogin'))
      } else {
        toast.error(t('dhFixFailed'))
      }
    } finally {
      setManualFixingId(null)
    }
  }

  async function handleFixAll() {
    setFixingAll(true)
    try {
      const result = await autoFixAll(health.issues)
      if (result.failed > 0) {
        toast.warning(t('dhFixAllResult', { fixed: result.fixed, failed: result.failed }))
      } else {
        toast.success(t('dhFixAllResult', { fixed: result.fixed, failed: result.failed }))
      }
      onFixed()
    } catch {
      toast.error(t('dhFixFailed'))
    } finally {
      setFixingAll(false)
    }
  }

  const headerInner = (
    <>
      {hasIssues
        ? (expanded
          ? <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />
          : <ChevronRight className="h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />)
        : <span className="h-4 w-4 shrink-0" />
      }
      <span className="text-sm font-semibold text-gray-900 dark:text-white">
        {health.collection}
      </span>
      <span className="text-xs text-gray-400 dark:text-gray-500">
        ({health.total} {t('dhRecords')})
      </span>
      <div className="ml-auto flex items-center gap-2">
        {!hasIssues ? (
          <span className="flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
            <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
            {t('dhClean')}
          </span>
        ) : (
          <>
            {errorCount > 0 && (
              <span className="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400">
                {errorCount} {errorCount === 1 ? t('dhError') : t('dhErrors')}
              </span>
            )}
            {warningCount > 0 && (
              <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                {warningCount} {warningCount === 1 ? t('dhWarning') : t('dhWarnings')}
              </span>
            )}
          </>
        )}
      </div>
    </>
  )

  return (
    <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800/50">
      {/* Header — interactive disclosure only when there are issues to reveal */}
      {hasIssues ? (
        <button
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          aria-controls={panelId}
          className="flex min-h-[44px] w-full items-center gap-3 px-4 py-3 text-left"
        >
          {headerInner}
        </button>
      ) : (
        <div className="flex min-h-[44px] w-full items-center gap-3 px-4 py-3">
          {headerInner}
        </div>
      )}

      {/* Issues */}
      {expanded && hasIssues && (
        <div id={panelId} className="border-t border-gray-100 dark:border-gray-700">
          {/* Fix all (auto-fixable only) */}
          {fixableCount > 0 && (
            <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-4 py-2 dark:border-gray-700">
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {fixableCount} {t('dhAutoFixable')}
              </span>
              <button
                onClick={handleFixAll}
                disabled={fixingAll}
                aria-busy={fixingAll}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50 sm:min-h-0"
              >
                <Wrench className="h-3 w-3" aria-hidden="true" />
                {fixingAll ? t('dhFixing') : t('dhFixAll')}
              </button>
            </div>
          )}

          {/* Bulk "Mark for sync-up" — select-all + a single flag POST for the
              selection. Only shows when the collection has markable drift rows. */}
          {markable.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-4 py-2 dark:border-gray-700">
              <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 text-xs text-gray-500 sm:min-h-0 dark:text-gray-400">
                <Checkbox
                  checked={
                    selected.size === 0 ? false
                      : selectedMarkable.length === markable.length ? true
                        : 'indeterminate'
                  }
                  onCheckedChange={toggleSelectAll}
                  aria-label={t('dhBulkSelectAll')}
                />
                {selectedMarkable.length > 0
                  ? t('dhBulkSelected', { count: selectedMarkable.length })
                  : t('dhBulkSelectAll')}
              </label>
              {selectedMarkable.length > 0 && (
                <button
                  onClick={handleBulkMark}
                  disabled={bulkMarking}
                  aria-busy={bulkMarking}
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50 sm:min-h-0"
                >
                  <ArrowUpFromLine className="h-3 w-3" aria-hidden="true" />
                  {bulkMarking ? t('dhFixing') : t('dhBulkMark', { count: selectedMarkable.length })}
                </button>
              )}
            </div>
          )}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[42%]">{t('dhColIssue')}</TableHead>
                <TableHead>{t('dhColRecord')}</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">{t('dhColAction')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedIssues.map((issue) => (
                <TableRow key={`${issue.id}-${issue.field}-${issue.issueKey}`}>
                  <TableCell className="align-top">
                    <span className="flex items-center gap-2">
                      {issue.manualKind === 'clubdeskDriftFlag' && (
                        <Checkbox
                          checked={selected.has(issue.id)}
                          onCheckedChange={() => toggleSelect(issue.id)}
                          aria-label={t('dhBulkSelectRow')}
                        />
                      )}
                      {severityIcon(issue.severity)}
                      <span className="text-xs font-medium text-gray-700 dark:text-gray-300">
                        {t(ISSUE_LABEL_KEY[issue.issueKey])}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className="align-top whitespace-normal break-words">
                    <p className="text-xs text-gray-600 dark:text-gray-300">
                      {issue.detail}
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-gray-400 dark:text-gray-500">
                      <span>ID: {issue.id}</span>
                      <span aria-hidden="true">&middot;</span>
                      <span>{t('dhField')}: {issue.field}</span>
                      <Link
                        to={`/admin/audit-log?collection=${health.collection}&record_id=${issue.id}`}
                        className="inline-flex items-center gap-0.5 text-brand-600 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300"
                        aria-label={`${t('dhViewHistory')} — ${issue.detail}`}
                      >
                        <ScrollText className="h-3 w-3" aria-hidden="true" />
                        {t('dhViewHistory')}
                      </Link>
                    </p>
                  </TableCell>
                  <TableCell className="text-right align-top">
                    {issue.exportRows ? (
                      <button
                        onClick={() => { void handleExport(issue) }}
                        className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-md border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 sm:min-h-0 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                      >
                        <Download className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('dhExport')}
                      </button>
                    ) : issue.manualKind === 'clubdeskDeactivate' ? (
                      <button
                        onClick={() => handleDeactivate(issue)}
                        disabled={manualFixingId === issue.id}
                        aria-busy={manualFixingId === issue.id}
                        className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 sm:min-h-0 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/30"
                      >
                        {manualFixingId === issue.id ? t('dhFixing') : t('dhDeactivate')}
                      </button>
                    ) : issue.manualKind === 'retentionErase' ? (
                      <button
                        onClick={() => void handleRetentionErase(issue)}
                        disabled={manualFixingId === issue.id}
                        aria-busy={manualFixingId === issue.id}
                        className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 sm:min-h-0 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/30"
                      >
                        {manualFixingId === issue.id ? t('dhFixing') : t('dhErase')}
                      </button>
                    ) : issue.manualKind === 'clubdeskStale' ? (
                      // A deleted ClubDesk contact has two honest readings and
                      // the server cannot pick between them — so both are
                      // offered, side by side, rather than guessing.
                      <div className="inline-flex flex-col gap-1.5 sm:flex-row">
                        <button
                          onClick={() => void handleStale(issue, 'unlink')}
                          disabled={manualFixingId === issue.id}
                          aria-busy={manualFixingId === issue.id}
                          className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50 sm:min-h-0 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                        >
                          {manualFixingId === issue.id ? t('dhFixing') : t('dhUnlink')}
                        </button>
                        <button
                          onClick={() => void handleStale(issue, 'deactivate')}
                          disabled={manualFixingId === issue.id}
                          aria-busy={manualFixingId === issue.id}
                          className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 sm:min-h-0 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/30"
                        >
                          {manualFixingId === issue.id ? t('dhFixing') : t('dhDeactivate')}
                        </button>
                      </div>
                    ) : issue.manualKind === 'clubdeskDriftFlag' ? (
                      <button
                        onClick={() => handleFlagDrift(issue)}
                        disabled={manualFixingId === issue.id}
                        aria-busy={manualFixingId === issue.id}
                        className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50 sm:min-h-0 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                      >
                        {manualFixingId === issue.id ? t('dhFixing') : t('dhMarkSync')}
                      </button>
                    ) : issue.manualKind === 'clubdeskLink' ? (
                      <button
                        onClick={() => handleLinkClubdesk(issue)}
                        disabled={manualFixingId === issue.id}
                        aria-busy={manualFixingId === issue.id}
                        className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50 sm:min-h-0 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                      >
                        {manualFixingId === issue.id ? t('dhFixing') : t('dhLink')}
                      </button>
                    ) : issue.manualKind === 'sex' ? (
                      <div className="inline-flex flex-col gap-1.5 sm:flex-row">
                        {(['m', 'f'] as const).map((val) => (
                          <button
                            key={val}
                            onClick={() => handleManualFix(issue, val)}
                            disabled={manualFixingId === issue.id}
                            aria-busy={manualFixingId === issue.id}
                            className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50 sm:min-h-0 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                          >
                            {manualFixingId === issue.id
                              ? t('dhFixing')
                              : val === 'm' ? t('dhSetMale') : t('dhSetFemale')}
                          </button>
                        ))}
                      </div>
                    ) : issue.autoFixable ? (
                      <button
                        onClick={() => handleFixOne(issue)}
                        disabled={fixingId === issue.id}
                        aria-busy={fixingId === issue.id}
                        className={`inline-flex min-h-[44px] items-center justify-center rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-50 sm:min-h-0 ${
                          issue.fixAction === 'delete'
                            ? 'border-red-200 text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/30'
                            : 'border-gray-200 text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700'
                        }`}
                      >
                        {fixingId === issue.id
                          ? t('dhFixing')
                          : issue.fixAction === 'delete' ? t('dhDelete') : t('dhFix')}
                      </button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

export default function DataHealthPage() {
  const { t } = useTranslation('admin')
  const [results, setResults] = useState<CollectionHealth[]>([])
  // Start in the loading state so the auto-scan shows the branded spinner
  // immediately rather than flashing the empty state for a frame.
  const [loading, setLoading] = useState(true)
  const [lastCheck, setLastCheck] = useState('')
  const [tab, setTab] = useState<SportTab>('all')
  // Which half of the page: everything ClubDesk, or the club-wide generic checks.
  const [section, setSection] = useState<Section>('clubdesk')
  // Lifted so the sync path can gate its decision step on it — the count is
  // owned by the proposals table, which is the thing that changes it.
  const [pendingProposals, setPendingProposals] = useState(0)
  // Bumped after a job that can rewrite the proposal queue (a sync-down, or a
  // path step that runs one) so ClubdeskProposals re-reads instead of showing
  // its mount-time snapshot. `runChecks` alone does not reach it — that table
  // owns its own fetch.
  const [proposalsReload, setProposalsReload] = useState(0)

  // ── ClubDesk findings, owned here ──────────────────────────────────────────
  // One fetch feeds the group-check table AND the "Fix groups" button, so the
  // button can never act on a list the operator is not looking at.
  const [groupData, setGroupData] = useState<Required<GroupCheckResp>>(EMPTY_GROUP_CHECK)
  const [groupErr, setGroupErr] = useState<string | null>(null)
  const [needsSync, setNeedsSync] = useState<NeedsSyncRow[]>([])
  const [syncMeta, setSyncMeta] = useState<
    // pendingPush is null while the backend predates /clubdesk-needs-sync's
    // `pending_push` — see the fallback at the ClubdeskSyncPath call site.
    { inSync: number; pendingPush: number | null; lastDown: string | null; lastUp: string | null }
  >({ inSync: 0, pendingPush: null, lastDown: null, lastUp: null })
  const [facets, setFacets] = useState<MemberFacets>(EMPTY_FACETS)

  const runChecks = useCallback(async () => {
    setLoading(true)
    setGroupErr(null)
    // The generic scan and the three ClubDesk reads are independent, so they run
    // together — but NOT under a single Promise.all: one failing ClubDesk endpoint
    // must not blank the games/scorer findings (the Promise.all-fails-all pattern
    // in CLAUDE.md). Each settles on its own and reports its own failure.
    const [checks, group, needs, facetRes] = await Promise.allSettled([
      runAllChecks(),
      kscwApi<GroupCheckResp>('/clubdesk-group-sync'),
      kscwApi<{
        rows: NeedsSyncRow[]; in_sync: number; pending_push?: number
        last_down: string | null; last_up: string | null
      }>('/clubdesk-needs-sync'),
      kscwApi<MemberFacets>('/clubdesk-member-facets'),
    ])

    if (checks.status === 'fulfilled') setResults(checks.value)
    else toast.error(String(checks.reason))

    if (group.status === 'fulfilled') setGroupData({ ...EMPTY_GROUP_CHECK, ...group.value })
    else setGroupErr(group.reason instanceof Error ? group.reason.message : String(group.reason))

    if (needs.status === 'fulfilled') {
      setNeedsSync(needs.value.rows || [])
      setSyncMeta({
        inSync: needs.value.in_sync || 0,
        pendingPush: needs.value.pending_push == null ? null : Number(needs.value.pending_push) || 0,
        lastDown: needs.value.last_down,
        lastUp: needs.value.last_up,
      })
    }
    // Facets are join data, not a finding: if they fail the tables still render,
    // they just fall back to the row's own sport and show no bill.
    if (facetRes.status === 'fulfilled') setFacets({ ...EMPTY_FACETS, ...facetRes.value })

    setLastCheck(formatTimeZurich(new Date()))
    setLoading(false)
  }, [])

  // A sync-down (directly, or as a step the path runs) is the ONE job that
  // rewrites the proposal queue, so it must refresh the queue as well as the
  // page's own checks. Deciding a proposal deliberately does not come through
  // here: that table reloads itself, and bumping the key from its own callback
  // would make the two refetch each other.
  const afterSyncJob = useCallback(async () => {
    setProposalsReload((n) => n + 1)
    await runChecks()
  }, [runChecks])

  // Auto-run once on mount — checks are read-only, mirroring InfraHealthPage.
  // runChecks flips `loading` synchronously (intentional one-shot mount fetch),
  // so the set-state-in-effect warning is expected here.
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  useEffect(() => { runChecks() }, [])

  // What "Fix groups" could act on right now. Counts only — the server rebuilds
  // the actual worklist at queue time (see ClubdeskFixGroups).
  const fixAvailable = useMemo<Record<FixClass, number>>(() => ({
    missing: groupData.missing.length,
    coach_no_group: groupData.coach_no_group.length,
    // Only the halves the fix is allowed to touch, so the dialog's number matches
    // what a run would actually do rather than promising more than it delivers.
    stale_funktion: groupData.stale_funktion.filter((r) => r.has_correct).length,
    strays: groupData.strays.filter((r) => r.auto_removable).length,
  }), [groupData])

  // These rows already carry the server's verdict, so they bucket directly rather
  // than going through the facets fallback: `sport_source === 'unknown'` IS the
  // Unassigned tab, and collapsing it into `sport` would read as 'both'.
  const needsSyncForTab = useMemo(
    () => needsSync.filter((r) => inTab(r.sport_source === 'unknown' ? 'unassigned' : r.sport, tab)),
    [needsSync, tab])

  const totalIssues = results.reduce((sum, r) => sum + r.issues.length, 0)
  const totalErrors = results.reduce(
    (sum, r) => sum + r.issues.filter((i) => i.severity === 'error').length, 0)
  const totalWarnings = totalIssues - totalErrors

  // Collections with issues (most urgent first) above the clean ones.
  const sortedResults = [...results].sort((a, b) => urgency(b) - urgency(a))

  const initialScan = loading && results.length === 0

  // Report to app boot gate — see usePageReady.tsx
  useReportPageLoading(initialScan)

  // Sport is a FILTER on the ClubDesk findings, not a kind of health check — see
  // the note on the Tabs below. 'club' is excluded because it was never a sport.
  const memberTabs = SPORT_TABS.filter((s) => s !== 'club')

  return (
    <div className="mx-auto max-w-5xl px-4 py-4">
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            {t('dhTitle')}
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('dhDescription')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {lastCheck && (
            <span className="hidden text-xs text-gray-400 sm:inline dark:text-gray-500">
              {lastCheck}
            </span>
          )}
          <Button
            type="button" variant="outline" size="sm"
            onClick={runChecks} disabled={loading} aria-busy={loading}
            className="gap-1.5"
          >
            <RefreshCcw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
            {loading ? t('dhScanning') : results.length > 0 ? t('dhRescan') : t('dhScan')}
          </Button>
        </div>
      </div>

      {/* Initial scan — branded "load everything then render" spinner */}
      {initialScan ? null : (
        <>
          {/* Summary (live region announces scan result to screen readers) */}
          {results.length > 0 && (
            <div
              role="status"
              aria-live="polite"
              className="mb-4 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800/30"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {totalIssues === 0 ? (
                  <span className="flex items-center gap-3">
                    <CheckCircle2 className="h-5 w-5 text-green-500" aria-hidden="true" />
                    <span className="text-sm font-medium text-green-700 dark:text-green-400">
                      {t('dhAllClean')}
                    </span>
                  </span>
                ) : (
                  <>
                    <span className="flex items-center gap-3">
                      <AlertTriangle className="h-5 w-5 text-amber-500" aria-hidden="true" />
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                        {t('dhIssuesFound', { count: totalIssues })}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      {totalErrors > 0 && (
                        <span className="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400">
                          {totalErrors} {totalErrors === 1 ? t('dhError') : t('dhErrors')}
                        </span>
                      )}
                      {totalWarnings > 0 && (
                        <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                          {totalWarnings} {totalWarnings === 1 ? t('dhWarning') : t('dhWarnings')}
                        </span>
                      )}
                    </span>
                  </>
                )}
              </div>
            </div>
          )}

          {/* The top level is FUNCTIONAL, not sport-sectional (2026-08-14). It used
              to be five sport tabs whose four member tabs rendered nothing but the
              ClubDesk components — mounted four times over, each re-filtering the
              same shared state. Sport is a filter on ClubDesk findings, not a
              category of health check, so it is a filter now. */}
          <Tabs value={section} onValueChange={(v) => setSection(v as Section)}>
            <TabsList className="mb-4 flex-wrap">
              <TabsTrigger value="clubdesk" className="min-h-11 sm:min-h-0">
                {t('dhTab_clubdesk')}
              </TabsTrigger>
              <TabsTrigger value="club" className="min-h-11 sm:min-h-0">
                {t('dhTab_club')}
              </TabsTrigger>
            </TabsList>

            {/* Everything ClubDesk in one place: what wants to come DOWN (awaiting
                your decision), what is queued to go UP, and the group allocations.
                The registrations page no longer carries any of it. */}
            <TabsContent value="clubdesk" className="space-y-4">
              {/* ⚠ NO manual job buttons here, at all (08.09.2026). There was one
                  left — a "ClubDesk · Fix groups" bar above the path — and it was
                  the last second door onto a job the path already owns. The three
                  ClubDesk jobs share one login and one server-side lock, and step 5
                  is LAST for a reason (the scraper needs the wiedisync UUID to be
                  on the contact, which only a pushed-and-linked create carries), so
                  a button offering it out of order could only run it too early or
                  409 the step the runner was mid-way through. The "last sync up"
                  line went with it: the same timestamp heads the sync board below.
                  The order is forced by how the jobs read each other — the path
                  runs what can be run and stops where a person is required. */}
              <ClubdeskSyncPath
                pendingProposals={pendingProposals}
                fixAvailable={fixAvailable}
                proposalsReload={proposalsReload}
                onProposalCountChange={setPendingProposals}
                onRefresh={runChecks}
                // ⚠ From the server, computed with the up-preview's own
                // predicate — NOT re-derived from the worklist rows. Counting
                // `not_linked` here was the 25.08.2026 dead end: it also holds
                // the members already pushed and awaiting link-back, which the
                // CREATE set skips, so the path offered a step whose modal said
                // "Nothing to push" and never advanced. Club-wide on purpose —
                // the push ignores the sport tabs, so gating the path on the
                // current slice would stall it on an empty sport.
                //
                // ⚠ The old derivation is kept as the fallback for exactly one
                // window: this page (Cloudflare Pages, auto-deploys on push)
                // reaches users before the endpoint (ext:deploy, by hand), and
                // reading a field an older backend does not send would make the
                // count 0 and SKIP step 3 whenever there really was something to
                // push — a worse failure than the one being fixed, and a silent
                // one. `null` means "backend predates pending_push", never zero.
                pendingPush={syncMeta.pendingPush ?? needsSync.filter(
                  (r) => r.status === 'pending' || r.status === 'not_linked',
                ).length}
                onDone={afterSyncJob}
              />

              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 dark:text-gray-400">{t('dhSportFilter')}</span>
                <Select value={tab} onValueChange={(v) => setTab(v as SportTab)}>
                  <SelectTrigger className="h-9 w-48 min-h-11 sm:min-h-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {memberTabs.map((s) => (
                      <SelectItem key={s} value={s}>{t(`dhTab_${s}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className={`space-y-4 transition-opacity ${loading ? 'pointer-events-none opacity-60' : ''}`}>
                <ClubdeskNeedsSync
                  rows={needsSyncForTab}
                  inSync={syncMeta.inSync}
                  lastDown={syncMeta.lastDown}
                  lastUp={syncMeta.lastUp}
                  loading={loading}
                />
                <ClubdeskGroupCheck
                  data={groupData}
                  loading={loading}
                  error={groupErr}
                  onRefresh={runChecks}
                  tab={tab}
                  facets={facets}
                />
              </div>
            </TabsContent>

            {/* Club-wide: the checks with no section at all — games, scorer
                licences, and the member-level ClubDesk findings whose fix is an
                admin decision rather than a group write. */}
            <TabsContent value="club" className="space-y-4">
              <div className={`space-y-4 transition-opacity ${loading ? 'pointer-events-none opacity-60' : ''}`}>
                {!loading && results.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-20 text-center">
                    <div className="mb-4 rounded-full bg-gray-100 p-4 dark:bg-gray-800">
                      <AlertTriangle className="h-8 w-8 text-gray-400" aria-hidden="true" />
                    </div>
                    <p className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                      {t('dhEmptyTitle')}
                    </p>
                    <p className="mb-6 text-xs text-gray-500 dark:text-gray-400">
                      {t('dhEmptyDescription')}
                    </p>
                    <Button type="button" onClick={runChecks} disabled={loading}>
                      {t('dhScan')}
                    </Button>
                  </div>
                )}
                {sortedResults.map((health) => (
                  <CollectionCard key={health.collection} health={health} onFixed={runChecks} />
                ))}
              </div>
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  )
}
