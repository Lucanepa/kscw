import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../../../components/Modal'
import pb from '../../../pb'
import type { Hall, HallClosure } from '../../../types'

interface ClosureManagerProps {
  halls: Hall[]
  closures: HallClosure[]
  onClose: () => void
  onChanged: () => void
}

const emptyForm: {
  hall: string
  start_date: string
  end_date: string
  reason: string
  source: HallClosure['source']
} = {
  hall: '',
  start_date: '',
  end_date: '',
  reason: '',
  source: 'admin',
}

export default function ClosureManager({ halls, closures, onClose, onChanged }: ClosureManagerProps) {
  const { t } = useTranslation('hallenplan')

  const SOURCE_OPTIONS = [
    { value: 'hauswart', label: t('sourceCaretaker') },
    { value: 'admin', label: t('sourceAdmin') },
    { value: 'auto', label: t('sourceAutomatic') },
  ]

  const [form, setForm] = useState(emptyForm)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function startEdit(closure: HallClosure) {
    setEditingId(closure.id)
    setForm({
      hall: closure.hall,
      start_date: closure.start_date.split(' ')[0],
      end_date: closure.end_date.split(' ')[0],
      reason: closure.reason,
      source: closure.source,
    })
  }

  function cancelEdit() {
    setEditingId(null)
    setForm(emptyForm)
    setError(null)
  }

  async function handleSave() {
    if (!form.hall || !form.start_date || !form.end_date || !form.reason) {
      setError(t('common:required'))
      return
    }
    if (form.start_date > form.end_date) {
      setError(t('common:endAfterStart'))
      return
    }

    setIsSaving(true)
    setError(null)
    try {
      if (editingId) {
        await pb.collection('hall_closures').update(editingId, form)
      } else {
        await pb.collection('hall_closures').create(form)
      }
      setForm(emptyForm)
      setEditingId(null)
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common:errorSaving'))
    } finally {
      setIsSaving(false)
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm(t('deleteClosureConfirm'))) return
    try {
      await pb.collection('hall_closures').delete(id)
      if (editingId === id) cancelEdit()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common:errorSaving'))
    }
  }

  function formatDateDisplay(dateStr: string): string {
    if (!dateStr) return ''
    const [y, m, d] = dateStr.split('T')[0].split('-')
    return `${m}/${d}/${y}`
  }

  function getHallName(hallId: string): string {
    return halls.find((h) => h.id === hallId)?.name ?? hallId
  }

  return (
    <Modal open onClose={onClose} title={t('closuresTitle')} size="lg">
      <div className="space-y-6">
        {/* Existing closures */}
        {closures.length > 0 ? (
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('currentClosures')}</h3>
            <div className="divide-y rounded-md border">
              {closures.map((closure) => (
                <div key={closure.id} className="flex items-center justify-between p-3">
                  <div className="text-sm">
                    <span className="font-medium">{getHallName(closure.hall)}</span>
                    <span className="mx-2 text-gray-400">|</span>
                    <span>{formatDateDisplay(closure.start_date)} – {formatDateDisplay(closure.end_date)}</span>
                    <span className="mx-2 text-gray-400">|</span>
                    <span className="text-gray-600 dark:text-gray-400">{closure.reason}</span>
                    <span className="ml-2 inline-flex rounded-full bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-xs text-gray-500 dark:text-gray-400">
                      {closure.source}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => startEdit(closure)}
                      className="min-h-[44px] rounded px-3 py-2 text-sm text-brand-600 hover:bg-brand-50 hover:text-brand-700 sm:min-h-0 sm:py-1"
                    >
                      {t('common:edit')}
                    </button>
                    <button
                      onClick={() => handleDelete(closure.id)}
                      className="min-h-[44px] rounded px-3 py-2 text-sm text-red-600 hover:bg-red-50 hover:text-red-800 sm:min-h-0 sm:py-1"
                    >
                      {t('common:delete')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-500 dark:text-gray-400">{t('noClosures')}</p>
        )}

        {/* Add/edit form */}
        <div className="space-y-4 rounded-lg border bg-gray-50 dark:bg-gray-900 p-4">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {editingId ? t('editClosure') : t('addNewClosure')}
          </h3>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">{t('hall')}</label>
              <select
                value={form.hall}
                onChange={(e) => update('hall', e.target.value)}
                className="w-full rounded-md border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                <option value="">{t('selectPlaceholder')}</option>
                {halls.map((h) => (
                  <option key={h.id} value={h.id}>{h.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">{t('source')}</label>
              <select
                value={form.source}
                onChange={(e) => update('source', e.target.value as typeof form.source)}
                className="w-full rounded-md border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                {SOURCE_OPTIONS.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">{t('common:from')}</label>
              <input
                type="date"
                value={form.start_date}
                onChange={(e) => update('start_date', e.target.value)}
                className="w-full rounded-md border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">{t('common:to')}</label>
              <input
                type="date"
                value={form.end_date}
                onChange={(e) => update('end_date', e.target.value)}
                className="w-full rounded-md border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">{t('common:reason')}</label>
            <input
              type="text"
              value={form.reason}
              onChange={(e) => update('reason', e.target.value)}
              placeholder="e.g. Holidays, maintenance, renovation"
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="flex gap-3">
            {editingId && (
              <button
                onClick={cancelEdit}
                className="rounded-md border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                {t('common:cancel')}
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="rounded-md bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
            >
              {isSaving ? t('common:saving') : editingId ? t('common:update') : t('common:add')}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
