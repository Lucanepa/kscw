import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../../components/Modal'
import EmptyState from '../../components/EmptyState'
import { useAuth } from '../../hooks/useAuth'
import { useTeamMembers } from '../../hooks/useTeamMembers'
import { useMutation } from '../../hooks/useMutation'
import pb from '../../pb'
import AttendanceRow from './AttendanceRow'
import type { Training, TrainingAttendance, Absence, Member } from '../../types'

interface AttendanceSheetProps {
  trainingId: string | null
  teamId: string | null
  onClose: () => void
}

export default function AttendanceSheet({ trainingId, teamId, onClose }: AttendanceSheetProps) {
  const { t } = useTranslation('trainings')
  const { user, isCoach } = useAuth()
  const { members } = useTeamMembers(teamId ?? undefined)
  const { create, update } = useMutation<TrainingAttendance>('training_attendance')

  const [training, setTraining] = useState<Training | null>(null)
  const [attendanceRecords, setAttendanceRecords] = useState<TrainingAttendance[]>([])
  const [absences, setAbsences] = useState<Absence[]>([])
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(async () => {
    if (!trainingId || !teamId) return

    setLoading(true)
    try {
      const [t, attendanceList] = await Promise.all([
        pb.collection('trainings').getOne<Training>(trainingId),
        pb.collection('training_attendance').getFullList<TrainingAttendance>({
          filter: `training="${trainingId}"`,
        }),
      ])

      setTraining(t)
      setAttendanceRecords(attendanceList)

      // Fetch active absences for the training date
      const memberIds = members.map((mt) => mt.member)
      if (memberIds.length > 0 && t.date) {
        const trainingDate = t.date.split(' ')[0]
        const memberFilter = memberIds.map((id) => `member="${id}"`).join(' || ')
        const absenceList = await pb.collection('absences').getFullList<Absence>({
          filter: `(${memberFilter}) && start_date<="${trainingDate}" && end_date>="${trainingDate}"`,
        })
        setAbsences(absenceList)
      }
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [trainingId, teamId, members])

  useEffect(() => {
    if (trainingId) fetchData()
  }, [trainingId, fetchData])

  async function handleStatusChange(memberId: string, status: TrainingAttendance['status']) {
    if (!trainingId || !user) return

    const existing = attendanceRecords.find((a) => a.member === memberId)
    const activeAbsence = absences.find((a) => a.member === memberId)

    try {
      if (existing) {
        await update(existing.id, {
          status,
          absence: status === 'excused' && activeAbsence ? activeAbsence.id : '',
          noted_by: user.id,
        })
      } else {
        await create({
          training: trainingId,
          member: memberId,
          status,
          absence: status === 'excused' && activeAbsence ? activeAbsence.id : '',
          noted_by: user.id,
        })
      }
      fetchData()
    } catch {
      // ignore
    }
  }

  const memberList: Member[] = members
    .map((mt) => mt.expand?.member)
    .filter((m): m is Member => m !== undefined)

  return (
    <Modal
      open={trainingId !== null}
      onClose={onClose}
      title={training ? t('attendanceTitle', { date: training.date.split(' ')[0] }) : t('attendanceTitleShort')}
      size="lg"
    >
      {loading ? (
        <div className="py-8 text-center text-gray-500 dark:text-gray-400">{t('common:loading')}</div>
      ) : memberList.length === 0 ? (
        <EmptyState icon="👤" title={t('noPlayers')} description={t('noPlayersAssigned')} />
      ) : (
        <div className="max-h-[60vh] overflow-y-auto rounded-lg border dark:border-gray-700">
          {memberList.map((member) => {
            const attendance = attendanceRecords.find((a) => a.member === member.id) ?? null
            const activeAbsence = absences.find((a) => a.member === member.id) ?? null
            const canEdit = isCoach || member.id === user?.id

            return (
              <AttendanceRow
                key={member.id}
                member={member}
                attendance={attendance}
                activeAbsence={activeAbsence}
                onStatusChange={handleStatusChange}
                canEdit={canEdit}
              />
            )
          })}
        </div>
      )}
    </Modal>
  )
}
