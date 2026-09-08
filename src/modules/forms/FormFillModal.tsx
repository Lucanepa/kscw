import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2 } from 'lucide-react'
import Modal from '@/components/Modal'
import { Button } from '@/components/ui/button'
import { useAuth } from '../../hooks/useAuth'
import { createRecord, updateRecord } from '../../lib/api'
import FormFieldRenderer from './FormFieldRenderer'
import { resolveFieldLabel } from './labels'
import type { FormDef, FieldDef, AnswerValue } from './types'

interface ExistingSubmission {
  id: string
  answers: Record<string, AnswerValue>
}

interface Props {
  open: boolean
  form: FormDef
  /** When set, the modal edits this existing submission instead of creating one. */
  existing?: ExistingSubmission | null
  onSubmitted: () => void
  onCancel: () => void
}

function isMissing(field: FieldDef, v: AnswerValue): boolean {
  if (!field.required) return false
  switch (field.type) {
    case 'multi_choice':
      return !(Array.isArray(v) && v.length > 0)
    case 'file':
      return !(v && typeof v === 'object' && 'id' in v)
    case 'number':
      return v === null || v === undefined || (v as unknown) === ''
    case 'yes_no':
      return false // a boolean is always an answer
    default:
      return !v || (typeof v === 'string' && v.trim() === '')
  }
}

function blankAnswers(form: FormDef): Record<string, AnswerValue> {
  const a: Record<string, AnswerValue> = {}
  for (const f of form.fields) a[f.id] = f.type === 'multi_choice' ? [] : f.type === 'yes_no' ? false : null
  return a
}

export default function FormFillModal({ open, form, existing, onSubmitted, onCancel }: Props) {
  const { t, i18n } = useTranslation('forms')
  const { t: tc } = useTranslation('common')
  const { user } = useAuth()
  // Seeded from `existing` (edit) or blank (new). The modal is not remounted per
  // open, so the seed is re-applied whenever form/open/existing changes — a
  // reset-on-prop-change, done during render (React's adjust-state-during-render
  // pattern) on exactly the trigger the old effect used.
  const seedAnswers = (): Record<string, AnswerValue> =>
    existing ? { ...blankAnswers(form), ...existing.answers } : {}
  const [answers, setAnswers] = useState<Record<string, AnswerValue>>(seedAnswers)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(false)

  const isEdit = !!existing

  const [prevSeed, setPrevSeed] = useState({ form, open, existing })
  if (prevSeed.form !== form || prevSeed.open !== open || prevSeed.existing !== existing) {
    setPrevSeed({ form, open, existing })
    setAnswers(seedAnswers())
    setError('')
    setDone(false)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    const missing = form.fields.find((f) => isMissing(f, answers[f.id] ?? null))
    if (missing) {
      // Use the locale-resolved label (same one shown on the field), not the
      // raw base `label`, so the error names the field the user actually sees.
      setError(t('errorRequiredMissing', { field: resolveFieldLabel(missing, i18n.language) || missing.label }))
      return
    }
    // Deadline / status are enforced in Postgres by the BEFORE INSERT + BEFORE
    // UPDATE guards (migrations 086/088) — but a plpgsql RAISE reaches the
    // browser as Directus's opaque 500 "An unexpected error occurred.", so the
    // message-matching in the catch below can never recognise it. Check here so
    // a modal left open across the deadline (or opened from a stale list) shows
    // the real reason instead of the generic failure — and never fires a write
    // that is certain to 500 and land in Sentry as a server error.
    if (form.status !== 'open' || (form.closes_at && Date.now() > new Date(form.closes_at).getTime())) {
      setError(t('errorClosed'))
      return
    }
    setSaving(true)
    try {
      if (isEdit) {
        await updateRecord('form_submissions', existing.id, { answers })
      } else {
        await createRecord('form_submissions', {
          form: form.id,
          member: form.anonymous ? null : user?.id,
          answers,
        })
      }
      setDone(true)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/already submitted/i.test(msg)) setError(t('errorAlreadySubmitted'))
      else if (/not open|deadline/i.test(msg)) setError(t('errorClosed'))
      else if (/required field/i.test(msg)) setError(t('errorRequiredGeneric'))
      else setError(t('errorSubmit'))
    } finally {
      setSaving(false)
    }
  }

  // Success view — show the (optional) custom thank-you, then close or, for
  // multi-submission forms, offer to fill in another response.
  if (done) {
    return (
      <Modal open={open} onClose={onSubmitted} title={form.title} size="md">
        <div className="space-y-5 py-2 text-center">
          <CheckCircle2 className="mx-auto h-10 w-10 text-green-500" />
          <p className="whitespace-pre-line text-sm text-foreground">
            {form.success_message?.trim() || (isEdit ? t('saveSuccess') : t('submitSuccess'))}
          </p>
          <div className="flex justify-center gap-3">
            {form.allow_multiple && !isEdit && (
              <Button variant="outline" onClick={() => { setAnswers({}); setDone(false) }}>
                {t('submitAnother')}
              </Button>
            )}
            <Button onClick={onSubmitted}>{t('done')}</Button>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal open={open} onClose={onCancel} title={form.title} size="md">
      <form onSubmit={handleSubmit} className="space-y-4">
        {form.description && <p className="whitespace-pre-line text-sm text-muted-foreground">{form.description}</p>}
        {form.anonymous && (
          <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">{t('anonymousNotice')}</p>
        )}
        {form.fields.map((f) => (
          <FormFieldRenderer
            key={f.id}
            field={f}
            value={answers[f.id] ?? (f.type === 'multi_choice' ? [] : f.type === 'yes_no' ? false : '')}
            onChange={(v) => setAnswers((a) => ({ ...a, [f.id]: v }))}
          />
        ))}
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-3 pt-2">
          <Button variant="ghost" type="button" onClick={onCancel}>{tc('cancel')}</Button>
          <Button type="submit" loading={saving}>{saving ? tc('saving') : isEdit ? tc('save') : t('submit')}</Button>
        </div>
      </form>
    </Modal>
  )
}
