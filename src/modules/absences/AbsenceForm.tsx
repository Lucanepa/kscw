import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../../components/Modal'
import { useAuth } from '../../hooks/useAuth'
import { useMutation } from '../../hooks/useMutation'
import { usePB } from '../../hooks/usePB'
import type { Absence, Member } from '../../types'

interface AbsenceFormProps {
  open: boolean
  absence?: Absence | null
  onSave: () => void
  onCancel: () => void
}

export default function AbsenceForm({ open, absence, onSave, onCancel }: AbsenceFormProps) {
  const { t } = useTranslation('absences')
  const { user, isCoach } = useAuth()
  const { create, update, isLoading } = useMutation<Absence>('absences')
  const { data: allMembers } = usePB<Member>('members', {
    filter: 'active=true',
    sort: 'name',
    perPage: 500,
  })

  const [memberId, setMemberId] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [reason, setReason] = useState<Absence['reason']>('other')
  const [reasonDetail, setReasonDetail] = useState('')
  const [affects, setAffects] = useState<string[]>(['all'])
  const [validationError, setValidationError] = useState('')

  useEffect(() => {
    if (absence) {
      setMemberId(absence.member)
      setStartDate(absence.start_date.split(' ')[0])
      setEndDate(absence.end_date.split(' ')[0])
      setReason(absence.reason)
      setReasonDetail(absence.reason_detail)
      setAffects(absence.affects ?? ['all'])
    } else {
      setMemberId(user?.id ?? '')
      setStartDate('')
      setEndDate('')
      setReason('other')
      setReasonDetail('')
      setAffects(['all'])
    }
    setValidationError('')
  }, [absence, user, open])

  function toggleAffect(value: string) {
    setAffects((prev) =>
      prev.includes(value) ? prev.filter((a) => a !== value) : [...prev, value],
    )
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setValidationError('')

    if (!startDate) {
      setValidationError(t('startDateRequired'))
      return
    }
    if (!endDate) {
      setValidationError(t('endDateRequired'))
      return
    }
    if (endDate < startDate) {
      setValidationError(t('endAfterStart'))
      return
    }

    const data = {
      member: memberId || user?.id,
      start_date: startDate,
      end_date: endDate,
      reason,
      reason_detail: reasonDetail,
      affects,
      approved: false,
    }

    try {
      if (absence) {
        await update(absence.id, data)
      } else {
        await create(data)
      }
      onSave()
    } catch {
      setValidationError(t('errorSaving'))
    }
  }

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={absence ? t('editAbsenceTitle') : t('newAbsenceTitle')}
      size="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {isCoach && (
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{t('member')}</label>
            <select
              value={memberId}
              onChange={(e) => setMemberId(e.target.value)}
              className="mt-1 w-full rounded-lg border dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none"
            >
              <option value="">{t('common:select')}</option>
              {allMembers.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{t('startDate')}</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => {
                setStartDate(e.target.value)
                if (!endDate || endDate < e.target.value) setEndDate(e.target.value)
              }}
              className="mt-1 w-full rounded-lg border dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{t('endDate')}</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              min={startDate}
              className="mt-1 w-full rounded-lg border dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{t('reason')}</label>
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value as Absence['reason'])}
            className="mt-1 w-full rounded-lg border dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none"
          >
            <option value="injury">{t('reasonInjury')}</option>
            <option value="vacation">{t('reasonVacation')}</option>
            <option value="work">{t('reasonWork')}</option>
            <option value="personal">{t('reasonPersonal')}</option>
            <option value="other">{t('reasonOther')}</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{t('detailsOptional')}</label>
          <textarea
            value={reasonDetail}
            onChange={(e) => setReasonDetail(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded-lg border dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none"
            placeholder={t('detailsPlaceholder')}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{t('affects')}</label>
          <div className="mt-2 flex gap-4">
            {(['trainings', 'games', 'all'] as const).map((value) => (
              <label key={value} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={affects.includes(value)}
                  onChange={() => toggleAffect(value)}
                  className="rounded border-gray-300 dark:border-gray-600"
                />
                {value === 'trainings' ? t('affectsTrainings') : value === 'games' ? t('affectsGames') : t('affectsAll')}
              </label>
            ))}
          </div>
        </div>

        {validationError && (
          <p className="text-sm text-red-600">{validationError}</p>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            {t('common:cancel')}
          </button>
          <button
            type="submit"
            disabled={isLoading}
            className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {isLoading ? t('common:saving') : t('common:save')}
          </button>
        </div>
      </form>
    </Modal>
  )
}
