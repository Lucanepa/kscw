// Finance member explorer (migrations 132/133) — the per-member ClubDesk-style
// finance view: contact + IBAN + membership + their invoices, plus an editable
// alternate billing contact (minors/guardians, company-paid). Master list (a
// Table of members) ⇄ full-width member detail. Read for board + finance; the
// billing edit is gated on canEdit (finance role / admin) so a read-only board
// member never hits a 403 on save.
import { useCallback, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Search, Save, Loader2, Mail, Phone, MapPin, CreditCard, ChevronRight, Paperclip, FileText, X, User2 } from 'lucide-react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { formatDateCompactZurich } from '../../utils/dateHelpers'
import { useAuth } from '../../hooks/useAuth'
import { useAdminMode } from '../../hooks/useAdminMode'
import {
  useFinanceInvoices, useFinanceMembers, useFinanceInvoiceDocuments,
  toNum, formatChf, isOpenInvoice, FINANCE_INVOICE_FOLDER,
  type FinanceMember, type FinanceInvoiceDocument,
} from '../../hooks/useFinance'
import { updateRecord, createRecord, deleteRecord, uploadFile, assetUrl } from '../../lib/api'
import { FilePreviewDialog } from '../../components/FilePreview'
import { logActivity } from '../../utils/logActivity'
import { isValidIban, normalizeIban } from '../../utils/iban'
import MemberPayoutQrBill from './MemberPayoutQrBill'
import type { FinanceInvoice } from './types'

const MAX_DOC_MB = 15

const BILLING_FIELDS = ['billing_different', 'billing_name', 'billing_email', 'billing_address', 'billing_plz', 'billing_ort', 'billing_phone', 'billing_iban'] as const

/** Age in years from a yyyy-mm-dd birthdate, or null. */
function ageOf(birthdate?: string | null): number | null {
  if (!birthdate) return null
  const d = new Date(birthdate)
  if (Number.isNaN(d.getTime())) return null
  const now = new Date()
  let age = now.getFullYear() - d.getFullYear()
  const m = now.getMonth() - d.getMonth()
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--
  return age
}

const fullName = (m: FinanceMember) => [(m.nickname || m.first_name), m.last_name].filter(Boolean).join(' ').trim() || '—'

/** Member's sport: ClubDesk Sektion first, else the membership-category VB/BB prefix. */
function sportOf(m: FinanceMember): 'volleyball' | 'basketball' | null {
  const sek = (m.sektion ?? '').toLowerCase()
  if (sek.includes('volley')) return 'volleyball'
  if (sek.includes('basket')) return 'basketball'
  const cat = (m.beitragskategorie ?? '').trim().toUpperCase()
  if (cat.startsWith('VB')) return 'volleyball'
  if (cat.startsWith('BB')) return 'basketball'
  return null
}

/** Colour + label for an invoice status (native lifecycle + ClubDesk German). */
function useStatusPill() {
  const { t } = useTranslation('finance')
  return (inv: FinanceInvoice) => {
    const amber = 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
    const orange = 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300'
    const blue = 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300'
    const green = 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
    const red = 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
    const gray = 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
    if (inv.source === 'native') {
      const s = inv.status ?? ''
      if (s === 'open') return { label: t('statusOpen'), cls: amber }
      if (s === 'partial') return { label: t('statusPartial'), cls: orange }
      if (s === 'pending_confirmation') return { label: t('statusPendingConfirmation'), cls: blue }
      if (s === 'paid') return { label: t('statusPaid'), cls: green }
      if (s === 'cancelled') return { label: t('statusCancelled'), cls: gray }
      return { label: s || '—', cls: gray }
    }
    const s = (inv.status ?? '').toLowerCase()
    if (s.includes('bezahl')) return { label: inv.status || t('statusPaid'), cls: green }
    if (s.includes('mahn')) return { label: inv.status || '—', cls: red }
    if (s.includes('storn') || s.includes('abgeschr')) return { label: inv.status || '—', cls: gray }
    if (isOpenInvoice(inv)) return { label: inv.status || t('statusOpen'), cls: amber }
    return { label: inv.status || '—', cls: gray }
  }
}

/** A labelled read-only contact line (hidden when there's no value). */
function InfoRow({ icon, label, value, always }: { icon?: React.ReactNode; label: string; value?: string | null; always?: boolean }) {
  if (!value && !always) return null
  return (
    <div className="flex items-start gap-2 py-1 text-sm">
      {icon && <span className="mt-0.5 shrink-0 text-gray-400">{icon}</span>}
      <span className="w-28 shrink-0 text-gray-500 dark:text-gray-400">{label}</span>
      <span className={`min-w-0 break-words ${value ? 'font-medium text-gray-900 dark:text-gray-100' : 'text-gray-400 dark:text-gray-500'}`}>{value || '—'}</span>
    </div>
  )
}

function fieldInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className="w-full rounded-md border border-gray-200 bg-transparent px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
    />
  )
}

function MemberDetail({ member, invoices, documents, canEdit, onBack, onSaved, onDocsChanged }: {
  member: FinanceMember
  invoices: FinanceInvoice[]
  documents: FinanceInvoiceDocument[]
  canEdit: boolean
  onBack: () => void
  onSaved: () => void
  onDocsChanged: () => void
}) {
  const { t } = useTranslation('finance')
  const { user } = useAuth()
  const statusPill = useStatusPill()
  const fileRef = useRef<HTMLInputElement>(null)
  const attachTarget = useRef<FinanceInvoice | null>(null)
  const [busyInvoice, setBusyInvoice] = useState<string | null>(null)

  // Docs for an invoice: ClubDesk rows key on clubdesk_id (sync-safe), native on the invoice id.
  const docsFor = useCallback((inv: FinanceInvoice) => documents.filter((d) =>
    (inv.source !== 'native' && inv.clubdesk_id && d.match_clubdesk_id === inv.clubdesk_id) ||
    (d.invoice != null && String(d.invoice) === String(inv.id)),
  ), [documents])

  const pickFile = (inv: FinanceInvoice) => { attachTarget.current = inv; fileRef.current?.click() }

  const onFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    const inv = attachTarget.current
    if (!file || !inv) return
    if (file.size > MAX_DOC_MB * 1024 * 1024) { toast.error(t('docTooBig', { mb: MAX_DOC_MB })); return }
    setBusyInvoice(String(inv.id))
    try {
      const up = await uploadFile(file, FINANCE_INVOICE_FOLDER)
      const key = (inv.source !== 'native' && inv.clubdesk_id)
        ? { match_clubdesk_id: inv.clubdesk_id }
        : { invoice: inv.id }
      await createRecord('finance_invoice_documents', {
        file: up.id, ...key, label: up.name,
        uploaded_by_name: [user?.first_name, user?.last_name].filter(Boolean).join(' ').trim() || null,
        uploaded_by_email: user?.email ?? null,
      })
      logActivity('create', 'finance_invoice_documents', undefined, { invoice: inv.number, ...key })
      toast.success(t('docUploaded'))
      onDocsChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('docUploadError'))
    } finally {
      setBusyInvoice(null)
    }
  }

  const removeDoc = async (doc: FinanceInvoiceDocument) => {
    try {
      await deleteRecord('finance_invoice_documents', doc.id)
      logActivity('delete', 'finance_invoice_documents', String(doc.id), null)
      onDocsChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('docDeleteError'))
    }
  }

  // Preview in place — invoice attachments are almost always PDFs, and bouncing
  // the treasurer into a new tab per document made reconciliation a tab graveyard.
  const [previewDoc, setPreviewDoc] = useState<FinanceInvoiceDocument | null>(null)
  // Billing draft — component is keyed by member.id in the parent, so this
  // initializer reseeds whenever a different member is opened.
  const [draft, setDraft] = useState({
    billing_different: !!member.billing_different,
    billing_name: member.billing_name ?? '',
    billing_email: member.billing_email ?? '',
    billing_address: member.billing_address ?? '',
    billing_plz: member.billing_plz ?? '',
    billing_ort: member.billing_ort ?? '',
    billing_phone: member.billing_phone ?? '',
    billing_iban: member.billing_iban ?? '',
  })
  const [saving, setSaving] = useState(false)

  const set = <K extends keyof typeof draft>(k: K, v: (typeof draft)[K]) => setDraft((d) => ({ ...d, [k]: v }))

  const dirty = useMemo(() => BILLING_FIELDS.some((f) => {
    const orig = f === 'billing_different' ? !!member.billing_different : (member[f] ?? '')
    return draft[f] !== orig
  }), [draft, member])

  const age = ageOf(member.birthdate)
  const isMinor = age != null && age < 18
  const myInvoices = useMemo(
    () => [...invoices].sort((a, b) => (b.invoice_date ?? '').localeCompare(a.invoice_date ?? '')),
    [invoices],
  )
  const totalOpen = useMemo(() => invoices.filter(isOpenInvoice).reduce((s, i) => s + toNum(i.open_amount), 0), [invoices])

  const save = async () => {
    if (!dirty) return
    const billIban = draft.billing_iban.trim()
    if (billIban && !isValidIban(billIban)) { toast.error(t('ibanInvalid')); return }
    setSaving(true)
    try {
      const patch: Record<string, unknown> = {}
      for (const f of BILLING_FIELDS) {
        const orig = f === 'billing_different' ? !!member.billing_different : (member[f] ?? '')
        if (draft[f] !== orig) {
          patch[f] = f === 'billing_different' ? draft[f]
            : f === 'billing_iban' ? (billIban ? normalizeIban(billIban) : null)
            : (String(draft[f]).trim() || null)
        }
      }
      await updateRecord('members', member.id, patch)
      logActivity('update', 'members', String(member.id), patch)
      toast.success(t('billingSaved'))
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('billingSaveError'))
    } finally {
      setSaving(false)
    }
  }

  const addressLine = [member.adresse, [member.plz, member.ort].filter(Boolean).join(' ')].filter(Boolean).join(', ')

  return (
    <div className="space-y-5">
      {canEdit && (
        <input ref={fileRef} type="file" accept=".pdf,image/*,application/pdf" className="hidden" onChange={onFilePicked} />
      )}
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200">
        <ArrowLeft className="h-4 w-4" /> {t('back')}
      </button>

      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">{fullName(member)}</h2>
        {member.sektion && (
          <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-medium text-brand-700 dark:bg-brand-900/40 dark:text-brand-300">{member.sektion}</span>
        )}
        {member.beitragskategorie && (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">{member.beitragskategorie}</span>
        )}
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${member.kscw_membership_active ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300' : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'}`}>
          {member.kscw_membership_active ? t('membershipActive') : t('membershipInactive')}
        </span>
        {isMinor && (
          <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-800 dark:bg-orange-900/30 dark:text-orange-300" title={t('minorHint')}>
            {t('minor')}{age != null ? ` · ${age}` : ''}
          </span>
        )}
      </div>

      {/* Contact */}
      <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('contactSection')}</h3>
        <div className="grid gap-x-6 sm:grid-cols-2">
          <div>
            <InfoRow always icon={<User2 className="h-3.5 w-3.5" />} label={t('fieldName')} value={fullName(member)} />
            <InfoRow always icon={<Mail className="h-3.5 w-3.5" />} label={t('fieldEmail')} value={member.email} />
            <InfoRow always icon={<Phone className="h-3.5 w-3.5" />} label={t('fieldPhone')} value={member.phone} />
            <InfoRow always icon={<MapPin className="h-3.5 w-3.5" />} label={t('fieldAddress')} value={addressLine || null} />
          </div>
          <div>
            <InfoRow always icon={<CreditCard className="h-3.5 w-3.5" />} label={t('fieldIban')} value={member.iban} />
            <InfoRow always label={t('colCategory')} value={member.beitragskategorie} />
            <InfoRow label={t('fieldAhv')} value={member.ahv_nummer} />
            <InfoRow label={t('fieldBirthdate')} value={member.birthdate ? formatDateCompactZurich(member.birthdate) : null} />
          </div>
        </div>
      </section>

      {/* Pay-out QR — reimburse this member by scanning (their IBAN) */}
      <MemberPayoutQrBill member={member} />

      {/* Billing contact */}
      <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('billingSection')}</h3>

        {canEdit ? (
          <div className="space-y-3">
            <label className="flex items-start justify-between gap-3">
              <span>
                <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">{t('billingDifferentToggle')}</span>
                <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">{t('billingDifferentHint')}</span>
              </span>
              <Switch checked={draft.billing_different} onCheckedChange={(v) => set('billing_different', v)} />
            </label>

            {draft.billing_different && (
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block sm:col-span-2"><span className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">{t('fieldName')}</span>{fieldInput({ value: draft.billing_name, onChange: (e) => set('billing_name', e.target.value), placeholder: t('billingNamePlaceholder') })}</label>
                <label className="block"><span className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">{t('fieldEmail')}</span>{fieldInput({ type: 'email', value: draft.billing_email, onChange: (e) => set('billing_email', e.target.value) })}</label>
                <label className="block"><span className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">{t('fieldPhone')}</span>{fieldInput({ value: draft.billing_phone, onChange: (e) => set('billing_phone', e.target.value) })}</label>
                <label className="block sm:col-span-2"><span className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">{t('fieldAddress')}</span>{fieldInput({ value: draft.billing_address, onChange: (e) => set('billing_address', e.target.value) })}</label>
                <label className="block"><span className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">{t('fieldPlz')}</span>{fieldInput({ value: draft.billing_plz, onChange: (e) => set('billing_plz', e.target.value) })}</label>
                <label className="block"><span className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">{t('fieldOrt')}</span>{fieldInput({ value: draft.billing_ort, onChange: (e) => set('billing_ort', e.target.value) })}</label>
                <label className="block sm:col-span-2">
                  <span className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">{t('fieldBillingIban')}</span>
                  {fieldInput({ value: draft.billing_iban, onChange: (e) => set('billing_iban', e.target.value), placeholder: 'CH..' })}
                  <span className="mt-1 block text-xs text-gray-400 dark:text-gray-500">{t('billingIbanHint')}</span>
                </label>
              </div>
            )}
            {!draft.billing_different && <p className="text-sm text-gray-500 dark:text-gray-400">{t('billsToSelf')}</p>}

            <div className="flex justify-end">
              <Button onClick={save} disabled={!dirty || saving} size="sm">
                {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
                {saving ? t('saving') : t('save')}
              </Button>
            </div>
          </div>
        ) : member.billing_different ? (
          <div>
            <InfoRow label={t('fieldName')} value={member.billing_name} />
            <InfoRow icon={<Mail className="h-3.5 w-3.5" />} label={t('fieldEmail')} value={member.billing_email} />
            <InfoRow icon={<Phone className="h-3.5 w-3.5" />} label={t('fieldPhone')} value={member.billing_phone} />
            <InfoRow icon={<MapPin className="h-3.5 w-3.5" />} label={t('fieldAddress')} value={[member.billing_address, [member.billing_plz, member.billing_ort].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null} />
          </div>
        ) : (
          <p className="text-sm text-gray-500 dark:text-gray-400">{t('billsToSelf')}</p>
        )}
      </section>

      {/* Invoices */}
      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('invoicesSection')}</h3>
          {totalOpen > 0.005 && <span className="text-sm font-semibold text-amber-700 dark:text-amber-400">{t('totalOpen')}: {formatChf(totalOpen)}</span>}
        </div>
        {myInvoices.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-300 py-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">{t('noMemberInvoices')}</div>
        ) : (
          <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
            <Table>
              <TableHeader>
                <TableRow className="border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/40">
                  <TableHead className="text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('colInvoice')}</TableHead>
                  <TableHead className="hidden sm:table-cell text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('colSubject')}</TableHead>
                  <TableHead className="text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('colStatus')}</TableHead>
                  <TableHead className="text-right text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('colAmount')}</TableHead>
                  <TableHead className="text-right text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('colOpen')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {myInvoices.map((inv) => {
                  const pill = statusPill(inv)
                  return (
                    <TableRow key={inv.id} className="border-gray-200 dark:border-gray-700">
                      <TableCell className="whitespace-normal break-words text-gray-900 dark:text-gray-100">
                        <span className="font-medium">{inv.number || '—'}</span>
                        <span className="mt-0.5 block text-xs text-gray-400">{inv.invoice_date ? formatDateCompactZurich(inv.invoice_date) : ''}</span>
                        <span className="mt-0.5 block text-xs text-gray-500 sm:hidden">{inv.subject}</span>
                        <span className="mt-1 flex flex-wrap items-center gap-1.5">
                          {docsFor(inv).map((d) => (
                            <span key={d.id} className="inline-flex items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5 dark:bg-gray-700">
                              <button type="button" onClick={() => setPreviewDoc(d)} title={d.label ?? t('viewPdf')} className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline dark:text-brand-300">
                                <FileText className="h-3 w-3" />{t('viewPdf')}
                              </button>
                              {canEdit && (
                                <button type="button" onClick={() => removeDoc(d)} aria-label={t('docDelete')} className="text-gray-400 hover:text-red-600">
                                  <X className="h-3 w-3" />
                                </button>
                              )}
                            </span>
                          ))}
                          {canEdit && (
                            <button
                              type="button"
                              onClick={() => pickFile(inv)}
                              disabled={busyInvoice === String(inv.id)}
                              className="inline-flex items-center gap-1 rounded border border-dashed border-gray-300 px-1.5 py-0.5 text-xs text-gray-500 hover:border-brand-400 hover:text-brand-600 disabled:opacity-50 dark:border-gray-600 dark:text-gray-400"
                            >
                              {busyInvoice === String(inv.id) ? <Loader2 className="h-3 w-3 animate-spin" /> : <Paperclip className="h-3 w-3" />}
                              {t('attachPdf')}
                            </button>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell whitespace-normal break-words text-gray-600 dark:text-gray-400">{inv.subject || '—'}</TableCell>
                      <TableCell><span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${pill.cls}`}>{pill.label}</span></TableCell>
                      <TableCell className="text-right tabular-nums text-gray-900 dark:text-gray-100">{formatChf(inv.amount)}</TableCell>
                      <TableCell className="text-right tabular-nums text-gray-700 dark:text-gray-300">{toNum(inv.open_amount) > 0.005 ? formatChf(inv.open_amount) : '—'}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <FilePreviewDialog
        key={previewDoc?.id}
        open={!!previewDoc}
        onOpenChange={(o) => { if (!o) setPreviewDoc(null) }}
        url={previewDoc ? assetUrl(previewDoc.file) : null}
        label={previewDoc?.label ?? t('viewPdf')}
        filename={previewDoc?.label ?? 'document.pdf'}
      />
    </div>
  )
}

export default function FinanceMemberExplorer() {
  const { t } = useTranslation('finance')
  // `isFinance` folds in isGlobalAdmin, so it was mode-blind. A real finance-role
  // holder keeps edit rights unconditionally; an admin needs the toggle.
  const { matchesRole, isGlobalAdmin } = useAuth()
  const { isAdminMode } = useAdminMode()
  const canEditFinance = matchesRole('finance') || (isGlobalAdmin && isAdminMode)
  const qc = useQueryClient()
  const { data: membersRaw, isLoading } = useFinanceMembers()
  const { data: invoicesRaw } = useFinanceInvoices()
  const { data: documentsRaw } = useFinanceInvoiceDocuments()
  const members = useMemo(() => membersRaw ?? [], [membersRaw])
  const invoices = useMemo(() => invoicesRaw ?? [], [invoicesRaw])
  const documents = useMemo(() => documentsRaw ?? [], [documentsRaw])

  const [query, setQuery] = useState('')
  const [onlyActive, setOnlyActive] = useState(true)
  const [onlyOpen, setOnlyOpen] = useState(false)
  const [sport, setSport] = useState<'all' | 'volleyball' | 'basketball'>('all')
  // Selected member lives in the URL (?m=) so a refresh keeps the open member.
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedId = searchParams.get('m')
  const setSelectedId = (id: string | null) => setSearchParams((prev) => {
    const p = new URLSearchParams(prev)
    if (id) p.set('m', id)
    else p.delete('m')
    return p
  })

  // Per-member invoice index + open balance (single client-side pass).
  const { invoicesByMember, openByMember } = useMemo(() => {
    const byMember = new Map<string, FinanceInvoice[]>()
    const open = new Map<string, number>()
    for (const inv of invoices) {
      if (inv.member == null) continue
      const key = String(inv.member)
      ;(byMember.get(key) ?? byMember.set(key, []).get(key)!).push(inv)
      if (isOpenInvoice(inv)) open.set(key, (open.get(key) ?? 0) + toNum(inv.open_amount))
    }
    return { invoicesByMember: byMember, openByMember: open }
  }, [invoices])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return members.filter((m) => {
      if (onlyActive && !m.kscw_membership_active) return false
      if (onlyOpen && !((openByMember.get(String(m.id)) ?? 0) > 0.005)) return false
      if (sport !== 'all' && sportOf(m) !== sport) return false
      if (!q) return true
      return (
        fullName(m).toLowerCase().includes(q) ||
        (m.email ?? '').toLowerCase().includes(q) ||
        (m.beitragskategorie ?? '').toLowerCase().includes(q) ||
        String(m.number ?? '').includes(q)
      )
    })
  }, [members, query, onlyActive, onlyOpen, sport, openByMember])

  const selected = selectedId ? members.find((m) => String(m.id) === selectedId) ?? null : null

  if (selected) {
    return (
      <MemberDetail
        key={selected.id}
        member={selected}
        invoices={invoicesByMember.get(String(selected.id)) ?? []}
        documents={documents}
        canEdit={canEditFinance}
        onBack={() => setSelectedId(null)}
        onSaved={() => { qc.invalidateQueries({ queryKey: ['finance', 'members'] }) }}
        onDocsChanged={() => { qc.invalidateQueries({ queryKey: ['finance', 'invoice-documents'] }) }}
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('memberExplorerSearch')}
            className="w-full rounded-md border border-gray-200 bg-transparent py-2 pl-8 pr-3 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
          />
        </div>
        <button
          onClick={() => setOnlyActive((v) => !v)}
          className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${onlyActive ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300' : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300'}`}
        >{t('filterActive')}</button>
        <button
          onClick={() => setOnlyOpen((v) => !v)}
          className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${onlyOpen ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300'}`}
        >{t('filterWithOpen')}</button>
        {(['volleyball', 'basketball'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSport((v) => (v === s ? 'all' : s))}
            className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${sport === s ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300' : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300'}`}
          >{s === 'volleyball' ? t('divVb') : t('divBb')}</button>
        ))}
      </div>

      {isLoading ? (
        <div className="py-12 text-center text-sm text-gray-500 dark:text-gray-400"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 py-12 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">{t('noMembers')}</div>
      ) : (
        <>
          <p className="text-xs text-gray-400 dark:text-gray-500">{t('memberCount', { count: filtered.length })}</p>
          <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
            <Table>
              <TableHeader>
                <TableRow className="border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/40">
                  <TableHead className="text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('colMember')}</TableHead>
                  <TableHead className="hidden sm:table-cell text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('colSport')}</TableHead>
                  <TableHead className="hidden sm:table-cell text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('colCategory')}</TableHead>
                  <TableHead className="text-right text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">{t('colOpen')}</TableHead>
                  <TableHead className="w-8" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((m) => {
                  const open = openByMember.get(String(m.id)) ?? 0
                  return (
                    <TableRow
                      key={m.id}
                      onClick={() => setSelectedId(String(m.id))}
                      className="cursor-pointer border-gray-200 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700/40"
                    >
                      <TableCell className="min-h-[44px] whitespace-normal break-words">
                        <span className="font-medium text-gray-900 dark:text-gray-100">{fullName(m)}</span>
                        {m.billing_different && <span className="ml-1.5 align-middle text-xs text-gray-400" title={t('billingSeparate')}>·  {t('billingSeparate')}</span>}
                        <span className="mt-0.5 block text-xs text-gray-400 sm:hidden">{[m.sektion, m.beitragskategorie].filter(Boolean).join(' · ')}{m.kscw_membership_active ? '' : ` · ${t('membershipInactive')}`}</span>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell text-gray-600 dark:text-gray-400">{m.sektion || '—'}</TableCell>
                      <TableCell className="hidden sm:table-cell text-gray-600 dark:text-gray-400">{m.beitragskategorie || '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {open > 0.005 ? <span className="font-semibold text-amber-700 dark:text-amber-400">{formatChf(open)}</span> : <span className="text-gray-400">—</span>}
                      </TableCell>
                      <TableCell className="text-gray-300 dark:text-gray-600"><ChevronRight className="h-4 w-4" /></TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  )
}
