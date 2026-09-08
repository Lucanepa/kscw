import { fetchAllItems, updateRecord, deleteRecord, kscwApi } from '../../../lib/api'
import { formatDateZurich } from '../../../utils/dateHelpers'

export type IssueSeverity = 'error' | 'warning'

export type FixAction = 'update' | 'delete'

/**
 * Drift fields the ClubDesk sync-up cannot push because ClubDesk owns legal
 * names — the UPDATE CSV (CD_PUSH_CONTACT_HEADERS in clubdesk-update.js) carries
 * no Vorname/Nachname on purpose. computeClubdeskDrift still compares them, so
 * these must be split off into an info-only row (no "Mark for sync-up"). If the
 * push scope ever changes, this must stay the compared-but-not-pushed set.
 */
const NAME_DRIFT_FIELDS = new Set(['first_name', 'last_name'])

/**
 * Stable, locale-independent issue identifier. Drives the translated label
 * (resolved in the component via t()) and the grouping/sort — never group or
 * label off a translated string, or grouping breaks per-locale.
 */
export type IssueKey =
  | 'missingDate'
  | 'missingAwayTeam'
  | 'missingTime'
  | 'nonPaddedTime'
  | 'duplicateFixture'
  | 'noTeamAssignment'
  | 'missingSex'
  | 'clubdeskNameMatch'
  | 'clubdeskDeparted'
  | 'clubdeskStale'
  | 'clubdeskStaleSuppressed'
  | 'retentionDue'
  | 'retentionUndated'
  | 'clubdeskDrift'
  | 'clubdeskDriftBlocked'
  | 'clubdeskFill'
  // The group-consistency keys (missing / stray / no-team-group / no-group /
  // coach-group / stale-Funktion / fee-no-roster / unmapped-team) were retired on
  // 2026-08-13: ClubdeskGroupCheck now renders those findings in full on this same
  // page, so an aggregate count here would be a second surface to keep in step.
  | 'clubdeskHonoraryDrift'
  | 'clubdeskNameDrift'
  // Fee rules (2026-08-13) — what the register bills vs what the club's rules
  // say. Zwischenjahr is deliberately not among them; see /clubdesk-fee-rules.
  | 'feeShouldBeFree'
  | 'feePassivCategory'
  | 'feeAmountMismatch'
  | 'feeNoRegisterAmount'
  | 'feeNoCategory'
  | 'feeUnmappedCategory'
  | 'scorerNotInVm'
  | 'scorerVmWriterNotFlagged'
  | 'scorerCdVbScNotFlagged'
  | 'scorerCheckFailed'

export interface DataIssue {
  id: string
  collection: string
  field: string
  severity: IssueSeverity
  issueKey: IssueKey
  /** Data-specific descriptor (team/member names, IDs, times) — locale-neutral. */
  detail: string
  autoFixable: boolean
  fixValue?: string
  fixAction?: FixAction
  /**
   * Non-auto fix that needs an admin choice (no single deterministic value).
   * The component renders inline controls and dispatches the matching handler.
   * 'sex' → male/female buttons (manualFix). 'clubdeskLink' → a single "Link"
   * button (linkClubdesk). 'clubdeskStale' → Unlink / Deactivate, the two honest
   * readings of a deleted ClubDesk contact. Excluded from "Fix all".
   */
  manualKind?: 'sex' | 'clubdeskLink' | 'clubdeskDeactivate' | 'clubdeskDriftFlag'
    | 'clubdeskStale' | 'retentionErase'
  /** For manualKind 'clubdeskLink': the ClubDesk contact to link to. */
  link?: { clubdeskId: string; clubdeskEmail?: string | null }
  /** For manualKind 'clubdeskDriftFlag' aggregate (fill) rows: all member ids to flag. */
  bulkMemberIds?: number[]
  /**
   * Full per-member list behind an AGGREGATE row, offered as an xlsx download.
   * Aggregates are the alarm; without this the detail would have nowhere to live
   * (unlike the ClubDesk aggregates, which expand on the ClubDesk sync page).
   * Columns/values are English — exports-always-English.
   */
  exportRows?: { columns: string[]; rows: string[][]; filename: string }
}

export interface CollectionHealth {
  collection: string
  total: number
  issues: DataIssue[]
}

interface ClubdeskDrift {
  member_id: number
  member_name: string
  clubdesk_id: string
  pending: boolean
  conflicts: { field: string; wiedisync: string; clubdesk: string }[]
  fills: { field: string; wiedisync: string }[]
  blank_risk: string[]
}

interface ClubdeskFillAgg {
  count: number
  member_ids: number[]
  at_risk: number
}

/**
 * /clubdesk-stale. `suppressed` is null or a reason code — the endpoint refuses to
 * report candidates when the ClubDesk snapshot is mid-reload, empty, or so
 * incomplete that most of the club reads as stale, because every row here carries
 * a Deactivate button.
 */
interface ClubdeskStaleResp {
  candidates: {
    member_id: number
    member_name: string
    clubdesk_id: string
    pushed_at: string | null
    current_teams: string[]
  }[]
  suppressed: 'down_in_progress' | 'export_empty' | 'export_incomplete' | null
  linked: number
  export_rows: number
  stale_count: number
}

/**
 * /retention-due. Former members whose personal data has passed the club's
 * retention period (12 months after deactivation). `undated` counts the
 * ex-members whose departure nobody has dated — they cannot be assessed at all,
 * and a check that quietly omitted them would report "nothing due" while not
 * looking at them.
 */
interface RetentionDueResp {
  candidates: {
    member_id: number
    member_name: string
    deactivated_at: string
    fields: string[]
    invoices_to_snapshot: number
    has_login: boolean
  }[]
  undated: number
  retention_months: number
  fields: string[]
}

interface ClubdeskNameMatch {
  member_id: number
  member_name: string
  member_email: string | null
  clubdesk_id: string
  clubdesk_email: string | null
  clubdesk_licence: string | null
  duplicate_of: { id: number; name: string } | null
}

interface ClubdeskDeparted {
  member_id: number
  member_name: string
  status: string
  austritt: string | null
  current_teams: string[]
}

// ── Helpers ──

function padTime(time: string): string {
  // "9:00" → "09:00", "8:30" → "08:30"
  const match = time.match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return time
  return `${match[1].padStart(2, '0')}:${match[2]}`
}

function gameLabel(record: Record<string, unknown>): string {
  const home = (record['home_team'] as string) || '?'
  const away = (record['away_team'] as string) || '?'
  return `${home} vs ${away}`
}

/**
 * A hand-entered fixture standing next to the synced one it duplicates.
 *
 * Both sync sources are blind to `source='manual'` rows: `bp-sync` pairs on
 * `bb_<gameNumber>` and `sv-sync` on `vb_<svrz_number>`, and each loads only
 * its OWN source when looking for the existing row. So a fixture that reached
 * `games` by hand before it reached the feed cannot be recognised by the sync
 * that later publishes it, and both rows live on — duplicated in the calendar
 * and team views, two sets of notifications, and (home games) the hall claimed
 * twice.
 *
 * `bp-sync`'s sweep retires basketball placeholders automatically, but only the
 * ones it can prove are placeholders: in the published date range AND created
 * before the schedule arrived. This is the safety net for everything else —
 * a fixture out of that range, one entered after the first publish, or a
 * volleyball cup game typed in before Swiss Volley carried it.
 *
 * ⚠ Detection is `(team, date)`, deliberately NOT `(team, date, opponent)`.
 * Opponent names drift badly between hand entry and the feed — "BC Winti" vs
 * "BC Winterthur 2 H1", "St.  Othmar" vs "St. Othmar" — so matching on them
 * would miss the real duplicates, which is the wrong way to be wrong for a
 * detector. Both fixtures' opponents and times ride in the detail line so the
 * admin adjudicates at a glance; a genuine tournament day or double-header
 * reads as two different opponents and is dismissed in one look.
 *
 * ⚠ Never auto-fixable. Which of the two rows to keep is a judgement call —
 * the manual one may carry a hand-set hall or a corrected time — and deleting
 * a game takes its RSVPs with it (`trg_games_0_purge_polymorphic`).
 *
 * Pure and exported so the pairing is testable without a fetch.
 */
export function findDuplicateFixtures(games: Record<string, unknown>[]): DataIssue[] {
  const SYNCED = new Set(['swiss_volley', 'basketplan'])
  const teamOf = (g: Record<string, unknown>) => {
    const t = g['kscw_team']
    // M2O: a bare id here (explicit `fields`), but fetchItems stringifies
    // integers, so normalise rather than compare mixed types.
    if (t && typeof t === 'object') return String((t as { id?: unknown }).id ?? '')
    return t == null ? '' : String(t)
  }
  const dayOf = (g: Record<string, unknown>) => String(g['date'] ?? '').slice(0, 10)

  // Index the synced fixtures by team+day once, so this stays linear.
  const syncedByKey = new Map<string, Record<string, unknown>[]>()
  for (const g of games) {
    if (!SYNCED.has(String(g['source'] ?? ''))) continue
    const team = teamOf(g)
    const day = dayOf(g)
    if (!team || !day) continue
    const key = `${team}|${day}`
    const list = syncedByKey.get(key)
    if (list) list.push(g)
    else syncedByKey.set(key, [g])
  }

  const issues: DataIssue[] = []
  for (const g of games) {
    if (String(g['source'] ?? '') !== 'manual') continue
    // A cancelled row is already out of every live view — flagging it is noise.
    if (String(g['status'] ?? '') === 'cancelled') continue
    const team = teamOf(g)
    const day = dayOf(g)
    if (!team || !day) continue
    const twins = syncedByKey.get(`${team}|${day}`)
    if (!twins?.length) continue

    const t = String(g['time'] ?? '').slice(0, 5)
    const twinText = twins
      .map((s) => `${gameLabel(s)}${String(s['time'] ?? '').slice(0, 5) ? ` ${String(s['time']).slice(0, 5)}` : ''} (${s['game_id'] ?? s['id']})`)
      .join(', ')
    issues.push({
      id: String(g['id']),
      collection: 'games',
      field: 'source',
      severity: 'warning',
      issueKey: 'duplicateFixture',
      detail: `${formatDateZurich(day)} · ${gameLabel(g)}${t ? ` ${t}` : ''} (${g['game_id'] ?? g['id']}) ↔ ${twinText}`,
      autoFixable: false,
    })
  }
  return issues
}

// ── Checks ──

async function checkGames(): Promise<CollectionHealth> {
  const games = await fetchAllItems<Record<string, unknown>>('games', {
    // kscw_team + source feed findDuplicateFixtures below; the rest are the
    // per-row field checks.
    fields: ['id', 'game_id', 'date', 'time', 'home_team', 'away_team', 'status',
      'kscw_team', 'source'],
    sort: ['date', 'time'],
  })

  const issues: DataIssue[] = []

  for (const g of games) {
    const gameId = (g['game_id'] as string) || String(g['id'])
    const date = g['date'] as string
    const time = g['time'] as string
    const awayTeam = g['away_team'] as string
    const status = (g['status'] as string) || ''
    const label = gameLabel(g)
    // Cancelled games may legitimately carry an empty date/time — don't flag them.
    const isCancelled = status === 'cancelled'

    // Missing date → manual review only, NEVER auto-deleted. The Swiss Volley
    // sync legitimately inserts real future fixtures with an empty date while
    // the opponent's agreed date is still pending; deleting them destroys
    // genuine games (and the next sync just re-creates them). Surface it so an
    // admin can decide in the Games UI, but don't offer a destructive one-click.
    if (!date && !isCancelled) {
      issues.push({
        id: String(g['id']),
        collection: 'games',
        field: 'date',
        severity: 'warning',
        issueKey: 'missingDate',
        detail: `${label} (${gameId})`,
        autoFixable: false,
      })
    }

    // Missing away team → set "Opponent TBD"
    if (!awayTeam || !awayTeam.trim() || awayTeam.trim() === '?') {
      issues.push({
        id: String(g['id']),
        collection: 'games',
        field: 'away_team',
        severity: 'error',
        issueKey: 'missingAwayTeam',
        detail: `${g['home_team'] || '?'} (${gameId})`,
        autoFixable: true,
        fixValue: 'Opponent TBD',
      })
    }

    // Missing time (when date exists) → set 00:00
    if (date && !isCancelled && (!time || !time.trim())) {
      issues.push({
        id: String(g['id']),
        collection: 'games',
        field: 'time',
        severity: 'warning',
        issueKey: 'missingTime',
        detail: `${formatDateZurich(date)} · ${label}`,
        autoFixable: true,
        fixValue: '00:00',
      })
    }

    // Non-padded time
    if (time && /^\d:\d{2}$/.test(time)) {
      issues.push({
        id: String(g['id']),
        collection: 'games',
        field: 'time',
        severity: 'warning',
        issueKey: 'nonPaddedTime',
        detail: `${time} → ${padTime(time)} · ${label}`,
        autoFixable: true,
        fixValue: padTime(time),
      })
    }
  }

  issues.push(...findDuplicateFixtures(games))

  return { collection: 'games', total: games.length, issues }
}

async function checkMembers(): Promise<CollectionHealth> {
  // Get all coach-approved, active members
  const members = await fetchAllItems<Record<string, unknown>>('members', {
    fields: ['id', 'first_name', 'last_name', 'nickname', 'coach_approved_team', 'wiedisync_active'],
    filter: { _and: [{ coach_approved_team: { _eq: true } }, { wiedisync_active: { _eq: true } }] },
    sort: ['last_name', 'first_name'],
  })

  // Pass members who have ANY team responsibility: player (current season),
  // coach (teams_coaches), or team-responsible (teams_responsibles). The
  // junctions have no season column — current-state is the truth, and the
  // player side now uses the same current-state gate (teams.active) rather than
  // any season string at all.

  // teams_coaches / teams_responsibles expose a real `members_id` column (not a
  // junction-id alias), so these direct junction reads are correct. Do NOT wrap
  // them in .catch(() => []) — a failed integrity query must surface (via the
  // top-level toast), not silently masquerade as "these members have no team"
  // and flood the page with false "No team assignment" warnings.
  const [memberTeams, teamCoaches, teamResponsibles] = await Promise.all([
    fetchAllItems<{ member: string | number }>('member_teams', {
      fields: ['member'],
      // Gate on the TEAM being active, not member_teams.season. The season
      // column is a create-time stamp uncoupled from the manually-run rollover,
      // so between the Jun-1 cutover and the rollover it matches nothing and
      // this check floods the page with false "No team assignment" warnings for
      // the entire playing roster — exactly the failure the comment above
      // describes, just from the other guard.
      filter: { team: { active: { _eq: true } } },
    }),
    fetchAllItems<{ members_id: string | number }>('teams_coaches', {
      fields: ['members_id'],
    }),
    fetchAllItems<{ members_id: string | number }>('teams_responsibles', {
      fields: ['members_id'],
    }),
  ])

  const assignedMemberIds = new Set<string>()
  for (const mt of memberTeams) assignedMemberIds.add(String(mt.member))
  for (const tc of teamCoaches) assignedMemberIds.add(String(tc.members_id))
  for (const tr of teamResponsibles) assignedMemberIds.add(String(tr.members_id))

  const issues: DataIssue[] = []

  for (const m of members) {
    if (!assignedMemberIds.has(String(m['id']))) {
      const name = `${m['nickname'] || m['first_name'] || ''} ${m['last_name'] || ''}`.trim() || String(m['id'])
      issues.push({
        id: String(m['id']),
        collection: 'members',
        field: 'member_teams',
        severity: 'warning',
        issueKey: 'noTeamAssignment',
        detail: name,
        autoFixable: false,
      })
    }
  }

  // Missing sex → manual review (m/f is a choice, not a deterministic auto-fix).
  // Independent of the team-assignment filter above: surface EVERY member without
  // a sex so it can be set by hand. The Volleymanager sync only ever set sex for
  // licensed volleyball players, and ClubDesk sync-down never propagated it — so
  // anyone outside that path (basketball, passive, new signups) lands here.
  // Skip the service/system account(s) — they aren't people and would be permanent
  // un-fixable noise (same heuristic as the ClubDesk sync's non-member guard).
  const sexless = await fetchAllItems<Record<string, unknown>>('members', {
    fields: ['id', 'first_name', 'last_name', 'nickname', 'email'],
    // _empty matches NULL and '' — Directus rejects _eq: '' outright (400 INVALID_QUERY).
    filter: { sex: { _empty: true } },
    sort: ['last_name', 'first_name'],
  })
  for (const m of sexless) {
    const email = String(m['email'] || '').toLowerCase()
    if (email.startsWith('system@') || email.includes('@kscw.clubdesk.com')) continue
    const name = `${m['nickname'] || m['first_name'] || ''} ${m['last_name'] || ''}`.trim() || String(m['id'])
    issues.push({
      id: String(m['id']),
      collection: 'members',
      field: 'sex',
      severity: 'warning',
      issueKey: 'missingSex',
      detail: name,
      autoFixable: false,
      manualKind: 'sex',
    })
  }

  // Members whose name matches a ClubDesk contact but whose email + licence
  // diverge — the auto-linker can't safely link these, so they surface here for
  // a manual decision. Free contact → one-click "Link" (sets clubdesk_id + keeps
  // the ClubDesk email as a secondary). Already-linked contact → flagged as a
  // likely duplicate that needs a merge (no one-click). Backend join: it reads
  // the clubdesk_export staging table, which isn't exposed via the items API.
  try {
    const { candidates } = await kscwApi<{ candidates: ClubdeskNameMatch[] }>('/clubdesk-name-matches')
    for (const c of candidates || []) {
      if (c.duplicate_of) {
        issues.push({
          id: String(c.member_id),
          collection: 'members',
          field: 'clubdesk_id',
          severity: 'warning',
          issueKey: 'clubdeskNameMatch',
          detail: `${c.member_name} — duplicate of #${c.duplicate_of.id} ${c.duplicate_of.name} (ClubDesk ${c.clubdesk_id})`,
          autoFixable: false,
        })
      } else {
        issues.push({
          id: String(c.member_id),
          collection: 'members',
          field: 'clubdesk_id',
          severity: 'warning',
          issueKey: 'clubdeskNameMatch',
          detail: `${c.member_name} → ClubDesk ${c.clubdesk_id}${c.clubdesk_email ? ` (${c.clubdesk_email})` : ''}`,
          autoFixable: false,
          manualKind: 'clubdeskLink',
          link: { clubdeskId: c.clubdesk_id, clubdeskEmail: c.clubdesk_email },
        })
      }
    }
  } catch {
    // Non-fatal: if the name-match endpoint is unavailable, the rest of the
    // members check still reports. (Surfaced via the page-level toast only if
    // the whole check throws — this one is best-effort.)
  }

  // Members still active in wiedisync but who LEFT ClubDesk (non-active status +
  // an Austritt date). They linger with rosters; flag for a manual deactivate
  // (sets not-a-member + drops current-season teams). Best-effort.
  try {
    const { candidates } = await kscwApi<{ candidates: ClubdeskDeparted[] }>('/clubdesk-departed')
    for (const c of candidates || []) {
      const teams = c.current_teams.length ? ` · ${c.current_teams.join(', ')}` : ''
      issues.push({
        id: String(c.member_id),
        collection: 'members',
        field: 'kscw_membership_active',
        severity: 'warning',
        issueKey: 'clubdeskDeparted',
        detail: `${c.member_name} — ${c.status}${c.austritt ? ` (${c.austritt})` : ''}${teams}`,
        autoFixable: false,
        manualKind: 'clubdeskDeactivate',
      })
    }
  } catch {
    // Best-effort — see above.
  }

  // Members whose linked ClubDesk contact has been DELETED from the register —
  // the mirror of "departed" (there the contact says they left; here there is no
  // contact left to say anything). Two decisions, because the server cannot tell
  // an accidental deletion from a real departure: unlink (keep the member, drop
  // the dead id so the next sync-up can re-create the contact) or deactivate
  // (same write as the departed flow). Best-effort for the rows — but NOT for the
  // suppression, which is reported as its own issue: a snapshot-shaped false
  // negative here reads as "no broken links" while the check has stopped looking.
  try {
    const stale = await kscwApi<ClubdeskStaleResp>('/clubdesk-stale')
    if (stale.suppressed) {
      issues.push({
        id: 'clubdesk-stale-suppressed',
        collection: 'members',
        field: 'clubdesk_id',
        severity: 'warning',
        issueKey: 'clubdeskStaleSuppressed',
        detail: `${stale.suppressed} · ${stale.stale_count}/${stale.linked} linked · ${stale.export_rows} rows in snapshot`,
        autoFixable: false,
      })
    }
    for (const c of stale.candidates || []) {
      const teams = c.current_teams.length ? ` · ${c.current_teams.join(', ')}` : ''
      issues.push({
        id: String(c.member_id),
        collection: 'members',
        field: 'clubdesk_id',
        severity: 'warning',
        issueKey: 'clubdeskStale',
        detail: `${c.member_name} — ClubDesk ${c.clubdesk_id}${teams}`,
        autoFixable: false,
        manualKind: 'clubdeskStale',
      })
    }
  } catch {
    // Best-effort — see above.
  }

  // Former members whose personal data has outlived its purpose — 12 months
  // after deactivation, per the club's retention decision. Deactivation stops
  // processing; nothing until now stopped storing. One decision per member: the
  // erase clears IBAN, AHV number, phone, address and email while keeping name,
  // birthdate, teams and dues history, and snapshots the recipient onto any
  // invoice that lacks one FIRST, so the books do not lose a payer.
  try {
    const ret = await kscwApi<RetentionDueResp>('/retention-due')
    for (const c of ret.candidates || []) {
      // ⚠ A member who still holds a login is listed but NOT offered the button:
      // clearing `members.email` while directus_users still holds the address and
      // the password hash would be theatre. Full account removal owns that case.
      const since = formatDateZurich(c.deactivated_at)
      const inv = c.invoices_to_snapshot > 0 ? ` · ${c.invoices_to_snapshot} invoices to stamp first` : ''
      issues.push({
        id: String(c.member_id),
        collection: 'members',
        field: c.fields.join(', '),
        severity: 'warning',
        issueKey: 'retentionDue',
        detail: `${c.member_name} — left ${since} · ${c.fields.join(', ')}${inv}`,
        autoFixable: false,
        manualKind: c.has_login ? undefined : 'retentionErase',
      })
    }
    // Not a nag: without a date there is no clock, so these are invisible to the
    // rule above and would otherwise never be looked at again.
    if (ret.undated > 0) {
      issues.push({
        id: 'retention-undated',
        collection: 'members',
        field: 'deactivated_at',
        severity: 'warning',
        issueKey: 'retentionUndated',
        detail: String(ret.undated),
        autoFixable: false,
      })
    }
  } catch {
    // Best-effort — see above.
  }

  // Linked members whose wiedisync contact data (push scope: names, email,
  // phone, address, birthdate, sex) no longer matches the ClubDesk snapshot —
  // edits made outside the profile modal never set the sync-up dirty flag, so
  // wiedisync and ClubDesk silently diverge. "Mark for sync-up" sets the flag
  // (+ field diff) so the sync-up modal picks the member up; already-pending
  // members are skipped here (they're in the modal's changed list already).
  // Best-effort.
  try {
    const { candidates, fills } = await kscwApi<{
      candidates: ClubdeskDrift[]
      fills: Record<string, ClubdeskFillAgg>
    }>('/clubdesk-drift')
    // Real conflicts: one row per member with the field-level diff. Members
    // with blank_risk fields (wiedisync empty where ClubDesk has data) get NO
    // one-click flag — pushing them would send empty cells for ClubDesk-owned
    // values; the next sync-down fills those fields and unblocks them. Their
    // issueKey carries the explanation ("run sync down first") via its label.
    for (const c of candidates || []) {
      // The ClubDesk UPDATE CSV is deliberately NAME-LESS (CD_PUSH_CONTACT_HEADERS
      // carries no Vorname/Nachname — ClubDesk owns legal names; see CLAUDE.md).
      // computeClubdeskDrift still COMPARES names, so a member whose only drift is
      // a name change can be flagged but never actually pushed: the sync-up CSV
      // changes nothing on the register, the pending flag clears, and the drift
      // recomputes on the next scan — a permanent no-op treadmill. Split those
      // into their own row with NO "Mark for sync-up" button; the fix is a human
      // editing one side by hand, not a push. NAME_DRIFT_FIELDS is the exact
      // compared-but-not-pushed set (see the push headers).
      const pushableConflicts = c.conflicts.filter((d) => !NAME_DRIFT_FIELDS.has(d.field))
      const hasPushable = pushableConflicts.length > 0 || c.fills.length > 0
      if (!hasPushable) {
        const nameTxt = c.conflicts
          .map((d) => `${d.field}: ${d.clubdesk} → ${d.wiedisync}`)
          .join(' · ')
        issues.push({
          id: `cd-namedrift-${c.member_id}`,
          collection: 'members',
          field: 'clubdesk_id',
          severity: 'warning',
          issueKey: 'clubdeskNameDrift',
          detail: `${c.member_name} — ${nameTxt}`,
          autoFixable: false,
        })
        continue
      }
      const diffTxt = c.conflicts
        .map((d) => `${d.field}: ${d.clubdesk} → ${d.wiedisync}`)
        .join(' · ')
      const fillTxt = c.fills.length ? ` · +${c.fills.map((f) => f.field).join(', ')}` : ''
      const blocked = c.blank_risk.length > 0
      const blank = blocked ? ` · ⚠ ${c.blank_risk.join(', ')}` : ''
      issues.push({
        // Prefixed id: avoids manualFixingId collisions with missingSex /
        // departed rows for the same member; the member id travels in
        // bulkMemberIds instead.
        id: `cd-drift-${c.member_id}`,
        collection: 'members',
        field: 'clubdesk_id',
        severity: 'warning',
        issueKey: blocked ? 'clubdeskDriftBlocked' : 'clubdeskDrift',
        detail: `${c.member_name} — ${diffTxt}${fillTxt}${blank}`,
        autoFixable: false,
        ...(blocked ? {} : { manualKind: 'clubdeskDriftFlag' as const, bulkMemberIds: [c.member_id] }),
      })
    }
    // Mass fills (wiedisync has data ClubDesk lacks): ONE aggregate row per
    // field with a bulk "mark for sync-up" — e.g. 100+ members whose sex is
    // only set in wiedisync would otherwise flood the list. member_ids only
    // contains blank-risk-free members; at_risk counts the held-back ones.
    for (const [field, agg] of Object.entries(fills || {})) {
      if (!agg.count && !agg.at_risk) continue
      const atRisk = agg.at_risk ? ` (+${agg.at_risk} ⚠)` : ''
      issues.push({
        id: `cd-fill-${field}`,
        collection: 'members',
        field,
        severity: 'warning',
        issueKey: 'clubdeskFill',
        detail: `${field} — ${agg.count}${atRisk}`,
        autoFixable: false,
        ...(agg.count ? { manualKind: 'clubdeskDriftFlag' as const, bulkMemberIds: agg.member_ids } : {}),
      })
    }
  } catch {
    // Best-effort — see above.
  }

  // ClubDesk HONORARY drift. The rest of /clubdesk-group-sync's output — missing
  // groups, strays, wrong Funktion, coaches without a coach group, billed-with-no-
  // roster, unmapped teams, groups with no team — used to be aggregated into
  // single alarm rows here, because the detail lived on a different page
  // (/admin/clubdesk-sync) and this one only had room to point at it. Since the
  // 2026-08-13 merge that page IS this page: ClubdeskGroupCheck renders every one
  // of those lists in full, per sport tab, with its own export. Duplicating them
  // as counts here would mean two surfaces to keep in step and a number that can
  // disagree with the list right below it.
  //
  // Honorary drift stays because nothing else renders it: it is not a group
  // consistency finding but a club-level one (the Ehrenmitglieder honour list vs
  // the register Status vs who is still being billed), so it lives in the
  // club-wide tab. Best-effort.
  try {
    const { honorary_drift } = await kscwApi<{
      honorary_drift?: { member_id: number; kind: 'status_only' | 'fee'; kat: string; fee_waived?: boolean }[]
    }>('/clubdesk-group-sync')

    // Aggregated — two counts in one row,
    // because the two halves need different hands: `status_only` is a missing
    // name on the ClubDesk honour list, `fee` is somebody holding the honour and
    // still being billed. Error when anyone is being billed; the honour list
    // being short is a warning.
    if ((honorary_drift || []).length > 0) {
      // "Still billed" counts anyone in this set not on 'Gratis', not just the
      // in-group half. Keying it off `kind` hid the worst row on prod: Zehnder
      // is Ehrenmitglied by status, absent from the group AND paying
      // Passivmitglied — classified 'status_only', so the fee half read 0.
      const billed = (honorary_drift || []).filter((r) => r.kat !== 'Gratis' && !r.fee_waived).length
      const statusOnly = (honorary_drift || []).filter((r) => r.kind === 'status_only').length
      issues.push({
        id: 'cd-honorary-drift',
        collection: 'members',
        field: 'register_status',
        severity: billed > 0 ? 'error' : 'warning',
        issueKey: 'clubdeskHonoraryDrift',
        detail: `${statusOnly} · ${billed} still billed`,
        autoFixable: false,
      })
    }
  } catch {
    // Best-effort — see above.
  }

  await checkFeeRules(issues)
  await checkScorerLicences(issues)

  return { collection: 'members', total: members.length, issues }
}

interface FeeRuleFinding {
  member_id: number
  member_name: string
  register_status: string | null
  category: string | null
  register_amount: number | null
  expected: number | null
  reason: 'honorary' | 'vorstand' | 'coach' | null
  kind: 'free_but_billed' | 'passiv_wrong_category' | 'amount_mismatch'
    | 'no_register_amount' | 'no_category' | 'unmapped_category'
}

/** Backend kind → stable issue key. One key per DIFFERENT hand needed: a wrong
 *  amount is the treasurer's call, a missing category is an admin's, and an
 *  unmapped one needs a rate codified in CD_BEITRAG_MAP before either can act. */
const FEE_ISSUE_KEY: Record<FeeRuleFinding['kind'], IssueKey> = {
  free_but_billed: 'feeShouldBeFree',
  passiv_wrong_category: 'feePassivCategory',
  amount_mismatch: 'feeAmountMismatch',
  no_register_amount: 'feeNoRegisterAmount',
  no_category: 'feeNoCategory',
  unmapped_category: 'feeUnmappedCategory',
}

/**
 * Fee rules — what the ClubDesk register bills vs what the club's own rules say.
 * The backend does the classification through feeBreakdown() (the one fee
 * engine); this only shapes rows.
 *
 * REPORT ONLY, by design — no autoFixable, no manualKind. The register's
 * Mitgliederbeitrag is a per-person cell the treasurer sets by hand, so a
 * mismatch is a question ("which side is wrong?"), not a value to write. A
 * "fix" button here would push the derivation over a deliberate decision.
 *
 * Severity: being billed when you should be free is an ERROR (someone is paying
 * money they don't owe); everything else is a warning.
 */
async function checkFeeRules(issues: DataIssue[]): Promise<void> {
  try {
    const { findings } = await kscwApi<{
      findings: FeeRuleFinding[]
      checked: number
      not_evaluated: number
    }>('/clubdesk-fee-rules')
    const chf = (n: number | null) => (n === null ? '—' : `CHF ${n}`)
    for (const f of findings || []) {
      const kat = f.category || '(no category)'
      // Says the whole story on one line: who, on what category, register says
      // X, rule says Y. The reader should never need to open the member.
      const detail = f.kind === 'free_but_billed'
        ? `${f.member_name} — ${f.reason} · ${kat} · ${chf(f.register_amount)}`
        : `${f.member_name} — ${kat} · register ${chf(f.register_amount)} · expected ${chf(f.expected)}`
      issues.push({
        id: `fee-${f.kind}-${f.member_id}`,
        collection: 'members',
        field: 'beitragskategorie',
        severity: f.kind === 'free_but_billed' ? 'error' : 'warning',
        issueKey: FEE_ISSUE_KEY[f.kind],
        detail,
        autoFixable: false,
      })
    }
  } catch {
    // Best-effort, like the ClubDesk checks above: a failing fee endpoint must
    // not blank the rest of the members findings.
  }
}

interface ScorerCheckRow {
  member_id: number
  member_name: string
  license_nr: string | null
  in_vm?: boolean
  vm_is_writer?: boolean
  vm_assoc_id?: string | number | null
  clubdesk_lizenz?: string | null
  referee_vb?: boolean
  cleared_next_sync?: boolean
}

/**
 * Scorer licence cross-check — members.scorer_vb vs Volleymanager's indoorwriter
 * registry vs ClubDesk's `VB SC`. Three registers, two crons writing the same
 * column from different sources, so the flag can oscillate weekly. Backend does
 * the join (it replicates vm-sync-check.mjs's match cascade); this only shapes rows.
 *
 * Aggregated one row per direction, with the full list on the row's Export button.
 *
 * NOTE the asymmetry: `scorerNotInVm` is a WARNING (VM's list is merely
 * incomplete — as of 2026-07-17 its writers are a strict subset of ClubDesk's
 * VB SC holders, so it contradicts nothing), while `scorerCdVbScNotFlagged` is an
 * ERROR — that one means the VM sync has actively cleared a licence the club
 * register grants, i.e. data already lost, not merely two lists differing.
 */
async function checkScorerLicences(issues: DataIssue[]): Promise<void> {
  try {
    const { flagged_not_in_vm, vm_writer_not_flagged, cd_vb_sc_not_flagged, summary } =
      await kscwApi<{
        flagged_not_in_vm: ScorerCheckRow[]
        vm_writer_not_flagged: ScorerCheckRow[]
        cd_vb_sc_not_flagged: ScorerCheckRow[]
        vm_writer_no_member: { vm_assoc_id: string; vm_name: string }[]
        summary: {
          scorer_vb_total: number
          vm_writers: number
          cd_vb_sc: number
          cleared_next_sync: number
        }
      }>('/admin/scorer-vm-check')

    const yn = (b: boolean | undefined) => (b ? 'yes' : 'no')

    if (flagged_not_in_vm.length > 0) {
      issues.push({
        id: 'scorer-not-in-vm',
        collection: 'members',
        field: 'scorer_vb',
        severity: 'warning',
        issueKey: 'scorerNotInVm',
        // `cleared_next_sync` is the actionable half — those lose the flag at the
        // next Monday 04:00 VM sync; the rest have no VM row so nothing touches them.
        detail: `${flagged_not_in_vm.length} · ${summary.cleared_next_sync} cleared by next VM sync · VM ${summary.vm_writers} / ClubDesk ${summary.cd_vb_sc}`,
        autoFixable: false,
        exportRows: {
          columns: ['Member ID', 'Name', 'Licence nr', 'In Volleymanager', 'VM writer', 'ClubDesk licence', 'VB referee', 'Cleared by next VM sync'],
          rows: flagged_not_in_vm.map((r) => [
            String(r.member_id), r.member_name, r.license_nr || '',
            yn(r.in_vm), yn(r.vm_is_writer), r.clubdesk_lizenz || '',
            yn(r.referee_vb), yn(r.cleared_next_sync),
          ]),
          filename: 'scorer_vb_not_in_volleymanager',
        },
      })
    }

    if (vm_writer_not_flagged.length > 0) {
      issues.push({
        id: 'scorer-vm-writer-not-flagged',
        collection: 'members',
        field: 'scorer_vb',
        severity: 'error',
        issueKey: 'scorerVmWriterNotFlagged',
        detail: `${vm_writer_not_flagged.length}`,
        autoFixable: false,
        exportRows: {
          columns: ['Member ID', 'Name', 'Licence nr', 'VM association ID', 'ClubDesk licence'],
          rows: vm_writer_not_flagged.map((r) => [
            String(r.member_id), r.member_name, r.license_nr || '',
            String(r.vm_assoc_id ?? ''), r.clubdesk_lizenz || '',
          ]),
          filename: 'volleymanager_writers_without_scorer_flag',
        },
      })
    }

    if (cd_vb_sc_not_flagged.length > 0) {
      issues.push({
        id: 'scorer-cd-vbsc-not-flagged',
        collection: 'members',
        field: 'scorer_vb',
        severity: 'error',
        issueKey: 'scorerCdVbScNotFlagged',
        detail: `${cd_vb_sc_not_flagged.length}`,
        autoFixable: false,
        exportRows: {
          columns: ['Member ID', 'Name', 'Licence nr', 'In Volleymanager', 'VM writer'],
          rows: cd_vb_sc_not_flagged.map((r) => [
            String(r.member_id), r.member_name, r.license_nr || '',
            yn(r.in_vm), yn(r.vm_is_writer),
          ]),
          filename: 'clubdesk_vbsc_without_scorer_flag',
        },
      })
    }
  } catch {
    // Deliberately NOT the silent best-effort swallow the ClubDesk checks use.
    // This check's whole job is to notice a flag being cleared; a check that goes
    // quiet when its endpoint 403s/500s reports "all clean" at exactly the moment
    // it has stopped looking — the false all-clear the hall audit hit when a 401
    // let it print "✓ 0/80 mismatches" (DEVLOG 2026-07-16). Surface it instead.
    issues.push({
      id: 'scorer-check-failed',
      collection: 'members',
      field: 'scorer_vb',
      severity: 'error',
      issueKey: 'scorerCheckFailed',
      detail: '',
      autoFixable: false,
    })
  }
}

// ── Public API ──

export async function runAllChecks(): Promise<CollectionHealth[]> {
  const [games, members] = await Promise.all([checkGames(), checkMembers()])
  return [games, members]
}

/**
 * Apply an admin-chosen value for a manual-fix issue (e.g. sex → 'm' | 'f').
 * Separate from autoFix because there is no single deterministic fixValue.
 */
export async function manualFix(issue: DataIssue, value: string): Promise<void> {
  await updateRecord(issue.collection, issue.id, { [issue.field]: value })
}

/**
 * Confirm a name-only ClubDesk match: link the member to the ClubDesk contact
 * (sets clubdesk_id + keeps the ClubDesk email as a secondary, server-side).
 */
export async function linkClubdesk(issue: DataIssue): Promise<void> {
  if (!issue.link) return
  await kscwApi('/clubdesk-link', {
    method: 'POST',
    body: { member_id: Number(issue.id), clubdesk_id: issue.link.clubdeskId },
  })
}

/**
 * Deactivate a member who left ClubDesk: sets not-a-member + inactive and drops
 * their current-season team assignments (keeps prior-season history).
 */
export async function deactivateMember(issue: DataIssue): Promise<void> {
  await kscwApi('/clubdesk-deactivate', {
    method: 'POST',
    body: { member_id: Number(issue.id) },
  })
}

/**
 * Deactivate every departed member in one call.
 *
 * ⚠ The server re-derives the departure PER MEMBER (linked, 1:1 link, still in a
 * departed status with an Austritt date) and writes its own audit entry for each,
 * so this is not a looser path than the single-row button — it is the same gate,
 * applied N times. Partial success is normal and reported: a member whose link
 * turned ambiguous since the scan is skipped while the rest proceed.
 */
export async function deactivateDepartedMembers(
  memberIds: number[],
): Promise<{ deactivated: number[]; skipped: { member_id: number; code: string }[]; rosters_dropped: number }> {
  const r = await kscwApi<{
    deactivated?: number[]; skipped?: { member_id: number; code: string }[]; rosters_dropped?: number
  }>('/clubdesk-deactivate', { method: 'POST', body: { member_ids: memberIds } })
  return {
    deactivated: r?.deactivated || [],
    skipped: r?.skipped || [],
    rosters_dropped: Number(r?.rosters_dropped) || 0,
  }
}

/**
 * Resolve a broken ClubDesk link (the contact was deleted register-side).
 *   'unlink'     — clear the dead clubdesk_id (+ clubdesk_pushed_at, or the member
 *                  would fall out of BOTH sync-up preview lists); they become
 *                  "not linked" and the next sync-up can create the contact again.
 *   'deactivate' — treat the deletion as the departure: not-a-member, inactive,
 *                  active-team rosters dropped.
 * The server re-derives the finding (snapshot-health guards included) before
 * writing, so a decision taken against a stale scan 409s instead of applying.
 */
export async function resolveStaleLink(
  issue: DataIssue, action: 'unlink' | 'deactivate',
): Promise<void> {
  await kscwApi('/clubdesk-stale/resolve', {
    method: 'POST',
    body: { member_id: Number(issue.id), action },
  })
}

/**
 * Erase a former member's personal data once the retention period has passed.
 * Clears IBAN, AHV number, phone, address and email (the last to a
 * non-deliverable `erased-<id>@invalid`, since the column is NOT NULL) and keeps
 * name, birthdate, teams and dues history. The server re-derives eligibility and
 * snapshots the recipient onto any invoice missing one before clearing, so an
 * erasure cannot quietly leave the books without a payer.
 */
export async function eraseRetentionData(issue: DataIssue): Promise<void> {
  await kscwApi('/retention-erase', {
    method: 'POST',
    body: { member_id: Number(issue.id) },
  })
}

/**
 * Mark drifted member(s) for the next ClubDesk sync-up push (sets the dirty
 * flag + field diff server-side; the actual push happens in the sync-up modal
 * on the Anmeldungen page). Bulk rows carry all their member ids.
 */
export async function flagClubdeskDrift(issue: DataIssue): Promise<void> {
  const memberIds = issue.bulkMemberIds ?? [Number(issue.id)]
  await kscwApi('/clubdesk-drift/flag', {
    method: 'POST',
    body: { member_ids: memberIds },
  })
}

/**
 * Bulk variant: flag every member behind the given drift/fill issues in a SINGLE
 * request. /clubdesk-drift/flag already takes an array and does its own blank-risk
 * filtering, so a multi-select collapses to one POST (no per-issue fan-out).
 * Returns the server's tally so the caller can report partial skips. Members with
 * no live drift are silently ignored server-side (they may have been marked since
 * the scan), which is why this never 409s on a mixed batch the way a single flag can.
 */
export async function flagClubdeskDriftBulk(
  issues: DataIssue[],
): Promise<{ flagged: number; skipped_blank_risk: number }> {
  const memberIds = [...new Set(issues.flatMap((i) => i.bulkMemberIds ?? []))]
  if (!memberIds.length) return { flagged: 0, skipped_blank_risk: 0 }
  return await kscwApi<{ flagged: number; skipped_blank_risk: number }>(
    '/clubdesk-drift/flag',
    { method: 'POST', body: { member_ids: memberIds } },
  )
}

export async function autoFix(issue: DataIssue): Promise<void> {
  if (!issue.autoFixable) return
  if (issue.fixAction === 'delete') {
    await deleteRecord(issue.collection, issue.id)
    return
  }
  if (issue.fixValue === undefined) return
  await updateRecord(issue.collection, issue.id, {
    [issue.field]: issue.fixValue,
  })
}

export async function autoFixAll(
  issues: DataIssue[],
): Promise<{ fixed: number; failed: number; failedIds: string[] }> {
  // Every remaining auto-fix is a non-destructive update on a distinct record,
  // so they're safe to run in parallel. allSettled keeps one failure from
  // aborting the rest and lets us report exactly which records still need help.
  const fixable = issues.filter((i) => i.autoFixable)
  const results = await Promise.allSettled(fixable.map((i) => autoFix(i)))

  let fixed = 0
  let failed = 0
  const failedIds: string[] = []
  results.forEach((r, idx) => {
    if (r.status === 'fulfilled') {
      fixed++
    } else {
      failed++
      failedIds.push(fixable[idx].id)
    }
  })
  return { fixed, failed, failedIds }
}
