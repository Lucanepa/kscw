const dateFmt = new Intl.DateTimeFormat('de-CH', { day: 'numeric', month: 'short', year: 'numeric' })
const dateShortFmt = new Intl.DateTimeFormat('de-CH', { day: '2-digit', month: '2-digit' })
const weekdayFmt = new Intl.DateTimeFormat('de-CH', { weekday: 'short' })

export function formatDate(date: string): string {
  return dateFmt.format(new Date(date))
}

export function formatDateShort(date: string): string {
  return dateShortFmt.format(new Date(date))
}

export function formatWeekday(date: string): string {
  return weekdayFmt.format(new Date(date))
}

export function formatTime(time: string): string {
  return time.slice(0, 5)
}

export function isDateInRange(date: string, start: string, end: string): boolean {
  const d = new Date(date).getTime()
  return d >= new Date(start).getTime() && d <= new Date(end).getTime()
}

export function getCurrentSeason(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth()
  // Season runs Sep–May. If we're in Jan–Aug, current season started last year.
  if (month < 8) {
    return `${year - 1}/${String(year).slice(2)}`
  }
  return `${year}/${String(year + 1).slice(2)}`
}

export function getSeasonDateRange(season: string): { start: string; end: string } {
  const startYear = parseInt(season.split('/')[0])
  return {
    start: `${startYear}-09-01`,
    end: `${startYear + 1}-08-31`,
  }
}

export function toISODate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// --- Hallenplan utilities ---

/** Returns the Monday 00:00:00 of the week containing `date` */
export function getMonday(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay()
  const diff = (day === 0 ? -6 : 1) - day
  d.setDate(d.getDate() + diff)
  d.setHours(0, 0, 0, 0)
  return d
}

/** Returns array of 7 Dates [Mon..Sun] for the week starting at `monday` */
export function getWeekDays(monday: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday)
    d.setDate(d.getDate() + i)
    return d
  })
}

/** Parses 'HH:mm' to minutes since midnight (e.g., '08:30' => 510) */
export function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return h * 60 + m
}

/** Converts minutes since midnight to 'HH:mm' */
export function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** Returns day_of_week 0=Mon..6=Sun from a JS Date */
export function getDayOfWeek(date: Date): number {
  return (date.getDay() + 6) % 7
}

/** Returns a new Date advanced by `days` */
export function addDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

/** Returns ISO week number */
export function getISOWeekNumber(date: Date): number {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7))
  const yearStart = new Date(d.getFullYear(), 0, 4)
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + yearStart.getDay() + 6) / 7)
}

const DAY_NAMES_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'] as const

/** Returns short German day name for day_of_week 0=Mon..6=Sun */
export function getDayName(dayOfWeek: number): string {
  return DAY_NAMES_SHORT[dayOfWeek]
}
