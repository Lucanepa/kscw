// src/modules/admin/components/ClubdeskNeedsSync.tsx
//
// "Who is out of step with ClubDesk since the last sync." The per-member verdict
// already existed (/clubdesk-sync-status) but only ever answered "what is member
// X's state" for the Data Explorer grid, which means nobody could see the LIST.
//
// `in_sync` and `excluded` are deliberately absent — this is a worklist. Their
// counts are shown anyway, so an empty table reads as "everyone is in step"
// rather than "the check stopped looking" (the false all-clear that let a 401
// print "✓ 0/80 mismatches" during the 2026-07-16 hall audit).

import { Fragment, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Download, Loader2, RefreshCw, UserMinus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatDateZurich } from '../../../utils/dateHelpers'
import { toXlsx, downloadBlob } from '../utils/exportResults'
import LastBillCell from './LastBillCell'
import { lastBillExport, type LastBill } from '../utils/clubdeskFindings'
import { cdFieldLabel } from '../utils/clubdeskFieldLabels'

// ⚠ No `drift` (migration 338). A value disagreement is a DECISION and lives in
// the proposals queue as a `conflict` row, where refusing is durable. This board
// is now only what no decision can resolve — states you wait out or repair, not
// questions you answer. `name_drift` stays for exactly that reason: no sync in
// either direction can reconcile a name.
export type SyncStatus = 'not_linked' | 'awaiting_link' | 'stale' | 'departed' | 'pending' | 'name_drift'

export interface NeedsSyncRow {
  member_id: number
  member_name: string
  clubdesk_id: string
  status: SyncStatus
  sport: 'volleyball' | 'basketball' | 'both'
  sport_source: 'teams' | 'sektion' | 'fee' | 'unknown'
  last_bill: LastBill | null
  /**
   * The field-level diff behind a `name_drift` row. Empty for the statuses that
   * are not a disagreement about a value — which, since migration 338 moved
   * value conflicts into the proposals queue, is every other status here.
   *
   * ⚠ Named per field on purpose: "a field differs from ClubDesk" is true of
   * every row and tells the reader nothing — they had to open the Club-wide tab
   * to find out which. Showing both values is also what makes a MIS-LINK
   * self-evident ("Aurora Cardinale Bosio" against "Alberto Cascino") rather
   * than looking like a spelling wobble.
   */
  conflicts?: { field: string; wiedisync: string; clubdesk: string }[]
  /**
   * Fields the push would BLANK — wiedisync's side is empty while ClubDesk still
   * holds a value. Still sent by the server (the sync-up's own guard reads it)
   * and still typed here so the shape stays honest, but no longer rendered: a
   * blank-risk field is by definition one where ClubDesk has a value and we do
   * not, which is a `fill` PROPOSAL. The board used to print "sync down first"
   * about a decision already waiting in the other table.
   */
  blank_risk?: string[]
}


/** Tab order: most actionable first, unfixable-by-sync last. */
const STATUS_ORDER: SyncStatus[] = ['pending', 'not_linked', 'awaiting_link', 'stale', 'departed', 'name_drift']

/**
 * Red = the link itself is broken or the person has left; amber = a push is owed;
 * blue = already in flight, waiting on the next sync down; grey = nothing a sync
 * can do.
 *
 * ⚠ `awaiting_link` is NOT `not_linked` wearing a different colour. The contact
 * exists in ClubDesk already — it was created by the last push and is waiting
 * for a sync down to read its [Id] back. Pushing it again duplicates it in the
 * legal register, which is why the CREATE set skips it. Sharing the red "create
 * them with a sync up" badge is what parked the sync path on step 3 while its
 * modal reported nothing to push.
 *
 * ⚠ `name_drift` is grey on purpose. Names are the one divergence NO sync can
 * reconcile — the push CSV is deliberately name-less so it can never overwrite
 * the register's legal name, and the sync-down does not propose names either. It
 * stays listed rather than hidden because a mis-linked contact surfaces here and
 * nowhere else.
 */
// Any status this build does not know — which, during a deploy window, means a
// `drift` row from an endpoint that has not shipped yet (Cloudflare Pages
// deploys this page on push; ext:deploy is run by hand). Neutral rather than
// absent: an unstyled chip with a readable label degrades quietly, where
// `TONE[unknown]` renders `className={undefined}` and the row loses its badge.
const TONE_UNKNOWN = 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'

const TONE: Record<SyncStatus, string> = {
  not_linked: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  awaiting_link: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  stale: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  departed: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  pending: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  name_drift: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
}

// Presentational — the page owns the fetch and the single Rescan button in the
// header, so this card deliberately has no refresh of its own.
export default function ClubdeskNeedsSync({
  rows, inSync, lastDown, lastUp, loading, onDeactivateDeparted, deactivating,
}: {
  rows: NeedsSyncRow[]
  inSync: number
  lastDown: string | null
  lastUp: string | null
  loading: boolean
  /**
   * Deactivate every departed row in view, in one go.
   *
   * ⚠ `departed` is the one status on this board that has a single correct answer:
   * ClubDesk records an Austritt, so the member is not a member any more and the
   * only question is when somebody gets round to saying so in wiedisync. It was a
   * per-row button on the club-wide list, which for twelve departures means twelve
   * trips through a table — hence one button, one confirm, one call (the server
   * still re-checks every member individually before writing).
   */
  onDeactivateDeparted?: (rows: NeedsSyncRow[]) => void | Promise<void>
  deactivating?: boolean
  // ⓘ No onFlag. "Keep ours" moved to the proposals queue as Refuse, which does
  // the same thing (flags the member for the next push) AND leaves a tombstone,
  // so the question is never asked again. A board row is no longer something you
  // answer.
}) {
  const { t, i18n } = useTranslation('admin')
  const [statusTab, setStatusTab] = useState<string>('all')
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  // Tabs are built from what is actually PRESENT, not from the full status
  // union — an empty "Departed (0)" tab is a dead end the reader has to click to
  // discover. Order follows STATUS_ORDER so the list does not reshuffle between
  // scans as counts change.
  const byStatus = useMemo(() => {
    const m: Record<string, NeedsSyncRow[]> = {}
    for (const r of rows) (m[r.status] ||= []).push(r)
    return m
  }, [rows])
  const presentStatuses = useMemo(
    () => STATUS_ORDER.filter((st) => (byStatus[st]?.length ?? 0) > 0),
    [byStatus],
  )
  // Every departed row in view — the sport filter has already been applied by the
  // page, so the button acts on exactly what the reader can see.
  const departedRows = byStatus.departed ?? []
  // A tab can disappear between scans (the last push landed), so fall
  // back rather than render an empty table under a tab that no longer exists.
  const activeTab: string = statusTab !== 'all' && !presentStatuses.includes(statusTab as SyncStatus)
    ? 'all'
    : statusTab
  const shown = activeTab === 'all' ? rows : (byStatus[activeTab] ?? [])

  // Exports are always English regardless of UI locale.
  const handleExport = async () => {
    try {
      const tEn = i18n.getFixedT('en', 'admin')
      const columns = ['Member ID', 'Name', 'Sport', 'Status', 'ClubDesk ID', 'Last bill', 'Bill status', 'Open amount']
      const body = rows.map((r) => [
        String(r.member_id), r.member_name,
        r.sport_source === 'unknown' ? 'Unassigned' : r.sport,
        tEn(`cdSyncStatus_${r.status}`),
        r.clubdesk_id,
        ...lastBillExport(r.last_bill),
      ])
      const blob = await toXlsx(columns, body)
      downloadBlob(blob, `clubdesk_needs_sync_${new Date().toISOString().slice(0, 10)}.xlsx`)
    } catch {
      toast.error(t('dhExportFailed'))
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <RefreshCw className="h-4 w-4" />{t('cdNeedsSyncTitle')}
            </CardTitle>
            <CardDescription>
              {t('cdNeedsSyncDescription')}
              {' '}
              <span className="whitespace-nowrap">
                {t('cdNeedsSyncLastDown', { time: lastDown ? formatDateZurich(lastDown) : '—' })}
                {' · '}
                {t('cdNeedsSyncLastUp', { time: lastUp ? formatDateZurich(lastUp) : '—' })}
              </span>
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* Only when there is something to do: a permanently-present button for
                an empty class is a button people learn to ignore. */}
            {onDeactivateDeparted && departedRows.length > 0 && (
              <Button
                type="button" variant="outline" size="sm"
                onClick={() => { void onDeactivateDeparted(departedRows) }}
                disabled={loading || !!deactivating}
                aria-busy={deactivating}
                className="gap-1.5"
              >
                {deactivating
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  : <UserMinus className="h-3.5 w-3.5" aria-hidden="true" />}
                {t('cdNeedsSyncDeactivateBtn', { count: departedRows.length })}
              </Button>
            )}
            <Button
              type="button" variant="outline" size="sm"
              onClick={() => { void handleExport() }}
              disabled={loading || rows.length === 0}
              className="gap-1.5"
            >
              <Download className="h-3.5 w-3.5" />{t('explorerGridExport')}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          // The in-sync tally is the point: "0 rows" alone is indistinguishable
          // from a check that never ran.
          <p className="py-2 text-sm text-emerald-600 dark:text-emerald-400">
            {t('cdNeedsSyncAllGood', { count: inSync })}
          </p>
        ) : (
          <>
            {/* ⚠ Status became a FILTER, not a column (2026-08-16). As a column it
                carried a sentence of explanation on every row, which squeezed the
                three value columns and pushed the action button off-screen — the
                one thing the row exists to offer. As tabs it groups like with
                like, states the explanation once, and gives the table its width
                back. */}
            <Tabs value={activeTab} onValueChange={setStatusTab}>
              <TabsList className="mb-2 flex-wrap">
                <TabsTrigger value="all" className="min-h-11 sm:min-h-0">
                  {t('cdSyncTabAll', { count: rows.length })}
                </TabsTrigger>
                {presentStatuses.map((st) => (
                  <TabsTrigger key={st} value={st} className="min-h-11 sm:min-h-0">
                    {t(`cdSyncStatus_${st}`)} ({byStatus[st].length})
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            {activeTab !== 'all' && (
              <p className="mb-2 text-xs text-muted-foreground">
                {t(`cdSyncHint_${activeTab}`)}
              </p>
            )}

            <div className="max-h-96 overflow-x-auto overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-8" />
                    <TableHead>{t('clubdeskGroupColName')}</TableHead>
                    {activeTab === 'all' && <TableHead>{t('cdSyncColStatus')}</TableHead>}
                    <TableHead>{t('cdSyncColField')}</TableHead>
                    <TableHead>{t('cdSyncColWiedisync')}</TableHead>
                    <TableHead>{t('cdSyncColClubdesk')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((r) => {
                    const open = expanded.has(r.member_id)
                    // +2 for the chevron and action columns, +1 more when the
                    // status column is showing.
                    const span = activeTab === 'all' ? 6 : 5
                    return (
                      <Fragment key={r.member_id}>
                        <TableRow className="min-h-11">
                          <TableCell className="align-top">
                            {/* ClubDesk id and the last bill are context, not the
                                decision — they live behind this so the row stays
                                narrow enough to show the button. */}
                            <button
                              type="button"
                              onClick={() => setExpanded((prev) => {
                                const next = new Set(prev)
                                if (next.has(r.member_id)) next.delete(r.member_id)
                                else next.add(r.member_id)
                                return next
                              })}
                              aria-expanded={open}
                              aria-label={t('cdSyncToggleDetails', { name: r.member_name })}
                              className="flex h-11 w-8 items-center justify-center text-muted-foreground sm:h-6"
                            >
                              {open
                                ? <ChevronDown className="h-4 w-4" aria-hidden="true" />
                                : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
                            </button>
                          </TableCell>
                          <TableCell className="whitespace-normal break-words align-top font-medium">
                            {r.member_name}
                          </TableCell>
                          {activeTab === 'all' && (
                            <TableCell className="align-top">
                              <span className={`whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium ${TONE[r.status] ?? TONE_UNKNOWN}`}>
                                {/* defaultValue keeps a status this build has
                                    never heard of readable as itself rather
                                    than printing the raw i18n key. */}
                                {t(`cdSyncStatus_${r.status}`, { defaultValue: r.status })}
                              </span>
                            </TableCell>
                          )}
                          {/* ⚠ Three cells rather than one "ours → theirs" string:
                              an arrow does not say which end is which, and knowing
                              which side to trust is the whole point of the row. */}
                          <TableCell className="whitespace-normal break-words align-top text-xs font-medium text-gray-700 dark:text-gray-300">
                            {(r.conflicts ?? []).map((d) => (
                              <div key={d.field} className="py-0.5">
                                {cdFieldLabel(t, d.field)}
                              </div>
                            ))}
                          </TableCell>
                          <TableCell className="whitespace-normal break-words align-top text-xs">
                            {(r.conflicts ?? []).map((d) => (
                              <div key={d.field} className="py-0.5">{d.wiedisync || '—'}</div>
                            ))}
                          </TableCell>
                          <TableCell className="whitespace-normal break-words align-top text-xs">
                            {(r.conflicts ?? []).map((d) => (
                              <div key={d.field} className="py-0.5">{d.clubdesk || '—'}</div>
                            ))}
                          </TableCell>
                        </TableRow>
                        {open && (
                          <TableRow className="hover:bg-transparent">
                            <TableCell colSpan={span} className="bg-muted/30 text-xs">
                              <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
                                <span>
                                  <span className="text-muted-foreground">{t('clubdeskGroupColClubdeskId')}: </span>
                                  {r.clubdesk_id || '—'}
                                </span>
                                <span className="flex items-center gap-1">
                                  <span className="text-muted-foreground">{t('cdColLastBill')}: </span>
                                  <LastBillCell bill={r.last_bill} />
                                </span>
                                {activeTab === 'all' && (
                                  <span className="text-muted-foreground">
                                    {t(`cdSyncHint_${r.status}`, { defaultValue: '' })}
                                  </span>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
