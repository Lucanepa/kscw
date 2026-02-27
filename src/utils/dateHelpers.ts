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
  return date.toISOString().split('T')[0]
}
