import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { House, Pencil, Plane, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import CalendarGrid from '../../../components/CalendarGrid'
import Modal from '../../../components/Modal'
import { Button } from '../../../components/ui/button'
import { useConfirm } from '../../../components/ConfirmProvider'
import { useMutation } from '../../../hooks/useMutation'
import ManualGameModal from '../../spielplanung/ManualGameModal'
import PlaceGameModal from '../components/PlaceGameModal'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../components/ui/table'
import { toDateKey, getSeasonYear } from '../../../utils/dateUtils'
import { formatDateZurich } from '../../../utils/dateHelpers'
import { useGameSchedulingSeason } from '../hooks/useGameSchedulingSeason'
import { useBasketballPlan, type BbFixture, type PlaceGameInput } from '../hooks/useBasketballPlan'
import { parseYmd } from '../utils/probasketSeason'
import type { BasketballSlotPlan, Game, Team } from '../../../types'

// One thing shown on a calendar day: a basketball PLACEMENT (home/guest, from
// basketball_slot_plan), a basketball FIXTURE of either side (from `games`), or a
// cross-sport volleyball home game (venue coordination). Hall closures render as the
// grid's red day background, not as items.
//
// ⚠ The two basketball kinds are two different tables on purpose — see the fixturesQ
// comment in useBasketballPlan. A placement is the planner's own draft on a KWI court
// and is edited in the prep grid; a fixture is the real game, editable right here.
// An AWAY fixture holds no KWI court, so its `hall` is the opponent's venue (often
// blank) and it must never be styled or counted as an occupied pitch.
type CalItem =
  | { id: string; kind: 'bb'; time: string; hall: string; label: string; guest: boolean; placement: BasketballSlotPlan }
  | { id: string; kind: 'fixture'; time: string; hall: string; label: string; fixture: BbFixture }
  | { id: string; kind: 'vb'; time: string; hall: string }

export interface BasketballCalendarPanelProps {
  /** Season name ('2026/27') — drives the month range the calendar navigates. */
  seasonName?: string | null
  teams: Team[]
  placements: Map<string, BasketballSlotPlan>
  /** Booked volleyball slots — cross-sport hall coordination. */
  vbGames: { date: string; time: string; hall: string }[]
  /**
   * Basketball fixtures from `games`, both sides. An away one holds no court but does
   * hold the date; a home one holds a KWI floor (migration 351) and, until 03.09.2026,
   * was not rendered here at all.
   */
  fixtures?: BbFixture[]
  closureEntries: { start: string; end: string; hall: string | null; reason: string }[]
  /** date → "no game may be played" reason (ProBasket blackout / club-wide block). */
  blockedDayReasons?: Map<string, string>
  /**
   * Placement writers. When passed, a placed game can be edited and removed from this
   * panel — without them the day panel only said "Edit in the planner" and did nothing,
   * reported 06.09.2026 as *"it says edit game in planner but it doesnt let it edit"*.
   */
  onPlacePlacement?: (date: string, time: string, hall: string, input: PlaceGameInput) => Promise<void>
  onRemovePlacement?: (id: string | number) => Promise<void>
}

/**
 * The basketball season calendar: placed games + volleyball home games + hall
 * closures + blocked days on the shared `CalendarGrid`.
 *
 * Extracted from the standalone page so the prep view can show the same calendar
 * beside its slot grid — away games can be placed almost anywhere, so a planner
 * needs the whole month, not just the KWI home pitches.
 */
export function BasketballCalendarPanel({
  seasonName, teams, placements, vbGames, fixtures = [], closureEntries, blockedDayReasons,
  onPlacePlacement, onRemovePlacement,
}: BasketballCalendarPanelProps) {
  const { t } = useTranslation('basketballScheduling')
  const confirm = useConfirm()
  const { remove: removeGame } = useMutation('games')

  const teamName = useCallback(
    (id: string | number | null | undefined, label?: string | null) =>
      (id != null ? teams.find((tm) => String(tm.id) === String(id))?.name : label) ?? label ?? '',
    [teams],
  )

  // Season start year drives the initial month + the Sep→May navigation clamp.
  const startYear = useMemo(() => {
    const y = parseInt(String(seasonName ?? '').slice(0, 4), 10)
    return Number.isFinite(y) ? y : getSeasonYear(new Date())
  }, [seasonName])
  const firstMonth = useMemo(() => new Date(startYear, 8, 1), [startYear]) // September
  // The 1.-Liga grid runs to 09.05.2027, so the calendar must reach May — clamping
  // at March hid the second half of the senior season entirely.
  const lastMonth = useMemo(() => new Date(startYear + 1, 4, 1), [startYear]) // May
  const [month, setMonth] = useState(() => new Date(startYear, 8, 1))
  const goMonth = (d: Date) => setMonth(d < firstMonth ? firstMonth : d > lastMonth ? lastMonth : d)

  // Games (bb + vb) keyed by the same date key CalendarGrid computes per cell.
  const itemsByDate = useMemo(() => {
    const m = new Map<string, CalItem[]>()
    const push = (dateStr: string, item: CalItem) => {
      const d = parseYmd(dateStr)
      if (!d) return
      const k = toDateKey(d)
      const arr = m.get(k) ?? []
      arr.push(item)
      m.set(k, arr)
    }
    for (const p of placements.values()) {
      push(p.date, {
        id: `bb-${p.id}`, kind: 'bb', time: p.time, hall: p.hall,
        label: `${teamName(p.kscw_team, p.kscw_team_label)} vs ${p.opponent ?? '?'}`,
        guest: p.game_type === 'guest',
        placement: p,
      })
    }
    for (const g of fixtures) {
      push(g.date, {
        id: `fx-${g.id}`, kind: 'fixture', time: g.time,
        // Our hall for a home game; the opponent's gym for an away one, when the fixture
        // carries one. Blank is normal and honest — a bilaterally agreed away game often
        // has no venue typed in yet.
        hall: g.venue,
        label: g.type === 'home'
          ? `${teamName(g.team, null)} vs ${g.opponent || '?'}`
          : `${teamName(g.team, null)} @ ${g.opponent || '?'}`,
        fixture: g,
      })
    }
    for (const g of vbGames) push(g.date, { id: `vb-${g.date}-${g.time}-${g.hall}`, kind: 'vb', time: g.time, hall: g.hall })
    // Sort each day's items by time.
    for (const arr of m.values()) arr.sort((a, b) => a.time.localeCompare(b.time))
    return m
  }, [placements, vbGames, fixtures, teamName])

  // Hall closures → red day background + a per-day reason, expanding each range.
  const { closedDates, closureReasons } = useMemo(() => {
    const dates = new Set<string>()
    const reasons = new Map<string, string>()
    for (const c of closureEntries) {
      const start = parseYmd(c.start)
      const end = parseYmd(c.end)
      if (!start || !end) continue
      for (let d = new Date(start), guard = 0; d <= end && guard < 400; d.setDate(d.getDate() + 1), guard++) {
        const k = toDateKey(d)
        dates.add(k)
        const label = [c.hall, c.reason].filter(Boolean).join(' — ')
        if (label && !reasons.has(k)) reasons.set(k, label)
      }
    }
    return { closedDates: dates, closureReasons: reasons }
  }, [closureEntries])

  const [dayDetail, setDayDetail] = useState<{ date: Date; items: CalItem[] } | null>(null)
  /** The date an away game is being added for — drives ManualGameModal. */
  const [addAwayOn, setAddAwayOn] = useState<Date | null>(null)
  /** The fixture being corrected — the same modal, in edit mode. */
  const [editingGame, setEditingGame] = useState<Game | null>(null)
  /** The PLACEMENT being edited — a different table, so a different modal. */
  const [editingPlacement, setEditingPlacement] = useState<BasketballSlotPlan | null>(null)
  /** id of the fixture whose delete is in flight, so the button cannot be double-fired. */
  const [deletingId, setDeletingId] = useState<string | null>(null)

  /**
   * Delete a fixture, after asking.
   *
   * Closes the day panel afterwards: its `items` were captured when the day was opened,
   * so leaving it up would show the row that no longer exists.
   */
  async function handleDelete(fx: BbFixture) {
    if (!(await confirm({ message: t('deleteFixtureConfirm', { opponent: fx.opponent || '—' }), danger: true }))) return
    setDeletingId(fx.id)
    try {
      await removeGame(fx.id)
      setDayDetail(null)
      toast.success(t('deleteFixtureDone'))
    } catch {
      toast.error(t('saveError'))
    } finally {
      setDeletingId(null)
    }
  }

  /**
   * Every active basketball team. Reaching this page already means `canManageBb`
   * (admin / superuser / bb_admin / club-wide Spielplaner), and that gate is club-wide
   * for basketball by design — so the editable set is simply "all of them" rather than a
   * narrower per-team scope that would not match the page the button sits on.
   */
  const editableTeamIds = useMemo(() => teams.map((tm) => String(tm.id)), [teams])

  return (
    <div className="space-y-3">
      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded bg-brand-500" />{t('type_home')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded bg-purple-500" />{t('type_guest')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded bg-blue-500" />{t('type_away')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded bg-amber-400" />{t('homeGameVb')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded bg-red-200 dark:bg-red-900" />{t('closedLabel')}
        </span>
        {blockedDayReasons && blockedDayReasons.size > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded bg-red-400 dark:bg-red-700" />{t('blockedLabel')}
          </span>
        )}
      </div>

      <div className="rounded-lg border border-border bg-white p-2 sm:p-4 dark:bg-gray-800">
        {/* The month grid is 7 columns wide — let it scroll inside its own box on a
            narrow phone instead of widening the page. */}
        <div className="overflow-x-auto">
          <div className="min-w-[19rem]">
            <CalendarGrid<CalItem>
              month={month}
              onMonthChange={goMonth}
              minMonth={firstMonth}
              maxMonth={lastMonth}
              itemsByDate={itemsByDate}
              closedDates={closedDates}
              closedLabel={t('closedLabel')}
              closureReasons={closureReasons}
              blockedDates={blockedDayReasons}
              blockedLabel={t('blockedLabel')}
              // ⚠ NO early return on an empty day. CalendarGrid paints every in-month,
              // in-season cell as clickable (pointer + hover) the moment a handler is
              // passed, so refusing to act on the empty ones made ~200 days advertise a
              // click that did nothing — reported 31.08.2026 as "the icon switches when I
              // hover but it doesn't do anything when I click". Every day now opens the
              // same panel; an empty one says so and offers the away-game form.
              onDayClick={(date, items) => setDayDetail({ date, items })}
              renderDayContent={(_date, items) => (
                <div className="flex flex-col gap-0.5">
                  {items.slice(0, 3).map((it) => (
                    <span
                      key={it.id}
                      title={it.kind === 'vb'
                        ? `${it.time} · ${it.hall} · ${t('homeGameVb')}`
                        : `${it.time} · ${it.hall || (it.kind === 'fixture' && it.fixture.type === 'away' ? t('type_away') : '—')} · ${it.label}`}
                      className={`flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] leading-tight ${
                        it.kind === 'vb'
                          ? 'bg-amber-200 text-amber-900 dark:bg-amber-900/50 dark:text-amber-200'
                          : it.kind === 'fixture'
                            ? it.fixture.type === 'away'
                              ? 'bg-blue-500 text-white'
                              : 'bg-brand-500 text-white'
                            : it.guest
                              ? 'bg-purple-500 text-white'
                              : 'bg-brand-500 text-white'
                      }`}
                    >
                      {it.time && <span className="shrink-0 tabular-nums">{it.time}</span>}
                      {it.kind === 'bb' && !it.guest && <House className="h-2.5 w-2.5 shrink-0" aria-hidden />}
                      {it.kind === 'fixture' && (
                        it.fixture.type === 'away'
                          ? <Plane className="h-2.5 w-2.5 shrink-0" aria-hidden />
                          : <House className="h-2.5 w-2.5 shrink-0" aria-hidden />
                      )}
                      <span className="truncate">{it.kind === 'vb' ? t('homeGameVb') : it.label}</span>
                    </span>
                  ))}
                  {items.length > 3 && (
                    <span className="text-[10px] text-gray-500 dark:text-gray-400">+{items.length - 3}</span>
                  )}
                </div>
              )}
            />
          </div>
        </div>
      </div>

      {/* Day-detail modal */}
      <Modal
        open={!!dayDetail}
        onClose={() => setDayDetail(null)}
        title={dayDetail ? formatDateZurich(toDateKey(dayDetail.date)) : ''}
        size="lg"
      >
        {dayDetail && (
          <div className="space-y-4">
            {dayDetail.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('dayEmpty')}</p>
            ) : (
              <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('colTime')}</TableHead>
                  <TableHead>{t('colHall')}</TableHead>
                  <TableHead>{t('colMatch')}</TableHead>
                  <TableHead className="text-right">{t('colActions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dayDetail.items.map((it) => (
                  <TableRow key={it.id}>
                    <TableCell className="whitespace-nowrap tabular-nums">{it.time || '—'}</TableCell>
                    <TableCell className="whitespace-normal break-words">{it.hall || '—'}</TableCell>
                    <TableCell className="whitespace-normal break-words">
                      {it.kind === 'fixture' ? (
                        <span className="inline-flex flex-wrap items-center gap-2">
                          <span
                            className={`rounded px-2 py-0.5 text-xs ${
                              it.fixture.type === 'away'
                                ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200'
                                : 'bg-brand-100 text-brand-800 dark:bg-brand-900/40 dark:text-brand-200'
                            }`}
                          >
                            {it.fixture.type === 'away' ? t('type_away') : t('type_home')}
                          </span>
                          {it.label}
                        </span>
                      ) : it.kind === 'bb' ? (
                        <span className="inline-flex flex-wrap items-center gap-2">
                          <span
                            className={`rounded px-2 py-0.5 text-xs ${
                              it.guest
                                ? 'bg-purple-200 text-purple-800 dark:bg-purple-900/50 dark:text-purple-200'
                                : 'bg-brand-100 text-brand-800 dark:bg-brand-900/40 dark:text-brand-200'
                            }`}
                          >
                            {it.guest ? t('type_guest') : t('type_home')}
                          </span>
                          {it.label}
                        </span>
                      ) : (
                        <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                          {t('homeGameVb')}
                        </span>
                      )}
                    </TableCell>
                    {/* Only a `games` fixture is editable from here. A placement belongs
                        to the prep grid (its date/time/hall ARE its identity) and a
                        volleyball booking to the volleyball side — saying so beats an
                        edit button that opens the wrong editor. */}
                    <TableCell className="whitespace-normal break-words text-right">
                      {it.kind === 'fixture' ? (
                        <span className="flex flex-col items-stretch justify-end gap-1 sm:flex-row sm:items-center">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="min-h-11 sm:min-h-9"
                            onClick={() => { setEditingGame(it.fixture.game); setDayDetail(null) }}
                          >
                            <Pencil className="h-4 w-4" aria-hidden /> {t('editFixture')}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={deletingId === it.fixture.id}
                            className="min-h-11 text-red-600 hover:text-red-700 sm:min-h-9 dark:text-red-400"
                            onClick={() => void handleDelete(it.fixture)}
                          >
                            <Trash2 className="h-4 w-4" aria-hidden /> {t('deleteFixture')}
                          </Button>
                        </span>
                      ) : it.kind === 'bb' && onPlacePlacement ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="min-h-11 sm:min-h-9"
                          onClick={() => { setEditingPlacement(it.placement); setDayDetail(null) }}
                        >
                          <Pencil className="h-4 w-4" aria-hidden /> {t('editFixture')}
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {it.kind === 'bb' ? t('editInPrepGrid') : '—'}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
              </div>
            )}

            {/* The one thing a planner cannot do anywhere else in this section: record a
                game agreed bilaterally at the OPPONENT's gym. It holds no KWI court, so it
                is not a placement — it is a `games` fixture, and from here it also closes
                the date for that team in the slot grid and the generator. */}
            <div className="flex justify-end">
              <Button className="min-h-11" onClick={() => setAddAwayOn(dayDetail.date)}>
                <Plus className="h-4 w-4" aria-hidden /> {t('addAwayGame')}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* One modal, two jobs: add (a date, seeded away) and correct (a whole fixture —
          side, date, time, hall and opponent all editable). */}
      <ManualGameModal
        open={!!addAwayOn || !!editingGame}
        onClose={() => { setAddAwayOn(null); setEditingGame(null) }}
        editableTeamIds={editableTeamIds}
        initialDate={addAwayOn}
        editingGame={editingGame}
        initialSport="basketball"
        initialGameType="away"
      />

      {/* A placement lives in `basketball_slot_plan`, keyed by (date, time, hall) — so this
          modal edits the team, opponent, type and note, and can remove it. Moving it to
          another pitch is still remove-then-place, in the prep grid. */}
      {editingPlacement && onPlacePlacement && (
        <PlaceGameModal
          open
          onClose={() => setEditingPlacement(null)}
          date={editingPlacement.date}
          time={editingPlacement.time}
          hall={editingPlacement.hall}
          // The panel does not resolve pitch availability, so the A+B toggle is offered
          // only to a placement that already holds the combined court (PlaceGameModal's
          // own `canBeCombined` keeps that case alive).
          canCombineAB={false}
          teams={teams}
          existing={editingPlacement}
          onPlace={(hall, input) => onPlacePlacement(editingPlacement.date, editingPlacement.time, hall, input)}
          onRemove={onRemovePlacement ? async () => { await onRemovePlacement(editingPlacement.id); setEditingPlacement(null) } : undefined}
        />
      )}
    </div>
  )
}

/**
 * Standalone full-width calendar route (`/admin/terminplanung/basketball/calendar`).
 *
 * KEPT even though the prep page now embeds the same panel: the prep page's copy is a
 * collapsible side-panel next to the slot grid, while this route gives the month the
 * full viewport — which is what you want on a phone, and it is already a nav tab and a
 * bookmarkable deep link.
 */
export default function BasketballCalendarPage() {
  const { t } = useTranslation('basketballScheduling')
  const { season, allSeasons, setSeason } = useGameSchedulingSeason()
  const {
    teams, placements, vbGames, fixtures, closureEntries, blockedDayReasons, placeGame, removeGame,
  } = useBasketballPlan(season)

  const selectClass = 'rounded-md border border-border bg-transparent px-3 py-2 text-sm dark:bg-gray-800'

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-2xl font-bold">{t('calendarTitle')}</h1>
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
      </header>

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
    </div>
  )
}
