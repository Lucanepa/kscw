import { useState } from 'react'
import { useAuth } from '../../hooks/useAuth'
import { usePB } from '../../hooks/usePB'
import { useMutation } from '../../hooks/useMutation'
import { useRealtime } from '../../hooks/useRealtime'
import TeamFilter from '../../components/TeamFilter'
import EmptyState from '../../components/EmptyState'
import ConfirmDialog from '../../components/ConfirmDialog'
import AbsenceCard from './AbsenceCard'
import AbsenceForm from './AbsenceForm'
import TeamAbsenceView from './TeamAbsenceView'
import type { Absence, Member } from '../../types'

type AbsenceExpanded = Absence & { expand?: { member?: Member } }

export default function AbsencesPage() {
  const { user, isCoach } = useAuth()
  const [activeTab, setActiveTab] = useState<'mine' | 'team'>('mine')
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [editingAbsence, setEditingAbsence] = useState<Absence | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const { data: myAbsences, refetch } = usePB<AbsenceExpanded>('absences', {
    filter: user ? `member="${user.id}"` : '',
    sort: '-start_date',
    expand: 'member',
    perPage: 50,
  })

  const { remove } = useMutation<Absence>('absences')

  useRealtime('absences', () => refetch())

  async function handleDelete() {
    if (!deletingId) return
    await remove(deletingId)
    setDeletingId(null)
    refetch()
  }

  function handleEdit(absence: Absence) {
    setEditingAbsence(absence)
    setFormOpen(true)
  }

  function handleFormSave() {
    setFormOpen(false)
    setEditingAbsence(null)
    refetch()
  }

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Absenzen</h1>
          <p className="mt-1 text-sm text-gray-500">Zentrale Absenzenverwaltung</p>
        </div>
        <button
          onClick={() => {
            setEditingAbsence(null)
            setFormOpen(true)
          }}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Neue Absenz
        </button>
      </div>

      {/* Tabs (coach only) */}
      {isCoach && (
        <div className="mt-6">
          <div className="flex gap-1 rounded-lg bg-gray-100 p-1">
            <button
              onClick={() => setActiveTab('mine')}
              className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === 'mine' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Meine Absenzen
            </button>
            <button
              onClick={() => setActiveTab('team')}
              className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === 'team' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Team-Absenzen
            </button>
          </div>
        </div>
      )}

      {/* Content */}
      {activeTab === 'mine' || !isCoach ? (
        <div className="mt-6">
          {myAbsences.length === 0 ? (
            <EmptyState
              icon="📋"
              title="Keine Absenzen"
              description="Du hast keine gemeldeten Absenzen."
            />
          ) : (
            <div className="space-y-3">
              {myAbsences.map((a) => (
                <AbsenceCard
                  key={a.id}
                  absence={a}
                  onEdit={handleEdit}
                  onDelete={setDeletingId}
                  canEdit={a.member === user?.id || isCoach}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="mt-6">
          <TeamFilter selected={selectedTeam} onChange={setSelectedTeam} />
          {selectedTeam ? (
            <div className="mt-4">
              <TeamAbsenceView teamId={selectedTeam} />
            </div>
          ) : (
            <div className="mt-4">
              <EmptyState
                icon="👥"
                title="Team auswählen"
                description="Wähle ein Team, um die Absenzen zu sehen."
              />
            </div>
          )}
        </div>
      )}

      <AbsenceForm
        open={formOpen}
        absence={editingAbsence}
        onSave={handleFormSave}
        onCancel={() => {
          setFormOpen(false)
          setEditingAbsence(null)
        }}
      />

      <ConfirmDialog
        open={deletingId !== null}
        onClose={() => setDeletingId(null)}
        onConfirm={handleDelete}
        title="Absenz löschen"
        message="Soll diese Absenz wirklich gelöscht werden?"
        confirmLabel="Löschen"
        danger
      />
    </div>
  )
}
