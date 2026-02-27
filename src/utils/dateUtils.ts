import {
  format,
  startOfMonth as fnsStartOfMonth,
  endOfMonth as fnsEndOfMonth,
  startOfWeek as fnsStartOfWeek,
  endOfWeek as fnsEndOfWeek,
  addMonths as fnsAddMonths,
  addWeeks as fnsAddWeeks,
  eachDayOfInterval as fnsEachDayOfInterval,
  isSameDay as fnsIsSameDay,
  isSameMonth as fnsIsSameMonth,
  isWithinInterval as fnsIsWithinInterval,
  parseISO,
  getDay as fnsGetDay,
} from 'date-fns'
import { de } from 'date-fns/locale'

export function parseDate(isoString: string): Date {
  return parseISO(isoString)
}

export function formatDateDE(date: Date, pattern: string): string {
  return format(date, pattern, { locale: de })
}

export function startOfMonth(date: Date): Date {
  return fnsStartOfMonth(date)
}

export function endOfMonth(date: Date): Date {
  return fnsEndOfMonth(date)
}

/** Monday-start week (Swiss convention) */
export function startOfWeek(date: Date): Date {
  return fnsStartOfWeek(date, { weekStartsOn: 1 })
}

export function endOfWeek(date: Date): Date {
  return fnsEndOfWeek(date, { weekStartsOn: 1 })
}

export function addMonths(date: Date, n: number): Date {
  return fnsAddMonths(date, n)
}

export function addWeeks(date: Date, n: number): Date {
  return fnsAddWeeks(date, n)
}

export function eachDayOfInterval(start: Date, end: Date): Date[] {
  return fnsEachDayOfInterval({ start, end })
}

export function isSameDay(a: Date, b: Date): boolean {
  return fnsIsSameDay(a, b)
}

export function isSameMonth(a: Date, b: Date): boolean {
  return fnsIsSameMonth(a, b)
}

export function isWithinInterval(date: Date, start: Date, end: Date): boolean {
  return fnsIsWithinInterval(date, { start, end })
}

/** Format to "YYYY-MM-DD" for use as Map keys */
export function toDateKey(date: Date): string {
  return format(date, 'yyyy-MM-dd')
}

/** 0=Mon..6=Sun (ISO convention, not JS default) */
export function getISODay(date: Date): number {
  const day = fnsGetDay(date)
  return day === 0 ? 6 : day - 1
}

/** Season months: Sep of startYear through May of startYear+1 */
export function getSeasonMonths(startYear: number): Date[] {
  const months: Date[] = []
  for (let m = 8; m <= 11; m++) {
    months.push(new Date(startYear, m, 1))
  }
  for (let m = 0; m <= 4; m++) {
    months.push(new Date(startYear + 1, m, 1))
  }
  return months
}

/** Get the season start year for a given date (Sep–May season) */
export function getSeasonYear(date: Date): number {
  const month = date.getMonth()
  return month >= 8 ? date.getFullYear() : date.getFullYear() - 1
}

/** Day-of-week headers in German (Monday-start) */
export const DAY_HEADERS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']
