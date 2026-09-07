import { AlertTriangle, Check, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/**
 * Server-side RSVP status for one nominated player. `'none'` = linked member who
 * never answered; `null` = nothing to check (see below).
 */
export type RsvpState = 'confirmed' | 'tentative' | 'declined' | 'none' | null

/**
 * The match sheet's check mark: does this nominated player's RSVP agree?
 *
 * The Einsatzliste WINS — this never changes who is on the sheet. It answers the
 * separate question the coach used to open a second modal for: of the people
 * Volleymanager says are playing, who actually told us they are coming?
 *
 * `null` renders as a dash rather than a warning, and it means two different
 * innocuous things: the row is a Volleymanager licence we hold no member for, or
 * the sheet came from the RSVP fallback (where the check would be circular — the
 * sheet IS the confirmed RSVPs, so every row would be green and would assert a
 * cross-check that never happened). Neither is a problem with the player.
 *
 * Own strings in the `games` namespace on purpose: the two match-sheet modals sit
 * in different namespaces (`scorer` and `games`) and would otherwise need the
 * labels duplicated.
 */
const STYLE = {
  confirmed: { Icon: Check, cls: 'text-green-600 dark:text-green-400', key: 'rsvpCheckConfirmed' },
  tentative: { Icon: AlertTriangle, cls: 'text-amber-600 dark:text-amber-500', key: 'rsvpCheckTentative' },
  none: { Icon: AlertTriangle, cls: 'text-amber-600 dark:text-amber-500', key: 'rsvpCheckNone' },
  declined: { Icon: X, cls: 'text-red-600 dark:text-red-400', key: 'rsvpCheckDeclined' },
} as const

export default function RsvpCheck({ state }: { state: RsvpState }) {
  const { t } = useTranslation('games')
  if (!state || !(state in STYLE)) {
    const label = t('rsvpCheckNotApplicable')
    return (
      <span className="text-muted-foreground" title={label} aria-label={label}>
        —
      </span>
    )
  }
  const { Icon, cls, key } = STYLE[state as keyof typeof STYLE]
  const label = t(key)
  return (
    <span
      className={`inline-flex items-center justify-center ${cls}`}
      title={label}
      role="img"
      aria-label={label}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </span>
  )
}
