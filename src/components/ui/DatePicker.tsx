import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Calendar as CalendarIcon } from 'lucide-react'
import { parseISO } from 'date-fns'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Calendar } from '@/components/ui/calendar'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { getLocale, toDateKey } from '../../utils/dateUtils'
import { formatDateZurich, parseTypedDate } from '../../utils/dateHelpers'

interface DatePickerProps {
  value: string
  onChange: (value: string) => void
  label?: string
  error?: string
  helperText?: string
  min?: string
  max?: string
  placeholder?: string
  id?: string
  required?: boolean
  disabled?: boolean
  className?: string
  /** Earliest year shown in the year dropdown. Defaults to 1900 (needed for birthdates).
   *  Clamped to the selected date's year so editing an older value stays selectable. */
  fromYear?: number
}

export default function DatePicker({
  value,
  onChange,
  label,
  error,
  helperText,
  min,
  max,
  placeholder,
  id,
  disabled,
  className = '',
  fromYear,
}: DatePickerProps) {
  const { t, i18n } = useTranslation('common')
  const lang = i18n.language
  const [open, setOpen] = useState(false)

  const selectedDate = value ? parseISO(value) : undefined
  const [month, setMonth] = useState<Date>(
    selectedDate ?? new Date(),
  )

  /**
   * What the user is currently typing, or `null` when they are not typing and
   * the field simply mirrors `value`.
   *
   * ⚠ Deliberately NOT a copy of `value` kept in sync by an effect: the text box
   * and the committed date are two different things (`31.02.` is text, not a
   * date), and a mirror would need a sync effect that fights the user mid-word.
   * `null` means "show the canonical dd.mm.yyyy", so an external change to
   * `value` — the calendar, a form reset, another field — needs no sync at all.
   * Blur drops back to `null`, which is also what discards unparseable text.
   */
  const [draft, setDraft] = useState<string | null>(null)

  // Follow an external `value` change (the calendar, a form reset, another
  // field) back into the visible month. Adjust-state-during-render rather than
  // an effect: `react-hooks/set-state-in-effect` is an error in this repo, and
  // this file only escaped it by living under the eslint-ignored `ui/` dir.
  // ⚠ The tracked dep is the `value` STRING — a primitive, so the comparison is
  // stable and this converges after one extra render. A render-phase write on a
  // value whose identity changes every render is React #301, not a stale seed.
  const [prevValue, setPrevValue] = useState(value)
  if (value !== prevValue) {
    setPrevValue(value)
    if (selectedDate) setMonth(selectedDate)
  }

  const minDate = min ? parseISO(min) : undefined
  const maxDate = max ? parseISO(max) : undefined

  const startYear =
    fromYear != null
      ? Math.min(fromYear, selectedDate ? selectedDate.getFullYear() : fromYear)
      : 1900

  // ⚠ Format the STRING, never `selectedDate`. `parseISO('2026-09-20')` builds
  // LOCAL midnight and `formatDateZurich` then re-reads that instant in
  // Europe/Zurich — so on a device EAST of Zurich (Riga, +03:00) local midnight
  // is still 23:00 the day before over here, and the box rendered 19.09.2026 for
  // a value of `2026-09-20`. The box then disagreed with everything that stayed
  // on the raw string (the weekday hint, another field's `min`), which reads as
  // "the End picker refuses the start day". A date-only string has no instant to
  // convert; passing it through keeps it a date.
  const displayValue = value ? formatDateZurich(value) : ''
  const text = draft ?? displayValue
  // Only flag what the user can see is wrong. A half-typed "10.05." is not yet a
  // date but is not an error either while the caret is still sitting in it.
  const typedInvalid = draft !== null && draft.trim() !== '' && parseTypedDate(draft) === null

  const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined)
  const errorId = error && inputId ? `${inputId}-error` : undefined
  const helpId = helperText && !error && inputId ? `${inputId}-help` : undefined
  const locale = getLocale(lang)

  /** ISO-string comparison — `min`/`max` are `YYYY-MM-DD`, which sorts by date. */
  function withinBounds(iso: string): boolean {
    if (min && iso < min.slice(0, 10)) return false
    if (max && iso > max.slice(0, 10)) return false
    return true
  }

  function handleType(next: string) {
    setDraft(next)
    if (!next.trim()) {
      // Emptying the box clears the value — same as the Clear button.
      if (value) onChange('')
      return
    }
    const iso = parseTypedDate(next)
    if (iso && iso !== value && withinBounds(iso)) onChange(iso)
  }

  function handleSelect(date: Date | undefined) {
    if (date) {
      setDraft(null)
      onChange(toDateKey(date))
      setOpen(false)
    }
  }

  function handleToday() {
    const today = new Date()
    setDraft(null)
    onChange(toDateKey(today))
    setMonth(today)
    setOpen(false)
  }

  function handleClear() {
    setDraft(null)
    onChange('')
    setOpen(false)
  }

  return (
    <div>
      {label && (
        <Label htmlFor={inputId} className="mb-1.5">
          {label}
        </Label>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        {/* Anchored to the whole field rather than to the icon button that opens
            it, so the calendar keeps lining up with the field's left edge the
            way it did when the entire control was one button. */}
        <PopoverAnchor asChild>
          <div
            // ⚠ Padding and sizing live on the WRAPPER, not on the input, so a
            // caller's `className` still lands on the control the way it did
            // when this was a single button — the grid's inline editor passes
            // `min-h-7 px-1 py-0` to compress a cell, and tailwind-merge can
            // only override what it can see on this element.
            className={cn(
              'flex min-h-[44px] min-w-[140px] w-full items-center gap-1 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-within:ring-1 focus-within:ring-ring',
              (error || typedInvalid) && 'border-destructive',
              disabled && 'cursor-not-allowed opacity-50',
              className,
            )}
          >
            <input
              type="text"
              id={inputId}
              value={text}
              onChange={(e) => handleType(e.target.value)}
              // Blur normalizes: a committed date snaps back to dd.mm.yyyy, and
              // text that never parsed is discarded rather than left sitting in
              // the box looking like a saved value.
              onBlur={() => setDraft(null)}
              onKeyDown={(e) => { if (e.key === 'Enter') setDraft(null) }}
              disabled={disabled}
              // `text`, not `type="date"` — a paste of any accepted shape has to
              // land intact, and the native picker must stay out of it (it draws
              // the browser locale's order, which is the one thing we forbid).
              // ⚠ iOS's numeric keypad has no `.`, which is why `parseTypedDate`
              // also accepts bare digits: `24031998` is the mobile typing path.
              inputMode="numeric"
              // ⚠ `size`, not just `min-w-0`. A text input's intrinsic width
              // comes from its `size` attribute (default 20 ≈ 210px) and
              // `min-width: 0` does NOT lower it — so inside a narrow flex or
              // table column the whole field refused to shrink and overflowed
              // its container (the member Danger zone on a phone). 6 puts the
              // whole field's intrinsic width at the wrapper's own 140px floor,
              // so a narrow parent decides the width instead of the input's
              // default. The input is `flex-1`, so it still fills whatever room
              // there is — `size` only decides how narrow it MAY get.
              size={6}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={error || typedInvalid ? true : undefined}
              aria-describedby={errorId || helpId}
              placeholder={placeholder || t('dateFormatHint')}
              className="min-w-0 flex-1 bg-transparent p-0 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
            />
            <PopoverTrigger asChild>
              <button
                type="button"
                disabled={disabled}
                aria-label={t('selectDate')}
                data-testid="datepicker-trigger"
                className="flex w-10 shrink-0 cursor-pointer items-center justify-center self-stretch rounded-md ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed"
              >
                <CalendarIcon className="h-4 w-4 opacity-50" />
              </button>
            </PopoverTrigger>
          </div>
        </PopoverAnchor>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            captionLayout="dropdown"
            // ⚠ `fixedWeeks` is load-bearing, not cosmetic. Months span 4–6 week
            // rows, so without it the popover changes height as you page through
            // them — and because it is collision-aware, a height change near the
            // bottom of the viewport flips it above the field and back again on
            // the next month. That is the "picker jumps up and down" report.
            // Outside days are shown so the constant 6th row reads as a calendar
            // instead of a blank gap (a bare `min-height` was tried before and
            // left exactly that gap — see the note in calendar.tsx).
            fixedWeeks
            showOutsideDays
            selected={selectedDate}
            onSelect={handleSelect}
            month={month}
            onMonthChange={setMonth}
            locale={locale}
            weekStartsOn={1}
            startMonth={new Date(startYear, 0)}
            endMonth={new Date(Math.max(2035, new Date().getFullYear() + 10), 11)}
            disabled={(date) => {
              if (minDate && toDateKey(date) < toDateKey(minDate)) return true
              if (maxDate && toDateKey(date) > toDateKey(maxDate)) return true
              return false
            }}
          />
          <div className={cn('border-t p-2 flex', selectedDate ? 'justify-between' : 'justify-end')}>
            {selectedDate && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClear}
                type="button"
              >
                {t('clear')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleToday}
              type="button"
            >
              {t('today')}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      {error && <p id={errorId} className="mt-1 text-xs text-destructive">{error}</p>}
      {helperText && !error && <p id={helpId} className="mt-1 text-xs text-muted-foreground">{helperText}</p>}
    </div>
  )
}
