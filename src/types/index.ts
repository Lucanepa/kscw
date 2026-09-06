import type { LicenceStatus } from '../utils/licenceStatus'

export type { LicenceStatus }

export interface BaseRecord {
  id: string
  created?: string
  updated?: string
  date_created?: string
  date_updated?: string
  [key: string]: unknown
}

export type LicenceType =
  | 'scorer_vb' | 'referee_vb'
  | 'otr1_bb' | 'otr2_bb'
  // The levels Basketplan actually issues (migration 228). They replaced a
  // coarse "holds some OTN" flag, `otn_bb`, which migration 303 dropped once
  // every one of its 8 holders had been confirmed as OTN 2 — so an eligibility
  // check ORs these two and nothing else.
  | 'otn1_bb' | 'otn2_bb'
  | 'referee_bb'

/** All licence keys in canonical order — single source of truth for UI iteration. */
export const LICENCE_TYPES: readonly LicenceType[] = [
  'scorer_vb', 'referee_vb', 'otr1_bb', 'otr2_bb', 'otn1_bb', 'otn2_bb', 'referee_bb',
] as const

/** Derive the legacy LicenceType[] view from the per-flag booleans. */
export function licencesOf(m: Partial<Record<LicenceType, boolean | undefined>>): LicenceType[] {
  const out: LicenceType[] = []
  for (const k of LICENCE_TYPES) if (m[k]) out.push(k)
  return out
}
export type MemberPosition =
  | 'setter'
  | 'outside'
  | 'middle'
  | 'opposite'
  | 'libero'
  | 'point_guard'
  | 'shooting_guard'
  | 'small_forward'
  | 'power_forward'
  | 'center'
  | 'guest'
  | 'staff_only'
  | 'other'

export interface Team extends BaseRecord {
  name: string
  full_name: string
  team_id: string
  sport: 'volleyball' | 'basketball'
  /** Team gender for picker filtering (migration 172). NULL = unknown → shown to everyone. */
  gender?: 'm' | 'f' | 'mixed' | null
  league: string
  season: string
  color: string
  coach: string[]
  captain: string[]
  team_responsible: string[]
  active: boolean
  team_picture: string
  team_picture_pos: string
  social_url: string
  facebook_url: string
  tiktok_url: string
  show_guests_on_website: boolean
  sponsors: string[]
  sponsors_logos: string[]
  bb_source_id: string
  open_for_players: boolean
  /** Positions the team is recruiting for (team-level). Empty/undefined = open to all. Shown on the public team page when open_for_players=true. */
  recruiting_positions?: MemberPosition[] | null
  /** Mixed (MU) youth teams only, sub-toggles of open_for_players (migration 298).
   *  Exactly one of the two set splits the website's Nachwuchs card: that gender
   *  gets the contact form, the other the waiting list. Both set — or neither,
   *  the default — recruit without a split. */
  open_for_girls?: boolean | null
  open_for_boys?: boolean | null
  features_enabled: TeamSettings
  /** Coach Dashboard: persisted From date (NULL = computed default). */
  dashboard_range_from?: string | null
  /** Coach Dashboard: persisted To date (NULL = today). */
  dashboard_range_to?: string | null
  /** Coach Dashboard: exclude cup games from games-attendance count. */
  dashboard_league_only?: boolean
  /** Scorer-duty manual credit (migration 196): duties this team is excused from
   *  (higher = fewer scorer/scoreboard assignments). Stacks on top of the
   *  automatic referee credit. Editable on the scorer-assignment page. */
  duty_credit?: number

}

export interface Sponsor extends BaseRecord {
  name: string
  logo: string
  website_url: string
  sort_order: number
  active: boolean
  teams: string[]
  team_page_only: boolean
}

export interface FeatureToggles {
  polls?: boolean
  show_rsvp_time?: boolean
  position_preferences?: boolean
}

export interface TeamSettings extends FeatureToggles {
  auto_decline_tentative?: boolean
  game_min_participants?: number
  game_respond_by_days?: number
  game_require_note_if_absent?: boolean
  training_min_participants?: number
  training_respond_by_days?: number
  training_auto_cancel_on_min?: boolean
  training_require_note_if_absent?: boolean
  /** Auto-confirm RSVP on training create (members must opt out). Default false. */
  training_auto_confirm?: boolean
  /** Auto-confirm RSVP on game create for full members only (guests blocked). Default false. */
  game_auto_confirm?: boolean
  /** Team default for auto-filing the Volleymanager Einsatzliste from confirmed RSVPs
   *  ~60 min before kickoff. A game's own `auto_nomination_list` overrides this; null
   *  there means "inherit this". Volleyball only. Default false. */
  auto_nomination_list?: boolean
}

export interface Member extends BaseRecord {
  /** directus_users.id — set when this member has an authenticated account.
   *  Used to map participation `last_edited_by` (a directus_users UUID) back
   *  to a member name for the "Edited by …" attribution line. */
  user?: string | null
  email: string
  first_name: string
  last_name: string
  /** Migration 215: preferred display name shown INSTEAD of first_name across
   *  the app UI (e.g. "Honza" for Jan Cerny). Empty/null → fall back to
   *  first_name. Legal/official surfaces (match sheets, VM, ClubDesk, invoices,
   *  public website) always use first_name. Use `memberDisplayName()` for UI,
   *  `memberName()` for legal contexts (both in src/utils/relations.ts). */
  nickname?: string | null
  phone: string
  license_nr: string
  number: number
  position: MemberPosition[]
  photo: string
  role: ('user' | 'vorstand' | 'admin' | 'vb_admin' | 'bb_admin' | 'superuser' | 'finance')[]
  kscw_membership_active: boolean
  birthdate: string

  // Per-licence boolean columns (migration 067). The legacy `licences` JSON
  // array was removed in migration 119 — read these or call `licencesOf(member)`.
  scorer_vb: boolean
  referee_vb: boolean
  otr1_bb: boolean
  otr2_bb: boolean
  /** OTN level 1 / level 2, the levels Basketplan issues (migration 228). */
  otn1_bb: boolean
  otn2_bb: boolean
  referee_bb: boolean
  /** Coaching education (migration 274): ordered comma-separated subset of
   *  JS/C/B/A, e.g. "JS,B". NULL = none / not recorded. Parse with
   *  `parseTrainerLicences()` from src/utils/trainerLicences.ts — never split
   *  it by hand, the helper also drops corrupt tokens and fixes the order. */
  trainer_licences?: string | null
  /** Club licence-ordering workflow for `licence_status_season` (migration 301).
   *  Staff-written: own-readable, never member-editable. `licenced` is asserted
   *  only by the Swiss Volley / Basketplan sweep, which promotes but never
   *  demotes. ⚠ Never read this raw for display — a stamp from last season is
   *  still sitting in the column until the nightly sweep resets it. Go through
   *  `effectiveLicenceStatus()` in src/utils/licenceStatus.ts. */
  licence_status?: LicenceStatus | null
  /** The season `licence_status` describes, short form ("2026/27"). */
  licence_status_season?: string | null
  licence_status_updated_at?: string | null
  /** Who last moved it — a person, or "Swiss Volley sync" / "Basketplan sync". */
  licence_status_by_name?: string | null
  coach_approved_team: boolean
  requested_team: string
  language: 'english' | 'german' | 'french' | 'italian' | 'swiss_german' | ''
  hide_phone: boolean
  hide_email: boolean
  // Per-member auto-confirm RSVP opt-in (migration 077). When on, the member is
  // auto-confirmed on new activities of that type (OR-ed with the team setting).
  auto_confirm_trainings: boolean
  auto_confirm_games: boolean
  auto_confirm_events: boolean
  // Per-member notification opt-out (migration 156). Default-on; opt-out
  // suppresses the email (or the form push) only — never the in-app bell.
  email_notify_registrations?: boolean
  email_notify_join_requests?: boolean
  email_notify_form_submissions?: boolean
  email_notify_announcements?: boolean
  email_notify_events?: boolean
  birthdate_visibility: 'full' | 'year_only' | 'hidden'
  website_visible: boolean
  // Website-scoped name privacy (migration 116). When true, the public website
  // roster shows the surname as an initial only ("Anna M.") and hides the year
  // of birth. Internal app is unaffected. Enforced server-side.
  website_name_private: boolean
  is_spielplaner: boolean
  wiedisync_active: boolean
  shell: boolean
  shell_expires: string
  shell_reminder_sent: boolean
  // ClubDesk sync fields
  // Stable global member key (migration 184) — pushed to ClubDesk as
  // "Wiedisync ID"; system-assigned, never edited.
  uuid?: string
  adresse: string
  plz: string
  ort: string
  // Nationality is CODED since migration 223/224. `nationalitaet_codes` is the
  // ordered, comma-separated ISO 3166-1 alpha-2 list ("CH,IT") and the FIRST
  // code is the primary one. `nationalitaet` is DERIVED from it by a DB trigger
  // (the German display name the ClubDesk push/drift path needs) — treat it as
  // READ-ONLY everywhere in the UI and never write it.
  nationalitaet: string
  nationalitaet_codes: string | null
  // Federation the member was FIRST licensed with (their federation of origin):
  // an ISO alpha-2 code, or null (not answered). A first-ever licence is issued
  // by Swiss Volley / Swiss Basketball, so that case is 'CH' — there is no
  // "none" answer (migration 342 retired the sentinel).
  federation_of_origin: string | null
  /** Zurich Kantonsschule (migration 315). 'Nein' = asked and not at one; null = never asked. */
  kantonsschule?: string | null
  // International-transfer workflow (migrations 234/235), driven by
  // /admin/transfers. STAFF-ONLY columns: deliberately absent from
  // MEMBER_VISIBLE_FIELDS *and* MEMBER_EDITABLE_FIELDS, so a member neither
  // reads nor writes them — only tiers holding `members` fields=* (Sport Admin,
  // full admins) can.
  //
  // NULL means "nobody has looked", and the answer is then DERIVED from
  // `federation_of_origin` ('CH' = Swiss-licensed, first licence included →
  // nothing to do). A stored value is a decision
  // a person made and OVERRIDES that derivation in both directions (migration
  // 320): 'not_needed' clears a foreign-origin member off the worklist without
  // falsifying their own federation answer, and 'pending' chases a transfer for
  // a CH-origin member Swiss Volley records as foreign.
  transfer_status?: 'pending' | 'done' | 'not_needed' | null
  /** Stamped when the status becomes 'done'; CLEARED whenever it moves away, so
   *  the timestamp can never describe a state the row is no longer in. */
  transfer_done_at?: string | null
  /** Display name of the staff member who marked it done. Cleared with the timestamp. */
  transfer_done_by_name?: string | null
  transfer_note?: string | null
  anrede: string
  sex: string
  licence_category: string
  licence_activated: boolean
  licence_validated: boolean
  // ⚠ NOT `members` columns — they exist only on `sv_vm_check`, and requesting
  // them from members 400s the whole query. Declared here historically; kept as
  // optional-and-commented rather than silently deleted because several call
  // sites already work around them (useExplorerCache, TransfersPage), and a bare
  // removal would just move the surprise. Read them from sv_vm_check.
  // licence_activation_date — sv_vm_check only
  // licence_validation_date — sv_vm_check only
  vm_email: string
  ahv_nummer: string
  // Bank account IBAN for reimbursements (migration 117). Sensitive financial
  // PII — scoped own-member + admin only server-side, like ahv_nummer.
  iban: string | null
  // Member has verified their own reimbursement IBAN (migration 136). False for
  // ClubDesk-backfilled IBANs until the member confirms on the My-finances card.
  iban_confirmed?: boolean
  beitragskategorie: string
  // Alternate billing contact (migrations 133/136) — finance-managed. When
  // billing_different is true, invoices bill the billing_* contact (e.g. a
  // minor's parent/guardian or a paying company) instead of the member, and
  // pay-outs go to billing_iban.
  billing_different?: boolean
  billing_name?: string | null
  billing_email?: string | null
  billing_address?: string | null
  billing_plz?: string | null
  billing_ort?: string | null
  billing_phone?: string | null
  billing_iban?: string | null

  // Messaging
  communications_team_chat_enabled?: boolean
  communications_dm_enabled?: boolean
  communications_banned?: boolean
  push_preview_content?: boolean
  last_online_at?: string | null
  /** Annual pre-licence data check (migration 270) — when the member last confirmed their profile. */
  profile_verified_at?: string | null
  consent_decision?: ConsentDecision
  consent_prompted_at?: string | null

}

export interface MemberTeam extends BaseRecord {
  member: string
  team: string
  season: string
  guest_level: number  // 0=member, 1-3=guest levels

}

export interface TeamInvite extends BaseRecord {
  token: string
  team: string
  invited_by: string
  guest_level: number // 0=player, 1-3=guest
  status: 'pending' | 'claimed' | 'expired'
  claimed_by: string
  expires_at: string

}

export interface Hall extends BaseRecord {
  name: string
  address: string
  city: string
  courts: number
  notes: string
  maps_url: string
  homologation: boolean
  sv_hall_id: string

}

export interface PhotonFeature {
  geometry: { coordinates: [number, number] }
  properties: {
    name?: string
    street?: string
    housenumber?: string
    city?: string
    postcode?: string
    country?: string
    state?: string
    osm_key?: string
    osm_value?: string
  }
}

export interface LocationResult {
  name: string
  address: string
  city: string
  lat: number | null
  lon: number | null
  source: 'directus' | 'photon' | 'google'
}

export interface SlotClaim extends BaseRecord {
  hall_slot: string
  hall: string
  date: string
  start_time: string
  end_time: string
  claimed_by_team: string
  claimed_by_member: string
  freed_reason: 'cancelled_training' | 'away_game' | 'manual_free'
  freed_source_id: string
  notes: string
  status: 'active' | 'revoked'

}

export interface VirtualSlotMeta {
  source: 'game' | 'training' | 'hall_event'
  sourceId: string
  sourceRecord: Game | Training | HallEvent
  isAway?: boolean
  isCancelled?: boolean
  isFreed?: boolean
  isClaimed?: boolean
  claimRecord?: SlotClaim
  /** Spielhalle slot that is free (no game scheduled) */
  isSpielhalleFreed?: boolean
  /** Recurring training template surfaced as free for this week/day */
  isTemplateFreed?: boolean
  /** When a slot spans multiple halls (e.g. BB game in A+B), lists all hall IDs */
  spanHallIds?: string[]
}

export interface HallSlot extends BaseRecord {
  hall: string
  /** Flattened team IDs — see `flattenM2MTeams`. */
  team: string[]
  /**
   * Raw `hall_slots_teams` junction rows as fetched (`teams.id` +
   * `teams.teams_id`). Kept alongside `team` so saves can send the junction
   * PKs back — see `m2mUpdatePayload`.
   */
  teams?: unknown[]
  day_of_week: number
  start_time: string
  end_time: string
  slot_type: 'training' | 'game' | 'event' | 'away' | 'other'
  recurring: boolean
  valid_from: string
  valid_until: string
  indefinite: boolean
  label: string
  notes: string
  sport?: 'volleyball' | 'basketball' | ''

  _virtual?: VirtualSlotMeta
}

export interface HallClosure extends BaseRecord {
  hall: string
  start_date: string
  end_date: string
  reason: string
  source: 'hauswart' | 'admin' | 'auto' | 'gcal' | 'school_holidays'
  /**
   * Publish this closure to the hall administration's Google calendar
   * (migration 328). Opt-in — that calendar is the school's. Ignored for
   * source 'gcal' (came from there) and 'school_holidays' (theirs to enter).
   * Written for every row of a span+reason group at once.
   */
  push_to_gcal: boolean
}

export interface Game extends BaseRecord {
  game_id: string
  /**
   * Besammlung: minutes BEFORE the start that the team meets (migration 340).
   * null = no meeting time. Stored as an offset, not a clock, so it survives a
   * reschedule — derive the displayed time with meetingTimeFromOffset().
   */
  meeting_offset_minutes?: number | null
  home_team: string
  away_team: string
  kscw_team: string
  hall: string
  /** Extra halls this game also blocks (e.g. basketball A+B combo). Empty/null = single-hall. */
  additional_halls?: string[] | null
  away_hall_json: { name: string; address: string; city: string; plus_code?: string } | null
  date: string
  time: string
  league: string
  round: string
  season: string
  type: 'home' | 'away'
  status: 'scheduled' | 'live' | 'completed' | 'postponed' | 'cancelled'
  home_score: number
  away_score: number
  sets_json: unknown
  // Volleyball duty assignments
  scorer_member: string
  scoreboard_member: string
  scorer_scoreboard_member: string
  scorer_duty_team: string
  scoreboard_duty_team: string
  scorer_scoreboard_duty_team: string
  // Referee duty — HU20 home games use scorer + referee instead of scorer + Täfeler.
  // No licence required; assigned as a duty team like scorer (migration 182).
  referee_member: string
  referee_duty_team: string
  // Basketball duty assignments
  bb_scorer_member: string
  bb_timekeeper_member: string
  bb_24s_official: string
  bb_duty_team: string
  bb_scorer_duty_team: string
  bb_timekeeper_duty_team: string
  bb_24s_duty_team: string
  duty_confirmed: boolean
  /** Per-duty confirmation actor + time (set by the games.items.update hook, migration 123).
   *  A duty is "confirmed" iff it has a person; these record who put them there and when. */
  scorer_confirmed_by_name: string | null
  scorer_confirmed_at: string | null
  scoreboard_confirmed_by_name: string | null
  scoreboard_confirmed_at: string | null
  scorer_scoreboard_confirmed_by_name: string | null
  scorer_scoreboard_confirmed_at: string | null
  referee_confirmed_by_name: string | null
  referee_confirmed_at: string | null
  bb_scorer_confirmed_by_name: string | null
  bb_scorer_confirmed_at: string | null
  bb_timekeeper_confirmed_by_name: string | null
  bb_timekeeper_confirmed_at: string | null
  bb_24s_confirmed_by_name: string | null
  bb_24s_confirmed_at: string | null
  /** Per-role late-arrival reports (migration 202): { role: { at, by_name } }.
   *  Written/read only by the duty-late endpoint (GET/POST /kscw/games/:id/duty-late);
   *  no contact info is stored here. */
  duty_late_json?: Record<string, { at: string; by_name: string }> | null
  referees_json: Array<{ name: string; id?: number }>
  source: 'swiss_volley' | 'manual' | 'basketplan'
  svrz_push_status: 'pending' | 'pushed' | 'failed' | null
  respond_by: string
  min_participants: number
  /** Per-game override for auto-confirm RSVP. null = inherit team default. */
  auto_confirm_rsvp?: boolean | null

  /** Per-game override for auto-filing the Volleymanager Einsatzliste from confirmed
   *  RSVPs ~60 min before kickoff (migration 206). null = inherit the team default
   *  (`TeamSettings.auto_nomination_list`). Volleyball only — basketball has no VM. */
  auto_nomination_list?: boolean | null
  /** Einsatzliste push journal — written by the cron / push worker, read-only in the UI.
   *  `filled` = players written but the list left OPEN (VM flagged a fineable issue, so
   *  we refuse to close it); `closed` = filed and closed; `skipped` = nothing to file. */
  vm_nomination_status?: 'pending' | 'filled' | 'closed' | 'skipped' | 'failed' | null
  vm_nomination_list_id?: string | null
  vm_nomination_count?: number | null
  vm_nomination_pushed_at?: string | null
  vm_nomination_error?: string | null

}

/**
 * A game opened to another team (migration 271). The coach's intent; Postgres
 * materializes one `GameGuest` per player of that team from it.
 */
export interface GameGuestTeam extends BaseRecord {
  game: string | number
  team: string | number
  invited_by_name?: string | null
  invited_by_email?: string | null
}

/**
 * One player invited to a game from outside its own roster. Creates NO team
 * membership — the invitation is scoped to this single fixture.
 *
 * `via_team` names the team opening that produced the row; null means the coach
 * picked this person individually, which is why closing a team opening leaves them
 * invited.
 */
export interface GameGuest extends BaseRecord {
  game: string | number
  member: string | number
  via_team?: string | number | null
  invited_by_name?: string | null
  invited_by_email?: string | null
}

export interface SpielplanerAssignment extends BaseRecord {
  member: string | number
  kscw_team: string | number
}

/**
 * Input shape for creating a manual game via the Spielplanung modal or
 * bulk-import flow. The shape is deliberately simpler than `Game` —
 * Directus fills defaults (status, source, svrz_push_status) in the
 * payload builder.
 */
export interface ManualGameInput {
  kscw_team: string | number
  type: 'home' | 'away'
  opponent: string
  date: string // 'YYYY-MM-DD'
  time: string // 'HH:MM' — 24h
  hall?: string | number | null
  /** Extra halls this home game also blocks (e.g. basketball A+B combo). */
  additional_halls?: string[] | null
  away_hall_json?: {
    name: string
    address: string
    city: string
    plus_code?: string
  } | null
  league?: string
  round?: string
  /** Per-game override for auto-confirm RSVP. null = inherit team default. */
  auto_confirm_rsvp?: boolean | null
}

export interface RefereeExpense extends BaseRecord {
  game: string
  team: string
  paid_by_member: string
  paid_by_other: string
  amount: number
  notes: string
  recorded_by: string
}


export interface Ranking extends BaseRecord {
  team_id: string
  team: string
  team_name: string
  league: string
  rank: number
  played: number
  won: number
  lost: number
  wins_clear?: number
  wins_narrow?: number
  defeats_clear?: number
  defeats_narrow?: number
  sets_won: number
  sets_lost: number
  points_won: number
  points_lost: number
  points: number
  season: string
  updated_at: string

}

export interface Training extends BaseRecord {
  team: string
  /**
   * Besammlung: minutes BEFORE the start that the team meets (migration 340).
   * null = no meeting time. Stored as an offset, not a clock, so it survives a
   * reschedule — derive the displayed time with meetingTimeFromOffset().
   */
  meeting_offset_minutes?: number | null
  hall_slot: string
  date: string
  start_time: string
  end_time: string
  hall: string
  hall_name: string
  coach: string
  notes: string
  cancelled: boolean
  cancel_reason: string
  respond_by: string
  min_participants: number
  max_participants: number
  require_note_if_absent: boolean
  auto_cancel_on_min: boolean
  /** Guest tiers blocked from confirming/tentative on this training. Values 1-3. Empty = open to all. */
  excluded_guest_levels: number[]
  /** Per-training override for auto-confirm RSVP. null = inherit team default. */
  auto_confirm_rsvp?: boolean | null
  /** Trial training (Probetraining): publicly visible on the website when the team is open for new players. */
  is_trial?: boolean
  /** games.id whose warm-up block auto-shortened this training (sweep-managed, migration 191). */
  auto_shortened_by_game?: number | null
  /** End time before the game auto-shorten; set only while shortened. */
  original_end_time?: string | null
}

export interface Absence extends BaseRecord {
  member: string
  start_date: string
  end_date: string
  reason: 'injury' | 'vacation' | 'work' | 'personal' | 'other'
  reason_detail: string
  affects: string[] // 'all', 'trainings', 'games', 'events'
  type: 'standard' | 'weekly'
  days_of_week: number[] // 0=Mon..6=Sun (only for type='weekly')
  indefinite: boolean
  /**
   * Migration 076: when true (default), this absence blocks game-scheduling
   * availability on its dates. Set false for absences where the player won't
   * play anyway (long-term injury, maternity leave) so the rest of the squad
   * can still be scheduled. Only standard absences affecting games/all count.
   */
  blocking: boolean
  /** Migration 051: directus_users.id of the most recent authenticated writer. */
  last_edited_by?: string | null
  /** Migration 051: timestamp of the most recent authenticated write. */
  last_edited_at?: string | null
  /** Migration 053: display name of the writer (first_name + last_name). */
  last_edited_name?: string | null
  /** Migration 053: writer's role relative to the affected member. */
  last_edited_role?: 'coach' | 'team_responsible' | 'admin' | 'staff' | null
}

/**
 * Migration 085: team-level game-scheduling blackout ("Team blocking").
 * A row hard-blocks game scheduling for `team` on every date in
 * [start_date, end_date] — home-slot offering AND all three away proposals —
 * like a team event but coach/TR-managed with no RSVP/chat. Created in the
 * Team Absences view; scoped to coach/TR teams (admins/Spielplaner: any team).
 */
export interface SchedulingBlock extends BaseRecord {
  team: string
  start_date: string // YYYY-MM-DD
  end_date: string // YYYY-MM-DD
  reason: string | null
  created_by: string | null
  date_created?: string
  date_updated?: string
}

export interface Event extends BaseRecord {
  title: string
  /**
   * Besammlung: the wall-clock time ('HH:MM:SS') the group meets on the start
   * date (migration 340). null = none. Absolute rather than an offset because
   * an all_day event has no start clock to count back from.
   */
  meeting_time?: string | null
  description: string
  event_type: 'verein' | 'social' | 'meeting' | 'tournament' | 'trainingsweekend' | 'friendly' | 'other'
  start_date: string
  end_date: string
  all_day: boolean
  location: string
  hall: string
  teams: string[]
  created_by: string
  respond_by: string
  max_players: number
  min_participants: number
  participation_mode: 'whole' | 'per_day' | 'per_session' | ''
  require_note_if_absent: boolean
  allow_maybe: boolean
  features_enabled: FeatureToggles
  invited_roles: string[] | null
  invited_members: string[]
  send_email_invite: boolean
  cancelled: boolean
  cancel_reason: string
  /**
   * Public OpnForm signup link (forms.kscw.ch). The door for NON-members —
   * members RSVP natively, which is what feeds counts and rosters. kscw-website
   * renders this as the "Anmelden" CTA on club-wide events; in the member app it
   * is a share affordance, never a signup button.
   */
  signup_url?: string | null
  /**
   * Migration 310: the native guests' door. Minted server-side; `/e/:token`
   * renders a public signup page. Distinct from `signup_url` (the OpnForm door)
   * and from the members' `/events/:id` deep link — see ShareActivityButton.
   */
  public_share_token?: string | null
  /**
   * Migration 324: do the invited teams' GUEST players (member_teams.guest_level
   * > 0) count as invited? Defaults to true — undefined/null reads as "yes", so
   * only an explicit `false` narrows the audience to the core roster. Nothing to
   * do with `participations.guest_count` (+1s) or the public signup door.
   */
  invite_guests?: boolean
  /** Migration 194: opt-in to the J+S (Jugend+Sport) export. */
  js_relevant?: boolean
  /** J+S NDS activity type used when js_relevant is set. */
  js_activity_type?: 'Training' | 'Wettkampf' | 'Trainingstag' | 'Lagertag' | null

}

export interface EventSession extends BaseRecord {
  event: string
  date: string
  start_time: string
  end_time: string
  label: string
  sort_order: number

}

/** Standing VB referee → team duty (migration 200). Set on /admin/vb-referees.
 *  Many-to-many; `external` (team null) = duty outside Wiedikon. */
export interface VbRefereeDuty extends BaseRecord {
  referee: string | Member
  team: string | Team | null
  external: boolean
  external_label: string | null
  note: string | null
}

export interface HallEvent extends BaseRecord {
  uid: string
  title: string
  date: string
  /** Last day covered, INCLUSIVE (migration 325). Null/equal to `date` = single day. */
  end_date: string | null
  start_time: string
  end_time: string
  location: string
  all_day: boolean
  source: string
  /**
   * Does this calendar entry close the KWI halls? Since migration 325 every
   * hall-administration entry does, so: null = automatic (closes), false = admin
   * override, closes nothing, true = admin confirmed it closes.
   */
  closure_override: boolean | null
}

export type VolleyPosition = 'Setter' | 'Outside' | 'Middle' | 'Opposite' | 'Libero' | 'Universal'

export interface Participation extends BaseRecord {
  member: string
  activity_type: 'training' | 'game' | 'event'
  activity_id: string
  status: 'confirmed' | 'declined' | 'tentative' | 'waitlisted'
  note: string
  session_id: string
  guest_count: number
  is_staff: boolean
  waitlisted_at: string
  position_1?: VolleyPosition | null
  position_2?: VolleyPosition | null
  position_3?: VolleyPosition | null
  /** Set by the autoDeclineForAbsence hook when the cron writes a forced
   *  decline. Cleared to NULL by the BEFORE UPDATE trigger the moment a user
   *  changes `status` (migration 038), so a non-null marker is the definitive
   *  signal that "this row was system-set, not user-set". */
  auto_declined_by?: number | null
  /** Migration 352. Set by the daily deadline sweep when it declines a member
   *  who never answered before `respond_by` — the same "system-owned row"
   *  contract as `auto_declined_by`: `trg_participations_clear_auto_marker`
   *  flips it back to false the moment anyone changes `status`, so a surviving
   *  true means nobody has touched it. Without it the roster shows a bare
   *  "Declined" and a missed deadline is indistinguishable from a real "I
   *  can't come" — which is the distinction the late_signin fine charges for. */
  auto_declined_deadline?: boolean
  /** Per-field edit attribution (migration 047). Set by the kscw-hooks
   *  `participations.items.{create,update}` filter ONLY when the matching
   *  field is in the write payload, so editing the note doesn't reset the
   *  status attribution and vice versa. Null for system-context writes
   *  (cron auto-decline, hall-closure unwind) — those leave the tracker
   *  pair untouched, distinguishing them from staff edits. Roster modal
   *  renders "Edited to X by Y on Z" / "Note edited by Y on Z" as
   *  independent lines when these resolve to a user other than the
   *  participation's own member. */
  last_status_edited_by?: string | null
  last_status_edited_at?: string | null
  last_note_edited_by?: string | null
  last_note_edited_at?: string | null
}

export interface UserLog extends BaseRecord {
  user: string
  action: 'create' | 'update' | 'delete'
  collection_name: string
  record_id: string
  data: Record<string, unknown> | null
}

// Everything on a participation except the member link. Use it for logic that
// doesn't care whether `member` came back as a bare id or an expanded object —
// both Participation and ParticipationWithMember are assignable to it.
export type ParticipationBase = Omit<Participation, 'member'>

// `Participation.member` is a bare id; this variant is for reads that EXPAND it.
// It must Omit first — a plain intersection would collapse `member` to
// `string & Pick<Member, …>`, i.e. make the expanded object unrepresentable,
// which is what forced the `as any` casts this type exists to avoid.
export type ParticipationWithMember = ParticipationBase & {
  member: Pick<Member, 'id' | 'position'> | string
}

// ── Game Scheduling (Terminplanung) ──────────────────────────────────

export interface GameSchedulingSeason extends BaseRecord {
  season: string
  status: 'setup' | 'open' | 'closed'
  spielsamstage: SpielsamstagConfig[]
  team_slot_config: TeamSlotConfig | null
  /** Per-season game-spacing gaps in days. Null/missing → defaults {4,4,2}. */
  gap_config: GameSchedulingGapConfig | null
  /** First date the tool offers slots/away dates (YYYY-MM-DD). Null → Sep 1 of the season's first year. */
  season_opens: string | null
  /** Last date the tool offers slots/away dates (YYYY-MM-DD). Null → Mar 31 of the season's second year. */
  season_closes: string | null
  /** Date the SV feed takes over date/time/venue for tool-scheduled games (YYYY-MM-DD). Null → protect until the game is completed. */
  vm_authority_date: string | null
  /** When true, opponents get ONE link per club (/terminplanung/club/:token) instead of one per team. Set on 2027/28 onward. */
  use_club_portals?: boolean
  notes: string

}

export interface GameSchedulingGapConfig {
  /** Min days between a home game and any other committed game. */
  home: number
  /** Same, for away proposals 1 & 2. */
  proposal: number
  /** Same, for the lenient 3rd away proposal. */
  proposal3: number
}

export interface SpielsamstagConfig {
  date: string
  slots: { time: string; hall_id: string }[]
}

/** One head-to-head leg of an intra-club derby (e.g. H1 vs H3) — Art. 27 SVRZ. */
export interface DerbyLeg {
  svrz_id: string
  display_name: string | null
  home_team: { id: number; name: string }
  away_team: { id: number; name: string }
  /** Placeholder/scheduled datetime as the SVRZ feed currently has it. */
  feed_datetime: string | null
  /** Round the feed currently files it under, e.g. "Runde 7" (the case Art. 27 overrides). */
  round: string | null
  /** Date the spielplaner fixed (YYYY-MM-DD), or null. */
  date: string | null
  half: 'vorrunde' | 'rueckrunde' | null
}

/** A detected derby pair: two KSCW teams sharing a league group + their two legs. */
export interface Derby {
  team_a: { id: number; name: string }
  team_b: { id: number; name: string }
  legs: DerbyLeg[]
  confirmed: boolean
  stored_id: number | null
}

export interface DerbiesResponse {
  season: string
  /** Vor-/Rückrunde boundary (YYYY-01-01) the halves split on. */
  boundary: string | null
  derbies: Derby[]
}

export interface TeamSlotConfig {
  [teamId: string]: {
    /** Additive home-slot sources. Empty/absent = manual (no slots generated).
     *  'hall_slot' = the team's latest Doltschi/KWI evening slots (end 21:30);
     *  'spielsamstag' = the central Game-Saturday pool. Both may be active. */
    sources?: ('hall_slot' | 'spielsamstag')[]
    /** @deprecated legacy single-select — still read for back-compat. */
    source?: 'hall_slot' | 'spielsamstag' | 'manual'
    hall_slot_id?: string
  }
}

export interface GameSchedulingSlot extends BaseRecord {
  /** game_scheduling_seasons id (integer FK since migration 251). */
  season: number
  kscw_team: string
  date: string
  start_time: string
  end_time: string
  hall: string
  source: 'hall_slot' | 'spielsamstag' | 'spielhalle' | 'manual'
  status: 'available' | 'booked' | 'blocked'

}

export type InviteStatus = 'invited' | 'viewed' | 'booked' | 'revoked' | 'expired' | 'active'
export type InviteSource = 'self_registration' | 'manual' | 'svrz'

export interface GameSchedulingOpponent extends BaseRecord {
  season: string | number | null
  club_name: string
  team_name?: string | null
  contact_name: string
  contact_email: string
  kscw_team: string
  token: string
  home_game: string
  away_game: string
  status?: InviteStatus
  source?: InviteSource
  created_by_admin?: boolean
  first_viewed_at?: string | null
  expires_at?: string | null
  /** When the opponent was last asked to pick 3 new home slots (all prior proposals invalidated). */
  new_slots_requested_at?: string | null
  /** Free-text note from KSCW shown to the opponent on their proposal page (editable in the dashboard). */
  kscw_note?: string | null
  /** Free-text remark written by the opponent (read-only for KSCW, shown in the dashboard). */
  opponent_note?: string | null
  /** contact_name/contact_email above is the UNION; these split it into the two
   *  sources for display. Calendar = club Spielplanverantwortliche; team = the
   *  opponent team's own responsibles. Comma-joined; empty on not-yet-resynced rows. */
  calendar_contact_name?: string | null
  calendar_contact_email?: string | null
  team_contact_name?: string | null
  team_contact_email?: string | null
}

/** Live validity of one proposed home slot (GET /admin/terminplanung/proposal-health). */
export interface ProposalHealthProposal {
  num: number
  slot_id: number
  valid: boolean
  /** Short reason code when invalid: taken | team_event | team_block | hall_closed | too_close | derby | doltschi_cap | doltschi_taken | cross_team */
  reason: string | null
  /** For reason='cross_team': the KSCW team(s) already playing that day. */
  teams?: string[]
  /** For the lenient 3rd pick (num===3) / away proposals: players absent on that date (0 = none). */
  absences?: number
  /** Names of the players absent on that date (admin-only). */
  absent_names?: string[]
  /** Nearest already-scheduled game before this date (gap in days). */
  prev_game?: { date: string; days: number } | null
  /** Nearest already-scheduled game after this date (gap in days). */
  next_game?: { date: string; days: number } | null
}

export interface ProposalHealthEntry {
  booking_id: number
  opponent_id: number
  /** SVRZ fixture this booking schedules (multi-game pairings); null = legacy/non-SVRZ. */
  svrz_game_id?: string | null
  opponent_label: string
  kscw_team: number
  proposals: ProposalHealthProposal[]
  alive_count: number
  all_dead: boolean
}

export interface OpponentInvite {
  id: string
  team_name: string
  contact_name: string
  contact_email: string
  token: string
  kscw_team: string
  season: string | number | null
  status: InviteStatus
  source: InviteSource
  created_by_admin: boolean
  first_viewed_at: string | null
  email_sent_at?: string | null
  expires_at: string
  date_created: string
}

export interface GameSchedulingBooking extends BaseRecord {
  /** game_scheduling_seasons id (integer FK since migration 251). */
  season: number
  opponent: string
  type: 'home_slot_pick' | 'away_proposal'
  /** SVRZ fixture (svrz_games.svrz_persistence_id) this booking schedules — a
   *  pairing can be played 2-3× per season. NULL = legacy/non-SVRZ booking,
   *  owned by the first fixture of its side. */
  svrz_game_id?: string | null
  slot: string
  proposed_datetime_1: string
  proposed_place_1: string
  proposed_datetime_2: string
  proposed_place_2: string
  proposed_datetime_3: string
  proposed_place_3: string
  /** Home-slot proposals (slot ids) while a home booking is pending. */
  proposed_slot_1: string | number | null
  proposed_slot_2: string | number | null
  proposed_slot_3: string | number | null
  confirmed_proposal: number
  status: 'pending' | 'confirmed' | 'rejected'
  admin_notes: string
  /** Name + email of the opponent-club person who submitted this proposal
   *  (captured by the confirm modal on the opponent page). */
  proposed_by_name?: string | null
  proposed_by_email?: string | null
  /** Name + email of the KSCW spielplaner/admin who confirmed the proposal or
   *  manually entered this booking (captured at action time, migration 112). */
  confirmed_by_name?: string | null
  confirmed_by_email?: string | null
  /** When the booking was confirmed / manually entered (migration 113). */
  confirmed_at?: string | null
  /** VolleyManager push tracking (home_slot_pick only). */
  vm_push_status?: 'queued' | 'pushed' | 'pushed_no_hall' | 'needs_pick' | 'no_fixture' | 'failed' | null
  vm_game_id?: string | null
  vm_pushed_at?: string | null
  /** Failure message, OR a JSON {"needs_pick":[{id,label,date}]} candidate list. */
  vm_push_error?: string | null
}

/** One offered time block for a basketball home date (ProBasket template: up to 3). */
export interface HallAvailabilityWindow {
  hall: string
  /** 'HH:MM' */
  from: string
  /** 'HH:MM' */
  to: string
}

/**
 * Per basketball team, per candidate home date (Fri/Sat/Sun), KWI hall availability
 * for ProBasket scheduling (migration 214). Basketball has no opponent/token/booking
 * flow — the association owns the schedule; this just records what we can host, edited
 * in the Basketball prep view and (later) exported to the ProBasket Excel template.
 */
export interface BasketballHallAvailability extends BaseRecord {
  /** game_scheduling_seasons.id (shared sport-neutral season identity). */
  season: string | number
  /** teams.id (teams.sport = 'basketball'). */
  team: string | number
  /** 'YYYY-MM-DD' */
  date: string
  /** The ProBasket template's "Nicht verfügbar" x — the hall is not available that day. */
  unavailable: boolean
  /** Offered time blocks (up to 3), matching the ProBasket template. */
  windows: HallAvailabilityWindow[]
  note?: string | null
  created_by?: string | number | null
}

/**
 * A basketball game placed into a fixed KWI hall slot for the ProBasket
 * Spielplansitzung (migration 216). One row per (season, date, time, hall).
 */
export interface BasketballSlotPlan extends BaseRecord {
  season: string | number
  /** 'YYYY-MM-DD' */
  date: string
  /** 'HH:MM' tip-off */
  time: string
  /** 'KWI A' | 'KWI B' | 'KWI C' | 'KWI A+B' */
  hall: string
  /** teams.id, or null when the KSCW side is free-text. */
  kscw_team?: string | number | null
  kscw_team_label?: string | null
  opponent?: string | null
  sex?: 'm' | 'f' | 'mixed' | null
  /** 'home' = KSCW hosts at KWI; 'guest' = a guest game occupying the hall. */
  game_type?: 'home' | 'guest'
  note?: string | null
  created_by?: string | number | null
}

/**
 * A coach/player-sharing link between two teams, per season + sport
 * (migrations 217 basketball, 218 generalized to `team_links`).
 * 'diff'     = must not play the same time (shared person);
 * 'same'     = keep at the same time;
 * 'adjacent' = must not overlap, but keep in adjacent time slots when possible
 *              (e.g. 1xDU18 ↔ Lions D1 — different time, but back-to-back if it fits).
 */
export interface TeamLink extends BaseRecord {
  season: string | number
  sport: 'basketball' | 'volleyball'
  team_a: string | number
  team_b: string | number
  link_type: 'same' | 'diff' | 'adjacent'
  created_by?: string | number | null
}

/** @deprecated Use {@link TeamLink}. Kept as an alias during the 217→218 rename. */
export type BasketballTeamLink = TeamLink

export interface ScorerDelegation extends BaseRecord {
  game: string
  role: 'scorer' | 'scoreboard' | 'scorer_scoreboard' | 'referee' | 'bb_scorer' | 'bb_timekeeper' | 'bb_24s_official'
  from_member: string
  to_member: string
  from_team: string
  to_team: string
  same_team: boolean
  status: 'pending' | 'accepted' | 'declined' | 'expired'

}

export interface Notification extends BaseRecord {
  member: string
  type: 'activity_change' | 'upcoming_activity' | 'deadline_reminder' | 'result_available' | 'duty_delegation_request' | 'member_join_request' | 'poll_created' | 'event_invite' | 'new_report' | 'form_published' | 'form_submission' | 'form_reminder' | 'expense_status' | 'announcement' | 'licence_status' | 'auto_declined_deadline'
  title: string
  body: string
  activity_type: 'game' | 'training' | 'event' | 'scorer_duty' | 'team' | 'poll' | 'report' | 'form' | 'expense' | 'announcement' | 'fine' | ''
  activity_id: string
  team: string
  read: boolean
}

// ── Announcements (Vereinsnews) ────────────────────────────────────

export type AnnouncementLocale = 'de' | 'en' | 'fr' | 'gsw' | 'it'

export interface AnnouncementTranslation {
  title: string
  /** HTML body (sanitized at render via RichText component) */
  body: string
}

export type AnnouncementAudienceType = 'all' | 'sport' | 'teams' | 'roles'

export interface Announcement extends BaseRecord {
  /** UUID of directus_files (hero image), or null */
  image: string | null
  /** Optional CTA link (external or internal). */
  link: string
  /** Sticky to top of feed when true. */
  pinned: boolean
  /** ISO timestamp; null = draft (not visible to members). */
  published_at: string | null
  /** Optional auto-hide timestamp. */
  expires_at: string | null
  audience_type: AnnouncementAudienceType
  /** When audience_type='sport' */
  audience_sport: 'volleyball' | 'basketball' | null
  /** When audience_type='teams' (schema-ready, hidden in v1 admin UI). */
  audience_teams: string[]
  /** When audience_type='roles' (schema-ready, hidden in v1 admin UI). */
  audience_roles: string[]
  /** Per-post toggle: also send web push on publish. */
  notify_push: boolean
  /** Per-post toggle: also send email on publish. */
  notify_email: boolean
  /** Email template (migration 204): standard branded card or newsletter masthead. */
  email_layout?: 'standard' | 'newsletter'
  /** Optional Reply-To for the announcement emails; null/empty = no-reply (migration 204). */
  reply_to?: string | null
  /** M2O → members.id (autofill). */
  created_by: string | null
  /** Set by backend hook after push/email fanout — prevents re-sending on edit. */
  fanout_sent_at: string | null
  /** Per-locale title + HTML body. German required. */
  translations: Partial<Record<AnnouncementLocale, AnnouncementTranslation>>
}

// ── Polls ───────────────────────────────────────────────────────────────

export interface Poll extends BaseRecord {
  team: string | null
  conversation?: string | null
  question: string
  options: string[]
  mode: 'single' | 'multi'
  deadline: string | null
  created_by: string
  status: 'open' | 'closed'
  anonymous: boolean
  /** Everyone (not just managers) may see the aggregate totals. Migration 171. */
  results_visible?: boolean
}

export interface PollVote extends BaseRecord {
  poll: string
  member: string
  selected_options: number[]
}

// ─── Messaging ───────────────────────────────────────────────

export type ConversationType = 'team' | 'dm' | 'dm_request' | 'activity_chat' | 'group_dm'

export type ConversationActivityType = 'event'

export interface Conversation extends BaseRecord {
  type: ConversationType
  team: string | null
  title: string | null
  created_by: string
  created_at: string
  last_message_at: string | null
  last_message_preview: string | null
  /** activity_chat only — 'event' in Plan 02. */
  activity_type?: ConversationActivityType | null
  /** activity_chat only — integer FK at DB level (string in client-side JSON). */
  activity_id?: number | string | null
}

export type ConversationMemberRole = 'member' | 'moderator'

export interface ConversationMember extends BaseRecord {
  conversation: string
  member: string
  role: ConversationMemberRole
  joined_at: string
  last_read_at: string | null
  muted: boolean
  archived: boolean
}

export type MessageType = 'text' | 'poll'

export interface Message extends BaseRecord {
  conversation: string
  sender: string
  type: MessageType
  body: string | null
  poll: string | null
  created_at: string
  edited_at: string | null
  deleted_at: string | null
}

export interface MessageReaction extends BaseRecord {
  message: string
  member: string
  emoji: string
  created_at: string
}

export interface Block extends BaseRecord {
  blocker: string
  blocked: string
  created_at: string
}

export type MessageRequestStatus = 'pending' | 'accepted' | 'declined'

export interface MessageRequest extends BaseRecord {
  conversation: string
  sender: string
  recipient: string
  status: MessageRequestStatus
  created_at: string
  resolved_at: string | null
}

export type ReportReason =
  | 'harassment' | 'spam' | 'inappropriate' | 'other' | 'moderator_delete'
export type ReportStatus = 'open' | 'resolved' | 'dismissed'

export interface Report extends BaseRecord {
  reporter: string | null
  reported_member: string | null
  message: string | null
  conversation: string | null
  reason: ReportReason
  note: string | null
  message_snapshot: string | null
  status: ReportStatus
  resolved_by: string | null
  resolved_at: string | null
  created_at: string
}

export type ConsentDecision = 'pending' | 'declined' | 'accepted'

// ── Fines (migration 069) ───────────────────────────────────────────────

export type FineCategory = 'late_signin' | 'no_show' | 'late_payment' | 'custom'
export type FineStatus = 'open' | 'paid' | 'waived'
export type FineActivityType = 'training' | 'game' | 'event'
export type FinePayMethod = 'cash' | 'twint' | 'transfer' | 'other'
export type FinePayTo = 'team_kasse' | 'club_kasse'
export type FineResetWindow = 'calendar_month' | 'rolling_30d' | 'rolling_90d' | 'season' | 'never'

export interface FineRuleTier {
  /** Exact-match offense number. Use this OR offense_min (not both). */
  offense?: number
  /** Catch-all for "Nth offense and beyond". Use on the last tier. */
  offense_min?: number
  amount: number
}

export interface FineRule extends BaseRecord {
  team: string
  category: FineCategory
  enabled: boolean
  reset_window: FineResetWindow
  tiers: FineRuleTier[]
  currency: string
  notes?: string | null
  updated_by?: string | null
}

export interface Fine extends BaseRecord {
  /** `null` = a team-level fine (migration 350): owed by the team, not a member. */
  member: string | null
  team: string
  category: FineCategory
  amount: number
  currency: string
  status: FineStatus
  activity_type: FineActivityType | null
  activity_id: string | null
  activity_date: string | null
  /** Snapshot: which Nth offense this was within the window at issue time. */
  tier_offense: number | null
  /** Snapshot: which reset_window the engine used. */
  reset_window_at_issue: FineResetWindow | null
  reason: string | null
  issued_by: string | null
  issued_at: string
  paid_at: string | null
  paid_method: FinePayMethod | null
  paid_to: FinePayTo | null
  paid_received_by: string | null
  waived_at: string | null
  waived_by: string | null
  waived_reason: string | null
  auto_issued: boolean
  notes: string | null
}
