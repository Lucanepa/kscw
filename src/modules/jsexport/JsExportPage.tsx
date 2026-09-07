import { useState, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Download } from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { useAdminMode } from '../../hooks/useAdminMode'
import { fetchAllItems } from '../../lib/api'
import { Button } from '@/components/ui/button'
import LoadingSpinner from '../../components/LoadingSpinner'
import DatePicker from '@/components/ui/DatePicker'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import {
  fetchJsExport, downloadJsCsv, jsExportFilename, activityCsvRows, attendanceCsvRows,
  JS_ACTIVITY_HEADERS, JS_ATTENDANCE_HEADERS, jsSeasonForDate, jsSeasonOptions, jsSeasonRange,
  type JsExportData,
} from './jsExport'

interface TeamRow { id: string; name: string; sport: string }

export default function JsExportPage() {
  const { t } = useTranslation('jsExport')
  const { t: tc } = useTranslation('common')
  const { coachTeamIds, teamResponsibleIds, isAdmin, isVorstand, teamsLoading } = useAuth()
  const { effectiveIsAdmin, effectiveIsVorstand } = useAdminMode()

  const canJsExport = isAdmin || isVorstand || coachTeamIds.length > 0 || teamResponsibleIds.length > 0
  const leaderTeamIds = useMemo(
    () => [...new Set([...coachTeamIds, ...teamResponsibleIds])],
    [coachTeamIds, teamResponsibleIds],
  )

  const [season, setSeason] = useState(() => jsSeasonForDate(new Date()))
  const seasons = useMemo(() => jsSeasonOptions(), [])
  // Explicit activity window — defaults to the season's Sep 1 → Aug 31 span, but
  // the coach can narrow it to control which activities/events fall in scope.
  const [from, setFrom] = useState(() => jsSeasonRange(jsSeasonForDate(new Date())).start)
  const [to, setTo] = useState(() => jsSeasonRange(jsSeasonForDate(new Date())).end)
  const [teams, setTeams] = useState<TeamRow[]>([])
  const [teamsFetching, setTeamsFetching] = useState(true)
  const [busyKey, setBusyKey] = useState<string | null>(null)

  function handleSeasonChange(next: string) {
    setSeason(next)
    const r = jsSeasonRange(next)
    setFrom(r.start)
    setTo(r.end)
  }

  // Cache the endpoint result per team+season+window so the two buttons don't double-fetch.
  const cacheRef = useRef<Map<string, JsExportData>>(new Map())
  useEffect(() => { cacheRef.current.clear() }, [season, from, to])

  const teamKey = leaderTeamIds.join(',')
  useEffect(() => {
    if (teamsLoading) return
    let cancelled = false
    async function load() {
      setTeamsFetching(true)
      try {
        // Admins + board see every active team; coaches/TR see the teams they lead.
        const showAll = effectiveIsAdmin || effectiveIsVorstand
        const filter = showAll ? { active: { _eq: true } } : { id: { _in: leaderTeamIds } }
        const list = (showAll || leaderTeamIds.length > 0)
          ? await fetchAllItems<TeamRow>('teams', { filter, fields: ['id', 'name', 'sport'], sort: ['name'] })
          : []
        if (!cancelled) setTeams(list.map((tm) => ({ id: String(tm.id), name: tm.name, sport: tm.sport })))
      } catch {
        if (!cancelled) setTeams([])
      } finally {
        if (!cancelled) setTeamsFetching(false)
      }
    }
    load()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveIsAdmin, effectiveIsVorstand, teamKey, teamsLoading])

  if (teamsLoading) {
    return <div className="flex justify-center py-16"><LoadingSpinner /></div>
  }
  if (!canJsExport) return <Navigate to="/" replace />

  function surfaceWarnings(data: JsExportData) {
    const {
      participantsMissingJsId, leadersMissingJsId, emptyRoster,
      trainingsMissingOrt = [], trainingsMissingZeit = [],
    } = data.warnings
    // Leaders but no participants is never a valid J+S export — it means the
    // requested season resolved to a team row with no roster. Loud, because the
    // CSV still downloads and looks plausible.
    if (emptyRoster) {
      toast.error(t('emptyRosterWarning'), { duration: 20_000 })
    }
    // ZEIT and ORT are mandatory on a Training — the NDS rejects the whole file
    // on an empty cell, and it does so only after the coach has uploaded it.
    if (trainingsMissingOrt.length || trainingsMissingZeit.length) {
      const missing: string[] = []
      if (trainingsMissingOrt.length) missing.push(`${t('missingOrt')}: ${trainingsMissingOrt.join(', ')}`)
      if (trainingsMissingZeit.length) missing.push(`${t('missingZeit')}: ${trainingsMissingZeit.join(', ')}`)
      toast.warning(t('trainingFieldsWarning'), { description: missing.join(' · '), duration: 15_000 })
    }
    if (!participantsMissingJsId.length && !leadersMissingJsId.length) return
    const parts: string[] = []
    if (leadersMissingJsId.length) parts.push(`${t('leaders')}: ${leadersMissingJsId.join(', ')}`)
    if (participantsMissingJsId.length) parts.push(`${t('players')}: ${participantsMissingJsId.join(', ')}`)
    toast.warning(t('missingJsIdWarning'), { description: parts.join(' · '), duration: 12_000 })
  }

  async function handleDownload(team: TeamRow, kind: 'activities' | 'attendance') {
    setBusyKey(`${team.id}:${kind}`)
    try {
      const cacheKey = `${team.id}:${season}:${from}:${to}`
      let data = cacheRef.current.get(cacheKey)
      if (!data) {
        data = await fetchJsExport(team.id, season, { from, to })
        cacheRef.current.set(cacheKey, data)
      }
      surfaceWarnings(data)
      if (kind === 'activities') {
        if (!data.activities.length) { toast.info(t('noActivities')); return }
        downloadJsCsv(jsExportFilename('activities', data.team.name, season), JS_ACTIVITY_HEADERS, activityCsvRows(data.activities))
      } else {
        if (!data.attendance.length) { toast.info(t('noAttendance')); return }
        downloadJsCsv(jsExportFilename('attendance', data.team.name, season), JS_ATTENDANCE_HEADERS, attendanceCsvRows(data.attendance))
      }
    } catch {
      toast.error(t('exportError'))
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('intro')}</p>
      </header>

      <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm text-muted-foreground space-y-2">
        <p className="font-medium text-foreground">{t('howtoTitle')}</p>
        <ol className="list-decimal space-y-1 pl-5">
          <li>{t('howto1')}</li>
          <li>{t('howto2')}</li>
          <li>{t('howto3')}</li>
        </ol>
        <p className="text-xs">{t('formatNote')}</p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="js-season" className="text-sm font-medium text-foreground">{t('season')}</label>
          <select
            id="js-season"
            value={season}
            onChange={(e) => handleSeasonChange(e.target.value)}
            className="rounded-md border border-border bg-background px-3 py-2 text-sm dark:bg-gray-800"
          >
            {seasons.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <DatePicker
            id="js-from"
            label={t('from')}
            value={from}
            max={to}
            onChange={setFrom}
          />
        </div>
        <div className="flex flex-col gap-1">
          <DatePicker
            id="js-to"
            label={t('to')}
            value={to}
            min={from}
            onChange={setTo}
          />
        </div>
        <p className="w-full text-xs text-muted-foreground">{t('dateRangeHint')}</p>
      </div>

      {teamsFetching ? (
        <div className="flex justify-center py-10"><LoadingSpinner /></div>
      ) : teams.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{t('noTeams')}</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('team')}</TableHead>
                <TableHead className="hidden sm:table-cell">{t('sport')}</TableHead>
                <TableHead className="text-right">{t('files')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {teams.map((team) => (
                <TableRow key={team.id}>
                  <TableCell className="font-medium whitespace-normal break-words">{team.name}</TableCell>
                  <TableCell className="hidden sm:table-cell text-muted-foreground">
                    {team.sport === 'volleyball' ? tc('volleyball') : team.sport === 'basketball' ? tc('basketball') : team.sport}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-stretch justify-end gap-2 sm:flex-row sm:items-center">
                      <Button
                        size="sm" variant="outline"
                        loading={busyKey === `${team.id}:activities`}
                        disabled={!!busyKey}
                        onClick={() => handleDownload(team, 'activities')}
                      >
                        <Download className="mr-1 h-4 w-4" />{t('activitiesCsv')}
                      </Button>
                      <Button
                        size="sm" variant="outline"
                        loading={busyKey === `${team.id}:attendance`}
                        disabled={!!busyKey}
                        onClick={() => handleDownload(team, 'attendance')}
                      >
                        <Download className="mr-1 h-4 w-4" />{t('attendanceCsv')}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
