import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2, Sparkles, Trash2 } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../components/ui/table'
import { useConfirm } from '../../../components/ConfirmProvider'
import type { BasketballGenerateResult, BasketballSlot } from '../hooks/useBasketballSlots'
import type { BasketballTeamRule } from '../utils/basketballRules'
import { homeGamesFor } from '../utils/bbHomeGames'
import type { Team } from '../../../types'

/**
 * Basketball slot generation — the counterpart of volleyball's `SlotGenerationPanel`.
 *
 * Two deliberate differences from volleyball:
 *  · NOT gated on `season.status === 'open'`. Prod's only season row is 2026/27 with
 *    status 'closed' and basketball has no invite-close lifecycle, so that gate would
 *    ship a permanently disabled button.
 *  · The generator explains itself: every candidate carries a score and the soft terms
 *    that produced it, and every rejected candidate is counted by reason. Both are
 *    surfaced here, because a black-box inventory is one nobody trusts enough to use.
 */

interface Props {
  teams: Team[]
  rulesByTeam: Map<string, BasketballTeamRule>
  slots: BasketballSlot[]
  availableByTeam: Map<string, number>
  generating: boolean
  clearing: boolean
  result: BasketballGenerateResult | null
  disabled?: boolean
  onGenerate: () => Promise<BasketballGenerateResult | null>
  onClear: () => Promise<{ deleted: number } | null>
}

/**
 * The reject codes the endpoint emits (kscw-endpoints/src/basketball-slots.js REJECT_CODES).
 * Tie-break order only — the count sorts first.
 *
 * ⚠ Every code here needs a matching `reject_<code>` key in all five locales, or the raw
 * key renders in the table. `not_a_spielsamstag` shipped in migration 285 without either
 * and leaked "reject_not_a_spielsamstag · 196" into the UI; the locale parity check could
 * not catch it because the key was missing from every locale equally.
 * Guarded by directus/scripts/__tests__/basketball-reject-codes.test.mjs.
 */
const REJECT_ORDER = [
  'day_not_allowed',
  'category_not_allowed',
  'start_window',
  'blocked_rule',
  'not_a_spielsamstag',
  'blackout_sperr',
  'blackout_ferien',
  'club_block',
  'hall_closed',
  'hall_not_allowed',
  'volleyball',
  'team_unavailable',
  'away_game',
  'home_game',
  'adjacent_game',
  'pitch_taken',
  'partner_same_time',
]

export default function BasketballSlotGenerationPanel({
  teams,
  rulesByTeam,
  slots,
  availableByTeam,
  generating,
  clearing,
  result,
  disabled,
  onGenerate,
  onClear,
}: Props) {
  const { t } = useTranslation('basketballScheduling')
  const confirm = useConfirm()

  const hasSlots = slots.length > 0
  /**
   * Mirrors the endpoint's own loop (`basketball-slots.js` → POST generate): EVERY active
   * team is planned — against its rules row if it has one, "open to all" if it has none.
   * Only an explicit `enabled = false` opts a team out.
   *
   * ⚠ Do not narrow this back to `rule?.enabled` — that was the old "no row = skipped"
   * model, and it disabled the Generate button for teams the generator plans regardless.
   */
  const plannedTeams = useMemo(
    () => teams.filter((tm) => {
      const rule = rulesByTeam.get(String(tm.id))
      return !rule || rule.enabled
    }),
    [teams, rulesByTeam],
  )
  const openTeams = useMemo(
    () => teams.filter((tm) => !rulesByTeam.get(String(tm.id))),
    [teams, rulesByTeam],
  )

  const perTeamResult = useMemo(() => {
    const m = new Map<string, BasketballGenerateResult['per_team'][number]>()
    for (const r of result?.per_team ?? []) m.set(String(r.team), r)
    return m
  }, [result])

  /**
   * Every active team gets a row, including the ones with no rules. They used to be
   * filtered out until they happened to have slots, which hid exactly the teams the
   * operator most needs to see the numbers for.
   */
  const rows = useMemo(
    () =>
      teams.map((tm) => ({
        team: tm,
        rule: rulesByTeam.get(String(tm.id)) ?? null,
        available: availableByTeam.get(String(tm.id)) ?? 0,
        run: perTeamResult.get(String(tm.id)) ?? null,
        // Demand side: how many of those slots actually have to be filled (Hin+Rück).
        home: homeGamesFor(tm.bb_source_id),
      })),
    [teams, rulesByTeam, availableByTeam, perTeamResult],
  )

  const totalAvailable = useMemo(
    () => slots.filter((s) => s.status === 'available').length,
    [slots],
  )

  async function handleGenerate() {
    if (hasSlots && !(await confirm({ message: t('regenerateConfirm'), danger: true }))) return
    try {
      const res = await onGenerate()
      if (res) toast.success(t('slotsGenerated', { created: res.created, updated: res.updated, deleted: res.deleted }))
    } catch (err) {
      const body = (err as { body?: { error?: string } }).body
      toast.error(body?.error === 'no_teams' ? t('generateNoTeams') : t('generateError'))
    }
  }

  async function handleClear() {
    if (!(await confirm({ message: t('clearSlotsConfirm'), danger: true }))) return
    try {
      const res = await onClear()
      toast.success(t('slotsCleared', { count: res?.deleted ?? 0 }))
    } catch {
      toast.error(t('generateError'))
    }
  }

  /** The three reject reasons that removed the most candidates for a team. */
  const topRejects = (rejects: Record<string, number>): { code: string; n: number }[] =>
    Object.entries(rejects ?? {})
      .map(([code, n]) => ({ code, n: Number(n) }))
      .sort((a, b) => b.n - a.n || REJECT_ORDER.indexOf(a.code) - REJECT_ORDER.indexOf(b.code))
      .slice(0, 3)

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 sm:p-6 dark:border-gray-700 dark:bg-gray-800">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('generateTitle')}</h2>
      <p className="mt-1 mb-4 max-w-3xl text-xs text-gray-500 dark:text-gray-400">{t('generateHint')}</p>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleGenerate}
          disabled={disabled || generating || clearing || plannedTeams.length === 0}
          className={`min-h-11 shrink-0 rounded-md px-6 py-2.5 text-sm font-medium disabled:opacity-50 ${
            hasSlots ? 'bg-gold-400 text-brand-900 hover:bg-gold-500' : 'bg-green-600 text-white hover:bg-green-700'
          }`}
        >
          {generating ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {t('generatingSlots')}
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <Sparkles className="h-4 w-4" aria-hidden /> {hasSlots ? t('regenerateSlots') : t('generateSlots')}
            </span>
          )}
        </button>

        {hasSlots && (
          <Button
            variant="outline"
            className="min-h-11 text-rose-600"
            disabled={disabled || generating || clearing}
            onClick={handleClear}
          >
            <Trash2 className="h-4 w-4" aria-hidden /> {clearing ? t('clearingSlots') : t('clearSlots')}
          </Button>
        )}

        {hasSlots && (
          <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">
            {t('slotsTotal', { count: totalAvailable })}
          </span>
        )}
      </div>

      {plannedTeams.length === 0 && (
        <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
          {t('generateNoEnabledTeams')}
        </p>
      )}
      {/* Informational, not a warning: an open team is a planned team. */}
      {openTeams.length > 0 && (
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
          {t('generateOpenTeams', { teams: openTeams.map((tm) => tm.name).join(', ') })}
        </p>
      )}

      {result && (
        <div className="mt-3 rounded-md bg-green-50 p-3 text-sm text-green-800 dark:bg-green-900/30 dark:text-green-300">
          {t('slotsGenerated', { created: result.created, updated: result.updated, deleted: result.deleted })}
        </div>
      )}

      {rows.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-200">{t('perTeamTitle')}</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('colTeam')}</TableHead>
                <TableHead>{t('colAvailable')}</TableHead>
                <TableHead>{t('colHomeGames')}</TableHead>
                <TableHead className="hidden sm:table-cell">{t('colCandidates')}</TableHead>
                <TableHead className="hidden lg:table-cell">{t('colTopRejects')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ team, rule, available, run, home }) => (
                <TableRow key={team.id} className={rule?.enabled === false ? 'opacity-60' : undefined}>
                  <TableCell className="whitespace-normal break-words font-medium">
                    {team.name}
                    {!rule && (
                      <span className="ml-2 rounded bg-sky-100 px-1.5 py-0.5 text-[11px] text-sky-900 dark:bg-sky-900/40 dark:text-sky-200">
                        {t('openToAll')}
                      </span>
                    )}
                    {rule && !rule.enabled && (
                      <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                        {t('ruleOff')}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums font-semibold">{available}</TableCell>
                  {/* Demand, not supply — a dash means "we refuse to guess", never "zero". */}
                  <TableCell className="tabular-nums">
                    {home.count !== null ? (
                      <span title={t('homeGamesBasis', { games: home.gamesTotal, group: home.groupCode })}>
                        {home.count}
                        {home.approximate && '–' + (home.count + 1)}
                      </span>
                    ) : (
                      <span
                        className="text-gray-400 dark:text-gray-500"
                        title={t(`homeGamesUnknown_${home.reason ?? 'no_group'}`)}
                      >
                        –
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="hidden tabular-nums sm:table-cell">
                    {run ? t('keptOfCandidates', { kept: run.kept, candidates: run.candidates }) : '–'}
                  </TableCell>
                  <TableCell className="hidden whitespace-normal break-words text-xs lg:table-cell">
                    {run ? (
                      <span className="flex flex-wrap gap-1">
                        {topRejects(run.rejects).map((r) => (
                          <span key={r.code} className="rounded bg-gray-100 px-1.5 py-0.5 dark:bg-gray-700">
                            {t(`reject_${r.code}`)} · {r.n}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="text-gray-400 dark:text-gray-500">{t('rejectsAfterRun')}</span>
                    )}
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
