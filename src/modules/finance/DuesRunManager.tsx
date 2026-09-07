import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, Loader2, PlayCircle, ListChecks, Download, Mail } from 'lucide-react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import DatePicker from '@/components/ui/DatePicker'
import { formatDateCompactZurich } from '../../utils/dateHelpers'
import {
  useDuesRates, useDuesRuns, saveDuesRate, deleteDuesRate,
  previewDuesRun, issueDuesRun, cancelDuesRun, fetchDuesRunInvoices, formatChf, toNum,
  type DuesPreviewResult, type DuesPreviewRow, type DuesRun,
} from '../../hooks/useFinance'
import { downloadInvoiceBillsPdf } from './qrBillPdf'
import { DuesEmailSettings, SendDuesEmailModal } from './DuesEmail'
import { useConfirm } from '../../components/ConfirmProvider'

const labelCls = 'block text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400'
const inputCls = 'mt-1 w-full rounded-md border border-gray-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-brand-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100'
const skelBar = 'animate-pulse bg-gray-200 dark:bg-gray-700'
const apiErr = (e: unknown, fallback: string) => (e as { body?: { error?: string } })?.body?.error || fallback

/** Per-member row status badge in the preview.
 *  `zeroRate` mirrors the issue endpoint's skip rule — a 0 CHF rate ('Gratis',
 *  'Kein Beitrag') is a real rate, but issuing would mint an invoice for
 *  nothing, so it never does. Showing those as "Will bill" made the preview
 *  promise ~90 more invoices than the run creates. */
function rowStatus(r: DuesPreviewRow): 'willBill' | 'alreadyBilled' | 'clubdeskBilled' | 'noRate' | 'zeroRate' | 'waived' {
  if (r.missing_rate) return 'noRate'
  if (r.already_billed) return 'alreadyBilled'
  if (r.clubdesk_billed) return 'clubdeskBilled'
  // Since 2026-08-13 both of these still get a DOCUMENT (a CHF 0 invoice) —
  // they are separated only because "the club waived a real fee" and "this
  // category costs nothing" are different facts to an auditor. `exempt` reads
  // as waived even at 0: a 'Gratis' member whose sektion has no comparable rate
  // still gets the named exemption on their invoice.
  if ((r.waiver || 0) > 0 || r.exempt) return 'waived'
  if (!r.amount || r.amount <= 0) return 'zeroRate'
  return 'willBill'
}

/** Rows this run will create an invoice for — paying and free alike. `noRate`
 *  is excluded because an unpriceable category cannot be invoiced at all. */
function isIssuable(r: DuesPreviewRow): boolean {
  return ['willBill', 'waived', 'zeroRate'].includes(rowStatus(r))
}
const STATUS_TONE: Record<string, string> = {
  willBill: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  alreadyBilled: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  clubdeskBilled: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  noRate: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  zeroRate: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
  waived: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
}

export default function DuesRunManager({ fiscalYearId, fiscalYearLabel }: { fiscalYearId: string; fiscalYearLabel: string }) {
  const { t } = useTranslation('finance')
  const confirm = useConfirm()
  const fyNum = Number(fiscalYearId)
  const { data: ratesData, isPending: ratesLoading, isPlaceholderData: ratesStale, isError: ratesFailed, refetch: refetchRates } = useDuesRates(fiscalYearId)
  const { data: runs, isPending: runsLoading, isPlaceholderData: runsStale, isError: runsFailed, refetch: refetchRuns } = useDuesRuns(fiscalYearId)
  /** "Not loaded yet" must never read as "the club has none" — this screen's two
   *  empty states are the financial claims "membership dues have never been billed
   *  for this year" and "no member has a category", read right before minting ~570
   *  irreversible invoices.
   *  `isPending`, not `isLoading`: useDuesRates is disabled while fiscalYearId is ''
   *  and a disabled query reports isLoading===false.
   *  `isPlaceholderData`: the global keepPreviousData default (src/lib/query.tsx)
   *  hands back the PREVIOUS fiscal year's rates/runs on a year switch, which would
   *  otherwise print last year's schedule under this year's heading.
   *  `isError` is the escape: on a failed fetch data stays undefined forever, and a
   *  permanent skeleton is worse than the wrong frame it replaces. */
  // ⚠ `isPending` is ALSO true for a DISABLED query, for ever — `useDuesRates` is
  // `enabled` on a non-empty fiscalYearId, so without one this gate would never
  // release and the add-rate selects and Preview button would stay disabled with
  // nothing loading. Ask for a fiscal year first, exactly like BudgetTab does.
  const ratesPending = !!fiscalYearId && !ratesFailed && (ratesLoading || ratesStale)
  const runsPending = !runsFailed && (runsLoading || runsStale)
  const categories = ratesData?.categories ?? []
  const sektionen = ratesData?.sektionen ?? []

  // ── Add-rate form ──
  const [rCat, setRCat] = useState('')
  const [rSek, setRSek] = useState('')
  const [rAmt, setRAmt] = useState('')
  /** Federation licence contained IN the amount (migration 323), not added to it. */
  const [rLic, setRLic] = useState('')
  const [rSubj, setRSubj] = useState('')
  const [rBusy, setRBusy] = useState(false)
  const [rErr, setRErr] = useState('')
  const rAmtNum = Number(rAmt.replace(',', '.'))
  const rLicNum = rLic.trim() === '' ? 0 : Number(rLic.replace(',', '.'))
  // A licence bigger than the rate would print a negative membership line — the
  // DB CHECK refuses it, so catch it here rather than showing the treasurer a 400.
  const rValid = !!rCat && rAmtNum >= 0 && rAmt.trim() !== '' && rLicNum >= 0 && rLicNum <= rAmtNum

  async function addRate() {
    if (!rValid) return
    setRBusy(true); setRErr('')
    try {
      await saveDuesRate({ fiscal_year: fyNum, category: rCat, sektion: rSek || null, amount_chf: rAmtNum, licence_chf: rLicNum, subject_template: rSubj.trim() || null })
      setRCat(''); setRSek(''); setRAmt(''); setRLic(''); setRSubj('')
      await refetchRates()
    } catch (e) { setRErr(apiErr(e, t('duesRateSaveError'))) } finally { setRBusy(false) }
  }
  async function removeRate(id: number) {
    if (!(await confirm({ message: t('duesRateDeleteSure'), danger: true }))) return
    setRErr('')
    try { await deleteDuesRate(id); await refetchRates() } catch (e) { setRErr(apiErr(e, t('ledActionError'))) }
  }

  // ── Run wizard ──
  const [selected, setSelected] = useState<string[]>([])
  const [onlyActive, setOnlyActive] = useState(true)
  const [dueDate, setDueDate] = useState('')
  const [preview, setPreview] = useState<DuesPreviewResult | null>(null)
  const [pvBusy, setPvBusy] = useState(false)
  const [issuing, setIssuing] = useState(false)
  const [runMsg, setRunMsg] = useState('')
  const [runErr, setRunErr] = useState('')
  /** Members ticked in the preview. Empty = bill everyone billable. */
  const [picked, setPicked] = useState<Set<number>>(new Set())
  /** Per-member CHF reduction granted for this run, keyed by member id. */
  const [discounts, setDiscounts] = useState<Record<number, string>>({})
  const [discountReason, setDiscountReason] = useState('')
  /** Only positive, parseable entries reach the endpoint. */
  const discountPayload = useMemo(() => {
    const out: Record<number, number> = {}
    for (const [k, v] of Object.entries(discounts)) {
      const n = Number(String(v).replace(',', '.'))
      if (Number.isFinite(n) && n > 0) out[Number(k)] = n
    }
    return out
  }, [discounts])
  const hasDiscounts = Object.keys(discountPayload).length > 0
  const togglePick = (id: number) => setPicked((p) => {
    const n = new Set(p)
    if (!n.delete(id)) n.add(id)
    return n
  })
  const toggleCat = (c: string) => { setPreview(null); setRunMsg(''); setPicked(new Set()); setSelected((p) => p.includes(c) ? p.filter((x) => x !== c) : [...p, c]) }

  async function runPreview() {
    if (!selected.length) { setRunErr(t('duesNoCategories')); return }
    setPvBusy(true); setRunErr(''); setRunMsg('')
    try {
      setPreview(await previewDuesRun({
        fiscal_year: fyNum, categories: selected, only_active: onlyActive,
        ...(hasDiscounts ? { discounts: discountPayload, discount_reason: discountReason.trim() || null } : {}),
      }))
    } catch (e) { setRunErr(apiErr(e, t('duesPreviewError'))) } finally { setPvBusy(false) }
  }
  async function issue() {
    if (!preview) return
    // Nothing ticked = bill the whole billable cohort (the ordinary run). Tick a
    // few and only those are billed — how you trial the run on one member before
    // committing 570 real invoices.
    const pickedRows = preview.rows.filter((r) => picked.has(r.member) && isIssuable(r))
    const trial = pickedRows.length > 0
    // The COUNT is what the run creates (free members included); the AMOUNT is
    // only what carries money. Quoting `billable` here promised fewer invoices
    // than the run makes now that CHF 0 rows are issued.
    const billable = trial ? pickedRows.length : preview.totals.issuable
    const amount = trial ? pickedRows.reduce((s, r) => s + (r.amount || 0), 0) : preview.totals.billable_amount
    if (!billable) return
    // High-stakes, irreversible batch (creates a payable QR-bill for every
    // billable member) — gate it behind the branded destructive confirm with a
    // count/amount summary instead of a reflexive browser popup.
    const ok = await confirm({
      title: t('duesIssueConfirmTitle'),
      message: t('duesIssueSure', { count: billable, amount: formatChf(amount) }),
      confirmLabel: t('duesIssueCta', { count: billable }),
      danger: true,
    })
    if (!ok) return
    setIssuing(true); setRunErr('')
    try {
      const r = await issueDuesRun({
        fiscal_year: fyNum, categories: selected, only_active: onlyActive, due_date: dueDate || null,
        member_ids: trial ? pickedRows.map((x) => x.member) : null,
        ...(hasDiscounts ? { discounts: discountPayload, discount_reason: discountReason.trim() || null } : {}),
      })
      setRunMsg(t('duesIssued', { count: r.summary.created, amount: formatChf(r.run.total_amount) }))
      setPreview(null); setSelected([]); setPicked(new Set()); setDiscounts({}); setDiscountReason('')
      await refetchRuns()
    } catch (e) { setRunErr(apiErr(e, t('duesIssueError'))) } finally { setIssuing(false) }
  }
  async function cancelRun(id: number) {
    if (!(await confirm({ message: t('duesRunCancelSure'), danger: true }))) return
    try {
      const r = await cancelDuesRun(id)
      setRunMsg(t('duesRunCancelled', { count: r.cancelled }))
      await refetchRuns()
    } catch (e) { setRunErr(apiErr(e, t('duesRunCancelError'))) }
  }

  // Download every bill in a run as one multi-page PDF (print/post or attach).
  const [billBusy, setBillBusy] = useState<number | null>(null)
  const [emailTarget, setEmailTarget] = useState<DuesRun | null>(null)
  async function downloadBills(run: DuesRun) {
    setBillBusy(run.id); setRunErr('')
    try {
      const { invoices } = await fetchDuesRunInvoices(run.id)
      const bills = invoices
        // Never re-bill a settled invoice — a full-amount QR slip would let a
        // paid member pay twice.
        .filter((inv) => inv.status !== 'paid')
        .map((inv) => {
          // Bill only the still-open balance. Fall back to the full amount only
          // when open_amount is genuinely unknown (null), never when it's 0 (paid).
          const open = inv.open_amount == null ? toNum(inv.amount) : toNum(inv.open_amount)
          return {
            number: inv.number,
            recipientName: inv.recipient_name,
            amount: open,
            message: [inv.number ? `Rechnungsnummer: ${inv.number}` : null, inv.subject].filter(Boolean).join('\n') || null,
            reference: inv.reference_type === 'SCOR' ? inv.reference : null,
          }
        })
        .filter((b) => b.amount >= 0.01)
      if (!bills.length) { setRunErr(t('duesBillsEmpty')); return }
      const safe = String(run.label || run.id).replace(/[^\w.-]+/g, '-')
      await downloadInvoiceBillsPdf(bills, `dues-${safe}.pdf`, t('duesBillsPdfTitle', { run: run.label || `#${run.id}` }))
    } catch { setRunErr(t('duesBillsError')) } finally { setBillBusy(null) }
  }

  const statusLabel = (s: string) => ({ willBill: t('duesStatusWillBill'), alreadyBilled: t('duesStatusAlreadyBilled'), clubdeskBilled: t('duesStatusClubdeskBilled'), noRate: t('duesStatusNoRate'), zeroRate: t('duesStatusZeroRate'), waived: t('duesStatusWaived') }[s] ?? s)
  const sektionLabel = (s: string | null) => s || t('duesSektionDefault')
  /** Why this member's bill came to nothing — the same reason the invoice prints. */
  const waiverWhy = (reason: DuesPreviewRow['waiver_reason']) => ({
    honorary: t('duesWaiverWhyHonorary'), vorstand: t('duesWaiverWhyVorstand'),
    coach: t('duesWaiverWhyCoach'), gratis: t('duesWaiverWhyGratis'),
  }[reason ?? 'gratis'] ?? t('duesWaiverWhyGratis'))
  const sortedRates = useMemo(() => [...(ratesData?.rates ?? [])].sort((a, b) => a.category.localeCompare(b.category) || (a.sektion || '').localeCompare(b.sektion || '')), [ratesData])

  if (!fiscalYearId) {
    return <p className="rounded-lg border border-dashed border-gray-300 py-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">{t('duesNeedFiscalYear')}</p>
  }

  return (
    <div className="space-y-8">
      <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-300">
        {t('duesBookNote')}
      </p>

      {/* ── Rate schedule ──────────────────────────────────────── */}
      <section>
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('duesRatesTitle')}</h2>
        <p className="mb-3 mt-0.5 text-xs text-gray-500 dark:text-gray-400">{t('duesRatesHint', { year: fiscalYearLabel })}</p>

        <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
          <Table>
            <TableHeader>
              <TableRow className="border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/40">
                <TableHead className="text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('duesColCategory')}</TableHead>
                <TableHead className="text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('duesColSektion')}</TableHead>
                <TableHead className="text-right text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('duesColAmount')}</TableHead>
                <TableHead className="text-right text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('duesColLicence')}</TableHead>
                <TableHead className="hidden sm:table-cell text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('duesColSubject')}</TableHead>
                <TableHead className="text-right text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ratesPending ? [0, 1, 2].map((i) => (
                <TableRow key={`rate-skeleton-${i}`} className="border-gray-200 dark:border-gray-700" aria-hidden="true">
                  <TableCell><div className={`${skelBar} h-4 w-24 rounded`} /></TableCell>
                  <TableCell><div className={`${skelBar} h-4 w-20 rounded`} /></TableCell>
                  <TableCell><div className={`${skelBar} ml-auto h-4 w-16 rounded`} /></TableCell>
                  <TableCell><div className={`${skelBar} ml-auto h-4 w-12 rounded`} /></TableCell>
                  <TableCell className="hidden sm:table-cell"><div className={`${skelBar} h-4 w-32 rounded`} /></TableCell>
                  <TableCell><div className={`${skelBar} ml-auto h-6 w-6 rounded-md`} /></TableCell>
                </TableRow>
              )) : sortedRates.map((r) => (
                <TableRow key={r.id} className="border-gray-200 dark:border-gray-700">
                  <TableCell className="whitespace-normal break-words text-gray-900 dark:text-gray-100">{r.category}</TableCell>
                  <TableCell className="whitespace-normal break-words text-gray-600 dark:text-gray-400">{sektionLabel(r.sektion)}</TableCell>
                  <TableCell className="text-right tabular-nums text-gray-900 dark:text-gray-100">{formatChf(r.amount_chf)}</TableCell>
                  {/* Contained in the amount, so the club's own share is shown
                      beneath it — otherwise "440 and 110" reads as 550. */}
                  <TableCell className="text-right tabular-nums text-gray-600 dark:text-gray-400">
                    {toNum(r.licence_chf) > 0 ? (
                      <>
                        {formatChf(r.licence_chf)}
                        <span className="mt-0.5 block text-xs text-gray-400">{t('duesLicenceOfWhich', { amount: formatChf(toNum(r.amount_chf) - toNum(r.licence_chf)) })}</span>
                      </>
                    ) : '–'}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell whitespace-normal break-words text-xs text-gray-500 dark:text-gray-400">{r.subject_template || '–'}</TableCell>
                  <TableCell className="text-right">
                    <button type="button" onClick={() => removeRate(r.id)} aria-label={t('duesRateDelete')}
                      className="inline-flex items-center rounded-md border border-gray-300 p-1.5 text-gray-500 hover:bg-gray-50 hover:text-red-600 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-700">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </TableCell>
                </TableRow>
              ))}
              {/* Add-rate row */}
              <TableRow className="border-gray-200 bg-gray-50/60 dark:border-gray-700 dark:bg-gray-900/20">
                <TableCell>
                  <select value={rCat} onChange={(e) => setRCat(e.target.value)} disabled={ratesPending} className={`${inputCls} mt-0 disabled:opacity-60`} aria-label={t('duesColCategory')}>
                    <option value="">{t('duesPickCategory')}</option>
                    {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </TableCell>
                <TableCell>
                  <select value={rSek} onChange={(e) => setRSek(e.target.value)} disabled={ratesPending} className={`${inputCls} mt-0 disabled:opacity-60`} aria-label={t('duesColSektion')}>
                    <option value="">{t('duesSektionDefault')}</option>
                    {sektionen.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </TableCell>
                <TableCell>
                  <input value={rAmt} onChange={(e) => setRAmt(e.target.value)} inputMode="decimal" placeholder="0.00" className={`${inputCls} mt-0 text-right`} aria-label={t('duesColAmount')} />
                </TableCell>
                <TableCell>
                  <input value={rLic} onChange={(e) => setRLic(e.target.value)} inputMode="decimal" placeholder="0.00" className={`${inputCls} mt-0 text-right`} aria-label={t('duesColLicence')} />
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <input value={rSubj} onChange={(e) => setRSubj(e.target.value)} placeholder={t('duesSubjectPlaceholder')} className={`${inputCls} mt-0`} aria-label={t('duesColSubject')} />
                </TableCell>
                <TableCell className="text-right">
                  <button type="button" disabled={!rValid || rBusy} onClick={addRate}
                    className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50">
                    {rBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}{t('duesAddRateCta')}
                  </button>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
        {rErr && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{rErr}</p>}
      </section>

      {/* ── Run wizard ─────────────────────────────────────────── */}
      <section>
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('duesRunTitle')}</h2>
        <p className="mb-3 mt-0.5 text-xs text-gray-500 dark:text-gray-400">{t('duesRunHint', { year: fiscalYearLabel })}</p>

        <div className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
          <div>
            <span id="dues-pick-categories-label" className={labelCls}>{t('duesPickCategories')}</span>
            {ratesPending ? (
              <div className="mt-1.5 flex flex-wrap gap-1.5" aria-hidden="true">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <div key={`cat-skeleton-${i}`} className={`${skelBar} h-[26px] w-20 rounded-full`} />
                ))}
              </div>
            ) : categories.length === 0 ? (
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t('duesNoActiveCategories')}</p>
            ) : (
              <div role="group" aria-labelledby="dues-pick-categories-label" className="mt-1.5 flex flex-wrap gap-1.5">
                {categories.map((c) => (
                  <button key={c} type="button" onClick={() => toggleCat(c)}
                    className={`rounded-full border px-3 py-1 text-xs font-medium ${selected.includes(c)
                      ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-300'
                      : 'border-gray-200 text-gray-600 dark:border-gray-600 dark:text-gray-300'}`}>
                    {c}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <input type="checkbox" checked={onlyActive} onChange={(e) => { setOnlyActive(e.target.checked); setPreview(null) }} />
              {t('duesOnlyActive')}
            </label>
            <div>
              <DatePicker id="dues-run-due-date" label={t('duesRunDueDate')} value={dueDate} onChange={setDueDate} />
            </div>
            <button type="button" disabled={!selected.length || pvBusy || ratesPending} onClick={runPreview}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700">
              {pvBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ListChecks className="h-4 w-4" />}{t('duesPreviewCta')}
            </button>
          </div>

          {runErr && <p className="text-sm text-red-600 dark:text-red-400">{runErr}</p>}
          {runMsg && <p className="text-sm text-green-700 dark:text-green-400">{runMsg}</p>}

          {preview && (
            <div className="space-y-3 border-t border-gray-200 pt-4 dark:border-gray-700">
              <p className="text-sm text-gray-700 dark:text-gray-300">
                {t('duesPreviewSummary', {
                  billable: preview.totals.billable,
                  amount: formatChf(preview.totals.billable_amount),
                  already: preview.totals.already_billed,
                  noRate: preview.totals.missing_rate,
                })}
                {preview.totals.clubdesk_billed > 0 && <span className="text-purple-700 dark:text-purple-400"> · {t('duesClubdeskBilledNote', { count: preview.totals.clubdesk_billed })}</span>}
                {preview.totals.zero_rate > 0 && <span className="text-gray-500 dark:text-gray-400"> · {t('duesZeroRateNote', { count: preview.totals.zero_rate })}</span>}
                {preview.totals.waived > 0 && <span className="text-gray-500 dark:text-gray-400"> · {t('duesWaivedNote', { count: preview.totals.waived, amount: formatChf(preview.totals.waived_amount) })}</span>}
                {/* A run that silently omits people must say so — the preview only
                    describes the categories that were picked. */}
                {preview.totals.no_email > 0 && <span className="text-amber-700 dark:text-amber-400"> · {t('duesNoEmailNote', { count: preview.totals.no_email })}</span>}
              </p>
              {hasDiscounts && (
                <div>
                  <label htmlFor="dues-discount-reason" className={labelCls}>{t('duesDiscountReason')}</label>
                  <input id="dues-discount-reason" value={discountReason} onChange={(e) => setDiscountReason(e.target.value)}
                    placeholder={t('invoiceDiscountReasonPlaceholder')} className={inputCls} />
                </div>
              )}

              {!!preview.uncovered && (preview.uncovered.no_category > 0 || preview.uncovered.category_not_selected > 0) && (
                <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-900/20 dark:text-amber-200">
                  <p className="font-semibold">{t('duesUncoveredTitle')}</p>
                  <p className="mt-0.5">
                    {preview.uncovered.no_category > 0 && t('duesUncoveredNoCategory', { count: preview.uncovered.no_category })}
                    {preview.uncovered.no_category > 0 && preview.uncovered.category_not_selected > 0 && ' · '}
                    {preview.uncovered.category_not_selected > 0 && t('duesUncoveredNotSelected', { count: preview.uncovered.category_not_selected })}
                  </p>
                  {preview.uncovered.members.length > 0 && (
                    <p className="mt-1 text-amber-800 dark:text-amber-300">
                      {preview.uncovered.members.map((m) => m.name || `#${m.member}`).join(', ')}
                    </p>
                  )}
                </div>
              )}

              {/* The total is NOT the sum of the rate schedule — say so, with the
                  two adjustments spelled out, so it reconciles on sight. */}
              {(preview.totals.surcharged > 0 || preview.totals.guests > 0) && (
                <p className="text-xs text-gray-600 dark:text-gray-400">
                  {t('duesAdjustmentsNote', { base: formatChf(preview.totals.base_amount) })}
                  {preview.totals.surcharged > 0 && <span className="text-amber-700 dark:text-amber-400"> · {t('duesSurchargeNote', { count: preview.totals.surcharged, amount: formatChf(preview.totals.surcharge_amount) })}</span>}
                  {preview.totals.guests > 0 && <span className="text-emerald-700 dark:text-emerald-400"> · {t('duesGuestNote', { count: preview.totals.guests, amount: formatChf(preview.totals.guest_discount_amount) })}</span>}
                  {preview.totals.discounted > 0 && <span className="text-emerald-700 dark:text-emerald-400"> · {t('duesDiscountNote', { count: preview.totals.discounted, amount: formatChf(preview.totals.discount_amount) })}</span>}
                </p>
              )}
              {/* Inside the total, not on top of it — the club forwards this to
                  the federation, so the treasurer can read its own income off
                  the difference without opening a single invoice. */}
              {preview.totals.licence_amount > 0 && (
                <p className="text-xs text-gray-600 dark:text-gray-400">
                  {t('duesLicenceNote', { count: preview.totals.licensed, amount: formatChf(preview.totals.licence_amount) })}
                </p>
              )}
              <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
                <Table>
                  <TableHeader>
                    <TableRow className="border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/40">
                      <TableHead className="w-10 text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400"><span className="sr-only">{t('duesColPick')}</span></TableHead>
                      <TableHead className="text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('duesColMember')}</TableHead>
                      <TableHead className="hidden sm:table-cell text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('duesColCategory')}</TableHead>
                      <TableHead className="hidden md:table-cell text-right text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('duesColDiscount')}</TableHead>
                      <TableHead className="text-right text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('duesColAmount')}</TableHead>
                      <TableHead className="text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('colStatus')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.rows.map((r) => {
                      const s = rowStatus(r)
                      return (
                        <TableRow key={r.member} className="border-gray-200 dark:border-gray-700">
                          {/* Only a row that would actually be billed can be picked. */}
                          <TableCell className="align-top">
                            {s === 'willBill' && (
                              <input type="checkbox" checked={picked.has(r.member)} onChange={() => togglePick(r.member)}
                                aria-label={t('duesPickMember', { name: r.name || String(r.member) })}
                                className="mt-1 h-4 w-4 cursor-pointer rounded border-gray-300 text-brand-600 focus:ring-brand-500 dark:border-gray-600 dark:bg-gray-700" />
                            )}
                          </TableCell>
                          <TableCell className="whitespace-normal break-words text-gray-900 dark:text-gray-100">
                            {r.name || '–'}
                            {r.missing_email && <span className="mt-0.5 block text-xs text-amber-600 dark:text-amber-400">{t('duesStatusNoEmail')}</span>}
                          </TableCell>
                          <TableCell className="hidden sm:table-cell whitespace-normal break-words text-gray-600 dark:text-gray-400">{r.category || '–'}{r.sektion ? ` · ${r.sektion}` : ''}</TableCell>
                          {/* Grant a reduction on this one bill. Re-preview applies it —
                              the club's habit of billing full and writing off later leaves
                              the member holding an invoice that overstates what they owe. */}
                          <TableCell className="hidden md:table-cell text-right">
                            {s === 'willBill' || (r.discount ?? 0) > 0 ? (
                              <input
                                value={discounts[r.member] ?? ''}
                                onChange={(e) => setDiscounts((p) => ({ ...p, [r.member]: e.target.value }))}
                                inputMode="decimal" placeholder="0.00"
                                aria-label={t('duesColDiscount')}
                                className="w-20 rounded border border-gray-200 bg-transparent px-2 py-1 text-right text-xs tabular-nums outline-none focus:border-brand-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                              />
                            ) : null}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-gray-900 dark:text-gray-100">
                            {r.amount != null ? formatChf(r.amount) : '–'}
                            {/* Why it isn't the plain category rate. Without this the
                                treasurer has no way to answer "why does she pay 540?". */}
                            {r.amount != null && (r.surcharge > 0 || r.guest_discount > 0 || (r.discount ?? 0) > 0 || (r.waiver ?? 0) > 0) && (
                              <span className="mt-0.5 block text-xs font-normal text-gray-500 dark:text-gray-400">
                                {formatChf(r.base_amount ?? 0)}
                                {r.surcharge > 0 && <span className="text-amber-600 dark:text-amber-400"> + {formatChf(r.surcharge)}</span>}
                                {r.guest_discount > 0 && <span className="text-emerald-600 dark:text-emerald-400"> − {formatChf(r.guest_discount)}</span>}
                                {(r.discount ?? 0) > 0 && <span className="text-emerald-600 dark:text-emerald-400"> − {formatChf(r.discount)}</span>}
                                {(r.waiver ?? 0) > 0 && <span className="text-teal-600 dark:text-teal-400"> − {formatChf(r.waiver)}</span>}
                                {/* The waiver reason wins the caption: it is the one that
                                    explains a CHF 0 line, and it is what the invoice prints. */}
                                <span className="block">
                                  {(r.waiver ?? 0) > 0 ? waiverWhy(r.waiver_reason)
                                    : r.surcharge > 0 ? t('duesSurchargeWhy') : t('duesGuestWhy')}
                                </span>
                              </span>
                            )}
                          </TableCell>
                          <TableCell><span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[s]}`}>{statusLabel(s)}</span></TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
              <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-end">
                {picked.size > 0 && (
                  <p className="text-xs text-brand-700 dark:text-brand-300">
                    {t('duesTrialRunNote', { count: picked.size })}
                    <button type="button" onClick={() => setPicked(new Set())} className="ml-2 underline">{t('duesTrialClear')}</button>
                  </p>
                )}
                <button type="button" disabled={!preview.totals.issuable || issuing} onClick={issue}
                  className="inline-flex items-center justify-center gap-1.5 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
                  {issuing ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
                  {t('duesIssueCta', { count: picked.size || preview.totals.issuable })}
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ── Email sending (global test-mode switch) ────────────── */}
      <DuesEmailSettings />

      {/* ── Past runs ──────────────────────────────────────────── */}
      <section>
        <h2 className="mb-3 text-sm font-semibold text-gray-900 dark:text-gray-100">{t('duesRunsTitle')}</h2>
        {runsPending || (runs ?? []).length > 0 ? (
          <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800" aria-busy={runsPending}>
            <Table>
              <TableHeader>
                <TableRow className="border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/40">
                  <TableHead className="text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('duesColRunLabel')}</TableHead>
                  <TableHead className="hidden sm:table-cell text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('duesColRunDate')}</TableHead>
                  <TableHead className="text-right text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('duesColRunCount')}</TableHead>
                  <TableHead className="text-right text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('duesColRunTotal')}</TableHead>
                  <TableHead className="text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('colStatus')}</TableHead>
                  <TableHead className="text-right text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runsPending ? [0, 1, 2].map((i) => (
                  <TableRow key={`run-skeleton-${i}`} className="border-gray-200 dark:border-gray-700" aria-hidden="true">
                    <TableCell><div className={`${skelBar} h-4 w-32 rounded`} /></TableCell>
                    <TableCell className="hidden sm:table-cell"><div className={`${skelBar} h-4 w-20 rounded`} /></TableCell>
                    <TableCell><div className={`${skelBar} ml-auto h-4 w-8 rounded`} /></TableCell>
                    <TableCell><div className={`${skelBar} ml-auto h-4 w-16 rounded`} /></TableCell>
                    <TableCell><div className={`${skelBar} h-4 w-16 rounded`} /></TableCell>
                    <TableCell><div className={`${skelBar} ml-auto h-6 w-24 rounded-md`} /></TableCell>
                  </TableRow>
                )) : (runs ?? []).map((run) => (
                  <TableRow key={run.id} className="border-gray-200 dark:border-gray-700">
                    <TableCell className="whitespace-normal break-words text-gray-900 dark:text-gray-100">{run.label || `#${run.id}`}</TableCell>
                    <TableCell className="hidden sm:table-cell whitespace-nowrap text-gray-600 dark:text-gray-400">{run.date_created ? formatDateCompactZurich(run.date_created) : '–'}</TableCell>
                    <TableCell className="text-right tabular-nums text-gray-900 dark:text-gray-100">{run.total_count}</TableCell>
                    <TableCell className="text-right tabular-nums text-gray-900 dark:text-gray-100">{formatChf(toNum(run.total_amount))}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-gray-600 dark:text-gray-300">{run.status === 'cancelled' ? t('duesRunStatusCancelled') : t('duesRunStatusIssued')}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex flex-col items-end gap-1.5 sm:flex-row sm:justify-end">
                        {run.status !== 'cancelled' && run.total_count > 0 && (
                          <button type="button" disabled={billBusy === run.id} onClick={() => downloadBills(run)}
                            className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700">
                            {billBusy === run.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}{t('duesDownloadBills')}
                          </button>
                        )}
                        {run.status !== 'cancelled' && run.total_count > 0 && (
                          <button type="button" onClick={() => setEmailTarget(run)}
                            className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700">
                            <Mail className="h-3.5 w-3.5" />{t('duesEmailSendShort')}
                          </button>
                        )}
                        {run.status !== 'cancelled' && (
                          <button type="button" onClick={() => cancelRun(run.id)}
                            className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700">
                            {t('duesRunCancel')}
                          </button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-gray-300 py-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">{t('duesNoRuns')}</p>
        )}
      </section>

      <SendDuesEmailModal key={emailTarget?.id ?? 'none'} run={emailTarget} onClose={() => setEmailTarget(null)} />
    </div>
  )
}
