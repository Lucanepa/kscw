import { useState } from 'react'
import { useParticipation } from '../hooks/useParticipation'
import type { Participation } from '../types'

interface ParticipationButtonProps {
  activityType: Participation['activity_type']
  activityId: string
  activityDate?: string
  compact?: boolean
}

const statusConfig = {
  confirmed: { label: 'Confirmed', icon: '✓', bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-700 dark:text-green-400' },
  declined: { label: 'Declined', icon: '✗', bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-700 dark:text-red-400' },
  tentative: { label: 'Maybe', icon: '?', bg: 'bg-yellow-100 dark:bg-yellow-900/30', text: 'text-yellow-700 dark:text-yellow-400' },
  absent: { label: 'Absent', icon: '—', bg: 'bg-gray-100 dark:bg-gray-700', text: 'text-gray-500 dark:text-gray-400' },
} as const

export default function ParticipationButton({
  activityType,
  activityId,
  activityDate,
  compact = false,
}: ParticipationButtonProps) {
  const { effectiveStatus, hasAbsence, setStatus } = useParticipation(
    activityType,
    activityId,
    activityDate,
  )
  const [menuOpen, setMenuOpen] = useState(false)

  if (hasAbsence) {
    const cfg = statusConfig.absent
    return (
      <span className={`inline-flex min-h-[44px] items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium sm:min-h-0 ${cfg.bg} ${cfg.text}`}>
        {cfg.icon} {!compact && cfg.label}
      </span>
    )
  }

  const currentConfig = effectiveStatus ? statusConfig[effectiveStatus] : null

  async function handleSelect(status: Participation['status']) {
    setMenuOpen(false)
    await setStatus(status)
  }

  return (
    <div className="relative">
      <button
        onClick={() => setMenuOpen(!menuOpen)}
        className={`inline-flex min-h-[44px] items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors sm:min-h-0 ${
          currentConfig
            ? `${currentConfig.bg} ${currentConfig.text}`
            : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
        }`}
      >
        {currentConfig ? (
          <>
            {currentConfig.icon} {!compact && currentConfig.label}
          </>
        ) : (
          <>RSVP</>
        )}
      </button>

      {menuOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1 w-32 rounded-lg border bg-white py-1 shadow-lg dark:border-gray-600 dark:bg-gray-800">
            {(['confirmed', 'tentative', 'declined'] as const).map((status) => {
              const cfg = statusConfig[status]
              return (
                <button
                  key={status}
                  onClick={() => handleSelect(status)}
                  className={`flex w-full items-center gap-2 px-3 py-3 text-left text-sm transition-colors hover:bg-gray-100 sm:py-2 dark:hover:bg-gray-700 ${
                    effectiveStatus === status ? 'font-medium' : ''
                  } ${cfg.text}`}
                >
                  {cfg.icon} {cfg.label}
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
