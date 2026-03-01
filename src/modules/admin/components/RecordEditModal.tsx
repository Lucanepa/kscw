import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { RecordModel } from 'pocketbase'
import pb from '../../../pb'
import Modal from '../../../components/Modal'
import ConfirmDialog from '../../../components/ConfirmDialog'

interface SchemaField {
  id: string
  name: string
  type: string
  required: boolean
  options: Record<string, unknown>
}

interface RecordEditModalProps {
  open: boolean
  onClose: () => void
  collection: string
  schema: SchemaField[]
  record?: RecordModel | null
  onSaved: () => void
}

const inputClass =
  'mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100'

export default function RecordEditModal({
  open,
  onClose,
  collection,
  schema,
  record,
  onSaved,
}: RecordEditModalProps) {
  const { t } = useTranslation('admin')
  const isEdit = !!record
  const [formData, setFormData] = useState<Record<string, unknown>>({})
  const [fileFields, setFileFields] = useState<Record<string, File | null>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  // Initialize form data when record or schema changes
  useEffect(() => {
    if (!open) return
    const data: Record<string, unknown> = {}
    for (const field of schema) {
      if (field.type === 'file') continue // files handled separately
      data[field.name] = record ? record[field.name] ?? '' : ''
    }
    setFormData(data)
    setFileFields({})
    setError(null)
  }, [open, record, schema])

  const setField = (name: string, value: unknown) => {
    setFormData((prev) => ({ ...prev, [name]: value }))
  }

  const handleSave = async () => {
    setLoading(true)
    setError(null)
    try {
      // Check if we have file fields
      const hasFiles = Object.values(fileFields).some((f) => f !== null)

      if (hasFiles) {
        const fd = new FormData()
        for (const [key, value] of Object.entries(formData)) {
          if (value !== undefined && value !== null) {
            fd.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
          }
        }
        for (const [key, file] of Object.entries(fileFields)) {
          if (file) fd.append(key, file)
        }
        if (isEdit) {
          await pb.collection(collection).update(record!.id, fd)
        } else {
          await pb.collection(collection).create(fd)
        }
      } else {
        // Clean up data — convert empty strings to null for optional fields
        const cleanData: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(formData)) {
          const field = schema.find((f) => f.name === key)
          if (field?.type === 'number' && value !== '' && value !== null) {
            cleanData[key] = Number(value)
          } else if (field?.type === 'bool') {
            cleanData[key] = Boolean(value)
          } else if (field?.type === 'json' && typeof value === 'string' && value) {
            try {
              cleanData[key] = JSON.parse(value)
            } catch {
              cleanData[key] = value
            }
          } else {
            cleanData[key] = value
          }
        }
        if (isEdit) {
          await pb.collection(collection).update(record!.id, cleanData)
        } else {
          await pb.collection(collection).create(cleanData)
        }
      }
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async () => {
    if (!record) return
    setLoading(true)
    try {
      await pb.collection(collection).delete(record.id)
      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setLoading(false)
    }
  }

  const renderField = (field: SchemaField) => {
    const value = formData[field.name]

    switch (field.type) {
      case 'text':
      case 'url':
      case 'editor':
        return (
          <input
            type="text"
            value={String(value ?? '')}
            onChange={(e) => setField(field.name, e.target.value)}
            className={inputClass}
          />
        )
      case 'email':
        return (
          <input
            type="email"
            value={String(value ?? '')}
            onChange={(e) => setField(field.name, e.target.value)}
            className={inputClass}
          />
        )
      case 'number':
        return (
          <input
            type="number"
            value={value === '' || value === null || value === undefined ? '' : String(value)}
            onChange={(e) => setField(field.name, e.target.value)}
            className={inputClass}
          />
        )
      case 'bool':
        return (
          <label className="mt-1 flex items-center gap-2">
            <input
              type="checkbox"
              checked={Boolean(value)}
              onChange={(e) => setField(field.name, e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
            />
            <span className="text-sm text-gray-600 dark:text-gray-400">
              {Boolean(value) ? 'true' : 'false'}
            </span>
          </label>
        )
      case 'date':
      case 'autodate':
        return (
          <input
            type="datetime-local"
            value={String(value ?? '').slice(0, 16)}
            onChange={(e) => setField(field.name, e.target.value)}
            className={inputClass}
          />
        )
      case 'select': {
        const options = (field.options?.values as string[]) || []
        const maxSelect = (field.options?.maxSelect as number) || 1
        if (maxSelect > 1) {
          // Multi-select: render as checkboxes
          const selected = Array.isArray(value) ? (value as string[]) : []
          return (
            <div className="mt-1 flex flex-wrap gap-2">
              {options.map((opt) => (
                <label key={opt} className="flex items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.includes(opt)}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...selected, opt]
                        : selected.filter((s) => s !== opt)
                      setField(field.name, next)
                    }}
                    className="h-4 w-4 rounded border-gray-300 text-brand-600"
                  />
                  <span className="text-gray-700 dark:text-gray-300">{opt}</span>
                </label>
              ))}
            </div>
          )
        }
        return (
          <select
            value={String(value ?? '')}
            onChange={(e) => setField(field.name, e.target.value)}
            className={inputClass}
          >
            <option value="">–</option>
            {options.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        )
      }
      case 'json':
        return (
          <textarea
            value={
              typeof value === 'object' && value !== null
                ? JSON.stringify(value, null, 2)
                : String(value ?? '')
            }
            onChange={(e) => setField(field.name, e.target.value)}
            rows={4}
            className={`${inputClass} font-mono`}
          />
        )
      case 'relation':
        return (
          <input
            type="text"
            value={
              Array.isArray(value) ? (value as string[]).join(', ') : String(value ?? '')
            }
            onChange={(e) => {
              const maxSelect = (field.options?.maxSelect as number) || 1
              if (maxSelect > 1) {
                setField(
                  field.name,
                  e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                )
              } else {
                setField(field.name, e.target.value.trim())
              }
            }}
            placeholder="Record ID(s)"
            className={inputClass}
          />
        )
      case 'file':
        return (
          <div className="mt-1">
            {isEdit && record?.[field.name] && (
              <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">
                {Array.isArray(record[field.name])
                  ? (record[field.name] as string[]).join(', ')
                  : String(record[field.name])}
              </p>
            )}
            <input
              type="file"
              onChange={(e) =>
                setFileFields((prev) => ({ ...prev, [field.name]: e.target.files?.[0] ?? null }))
              }
              className="text-sm text-gray-700 dark:text-gray-300"
            />
          </div>
        )
      default:
        return (
          <input
            type="text"
            value={String(value ?? '')}
            onChange={(e) => setField(field.name, e.target.value)}
            className={inputClass}
          />
        )
    }
  }

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={isEdit ? `${t('editRecord')} — ${record?.id}` : t('createRecord')}
        size="lg"
      >
        <div className="space-y-4">
          {schema.map((field) => (
            <div key={field.id}>
              <label className="block text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                {field.name}
                {field.required && <span className="ml-1 text-red-500">*</span>}
                <span className="ml-2 font-normal normal-case text-gray-400">{field.type}</span>
              </label>
              {renderField(field)}
            </div>
          ))}

          {/* Error */}
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-between pt-2">
            <div>
              {isEdit && (
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  className="min-h-[44px] rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 sm:min-h-0"
                >
                  {t('deleteRecord')}
                </button>
              )}
            </div>
            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="min-h-[44px] rounded-lg px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 sm:min-h-0 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                {t('cancel')}
              </button>
              <button
                onClick={handleSave}
                disabled={loading}
                className="min-h-[44px] rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50 sm:min-h-0"
              >
                {loading ? '...' : t('save')}
              </button>
            </div>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={handleDelete}
        title={t('deleteRecord')}
        message={t('deleteRecordMessage')}
        danger
      />
    </>
  )
}
