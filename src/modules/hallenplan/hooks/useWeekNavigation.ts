import { useState, useMemo, useCallback } from 'react'
import { getMonday, getWeekDays, toISODate, addDays, getISOWeekNumber } from '../../../utils/dateHelpers'

export function useWeekNavigation() {
  const [monday, setMonday] = useState(() => getMonday(new Date()))

  const weekDays = useMemo(() => getWeekDays(monday), [monday])

  const goNext = useCallback(() => {
    setMonday((prev) => addDays(prev, 7))
  }, [])

  const goPrev = useCallback(() => {
    setMonday((prev) => addDays(prev, -7))
  }, [])

  const goToday = useCallback(() => {
    setMonday(getMonday(new Date()))
  }, [])

  const weekLabel = useMemo(() => {
    const kw = getISOWeekNumber(monday)
    const sunday = addDays(monday, 6)
    const monDay = String(monday.getDate()).padStart(2, '0')
    const monMonth = String(monday.getMonth() + 1).padStart(2, '0')
    const sunDay = String(sunday.getDate()).padStart(2, '0')
    const sunMonth = String(sunday.getMonth() + 1).padStart(2, '0')
    return `KW ${kw} — ${monDay}.${monMonth}. - ${sunDay}.${sunMonth}.${sunday.getFullYear()}`
  }, [monday])

  const mondayStr = useMemo(() => toISODate(monday), [monday])
  const sundayStr = useMemo(() => toISODate(addDays(monday, 6)), [monday])

  return { monday, weekDays, goNext, goPrev, goToday, weekLabel, mondayStr, sundayStr }
}
