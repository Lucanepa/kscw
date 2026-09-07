import { useState, useMemo, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import ViewToggle from '../../components/ViewToggle'
import SpielplanungFilters from './SpielplanungFilters'
import CalendarView from './CalendarView'
import WeekView from './WeekView'
import ListView from './ListView'
import GameDetailDrawer from './GameDetailDrawer'
import ManualGameModal from './ManualGameModal'
import ImportPanel from './ImportPanel'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../components/ui/collapsible'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select'
import { FileSpreadsheet, ChevronDown, Eye } from 'lucide-react'
import { useSpielplanungData } from './hooks/useSpielplanungData'
import { useAvailableSeasons } from './hooks/useAvailableSeasons'
import { checkConflicts } from './utils/gameConflicts'
import { toast } from 'sonner'
import { useTeams } from '../../hooks/useTeams'
import { useClubBlockedDates } from '../../hooks/useClubBlockedDates'
import { useTeamAbsences } from '../../hooks/useTeamAbsences'
import { useAuth } from '../../hooks/useAuth'
import { useMutation } from '../../hooks/useMutation'
import { buildAbsencesByDate, type AbsentMember } from './utils/absencesByDate'
import { useCrossTeamConflicts } from './hooks/useCrossTeamConflicts'
import { asObj } from '../../utils/relations'
import { startOfMonth, getSeasonYear } from '../../utils/dateUtils'
import { useIsMobile } from '../../hooks/useMediaQuery'
import { useReportPageLoading } from '../../hooks/usePageReady'
import LoadingSpinner from '../../components/LoadingSpinner'
import type { ViewMode, SpielplanungFilterState } from '../../types/calendar'
import type { Game } from '../../types'
import { TourPageButton } from '../guide/TourPageButton'

const VIEW_MODES: ViewMode[] = ['calendar', 'week', 'list-date', 'list-team']

function isViewMode(v: string | null): v is ViewMode {
  return !!v && (VIEW_MODES as string[]).includes(v)
}

function getInitialMonth(): Date {
  const now = new Date()
  const m = now.getMonth()
  if (m >= 8 || m <= 4) return startOfMonth(now)
  return new Date(now.getFullYear(), 8, 1)
}

export default function SpielplanungPage() {
  const { t } = useTranslation('spielplanung')
  const { t: tGs } = useTranslation('gameScheduling')
  const isMobile = useIsMobile()

  // The active tab lives in the URL (`?view=`), so a view is shareable, survives a
  // refresh, and the back button steps between tabs. No local mirror of it — the
  // URL is the single source of truth; an absent/unknown value falls back to the
  // per-device default, and `week` (desktop-only tab) degrades on mobile.
  const [searchParams, setSearchParams] = useSearchParams()
  const viewParam = searchParams.get('view')
  const requestedView: ViewMode = isViewMode(viewParam)
    ? viewParam
    : isMobile
      ? 'list-date'
      : 'calendar'
  const viewMode: ViewMode = isMobile && requestedView === 'week' ? 'list-date' : requestedView

  const setViewMode = useCallback(
    (next: ViewMode) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev)
          params.set('view', next)
          return params
        },
        // Keep other query params (and don't replace — back should undo a tab switch).
        { replace: false },
      )
    },
    [setSearchParams],
  )
  // `?sport=` seeds the sport filter once, on first render only: the scheduling shell's
  // basketball tab links here with `?sport=basketball` (the page is shared by both
  // sports), and a planner who arrives from there wants his own sport, not all of them.
  // Not kept in sync afterwards — the filter bar owns it from that point on.
  const sportParam = searchParams.get('sport')
  const [filters, setFilters] = useState<SpielplanungFilterState>(() => ({
    sport: sportParam === 'basketball' || sportParam === 'volleyball' ? sportParam : 'all',
    selectedTeamIds: [],
    gameType: 'all',
    showAbsences: false,
    showCrossTeam: false,
  }))
  const [month, setMonth] = useState<Date>(getInitialMonth)
  const [weekAnchor, setWeekAnchor] = useState<Date>(() => new Date())
  const [selectedGame, setSelectedGame] = useState<Game | null>(null)
  const [createFor, setCreateFor] = useState<Date | null>(null)
  const [editingGame, setEditingGame] = useState<Game | null>(null)

  const { isAdmin, is_spielplaner, spielplanerTeamIds } = useAuth()
  const { remove: deleteGame, update: updateGame } = useMutation('games')

  const seasonYear = getSeasonYear(month)
  const seasonStart = `${seasonYear}-09-01`
  const seasonEnd = `${seasonYear + 1}-05-31`

  const { games, entries, closedDates, isLoading: dataLoading, error } = useSpielplanungData({
    filters,
    seasonStart,
    seasonEnd,
  })

  const { data: teams, isLoading: teamsLoading } = useTeams()
  const { seasons, isLoading: seasonsLoading } = useAvailableSeasons()

  // Club-wide blackout days (superadmin-set). These are NOT hall closures — they
  // live in scheduling_global_blocks and were invisible on this calendar until
  // 2026-07-14, so a planner could book a home game straight into a blocked day.
  const { blockedDates } = useClubBlockedDates()

  // Wait for ALL primary data before rendering the views: games/closures, the
  // team list (feeds the list views + edit-permission map), and the season list
  // (feeds the season dropdown). Avoids a pop-in where the calendar renders
  // before teams/seasons resolve.
  const isLoading = dataLoading || teamsLoading || seasonsLoading

  // Report to the app boot gate — see usePageReady.tsx
  useReportPageLoading(isLoading)

  const editableTeamIds = useMemo(() => {
    if (isAdmin || is_spielplaner) return (teams ?? []).map((t) => String(t.id))
    return spielplanerTeamIds
  }, [isAdmin, is_spielplaner, spielplanerTeamIds, teams])

  const canCreateManualGames = editableTeamIds.length > 0

  // ── Absence overlay ──────────────────────────────────────────────────
  // Scope absences to whatever the calendar is currently showing: the picked
  // teams, else all teams of the picked sport, else every team. Only fetch when
  // the toggle is on (the hook no-ops on an empty id list).
  const absenceTeamIds = useMemo(() => {
    if (!filters.showAbsences) return []
    if (filters.selectedTeamIds.length > 0) return filters.selectedTeamIds
    const pool = teams ?? []
    const scoped = filters.sport === 'all' ? pool : pool.filter((t) => t.sport === filters.sport)
    return scoped.map((t) => String(t.id))
  }, [filters.showAbsences, filters.selectedTeamIds, filters.sport, teams])

  const { absences, memberTeams, isLoading: absencesLoading } = useTeamAbsences(absenceTeamIds, seasonStart, seasonEnd)

  // An empty `absencesByDate` used to mean three different things — overlay off,
  // still fetching, and genuinely nobody away — and the day cells render the last
  // two identically (no badge at all). Flipping the switch changes no games query
  // key, so the page-level `isLoading` above never fires and the calendar keeps
  // painting a definitively clean month while the absence fetch (up to four
  // sequential round trips, over every team of the sport when no chip is picked)
  // runs. AND with the toggle deliberately: `useTeamAbsences` reports isLoading
  // for one tick even on an empty id list (loadedKey starts undefined while
  // requestedKey is null), which would flash a pending pill on every day cell in
  // the default off state.
  const absencesPending = filters.showAbsences && absencesLoading

  const absencesByDate = useMemo(
    () =>
      filters.showAbsences
        ? buildAbsencesByDate(absences, memberTeams, seasonStart, seasonEnd)
        : new Map<string, AbsentMember[]>(),
    [filters.showAbsences, absences, memberTeams, seasonStart, seasonEnd],
  )

  // ── Cross-team overlay ───────────────────────────────────────────────
  // Days a roster-sharing team plays (those block this team's home slots).
  // Scoped to the picked team(s) — cross-team is inherently per-team, so it needs
  // at least one selected; the hook no-ops on an empty id list.
  const crossTeamTeamIds = useMemo(
    () => (filters.showCrossTeam ? filters.selectedTeamIds : []),
    [filters.showCrossTeam, filters.selectedTeamIds],
  )
  const { byDate: crossTeamByDate, isLoading: crossTeamLoading } = useCrossTeamConflicts(crossTeamTeamIds)
  // Same "empty map means unknown, not none" trap as the absence overlay above.
  // The hook reports isLoading false on an empty id list, so the AND also keeps
  // the pill away from the "toggle on, no team picked" state (which is a real
  // empty, not a pending one).
  const crossTeamPending = filters.showCrossTeam && crossTeamLoading

  // While either overlay is still unknown, withhold the empty-day quick-add "+":
  // booking a home game onto a day whose absence / cross-team answer hasn't
  // landed is exactly the mistake the badges exist to prevent, and nothing
  // downstream (ManualGameModal) re-checks either overlay. The "+" is
  // absolute-positioned and opacity-0 until hover, so dropping it shifts nothing.
  const overlaysPending = absencesPending || crossTeamPending

  function canEditGame(game: Game | null): boolean {
    if (!game) return false
    if (game.source !== 'manual') return false
    const teamRel = asObj<{ id: number | string }>(game.kscw_team)
    const tid = String(teamRel?.id ?? game.kscw_team ?? '')
    return isAdmin || is_spielplaner || spielplanerTeamIds.includes(tid)
  }

  // Short form ("2026/27") — `seasons` comes straight from `games.season`, which
  // the sync sources write short. The long form here made the Select value match
  // no option, so the picker grew a bogus third entry next to the real two.
  const currentSeasonLabel = `${seasonYear}/${String(seasonYear + 1).slice(2)}`

  // Merge the current season into the dropdown so we always have at least one option,
  // even before the games collection resolves.
  const seasonOptions = useMemo(() => {
    const set = new Set<string>([currentSeasonLabel, ...seasons])
    return [...set].sort().reverse()
  }, [seasons, currentSeasonLabel])

  async function handleWeekMove(move: { gameId: string | number; newDate: string; newTime: string }) {
    const game = games.find((g) => String(g.id) === String(move.gameId))
    if (!game) return
    if (game.source !== 'manual') return
    if (!canEditGame(game)) return

    // Dragging in Week view goes through the pure checkConflicts util, which knows
    // nothing about club blackouts — enforce the same hard rule the modal applies.
    if (game.type === 'home' && blockedDates.has(move.newDate)) {
      const reason = blockedDates.get(move.newDate)
      toast.error(
        reason
          ? t('manualGame.conflict.clubBlocked', { reason })
          : t('manualGame.conflict.clubBlockedNoReason'),
      )
      return
    }

    const teamRel = asObj<{ id: number | string }>(game.kscw_team)
    const teamId = String(teamRel?.id ?? game.kscw_team ?? '')
    const hallRel = asObj<{ id: number | string }>(game.hall)
    const hallId = hallRel?.id != null ? String(hallRel.id) : (game.hall as unknown as string) ?? null

    const { errors, warnings } = checkConflicts(
      {
        editingId: game.id,
        kscw_team: teamId,
        hall: hallId,
        date: move.newDate,
        time: move.newTime,
        type: game.type as 'home' | 'away',
      },
      games,
    )

    if (errors.length > 0) {
      const msg = t(`manualGame.conflict.${errors[0].messageKey}`, errors[0].context)
      toast.error(msg)
      return
    }

    try {
      await updateGame(game.id, { date: move.newDate, time: move.newTime })
      if (warnings.length > 0) {
        const msg = t(`manualGame.conflict.${warnings[0].messageKey}`, warnings[0].context)
        toast.warning(msg)
      } else {
        toast.success(t('weekMoveSuccess'))
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(t('weekMoveFailed', { message }))
    }
  }

  function handleSeasonChange(nextSeason: string) {
    // Season format: 'YYYY/YYYY'. Set month to Sep of the start year.
    const startYear = parseInt(nextSeason.split('/')[0] ?? '', 10)
    if (Number.isFinite(startYear)) {
      setMonth(new Date(startYear, 8, 1))
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-gray-900 sm:text-2xl dark:text-gray-100">{t('title')}</h1>
            <TourPageButton />
          </div>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('subtitleSeason', { season: currentSeasonLabel })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={currentSeasonLabel} onValueChange={handleSeasonChange}>
            <SelectTrigger aria-label={t('seasonPicker')} className="h-9 w-[132px] rounded-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {seasonOptions.map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div data-tour="view-toggle"><ViewToggle
            options={[
              { value: 'calendar', label: t('viewCalendar') },
              ...(isMobile ? [] : [{ value: 'week', label: t('viewWeek') }]),
              { value: 'list-date', label: t('viewByDate') },
              { value: 'list-team', label: t('viewByTeam') },
            ]}
            value={viewMode}
            onChange={(v) => setViewMode(v as ViewMode)}
          /></div>
        </div>
      </div>

      {/* Read-only notice — coaches/TRs (v1) can browse but hold no editable
          teams; spielplaners/admins always have editableTeamIds > 0. */}
      {!isLoading && editableTeamIds.length === 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          <Eye className="h-4 w-4 shrink-0" aria-hidden />
          <span>{tGs('plannerReadOnly')}</span>
        </div>
      )}

      {/* Filters */}
      <div data-tour="spielplanung-filters">
        <SpielplanungFilters filters={filters} onChange={setFilters} />
      </div>

      {/* Bulk import (only when the caller can create manual games) */}
      {canCreateManualGames && (
        <Collapsible>
          <CollapsibleTrigger className="group inline-flex items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700">
            <FileSpreadsheet className="h-4 w-4" aria-hidden />
            {t('import.title')}
            <ChevronDown className="h-4 w-4 transition-transform group-data-[state=open]:rotate-180" aria-hidden />
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <ImportPanel editableTeamIds={editableTeamIds} />
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Loading / Error */}
      {isLoading && <LoadingSpinner />}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {t('common:errorLoading')} {error.message}
        </div>
      )}

      {/* Views */}
      {!isLoading && !error && (
        <>
          {viewMode === 'calendar' && (
            <CalendarView
              entries={entries}
              closedDates={closedDates}
              blockedDates={blockedDates}
              month={month}
              onMonthChange={setMonth}
              onGameClick={setSelectedGame}
              onEmptyDayClick={canCreateManualGames && !overlaysPending ? setCreateFor : undefined}
              absencesByDate={absencesByDate}
              crossTeamByDate={crossTeamByDate}
              absencesPending={absencesPending}
              crossTeamPending={crossTeamPending}
            />
          )}
          {viewMode === 'week' && (
            <WeekView
              entries={entries}
              weekStart={weekAnchor}
              onWeekChange={setWeekAnchor}
              onGameClick={setSelectedGame}
              canEdit={canEditGame}
              onMove={handleWeekMove}
              absencesByDate={absencesByDate}
              crossTeamByDate={crossTeamByDate}
              absencesPending={absencesPending}
              crossTeamPending={crossTeamPending}
            />
          )}
          {viewMode === 'list-date' && (
            <ListView games={games} mode="date" teams={teams} />
          )}
          {viewMode === 'list-team' && (
            <ListView games={games} mode="team" teams={teams} />
          )}
        </>
      )}

      <GameDetailDrawer
        game={selectedGame}
        onClose={() => setSelectedGame(null)}
        canEdit={canEditGame(selectedGame)}
        onEdit={(g) => {
          setEditingGame(g)
          setSelectedGame(null)
        }}
        onDelete={async (g) => {
          await deleteGame(g.id)
        }}
      />

      <ManualGameModal
        open={!!createFor || !!editingGame}
        onClose={() => {
          setCreateFor(null)
          setEditingGame(null)
        }}
        initialDate={createFor}
        editingGame={editingGame}
        editableTeamIds={editableTeamIds}
        initialSport={filters.sport}
        initialGameType={filters.gameType}
        initialSelectedTeamIds={filters.selectedTeamIds}
      />
    </div>
  )
}
