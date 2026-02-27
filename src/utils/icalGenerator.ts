import type { CalendarEntry } from '../types/calendar'

/**
 * Generate a valid iCalendar (.ics) string from calendar entries.
 * Conforms to RFC 5545.
 */
export function generateICal(entries: CalendarEntry[]): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//KSCW Volley//Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:KSCW Volleyball',
    'X-WR-TIMEZONE:Europe/Zurich',
  ]

  for (const entry of entries) {
    lines.push('BEGIN:VEVENT')
    lines.push(`UID:${entry.id}@kscw.ch`)
    lines.push(`DTSTAMP:${formatICalUTC(new Date())}`)

    if (entry.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${formatICalDateOnly(entry.date)}`)
      const nextDay = new Date(entry.date)
      nextDay.setDate(nextDay.getDate() + 1)
      lines.push(`DTEND;VALUE=DATE:${formatICalDateOnly(nextDay)}`)
    } else if (entry.startTime) {
      lines.push(
        `DTSTART;TZID=Europe/Zurich:${formatICalLocal(entry.date, entry.startTime)}`,
      )
      if (entry.endTime) {
        lines.push(
          `DTEND;TZID=Europe/Zurich:${formatICalLocal(entry.date, entry.endTime)}`,
        )
      } else {
        lines.push(
          `DTEND;TZID=Europe/Zurich:${formatICalLocalOffset(entry.date, entry.startTime, 2)}`,
        )
      }
    } else {
      lines.push(`DTSTART;VALUE=DATE:${formatICalDateOnly(entry.date)}`)
      const nextDay = new Date(entry.date)
      nextDay.setDate(nextDay.getDate() + 1)
      lines.push(`DTEND;VALUE=DATE:${formatICalDateOnly(nextDay)}`)
    }

    lines.push(`SUMMARY:${escapeICalText(entry.title)}`)
    if (entry.location) {
      lines.push(`LOCATION:${escapeICalText(entry.location)}`)
    }
    if (entry.description) {
      lines.push(`DESCRIPTION:${escapeICalText(entry.description)}`)
    }
    lines.push('END:VEVENT')
  }

  lines.push('END:VCALENDAR')
  return lines.join('\r\n')
}

/**
 * Trigger a browser download of the .ics file.
 */
export function downloadICal(
  entries: CalendarEntry[],
  filename: string = 'kscw.ics',
): void {
  const content = generateICal(entries)
  const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

// --- Internal helpers ---

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** UTC datetime for DTSTAMP: 20251015T143000Z */
function formatICalUTC(date: Date): string {
  const y = date.getUTCFullYear()
  const m = pad(date.getUTCMonth() + 1)
  const d = pad(date.getUTCDate())
  const h = pad(date.getUTCHours())
  const min = pad(date.getUTCMinutes())
  const s = pad(date.getUTCSeconds())
  return `${y}${m}${d}T${h}${min}${s}Z`
}

/** Date-only: 20251015 */
function formatICalDateOnly(date: Date): string {
  const y = date.getFullYear()
  const m = pad(date.getMonth() + 1)
  const d = pad(date.getDate())
  return `${y}${m}${d}`
}

/** Local datetime from date + time string: 20251015T143000 */
function formatICalLocal(date: Date, time: string): string {
  const y = date.getFullYear()
  const mo = pad(date.getMonth() + 1)
  const d = pad(date.getDate())
  const [h, m] = time.split(':')
  return `${y}${mo}${d}T${h}${m}00`
}

/** Local datetime offset by hours */
function formatICalLocalOffset(date: Date, time: string, hoursOffset: number): string {
  const [h, m] = time.split(':').map(Number)
  const newH = h + hoursOffset
  const y = date.getFullYear()
  const mo = pad(date.getMonth() + 1)
  const d = pad(date.getDate())
  return `${y}${mo}${d}T${pad(newH)}${pad(m)}00`
}

/** Escape special characters per RFC 5545 */
function escapeICalText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
}
