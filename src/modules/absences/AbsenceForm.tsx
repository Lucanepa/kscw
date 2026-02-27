import { useState, useEffect } from 'react'
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
      setValidationError('Startdatum ist erforderlich')
      return
    }
    if (!endDate) {
      setValidationError('Enddatum ist erforderlich')
      return
    }
    if (endDate < startDate) {
      setValidationError('Enddatum muss nach dem Startdatum liegen')
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
      setValidationError('Fehler beim Speichern')
    }
  }

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={absence ? 'Absenz bearbeiten' : 'Neue Absenz'}
      size="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {isCoach && (
          <div>
            <label className="block text-sm font-medium text-gray-700">Mitglied</label>
            <select
              value={memberId}
              onChange={(e) => setMemberId(e.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
            >
              <option value="">Auswählen...</option>
              {allMembers.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">Von</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => {
                setStartDate(e.target.value)
                if (!endDate || endDate < e.target.value) setEndDate(e.target.value)
              }}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Bis</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              min={startDate}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">Grund</label>
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value as Absence['reason'])}
            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
          >
            <option value="injury">Verletzung</option>
            <option value="vacation">Ferien</option>
            <option value="work">Arbeit</option>
            <option value="personal">Persönlich</option>
            <option value="other">Anderes</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">Details (optional)</label>
          <textarea
            value={reasonDetail}
            onChange={(e) => setReasonDetail(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
            placeholder="Zusätzliche Informationen..."
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">Betrifft</label>
          <div className="mt-2 flex gap-4">
            {(['trainings', 'games', 'all'] as const).map((value) => (
              <label key={value} className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={affects.includes(value)}
                  onChange={() => toggleAffect(value)}
                  className="rounded border-gray-300"
                />
                {value === 'trainings' ? 'Trainings' : value === 'games' ? 'Spiele' : 'Alles'}
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
            className="rounded-lg px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100"
          >
            Abbrechen
          </button>
          <button
            type="submit"
            disabled={isLoading}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {isLoading ? 'Speichern...' : 'Speichern'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
