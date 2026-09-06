import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { FormInput, FormTextarea, FormField } from '@/components/FormField'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import LocationCombobox from '@/components/LocationCombobox'
import { cn } from '@/lib/utils'
import { logActivity } from '../../utils/logActivity'
import { useConfirm } from '../../components/ConfirmProvider'
import { useCollection } from '../../lib/query'
import { useReportPageLoading } from '../../hooks/usePageReady'
import type { Hall } from '../../types'
import { createRecord, deleteRecord, updateRecord, countItems } from '../../lib/api'

const EMPTY_HALLS: Hall[] = []

const emptyForm = {
  name: '',
  address: '',
  city: '',
  courts: '',
  maps_url: '',
  notes: '',
  homologation: false,
}

/**
 * Halls — the venue register every hall slot, training and home game points at.
 *
 * Its own page rather than a Directus-only collection: a hall has to exist
 * before a slot can be created in it, and before a slot exists there is no
 * recurring training to generate. Without this the only way to add a venue was
 * the Directus admin UI, which coaches and sport admins do not have.
 *
 * Mounted at /admin/hallenplan/halls (member app) and
 * /admin/terminplanung/halls (scheduling app) — hence `navigate(-1)` for back.
 */
export default function HallsPage() {
  const { t } = useTranslation('hallenplan')
  const navigate = useNavigate()
  const confirm = useConfirm()

  const { data: hallsRaw, isLoading, refetch } = useCollection<Hall>('halls', {
    sort: ['name'],
    limit: 200,
    fields: ['id', 'name', 'address', 'city', 'courts', 'maps_url', 'notes', 'homologation'],
  })
  const halls = hallsRaw ?? EMPTY_HALLS

  useReportPageLoading(isLoading)

  const [form, setForm] = useState(emptyForm)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const [countingId, setCountingId] = useState<string | null>(null)
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const formRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => () => { if (highlightTimer.current) clearTimeout(highlightTimer.current) }, [])

  function flashRow(id: string) {
    setHighlightId(id)
    if (highlightTimer.current) clearTimeout(highlightTimer.current)
    highlightTimer.current = setTimeout(() => setHighlightId(null), 5000)
  }

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function startEdit(hall: Hall) {
    setEditingId(hall.id)
    setForm({
      name: hall.name ?? '',
      address: hall.address ?? '',
      city: hall.city ?? '',
      courts: hall.courts == null ? '' : String(hall.courts),
      maps_url: hall.maps_url ?? '',
      notes: hall.notes ?? '',
      homologation: !!hall.homologation,
    })
    setError(null)
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function cancelEdit() {
    setEditingId(null)
    setForm(emptyForm)
    setError(null)
  }

  async function handleSave() {
    const name = form.name.trim()
    if (!name) {
      setError(t('hallNameRequired'))
      return
    }
    const payload = {
      name,
      address: form.address.trim() || null,
      city: form.city.trim() || null,
      courts: form.courts === '' ? null : Number(form.courts),
      maps_url: form.maps_url.trim() || null,
      notes: form.notes.trim() || null,
      homologation: form.homologation,
    }

    setIsSaving(true)
    setError(null)
    try {
      if (editingId) {
        await updateRecord('halls', editingId, payload)
        logActivity('update', 'halls', editingId, payload)
        flashRow(editingId)
      } else {
        const rec = await createRecord<{ id: string }>('halls', payload)
        logActivity('create', 'halls', rec.id, payload)
        flashRow(rec.id)
      }
      toast.success(t('hallSaved'))
      cancelEdit()
      refetch()
    } catch (err: unknown) {
      setError(errorMessage(err))
    } finally {
      setIsSaving(false)
    }
  }

  async function handleDelete(hall: Hall) {
    // Migration 353 made the delete cascade, so the DB no longer refuses. The
    // guardrail moved here: count what goes and what merely loses its venue,
    // and put both in the dialog. Deleting a hall silently takes the recurring
    // training plan of every team that trains in it, and that is not
    // recoverable from the app.
    setCountingId(hall.id)
    let impact = ''
    try {
      const [slots, closures, trainings, games] = await Promise.all([
        countItems('hall_slots', { hall: { _eq: hall.id } }),
        countItems('hall_closures', { hall: { _eq: hall.id } }),
        countItems('trainings', { hall: { _eq: hall.id } }),
        countItems('games', { hall: { _eq: hall.id } }),
      ])
      const removed: string[] = []
      if (slots) removed.push(t('hallImpactSlots', { count: slots }))
      if (closures) removed.push(t('hallImpactClosures', { count: closures }))
      const kept: string[] = []
      if (trainings) kept.push(t('hallImpactTrainings', { count: trainings }))
      if (games) kept.push(t('hallImpactGames', { count: games }))
      if (removed.length) impact += `\n\n${t('hallImpactRemoved')} ${removed.join(', ')}.`
      if (kept.length) impact += `\n${t('hallImpactKept')} ${kept.join(', ')}.`
    } catch {
      // A failed count must not block the delete — just confirm without the
      // detail rather than pretending the hall is unused.
      impact = `\n\n${t('hallImpactUnknown')}`
    } finally {
      setCountingId(null)
    }

    if (!(await confirm({ message: t('hallDeleteConfirm', { name: hall.name }) + impact, danger: true }))) return
    try {
      await deleteRecord('halls', hall.id)
      logActivity('delete', 'halls', hall.id)
      toast.success(t('hallDeleted'))
      if (editingId === hall.id) cancelEdit()
      refetch()
    } catch (err: unknown) {
      toast.error(errorMessage(err))
    }
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-4">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="mb-2 inline-flex min-h-[44px] items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('common:back')}
        </button>
        <h1 className="text-xl font-bold text-gray-900 sm:text-2xl dark:text-gray-100">{t('hallsTitle')}</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{t('hallsSubtitle')}</p>
      </div>

      {/* Add / edit form */}
      <div ref={formRef} className="mb-6 space-y-4 rounded-lg border border-gray-200 bg-white p-4 sm:p-6 dark:border-gray-700 dark:bg-gray-800">
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          {editingId ? t('editHall') : t('addNewHall')}
        </h2>

        <FormField label={t('hallName')} helperText={t('hallNameHint')}>
          <LocationCombobox
            value={form.name}
            onChange={(v) => update('name', v)}
            onSelect={(r) => {
              // A picked venue carries its own address — fill the rest in so the
              // register stays consistent with what the calendar links to.
              update('name', r.name)
              if (r.address) update('address', r.address)
              if (r.city) update('city', r.city)
            }}
            placeholder={t('hallNamePlaceholder')}
          />
        </FormField>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormInput
            label={t('hallAddress')}
            value={form.address}
            onChange={(e) => update('address', e.target.value)}
          />
          <FormInput
            label={t('hallCity')}
            value={form.city}
            onChange={(e) => update('city', e.target.value)}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormInput
            label={t('hallCourts')}
            type="number"
            min={0}
            value={form.courts}
            onChange={(e) => update('courts', e.target.value)}
          />
          <FormInput
            label={t('hallMapsUrl')}
            type="url"
            inputMode="url"
            placeholder="https://…"
            value={form.maps_url}
            onChange={(e) => update('maps_url', e.target.value)}
          />
        </div>

        <div className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
          <Switch
            checked={form.homologation}
            onCheckedChange={(checked) => update('homologation', checked)}
            className="mt-0.5"
          />
          <div>
            <span>{t('hallHomologation')}</span>
            <p className="text-xs text-muted-foreground">{t('hallHomologationHint')}</p>
          </div>
        </div>

        <FormTextarea
          label={t('notes')}
          rows={2}
          value={form.notes}
          onChange={(e) => update('notes', e.target.value)}
        />

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => { void handleSave() }} disabled={isSaving} loading={isSaving}>
            {editingId ? t('common:save') : t('addNewHall')}
          </Button>
          {editingId && (
            <Button variant="ghost" onClick={cancelEdit}>{t('common:cancel')}</Button>
          )}
        </div>
      </div>

      {/* List */}
      <div className="rounded-lg border border-gray-200 bg-white p-4 sm:p-6 dark:border-gray-700 dark:bg-gray-800">
        {isLoading ? (
          <p className="py-6 text-center text-sm text-gray-400 dark:text-gray-500">{t('common:loading')}</p>
        ) : halls.length === 0 ? (
          <p className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">{t('hallsEmpty')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('hallName')}</TableHead>
                <TableHead className="hidden sm:table-cell">{t('hallAddress')}</TableHead>
                <TableHead className="hidden md:table-cell">{t('hallCourts')}</TableHead>
                <TableHead className="hidden md:table-cell">{t('hallHomologation')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {halls.map((hall) => (
                <TableRow
                  key={hall.id}
                  className={cn(
                    'min-h-[44px]',
                    highlightId === hall.id && 'bg-green-50 dark:bg-green-900/20',
                  )}
                >
                  <TableCell className="whitespace-normal break-words font-medium">
                    {hall.name}
                    <span className="block text-xs text-gray-500 sm:hidden dark:text-gray-400">
                      {[hall.address, hall.city].filter(Boolean).join(', ')}
                    </span>
                  </TableCell>
                  <TableCell className="hidden whitespace-normal break-words text-gray-500 sm:table-cell dark:text-gray-400">
                    {[hall.address, hall.city].filter(Boolean).join(', ')}
                  </TableCell>
                  <TableCell className="hidden tabular-nums md:table-cell">{hall.courts ?? '—'}</TableCell>
                  <TableCell className="hidden md:table-cell">
                    <span
                      className={cn(
                        'inline-flex rounded-full px-2 py-0.5 text-xs',
                        hall.homologation
                          ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
                          : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
                      )}
                    >
                      {hall.homologation ? t('common:yes') : t('common:no')}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1 sm:flex-row">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => startEdit(hall)}
                        className="text-brand-600 hover:bg-brand-50 hover:text-brand-700 dark:hover:bg-gray-800"
                      >
                        {t('common:edit')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={countingId === hall.id}
                        loading={countingId === hall.id}
                        onClick={() => { void handleDelete(hall) }}
                        className="text-red-600 hover:bg-red-50 hover:text-red-800 dark:hover:bg-gray-800"
                      >
                        {t('common:delete')}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  const directus = (err as { errors?: { message?: string }[] })?.errors?.[0]?.message
  return directus ?? String(err)
}
