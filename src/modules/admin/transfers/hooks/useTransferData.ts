/**
 * Every query and every derivation `/admin/transfers` renders from.
 *
 * The page reads five registers and reconciles them: the club's own roster
 * (`teams` + `member_teams`), the member register (`members`), FIVB's federation
 * directory and transfer records (`vis_federations`, `vis_transfers`) and Swiss
 * Volley's Volleymanager licence list (`sv_vm_check`). Everything a view needs is
 * derived ONCE here and handed down, so no component can re-derive a cohort or a
 * state for itself and disagree with the numbers bar.
 *
 * ⚠ The query ORDER below is load-bearing: the second `sv_vm_check` query is
 * filtered by the licence numbers of the cohorts the first six produce.
 */

import { useCallback, useMemo } from 'react'
import { useCollection } from '../../../../lib/query'
import { countryFlag, countryLabel, parseCountryCodes } from '../../../../utils/countries'
import { federationDisplay } from '../../../../utils/federations'
import { MEMBER_FIELDS, SPORT } from '../constants'
import {
  buildCohorts, countHidden, countVisPresence, findFooConflicts, groupRows, newestVisCheck,
} from '../utils/cohorts'
import {
  indexSportsByMember, indexTeamNamesByMember, indexTeams, u20OnlyMemberIds,
} from '../utils/rosterIndex'
import { countByState, isDisputed, rowStateOf } from '../utils/rowState'
import {
  indexVisTransfersByPlayer, latestVisSeason, normaliseVisPlayerNo, pickVisTransfer,
} from '../utils/visTransfer'
import {
  indexFederationsByIso, indexIsoByFivbCode, indexVmLicences, indexVmRows, playsAsSwiss,
  validationStateOf, vmMatchKeys,
} from '../utils/vmMatch'
import type { MemberTeam, Team } from '../../../../types'
import type {
  FooConflict, HiddenCounts, RowState, TransferCohorts, TransferDerivations, TransferGroup,
  TransferMember, VisFederation, VisPresenceCounts, VisTransfer, VmRow,
} from '../types'

/**
 * The unfiltered `sv_vm_check` projection. `association_id` is an INTEGER
 * column, but `fetchItems` stringifies every integer that is not in
 * `KEEP_AS_NUMBER` (src/lib/api.ts) — the union says so rather than letting a
 * future `=== 12345` look correct.
 */
interface VmLicenceRow {
  association_id: number | string
  nationality_code: string | null
}

export interface TransferData {
  bootLoading: boolean
  /**
   * The two `sv_vm_check` reads have not landed yet. Every figure derived from
   * `validationStateOf` / `vmSaysSwiss` is provisional while this is true — see
   * the note where it is computed.
   */
  crossChecksLoading: boolean
  isFetching: boolean
  refetch: () => Promise<unknown>
  cohorts: TransferCohorts
  hidden: HiddenCounts
  fooConflicts: FooConflict[]
  visCountsByGroupKey: (rows: readonly TransferMember[]) => VisPresenceCounts
  stateCounts: Record<RowState, number>
  lastVisCheck: string | null
  blockedRows: TransferMember[]
  needsGroups: TransferGroup[]
  clarifyGroups: TransferGroup[]
  swissGroups: TransferGroup[]
  notNeededGroups: TransferGroup[]
  derivations: TransferDerivations
}

export function useTransferData(): TransferData {
  // ── Roster ────────────────────────────────────────────────────────
  // Sport membership is derived from the member's teams. Teams are fetched
  // WITHOUT the `active` filter on purpose: a player parked on an archived team
  // still plays that sport, and dropping them would silently hide a transfer.
  // `active` is selected but deliberately NOT filtered on: the two derivations
  // below need opposite scopes. Sport must survive an archived team; the
  // displayed team NAMES must not (`teamNamesByMember`).
  const { data: teamsRaw } = useCollection<Team>('teams', {
    fields: ['id', 'sport', 'name', 'active'],
    all: true,
    staleTime: 60_000,
  })
  const teams = useMemo(() => teamsRaw ?? [], [teamsRaw])
  const { teamIds, sportByTeam, nameByTeam, activeTeamIds } = useMemo(
    () => indexTeams(teams),
    [teams],
  )

  // ⚠ SINGLE-LEVEL junction fetch, then bucket in memory. Never
  // `members: { member_teams: { team: { sport: … } } }` — combining a frontend
  // filter that walks an M2M alias with a policy filter that walks the SAME
  // alias makes Directus return `[]` for non-admins with no error at all
  // (CLAUDE.md → "M2M deep filter + policy walk = silent empty"). A sport admin
  // is exactly such a non-admin, so the page would simply have looked empty for
  // the people it is built for. Reference impl: `useMultiTeamMembers`.
  const { data: junctionRaw } = useCollection<MemberTeam>('member_teams', {
    filter: { team: { _in: teamIds } },
    // `guest_level` is what separates a licensed player from a guest — see
    // `indexSportsByMember` for why this page has to know the difference.
    fields: ['id', 'member', 'team', 'guest_level'],
    all: true,
    enabled: teamIds.length > 0,
    staleTime: 60_000,
  })
  const junction = useMemo(() => junctionRaw ?? [], [junctionRaw])

  // ── Members ───────────────────────────────────────────────────────
  // The members query touches only plain `members` columns — no junction walk at
  // all — so it is immune to the same trap by construction.
  const { data: membersRaw, refetch, isFetching } = useCollection<TransferMember>('members', {
    filter: {
      _or: [
        // Everyone who has answered. 'CH' answers are needed here too — they
        // feed the Swiss reference list and the "no transfer needed" count.
        { federation_of_origin: { _nnull: true } },
        // Never asked, but plausibly relevant. The "no Swiss nationality" half
        // is applied client-side (`bucketOf`) because the column is a
        // comma-joined code list, not a relation we can filter precisely.
        {
          _and: [
            { federation_of_origin: { _null: true } },
            { nationalitaet_codes: { _nnull: true } },
            { kscw_membership_active: { _eq: true } },
          ],
        },
      ],
    },
    fields: MEMBER_FIELDS,
    sort: ['last_name', 'first_name'],
    all: true,
  })
  const members = useMemo(() => membersRaw ?? [], [membersRaw])

  // ── FIVB ──────────────────────────────────────────────────────────
  // The VIS federation directory (migration 241). 69 rows and effectively
  // static, so it is fetched whole and cached for an hour rather than filtered
  // down to the ISO codes on screen — a filter would refetch on every tab
  // switch for no gain. Deliberately NOT part of the boot gate below: a missing
  // directory degrades to "no contact on file" per row, and must never hold the
  // transfer worklist hostage.
  const { data: federationsRaw } = useCollection<VisFederation>('vis_federations', {
    fields: ['vis_no', 'iso', 'code', 'name', 'email', 'website'],
    all: true,
    staleTime: 3_600_000,
  })
  const federationByIso = useMemo(() => indexFederationsByIso(federationsRaw), [federationsRaw])
  const isoByFivbCode = useMemo(() => indexIsoByFivbCode(federationsRaw), [federationsRaw])

  /**
   * FIVB's own transfer records. Small (tens of rows), so fetched whole — and,
   * like the federation directory, deliberately OUTSIDE the boot gate: the
   * worklist must still render if this table is empty or unreachable.
   *
   * ⚠ `vis_transfers` has permission rows but no `directus_collections` entry;
   * Directus serves it off the database schema regardless (verified on prod).
   */
  const { data: visTransfersRaw } = useCollection<VisTransfer>('vis_transfers', {
    fields: [
      'vis_no', 'season_no', 'no_by_season', 'status_code', 'status_label',
      'percent_complete', 'is_player_blocked', 'start_on', 'end_on',
      'player_no', 'player_first_name', 'player_last_name', 'deleted_at',
    ],
    all: true,
    staleTime: 600_000,
  })
  const visSeason = useMemo(() => latestVisSeason(visTransfersRaw), [visTransfersRaw])
  const visTransfersByPlayer = useMemo(
    () => indexVisTransfersByPlayer(visTransfersRaw, visSeason),
    [visTransfersRaw, visSeason],
  )

  /**
   * The one transfer worth showing for a member: the most advanced live row,
   * falling back to a cancelled/refused one when that is all there is — a
   * refusal is the answer to "why has nothing happened", so hiding it would
   * leave the row looking untouched.
   *
   * The hand-set number outranks the swept one, the same rule the sync writes
   * by; both are read through `normaliseVisPlayerNo` because they arrive as
   * strings.
   */
  const visTransferOf = useCallback((m: TransferMember): VisTransfer | null => {
    const no = normaliseVisPlayerNo(m.vis_player_no_manual) ?? normaliseVisPlayerNo(m.vis_player_no)
    if (no === null) return null
    return pickVisTransfer(visTransfersByPlayer.get(no))
  }, [visTransfersByPlayer])

  // ── Roster derivations ────────────────────────────────────────────
  const { sportsByMember, guestSportsByMember } = useMemo(
    () => indexSportsByMember(junction, sportByTeam),
    [junction, sportByTeam],
  )
  const teamNamesByMember = useMemo(
    () => indexTeamNamesByMember(junction, sportByTeam, nameByTeam, activeTeamIds),
    [junction, sportByTeam, nameByTeam, activeTeamIds],
  )
  const u20OnlyMembers = useMemo(() => u20OnlyMemberIds(teamNamesByMember), [teamNamesByMember])

  /**
   * Everyone Volleymanager licenses for KSC Wiedikon, by `association_id`.
   *
   * Cohort-INDEPENDENT on purpose, and therefore a second query rather than a
   * reuse of `vmRaw` further down: that one is filtered to the licence numbers
   * of the members who are ALREADY on the worklist, so it can confirm a row but
   * can never admit one. Unfiltered here — the club licence list is ~260
   * single-column rows and changes only when the weekly VM sync runs.
   *
   * Every row carries a player `licence_category` (RLL/JLL/NLL/PL/DLR/DLN);
   * `is_referee` / `is_writer` are additive flags on top of a player licence,
   * never a row of their own (verified on prod 2026-08-13: 0 of 258 rows lack a
   * category). So presence here means "holds a KSCW player licence" — which is
   * precisely the thing an ITC clears.
   */
  const { data: vmLicenceRaw, isError: vmLicenceError } = useCollection<VmLicenceRow>('sv_vm_check', {
    fields: ['association_id', 'nationality_code'],
    all: true,
    staleTime: 3_600_000,
  })
  const { vmLicensedMembers, vmPlaysAsByMember } = useMemo(
    () => indexVmLicences(vmLicenceRaw, members),
    [vmLicenceRaw, members],
  )

  /**
   * A member appears on this page when EITHER the club's own roster puts them in
   * VOLLEYBALL as a PLAYER (guest memberships do not count — see
   * `indexSportsByMember`), OR Volleymanager licenses them for the club.
   *
   * Members on NO team used to surface so nothing could hide — but a transfer
   * is only owed by someone who plays, and the register carries enough
   * team-less people (ehemalige, passive, parents) that they buried the cohort
   * this page exists for. They are counted in Diagnostics instead, so dropping
   * them stays visible rather than silent: give them a team and they reappear.
   *
   * ⚠ The Volleymanager half is not a convenience — it is the AUTHORITATIVE
   * half. A Swiss Volley licence IS the thing an ITC clears, so somebody VM
   * licenses owes the transfer whether or not the club ever got round to
   * entering a `member_teams` row. Roster bookkeeping lags reality every
   * season, and on prod 2026-08-13 that lag hid four licensed, active,
   * foreign-federation players from the worklist completely — Delucchi (PE),
   * Gatsko (RU), Nikolov (BG), Suárez Perez (CO). They sat in the "on no team"
   * tally, which nobody works.
   *
   * ⚠ This also overrides the guest exclusion, and correctly so: "guest" means
   * "trains with us but holds no club licence", and a VM licence is that claim
   * being false.
   */
  const playsVolleyball = useCallback(
    (memberId: string) => (sportsByMember.get(memberId)?.has(SPORT) ?? false)
      || vmLicensedMembers.has(memberId),
    [sportsByMember, vmLicensedMembers],
  )

  /**
   * On the page only because Volleymanager licenses them — the club's own roster
   * has no volleyball player row for them.
   *
   * Surfaced rather than smoothed over: admitting them fixes the worklist, but
   * the MISSING ROSTER ROW is a real data gap, and if these rows looked like any
   * other the gap would simply stop being visible (it used to show up in the "on
   * no team" tally). Marking them keeps both true at once — the transfer gets
   * worked, and somebody can still go fix `member_teams`.
   */
  const unrosteredLicensed = useCallback(
    (memberId: string) => vmLicensedMembers.has(memberId)
      && !(sportsByMember.get(memberId)?.has(SPORT) ?? false),
    [vmLicensedMembers, sportsByMember],
  )

  /**
   * "Swiss Volley licences this member as Swiss" — the register's own answer,
   * mapped through the VIS federation directory rather than string-matching
   * 'SUI', so an IOC code the directory does not know yields no claim instead of
   * a wrong one.
   *
   * ⚠ It removes members from the worklist, so it must never fire on absence.
   * No VM row, no code, or a code the directory cannot resolve all yield false.
   */
  const vmSaysSwiss = useCallback(
    (m: TransferMember): boolean => playsAsSwiss(vmPlaysAsByMember.get(String(m.id)), isoByFivbCode),
    [vmPlaysAsByMember, isoByFivbCode],
  )

  // ── Cohorts ───────────────────────────────────────────────────────
  const fooConflicts = useMemo(
    () => findFooConflicts(members, { playsVolleyball, vmPlaysAsByMember, isoByFivbCode }),
    [members, playsVolleyball, vmPlaysAsByMember, isoByFivbCode],
  )
  const hidden = useMemo(
    () => countHidden(members, {
      playsVolleyball, vmSaysSwiss, sportsByMember, guestSportsByMember,
    }),
    [members, playsVolleyball, vmSaysSwiss, sportsByMember, guestSportsByMember],
  )
  const cohorts = useMemo(
    () => buildCohorts(members, { playsVolleyball, vmSaysSwiss, u20OnlyMembers }),
    [members, playsVolleyball, vmSaysSwiss, u20OnlyMembers],
  )

  // ── Licence validation ────────────────────────────────────────────
  // Swiss Volley validates the licence once the ITC has arrived, reconciled every
  // working day — so for a member who needs an ITC, `licence_validated = true` is
  // the downstream evidence that the transfer completed. There is no readable
  // FIVB transfer API for us (VIS gates transfer request types for guests, and
  // club access is a Swiss Volley UI login), so the Pending/Done toggle stays
  // manual and this is a cross-CHECK, not a replacement.
  //
  // ⚠ Scope is `needs` + `notNeeded`, not `needs` alone. The "ruled out" table
  // renders the same licence cell and the ruling was made from exactly this
  // evidence (`licence_validation_date`, the "VM: Italien (SUI)" origin line);
  // and the blocked-eligibility alarm below has to span both, because a member
  // cleared off the worklist who still carries `transfer_status = 'done'` with an
  // unvalidated licence is precisely the person nobody is looking at.
  const licenceScope = useMemo(
    () => cohorts.needs.concat(cohorts.notNeeded),
    [cohorts.needs, cohorts.notNeeded],
  )
  const matchKeys = useMemo(() => vmMatchKeys(licenceScope), [licenceScope])

  const { data: vmRaw, isError: vmError } = useCollection<VmRow>('sv_vm_check', {
    filter: {
      _or: [
        { association_id: { _in: matchKeys.licences } },
        { email: { _in: matchKeys.emails } },
      ],
    },
    fields: [
      'id', 'association_id', 'email', 'licence_validated', 'licence_validation_date',
      'nationality', 'nationality_code',
    ],
    all: true,
    enabled: matchKeys.licences.length > 0 || matchKeys.emails.length > 0,
    staleTime: 60_000,
  })
  const vmByMember = useMemo(() => indexVmRows(vmRaw, licenceScope), [vmRaw, licenceScope])

  const vmRowOf = useCallback(
    (m: TransferMember): VmRow | null => vmByMember.get(String(m.id)) ?? null,
    [vmByMember],
  )
  const validationOf = useCallback(
    (m: TransferMember) => validationStateOf(m, vmByMember.get(String(m.id))),
    [vmByMember],
  )

  /**
   * The derived state LABEL, and the one disagreement the nightly VIS sync can
   * never resolve.
   *
   * ⚠ Neither is a merge of the four authorities. `in_vis`, `licence_validated`,
   * `transfer_status` and the `vis_transfers` row stay four separate facts and
   * are all still rendered separately in Evidence and the row detail —
   * conflating them lets a stale toggle hide an incomplete transfer.
   */
  const stateOf = useCallback(
    (m: TransferMember): RowState => rowStateOf(m, visTransferOf(m), validationOf(m)),
    [visTransferOf, validationOf],
  )
  const disputedOf = useCallback(
    (m: TransferMember) => isDisputed(m, visTransferOf(m)),
    [visTransferOf],
  )

  // The hard mismatch: a transfer recorded as done whose licence is not
  // validated means the ITC has NOT landed and the player is not eligible —
  // fielding an unvalidated licence is sanctionable (FIVB Disciplinary
  // Regulations Art. 11.4). Widened to the ruled-out cohort for the reason
  // stated on `licenceScope` above.
  const blockedRows = useMemo(
    () => licenceScope.filter((m) => m.transfer_status === 'done' && validationOf(m) !== 'validated'),
    [licenceScope, validationOf],
  )

  const stateCounts = useMemo(() => countByState(cohorts.needs, stateOf), [cohorts.needs, stateOf])

  /**
   * Newest `in_vis_checked_at` anywhere in the loaded set — i.e. when the VIS
   * columns were last established. Across ALL members, not just the actionable
   * cohort: one run writes every row it evaluated, so the newest timestamp is
   * the run, and reading it off a filtered subset would understate it on a tab
   * where nothing is actionable.
   */
  const lastVisCheck = useMemo(() => newestVisCheck(members), [members])

  // ── Groups ────────────────────────────────────────────────────────
  // Federation of origin drives the actionable grouping; nationality drives the
  // "to clarify" grouping, because those members have no federation answer yet.
  const needsGroups = useMemo(
    () => groupRows(
      cohorts.needs,
      (m) => String(m.federation_of_origin ?? '').trim().toUpperCase(),
      (code) => federationDisplay(code, SPORT) || code,
    ),
    [cohorts.needs],
  )
  /**
   * The Swiss cohort under Swiss Volley itself. Always exactly one group (every
   * row answered 'CH'), built through `groupRows` anyway so it renders through
   * the same code path — and so the label comes from the same
   * `federationDisplay` the other groups use ("🇨🇭 Swiss Volley").
   */
  const swissGroups = useMemo(
    () => groupRows(
      cohorts.swiss,
      () => 'CH',
      (code) => federationDisplay(code, SPORT) || code,
    ),
    [cohorts.swiss],
  )
  /**
   * The cleared cohort, grouped by the federation that PUT them on the worklist
   * — not by the reason they came off it. That is the question an admin is
   * actually re-checking here ("did we really rule out all four Italians?"), and
   * it keeps the group headers and the VIS split reading identically to the
   * worklist above.
   *
   * The empty-code fallback is the group header's job (`trUnknownFederation`),
   * which is what keeps this hook free of i18n.
   */
  const notNeededGroups = useMemo(
    () => groupRows(
      cohorts.notNeeded,
      (m) => String(m.federation_of_origin ?? '').trim().toUpperCase(),
      (code) => federationDisplay(code, SPORT) || code,
    ),
    [cohorts.notNeeded],
  )
  const clarifyGroups = useMemo(
    () => groupRows(
      cohorts.clarify,
      // The primary (first) nationality. None of these members holds CH — that is
      // what put them in this bucket — so the first code is the meaningful one.
      (m) => parseCountryCodes(m.nationalitaet_codes)[0] ?? '',
      (code) => {
        const flag = countryFlag(code)
        const label = countryLabel(code) || code
        return flag ? `${flag} ${label}` : label
      },
    ),
    [cohorts.clarify],
  )

  const teamNamesOf = useCallback(
    (memberId: string) => teamNamesByMember.get(memberId),
    [teamNamesByMember],
  )

  const derivations = useMemo<TransferDerivations>(() => ({
    visTransferOf,
    validationOf,
    vmRowOf,
    vmSaysSwiss,
    stateOf,
    disputedOf,
    teamNamesOf,
    isUnrostered: unrosteredLicensed,
    federationByIso,
  }), [
    visTransferOf, validationOf, vmRowOf, vmSaysSwiss, stateOf, disputedOf, teamNamesOf,
    unrosteredLicensed, federationByIso,
  ])

  /**
   * The app's boot gate — see `usePageReady.tsx`.
   *
   * ⚠⚠ Keyed off `undefined` (query never resolved) rather than `isLoading`: a
   * DISABLED query reports `isLoading = false` in react-query v5 and would lift
   * the gate too early. The VM lookups, the federation directory and the VIS
   * transfers are deliberately NOT part of the gate — they are secondary
   * cross-checks and must never hold the whole page hostage.
   */
  const bootLoading =
    teamsRaw === undefined || membersRaw === undefined ||
    (teamIds.length > 0 && junctionRaw === undefined)

  /**
   * The Swiss Volley cross-check has not answered yet.
   *
   * Deliberately NOT folded into `bootLoading` — the worklist must still render
   * during a VM outage (see the note above). It exists because the ABSENCE of a
   * `sv_vm_check` row and a NEGATIVE answer from Swiss Volley are the same value
   * here: with `vmRaw` still `undefined`, `validationStateOf` falls through to
   * `'unknown'` for everyone, so `blockedRows` over-counts and `stateCounts`
   * buckets settled rows as blocked. That is not a rare timing window — `vmRaw`
   * is `enabled`-gated on `matchKeys`, which derives from `cohorts` → `members`,
   * so it cannot have resolved at the moment the boot gate lifts. The page-level
   * summaries that read as verdicts (the red eligibility alarm, the chips) wait
   * for this instead of asserting a number they are about to retract.
   *
   * ⚠ The `matchKeys` guard is not optional. `vmRaw` is `enabled`-gated, so on a
   * cohort with no licence number and no email it stays `undefined` for good —
   * a bare `vmRaw === undefined` would hide those summaries permanently, the
   * same trap the comment above documents for `isLoading`.
   */
  // // ⚠ `isLoading` goes false on ERROR while `data` stays undefined, so a bare
  // `data === undefined` gate never releases after a failed fetch — a permanent
  // skeleton is worse than the wrong frame it replaced. Errors fall through.
  // A VM outage must not take the state-filter chips down with the numbers.
  const crossChecksLoading =
    !vmLicenceError && !vmError && (
      vmLicenceRaw === undefined
      || ((matchKeys.licences.length > 0 || matchKeys.emails.length > 0) && vmRaw === undefined)
    )

  return {
    bootLoading,
    crossChecksLoading,
    // Refresh is a refetch of `members` only: it is the one collection the
    // page's own writes and the VIS check touch.
    isFetching,
    refetch,
    cohorts,
    hidden,
    fooConflicts,
    // A pure function of the rows handed in, so every group header can count its
    // OWN rows and no figure is ever printed without a stated scope.
    visCountsByGroupKey: countVisPresence,
    stateCounts,
    lastVisCheck,
    blockedRows,
    needsGroups,
    clarifyGroups,
    swissGroups,
    notNeededGroups,
    derivations,
  }
}
