import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { CalendarDays, ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { formatDateZurich } from '../../../utils/dateHelpers'
import { useGameSchedulingSeason } from '../hooks/useGameSchedulingSeason'
import { useBasketballPlan, type PlaceGameInput, type HallCell } from '../hooks/useBasketballPlan'
import {
  parseYmd,
  slotsForDate,
  probasketLeagueForTeam,
  AUTOMATIC_SCHEDULING_BB_SOURCE_IDS,
  PROBASKET_KEY_DATES,
  PROBASKET_CONTACT_EMAIL,
  HALL_A,
  HALL_B,
  HALL_AB,
} from '../utils/probasketSeason'
import { exportBasketballAvailability } from '../lib/basketballAvailabilityExport'
import PlaceGameModal from '../components/PlaceGameModal'
import { BasketballCalendarPanel } from './BasketballCalendarPage'
import { useBasketballSlots, type BasketballSlot } from '../hooks/useBasketballSlots'
import type { BasketballSlotPlan, Team } from '../../../types'

// Weekday abbreviation follows the UI language (Sun/Sa/So/…); the full date stays
// Swiss dd.mm.yyyy via formatDateZurich.
const WEEKDAY_LOCALE: Record<string, string> = { en: 'en-GB', de: 'de-CH', fr: 'fr-CH', it: 'it-CH', gsw: 'de-CH' }
function weekday(ymd: string, lang: string): string {
  return new Intl.DateTimeFormat(WEEKDAY_LOCALE[lang] ?? 'de-CH', { weekday: 'short' }).format(parseYmd(ymd))
}

interface ModalSlot {
  date: string
  dow: number
  time: string
  hall: string
  canCombineAB: boolean
  existing: BasketballSlotPlan | null
}

/** One time row of a date card, pre-resolved so the card can decide if anything is placeable. */
interface TimeRow {
  time: string
  cells: HallCell[]
  canCombineAB: boolean
}

export default function BasketballPrepPage() {
  const { t, i18n } = useTranslation('basketballScheduling')
  const { season, allSeasons, isLoading: seasonLoading, setSeason } = useGameSchedulingSeason()

  const [picked, setPicked] = useState<string | number | null>(null)
  // ProBasket publishes a different availability window per LEAGUE, so the grid below
  // belongs to the selected team — the hook needs its bb_source_id as an INPUT while
  // the team list is one of its outputs. Broken with a scalar mirror: the hook renders
  // once with the previous id, the sync below notices the change and it settles on the
  // next render (a plain adjust-state-during-render, no effect, always converges).
  const [bbSourceId, setBbSourceId] = useState<string | number | null>(null)

  const {
    config, candidateDates, teams, dateInfoByDate, blockers, blockedDayReasons,
    placements, availability, availKey, slotView, highlightFor, vbGames, closureEntries,
    fixtures, teamBlockedOn, teamRestBlockedOn, teamHostsOn, setDateUnavailable,
    isLoading, error, placeGame, removeGame,
  } = useBasketballPlan(season, { bbSourceId })

  /** Which date's block toggle is mid-flight, so the button can't be double-fired. */
  const [blockingDate, setBlockingDate] = useState<string | null>(null)

  const teamId =
    picked != null && teams.some((tm) => String(tm.id) === String(picked)) ? picked : teams[0]?.id ?? ''
  const selectedTeam = teams.find((tm) => String(tm.id) === String(teamId)) ?? null
  const wantedBbSourceId = selectedTeam?.bb_source_id ?? null
  if (wantedBbSourceId !== bbSourceId) setBbSourceId(wantedBbSourceId)

  // The GENERATED candidate inventory for the selected team (basketball_slots,
  // migration 278). Read-only here: the grid ranks and explains the suggestions, the
  // Settings page is where they are (re)generated.
  const {
    byTeam: slotsByTeam, suggestionAt, isLoading: slotsLoading, error: slotsError,
  } = useBasketballSlots(season?.id, {
    teamId,
    // No team selected means no grid either — do not pull the whole season's inventory.
    enabled: !!teamId,
  })

  const [modal, setModal] = useState<ModalSlot | null>(null)
  const [exporting, setExporting] = useState(false)
  const [showCalendar, setShowCalendar] = useState(true)

  const teamName = useMemo(() => {
    const m = new Map<string, string>()
    for (const tm of teams) m.set(String(tm.id), tm.name)
    return m
  }, [teams])

  const placementLabel = (p: BasketballSlotPlan): string => {
    const ksc = p.kscw_team ? teamName.get(String(p.kscw_team)) ?? '' : p.kscw_team_label ?? ''
    const opp = p.opponent ?? '?'
    return `${ksc} vs ${opp}`
  }

  // Other placed games within ±3 days of the modal's date — shown for context.
  const nearby = useMemo(() => {
    if (!modal) return []
    const target = parseYmd(modal.date).getTime()
    return [...placements.values()]
      .filter((p) => Math.abs(parseYmd(p.date).getTime() - target) <= 3 * 86400000)
      .filter((p) => !(p.date === modal.date && p.time === modal.time && p.hall === modal.hall))
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
      .map((p) => ({ date: p.date, time: p.time, hall: p.hall, label: placementLabel(p) }))
  }, [modal, placements, teamName])

  // How the selected team's window was resolved — a 'default' league or a 'derived'
  // grid means the dates below are an inference, not an official ProBasket template.
  const leagueSource = probasketLeagueForTeam(selectedTeam?.bb_source_id ?? null).source

  const mySlots = useMemo(
    () => (teamId ? slotsByTeam.get(String(teamId)) ?? [] : []),
    [slotsByTeam, teamId],
  )
  const suggestionCount = useMemo(() => mySlots.filter((s) => s.status === 'available').length, [mySlots])

  const dowByDate = useMemo(() => {
    const m = new Map<string, number>()
    for (const cd of candidateDates) m.set(cd.date, cd.dow)
    return m
  }, [candidateDates])

  /**
   * Suggestions the world has moved past: the generator offered them, but the court is
   * no longer free (a volleyball booking, a closure or a placement landed since), or the
   * TEAM is no longer free (an away fixture, a hand-set block). They are not hidden — a
   * stale count with a "re-generate" hint is honest, silently dropping them would make
   * the inventory look smaller than it is.
   *
   * ⚠ The per-team causes have to be counted here too. The date card for a blocked date
   * does not render at all, so a suggestion sitting on one would otherwise be counted as
   * live while being invisible — the count and the grid must tell the same story.
   */
  const staleCount = useMemo(() => {
    let n = 0
    for (const s of mySlots) {
      if (s.status !== 'available') continue
      const dow = dowByDate.get(s.date)
      if (dow == null) continue
      if (teamId && teamBlockedOn(teamId, s.date)) { n++; continue }
      // The rest gap does not close the date — but the generator would no longer offer it,
      // so a suggestion sitting on one is stale in exactly the same sense.
      if (teamId && teamRestBlockedOn(teamId, s.date)) { n++; continue }
      // Same for a day the team already hosts: every pitch but its own is gone
      // (REJECT_CODES.HOME_GAME). Its own pitch is not stale — that IS the placement.
      const hosts = teamId ? teamHostsOn(teamId, s.date) : null
      if (hosts && !(hosts.time === s.time && hosts.hall === s.hall)) { n++; continue }
      const { cells } = slotView(s.date, dow, s.time)
      const needed = s.hall === HALL_AB ? [HALL_A, HALL_B] : [s.hall]
      const free = needed.every((h) => cells.find((c) => c.hall === h)?.status === 'free')
      if (!free) n++
    }
    return n
  }, [mySlots, dowByDate, slotView, teamId, teamBlockedOn, teamRestBlockedOn, teamHostsOn])

  /** "Why this score": every soft term that produced it, translated, as a tooltip. */
  const scoreTitle = (slot: BasketballSlot): string => {
    const parts = slot.score_reasons.map(
      (r) => `${t(`score_${r.code}`, { defaultValue: r.code })} ${r.delta > 0 ? '+' : ''}${r.delta}`,
    )
    return `${t('whyThisScore')}: ${parts.join(' · ') || '–'}`
  }

  async function doExport(mode: 'team' | 'auto') {
    const exportTeams: Team[] =
      mode === 'team'
        ? teams.filter((tm) => String(tm.id) === String(teamId))
        : teams.filter((tm) =>
            (AUTOMATIC_SCHEDULING_BB_SOURCE_IDS as readonly string[]).includes(String(tm.bb_source_id)),
          )
    if (!exportTeams.length) {
      toast.error(t('exportNoTeams'))
      return
    }
    setExporting(true)
    try {
      await exportBasketballAvailability({
        season, teams: exportTeams, blockers, availability, availKey,
      })
    } catch {
      toast.error(t('exportError'))
    } finally {
      setExporting(false)
    }
  }

  const selectClass = 'rounded-md border border-border bg-transparent px-3 py-2 text-sm dark:bg-gray-800'

  /**
   * Human reason a whole date cannot host a game, named so the planner can act on it.
   *
   * ⚠ The per-TEAM causes come first and are checked against `teamBlockedOn`, which
   * mirrors the generator's two per-team hard rejects. A hall-level reason ("volleyball
   * has the court") would be actively misleading on a date the selected team simply
   * cannot play, and it points at the wrong fix.
   */
  const dateBlockedLabel = (date: string): string => {
    const own = teamId ? teamBlockedOn(teamId, date) : null
    if (own?.reason === 'away_game') {
      return t('reason_away_game', { opponent: own.opponent || '—' })
    }
    if (own?.reason === 'manual') return t('reason_team_blocked')
    const info = dateInfoByDate.get(date)
    switch (info?.reason) {
      case 'blackout':
        return `${t('reason_blackout')}${info.reasonDetail ? ` — ${info.reasonDetail}` : ''}`
      case 'club_block':
        return t('reason_club_block')
      case 'hall_closed':
        return `${t('reason_hall_closed')}${info.reasonDetail ? ` — ${info.reasonDetail}` : ''}`
      case 'volleyball':
        return t('reason_volleyball')
      case 'basketball':
        return t('reason_basketball')
      default:
        return t('statusUnavailable')
    }
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">{t('prepTitle')}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">{t('subtitle')}</p>
      </header>

      {/* The 17-Aug submission deadline + where the workbook goes (document D). */}
      <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
        {t('availabilityDue', {
          date: formatDateZurich(PROBASKET_KEY_DATES.availabilityDue),
          email: PROBASKET_CONTACT_EMAIL,
        })}
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted-foreground">{t('season')}</span>
          <select
            className={selectClass}
            value={season?.id ?? ''}
            onChange={(e) => setSeason(allSeasons.find((s) => String(s.id) === e.target.value) ?? null)}
          >
            {allSeasons.map((s) => (
              <option key={s.id} value={s.id}>{s.season}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted-foreground">{t('team')}</span>
          <select className={selectClass} value={String(teamId)} onChange={(e) => setPicked(e.target.value)}>
            {teams.length === 0 && <option value="">—</option>}
            {teams.map((tm) => (
              <option key={tm.id} value={tm.id}>{tm.name}</option>
            ))}
          </select>
          <span className="max-w-xs text-xs text-muted-foreground">{t('teamDrivesWindow')}</span>
        </label>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => doExport('team')} disabled={exporting || !teamId}>
            {t('exportTeam')}
          </Button>
          <Button variant="outline" onClick={() => doExport('auto')} disabled={exporting}>
            {t('exportAuto')}
          </Button>
        </div>
      </div>

      <p className="max-w-3xl text-xs text-muted-foreground">{t('exportAutoHint')}</p>

      {/* Which ProBasket window the grid below is showing, and how sure we are of it. */}
      {config && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded bg-muted px-2 py-0.5 font-medium">
            {t('windowLabel', { league: config.leagueLabel })}
          </span>
          <span className="text-muted-foreground">
            {formatDateZurich(config.vorrundeStart)} – {formatDateZurich(config.vorrundeEnd)} ·{' '}
            {t('dateCount', { n: candidateDates.length })}
          </span>
          {config.gridSource === 'derived' && (
            <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
              {t('gridDerived')}
            </span>
          )}
          {leagueSource === 'default' && (
            <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
              {t('leagueDefault')}
            </span>
          )}
        </div>
      )}

      {/* Generated candidate slots for the selected team (Settings → Slot generation). */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {/* "None generated" and "could not load" are different facts — a missing
            backend must never read as an empty inventory. */}
        {slotsError ? (
          <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
            {t('backendUnavailable')}
          </span>
        ) : slotsLoading ? null : suggestionCount > 0 ? (
          <span className="rounded bg-indigo-100 px-2 py-0.5 font-medium text-indigo-900 dark:bg-indigo-900/40 dark:text-indigo-200">
            {t('suggestionsFor', { count: suggestionCount, team: selectedTeam?.name ?? '' })}
          </span>
        ) : (
          <span className="text-muted-foreground">{t('suggestionsNone')}</span>
        )}
        {staleCount > 0 && (
          <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
            {t('suggestionsStale', { count: staleCount })}
          </span>
        )}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium text-muted-foreground">{t('legend')}:</span>
        <span className="rounded px-2 py-0.5 bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">{t('statusFree')}</span>
        <span className="rounded px-2 py-0.5 bg-indigo-100 text-indigo-900 dark:bg-indigo-900/40 dark:text-indigo-200">{t('statusSuggested')}</span>
        <span className="rounded px-2 py-0.5 bg-brand-100 text-brand-800 dark:bg-brand-900/40 dark:text-brand-200">{t('statusGame')}</span>
        <span className="rounded px-2 py-0.5 bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">{t('statusVbUsing')}</span>
        <span className="rounded px-2 py-0.5 bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-300">{t('statusUnavailable')}</span>
      </div>

      <p className="text-xs text-amber-700 dark:text-amber-400">⚠ {t('provisional')}</p>

      {/* Season calendar — away games can land almost anywhere, so the planner needs
          the whole month next to the KWI home grid. Collapsible: on a phone the grid
          is the working surface and the calendar is context. */}
      <section className="space-y-3">
        <Button
          variant="outline"
          onClick={() => setShowCalendar((v) => !v)}
          aria-expanded={showCalendar}
          className="min-h-[44px] w-full justify-start gap-2 sm:w-auto"
        >
          <CalendarDays className="h-4 w-4" aria-hidden />
          {t('calendarTitle')}
          {showCalendar ? <ChevronUp className="h-4 w-4" aria-hidden /> : <ChevronDown className="h-4 w-4" aria-hidden />}
        </Button>
        {showCalendar && (
          <BasketballCalendarPanel
            seasonName={season?.season}
            teams={teams}
            placements={placements}
            vbGames={vbGames}
            fixtures={fixtures}
            closureEntries={closureEntries}
            blockedDayReasons={blockedDayReasons}
            onPlacePlacement={placeGame}
            onRemovePlacement={removeGame}
          />
        )}
      </section>

      {seasonLoading || isLoading ? (
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      ) : error ? (
        <p className="text-sm text-rose-600">{String(error.message)}</p>
      ) : !season ? (
        <p className="text-sm text-muted-foreground">{t('noSeason')}</p>
      ) : !config ? (
        <p className="text-sm text-muted-foreground">{t('noConfig', { season: season.season })}</p>
      ) : (
        <div className="space-y-3">
          {candidateDates.map((cd) => {
            const { times } = slotsForDate(cd.dow)
            const rows: TimeRow[] = times.map((time) => ({ time, ...slotView(cd.date, cd.dow, time) }))
            // A date is dead only when NOTHING can be placed AND nothing is placed —
            // an existing game always keeps its card so it stays removable, and a
            // fixture already on that court keeps its card so the planner can SEE what
            // took the day rather than finding it collapsed into "unavailable".
            const anyPlaceable = rows.some((r) =>
              r.cells.some((c) => c.status === 'free' || c.status === 'game' || c.status === 'bbgame'),
            )
            // The selected team's OWN blockers (away fixture / hand-set block). These close
            // the date even when the halls are wide open, because the team is elsewhere.
            const ownBlock = teamId ? teamBlockedOn(teamId, cd.date) : null
            // SOFT: the day either side of one of this team's own games. The card renders
            // and every free pitch stays clickable — only the machine suggestions go
            // (club rule 2026-09-02). Juniors never reach this, the rule exempts them.
            const restGap = !ownBlock && teamId ? teamRestBlockedOn(teamId, cd.date) : null
            // The team already hosts that day → no more suggestions on it (the placement's
            // own pitch is a 'game' cell and never reaches the suggestion branch anyway).
            const hostsToday = !ownBlock && teamId ? teamHostsOn(teamId, cd.date) : null
            /** Toggle the hand-set block. Only offered where it means something. */
            const blockToggle = teamId && !ownBlock?.reason.startsWith('away') ? (
              <Button
                variant="outline"
                size="sm"
                className="ml-auto min-h-9"
                disabled={blockingDate === cd.date}
                onClick={async () => {
                  setBlockingDate(cd.date)
                  try {
                    await setDateUnavailable(teamId, cd.date, ownBlock?.reason !== 'manual')
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : String(err))
                  } finally {
                    setBlockingDate(null)
                  }
                }}
              >
                {ownBlock?.reason === 'manual' ? t('unblockDate') : t('blockDate')}
              </Button>
            ) : null

            if (ownBlock || !anyPlaceable) {
              return (
                <div key={cd.date} className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm opacity-70">
                  <span className="font-medium">{weekday(cd.date, i18n.language)} {formatDateZurich(cd.date)}</span>
                  <span className="rounded px-2 py-0.5 text-xs bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                    {t('statusUnavailable')} — {dateBlockedLabel(cd.date)}
                  </span>
                  {blockToggle}
                </div>
              )
            }
            return (
              <div key={cd.date} className="rounded-lg border border-border">
                <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2 text-sm font-semibold">
                  <span>{weekday(cd.date, i18n.language)} {formatDateZurich(cd.date)}</span>
                  {restGap && (
                    <span
                      title={t('restGapHint', { date: formatDateZurich(restGap.date) })}
                      className="rounded bg-amber-100 px-2 py-0.5 text-xs font-normal text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
                    >
                      {t('restGapBadge')}
                    </span>
                  )}
                  {hostsToday && (
                    <span
                      title={t('hostsTodayHint', {
                        time: hostsToday.time || '—',
                        opponent: hostsToday.opponent || '—',
                      })}
                      className="rounded bg-brand-100 px-2 py-0.5 text-xs font-normal text-brand-800 dark:bg-brand-900/40 dark:text-brand-200"
                    >
                      {t('hostsTodayBadge')}
                    </span>
                  )}
                  {blockToggle}
                </div>
                <div className="divide-y divide-border">
                  {rows.map(({ time, cells, canCombineAB }) => {
                    const hl = highlightFor(teamId, cd.date, time)
                    const hlRing =
                      hl === 'suggest'
                        ? ' ring-2 ring-emerald-500'
                        : hl === 'conflict'
                          ? ' ring-2 ring-amber-500'
                          : ''
                    return (
                      <div key={time} className="flex items-stretch gap-2 px-3 py-2">
                        <span className="flex w-14 shrink-0 items-center text-sm font-medium tabular-nums">
                          {time}
                          {hl === 'suggest' && <span className="ml-1 text-emerald-600" title={t('suggestSameTime')}>★</span>}
                          {hl === 'conflict' && <span className="ml-1 text-amber-600" title={t('conflictTime')}>⚠</span>}
                        </span>
                        <div className="flex flex-1 flex-wrap gap-2">
                          {cells.map((cell) => {
                            const base = 'min-h-[44px] min-w-[9rem] flex-1 rounded-md border px-2 py-1 text-left text-xs'
                            if (cell.status === 'game' && cell.placement) {
                              const p = cell.placement
                              return (
                                <button
                                  key={cell.hall}
                                  type="button"
                                  onClick={() => setModal({ date: cd.date, dow: cd.dow, time, hall: cell.hall, canCombineAB, existing: p })}
                                  className={`${base} border-brand-300 bg-brand-50 text-brand-900 hover:bg-brand-100 dark:border-brand-800 dark:bg-brand-900/40 dark:text-brand-100`}
                                >
                                  <div className="flex items-center justify-between gap-1 font-medium">
                                    <span>{cell.hall}{cell.viaCombined ? ' (A+B)' : ''}</span>
                                    {p.game_type === 'guest' && (
                                      <span className="rounded bg-purple-200 px-1 text-[10px] text-purple-800 dark:bg-purple-900/50 dark:text-purple-200">{t('type_guest')}</span>
                                    )}
                                  </div>
                                  <div className="truncate">{placementLabel(p)}</div>
                                </button>
                              )
                            }
                            // A real game (a `games` fixture, ours) already holds this
                            // court — from the game calendar or from Basketplan, not from
                            // this grid, so it is shown but not clickable. Before
                            // 03.09.2026 the cell said "free" and the ProBasket workbook
                            // offered the court away underneath a game we had already
                            // agreed to play on it.
                            if (cell.status === 'bbgame') {
                              return (
                                <div
                                  key={cell.hall}
                                  title={t('statusBbGameHint', { hall: cell.hall, time })}
                                  aria-disabled="true"
                                  className={`${base} cursor-not-allowed border-brand-300 bg-brand-50 text-brand-900 opacity-80 dark:border-brand-800 dark:bg-brand-900/30 dark:text-brand-100`}
                                >
                                  <div className="font-medium">{cell.hall}</div>
                                  <div className="truncate">{cell.fixture?.label || t('statusBbGame')}</div>
                                </div>
                              )
                            }
                            // Volleyball holds this court around this pitch — shown, not
                            // hidden, so the legend's amber means something and the
                            // planner can see WHY the hall is gone.
                            if (cell.status === 'vb') {
                              return (
                                <div
                                  key={cell.hall}
                                  title={t('statusVbUsingHint', { hall: cell.hall, time })}
                                  aria-disabled="true"
                                  className={`${base} cursor-not-allowed border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300`}
                                >
                                  <div className="font-medium">{cell.hall}</div>
                                  <div className="truncate">{t('statusVbUsing')}</div>
                                </div>
                              )
                            }
                            if (cell.status === 'unavailable') {
                              return (
                                <div
                                  key={cell.hall}
                                  title={dateBlockedLabel(cd.date)}
                                  aria-disabled="true"
                                  className={`${base} cursor-not-allowed border-gray-300 bg-gray-100 text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400`}
                                >
                                  <div className="font-medium">{cell.hall}</div>
                                  <div className="truncate">{t('statusUnavailable')}</div>
                                </div>
                              )
                            }
                            // Free pitch. When the generator offered this exact court to
                            // the selected team, the cell carries its rank and the soft
                            // terms behind it — a hand-placed game (brand colour above)
                            // stays visually distinct from a machine suggestion.
                            const sug = restGap || hostsToday ? null : suggestionAt(cd.date, time, cell.hall)
                            return (
                              <button
                                key={cell.hall}
                                type="button"
                                title={sug ? scoreTitle(sug.slot) : undefined}
                                onClick={() => setModal({ date: cd.date, dow: cd.dow, time, hall: cell.hall, canCombineAB, existing: null })}
                                className={`${base} ${
                                  sug
                                    ? 'border-indigo-300 bg-indigo-50 text-indigo-900 hover:bg-indigo-100 dark:border-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-200'
                                    : 'border-dashed border-emerald-300 bg-emerald-50/50 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-300'
                                }${hlRing}`}
                              >
                                <div className="flex items-center justify-between gap-1 font-medium">
                                  <span>
                                    {cell.hall}
                                    {sug?.combined ? ` → ${HALL_AB}` : ''}
                                  </span>
                                  {sug && (
                                    <span className="rounded bg-indigo-200 px-1 text-[10px] tabular-nums text-indigo-900 dark:bg-indigo-800 dark:text-indigo-100">
                                      {sug.slot.score}
                                    </span>
                                  )}
                                </div>
                                <div className="truncate">
                                  {sug ? `${sug.top ? '★ ' : ''}${t('suggested')}` : `＋ ${t('putGameHere')}`}
                                </div>
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {modal && (
        <PlaceGameModal
          open
          onClose={() => setModal(null)}
          date={modal.date}
          time={modal.time}
          hall={modal.hall}
          canCombineAB={modal.canCombineAB}
          teams={teams}
          existing={modal.existing}
          defaultTeamId={modal.existing ? undefined : (teamId ? String(teamId) : undefined)}
          nearbyGames={nearby}
          onPlace={(hall, input: PlaceGameInput) => placeGame(modal.date, modal.time, hall, input)}
          onRemove={modal.existing ? () => removeGame(modal.existing!.id) : undefined}
        />
      )}
    </div>
  )
}
