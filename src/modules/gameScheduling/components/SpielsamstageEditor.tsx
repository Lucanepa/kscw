import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { parseISO, isSaturday, addDays } from 'date-fns'
import { de } from 'date-fns/locale/de'
import { enUS } from 'date-fns/locale'
import { Calendar as CalendarIcon, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Calendar } from '@/components/ui/calendar'
import { Button } from '@/components/ui/button'
import type { SpielsamstagConfig } from '../../../types'
import { useHalls } from '../../../hooks/useData'
import { useCollection } from '../../../lib/query'
import { toDateKey, formatDateLocale } from '../../../utils/dateUtils'

// Fixed game-Saturday times (rule C1) — not editable. Juniors may also play on
// any Sunday at fixed times (11:00/13:00/15:00); those slots are generated for
// every Sunday automatically, so there is no Sunday picker here.
const DEFAULT_TIMES = ['11:00', '13:30', '16:00', '18:30']

interface Props {
  spielsamstage: SpielsamstagConfig[]
  onUpdate: (spielsamstage: SpielsamstagConfig[]) => Promise<void>
  /** Season string ("YYYY/YYYY") — bounds the picker to Sep 1 → Mar 31. */
  season: string
}

export default function SpielsamstageEditor({ spielsamstage, onUpdate, season }: Props) {
  const { t, i18n } = useTranslation('gameScheduling')
  const [dates, setDates] = useState<string[]>(
    spielsamstage.map(s => s.date).filter(Boolean),
  )
  const [saving, setSaving] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)

  // Re-seed the local selection whenever the parent hands down a new
  // `spielsamstage` array (same trigger the old effect had — a reference change).
  // Adjust-state-during-render instead of setState-in-effect.
  const [seededFrom, setSeededFrom] = useState(spielsamstage)
  if (seededFrom !== spielsamstage) {
    setSeededFrom(spielsamstage)
    setDates(spielsamstage.map(s => s.date).filter(Boolean))
  }

  // Shared cached query (the sibling admin dashboard warms the same key), so a
  // navigation usually has the halls already in hand.
  const { data: hallsData, isLoading: hallsLoading, isError: hallsFailed, error: hallsError } = useHalls()
  // TanStack flips isLoading to false on ERROR while data stays undefined — the
  // `isError` escape is what stops this gate latching on forever after a failed read.
  const hallsPending = !hallsFailed && (hallsLoading || hallsData === undefined)
  const halls = useMemo(() => hallsData ?? [], [hallsData])

  // Saturdays that fall on any event get greyed out in the picker, so a game
  // day isn't booked onto an event. Zurich-local dates (matches the server).
  const { data: eventsData, isLoading: eventsLoading, isError: eventsFailed } =
    useCollection<{ start_date: string; end_date: string | null }>('events', {
      fields: ['id', 'start_date', 'end_date'],
      all: true,
    })
  // Same escape: if the clash list cannot be read we fall back to the old
  // behaviour (every Saturday selectable) rather than locking the picker shut.
  const eventsPending = !eventsFailed && (eventsLoading || eventsData === undefined)

  const eventDays = useMemo(() => {
    const set = new Set<string>()
    const zkey = (ts: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich' }).format(new Date(ts))
    for (const e of eventsData ?? []) {
      if (!e.start_date) continue
      let d = parseISO(zkey(e.start_date))
      const last = parseISO(zkey(e.end_date || e.start_date))
      let guard = 0
      while (d <= last && guard++ < 400) {
        set.add(toDateKey(d))
        d = addDays(d, 1)
      }
    }
    return set
  }, [eventsData])

  const lang = i18n.language
  const locale = lang === 'de' ? de : enUS

  const kwiHalls = useMemo(
    () => halls.filter(h => h.name.toLowerCase().includes('kwi')),
    [halls],
  )

  const selectedDates = useMemo(
    () => dates.map(d => parseISO(d)).sort((a, b) => a.getTime() - b.getTime()),
    [dates],
  )

  // The volleyball season runs Sep 1 (start year) → Mar 31 (end year). Bound the
  // picker so only Saturdays inside that window are selectable / navigable.
  const seasonRange = useMemo(() => {
    const m = String(season || '').match(/^(\d{4})/)
    if (!m) return null
    const startYear = parseInt(m[1], 10)
    return {
      start: new Date(startYear, 8, 1),            // 1 Sep
      end: new Date(startYear + 1, 2, 31, 23, 59),  // 31 Mar
    }
  }, [season])

  const handleCalendarSelect = (newDates: Date[] | undefined) => {
    const keys = (newDates ?? []).map(toDateKey)
    setDates(Array.from(new Set(keys)))
  }

  const removeDate = (d: string) => {
    setDates(dates.filter(x => x !== d))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const payload: SpielsamstagConfig[] = [...dates]
        .sort()
        .map(date => ({
          date,
          slots: DEFAULT_TIMES.flatMap(time =>
            kwiHalls.map(h => ({ time, hall_id: String(h.id) })),
          ),
        }))
      await onUpdate(payload)
      toast.success(t('spielsamstageSaved'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const slotsPerDay = kwiHalls.length * DEFAULT_TIMES.length
  const hallNames = kwiHalls.map(h => h.name).join(' / ') || 'KWI'

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        {t('spielsamstage')}
      </h2>
      {/* Never state a slot count from an unloaded hall list — "0 slots × KWI" reads
          as a misconfigured club. Skeleton while pending, the read error when it failed. */}
      <p className="mt-1 mb-4 text-xs text-gray-500 dark:text-gray-400">
        {hallsPending ? (
          <span
            aria-hidden
            className="inline-block h-3 w-72 max-w-full animate-pulse rounded bg-gray-200 align-middle dark:bg-gray-700"
          />
        ) : hallsFailed ? (
          <span className="text-amber-600 dark:text-amber-400">
            {t('common:errorLoading')} {hallsError instanceof Error ? hallsError.message : ''}
          </span>
        ) : (
          t('spielsamstageAutoHint', {
            count: slotsPerDay,
            times: DEFAULT_TIMES.join(' / '),
            halls: hallNames,
            defaultValue: `Each selected Saturday auto-generates ${slotsPerDay} slots — ${DEFAULT_TIMES.join(' / ')} × ${hallNames}.`,
          })
        )}
      </p>

      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="gap-2" disabled={eventsPending}>
            <CalendarIcon className="h-4 w-4" />
            {t('pickSaturdays', { defaultValue: 'Pick Saturdays' })}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="multiple"
            selected={selectedDates}
            onSelect={handleCalendarSelect}
            locale={locale}
            weekStartsOn={1}
            showOutsideDays={false}
            captionLayout="dropdown"
            disabled={(date) =>
              eventsPending ||
              !isSaturday(date) ||
              eventDays.has(toDateKey(date)) ||
              (!!seasonRange && (date < seasonRange.start || date > seasonRange.end))
            }
            startMonth={seasonRange ? seasonRange.start : new Date(new Date().getFullYear() - 1, 0)}
            endMonth={seasonRange ? seasonRange.end : new Date(new Date().getFullYear() + 2, 11)}
          />
        </PopoverContent>
      </Popover>

      {selectedDates.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {selectedDates.map(d => {
            const key = toDateKey(d)
            return (
              <span
                key={key}
                className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-3 py-1 text-xs font-medium text-blue-800 dark:bg-blue-900/40 dark:text-blue-200"
              >
                {formatDateLocale(d, 'd. MMM yyyy', lang)}
                <button
                  type="button"
                  onClick={() => removeDate(key)}
                  className="-mr-1.5 ml-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full hover:text-blue-600 dark:hover:text-white"
                  aria-label={t('removeSpielssamstag')}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            )
          })}
        </div>
      ) : (
        <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
          {t('noSpielsamstage', { defaultValue: 'No game Saturdays yet.' })}
        </p>
      )}

      {!hallsPending && !hallsFailed && kwiHalls.length === 0 && halls.length > 0 && (
        <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
          {t('noKwiHalls', {
            defaultValue: 'No KWI halls found — add halls named "KWI A/B/C" to enable auto-slot generation.',
          })}
        </p>
      )}

      <Button
        onClick={handleSave}
        disabled={saving || hallsPending || kwiHalls.length === 0}
        size="sm"
        className="mt-4"
      >
        {saving ? '...' : t('common:save')}
      </Button>
    </div>
  )
}
