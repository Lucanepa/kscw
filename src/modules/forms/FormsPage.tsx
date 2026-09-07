import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Plus, Pencil, BarChart3, Trash2, Lock, Unlock, Link as LinkIcon, Globe } from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { useAdminMode } from '../../hooks/useAdminMode'
import { useCollection } from '../../lib/query'
import { useFillableForms, type FillableForm } from '../../hooks/useFillableForms'
import { updateRecord, deleteRecord } from '../../lib/api'
import { formatDateTimeCompactZurich } from '../../utils/dateHelpers'
import { useConfirm } from '../../components/ConfirmProvider'
import { useReportPageLoading } from '../../hooks/usePageReady'
import FormFillModal from './FormFillModal'
import FormResponsesModal from './FormResponsesModal'
import { TourPageButton } from '../guide/TourPageButton'
import type { FormDef, FormStatus } from './types'

function teamRefs(form: FormDef): { id: string; name: string; sport?: string }[] {
  return (form.teams ?? []).map((tref) => {
    if (typeof tref === 'object' && tref !== null && 'teams_id' in tref) {
      const tid = (tref as { teams_id: unknown }).teams_id
      if (typeof tid === 'object' && tid !== null) {
        const o = tid as { id: string | number; name?: string; sport?: string }
        return { id: String(o.id), name: o.name ?? String(o.id), sport: o.sport }
      }
      return { id: String(tid), name: String(tid) }
    }
    return { id: String(tref), name: String(tref) }
  })
}

function StatusBadge({ status }: { status: FormStatus }) {
  const { t } = useTranslation('forms')
  const cls =
    status === 'open'
      ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
      : status === 'closed'
        ? 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
        : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{t(`status${status[0].toUpperCase()}${status.slice(1)}`)}</span>
}

export default function FormsPage() {
  const { t } = useTranslation('forms')
  const { t: tc } = useTranslation('common')
  const confirm = useConfirm()
  const navigate = useNavigate()
  const { user, coachTeamIds, teamResponsibleIds, isAdmin, isVorstand, isVbAdmin, isBbAdmin } = useAuth()
  const { effectiveIsAdmin, effectiveIsVorstand } = useAdminMode()
  // Authoring is role-gated (see Layout) — members never reach this page via nav,
  // they fill forms from the Home card. Coaches/TRs/Sport Admins/Vorstand/Admins.
  const canManageForms = isAdmin || isVorstand || coachTeamIds.length > 0 || teamResponsibleIds.length > 0
  // Full managers (global admin + Vorstand) manage every form incl. club-wide.
  const fullManager = effectiveIsAdmin || effectiveIsVorstand

  const { data: formsRaw, isLoading, refetch } = useCollection<FormDef>('forms', {
    fields: ['*', 'teams.teams_id.id', 'teams.teams_id.name', 'teams.teams_id.sport'],
    sort: ['-date_created'],
    limit: 200,
  })
  const forms = formsRaw ?? []

  // Forms the current user can fill / edit (club-wide ∪ their player teams).
  const { items: fillable, isLoading: fillableLoading, refetch: refetchFillable } = useFillableForms()

  // Gate the whole page on BOTH primary data sources (managed forms + "open for
  // you") so neither table pops in after the other.
  const pageLoading = isLoading || fillableLoading

  const editable = (f: FormDef): boolean => {
    if (fullManager) return true
    const teams = teamRefs(f)
    // Sport Admin: only team-scoped forms whose targeted teams are ALL in their
    // sport. Club-wide (cross-sport) forms stay with full managers.
    if (
      (isVbAdmin || isBbAdmin) &&
      f.audience === 'teams' &&
      teams.length > 0 &&
      teams.every((tr) => (tr.sport === 'volleyball' ? isVbAdmin : tr.sport === 'basketball' ? isBbAdmin : false))
    ) {
      return true
    }
    // Coach/TR: any targeted team they lead, or forms they created themselves.
    const myLeaderTeams = new Set<string>([...coachTeamIds, ...teamResponsibleIds])
    if (teams.some((tr) => myLeaderTeams.has(tr.id))) return true
    return String(f.created_by ?? '') === String(user?.id ?? '')
  }

  const managedForms = useMemo(() => (canManageForms ? forms.filter(editable) : []), [forms, canManageForms]) // eslint-disable-line react-hooks/exhaustive-deps

  const [fillItem, setFillItem] = useState<FillableForm | null>(null)
  const [responsesForm, setResponsesForm] = useState<FormDef | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  async function toggleStatus(f: FormDef) {
    const next: FormStatus = f.status === 'open' ? 'closed' : 'open'
    await updateRecord('forms', f.id, { status: next })
    refetch()
  }
  async function remove(f: FormDef) {
    if (!(await confirm({ message: t('confirmDelete', { title: f.title }), danger: true }))) return
    await deleteRecord('forms', f.id)
    refetch()
  }
  async function copyPublicLink(f: FormDef) {
    if (!f.slug) return
    const url = `${window.location.origin}/f/${f.slug}`
    try {
      await navigator.clipboard.writeText(url)
      setCopiedId(String(f.id))
      setTimeout(() => setCopiedId((c) => (c === String(f.id) ? null : c)), 2000)
    } catch { /* clipboard blocked — no-op */ }
  }

  // Report to app boot gate — see usePageReady.tsx
  useReportPageLoading(pageLoading)

  if (pageLoading) return null

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-4 py-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <TourPageButton />
        </div>
        {canManageForms && (
          <Button data-tour="forms-create" onClick={() => navigate('/forms/new')}>
            <Plus size={16} className="mr-1" /> {t('newForm')}
          </Button>
        )}
      </div>

      {/* Open for you */}
      <section data-tour="forms-list" className="space-y-3">
        <h2 className="text-lg font-semibold">{t('openForYou')}</h2>
        {fillable.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noOpenForms')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('formTitle')}</TableHead>
                <TableHead className="hidden sm:table-cell">{t('closesAt')}</TableHead>
                <TableHead className="text-right">{t('actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {fillable.map((item) => (
                <TableRow key={item.form.id}>
                  <TableCell className="font-medium">{item.form.title}</TableCell>
                  <TableCell className="hidden text-sm text-muted-foreground sm:table-cell">
                    {item.form.closes_at ? formatDateTimeCompactZurich(item.form.closes_at) : '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button data-tour="forms-fill" size="sm" variant={item.submission ? 'outline' : 'default'} onClick={() => setFillItem(item)}>
                      {item.submission ? t('edit') : t('fill')}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      {/* Manage */}
      {canManageForms && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">{t('manageForms')}</h2>
          {managedForms.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noManagedForms')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('formTitle')}</TableHead>
                  <TableHead>{t('status')}</TableHead>
                  <TableHead className="hidden sm:table-cell">{t('audience')}</TableHead>
                  <TableHead className="text-right">{t('actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {managedForms.map((f) => {
                  const teams = teamRefs(f)
                  return (
                    <TableRow key={f.id}>
                      <TableCell className="font-medium">
                        <span className="flex items-center gap-1.5">
                          {f.title}
                          {f.is_public && (
                            <span className="inline-flex items-center gap-0.5 rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" title={t('isPublicHint')}>
                              <Globe size={10} /> {t('publicBadge')}
                            </span>
                          )}
                        </span>
                      </TableCell>
                      <TableCell><StatusBadge status={f.status} /></TableCell>
                      <TableCell className="hidden text-sm text-muted-foreground sm:table-cell">
                        {f.audience === 'club_wide' ? t('audienceClub') : teams.map((tr) => tr.name).join(', ') || t('audienceTeams')}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col justify-end gap-1 sm:flex-row">
                          {f.is_public && f.slug && (
                            <Button variant="ghost" size="sm" onClick={() => copyPublicLink(f)} title={t('copyLink')}>
                              <LinkIcon size={15} className={copiedId === String(f.id) ? 'text-green-600 dark:text-green-400' : ''} />
                            </Button>
                          )}
                          <Button variant="ghost" size="sm" onClick={() => setResponsesForm(f)} title={t('responses')}><BarChart3 size={15} /></Button>
                          <Button variant="ghost" size="sm" onClick={() => navigate(`/forms/${f.id}/edit`)} title={tc('edit')}><Pencil size={15} /></Button>
                          <Button variant="ghost" size="sm" onClick={() => toggleStatus(f)} title={f.status === 'open' ? t('close') : t('open')}>
                            {f.status === 'open' ? <Lock size={15} /> : <Unlock size={15} />}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => remove(f)} title={tc('delete')} className="text-red-500"><Trash2 size={15} /></Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </section>
      )}

      {fillItem && (
        <FormFillModal
          open={!!fillItem}
          form={fillItem.form}
          existing={fillItem.submission}
          onSubmitted={() => { setFillItem(null); refetchFillable() }}
          onCancel={() => setFillItem(null)}
        />
      )}
      {responsesForm && (
        <FormResponsesModal open={!!responsesForm} form={responsesForm} onClose={() => setResponsesForm(null)} />
      )}
    </div>
  )
}
