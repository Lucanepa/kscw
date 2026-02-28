import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../../components/Modal'
import { useTeams } from '../../hooks/useTeams'
import { downloadICal } from '../../utils/icalGenerator'
import type { CalendarEntry } from '../../types/calendar'

const PB_URL = import.meta.env.VITE_PB_URL as string

type ICalMode = 'subscribe' | 'download'

interface ICalModalProps {
  open: boolean
  mode: ICalMode
  onClose: () => void
  /** Current visible entries (used for download mode) */
  entries: CalendarEntry[]
}

type Preset = 'all' | 'games' | 'games-home' | 'trainings'

const presetSources: Record<Preset, string[]> = {
  all: ['games-home', 'games-away', 'trainings', 'events', 'closures', 'hall'],
  games: ['games-home', 'games-away'],
  'games-home': ['games-home'],
  trainings: ['trainings'],
}

function presetMatchesEntry(preset: Preset, entry: CalendarEntry): boolean {
  if (preset === 'all') return true
  if (preset === 'games') return entry.type === 'game'
  if (preset === 'games-home') return entry.type === 'game' && entry.gameType === 'home'
  if (preset === 'trainings') return entry.type === 'training'
  return false
}

export default function ICalModal({ open, mode, onClose, entries }: ICalModalProps) {
  const { t } = useTranslation('calendar')
  const { data: teams } = useTeams()
  const [preset, setPreset] = useState<Preset>('all')
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>([])

  const title = mode === 'subscribe' ? t('icalSubscribeTitle') : t('icalDownloadTitle')

  const presetOptions: { value: Preset; label: string }[] = [
    { value: 'all', label: t('icalPresetAll') },
    { value: 'games', label: t('icalPresetGames') },
    { value: 'games-home', label: t('icalPresetHomeGames') },
    { value: 'trainings', label: t('icalPresetTrainings') },
  ]

  function handleConfirm() {
    if (mode === 'subscribe') {
      const params = new URLSearchParams()
      params.set('source', presetSources[preset].join(','))
      if (selectedTeamIds.length > 0) {
        params.set('team', selectedTeamIds.join(','))
      }
      const icalUrl = `${PB_URL}/api/ical?${params.toString()}`
      const webcalUrl = icalUrl.replace(/^https?:/, 'webcal:')
      window.open(webcalUrl, '_self')
    } else {
      // Download: filter current entries client-side
      let filtered = entries
      if (preset !== 'all') {
        filtered = entries.filter((e) => presetMatchesEntry(preset, e))
      }
      if (selectedTeamIds.length > 0) {
        filtered = filtered.filter((e) => {
          // Games: check source.kscw_team; Trainings: check source.team
          const src = e.source as Record<string, unknown>
          const teamId = (src.kscw_team ?? src.team ?? '') as string
          return !teamId || selectedTeamIds.includes(teamId)
        })
      }
      downloadICal(filtered, 'kscw-kalender.ics')
    }
    onClose()
  }

  function toggleTeam(id: string) {
    setSelectedTeamIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id],
    )
  }

  return (
    <Modal open={open} onClose={onClose} title={title} size="sm">
      <div className="space-y-5">
        {/* Preset selection */}
        <div>
          <p className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('icalFilterLabel')}
          </p>
          <div className="space-y-1">
            {presetOptions.map((opt) => (
              <label
                key={opt.value}
                className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-gray-50 sm:min-h-0 dark:hover:bg-gray-700"
              >
                <input
                  type="radio"
                  name="ical-preset"
                  value={opt.value}
                  checked={preset === opt.value}
                  onChange={() => setPreset(opt.value)}
                  className="h-4 w-4 text-brand-600 focus:ring-brand-500"
                />
                <span className="text-sm text-gray-900 dark:text-gray-100">{opt.label}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Team filter */}
        {teams.length > 0 && (
          <div>
            <p className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('icalTeamFilter')}
            </p>
            <div className="flex flex-wrap gap-2">
              {teams.map((team) => {
                const isSelected = selectedTeamIds.includes(team.id)
                return (
                  <button
                    key={team.id}
                    type="button"
                    onClick={() => toggleTeam(team.id)}
                    className={`min-h-[44px] rounded-full border px-3 py-2 text-sm font-medium transition-colors sm:min-h-0 sm:py-1 sm:text-xs ${
                      isSelected
                        ? 'border-brand-200 bg-brand-100 text-brand-800 dark:border-brand-700 dark:bg-brand-900/40 dark:text-brand-300'
                        : 'border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
                    }`}
                  >
                    {team.name}
                  </button>
                )
              })}
            </div>
            <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">{t('icalTeamHint')}</p>
          </div>
        )}

        {/* Confirm button */}
        <button
          type="button"
          onClick={handleConfirm}
          className="w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-700 active:bg-brand-800"
        >
          {mode === 'subscribe' ? t('subscribeICal') : t('exportICal')}
        </button>
      </div>
    </Modal>
  )
}
