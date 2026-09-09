/**
 * KSCW Directus Hooks Extension — Lean Version
 *
 * Most validation & notification logic has been pushed to Postgres triggers:
 *   - trg_slot_claims_validate      (past dates, duplicate claims)
 *   - trg_members_shell_convert     (shell→full on password set)
 *   - trg_members_coach_approval_guard (coach_approved requires member_teams)
 *   - trg_participations_guest_block (guests can't confirm games)
 *   - trg_trainings_revoke_claims   (auto-revoke on uncancelling)
 *   - trg_games_notify              (batch notifications on game CRUD)
 *   - trg_trainings_notify          (batch notifications on training CRUD)
 *   - trg_events_notify             (batch notifications on event CRUD)
 *   - trg_scorer_delegation_validate (same-team auto-accept)
 *   - Postgres DEFAULT values: members.language='german', birthdate_visibility='hidden'
 *
 * This extension only handles logic that CANNOT run in Postgres:
 *   1. Auth hooks (wiedisync_active on login — needs Directus auth event)
 *   2. Crons with email/HTTP (participation reminders, scorer reminders, shell lifecycle)
 *   3. Notification cleanup (old notifications)
 */

import { logCronError, logCronRun, logWarning, logAuthDenial, cleanOldLogs, writeErrorLog } from '../../kscw-endpoints/src/error-log.js'
import { initSentry } from '../../kscw-endpoints/src/sentry.js'
import { buildEmailLayout, buildNewsletterEmail, buildInfoCard, buildAlertBox, bucketEmailsByLocale } from '../../kscw-endpoints/src/email-template.js'
import { sendLocalizedPush, bucketMembersByLocale, tPush } from '../../kscw-endpoints/src/push-i18n.js'
import { mintSignupToken, signupInviteUrl, buildGuideHtml } from '../../kscw-endpoints/src/signup-invites.js'
import { bbRequiredDocsAfterWaiver, parseWaivedDocs, fibaNatCode } from '../../kscw-endpoints/src/bb-docs.js'
import { TEMPLATE_FIELDS, validateTemplate, sanitizeTemplateHtml } from '../../kscw-endpoints/src/email-templates.js'
import { gameStartMs } from '../../kscw-endpoints/src/scorer-roster.js'
import { teamPeopleSql, notGuestAnywhereSql } from '../../kscw-endpoints/src/activity-roster-sql.js'
import { sweepTrainingAutoConfirm } from '../../kscw-endpoints/src/training-auto-confirm-sweep.js'
import { currentSeasonShort, seasonStartYear } from '../../kscw-endpoints/src/season.js'
import { resolveMemberSports, sportAdminScope, sportScopeAllows } from '../../kscw-endpoints/src/member-sport.js'
import { createActingMemberMiddleware } from './acting-member.js'
import { isLicenceStatus, notifyLicenceStatusChange, runLicenceStatusSweep } from '../../kscw-endpoints/src/licence-status.js'
import { parseJsonArray, resolveMemberAudience } from '../../kscw-endpoints/src/audience.js'
import { loadSuppressed } from '../../kscw-endpoints/src/email-suppression.js'
import { registerAuditHook } from './audit.js'
import { sanitizeAnnouncementHtml } from './sanitize-html.js'
import { snapshotSlot, cascadeSlotUpdate, generateInitialTrainings, topUpIndefiniteSlots, addTrainingSkip, clearTrainingSkip } from './slot-cascade.js'
import { sweepGameTrainingShorten, sweepGameClashDeclines } from './game-training-shorten.js'

// Frontend URL — env var or auto-detect from Directus PUBLIC_URL
const FRONTEND_URL = process.env.FRONTEND_URL
  || (process.env.PUBLIC_URL?.includes('directus-dev') ? 'https://wiedisync.pages.dev' : 'https://wiedisync.kscw.ch')

// Escape user/admin-supplied text before interpolating into outbound email
// HTML. Used by registration rejection emails and any other place where a
// human-controlled string lands in an `html:` mail body.
function escapeEmailHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Strictly-validated YYYY-MM-DD date string for safe interpolation into
// `database.raw` SQL templates. PG `date` columns come back as `Date` or
// `string` depending on the driver — both paths funnel through this guard
// before reaching SQL text. Returns null when the input doesn't match the
// shape (caller must abort / skip rather than continue with an injection-
// shaped value). 2026-05-12 audit finding #9.
function safeDateStr(input) {
  if (!input) return null
  const raw = input?.toISOString?.().split('T')[0] || String(input).split('T')[0]
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null
}

/**
 * Everyone expected at a game: its own roster, PLUS the guests a coach opened it to
 * (migration 271), PLUS the team's staff (2026-08-15). A drop-in replacement for
 * `JOIN member_teams mt ON mt.team = g.kscw_team` — it still exposes `mt.member` and
 * `mt.guest_level`, so the surrounding query is unchanged, and now also `mt.is_staff`.
 * Requires the games table to be aliased `g`.
 *
 * Game guests report `guest_level = 0` deliberately: that column means "guest player of
 * this TEAM" (someone training along who may not play league games — see
 * trg_participations_guest_block), which is the opposite of a game guest, who was
 * invited precisely in order to play. The existing `guest_level = 0` filters in these
 * queries therefore include them, which is what we want.
 *
 * Staff are the `teamPeopleSql` set inlined (coaches ∪ team responsibles, minus anyone
 * already on the roster — a player-coach is a player, one row). They were missing from
 * every reminder here: a coach got no RSVP deadline nudge and no "game tomorrow", on a
 * sheet they are expected at. The second NOT EXISTS keeps a staff member who is ALSO a
 * game guest from arriving twice with conflicting is_staff — a duplicate row here is a
 * duplicate notification, not just a wasted join.
 *
 * NOT used by the auto-confirm paths. Being lent to a game is not consent to play it —
 * a guest answers for themselves. Used by the reminder and absence sweeps, where the
 * whole point is to treat them like anyone else on the sheet.
 */
const GAME_SQUAD_JOIN = `JOIN (
          SELECT g2.id AS game, mt2.member, COALESCE(mt2.guest_level, 0) AS guest_level, false AS is_staff
          FROM games g2 JOIN member_teams mt2 ON mt2.team = g2.kscw_team
          UNION
          SELECT gg.game, gg.member, 0, false FROM game_guests gg
          UNION
          SELECT g3.id, s.members_id, 0, true
          FROM games g3
          JOIN (
            SELECT teams_id, members_id FROM teams_coaches
            UNION
            SELECT teams_id, members_id FROM teams_responsibles
          ) s ON s.teams_id = g3.kscw_team
          WHERE NOT EXISTS (
            SELECT 1 FROM member_teams m2 WHERE m2.team = g3.kscw_team AND m2.member = s.members_id
          ) AND NOT EXISTS (
            SELECT 1 FROM game_guests gg2 WHERE gg2.game = g3.id AND gg2.member = s.members_id
          )
        ) mt ON mt.game = g.id`

const PUSH_WORKER_URL = process.env.PUSH_WORKER_URL || 'https://kscw-push.lucanepa.workers.dev'
const PUSH_AUTH_SECRET = process.env.PUSH_AUTH_SECRET || ''

async function sendPushToMembers(db, memberIds, title, body, url, tag, log) {
  if (!memberIds || memberIds.length === 0 || !PUSH_AUTH_SECRET) return
  try {
    const subscriptions = await db('push_subscriptions')
      .whereIn('member', memberIds)
      .select('endpoint', 'keys_p256dh', 'keys_auth')
    if (subscriptions.length === 0) return

    const resp = await fetch(`${PUSH_WORKER_URL}/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${PUSH_AUTH_SECRET}`,
      },
      body: JSON.stringify({
        subscriptions: subscriptions.map(s => ({
          endpoint: s.endpoint,
          keys: { p256dh: s.keys_p256dh, auth: s.keys_auth },
        })),
        title: title || 'KSC Wiedikon',
        body: body || '',
        url: url || FRONTEND_URL,
        ...(tag ? { tag } : {}),
      }),
      signal: AbortSignal.timeout(15000),
    })

    if (resp.ok) {
      const data = await resp.json()
      // Clean up expired subscriptions
      if (data.expired?.length > 0) {
        await db('push_subscriptions').whereIn('endpoint', data.expired).delete()
      }
      log.info(`[push] Sent ${data.sent || 0}, failed ${data.failed || 0}, cleaned ${data.expired?.length || 0}`)
    }
  } catch (err) {
    log.warn({ msg: `[push] Failed: ${err.message}`, event: 'push_send', memberCount: memberIds?.length, stack: err.stack })
    logWarning('push_send_failed', err.message, { memberCount: memberIds?.length, stack: err.stack })
  }
}

// Junction create payloads deliver the related field as a bare id OR a
// junction-object (`{ id: 108 }`, the M2M write format the app uses) — unwrap
// to a scalar so it can be used directly in `.where('id', …)`.
function toIdValue(v) {
  return v && typeof v === 'object' ? (v.id ?? v) : v
}

// ── Role Sync ────────────────────────────────────────────────────
// Keeps each member's Directus user role in sync with their app role
// (members.role array) and coach/TR junction membership.
//
// Directus 11: one role per user, multiple policies per role.
// Priority: superuser/admin > Sport Admin > Vorstand+Coach > Vorstand > Team Responsible > Member

/**
 * Determine the correct Directus role for a member.
 * @returns {{ userId: string, roleName: string } | null}
 */
async function resolveDirectusRole(db, memberId) {
  const member = await db('members').where('id', memberId).select('role', 'user').first()
  if (!member || !member.user) return null

  const roles = Array.isArray(member.role) ? member.role : []

  if (roles.includes('superuser') || roles.includes('admin')) {
    return { userId: member.user, roleName: 'Superuser' }
  }
  if (roles.includes('vb_admin') || roles.includes('bb_admin')) {
    return { userId: member.user, roleName: 'Sport Admin' }
  }

  // Check coach/TR junctions
  const isCoach = await db('teams_coaches').where('members_id', memberId).first()
  const isTR = await db('teams_responsibles').where('members_id', memberId).first()
  const isTeamResponsible = !!(isCoach || isTR)

  // Vorstand who is also a coach → Team Responsible (higher write access)
  if (roles.includes('vorstand') && isTeamResponsible) {
    return { userId: member.user, roleName: 'Team Responsible' }
  }
  if (roles.includes('vorstand')) {
    return { userId: member.user, roleName: 'Vorstand' }
  }
  if (isTeamResponsible) {
    return { userId: member.user, roleName: 'Team Responsible' }
  }

  return { userId: member.user, roleName: 'Member' }
}

// ── Turnstile CAPTCHA ────────────────────────────────────────────
// Directus filter hooks don't receive HTTP headers, so we use AsyncLocalStorage
// to bridge the X-Turnstile-Token header from middleware into filter hooks.
import { AsyncLocalStorage } from 'node:async_hooks'

const turnstileStore = new AsyncLocalStorage()
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || ''

async function verifyTurnstile(token) {
  if (!TURNSTILE_SECRET) return true // skip in dev
  if (!token) return false
  const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: token }).toString(),
  })
  const data = await resp.json()
  return data.success === true
}

// Why password auth instead of a static admin token:
// Directus can silently invalidate static tokens on role/schema changes,
// which caused SV/BP syncs to log "401 Invalid user credentials" unnoticed.
// Logging in per-run exchanges env credentials for a short-lived access_token,
// which is resilient to those invalidations.
async function getCronAccessToken(log, contextName) {
  const email = process.env.DIRECTUS_SYNC_EMAIL
  const password = process.env.DIRECTUS_SYNC_PASSWORD
  if (!email || !password) {
    log.warn(`${contextName} skipped: DIRECTUS_SYNC_EMAIL or DIRECTUS_SYNC_PASSWORD not set`)
    return null
  }
  const r = await fetch('http://localhost:8055/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`auth/login ${r.status}: ${body.slice(0, 200)}`)
  }
  const { data } = await r.json()
  if (!data?.access_token) throw new Error('auth/login returned no access_token')
  return data.access_token
}

export default ({ action, filter, init, schedule }, { services, database, logger, getSchema }) => {
  initSentry().catch(() => {})
  const log = logger.child({ extension: 'kscw-hooks' })

  // ── 0. Turnstile Middleware + Filter Hooks ─────────────────────
  // Capture X-Turnstile-Token from request headers via AsyncLocalStorage,
  // then validate in filter hooks for public item creation.

  init('middlewares.before', ({ app }) => {
    app.use((req, _res, next) => {
      const token = req.headers['x-turnstile-token'] || ''
      turnstileStore.run({ turnstileToken: token }, next)
    })
  })

  // ── 0b. Acting-member swap (households, migration 348) ─────────
  // MUST be 'middlewares.after': it narrows an already-authenticated identity,
  // so it has to run AFTER Directus's `authenticate` (which builds
  // req.accountability) and BEFORE any route reads it. Verified ordering in the
  // running image: authenticate :220 → cache :226 → middlewares.after :227 →
  // endpoint router :273. See acting-member.js for the full contract.
  init('middlewares.after', ({ app }) => {
    app.use(createActingMemberMiddleware(database, log))
  })

  // Block unauthenticated members.create / feedback.create / event_signups.create / mixed_tournament_signups.create without valid Turnstile
  filter('items.create', async (payload, meta, context) => {
    const collection = meta.collection
    if (collection !== 'members' && collection !== 'feedback' && collection !== 'event_signups' && collection !== 'mixed_tournament_signups') return payload

    // Skip for authenticated users (admins creating members, logged-in feedback)
    if (context.accountability?.user) return payload

    // Skip in dev (no secret configured)
    if (!TURNSTILE_SECRET) return payload

    const store = turnstileStore.getStore()
    const token = store?.turnstileToken
    if (!(await verifyTurnstile(token))) {
      log.warn({
        msg: 'Turnstile CAPTCHA failed on public create',
        collection,
        event: 'captcha_failed',
      })
      logWarning('captcha_failed', 'Turnstile verification failed', { collection })
      const err = new Error('Captcha verification failed')
      err.status = 403
      throw err
    }
    return payload
  })

  // ── Feedback screenshots → private folder (security audit 2026-05-31) ──────
  // Anon can fetch any uploaded file via GET /assets/:id; the public
  // directus_files read is scoped to FOLDER-LESS files (setup-permissions.mjs),
  // so move feedback screenshots — which can contain a member's authenticated
  // screen / PII — into a private folder on create/update. /assets then 403s
  // them for anon while the folder-less public photos keep serving. The folder
  // is created by migration 074 with this fixed UUID on every environment.
  const FEEDBACK_FILES_FOLDER = 'feedbac0-0000-4000-8000-000000000001'
  async function quarantineFeedbackScreenshot(feedbackId) {
    try {
      if (!feedbackId) return
      const row = await database('feedback').where('id', feedbackId).select('screenshot', 'screenshots').first()
      // Quarantine EVERY attached screenshot (migration 166 added the array;
      // `screenshot` mirrors the first). Union covers both old + new rows.
      const ids = new Set()
      if (row?.screenshot) ids.add(row.screenshot)
      let arr = row?.screenshots
      if (typeof arr === 'string') { try { arr = JSON.parse(arr) } catch { arr = [] } }
      if (Array.isArray(arr)) for (const id of arr) { if (id) ids.add(id) }
      if (ids.size > 0) {
        await database('directus_files').whereIn('id', [...ids]).update({ folder: FEEDBACK_FILES_FOLDER })
      }
    } catch (err) {
      log.error({ msg: `[feedback-quarantine] ${err.message}`, event: 'feedback_quarantine', stack: err.stack })
    }
  }
  action('feedback.items.create', async ({ key }) => { await quarantineFeedbackScreenshot(key) })
  action('feedback.items.update', async ({ keys }) => {
    for (const k of (Array.isArray(keys) ? keys : [])) await quarantineFeedbackScreenshot(k)
  })

  // ── Registration ID scans → private folder (security audit HIGH #3) ──────
  // Registration uploads — government-ID front/back plus basketball licence /
  // self- & national-declaration docs — are posted anon via POST /files and are
  // therefore FOLDER-LESS, i.e. anon-readable via GET /assets/:id (live PII
  // leak). Mirror the feedback quarantine: move every attached file into the
  // private folder on create/update so /assets 403s them for anon while the
  // folder-less public photos keep serving. Migration 167 creates the folder
  // with this fixed UUID on every environment and moves the EXISTING files;
  // this hook covers FUTURE uploads. Best-effort (try/catch + log).
  const REGISTRATION_FILES_FOLDER = 'a0000167-0000-4000-8000-000000000001'
  const REGISTRATION_FILE_COLS = ['id_upload_front', 'id_upload_back', 'bb_doc_lizenz', 'bb_doc_freibrief', 'bb_doc_selfdecl', 'bb_doc_natdecl', 'bb_doc_u18parents', 'bb_doc_schoolcert']
  async function quarantineRegistrationDocs(registrationId) {
    try {
      if (!registrationId) return
      const row = await database('registrations').where('id', registrationId).select(...REGISTRATION_FILE_COLS).first()
      const ids = new Set()
      for (const col of REGISTRATION_FILE_COLS) { if (row?.[col]) ids.add(row[col]) }
      if (ids.size > 0) {
        await database('directus_files').whereIn('id', [...ids]).update({ folder: REGISTRATION_FILES_FOLDER })
      }
    } catch (err) {
      log.error({ msg: `[registration-quarantine] ${err.message}`, event: 'registration_quarantine', stack: err.stack })
    }
  }
  action('registrations.items.create', async ({ key }) => { await quarantineRegistrationDocs(key) })
  action('registrations.items.update', async ({ keys }) => {
    for (const k of (Array.isArray(keys) ? keys : [])) await quarantineRegistrationDocs(k)
  })

  // ── 0b. Cascade: Directus user deletion → delete linked member ──
  // When a user is deleted from Directus admin UI, also delete the linked member.
  // The Postgres CASCADE constraints then clean up all member-owned data.

  // Capture member IDs before user deletion (filter runs before delete)
  const pendingUserDeletes = new Map()

  filter('users.delete', async (keys) => {
    try {
      const members = await database('members').whereIn('user', keys).select('id', 'user', 'email')
      for (const m of members) {
        pendingUserDeletes.set(m.user, { memberId: m.id, email: m.email })
      }
    } catch (e) {
      log.warn({ msg: `user-delete cascade lookup failed: ${e.message}`, event: 'cascade_delete' })
    }
    return keys
  })

  action('users.delete', async ({ keys }) => {
    for (const userId of keys) {
      const pending = pendingUserDeletes.get(userId)
      if (!pending) continue
      pendingUserDeletes.delete(userId)
      try {
        // Clean up email verifications (not FK-linked)
        if (pending.email) {
          await database('email_verifications').where('email', pending.email).delete()
        }
        // Delete member — CASCADE handles all child records
        await database('members').where('id', pending.memberId).delete()
        log.info(`[cascade] Deleted member ${pending.memberId} (user ${userId} deleted from admin)`)
      } catch (err) {
        log.error({ msg: `[cascade] Member delete failed for ${pending.memberId}: ${err.message}`, event: 'cascade_delete', userId, memberId: pending.memberId, stack: err.stack })
        logCronError('cascade_delete', err, { userId, memberId: pending.memberId })
      }
    }
  })

  // ── 0c. Cascade: Member deletion → delete linked Directus user ──
  // When a member is deleted from the admin UI, also delete the linked directus_user.
  // Without this, deleting a member orphans the user record.

  const pendingMemberDeletes = new Map()

  filter('members.items.delete', async (keys) => {
    try {
      const members = await database('members').whereIn('id', keys).select('id', 'user')
      for (const m of members) {
        if (m.user) pendingMemberDeletes.set(m.id, m.user)
      }
    } catch (e) {
      log.warn({ msg: `member-delete cascade lookup failed: ${e.message}`, event: 'cascade_delete' })
    }
    return keys
  })

  action('members.items.delete', async ({ keys }) => {
    for (const memberId of keys) {
      const userId = pendingMemberDeletes.get(memberId)
      if (!userId) continue
      pendingMemberDeletes.delete(memberId)
      try {
        await database('directus_users').where('id', userId).delete()
        log.info(`[cascade] Deleted user ${userId} (member ${memberId} deleted from admin)`)
      } catch (err) {
        log.error({ msg: `[cascade] User delete failed for ${userId}: ${err.message}`, event: 'cascade_delete', userId, memberId, stack: err.stack })
        logCronError('cascade_delete', err, { userId, memberId })
      }
    }
  })

  // ── 1. Wiedisync Active on Auth ─────────────────────────────────
  // Mark wiedisync_active=true on successful login
  // (Can't be a Postgres trigger because Directus auth doesn't write to members table)

  action('auth.login', async ({ user }) => {
    if (!user) return
    try {
      await database('members')
        .where('user', user)
        .where('wiedisync_active', false)
        .update({ wiedisync_active: true })
      // Presence stamp for the admin Explorer's "Last online" column —
      // Directus auth never touches members, so this is the only writer.
      // Login-time only: refresh tokens keep a session alive for weeks
      // without re-login, so the value means "last full login", which is
      // what an admin last-seen column needs. Never blocks login (caught
      // below like the wiedisync_active write).
      await database('members')
        .where('user', user)
        .update({ last_online_at: new Date() })
    } catch (err) {
      log.warn({ msg: `auth.login post-login writes (wiedisync_active / last_online_at): ${err.message}`, event: 'auth.login', userId: user, stack: err.stack })
      logWarning('auth_login_hook', err.message, { userId: user, stack: err.stack })
    }
  })

  // ── 1b. Role Sync — keep Directus user role in sync ─────────────
  // When members.role changes or coach/TR junctions change, update the
  // linked Directus user's role to the correct tier.

  let roleNameToId = null

  async function getRoleMap() {
    if (roleNameToId) return roleNameToId
    const roles = await database('directus_roles').select('id', 'name')
    roleNameToId = Object.fromEntries(roles.map(r => [r.name, r.id]))
    return roleNameToId
  }

  async function syncMemberRole(memberId) {
    try {
      const map = await getRoleMap()
      const result = await resolveDirectusRole(database, memberId)
      if (!result) return

      const roleId = map[result.roleName]
      if (!roleId) {
        log.warn(`[role-sync] Role "${result.roleName}" not found in Directus`)
        return
      }

      const currentUser = await database('directus_users').where('id', result.userId).select('role').first()
      if (currentUser && currentUser.role !== roleId) {
        await database('directus_users').where('id', result.userId).update({ role: roleId })
        log.info(`[role-sync] Member ${memberId} → ${result.roleName}`)
      }
    } catch (err) {
      log.warn({ msg: `[role-sync] Failed for member ${memberId}: ${err.message}`, event: 'role_sync', memberId, stack: err.stack })
      logWarning('role_sync', err.message, { memberId, stack: err.stack })
    }
  }

  // ── Whitespace trim on member text fields ──────────────────────────────
  // Leading/trailing whitespace is never meaningful on a member record: it
  // silently corrupts names ("Irini " vs "Irini"), breaks exact-name linking
  // against ClubDesk, and produces spurious audit-log diffs. Trim the ends of
  // every top-level string in the payload on both create and update, for every
  // write that reaches the items API (Directus admin UI + the member app).
  // `String.prototype.trim()` also strips non-breaking ( ), zero-width
  // (﻿) and other Unicode whitespace, not just ASCII spaces/tabs. Internal
  // whitespace is preserved (addresses, notes). Registered FIRST so downstream
  // member filters (priv-strip, duplicate-email) see the cleaned values. Empty
  // strings are left as-is here — this is a normalizer, not a required-field
  // guard. Raw-knex paths (signup invites, registration approval, ClubDesk
  // sync) bypass items filters and carry their own normalization.
  function trimMemberStrings(payload) {
    if (!payload || typeof payload !== 'object') return payload
    for (const key of Object.keys(payload)) {
      const v = payload[key]
      if (typeof v === 'string') {
        const trimmed = v.trim()
        if (trimmed !== v) payload[key] = trimmed
      }
    }
    return payload
  }
  filter('members.items.create', async (payload) => trimMemberStrings(payload))
  filter('members.items.update', async (payload) => trimMemberStrings(payload))

  // Defense-in-depth: strip privilege-bearing flags from the payload unless the
  // caller is admin / superuser. The Directus field-level permissions SHOULD be
  // admin-only — but the action hooks below escalate each of these into a real
  // Directus role / policy attachment, so a single misconfigured field perm
  // would let any member self-promote. Fail closed at the filter layer.
  //   role          → syncMemberRole (base Directus role, incl. Superuser)
  //   is_spielplaner → ensureTerminplanungAccess (club-wide scheduling policy)
  //   finance        → reconcileFinanceAccess (finance policy)
  const PRIVILEGE_FLAGS = ['role', 'is_spielplaner', 'finance']
  filter('members.items.update', async (payload, _meta, context) => {
    if (!payload || !PRIVILEGE_FLAGS.some((f) => f in payload)) return payload
    const userId = context?.accountability?.user
    if (!userId) return payload // system-context update (cron/hook) — trust
    const m = await database('members').where('user', userId).select('role').first()
    const roles = Array.isArray(m?.role) ? m.role : []
    if (roles.includes('admin') || roles.includes('superuser')) return payload
    for (const f of PRIVILEGE_FLAGS) {
      if (f in payload) { delete payload[f]; log.warn({ msg: `[priv-strip] non-admin attempted members.${f} update — stripped`, userId }) }
    }
    return payload
  })

  // ── Licence status: stamp the actor, notify the member (migration 301) ──
  //
  // Hand edits reach `members.licence_status` through the items API (the Data
  // Explorer's inline editor and the /admin/anmeldungen buttons), so this pair
  // covers every human write; the sweep in licence-status.js covers the machine
  // ones and stamps itself.
  //
  // Why a filter AND an action: only the filter can see the OLD value (it runs
  // before the write), and only the action knows the write actually committed.
  // Detecting the change in the filter is what stops an admin re-picking the
  // value already on the row from pushing "your licence status changed" to a
  // member for whom nothing did — the Data Explorer sends every dirty field,
  // and "dirty" there means touched, not different.
  const pendingLicenceNotifications = new Map()

  filter('members.items.update', async (payload, meta, context) => {
    if (!payload || !('licence_status' in payload)) return payload
    const next = payload.licence_status
    if (!isLicenceStatus(next)) return payload
    const keys = Array.isArray(meta?.keys) ? meta.keys : []
    if (keys.length === 0) return payload

    const rows = await database('members').whereIn('id', keys).select('id', 'licence_status')
    const changed = rows.filter((r) => r.licence_status !== next).map((r) => r.id)
    if (changed.length === 0) return payload

    // The season the new status describes is always the CURRENT one — a human
    // is answering "where is this licence now", never backdating last season.
    const [{ season }] = (await database.raw('SELECT public.kscw_current_season_label() AS season')).rows
    payload.licence_status_season = season
    payload.licence_status_updated_at = new Date()

    // Actor, best available name. The members row is the one worth having (it
    // is the name every other surface shows), but a write can legitimately come
    // from a login with no member row — the Directus admin service account, an
    // API token — and stamping those "Unknown user" throws away an answerable
    // audit trail for no reason. Fall back to directus_users, then the email.
    const userId = context?.accountability?.user
    let who = 'System'
    if (userId) {
      const actor = await database('members').where('user', userId).first('first_name', 'last_name')
      who = [actor?.first_name, actor?.last_name].filter(Boolean).join(' ').trim()
      if (!who) {
        const du = await database('directus_users').where('id', userId).first('first_name', 'last_name', 'email')
        who = [du?.first_name, du?.last_name].filter(Boolean).join(' ').trim() || du?.email || `User ${userId}`
      }
    }
    payload.licence_status_by_name = who

    for (const id of changed) pendingLicenceNotifications.set(String(id), { status: next, season })
    return payload
  })

  action('members.items.update', async ({ keys }) => {
    if (pendingLicenceNotifications.size === 0) return
    for (const id of (Array.isArray(keys) ? keys : [])) {
      const pending = pendingLicenceNotifications.get(String(id))
      if (!pending) continue
      pendingLicenceNotifications.delete(String(id))
      try {
        await notifyLicenceStatusChange(database, log, {
          memberId: id, status: pending.status, season: pending.season,
        })
      } catch (err) {
        logWarning('licence_status_notify', err.message, { memberId: id, status: pending.status, stack: err.stack })
      }
    }
    // A filter that stamped and then threw (or a write Directus rolled back)
    // leaves an entry nothing will ever drain. Bound the map rather than let it
    // grow for the life of the container.
    if (pendingLicenceNotifications.size > 500) pendingLicenceNotifications.clear()
  })

  // Same guard on CREATE. Directus does NOT enforce field-level permission
  // filters on create payloads, so without this a non-admin members.create
  // could smuggle role/is_spielplaner/finance — which the action hooks would
  // then escalate. System context (no accountability.user — cron/hook/
  // registration backend) and admins keep the write; everyone else is stripped.
  filter('members.items.create', async (payload, _meta, context) => {
    if (!payload || !PRIVILEGE_FLAGS.some((f) => f in payload)) return payload
    const userId = context?.accountability?.user
    if (!userId) return payload // system-context create (cron/hook) — trust
    const m = await database('members').where('user', userId).select('role').first()
    const roles = Array.isArray(m?.role) ? m.role : []
    if (roles.includes('admin') || roles.includes('superuser')) return payload
    for (const f of PRIVILEGE_FLAGS) {
      if (f in payload) { delete payload[f]; log.warn({ msg: `[priv-strip] non-admin attempted members.${f} on create — stripped`, userId }) }
    }
    return payload
  })

  // ── Duplicate-email guard on members create (items API) ─────────────────
  // Same-PERSON duplicates via the items API get blocked; same-email
  // different-first-name creates pass — that's a family sharing an address
  // (verified on prod 2026-07-03: Galeczki + Stinson sibling pairs each share
  // a parent email with distinct clubdesk_ids — legitimate admin adds, NOT
  // duplicates). This is also why there is deliberately NO DB unique index on
  // members.email. Raw-knex paths (signup invites, registration approval,
  // team-invite claims) carry their own dedup logic and bypass items filters
  // by design. Uses the same symmetric first-name-prefix rule as
  // createMemberFromRegistration (firstNamesMatch, hoisted from below).
  filter('members.items.create', async (payload) => {
    const email = String(payload?.email || '').trim().toLowerCase()
    if (!email) return payload
    const existingRows = await database('members')
      .whereRaw('LOWER(email) = ?', [email])
      .select('id', 'first_name', 'last_name')
    const samePerson = existingRows.find(r => firstNamesMatch(r.first_name, payload?.first_name))
    if (samePerson) {
      throw kscwScopeError(
        `A member with this email already exists (#${samePerson.id} ${[samePerson.first_name, samePerson.last_name].filter(Boolean).join(' ')}). Edit the existing member instead of creating a duplicate. (A different family member sharing this email needs a different first name.)`,
        400, 'DUPLICATE_EMAIL'
      )
    }
    return payload
  })

  // Sync when members.role array changes
  action('members.items.update', async ({ keys, payload }) => {
    if (payload && 'role' in payload) {
      for (const id of keys) {
        await syncMemberRole(id)
        // 'finance' is orthogonal (layered policy), not a base role → reconcile
        // the per-user FINANCE policy alongside the base-role sync.
        await reconcileFinanceAccess(id)
      }
    }
    // Sync member photo → directus_users.avatar
    if (payload && 'photo' in payload) {
      for (const id of keys) {
        try {
          const member = await database('members').where('id', id).select('user', 'photo').first()
          if (member?.user) {
            await database('directus_users').where('id', member.user).update({ avatar: member.photo })
          }
        } catch (err) {
          logWarning('photo_sync', err.message, { memberId: id, stack: err.stack })
        }
      }
    }
    // is_spielplaner flipped → attach/revoke the TERMINPLANUNG policy so the
    // backend game_scheduling_* API tracks the flag without a setup-perms re-run.
    if (payload && 'is_spielplaner' in payload) {
      for (const id of keys) {
        if (payload.is_spielplaner === true) await ensureTerminplanungAccess(id)
        else await revokeTerminplanungAccessIfNotSpielplaner(id)
      }
    }
    // IBAN / AHV number saved via the items API (PayoutIbanCard profile card,
    // the profile edit modal, finance explorer billing, Data Explorer) → flag the
    // member for the next ClubDesk sync-up push. Both columns are in
    // CD_PUSH_CONTACT_HEADERS (IBAN 2026-07-06, AHV Nummer 2026-07-07) but these
    // write paths do not self-flag the way POST /clubdesk-update does, and
    // /clubdesk-update deliberately refuses both as ClubDesk-authoritative — so
    // without this an edited AHV number reached the register only if some
    // unrelated field happened to be flagged in the same season (added
    // 2026-08-07; IBAN has been handled here since 2026-07-06). Only a NON-EMPTY
    // value flags: a cleared field is deliberately not propagated — the push
    // echoes ClubDesk's own value back instead (see clubdesk-update.js). Unlinked
    // members skip the flag; their values ride the CREATE push.
    // The register triple (migration 302) joins this loop, and it is the reason
    // the loop matters rather than a convenience: `clubdesk_push_changes` is not
    // just bookkeeping for these three — buildPushCsv READS it to decide whether
    // an UPDATE row may overwrite ClubDesk's Status / Eintritt / Austritt at all
    // (registerCell / CD_REGISTER_FIELDS). A status edited here and not recorded
    // here would set the column and then never reach the register.
    //
    // ⚠ The non-empty rule below applies to them too, and for Austritt it has a
    // consequence worth knowing: CLEARING an exit date (a member rejoining)
    // cannot propagate. ClubDesk's import ignores empty cells, so wiedisync has
    // no way to blank a register cell at all — the date has to be removed in
    // ClubDesk by hand. The wiedisync side is still correct immediately; only
    // the register lags.
    // ⚠ `beitragskategorie` joined this loop on 2026-08-14 and it is the field
    // that needs it MOST: the sync-down is ClubDesk-authoritative on the column
    // (`COALESCE(cd.categ, …)`), so an unflagged category edit is not merely
    // un-pushable — it is REVERTED at the next sync-down. The flag is the shield
    // as much as the licence. buildPushCsv drags the Mitgliederbeitrag cell along
    // with it, so the register can never end up 'Gratis' next to CHF 440.
    // ⚠ The officials booleans joined on 2026-08-14 (Offiziellen Lizenz). They
    // are here for the FLAG, not for the gate: that cell is fill-only and
    // ignores clubdesk_push_changes entirely, so without an entry in this loop
    // a scorer/OTR edit would set the column and then never queue a push at
    // all — the AHV problem above, one field over. The non-empty rule reads
    // them exactly right: `true` flags, `false` skips, and a downgrade is
    // unpushable anyway because ClubDesk's import ignores an empty cell.
    for (const field of ['iban', 'ahv_nummer', 'register_status', 'eintritt', 'austritt', 'beitragskategorie',
      'scorer_vb', 'referee_vb', 'otr1_bb', 'otr2_bb', 'otn1_bb', 'otn2_bb']) {
      if (!payload || !(field in payload) || !String(payload[field] || '').trim()) continue
      for (const id of keys) {
        try {
          const m = await database('members').where('id', id).select('clubdesk_id', 'clubdesk_push_changes').first()
          if (!m?.clubdesk_id) continue
          let changes = []
          try {
            changes = Array.isArray(m.clubdesk_push_changes) ? m.clubdesk_push_changes
              : (m.clubdesk_push_changes ? JSON.parse(m.clubdesk_push_changes) : [])
          } catch { changes = [] }
          changes = changes.filter((c) => c?.field !== field)
          changes.push({ field, old_value: null, new_value: String(payload[field]).trim() })
          await database('members').where('id', id).update({
            clubdesk_push_pending: true,
            clubdesk_push_changes: JSON.stringify(changes),
          })
        } catch (err) {
          logWarning('clubdesk_contact_flag', err.message, { memberId: id, field, stack: err.stack })
        }
      }
    }
    // Auto-confirm opt-in flipped on (migration 077) → backfill existing
    // upcoming activities of that type. Idempotent (NOT EXISTS), so a no-op
    // when the flag was already on or nothing is outstanding.
    if (payload && (payload.auto_confirm_trainings === true || payload.auto_confirm_games === true || payload.auto_confirm_events === true)) {
      for (const id of keys) {
        try {
          let n = 0
          if (payload.auto_confirm_trainings === true) n += await backfillMemberAutoConfirm(id, 'training')
          if (payload.auto_confirm_games === true) n += await backfillMemberAutoConfirm(id, 'game')
          if (payload.auto_confirm_events === true) n += await backfillMemberAutoConfirm(id, 'event')
          if (n > 0) log.info(`[auto-confirm-backfill] member ${id}: ${n} participations confirmed`)
        } catch (err) {
          log.error({ msg: `[auto-confirm-backfill] member ${id}: ${err.message}`, event: 'auto_confirm_backfill_failed', memberId: id, stack: err.stack })
        }
      }
    }
  })

  // ── Direct LEADER policy attachment ─────────────────────────────
  // Permission gating MUST NOT depend on the Directus role alone — custom
  // roles (e.g. "Website Admin"), missed sync events, or manual role edits
  // can leave a real coach/TR without the LEADER policy. Mirror role-sync
  // with a user-level directus_access row attached to the LEADER policy.
  // The LEADER policy's writes are already self-scoped via M2M filters, so
  // an extra attachment can't widen access beyond what the user's data
  // already proves.

  async function getLeaderPolicyId() {
    const row = await database('directus_policies').where('name', 'KSCW Team Responsible').select('id').first()
    return row?.id ?? null
  }

  async function ensureLeaderAccess(memberId) {
    try {
      const member = await database('members').where('id', memberId).select('user').first()
      if (!member?.user) return
      const policyId = await getLeaderPolicyId()
      if (!policyId) return
      const existing = await database('directus_access')
        .where({ user: member.user, policy: policyId })
        .first()
      if (existing) return
      const { randomUUID } = await import('node:crypto')
      await database('directus_access').insert({ id: randomUUID(), user: member.user, policy: policyId })
      log.info(`[leader-access] Attached LEADER policy to user ${member.user} (member ${memberId})`)
    } catch (err) {
      log.warn({ msg: `[leader-access] attach failed for member ${memberId}: ${err.message}`, memberId, stack: err.stack })
      logWarning('leader_access_attach', err.message, { memberId, stack: err.stack })
    }
  }

  // ── Direct TERMINPLANUNG policy attachment ──────────────────────
  // Mirrors the LEADER pattern: the `KSCW Terminplanung` policy (club-wide
  // game-scheduling, CRUD on game_scheduling_*) is layered per-user via a
  // directus_access row, gated on members.is_spielplaner. Keeps the backend
  // items-API access in lockstep with the flag so admins don't have to re-run
  // setup-permissions.mjs after toggling it. setup-permissions.mjs §12 still
  // performs the same attach/revoke as an idempotent reconcile on every deploy.
  async function getTerminplanungPolicyId() {
    const row = await database('directus_policies').where('name', 'KSCW Terminplanung').select('id').first()
    return row?.id ?? null
  }

  async function ensureTerminplanungAccess(memberId) {
    try {
      const member = await database('members').where('id', memberId).select('user').first()
      if (!member?.user) return
      const policyId = await getTerminplanungPolicyId()
      if (!policyId) return
      const existing = await database('directus_access')
        .where({ user: member.user, policy: policyId })
        .first()
      if (existing) return
      const { randomUUID } = await import('node:crypto')
      await database('directus_access').insert({ id: randomUUID(), user: member.user, policy: policyId })
      log.info(`[terminplanung-access] Attached TERMINPLANUNG policy to user ${member.user} (member ${memberId})`)
    } catch (err) {
      log.warn({ msg: `[terminplanung-access] attach failed for member ${memberId}: ${err.message}`, memberId, stack: err.stack })
      logWarning('terminplanung_access_attach', err.message, { memberId, stack: err.stack })
    }
  }

  async function revokeTerminplanungAccessIfNotSpielplaner(memberId) {
    try {
      const member = await database('members').where('id', memberId).select('user', 'is_spielplaner').first()
      if (!member?.user) return
      if (member.is_spielplaner === true) return
      const policyId = await getTerminplanungPolicyId()
      if (!policyId) return
      const deleted = await database('directus_access')
        .where({ user: member.user, policy: policyId })
        .delete()
      if (deleted) log.info(`[terminplanung-access] Revoked TERMINPLANUNG policy from user ${member.user} (member ${memberId} no longer is_spielplaner)`)
    } catch (err) {
      log.warn({ msg: `[terminplanung-access] revoke failed for member ${memberId}: ${err.message}`, memberId, stack: err.stack })
      logWarning('terminplanung_access_revoke', err.message, { memberId, stack: err.stack })
    }
  }

  // ── Direct FINANCE policy attachment ────────────────────────────
  // Mirrors LEADER/TERMINPLANUNG: the `KSCW Finance` policy (club-wide finance
  // reads + member billing-field write) is layered per-user via a directus_access
  // row, gated on the orthogonal 'finance' app-role. Reconciled the moment
  // members.role changes so a newly-designated treasurer gets (or loses) finance
  // access immediately, without waiting for a setup-perms deploy (§13 does the
  // same as an idempotent reconcile).
  async function getFinancePolicyId() {
    const row = await database('directus_policies').where('name', 'KSCW Finance').select('id').first()
    return row?.id ?? null
  }

  async function reconcileFinanceAccess(memberId) {
    try {
      const member = await database('members').where('id', memberId).select('user', 'role').first()
      if (!member?.user) return
      const policyId = await getFinancePolicyId()
      if (!policyId) return
      const roles = Array.isArray(member.role) ? member.role : []
      const wantFinance = roles.includes('finance')
      const existing = await database('directus_access').where({ user: member.user, policy: policyId }).first()
      if (wantFinance && !existing) {
        const { randomUUID } = await import('node:crypto')
        await database('directus_access').insert({ id: randomUUID(), user: member.user, policy: policyId })
        log.info(`[finance-access] Attached FINANCE policy to user ${member.user} (member ${memberId})`)
      } else if (!wantFinance && existing) {
        await database('directus_access').where({ user: member.user, policy: policyId }).delete()
        log.info(`[finance-access] Revoked FINANCE policy from user ${member.user} (member ${memberId} no longer finance)`)
      }
    } catch (err) {
      log.warn({ msg: `[finance-access] reconcile failed for member ${memberId}: ${err.message}`, memberId, stack: err.stack })
      logWarning('finance_access_reconcile', err.message, { memberId, stack: err.stack })
    }
  }

  async function revokeLeaderAccessIfOrphan(memberId) {
    try {
      const member = await database('members').where('id', memberId).select('user').first()
      if (!member?.user) return
      const stillCoach = await database('teams_coaches').where('members_id', memberId).first()
      const stillTR = await database('teams_responsibles').where('members_id', memberId).first()
      if (stillCoach || stillTR) return
      const policyId = await getLeaderPolicyId()
      if (!policyId) return
      const deleted = await database('directus_access')
        .where({ user: member.user, policy: policyId })
        .delete()
      if (deleted) log.info(`[leader-access] Revoked LEADER policy from user ${member.user} (member ${memberId} no longer coach/TR)`)
    } catch (err) {
      log.warn({ msg: `[leader-access] revoke failed for member ${memberId}: ${err.message}`, memberId, stack: err.stack })
      logWarning('leader_access_revoke', err.message, { memberId, stack: err.stack })
    }
  }

  // Sync when coach/TR junctions change (create)
  action('teams_coaches.items.create', async ({ payload }) => {
    const memberId = toIdValue(payload?.members_id)
    if (memberId) {
      await syncMemberRole(memberId)
      await ensureLeaderAccess(memberId)
    }
  })
  action('teams_responsibles.items.create', async ({ payload }) => {
    const memberId = toIdValue(payload?.members_id)
    if (memberId) {
      await syncMemberRole(memberId)
      await ensureLeaderAccess(memberId)
    }
  })

  // Sync when coach/TR junctions change (delete)
  // Capture member IDs before deletion via filter, then sync in action
  const pendingJunctionDeletes = new Map()

  filter('teams_coaches.items.delete', async (keys) => {
    try {
      const rows = await database('teams_coaches').whereIn('id', keys).select('members_id')
      for (const r of rows) pendingJunctionDeletes.set(`coach-${r.members_id}`, r.members_id)
    } catch (e) { /* ignore */ }
    return keys
  })

  filter('teams_responsibles.items.delete', async (keys) => {
    try {
      const rows = await database('teams_responsibles').whereIn('id', keys).select('members_id')
      for (const r of rows) pendingJunctionDeletes.set(`tr-${r.members_id}`, r.members_id)
    } catch (e) { /* ignore */ }
    return keys
  })

  // Drain the pending-junction map under try/finally so a syncMemberRole
  // failure can't leave the entry orphaned forever. Snapshot keys first so
  // we never iterate the map while mutating it (concurrent inserts from
  // overlapping deletes are otherwise lost).
  async function drainPendingJunction(prefix) {
    const toProcess = []
    for (const [key, memberId] of pendingJunctionDeletes) {
      if (key.startsWith(prefix)) toProcess.push([key, memberId])
    }
    for (const [key, memberId] of toProcess) {
      try {
        await syncMemberRole(memberId)
        await revokeLeaderAccessIfOrphan(memberId)
      } finally {
        pendingJunctionDeletes.delete(key)
      }
    }
  }

  action('teams_coaches.items.delete', async () => { await drainPendingJunction('coach-') })
  action('teams_responsibles.items.delete', async () => { await drainPendingJunction('tr-') })

  // ── Absence Auto-Decline ────────────────────────────────────────
  // When an absence is created or updated, auto-decline all overlapping
  // future trainings/games/events for that member. Skips activities where
  // the member already has a participation record (so manual overrides stick).
  // Also handles weekly absences (day-of-week matching).

  // Sentinel stamped on rows the auto-decline INSERT *created* (vs rows that
  // pre-existed and were overridden by the UPDATE branch). `waitlisted_at` is
  // never legitimately set on a `declined` row and isn't surfaced for declined
  // rows in the UI, and the migration-038 BEFORE-UPDATE trigger only touches
  // `auto_declined_by`, so it survives as a marker. On unwind we DELETE the
  // created rows and REVERT the overridden ones (instead of deleting the
  // member's original confirmed RSVP). 1970-01-01Z = "auto-decline created".
  const AUTO_DECLINE_CREATED_SENTINEL = '1970-01-01 00:00:00+00'

  /**
   * Reverse the effect of an absence's auto-declines. Created rows (sentinel
   * set) are deleted; overridden rows (a pre-existing confirmed/tentative/
   * waitlisted RSVP the absence flipped to declined) are reverted to
   * 'confirmed' with the marker + sentinel cleared, so the member's original
   * attendance is restored rather than silently destroyed. Manual overrides
   * are already detached by the trigger (auto_declined_by → NULL on a user
   * status edit) and so match neither branch — they're left untouched.
   * Returns { deleted, reverted } counts.
   */
  async function unwindAbsenceAutoDeclines(absenceId) {
    const del = await database.raw(
      `DELETE FROM participations
       WHERE auto_declined_by = ?::integer
         AND waitlisted_at = ?::timestamptz`,
      [absenceId, AUTO_DECLINE_CREATED_SENTINEL],
    )
    const rev = await database.raw(
      `UPDATE participations
       SET status = 'confirmed', auto_declined_by = NULL, note = ''
       WHERE auto_declined_by = ?::integer
         AND (waitlisted_at IS NULL OR waitlisted_at <> ?::timestamptz)`,
      [absenceId, AUTO_DECLINE_CREATED_SENTINEL],
    )
    return { deleted: del?.rowCount || 0, reverted: rev?.rowCount || 0 }
  }

  // Duplicate-RSVP backstop (migration 246): participations carries two
  // partial unique indexes — (activity_type, activity_id, member) WHERE
  // session_id IS NULL, and the session-scoped variant. Every RSVP writer
  // below appends a targetless ON CONFLICT DO NOTHING so Postgres infers the
  // arbiter from whichever unique index the row violates — concurrent passes
  // (absence decline vs. cron sweep vs. a member's own RSVP) can no longer
  // slip duplicate rows past the NOT EXISTS guards. Targetless on purpose: a
  // named conflict target errors when the index is missing, while this form
  // is simply inert on a pre-246 database (deploy order is schema-first, but
  // the code must not depend on it). The NOT EXISTS guards stay — they are
  // the semantic filter ("never overwrite an answer"), not the race guard.

  // Event decline eligibility — mirrors autoConfirmEvent / the frontend's
  // useUserVisibleEventIds: members of an invited team (events_teams) ∪
  // individually invited (events_members) ∪ everyone active when the event
  // is club-wide (no rows in either junction). Without the club-wide arm, a
  // club-wide event gets zero absence-declines while auto-confirm happily
  // treats it as "everyone" — an absent opted-in member ends up confirmed.
  // `eventRef` / `memberRef` are SQL column references, never user input.
  //
  // Migration 324: `events.invite_guests = false` narrows the TEAM arm to the
  // core roster. Per member, not per row — a guest on one invited team who is a
  // core player on another still matches, and the events_members arm below is
  // untouched, so a named personal invite outranks the switch. IS NOT FALSE (not
  // `= true`) so a NULL from a pre-324 row still reads as "invited".
  function eventEligibilitySql(eventRef, memberRef) {
    return `(
      EXISTS (SELECT 1 FROM events_teams et JOIN member_teams mt ON mt.team = et.teams_id
              JOIN events ev ON ev.id = et.events_id
              WHERE et.events_id = ${eventRef} AND mt.member = ${memberRef}
                AND (ev.invite_guests IS NOT FALSE OR COALESCE(mt.guest_level, 0) = 0))
      OR EXISTS (SELECT 1 FROM events_members em
                 WHERE em.events_id = ${eventRef} AND em.members_id = ${memberRef})
      OR (NOT EXISTS (SELECT 1 FROM events_teams et2 WHERE et2.events_id = ${eventRef})
          AND NOT EXISTS (SELECT 1 FROM events_members em2 WHERE em2.events_id = ${eventRef})
          AND EXISTS (SELECT 1 FROM members mm WHERE mm.id = ${memberRef} AND mm.wiedisync_active = true))
    )`
  }

  /**
   * Auto-decline future activities that overlap with the given absence.
   * Uses a single INSERT...SELECT per activity type (no per-row loop).
   */
  async function autoDeclineForAbsence(absenceId) {
    try {
      const absence = await database('absences').where('id', absenceId).first()
      if (!absence) return

      const memberId = absence.member
      // 2026-05-14: knex returns Postgres `date` columns as JS Date objects, so
      // `.split('T')[0]` short-circuits to undefined and the fallback handed
      // back the Date itself. `Date > '2026-05-13'` then coerced to `NaN >
      // NaN` → false, so `effectiveStart` was ALWAYS clamped to today even for
      // future-dated absences. Net: a future absence (e.g. Aug 27–28) declined
      // every activity from today through end_date. Always coerce to
      // YYYY-MM-DD string via safeDateStr() before any comparison or SQL bind.
      const startDate = safeDateStr(absence.start_date)
      const endDate = safeDateStr(absence.end_date)
      if (!startDate || !endDate) return
      const today = new Date().toISOString().split('T')[0]
      const effectiveStart = startDate > today ? startDate : today

      // Parse affects — JSON array like ["all"] or ["trainings","games"]
      let affects = absence.affects
      if (typeof affects === 'string') {
        try { affects = JSON.parse(affects) } catch { affects = ['all'] }
      }
      if (!Array.isArray(affects) || affects.length === 0) affects = ['all']
      const allTypes = affects.includes('all')

      const isWeekly = absence.type === 'weekly'
      let daysOfWeek = absence.days_of_week
      if (isWeekly) {
        if (typeof daysOfWeek === 'string') {
          try { daysOfWeek = JSON.parse(daysOfWeek) } catch { daysOfWeek = [] }
        }
        if (!Array.isArray(daysOfWeek) || daysOfWeek.length === 0) return
        // Audit 2026-05-12 #9 — coerce each entry to a valid 0..6 integer
        // BEFORE interpolating into raw SQL. Even though the source is a
        // jsonb column, the trigger path doesn't guarantee element type, so
        // a malformed value (string, decimal, out-of-range) would otherwise
        // land in the IN-list verbatim.
        daysOfWeek = daysOfWeek
          .map(d => Number(d))
          .filter(d => Number.isInteger(d) && d >= 0 && d <= 6)
        if (daysOfWeek.length === 0) return
      }

      // Day-of-week filter for weekly absences (Postgres: 0=Sun,1=Mon..6=Sat; our format: 0=Mon..6=Sun)
      // Convert our Mon=0..Sun=6 to Postgres EXTRACT(DOW): Sun=0,Mon=1..Sat=6
      const pgDowClause = isWeekly
        ? `AND EXTRACT(DOW FROM d.date) IN (${daysOfWeek.map(d => (d + 1) % 7).join(',')})`
        : ''

      // Unwind: reverse any auto-declines this absence previously created
      // that no longer match the (possibly shortened / re-scoped) window.
      // Created rows are deleted; rows that pre-existed and were overridden are
      // reverted to 'confirmed' (restoring the member's original RSVP rather
      // than destroying it — see unwindAbsenceAutoDeclines). Tentative/
      // waitlisted prior statuses revert to confirmed (no column to stash the
      // exact prior status without a migration; attendance is preserved, which
      // is the point). Still-covered rows are immediately re-applied by the
      // UPDATE/INSERT below. Manual overrides survive — the BEFORE UPDATE
      // trigger detaches `auto_declined_by` the moment a user flips `status`.
      await unwindAbsenceAutoDeclines(absenceId)

      let declined = 0

      // Per the agreed policy: an absence hard-overrides existing confirmed /
      // tentative / waitlisted RSVPs. The two-step pattern (UPDATE then INSERT)
      // is deliberate even now that migration 246 makes ON CONFLICT possible:
      // the UPDATE flips ANY existing RSVP row in the window — including
      // stale-roster rows the INSERT's eligibility SELECT would never produce
      // — so folding both into one INSERT ... DO UPDATE would silently narrow
      // the override. The INSERTs close their duplicate race with the
      // targetless ON CONFLICT DO NOTHING backstop documented above.
      // Migration 038 reshapes the trigger to preserve `auto_declined_by`
      // when we set status + marker in the same UPDATE — without that, the
      // marker would be cleared and the override would be indistinguishable
      // from a manual edit.

      // Trainings
      if (allTypes || affects.includes('trainings')) {
        const trainingDowClause = pgDowClause.replace(/d\.date/g, 't.date')
        const upd = await database.raw(`
          UPDATE participations p
          SET status = 'declined', note = ?, auto_declined_by = ?::integer
          FROM trainings t
          WHERE p.activity_type = 'training' AND p.activity_id = t.id::text
            AND p.member = ?::integer
            AND p.status IN ('confirmed', 'tentative', 'waitlisted')
            AND t.date >= ?::date AND t.date <= ?::date
            AND t.cancelled = false
            ${trainingDowClause}
        `, [absence.reason || '', absenceId, memberId, effectiveStart, endDate])
        declined += upd?.rowCount || 0

        const ins = await database.raw(`
          INSERT INTO participations (member, activity_type, activity_id, status, note, guest_count, is_staff, auto_declined_by, waitlisted_at)
          SELECT ?::integer, 'training', t.id::text, 'declined', ?, 0, mt.is_staff, ?::integer, '1970-01-01 00:00:00+00'::timestamptz
          FROM trainings t
          -- Respect the per-training guest toggle (excluded_guest_levels):
          -- a member at an excluded guest level can't attend that training,
          -- so the roster drops them. Auto-declining them would inflate the
          -- RSVP tallies above the roster — the same drift guests caused on
          -- games. Mirror autoConfirmTraining's exclusion. (Unlike games the
          -- excluded set is per-training, so it is correlated to the training
          -- row here rather than a hard guest_level = 0.)
          --
          -- teamPeopleSql (was a bare member_teams EXISTS), so a coach/TR on
          -- holiday is declined out of their own trainings — and it is a LATERAL
          -- rather than an EXISTS so the row's is_staff comes from the same
          -- set that decided eligibility, instead of a hardcoded false. Since
          -- 2026-08-15 auto-confirm seeds staff a confirmed row and the two
          -- halves have to agree: the UPDATE above catches an absence filed
          -- AFTER the confirm, this INSERT catches a training generated after
          -- the absence. Miss it and a coach reads as attending while away.
          JOIN LATERAL ${teamPeopleSql('t.team')} mt
            ON mt.member = ?::integer
           AND NOT (COALESCE(t.excluded_guest_levels, '[]')::jsonb @> to_jsonb(mt.guest_level))
          WHERE t.date >= ?::date AND t.date <= ?::date
            AND t.cancelled = false
            ${trainingDowClause}
            AND NOT EXISTS (
              SELECT 1 FROM participations p
              WHERE p.activity_type = 'training' AND p.activity_id = t.id::text AND p.member = ?::integer
            )
          ON CONFLICT DO NOTHING
        `, [memberId, absence.reason || '', absenceId, memberId, effectiveStart, endDate, memberId])
        declined += ins?.rowCount || 0
      }

      // Games
      if (allTypes || affects.includes('games')) {
        const upd = await database.raw(`
          UPDATE participations p
          SET status = 'declined', note = ?, auto_declined_by = ?::integer
          FROM games g
          WHERE p.activity_type = 'game' AND p.activity_id = g.id::text
            AND p.member = ?::integer
            AND p.status IN ('confirmed', 'tentative', 'waitlisted')
            AND g.date >= ?::date AND g.date <= ?::date
            AND g.kscw_team IS NOT NULL
            AND COALESCE(g.status, '') NOT IN ('completed', 'postponed', 'cancelled')
            ${pgDowClause.replace(/d\.date/g, 'g.date')}
        `, [absence.reason || '', absenceId, memberId, effectiveStart, endDate])
        declined += upd?.rowCount || 0

        const ins = await database.raw(`
          INSERT INTO participations (member, activity_type, activity_id, status, note, guest_count, is_staff, auto_declined_by, waitlisted_at)
          SELECT ?::integer, 'game', g.id::text, 'declined', ?, 0, mt.is_staff, ?::integer, '1970-01-01 00:00:00+00'::timestamptz
          FROM games g
          -- Guests (guest_level > 0) can never play league games — the
          -- guest-block trigger forbids confirming and the UI hides RSVP
          -- entirely. Auto-declining them creates rows that are excluded
          -- from the game roster yet still inflate the card/modal RSVP
          -- tallies (declined count drifts above the roster). Mirror the
          -- auto-confirm guard (guest_level = 0) so we never seed them.
          -- …but a GAME guest (migration 271) is the opposite case: invited to a
          -- specific game precisely so they can play it, with no member_teams row on
          -- that team at all. They belong in the sweep like any other player.
          --
          -- GAME_SQUAD_JOIN is exactly that union (roster ∪ game guests ∪ staff,
          -- game guests reported at guest_level 0), so the two hand-rolled EXISTS
          -- branches this replaced are now one join that also carries is_staff
          -- — and it picks up coaches/TRs, who since 2026-08-15 hold an
          -- auto-confirmed row that an absence has to be able to overturn.
          ${GAME_SQUAD_JOIN}
          WHERE mt.member = ?::integer
            AND mt.guest_level = 0
            AND g.date >= ?::date AND g.date <= ?::date
            AND g.kscw_team IS NOT NULL
            AND COALESCE(g.status, '') NOT IN ('completed', 'postponed', 'cancelled')
            ${pgDowClause.replace(/d\.date/g, 'g.date')}
            AND NOT EXISTS (
              SELECT 1 FROM participations p
              WHERE p.activity_type = 'game' AND p.activity_id = g.id::text AND p.member = ?::integer
            )
          ON CONFLICT DO NOTHING
        `, [memberId, absence.reason || '', absenceId, memberId, effectiveStart, endDate, memberId])
        declined += ins?.rowCount || 0
      }

      // Events
      if (allTypes || affects.includes('events')) {
        // events.start_date is timestamptz → localize to Zurich for the
        // calendar-date window/DOW match (UTC would shift a 00:00–02:00 Zurich
        // event to the previous day and mismatch the absence window).
        // Whole-mode events match on the event date; per_day/per_session
        // events carry one RSVP row per event_sessions day, so both the
        // override and the insert match each session's own date — declining
        // day 2 of a 3-day camp must not depend on day 1 being inside the
        // absence window, and a NULL-session row on a per-day event is
        // invisible to every per-day roster reader.
        const eventDateZ = "(e.start_date AT TIME ZONE 'Europe/Zurich')::date"
        const upd = await database.raw(`
          UPDATE participations p
          SET status = 'declined', note = ?, auto_declined_by = ?::integer
          FROM events e
          WHERE p.activity_type = 'event' AND p.activity_id = e.id::text
            AND p.member = ?::integer
            AND p.status IN ('confirmed', 'tentative', 'waitlisted')
            AND (e.participation_mode IS NULL OR e.participation_mode = 'whole')
            AND ${eventDateZ} >= ?::date AND ${eventDateZ} <= ?::date
            ${pgDowClause.replace(/d\.date/g, eventDateZ)}
        `, [absence.reason || '', absenceId, memberId, effectiveStart, endDate])
        declined += upd?.rowCount || 0

        const updSessions = await database.raw(`
          UPDATE participations p
          SET status = 'declined', note = ?, auto_declined_by = ?::integer
          FROM events e
          JOIN event_sessions s ON s.event = e.id
          WHERE p.activity_type = 'event' AND p.activity_id = e.id::text
            AND p.session_id = s.id::text
            AND p.member = ?::integer
            AND p.status IN ('confirmed', 'tentative', 'waitlisted')
            AND e.participation_mode IN ('per_day', 'per_session')
            AND s.date >= ?::date AND s.date <= ?::date
            ${pgDowClause.replace(/d\.date/g, 's.date')}
        `, [absence.reason || '', absenceId, memberId, effectiveStart, endDate])
        declined += updSessions?.rowCount || 0

        const ins = await database.raw(`
          INSERT INTO participations (member, activity_type, activity_id, status, note, guest_count, is_staff, auto_declined_by, waitlisted_at)
          SELECT a.member, 'event', e.id::text, 'declined', COALESCE(a.reason, ''), 0, false, a.id, '1970-01-01 00:00:00+00'::timestamptz
          FROM events e
          JOIN absences a ON a.id = ?::integer
          WHERE (e.participation_mode IS NULL OR e.participation_mode = 'whole')
            AND ${eventDateZ} >= ?::date AND ${eventDateZ} <= ?::date
            ${pgDowClause.replace(/d\.date/g, eventDateZ)}
            AND ${eventEligibilitySql('e.id', 'a.member')}
            AND NOT EXISTS (
              SELECT 1 FROM participations p
              WHERE p.activity_type = 'event' AND p.activity_id = e.id::text AND p.member = a.member
            )
          ON CONFLICT DO NOTHING
        `, [absenceId, effectiveStart, endDate])
        declined += ins?.rowCount || 0

        const insSessions = await database.raw(`
          INSERT INTO participations (member, activity_type, activity_id, status, note, guest_count, is_staff, auto_declined_by, waitlisted_at, session_id)
          SELECT a.member, 'event', e.id::text, 'declined', COALESCE(a.reason, ''), 0, false, a.id, '1970-01-01 00:00:00+00'::timestamptz, s.id::text
          FROM events e
          JOIN event_sessions s ON s.event = e.id
          JOIN absences a ON a.id = ?::integer
          WHERE e.participation_mode IN ('per_day', 'per_session')
            AND s.date >= ?::date AND s.date <= ?::date
            ${pgDowClause.replace(/d\.date/g, 's.date')}
            AND ${eventEligibilitySql('e.id', 'a.member')}
            AND NOT EXISTS (
              SELECT 1 FROM participations p
              WHERE p.activity_type = 'event' AND p.activity_id = e.id::text AND p.member = a.member
                AND p.session_id = s.id::text
            )
          ON CONFLICT DO NOTHING
        `, [absenceId, effectiveStart, endDate])
        declined += insSessions?.rowCount || 0
      }

      if (declined > 0) log.info(`[absence-auto-decline] Absence ${absenceId}: ${declined} activities declined for member ${memberId}`)
    } catch (err) {
      log.error({ msg: `[absence-auto-decline] ${err.message}`, event: 'absence_auto_decline', absenceId, stack: err.stack })
      logCronError('absence_auto_decline', err)
    }
  }

  // Edit-attribution (migration 051): stamp directus_users.id of the writer
  // on every authenticated create/update so the UI can flag third-party
  // edits. System-context writes (no accountability) leave the columns null.
  // Filters always overwrite client-supplied values so they can't be spoofed.
  // Resolve editor's display name + role relative to the affected member.
  // Role = 'coach' | 'team_responsible' | 'admin' | 'staff' (fallback).
  // Migration 053 added the columns; this fills them at write time so the
  // frontend can render "Edited by coach (Daniela Imhof) on …" without a
  // per-row round-trip.
  async function resolveAbsenceEditorMeta(accountability, affectedMemberId) {
    try {
      const editorUser = await database('directus_users').where('id', accountability.user)
        .select('first_name', 'last_name').first()
      const name = [editorUser?.first_name, editorUser?.last_name].filter(Boolean).join(' ') || null
      if (accountability.admin) return { name, role: 'admin' }
      if (!affectedMemberId) return { name, role: 'staff' }

      // Active teams only: an unqualified read attributes an edit as "coach"
      // from ANY team the member was ever on, so a past coach's edit is labelled
      // "Edited by coach (X)" indefinitely.
      const memberTeams = await database('member_teams as mt')
        .join('teams as t', 't.id', 'mt.team')
        .where('mt.member', affectedMemberId).where('t.active', true)
        .select('mt.team as team')
      const teamIds = memberTeams.map(mt => mt.team).filter(Boolean)
      if (teamIds.length === 0) return { name, role: 'staff' }

      const editorMember = await database('members').where('user', accountability.user).select('id').first()
      if (!editorMember) return { name, role: 'staff' }

      const isCoach = await database('teams_coaches')
        .whereIn('teams_id', teamIds)
        .andWhere('members_id', editorMember.id)
        .first()
      if (isCoach) return { name, role: 'coach' }

      const isTR = await database('teams_responsibles')
        .whereIn('teams_id', teamIds)
        .andWhere('members_id', editorMember.id)
        .first()
      if (isTR) return { name, role: 'team_responsible' }

      return { name, role: 'staff' }
    } catch (err) {
      log.error({ msg: `[absence-editor-meta] ${err.message}`, event: 'absence_editor_meta', stack: err.stack })
      return { name: null, role: 'staff' }
    }
  }

  filter('absences.items.create', async (payload, _meta, { accountability }) => {
    if (!accountability?.user) return payload
    const meta = await resolveAbsenceEditorMeta(accountability, payload.member)
    return {
      ...payload,
      last_edited_by: accountability.user,
      last_edited_at: new Date().toISOString(),
      last_edited_name: meta.name,
      last_edited_role: meta.role,
    }
  })
  filter('absences.items.update', async (payload, meta, { accountability }) => {
    if (!accountability?.user) return payload
    let affectedMemberId = payload.member
    if (!affectedMemberId && Array.isArray(meta?.keys) && meta.keys.length === 1) {
      const row = await database('absences').where('id', meta.keys[0]).select('member').first()
      affectedMemberId = row?.member
    }
    const editorMeta = await resolveAbsenceEditorMeta(accountability, affectedMemberId)
    return {
      ...payload,
      last_edited_by: accountability.user,
      last_edited_at: new Date().toISOString(),
      last_edited_name: editorMeta.name,
      last_edited_role: editorMeta.role,
    }
  })

  async function notifyAbsenceThirdParty(absenceId, op) {
    try {
      const row = await database('absences').where('id', absenceId)
        .select('id', 'member', 'start_date', 'end_date', 'type', 'reason', 'reason_detail', 'last_edited_by', 'indefinite').first()
      if (!row || !row.last_edited_by || !row.member) return

      const memberRow = await database('members').where('id', row.member)
        .select('id', 'user').first()
      if (!memberRow) return
      if (memberRow.user && memberRow.user === row.last_edited_by) return // self-edit

      const editorUser = await database('directus_users').where('id', row.last_edited_by)
        .select('first_name', 'last_name').first()
      const editorName = [editorUser?.first_name, editorUser?.last_name].filter(Boolean).join(' ') || 'Staff'

      const isWeekly = row.type === 'weekly'
      await database('notifications').insert({
        member: row.member,
        type: 'absence_third_party_edit',
        title: op === 'create'
          ? (isWeekly ? 'absence_weekly_created_for_you' : 'absence_created_for_you')
          : (isWeekly ? 'absence_weekly_updated_for_you' : 'absence_updated_for_you'),
        body: JSON.stringify({
          editor: editorName,
          start: row.start_date,
          end: row.indefinite ? null : row.end_date,
          reason: row.reason || null,
          detail: row.reason_detail || null,
          weekly: isWeekly,
        }),
        activity_type: 'absence',
        activity_id: String(row.id),
        read: false,
      })

      // Web push fanout — same dispatch path as upcoming_activity /
      // deadline_reminder. The dd.mm.yyyy formatter mirrors the front-end
      // (Swiss / dot-day-first) so the push body matches the in-app row.
      // safeDateStr() normalizes first: knex hands back `date` columns as JS
      // Date objects, and `String(Date).slice(0,10)` yields "Wed Aug 27" (not
      // an ISO date), which then split/reverse mangles. absences.start_date is
      // a pg `date` (no TZ skew), so no AT TIME ZONE needed — just ISO it.
      const startIso = safeDateStr(row.start_date)
      const startFmt = startIso
        ? startIso.split('-').reverse().join('.')
        : ''
      const keyBase = isWeekly
        ? (op === 'create' ? 'absence.weekly.created' : 'absence.weekly.updated')
        : (op === 'create' ? 'absence.created' : 'absence.updated')
      await sendLocalizedPush(
        database,
        [row.member],
        (ids, title, body) => sendPushToMembers(database, ids, title, body, `${FRONTEND_URL}/absences`, 'absence', log),
        `${keyBase}.title`,
        `${keyBase}.body`,
        { editor: editorName, start: startFmt },
      )
    } catch (err) {
      log.error({ msg: `[absence-notify] ${err.message}`, event: 'absence_notify', absenceId, stack: err.stack })
    }
  }

  action('absences.items.create', async ({ key }) => {
    await autoDeclineForAbsence(key)
    await notifyAbsenceThirdParty(key, 'create')
  })
  action('absences.items.update', async ({ keys }) => {
    for (const k of keys) {
      await autoDeclineForAbsence(k)
      await notifyAbsenceThirdParty(k, 'update')
    }
  })
  action('absences.items.delete', async ({ keys }) => {
    // Reverse any auto-declines this absence had created: delete the rows it
    // created, revert the pre-existing RSVPs it overrode back to 'confirmed'
    // (don't destroy them). Manual overrides are protected by the clear-marker
    // trigger (they match neither branch).
    try {
      for (const k of keys) {
        const { deleted, reverted } = await unwindAbsenceAutoDeclines(k)
        if (deleted > 0 || reverted > 0) log.info(`[absence-auto-decline] Absence ${k} deleted: ${deleted} reversed, ${reverted} RSVPs restored`)
      }
    } catch (err) {
      log.error({ msg: `[absence-auto-decline] delete: ${err.message}`, event: 'absence_auto_decline_delete', stack: err.stack })
    }
  })

  // ── Team join request notifications ──────────────────────────────
  // Notify coaches + team responsibles when a member requests to join a team.
  // Fires for both collection creates (team_requests) and inline
  // members.requested_team sets from the account-claim flow.
  async function notifyTeamJoinRequest(memberId, teamId) {
    try {
      if (!memberId || !teamId) return
      const member = await database('members').where('id', memberId)
        .select('id', 'first_name', 'last_name').first()
      if (!member) return

      const teamRow = await database('teams').where('id', teamId)
        .select('name').first()
      const teamName = teamRow?.name || `Team ${teamId}`
      const teamUrlPath = encodeURIComponent(teamName)

      const coaches = await database('teams_coaches').where('teams_id', teamId).select('members_id')
      const trMembers = await database('teams_responsibles').where('teams_id', teamId).select('members_id')
      const recipientIds = [...new Set([...coaches, ...trMembers].map(r => r.members_id))]
        .filter(id => id && id !== memberId)
      if (recipientIds.length === 0) return

      // In-app notifications
      await database('notifications').insert(recipientIds.map(rid => ({
        member: rid,
        type: 'member_join_request',
        title: 'member_join_request',
        body: JSON.stringify({ memberName: `${member.first_name} ${member.last_name}`, teamName }),
        activity_type: 'team',
        activity_id: teamName,
        team: teamId,
        read: false,
      })))

      // Emails
      const schema = await getSchema()
      const { MailService } = services
      const mailService = new MailService({ schema, knex: database })
      const recipients = await database('members')
        .whereIn('id', recipientIds)
        .select('email', 'first_name', 'language')
      // Per-recipient locale via members.language → 5 buckets (de/gsw/en/fr/it)
      const TJR_LANG_TO_CODE = { german: 'de', swiss_german: 'gsw', english: 'en', french: 'fr', italian: 'it' }
      // Escape member-supplied first/last name + admin-supplied team name before
      // they land in email HTML; subject lines are plain text so they don't
      // need escaping, only the `intro` HTML body.
      const safeMemberName = `${escapeEmailHtml(member.first_name || '')} ${escapeEmailHtml(member.last_name || '')}`.trim()
      const safeTeamNameHtml = escapeEmailHtml(teamName)
      const TJR = {
        de: {
          subject: `WiediSync — Neue Beitrittsanfrage für ${teamName}`,
          intro: `<strong>${safeMemberName}</strong> möchte dem Team <strong>${safeTeamNameHtml}</strong> beitreten.`,
          alertTitle: 'Aktion erforderlich',
          alertBody: 'Bitte genehmige oder lehne die Anfrage auf der Teamseite ab.',
          cta: 'Zur Teamseite', title: 'Neue Beitrittsanfrage',
        },
        gsw: {
          subject: `WiediSync — Neui Bytrittsaafrog für ${teamName}`,
          intro: `<strong>${safeMemberName}</strong> möcht zum Team <strong>${safeTeamNameHtml}</strong>.`,
          alertTitle: 'Aktion erforderlich',
          alertBody: 'Bitte bewillig oder läne d Aafrog uf dr Team-Site ab.',
          cta: 'Zur Team-Site', title: 'Neui Bytrittsaafrog',
        },
        en: {
          subject: `WiediSync — New join request for ${teamName}`,
          intro: `<strong>${safeMemberName}</strong> wants to join team <strong>${safeTeamNameHtml}</strong>.`,
          alertTitle: 'Action required',
          alertBody: 'Please approve or reject the request on the team page.',
          cta: 'Go to team page', title: 'New join request',
        },
        fr: {
          subject: `WiediSync — Nouvelle demande d'adhésion pour ${teamName}`,
          intro: `<strong>${safeMemberName}</strong> souhaite rejoindre l'équipe <strong>${safeTeamNameHtml}</strong>.`,
          alertTitle: 'Action requise',
          alertBody: "Merci d'approuver ou de refuser la demande sur la page de l'équipe.",
          cta: "Voir la page de l'équipe", title: "Nouvelle demande d'adhésion",
        },
        it: {
          subject: `WiediSync — Nuova richiesta di adesione per ${teamName}`,
          intro: `<strong>${safeMemberName}</strong> vuole unirsi alla squadra <strong>${safeTeamNameHtml}</strong>.`,
          alertTitle: 'Azione richiesta',
          alertBody: 'Approva o rifiuta la richiesta sulla pagina della squadra.',
          cta: 'Vai alla pagina della squadra', title: 'Nuova richiesta di adesione',
        },
      }
      for (const r of recipients) {
        if (!r.email) continue
        const code = TJR_LANG_TO_CODE[r.language] || 'de'
        const tt = TJR[code]
        const bodyHtml =
          `<div style="font-size:14px;color:#e2e8f0;margin-bottom:16px">${tt.intro}</div>` +
          buildAlertBox('info', tt.alertTitle, tt.alertBody) +
          `<div style="text-align:center;margin-top:20px"><a href="${FRONTEND_URL}/teams/${teamUrlPath}" style="display:inline-block;padding:12px 24px;background:#4A55A2;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">${tt.cta}</a></div>`
        const html = buildEmailLayout(bodyHtml, {
          title: tt.title,
          subtitle: `WiediSync — ${teamName}`,
        })
        mailService.send({
          to: r.email,
          subject: tt.subject,
          html,
          text: `${member.first_name} ${member.last_name} → ${teamName}\n${FRONTEND_URL}/teams/${teamUrlPath}`,
        }).catch(e => log.error(`team-join-request email: ${e.message}`))
      }

      // Push (per-recipient locale)
      const memberName = `${member.first_name} ${member.last_name}`
      await sendLocalizedPush(
        database, recipientIds,
        (ids, title, body) => sendPushToMembers(database, ids, title, body, `${FRONTEND_URL}/teams/${teamUrlPath}`, 'team', log),
        'joinRequest.title', 'joinRequest.body',
        { name: memberName, team: teamName },
      )
    } catch (err) {
      log.error({ msg: `[team-join-request] ${err.message}`, stack: err.stack })
    }
  }

  action('team_requests.items.create', async ({ payload, key }) => {
    const memberId = payload?.member
    const teamId = payload?.team
    if (memberId && teamId) await notifyTeamJoinRequest(memberId, teamId)
    else if (key) {
      const row = await database('team_requests').where('id', key).select('member', 'team').first()
      if (row) await notifyTeamJoinRequest(row.member, row.team)
    }
  })

  // ── Announcements (Vereinsnews) — publish fanout ─────────────────
  // Fires when an announcement is created or updated. If it's now published
  // (published_at set) and hasn't been fanned out yet (fanout_sent_at null),
  // resolves the audience and sends push + email per the per-post toggles.
  // Sets fanout_sent_at after sending so subsequent edits don't re-fanout.
  function stripHtmlPlain(html) {
    return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
  }
  function pickAnnouncementTranslation(translations, lang) {
    const t = translations || {}
    const map = { german: 'de', swiss_german: 'gsw', english: 'en', french: 'fr', italian: 'it' }
    const code = map[lang] || lang || 'de'
    return t[code] || t.de || t.en || Object.values(t).find(v => v && v.title) || { title: '', body: '' }
  }

  async function notifyAnnouncementPublished(annId) {
    try {
      if (!annId) return
      const ann = await database('announcements').where('id', annId).first()
      if (!ann) return
      // Not published yet, or already fanned out
      if (!ann.published_at) return
      if (ann.fanout_sent_at) return
      // Don't fanout for future-scheduled posts (let an admin trigger again later if needed)
      if (new Date(ann.published_at) > new Date()) return
      // NB: no "nothing requested" early-exit anymore — the in-app bell fanout
      // is always on (push/email stay per-announcement toggles), so publishing
      // always proceeds to audience resolution.

      // Shared with the club mailbox's group send (kscw-endpoints/src/audience.js)
      // so both resolve the same audience from the same gates.
      // The label carries the post id so a skipped-fanout warning still says
      // WHICH announcement resolved to nobody (the resolver is shared now, so
      // it can't reference ann.id itself).
      const memberIds = await resolveMemberAudience(database, log, ann, `announcements #${annId}`)
      if (memberIds.length === 0) {
        await database('announcements').where('id', annId).update({ fanout_sent_at: new Date().toISOString() })
        return
      }

      // Re-entrancy lock: stamp fanout_sent_at BEFORE the send loop, not after.
      // The check above (fanout_sent_at null) and the write were previously
      // separated by the whole per-recipient loop, so an edit / cron tick that
      // re-entered mid-send would pass the null check and double-mail the club.
      // Conditional update (whereNull) makes the stamp a claim: only the call
      // that flips it from null actually sends. Lost races no-op here.
      const claimed = await database('announcements')
        .where('id', annId)
        .whereNull('fanout_sent_at')
        .update({ fanout_sent_at: new Date().toISOString() })
      if (!claimed) {
        log.info(`[announcements] Fanout for #${annId} already claimed by a concurrent run — skipping`)
        return
      }

      // Materialize the resolved audience (migration 219). For teams/roles this
      // IS the read gate — members can't read audience_teams/audience_roles, so
      // the Member policy filter matches on these rows instead. It therefore has
      // to land before any channel fanout: a member who gets the bell but has no
      // recipient row would click through to a post they can't open.
      try {
        const CHUNK = 500
        for (let i = 0; i < memberIds.length; i += CHUNK) {
          await database('announcement_recipients')
            .insert(memberIds.slice(i, i + CHUNK).map(mid => ({ announcement: annId, member: mid })))
            .onConflict(['announcement', 'member']).ignore()
        }
      } catch (recErr) {
        log.error({ msg: `[announcements] recipient materialization failed: ${recErr.message}`, annId, stack: recErr.stack })
        if (ann.audience_type === 'teams' || ann.audience_type === 'roles') {
          // Without the rows a targeted post mails and pushes people to a /news
          // entry they cannot open. Release the claim and bail so the 5-min cron
          // retries cleanly, rather than half-delivering.
          await database('announcements').where('id', annId).update({ fanout_sent_at: null })
          writeErrorLog?.('announcement_recipients_failed', recErr.message, { annId, stack: recErr.stack })
          return
        }
        // all/sport keep their own arm in the policy filter, so the post stays
        // visible either way — press on and lose only the delivery log.
      }

      const translations = (typeof ann.translations === 'string')
        ? (() => { try { return JSON.parse(ann.translations) } catch { return {} } })()
        : (ann.translations || {})

      const baseTr = pickAnnouncementTranslation(translations, 'german')
      const baseTitle = baseTr.title || 'Vereinsnews'
      const baseBodyText = stripHtmlPlain(baseTr.body).slice(0, 200)
      const newsUrl = `${FRONTEND_URL}/news`

      // In-app bell fanout — always on (opt-outs suppress email/push only,
      // never the bell — same rule as migration 156). Per-recipient locale
      // like push; the panel routes type 'announcement' to /news.
      try {
        const CODE_TO_LANG = { de: 'german', gsw: 'swiss_german', en: 'english', fr: 'french', it: 'italian' }
        const buckets = await bucketMembersByLocale(database, memberIds)
        const bellRows = []
        for (const [code, ids] of Object.entries(buckets)) {
          if (!ids || ids.length === 0) continue
          const tr = pickAnnouncementTranslation(translations, CODE_TO_LANG[code])
          const title = tr.title || baseTitle
          const body = (stripHtmlPlain(tr.body).slice(0, 200)) || baseBodyText
          for (const rid of ids) {
            bellRows.push({
              member: rid, type: 'announcement', title, body,
              activity_type: 'announcement', activity_id: String(annId), read: false,
            })
          }
        }
        if (bellRows.length > 0) {
          await database('notifications').insert(bellRows)
          await database('announcement_recipients')
            .where('announcement', annId)
            .whereIn('member', bellRows.map(r => r.member))
            .update({ bell_at: new Date().toISOString() })
        }
        log.info(`[announcements] Bell notifications: ${bellRows.length} inserted`)
      } catch (bellErr) {
        log.warn({ msg: `[announcements] bell fanout failed: ${bellErr.message}` })
      }

      // Push fanout (per-recipient locale via members.language)
      if (ann.notify_push) {
        const CODE_TO_LANG = { de: 'german', gsw: 'swiss_german', en: 'english', fr: 'french', it: 'italian' }
        const buckets = await bucketMembersByLocale(database, memberIds)
        for (const [code, ids] of Object.entries(buckets)) {
          if (!ids || ids.length === 0) continue
          const tr = pickAnnouncementTranslation(translations, CODE_TO_LANG[code])
          const title = tr.title || baseTitle
          const body = (stripHtmlPlain(tr.body).slice(0, 200)) || baseBodyText
          await sendPushToMembers(database, ids, title, body, newsUrl, `announcement-${annId}`, log)
        }
      }

      // Email fanout (per-recipient locale resolution)
      if (ann.notify_email) {
        try {
          const schema = await getSchema()
          const { MailService } = services
          const mailService = new MailService({ schema, knex: database })
          const candidates = await database('members')
            .whereIn('id', memberIds)
            .whereNotNull('email')
            // Migration 156: respect per-member opt-out. Push fanout is unaffected.
            .where('email_notify_announcements', true)
            .select('id', 'email', 'first_name', 'language')
          // Migration 277: never re-mail an address SES reported as a permanent
          // bounce or a spam complaint. Announcements are the highest-volume
          // sender on the shared SES identity, so this is where repeated
          // delivery to dead addresses would do the reputational damage.
          const annSuppressed = await loadSuppressed(database, candidates.map(r => r.email))
          const recipients = candidates.filter(r => !annSuppressed.has(String(r.email).trim().toLowerCase()))
          if (candidates.length !== recipients.length) {
            log.info(`[announcements] ${candidates.length - recipients.length} suppressed address(es) skipped`)
          }

          let sent = 0
          let failed = 0
          for (const r of recipients) {
            try {
              const tr = pickAnnouncementTranslation(translations, r.language)
              const title = tr.title || baseTitle
              const rawBodyHtml = tr.body || baseTr.body || ''
              const isGerman = !r.language || r.language === 'german' || r.language === 'swiss_german'
              const ctaLabel = isGerman ? 'Auf WiediSync ansehen' : 'View on WiediSync'

              // Audit 2026-05-12 #14 — allowlist-sanitize the announcement body
              // before interpolating into the outbound email. Admin-authored
              // rich text only; strips script/style/iframe/img and all
              // attributes except https-only href on <a>. Closes the
              // phishing-redirect / tracking-pixel / event-handler injection
              // vector that a compromised Sport Admin could exploit.
              const bodyHtml = sanitizeAnnouncementHtml(rawBodyHtml)

              // Gate: never render `ann.link` inline in the email. External/CTA
              // links stay behind wiedisync login — recipients click the layout
              // CTA ("Auf WiediSync ansehen") to reach the full post + link.
              //
              // Body wrapper forces justified text. Inline anchors get an
              // explicit light-blue style (default browser blue is unreadable
              // on the #1e293b dark card). We inline-style via regex rather
              // than a <style> block so the CTA button <a> isn't affected.
              const bodyWithStyledLinks = bodyHtml.replace(
                /<a\s/gi,
                '<a style="color:#93c5fd;text-decoration:underline" ',
              )
              const emailBody =
                `<div style="font-size:14px;color:#e2e8f0;line-height:1.6;text-align:justify">${bodyWithStyledLinks}</div>`

              // Newsletter layout (migration 204): wide masthead template with
              // the announcement image as hero. Announcement images are
              // folder-less uploads → the Public policy serves them via
              // /assets, so email clients can fetch anonymously.
              const isNewsletter = ann.email_layout === 'newsletter'
              const greeting = r.first_name ? (isGerman ? `Hallo ${r.first_name}` : `Hi ${r.first_name}`) : (isGerman ? 'Hallo' : 'Hi')
              let html
              if (isNewsletter) {
                const assetsBase = (process.env.PUBLIC_URL || 'https://directus.kscw.ch').replace(/\/$/, '')
                const newsletterBody =
                  `<div style="font-size:15px;color:#e2e8f0;line-height:1.7">${bodyWithStyledLinks}</div>`
                html = buildNewsletterEmail(newsletterBody, {
                  title,
                  greeting,
                  heroImageUrl: ann.image ? `${assetsBase}/assets/${ann.image}` : null,
                  ctaUrl: newsUrl,
                  ctaLabel,
                  footerNote: isGerman
                    ? 'Du erhältst diese E-Mail als Mitglied des KSC Wiedikon. E-Mail-Einstellungen kannst du in deinem Wiedisync-Profil anpassen.'
                    : 'You receive this email as a KSC Wiedikon member. Manage your email preferences in your Wiedisync profile.',
                })
              } else {
                html = buildEmailLayout(emailBody, {
                  title: isGerman ? 'Vereinsnews' : 'Club news',
                  subtitle: title,
                  greeting,
                  ctaUrl: newsUrl,
                  ctaLabel,
                })
              }

              await mailService.send({
                to: r.email,
                // Newsletter subject is just the headline; standard keeps the
                // "Vereinsnews:" prefix.
                subject: isNewsletter ? title : `${isGerman ? 'Vereinsnews' : 'Club news'}: ${title}`,
                html,
                text: `${title}\n\n${stripHtmlPlain(bodyHtml).slice(0, 500)}\n\n${newsUrl}`,
                // Reply-To (migration 204) — empty keeps no-reply.
                ...(ann.reply_to ? { replyTo: ann.reply_to } : {}),
              })
              sent++
              await database('announcement_recipients')
                .where({ announcement: annId, member: r.id })
                .update({ email_at: new Date().toISOString(), email_error: null })
            } catch (perEmailErr) {
              failed++
              log.warn({ msg: `[announcements] email to ${r.email} failed: ${perEmailErr.message}` })
              // Record against the recipient row too — a log line answers "how
              // many failed", this answers "who didn't get it".
              await database('announcement_recipients')
                .where({ announcement: annId, member: r.id })
                .update({ email_error: String(perEmailErr.message).slice(0, 500) })
                .catch(() => {})
            }
          }
          log.info(`[announcements] Emails: ${sent} sent, ${failed} failed (out of ${recipients.length})`)
        } catch (emailErr) {
          log.warn({ msg: `[announcements] email batch failed: ${emailErr.message}`, stack: emailErr.stack })
        }
      }

      // fanout_sent_at was already stamped before the send loop (re-entrancy
      // lock above), so no second write is needed here.
      log.info(`[announcements] Fanout complete for #${annId} → ${memberIds.length} recipients (push=${!!ann.notify_push}, email=${!!ann.notify_email})`)
    } catch (err) {
      log.error({ msg: `[announcements] ${err.message}`, event: 'announcement_fanout', annId, stack: err.stack })
      writeErrorLog?.('announcement_fanout_failed', err.message, { annId, stack: err.stack })
    }
  }

  action('announcements.items.create', async ({ key }) => {
    if (key) await notifyAnnouncementPublished(key)
  })
  action('announcements.items.update', async ({ keys }) => {
    for (const k of keys || []) await notifyAnnouncementPublished(k)
  })

  // ── Announcements: server-side created_by + audience_sport enforcement ──
  // F5: Prevents an admin (Sport Admin+) from spoofing `created_by` via
  // direct API. On create, set from accountability user's linked member;
  // on update, never allow it to change.
  // F3: Prevents a sport-scoped admin (vb_admin / bb_admin) from posting
  // an announcement targeting the OTHER sport. Global admin/superuser
  // and members with BOTH sport roles bypass.
  function denyAudience(message) {
    const err = new Error(message)
    err.status = 403
    throw err
  }

  // `a` is the EFFECTIVE audience state (payload merged over the stored row),
  // never a bare update payload — see validateAnnouncementAudience.
  async function assertAudienceAllowed(a, isVb, isBb) {
    const sport = isVb ? 'volleyball' : (isBb ? 'basketball' : null)
    if (!sport) denyAudience('Only global admins can post club-wide announcements.')
    const type = a.audience_type || 'all'

    // audience_type='all' ignores audience_sport entirely in the resolver, so a
    // sport admin sending type=all + sport=volleyball reaches the whole club.
    // The old check only looked at audience_sport and let exactly that through.
    if (type === 'all') {
      denyAudience('Only global admins can post club-wide announcements. Target a sport or specific teams instead.')
    }

    // Role targeting crosses every sport boundary by nature (role:vorstand,
    // role:finance), so it stays global-admin only.
    if (type === 'roles') {
      denyAudience('Only global admins can target announcements by role.')
    }

    if (type === 'teams') {
      const ids = parseJsonArray(a.audience_teams).map(Number).filter(Number.isFinite)
      if (ids.length === 0) denyAudience('Select at least one team to target.')
      const rows = await database('teams').whereIn('id', ids).select('id', 'sport')
      if (rows.length !== ids.length) denyAudience('One or more selected teams do not exist.')
      if (rows.some(r => r.sport !== sport)) {
        denyAudience(`Only ${sport === 'volleyball' ? 'basketball' : 'volleyball'} admins can target ${sport === 'volleyball' ? 'basketball' : 'volleyball'} teams.`)
      }
      return
    }

    // type === 'sport'
    if (!a.audience_sport) {
      denyAudience('Only global admins can post club-wide announcements. Set audience_sport to your scope.')
    }
    if (a.audience_sport === 'volleyball' && !isVb) {
      denyAudience('Only volleyball admins can post volleyball-targeted announcements.')
    }
    if (a.audience_sport === 'basketball' && !isBb) {
      denyAudience('Only basketball admins can post basketball-targeted announcements.')
    }
  }

  async function validateAnnouncementAudience(payload, meta, context) {
    const userId = context?.accountability?.user
    if (!userId) return
    const m = await database('members').where('user', userId).select('role').first()
    if (!m) return
    const roles = Array.isArray(m.role) ? m.role : []
    // Global admins / superusers can post anything. Members with both sport
    // admin roles also pass through.
    if (roles.includes('admin') || roles.includes('superuser')) return
    const isVb = roles.includes('vb_admin')
    const isBb = roles.includes('bb_admin')
    if (isVb && isBb) return

    // On update the payload is PARTIAL, so it cannot be judged alone: a PATCH of
    // only {audience_teams} carries no audience_type and would read as club-wide,
    // while a PATCH of {audience_sport, audience_teams} would pass the sport check
    // with the other sport's teams still in the array. Merge over the stored row
    // and validate the state the write would actually produce.
    const keys = meta?.keys || (meta?.key ? [meta.key] : [])
    if (keys.length > 0) {
      const existing = await database('announcements')
        .whereIn('id', keys)
        .select('audience_type', 'audience_sport', 'audience_teams', 'audience_roles')
      for (const row of existing) {
        await assertAudienceAllowed({ ...row, ...payload }, isVb, isBb)
      }
      return
    }
    await assertAudienceAllowed(payload || {}, isVb, isBb)
  }

  filter('announcements.items.create', async (payload, meta, context) => {
    await validateAnnouncementAudience(payload, meta, context)
    const userId = context?.accountability?.user
    if (userId) {
      const m = await database('members').where('user', userId).select('id').first()
      if (m?.id) payload.created_by = m.id
      else delete payload.created_by
    } else {
      delete payload.created_by
    }
    return payload
  })
  filter('announcements.items.update', async (payload, meta, context) => {
    await validateAnnouncementAudience(payload, meta, context)
    if (payload && Object.prototype.hasOwnProperty.call(payload, 'created_by')) {
      delete payload.created_by
    }
    return payload
  })

  // ── Cron: Announcement scheduled-publish fanout (every 5 min) ──
  // Picks up posts where published_at has now arrived but fanout_sent_at
  // is still null (i.e. created with a future published_at and never
  // re-saved by an admin). Calls the same notifyAnnouncementPublished
  // helper which marks fanout_sent_at on every code path so the cron
  // doesn't loop on the same row.
  schedule('*/5 * * * *', async () => {
    try {
      const due = await database('announcements')
        .whereNotNull('published_at')
        .where('published_at', '<=', new Date())
        .whereNull('fanout_sent_at')
        .select('id')
      if (due.length === 0) return
      for (const row of due) {
        await notifyAnnouncementPublished(row.id)
      }
      log.info(`[announcements/cron] Scheduled fanout fired for ${due.length} post(s)`)
    } catch (err) {
      log.error({ msg: `[announcements/cron] ${err.message}`, stack: err.stack })
      logCronError('announcement_fanout_cron', err)
    }
  })

  // ── Auto-confirm RSVP helpers ──────────────────────────────────
  // Insert `confirmed` participations for all eligible members of an activity.
  // Uses NOT EXISTS to skip members already declined (absence overlay), already
  // confirmed/tentative (manual), and members in the training's excluded
  // guest-levels. Idempotent: safe to call on create AND on later flip-on.
  //
  // Returns rowCount inserted (0 if disabled / nothing to do).
  function parseTeamFeatures(fe) {
    if (typeof fe === 'string') {
      try { return JSON.parse(fe) || {} } catch { return {} }
    }
    return fe || {}
  }

  async function effectiveTrainingAutoConfirm(training, team) {
    if (training.auto_confirm_rsvp === true) return true
    if (training.auto_confirm_rsvp === false) return false
    return parseTeamFeatures(team?.features_enabled).training_auto_confirm === true
  }

  async function effectiveGameAutoConfirm(game, team) {
    if (game.auto_confirm_rsvp === true) return true
    if (game.auto_confirm_rsvp === false) return false
    return parseTeamFeatures(team?.features_enabled).game_auto_confirm === true
  }

  async function autoConfirmTraining(trainingId, { onlyIfFuture = false } = {}) {
    const training = await database('trainings').where('id', trainingId).first()
    if (!training || training.cancelled || !training.team || !training.date) return 0
    if (onlyIfFuture) {
      const today = new Date().toISOString().split('T')[0]
      const dateStr = training.date.toISOString?.().split('T')[0] || String(training.date).split('T')[0]
      if (dateStr < today) return 0
    }
    const team = await database('teams').where('id', training.team).first('features_enabled')
    // Team setting on → confirm every team member (legacy behavior). Off → only
    // members who personally opted in via members.auto_confirm_trainings (OR
    // semantics — migration 077). We no longer early-return on team-off, since
    // individual opt-ins must still be honoured.
    const teamOn = await effectiveTrainingAutoConfirm(training, team)
    const eligibleClause = teamOn ? 'TRUE' : 'm.auto_confirm_trainings = true'

    let excluded = training.excluded_guest_levels
    if (typeof excluded === 'string') { try { excluded = JSON.parse(excluded) } catch { excluded = [] } }
    if (!Array.isArray(excluded)) excluded = []
    const excludedClause = excluded.length > 0
      ? `AND e.guest_level NOT IN (${excluded.map(() => '?').join(',')})`
      : ''
    // `teamPeopleSql`, not `member_teams`: staff (coaches / team responsibles)
    // hold no roster row and were skipped by every auto-confirm path until
    // 2026-08-15. They come back with is_staff = true so they stay out of the
    // player tallies and the min-participants gate.
    const ins = await database.raw(`
      INSERT INTO participations (member, activity_type, activity_id, status, note, guest_count, is_staff)
      SELECT e.member, 'training', ?::text, 'confirmed', '', 0, e.is_staff
      FROM ${teamPeopleSql('?::integer')} e
      JOIN members m ON m.id = e.member
      WHERE (${eligibleClause})
        ${excludedClause}
        AND NOT EXISTS (
          SELECT 1 FROM participations p
          WHERE p.activity_type = 'training' AND p.activity_id = ?::text AND p.member = e.member
        )
      ON CONFLICT DO NOTHING
    `, [String(trainingId), training.team, training.team, ...excluded, String(trainingId)])
    return ins?.rowCount || 0
  }

  async function autoConfirmGame(gameId, { onlyIfFuture = false } = {}) {
    const game = await database('games').where('id', gameId).first()
    if (!game || !game.kscw_team || !game.date) return 0
    if (['completed', 'postponed', 'cancelled'].includes(game.status || '')) return 0
    if (onlyIfFuture) {
      const today = new Date().toISOString().split('T')[0]
      const dateStr = game.date.toISOString?.().split('T')[0] || String(game.date).split('T')[0]
      if (dateStr < today) return 0
    }
    const team = await database('teams').where('id', game.kscw_team).first('features_enabled')
    // Team setting on → everyone (legacy). Off → only members who opted in via
    // members.auto_confirm_games (migration 077). Guests (guest_level > 0) are
    // always excluded — trg_participations_guest_block enforces it too.
    const teamOn = await effectiveGameAutoConfirm(game, team)
    const eligibleClause = teamOn ? 'TRUE' : 'm.auto_confirm_games = true'

    // Staff join via `teamPeopleSql` (see autoConfirmTraining). The extra
    // `notGuestAnywhereSql` is game-only: trg_participations_guest_block RAISES
    // on a confirmed game RSVP for anybody guesting on ANY team, which would
    // abort this whole INSERT rather than skip the row. Players already carry
    // their own `guest_level = 0` filter; staff have no roster row to filter.
    const ins = await database.raw(`
      INSERT INTO participations (member, activity_type, activity_id, status, note, guest_count, is_staff)
      SELECT e.member, 'game', ?::text, 'confirmed', '', 0, e.is_staff
      FROM ${teamPeopleSql('?::integer')} e
      JOIN members m ON m.id = e.member
      WHERE e.guest_level = 0
        AND ${notGuestAnywhereSql('e.member')}
        AND (${eligibleClause})
        AND NOT EXISTS (
          SELECT 1 FROM participations p
          WHERE p.activity_type = 'game' AND p.activity_id = ?::text AND p.member = e.member
        )
      ON CONFLICT DO NOTHING
    `, [String(gameId), game.kscw_team, game.kscw_team, String(gameId)])
    return ins?.rowCount || 0
  }

  // Auto-confirm opted-in members on an event (member opt-in only — there is no
  // team-level event auto-confirm). Eligibility mirrors useUserVisibleEventIds:
  // members of an invited team (events_teams) ∪ individually invited
  // (events_members) ∪ everyone when the event is club-wide (no team and no
  // member junction). Whole-event mode only — per-session events need per-row
  // RSVPs. NOT EXISTS skips manual answers and absence-declines. Returns count.
  async function autoConfirmEvent(eventId, { onlyIfFuture = false } = {}) {
    const event = await database('events').where('id', eventId).first()
    if (!event || event.cancelled || !event.start_date) return 0
    if (event.participation_mode && event.participation_mode !== 'whole') return 0
    if (onlyIfFuture) {
      const today = new Date().toISOString().split('T')[0]
      const dateStr = safeDateStr(event.start_date)
      if (dateStr && dateStr < today) return 0
    }
    const [teamCount, memberCount] = await Promise.all([
      database('events_teams').where('events_id', eventId).count('* as c').first(),
      database('events_members').where('events_id', eventId).count('* as c').first(),
    ])
    const isClubWide = Number(teamCount?.c || 0) === 0 && Number(memberCount?.c || 0) === 0
    // Migration 324: with invite_guests off, the team arm is the core roster
    // only. UNION (not UNION ALL) with the invited-members arm, so a guest who
    // was ALSO invited by name still comes through — same per-member rule as
    // eventEligibilitySql.
    const guestClause = event.invite_guests === false ? 'AND COALESCE(mt.guest_level, 0) = 0' : ''
    const eligibleSql = isClubWide
      ? `SELECT m.id AS member FROM members m WHERE m.wiedisync_active = true`
      : `SELECT mt.member FROM events_teams et
           JOIN member_teams mt ON mt.team = et.teams_id
           WHERE et.events_id = ?::integer ${guestClause}
         UNION
         SELECT em.members_id AS member FROM events_members em
           WHERE em.events_id = ?::integer`
    const eligibleParams = isClubWide ? [] : [eventId, eventId]
    const ins = await database.raw(`
      INSERT INTO participations (member, activity_type, activity_id, status, note, guest_count, is_staff)
      SELECT DISTINCT e.member, 'event', ?::text, 'confirmed', '', 0, false
      FROM (${eligibleSql}) e
      JOIN members m ON m.id = e.member
      WHERE m.auto_confirm_events = true
        AND NOT EXISTS (
          SELECT 1 FROM participations p
          WHERE p.activity_type = 'event' AND p.activity_id = ?::text AND p.member = e.member
        )
      ON CONFLICT DO NOTHING
    `, [String(eventId), ...eligibleParams, String(eventId)])
    return ins?.rowCount || 0
  }

  // Backfill: confirm a single member on all their existing upcoming activities
  // of one type. Run when a member flips an auto_confirm_* flag on. NOT EXISTS
  // skips anything already answered or absence-declined (those are rows too),
  // so it never overwrites a prior choice. Idempotent.
  async function backfillMemberAutoConfirm(memberId, type) {
    const today = new Date().toISOString().split('T')[0]
    // The training/game branches walk `teamPeopleSql` rather than joining
    // `member_teams` directly, so a member's OWN opt-in reaches the teams they
    // only coach. Before 2026-08-15 this was the sharpest edge of the staff
    // gap: a coach could tick "auto-confirm trainings" on their profile, the
    // flag saved, the backfill ran, and it inserted nothing — the join had no
    // roster row to match.
    if (type === 'training') {
      const res = await database.raw(`
        INSERT INTO participations (member, activity_type, activity_id, status, note, guest_count, is_staff)
        SELECT ?::integer, 'training', t.id::text, 'confirmed', '', 0, e.is_staff
        FROM trainings t
        JOIN LATERAL ${teamPeopleSql('t.team')} e ON e.member = ?::integer
        WHERE t.cancelled = false
          AND t.date::date >= ?::date
          AND NOT (COALESCE(t.excluded_guest_levels, '[]')::jsonb @> to_jsonb(e.guest_level))
          AND NOT EXISTS (
            SELECT 1 FROM participations p
            WHERE p.activity_type = 'training' AND p.activity_id = t.id::text AND p.member = ?::integer
          )
        ON CONFLICT DO NOTHING
      `, [memberId, memberId, today, memberId])
      return res?.rowCount || 0
    }
    if (type === 'game') {
      const res = await database.raw(`
        INSERT INTO participations (member, activity_type, activity_id, status, note, guest_count, is_staff)
        SELECT ?::integer, 'game', g.id::text, 'confirmed', '', 0, e.is_staff
        FROM games g
        JOIN LATERAL ${teamPeopleSql('g.kscw_team')} e ON e.member = ?::integer
        WHERE g.status NOT IN ('completed', 'postponed', 'cancelled')
          AND g.date::date >= ?::date
          AND e.guest_level = 0
          AND ${notGuestAnywhereSql('e.member')}
          AND NOT EXISTS (
            SELECT 1 FROM participations p
            WHERE p.activity_type = 'game' AND p.activity_id = g.id::text AND p.member = ?::integer
          )
        ON CONFLICT DO NOTHING
      `, [memberId, memberId, today, memberId])
      return res?.rowCount || 0
    }
    if (type === 'event') {
      const res = await database.raw(`
        INSERT INTO participations (member, activity_type, activity_id, status, note, guest_count, is_staff)
        SELECT DISTINCT ?::integer, 'event', e.id::text, 'confirmed', '', 0, false
        FROM events e
        WHERE e.cancelled = false
          AND (e.participation_mode IS NULL OR e.participation_mode = 'whole')
          AND e.start_date::date >= ?::date
          AND (
            EXISTS (SELECT 1 FROM events_teams et JOIN member_teams mt
                      ON mt.team = et.teams_id
                    WHERE et.events_id = e.id AND mt.member = ?::integer
                      AND (e.invite_guests IS NOT FALSE OR COALESCE(mt.guest_level, 0) = 0))
            OR EXISTS (SELECT 1 FROM events_members em
                       WHERE em.events_id = e.id AND em.members_id = ?::integer)
            OR (NOT EXISTS (SELECT 1 FROM events_teams et2 WHERE et2.events_id = e.id)
                AND NOT EXISTS (SELECT 1 FROM events_members em2 WHERE em2.events_id = e.id))
          )
          AND NOT EXISTS (
            SELECT 1 FROM participations p
            WHERE p.activity_type = 'event' AND p.activity_id = e.id::text AND p.member = ?::integer
          )
        ON CONFLICT DO NOTHING
      `, [memberId, today, memberId, memberId, memberId])
      return res?.rowCount || 0
    }
    return 0
  }

  // Shared per-training pass: absence-decline then auto-confirm. Used by
  // both the trainings.items.create hook and the slot-cascade callsites
  // (initial generation, slot update fill, nightly rolling top-up) — those
  // do bulk INSERTs directly on `trainings` and bypass the Directus
  // item-create event, so without this we'd miss every cascaded training.
  async function applyTrainingAutoRSVP(trainingId) {
    try {
      const training = await database('trainings').where('id', trainingId).first()
      if (!training || training.cancelled || !training.team || !training.date) return
      const dateStr = safeDateStr(training.date)
      if (!dateStr) return
      const res = await database.raw(`
        INSERT INTO participations (member, activity_type, activity_id, status, note, guest_count, is_staff, auto_declined_by, waitlisted_at)
        SELECT mt.member, 'training', ?::text, 'declined', COALESCE(a.reason, ''), 0, mt.is_staff, a.id, '1970-01-01 00:00:00+00'::timestamptz
        FROM ${teamPeopleSql('?::integer')} mt
        JOIN absences a ON a.member = mt.member
        WHERE a.start_date::date <= ?::date AND a.end_date::date >= ?::date
          AND (a.affects::jsonb @> '"all"' OR a.affects::jsonb @> '"trainings"')
          AND (a.type IS DISTINCT FROM 'weekly' OR (a.days_of_week::jsonb @> to_jsonb((EXTRACT(DOW FROM ?::date)::int + 6) % 7)))
          AND NOT EXISTS (
            SELECT 1 FROM participations p
            WHERE p.activity_type = 'training' AND p.activity_id = ?::text AND p.member = mt.member
          )
        ON CONFLICT DO NOTHING
      `, [String(trainingId), training.team, training.team, dateStr, dateStr, dateStr, String(trainingId)])
      if (res?.rowCount > 0) log.info(`[absence-auto-decline] Training ${trainingId}: ${res.rowCount} members auto-declined`)
      const confirmed = await autoConfirmTraining(trainingId)
      if (confirmed > 0) log.info(`[auto-confirm] Training ${trainingId}: ${confirmed} members auto-confirmed`)
    } catch (err) {
      log.error({ msg: `[auto-rsvp] Training ${trainingId}: ${err.message}`, event: 'training_auto_rsvp_failed', trainingId, stack: err.stack })
    }
  }

  // Combined game↔training sweep runner: hall-block shorten/cancel + own-team
  // game-day cancel (sweepGameTrainingShorten), then the per-member two-team
  // clash declines (sweepGameClashDeclines — after, so trainings the first
  // sweep just cancelled are skipped). Both are whole-table idempotent, so
  // it's safe to fire on every games/trainings/hall_slots mutation; sv-sync/
  // bp-sync/spielplanung write games via raw knex (no items hooks), which the
  // 02:20 nightly run covers.
  const runGameTrainingSweeps = async () => {
    try {
      await sweepGameTrainingShorten(database, log)
    } catch (err) {
      log.error({ msg: `[game-training-shorten] action sweep failed: ${err.message}`, event: 'game_training_shorten_action_failed', stack: err.stack })
    }
    try {
      await sweepGameClashDeclines(database, log)
    } catch (err) {
      log.error({ msg: `[game-clash-decline] action sweep failed: ${err.message}`, event: 'game_clash_decline_action_failed', stack: err.stack })
    }
  }

  // When a training is created via Directus, run the auto-RSVP pass.
  // (Slot-cascade bulk inserts call applyTrainingAutoRSVP directly — see
  // the hall_slots.items.create / .update actions and the nightly cron.)
  // Also clear any regeneration tombstone (migration 162) for this
  // (hall_slot, date): manually re-adding an occupant means the coach wants
  // it back, so the slot may regenerate it again later.
  action('trainings.items.create', async ({ key }) => {
    await applyTrainingAutoRSVP(key)
    try {
      const row = await database('trainings').where('id', key).first('hall_slot', 'date')
      if (row?.hall_slot) await clearTrainingSkip(database, row.hall_slot, row.date)
    } catch (err) {
      log.error({ msg: `[slot-cascade] clear-skip on training create failed: ${err.message}`, event: 'training_skip_clear_failed', training: key, stack: err.stack })
    }
    // A manually added training on a game day is subject to the same rules —
    // own-team cancel + clash declines — without waiting for the nightly run.
    await runGameTrainingSweeps()
  })

  action('games.items.create', async ({ key }) => {
    try {
      const game = await database('games').where('id', key).first()
      if (!game || !game.kscw_team || !game.date) return
      const dateStr = safeDateStr(game.date)
      if (!dateStr) return
      const res = await database.raw(`
        INSERT INTO participations (member, activity_type, activity_id, status, note, guest_count, is_staff, auto_declined_by, waitlisted_at)
        SELECT mt.member, 'game', ?::text, 'declined', COALESCE(a.reason, ''), 0, mt.is_staff, a.id, '1970-01-01 00:00:00+00'::timestamptz
        FROM ${teamPeopleSql('?::integer')} mt
        JOIN absences a ON a.member = mt.member
        -- Guests (member_teams.guest_level > 0) can never play a league game, so
        -- the roster modal drops them from every game — but the RSVP bricks count
        -- each row they leave behind, and the declined tally drifts one above the
        -- roster for every guest with a standing absence. Migration 124 purged
        -- that once and guarded autoDeclineForAbsence; this sweep (a NEW fixture
        -- landing inside an existing absence) was writing the same rows unguarded
        -- and re-seeded 128 of them by 27.08.2026. Same guard, same reason.
        WHERE mt.guest_level = 0
          AND a.start_date::date <= ?::date AND a.end_date::date >= ?::date
          AND (a.affects::jsonb @> '"all"' OR a.affects::jsonb @> '"games"')
          AND (a.type IS DISTINCT FROM 'weekly' OR (a.days_of_week::jsonb @> to_jsonb((EXTRACT(DOW FROM ?::date)::int + 6) % 7)))
          AND NOT EXISTS (
            SELECT 1 FROM participations p
            WHERE p.activity_type = 'game' AND p.activity_id = ?::text AND p.member = mt.member
          )
        ON CONFLICT DO NOTHING
      `, [String(key), game.kscw_team, game.kscw_team, dateStr, dateStr, dateStr, String(key)])
      if (res?.rowCount > 0) log.info(`[absence-auto-decline] Game ${key}: ${res.rowCount} members auto-declined`)

      // Auto-confirm pass — per-activity override + team default. Guest-level=0
      // only (trg_participations_guest_block enforces). NOT EXISTS protects
      // absence-declined rows above and any prior participation.
      const confirmed = await autoConfirmGame(key)
      if (confirmed > 0) log.info(`[auto-confirm] Game ${key}: ${confirmed} members auto-confirmed`)
    } catch (err) {
      log.error({ msg: `[absence-auto-decline] Game create: ${err.message}`, event: 'absence_auto_decline_game', key, stack: err.stack })
    }
  })

  // Absence auto-decline pass for one event. Used by the events.items.create
  // action and by the date-move re-eval (reEvalEventAutoDeclines). Eligibility
  // is eventEligibilitySql — invited teams ∪ invited members ∪ everyone active
  // when club-wide — so club-wide and individually-invited events get the same
  // absence handling as team events. Whole-mode events get one NULL-session
  // declined row matched on the event's Zurich date; per_day/per_session
  // events get one row per event_sessions day the absence actually covers
  // (session_id = event_sessions.id::text — the per-day RSVP identity the
  // roster readers expect). Returns the number of rows inserted.
  async function applyEventAbsenceDeclines(eventId) {
    const event = await database('events').where('id', eventId).first()
    if (!event || !event.start_date) return 0
    const mode = event.participation_mode || 'whole'
    if (mode !== 'whole') {
      const res = await database.raw(`
        INSERT INTO participations (member, activity_type, activity_id, status, note, guest_count, is_staff, auto_declined_by, waitlisted_at, session_id)
        SELECT DISTINCT ON (a.member, s.id) a.member, 'event', e.id::text, 'declined', COALESCE(a.reason, ''), 0, false, a.id, '1970-01-01 00:00:00+00'::timestamptz, s.id::text
        FROM events e
        JOIN event_sessions s ON s.event = e.id
        JOIN absences a ON a.start_date::date <= s.date AND a.end_date::date >= s.date
        WHERE e.id = ?::integer
          AND (a.affects::jsonb @> '"all"' OR a.affects::jsonb @> '"events"')
          AND (a.type IS DISTINCT FROM 'weekly' OR (a.days_of_week::jsonb @> to_jsonb((EXTRACT(DOW FROM s.date)::int + 6) % 7)))
          AND ${eventEligibilitySql('e.id', 'a.member')}
          AND NOT EXISTS (
            SELECT 1 FROM participations p
            WHERE p.activity_type = 'event' AND p.activity_id = e.id::text AND p.member = a.member
              AND p.session_id = s.id::text
          )
        ON CONFLICT DO NOTHING
      `, [eventId])
      return res?.rowCount || 0
    }
    // events.start_date is timestamptz; absence window/DOW matching is by
    // calendar date → derive the date in Zurich, not UTC (a 01:00 Zurich
    // event is the previous day in UTC and would match the wrong day).
    const ds = await database.raw(
      `SELECT to_char((? ::timestamptz AT TIME ZONE 'Europe/Zurich')::date, 'YYYY-MM-DD') AS d`,
      [event.start_date],
    )
    const dateStr = ds?.rows?.[0]?.d
    if (!dateStr) return 0
    const res = await database.raw(`
      INSERT INTO participations (member, activity_type, activity_id, status, note, guest_count, is_staff, auto_declined_by, waitlisted_at)
      SELECT DISTINCT ON (a.member) a.member, 'event', e.id::text, 'declined', COALESCE(a.reason, ''), 0, false, a.id, '1970-01-01 00:00:00+00'::timestamptz
      FROM events e
      JOIN absences a ON a.start_date::date <= ?::date AND a.end_date::date >= ?::date
      WHERE e.id = ?::integer
        AND (a.affects::jsonb @> '"all"' OR a.affects::jsonb @> '"events"')
        AND (a.type IS DISTINCT FROM 'weekly' OR (a.days_of_week::jsonb @> to_jsonb((EXTRACT(DOW FROM ?::date)::int + 6) % 7)))
        AND ${eventEligibilitySql('e.id', 'a.member')}
        AND NOT EXISTS (
          SELECT 1 FROM participations p
          WHERE p.activity_type = 'event' AND p.activity_id = e.id::text AND p.member = a.member
        )
      ON CONFLICT DO NOTHING
    `, [dateStr, dateStr, eventId, dateStr])
    return res?.rowCount || 0
  }

  // Events — mirror trainings/games: decline for members already on absence
  action('events.items.create', async ({ key }) => {
    try {
      const declined = await applyEventAbsenceDeclines(key)
      if (declined > 0) log.info(`[absence-auto-decline] Event ${key}: ${declined} members auto-declined`)

      // Auto-confirm pass — opted-in members only (no team-level event setting).
      // NOT EXISTS protects the absence-declines just inserted above.
      const confirmed = await autoConfirmEvent(key)
      if (confirmed > 0) log.info(`[auto-confirm] Event ${key}: ${confirmed} members auto-confirmed`)
    } catch (err) {
      log.error({ msg: `[absence-auto-decline] Event create: ${err.message}`, event: 'absence_auto_decline_event', key, stack: err.stack })
    }
  })

  // ── Activity date-change re-evaluation ─────────────────────────
  // When a training/game/event date moves, reverse stale auto-declines that
  // no longer apply (activity moved OUT of absence window), then insert fresh
  // ones for the new date (activity moved INTO a window). Manual overrides
  // are safe — the BEFORE UPDATE trigger on participations detaches them.
  // Trainings/games only — events go through reEvalEventAutoDeclines, whose
  // eligibility isn't member_teams-shaped (club-wide / invited members) and
  // whose per-session rows re-check against their own session date.

  // `teamId` replaced a caller-supplied `teamFilterSql`/`params` pair on
  // 2026-08-15: both callers passed the identical `mt.team = ?::integer`, and
  // the eligibility set below is no longer a bare `member_teams` scan with a
  // `team` column to filter on.
  async function reEvalActivityAutoDeclines(activityType, activityId, teamId, dateStr) {
    // 1. Unwind auto-declines that no longer match (new date outside window).
    //
    // ⚠ Two KINDS of row carry `auto_declined_by`, and they unwind differently —
    // the invariant `unwindAbsenceAutoDeclines` states and this path used to
    // ignore (audit 2026-08-08, finding 22). Rows the auto-decline CREATED carry
    // the sentinel `waitlisted_at` and must be DELETED; rows it merely OVERRODE
    // (the member had already confirmed, and the absence flipped the existing
    // row, leaving `waitlisted_at` NULL) must be REVERTED to confirmed. Deleting
    // both destroyed a confirmed RSVP that the very same row would have had
    // restored had the absence simply been deleted instead.
    const STALE_ABSENCE_PREDICATE = `
        AND p.auto_declined_by = a.id
        AND (
          a.start_date::date > ?::date OR a.end_date::date < ?::date
          OR (
            NOT (a.affects::jsonb @> '"all"' OR a.affects::jsonb @> ?)
          )
          OR (
            a.type = 'weekly' AND NOT (a.days_of_week::jsonb @> to_jsonb((EXTRACT(DOW FROM ?::date)::int + 6) % 7))
          )
        )`
    const staleParams = [dateStr, dateStr, `"${activityType}s"`, dateStr]
    await database.raw(`
      DELETE FROM participations p
      USING absences a
      WHERE p.activity_type = ?
        AND p.activity_id = ?::text
        ${STALE_ABSENCE_PREDICATE}
        AND p.waitlisted_at = ?::timestamptz
    `, [activityType, String(activityId), ...staleParams, AUTO_DECLINE_CREATED_SENTINEL])
    await database.raw(`
      UPDATE participations p
      SET status = 'confirmed', auto_declined_by = NULL, note = ''
      FROM absences a
      WHERE p.activity_type = ?
        AND p.activity_id = ?::text
        ${STALE_ABSENCE_PREDICATE}
        AND (p.waitlisted_at IS NULL OR p.waitlisted_at <> ?::timestamptz)
    `, [activityType, String(activityId), ...staleParams, AUTO_DECLINE_CREATED_SENTINEL])
    // 2. Insert fresh auto-declines for the new date (NOT EXISTS skips manual overrides)
    //    Sentinel waitlisted_at marks these as auto-decline-created so the
    //    absence unwind DELETEs them rather than reverting to 'confirmed'.
    //
    // The guest guard is the same one `autoDeclineForAbsence` applies, in the
    // same two flavours: a game is closed to every guest level (they may not
    // play league games at all), a training only to the levels that training
    // excluded. Without it a date move re-seeds exactly the rows the roster
    // hides and the RSVP bricks count — the drift migration 124 cleaned up and
    // 345 had to clean up again. Bound LAST so every existing `?` keeps its
    // position.
    const guestGuard = activityType === 'game'
      ? 'AND mt.guest_level = 0'
      : `AND NOT (COALESCE((SELECT t2.excluded_guest_levels FROM trainings t2 WHERE t2.id = ?::integer), '[]')::jsonb @> to_jsonb(mt.guest_level))`
    const guestGuardParams = activityType === 'game' ? [] : [Number(activityId)]
    await database.raw(`
      INSERT INTO participations (member, activity_type, activity_id, status, note, guest_count, is_staff, auto_declined_by, waitlisted_at)
      SELECT mt.member, ?, ?::text, 'declined', COALESCE(a.reason, ''), 0, mt.is_staff, a.id, '1970-01-01 00:00:00+00'::timestamptz
      FROM ${teamPeopleSql('?::integer')} mt
      JOIN absences a ON a.member = mt.member
      WHERE a.start_date::date <= ?::date AND a.end_date::date >= ?::date
        AND (a.affects::jsonb @> '"all"' OR a.affects::jsonb @> ?)
        AND (a.type IS DISTINCT FROM 'weekly' OR (a.days_of_week::jsonb @> to_jsonb((EXTRACT(DOW FROM ?::date)::int + 6) % 7)))
        AND NOT EXISTS (
          SELECT 1 FROM participations p
          WHERE p.activity_type = ? AND p.activity_id = ?::text AND p.member = mt.member
        )
        ${guestGuard}
      ON CONFLICT DO NOTHING
    `, [activityType, String(activityId), teamId, teamId, dateStr, dateStr, `"${activityType}s"`, dateStr, activityType, String(activityId), ...guestGuardParams])
  }

  // Event flavor of the re-eval: delete stale auto-declines (whole-event rows
  // checked against the event's new Zurich date, per-session rows against
  // their own session's date), then re-apply the same pass the create hook
  // runs. Like reEvalActivityAutoDeclines, only rows with `auto_declined_by`
  // set are touched — manual overrides were already detached by the trigger.
  async function reEvalEventAutoDeclines(eventId) {
    const event = await database('events').where('id', eventId).first()
    if (!event || !event.start_date) return
    // events.start_date is timestamptz; absence window/DOW matching is by
    // calendar date, so derive the date in Zurich (not UTC). An event at
    // 01:00 Zurich is the previous day in UTC, which would match the wrong
    // absence day. safeDateStr() on the raw value would keep the UTC date.
    const ds = await database.raw(
      `SELECT to_char((? ::timestamptz AT TIME ZONE 'Europe/Zurich')::date, 'YYYY-MM-DD') AS d`,
      [event.start_date],
    )
    const dateStr = ds?.rows?.[0]?.d
    if (!dateStr) return
    // Same sentinel split as reEvalActivityAutoDeclines — see the note there.
    const STALE_EVENT_PREDICATE = `
        AND p.auto_declined_by = a.id
        AND p.session_id IS NULL
        AND (
          a.start_date::date > ?::date OR a.end_date::date < ?::date
          OR NOT (a.affects::jsonb @> '"all"' OR a.affects::jsonb @> '"events"')
          OR (a.type = 'weekly' AND NOT (a.days_of_week::jsonb @> to_jsonb((EXTRACT(DOW FROM ?::date)::int + 6) % 7)))
        )`
    await database.raw(`
      DELETE FROM participations p
      USING absences a
      WHERE p.activity_type = 'event'
        AND p.activity_id = ?::text
        ${STALE_EVENT_PREDICATE}
        AND p.waitlisted_at = ?::timestamptz
    `, [String(eventId), dateStr, dateStr, dateStr, AUTO_DECLINE_CREATED_SENTINEL])
    await database.raw(`
      UPDATE participations p
      SET status = 'confirmed', auto_declined_by = NULL, note = ''
      FROM absences a
      WHERE p.activity_type = 'event'
        AND p.activity_id = ?::text
        ${STALE_EVENT_PREDICATE}
        AND (p.waitlisted_at IS NULL OR p.waitlisted_at <> ?::timestamptz)
    `, [String(eventId), dateStr, dateStr, dateStr, AUTO_DECLINE_CREATED_SENTINEL])
    const STALE_SESSION_PREDICATE = `
        AND p.auto_declined_by = a.id
        AND s.event = ?::integer
        AND p.session_id = s.id::text
        AND (
          a.start_date::date > s.date OR a.end_date::date < s.date
          OR NOT (a.affects::jsonb @> '"all"' OR a.affects::jsonb @> '"events"')
          OR (a.type = 'weekly' AND NOT (a.days_of_week::jsonb @> to_jsonb((EXTRACT(DOW FROM s.date)::int + 6) % 7)))
        )`
    await database.raw(`
      DELETE FROM participations p
      USING absences a, event_sessions s
      WHERE p.activity_type = 'event'
        AND p.activity_id = ?::text
        ${STALE_SESSION_PREDICATE}
        AND p.waitlisted_at = ?::timestamptz
    `, [String(eventId), eventId, AUTO_DECLINE_CREATED_SENTINEL])
    await database.raw(`
      UPDATE participations p
      SET status = 'confirmed', auto_declined_by = NULL, note = ''
      FROM absences a, event_sessions s
      WHERE p.activity_type = 'event'
        AND p.activity_id = ?::text
        ${STALE_SESSION_PREDICATE}
        AND (p.waitlisted_at IS NULL OR p.waitlisted_at <> ?::timestamptz)
    `, [String(eventId), eventId, AUTO_DECLINE_CREATED_SENTINEL])
    await applyEventAbsenceDeclines(eventId)
  }

  // Notify the whole team (players + coaches + TR) when a training is
  // cancelled from the "Cancel training" control. Mirrors notifyAbsenceThirdParty:
  // an in-app `notifications` row (client localizes via title+body keys) plus a
  // per-recipient localized web push. Reinstating sends cancelled:false so it
  // never reaches here; past trainings are skipped (nothing to warn about).
  async function notifyTrainingCancelled(trainingId) {
    const tr = await database('trainings').where('id', trainingId)
      .select('id', 'team', 'date', 'cancelled').first()
    if (!tr || !tr.cancelled || !tr.team || !tr.date) return

    const dateStr = safeDateStr(tr.date)
    if (!dateStr) return
    const today = safeDateStr(new Date())
    if (today && dateStr < today) return // past training — skip

    const teamRow = await database('teams').where('id', tr.team).select('name').first()
    const teamName = teamRow?.name || `Team ${tr.team}`

    const [players, coaches, trs] = await Promise.all([
      database('member_teams').where('team', tr.team).select('member'),
      database('teams_coaches').where('teams_id', tr.team).select('members_id'),
      database('teams_responsibles').where('teams_id', tr.team).select('members_id'),
    ])
    const memberIds = [...new Set([
      ...players.map(r => r.member),
      ...coaches.map(r => r.members_id),
      ...trs.map(r => r.members_id),
    ].filter(Boolean))]
    if (memberIds.length === 0) return

    const active = await database('members')
      .whereIn('id', memberIds)
      .andWhere('wiedisync_active', true)
      .select('id')
    const recipientIds = active.map(r => r.id)
    if (recipientIds.length === 0) return

    const dateFmt = dateStr.split('-').reverse().join('.') // dd.mm.yyyy

    await database('notifications').insert(recipientIds.map(rid => ({
      member: rid,
      type: 'training_cancelled',
      title: 'training_cancelled',
      body: JSON.stringify({ date: dateFmt }),
      activity_type: 'training',
      activity_id: String(tr.id),
      team: tr.team,
      read: false,
    })))

    await sendLocalizedPush(
      database,
      recipientIds,
      (pids, title, body) => sendPushToMembers(database, pids, title, body, `${FRONTEND_URL}/trainings`, `training-cancelled-${tr.id}`, log),
      'trainingCancelled.title',
      'trainingCancelled.body',
      { team: teamName, date: dateFmt },
    )
  }

  // ── Forms (migrations 086/087) ──────────────────────────────────────
  // Notify the scoped audience once, when a form transitions to `open`.
  //
  // The dedupe used to look for an existing `form_published` NOTIFICATION row,
  // which is transient by design: the nightly cleanup deletes anything older
  // than 30 days through an untyped catch-all (its activity-type rules protect
  // only game/training/event; form rows carry 'form'), and members can delete
  // their own from the bell menu. The dedupe needed ZERO surviving rows
  // club-wide, so a small team's form could lose its key in days — and a form
  // published in January, typo-fixed in March, then re-notified AND re-pushed
  // every active member, repeating on every later edit. The trigger is
  // `status === 'open'` and the builder re-sends the whole object on every save,
  // so an edit is enough; coaches can trigger it too (audit 2026-08-08, #19).
  //
  // The state now lives on the form (migration 305), exactly as announcements
  // already do with `fanout_sent_at`. Claiming it is a CONDITIONAL update — the
  // row count tells us whether we won — so the fan-out is re-entrant and immune
  // to the purge, and two concurrent saves cannot both send.
  async function notifyFormPublished(formId) {
    const form = await database('forms').where('id', formId)
      .select('id', 'title', 'status', 'audience').first()
    if (!form || form.status !== 'open') return

    const claimed = await database('forms')
      .where('id', formId)
      .whereNull('published_notified_at')
      .update({ published_notified_at: new Date().toISOString() })
    if (!claimed) return

    let memberIds = []
    if (form.audience === 'club_wide') {
      const rows = await database('members').where('wiedisync_active', true).select('id')
      memberIds = rows.map(r => r.id)
    } else {
      const teamRows = await database('forms_teams').where('forms_id', formId).select('teams_id')
      const teamIds = [...new Set(teamRows.map(r => r.teams_id).filter(Boolean))]
      if (teamIds.length === 0) return
      const [players, coaches, trs] = await Promise.all([
        database('member_teams').whereIn('team', teamIds).select('member'),
        database('teams_coaches').whereIn('teams_id', teamIds).select('members_id'),
        database('teams_responsibles').whereIn('teams_id', teamIds).select('members_id'),
      ])
      memberIds = [...new Set([
        ...players.map(r => r.member),
        ...coaches.map(r => r.members_id),
        ...trs.map(r => r.members_id),
      ].filter(Boolean))]
    }
    if (memberIds.length === 0) return

    const active = await database('members')
      .whereIn('id', memberIds)
      .andWhere('wiedisync_active', true)
      .select('id')
    const recipientIds = active.map(r => r.id)
    if (recipientIds.length === 0) return

    await database('notifications').insert(recipientIds.map(rid => ({
      member: rid,
      type: 'form_published',
      title: 'form_published',
      body: JSON.stringify({ title: form.title }),
      activity_type: 'form',
      activity_id: String(form.id),
      team: null,
      read: false,
    })))

    await sendLocalizedPush(
      database,
      recipientIds,
      (pids, title, body) => sendPushToMembers(database, pids, title, body, `${FRONTEND_URL}/forms`, `form-${form.id}`, log),
      'formPublished.title',
      'formPublished.body',
      { title: form.title },
    )
  }

  action('forms.items.update', async ({ keys, payload }) => {
    if (payload && payload.status === 'open') {
      for (const k of keys) {
        try {
          await notifyFormPublished(k)
        } catch (err) {
          log.error({ msg: `[form-published-notify] ${err.message}`, event: 'form_published_notify', keys: [k], stack: err.stack })
        }
      }
    }
  })

  // ── Forms: audience + ownership guard (audit 2026-08-08, finding 10) ──
  //
  // The rule lived ONLY in the browser (FormBuilder.tsx: "Full managers can
  // target any audience incl. club-wide … Public exposure is also
  // full-manager-only"). Server-side, LEADER holds an UNFILTERED `forms.create`
  // — and setup-permissions.mjs's own note records that Directus filters are
  // no-ops on CREATE and that self-scoping "is therefore enforced in the
  // kscw-hooks *.items.create filter guard". That guard did not exist; only an
  // action hook did, which runs too late to refuse anything.
  //
  // So any coach/TR could POST `{audience:'club_wide', is_public:true, slug:'x',
  // created_by:<own id>}` and (a) make `notifyFormPublished` fan a notification
  // and web push out to EVERY active member, repeatable per new form since the
  // limiter is keyed per-form, and (b) publish an anonymously readable and
  // submittable page at /kscw/public/forms/:slug on the club's own domain,
  // reading the harvested rows back via FORMS_LEADER_SCOPE.
  // `created_by` was client-supplied too, so `authorizeManage`'s creator branch
  // authorised on an attacker-chosen column.
  //
  // Modelled on the `announcements.items.create` guard above, which already does
  // exactly this. Manager tiers (admin/superuser bypass filter hooks entirely;
  // vorstand and the sport admins are allowed through here) keep club-wide and
  // public forms — `forms` is in SPORT_ADMIN_FULL_CRUD and the FormsPage is
  // sport-scoped by design. This constrains the LEADER tier, which is where the
  // escalation was.
  async function assertFormAudienceAllowed(payload, meta, context) {
    const userId = context?.accountability?.user
    // System context (cron/endpoint/registration backend) — trusted, as elsewhere.
    if (!userId) return payload
    const m = await database('members').where('user', userId).select('id', 'role').first()
    if (!m) return payload
    const roles = Array.isArray(m.role) ? m.role : []
    const isManager = roles.includes('admin') || roles.includes('superuser')
      || roles.includes('vorstand') || roles.includes('vb_admin') || roles.includes('bb_admin')

    if (!isManager) {
      // A PATCH is partial, so judge the state the write would PRODUCE, not the
      // payload alone — the same reason validateAnnouncementAudience merges over
      // the stored row. A PATCH of only {is_public:true} carries no audience.
      const keys = meta?.keys || (meta?.key ? [meta.key] : [])
      const existing = keys.length
        ? await database('forms').whereIn('id', keys).select('audience', 'is_public')
        : [{}]
      for (const row of existing) {
        const next = { ...row, ...payload }
        if (next.audience && next.audience !== 'teams') {
          throw kscwScopeError('Only the board and sport admins can create club-wide forms.', 403, 'FORM_AUDIENCE')
        }
        if (next.is_public === true) {
          throw kscwScopeError('Only the board and sport admins can publish a form publicly.', 403, 'FORM_PUBLIC')
        }
      }
      // Every linked team must be one the caller actually leads. The M2M arrives
      // as junction objects; a bare id is a create.
      const links = Array.isArray(payload?.teams) ? payload.teams : []
      for (const link of links) {
        const teamId = typeof link === 'object' ? (link.teams_id ?? link) : link
        if (teamId != null && !(await actorLeadsTeam(database, context.accountability, teamId))) {
          throw kscwScopeError('You can only target teams you coach or are responsible for.', 403, 'FORM_TEAM_SCOPE')
        }
      }
    }

    // `created_by` is the column authorizeManage trusts, so it is stamped
    // server-side and never taken from the client — on update it cannot be
    // reassigned at all.
    const keys = meta?.keys || (meta?.key ? [meta.key] : [])
    if (keys.length > 0) {
      if (payload && Object.prototype.hasOwnProperty.call(payload, 'created_by')) delete payload.created_by
    } else if (payload) {
      payload.created_by = m.id
    }
    return payload
  }

  filter('forms.items.create', async (payload, meta, context) => assertFormAudienceAllowed(payload, meta, context))
  filter('forms.items.update', async (payload, meta, context) => assertFormAudienceAllowed(payload, meta, context))

  action('forms.items.create', async ({ key, payload }) => {
    if (payload && payload.status === 'open') {
      try {
        await notifyFormPublished(key)
      } catch (err) {
        log.error({ msg: `[form-published-notify] ${err.message}`, event: 'form_published_notify', keys: [key], stack: err.stack })
      }
    }
  })

  // ── Form submissions: server-side required-field validation ─────────
  // The app validates required fields client-side; this is the backstop for
  // any write that reaches Directus (member fill view, admin back-office). The
  // public website submits via the knex endpoint, which validates separately.
  // Best-effort: never block on an unexpected shape, only on a genuine miss.
  function answerIsEmpty(field, v) {
    if (v === null || v === undefined) return true
    if (field.type === 'multi_choice') return !(Array.isArray(v) && v.length > 0)
    if (field.type === 'yes_no') return false // a boolean is always an answer
    if (typeof v === 'string') return v.trim() === ''
    return false
  }
  filter('form_submissions.items.create', async (payload) => {
    try {
      if (!payload || !payload.form) return payload
      const form = await database('forms').where('id', payload.form).select('fields').first()
      const fields = Array.isArray(form?.fields) ? form.fields : []
      const answers = payload.answers && typeof payload.answers === 'object' ? payload.answers : {}
      for (const f of fields) {
        if (f && f.required && answerIsEmpty(f, answers[f.id])) {
          throw new Error(`Missing required field: ${f.label || f.id}`)
        }
      }
    } catch (err) {
      if (err.message && err.message.startsWith('Missing required field')) throw err
      // Swallow lookup/shape errors — the guard trigger still enforces integrity.
      log.warn({ msg: `[form-submission-validate] ${err.message}`, event: 'form_submission_validate' })
    }
    return payload
  })

  // ── Notify the form's owner (+ co-managers) when a response arrives ──
  // The author no longer has to keep re-opening the responses view. Recipients:
  // the form creator, plus coaches/TRs of any team the form is scoped to. The
  // submitter is excluded (so test-filling your own form is quiet). Anonymous
  // forms still notify — the owner sees a response landed, not who sent it.
  async function notifyFormSubmission(submissionId) {
    const sub = await database('form_submissions').where('id', submissionId)
      .select('id', 'form', 'member').first()
    if (!sub) return
    const form = await database('forms').where('id', sub.form)
      .select('id', 'title', 'created_by', 'audience').first()
    if (!form) return

    const recipients = new Set()
    if (form.created_by) recipients.add(form.created_by)
    if (form.audience === 'teams') {
      const teamRows = await database('forms_teams').where('forms_id', form.id).select('teams_id')
      const teamIds = [...new Set(teamRows.map(r => r.teams_id).filter(Boolean))]
      if (teamIds.length > 0) {
        const [coaches, trs] = await Promise.all([
          database('teams_coaches').whereIn('teams_id', teamIds).select('members_id'),
          database('teams_responsibles').whereIn('teams_id', teamIds).select('members_id'),
        ])
        for (const r of coaches) if (r.members_id) recipients.add(r.members_id)
        for (const r of trs) if (r.members_id) recipients.add(r.members_id)
      }
    }
    // Don't notify the person who just submitted.
    if (sub.member) recipients.delete(sub.member)
    if (recipients.size === 0) return

    const active = await database('members')
      .whereIn('id', [...recipients]).andWhere('wiedisync_active', true).select('id')
    const recipientIds = active.map(r => r.id)
    if (recipientIds.length === 0) return

    await database('notifications').insert(recipientIds.map(rid => ({
      member: rid,
      type: 'form_submission',
      title: 'form_submission',
      body: JSON.stringify({ title: form.title }),
      activity_type: 'form',
      activity_id: String(form.id),
      team: null,
      read: false,
    })))

    await sendLocalizedPush(
      database,
      recipientIds,
      (pids, title, body) => sendPushToMembers(database, pids, title, body, `${FRONTEND_URL}/forms`, `form-sub-${form.id}`, log),
      'formSubmission.title',
      'formSubmission.body',
      { title: form.title },
    )
  }

  action('form_submissions.items.create', async ({ key }) => {
    try {
      await notifyFormSubmission(key)
    } catch (err) {
      log.error({ msg: `[form-submission-notify] ${err.message}`, event: 'form_submission_notify', keys: [key], stack: err.stack })
    }
  })

  action('trainings.items.update', async ({ keys, payload }) => {
    // Notify the team when a training is cancelled (coach/TR pressed "Cancel
    // training"). payload.cancelled === true only on the cancel transition.
    if (payload && payload.cancelled === true) {
      for (const k of keys) {
        try {
          await notifyTrainingCancelled(k)
        } catch (err) {
          log.error({ msg: `[training-cancel-notify] ${err.message}`, event: 'training_cancel_notify', keys: [k], stack: err.stack })
        }
      }
    }

    // Re-eval absence-decline when date changed
    if (payload && 'date' in payload) {
      try {
        for (const k of keys) {
          const t = await database('trainings').where('id', k).first()
          if (!t || t.cancelled || !t.team || !t.date) continue
          const dateStr = t.date.toISOString?.().split('T')[0] || String(t.date).split('T')[0]
          await reEvalActivityAutoDeclines('training', k, t.team, dateStr)
        }
      } catch (err) {
        log.error({ msg: `[absence-auto-decline] Training update: ${err.message}`, event: 'absence_auto_decline_training_update', keys, stack: err.stack })
      }
      // A moved training may enter/leave a game day — re-run the game sweeps
      // (own-team cancel + clash declines) instead of waiting for the nightly.
      await runGameTrainingSweeps()
    }

    // Backfill auto-confirm when auto_confirm_rsvp flips on (or any future-dated
    // update where effective auto-confirm is true and rows are missing).
    if (payload && 'auto_confirm_rsvp' in payload) {
      try {
        for (const k of keys) {
          const c = await autoConfirmTraining(k, { onlyIfFuture: true })
          if (c > 0) log.info(`[auto-confirm] Training ${k} update: ${c} members auto-confirmed`)
        }
      } catch (err) {
        log.error({ msg: `[auto-confirm] Training update: ${err.message}`, keys, stack: err.stack })
      }
    }
  })

  // Per-duty confirmation actor (migration 123). A duty is "confirmed" iff it
  // has a person; so when a role's member FK is set we stamp WHO did it + WHEN,
  // and when it's cleared we wipe them. A filter (not an action) rides the
  // existing payload — a second raw write would re-fire trg_games_notify and
  // double-notify the team. Writers are only LEADER/admins (games.update is
  // ['*'] for them), so the injected fields pass field-level permission. Name
  // only — games.read is ['*'] for members; the actor line is admin-only client-side.
  const DUTY_CONFIRM_ROLES = [
    { member: 'scorer_member', name: 'scorer_confirmed_by_name', at: 'scorer_confirmed_at' },
    { member: 'scoreboard_member', name: 'scoreboard_confirmed_by_name', at: 'scoreboard_confirmed_at' },
    { member: 'scorer_scoreboard_member', name: 'scorer_scoreboard_confirmed_by_name', at: 'scorer_scoreboard_confirmed_at' },
    { member: 'referee_member', name: 'referee_confirmed_by_name', at: 'referee_confirmed_at' },
    { member: 'bb_scorer_member', name: 'bb_scorer_confirmed_by_name', at: 'bb_scorer_confirmed_at' },
    { member: 'bb_timekeeper_member', name: 'bb_timekeeper_confirmed_by_name', at: 'bb_timekeeper_confirmed_at' },
    { member: 'bb_24s_official', name: 'bb_24s_confirmed_by_name', at: 'bb_24s_confirmed_at' },
  ]
  filter('games.items.update', async (payload, _meta, { accountability }) => {
    if (!payload) return payload
    const touched = DUTY_CONFIRM_ROLES.filter((r) => r.member in payload)
    if (touched.length === 0) return payload
    try {
      let actorName = null
      if (touched.some((r) => payload[r.member]) && accountability?.user) {
        const m = await database('members').where('user', accountability.user).first('first_name', 'last_name')
        if (m) actorName = [m.first_name, m.last_name].filter(Boolean).join(' ').trim() || null
      }
      const nowIso = new Date().toISOString()
      const out = { ...payload }
      for (const r of touched) {
        if (payload[r.member]) { out[r.name] = actorName; out[r.at] = nowIso }
        else { out[r.name] = null; out[r.at] = null }
      }
      return out
    } catch (err) {
      log.error({ msg: `[duty-confirm-actor] ${err.message}`, event: 'duty_confirm_actor', stack: err.stack })
    }
    return payload
  })

  // Delegation transfer (fixes the live items-API path that only set status):
  // when a scorer-duty delegation becomes 'accepted' — on UPDATE (cross-team,
  // recipient accepts) or on CREATE (same-team, auto-accepted by
  // trg_scorer_delegation_validate) — move the duty's member (and duty team for
  // cross-team) to the recipient on the game, and re-stamp that role's
  // confirmed-by to the new person. Raw knex (bypasses perms — a plain member
  // accepting can't write games via the items API). Role keys are the English
  // ScorerDelegation.role values.
  const DELEG_ROLE_MEMBER = {
    scorer: { member: 'scorer_member', team: 'scorer_duty_team', name: 'scorer_confirmed_by_name', at: 'scorer_confirmed_at' },
    scoreboard: { member: 'scoreboard_member', team: 'scoreboard_duty_team', name: 'scoreboard_confirmed_by_name', at: 'scoreboard_confirmed_at' },
    scorer_scoreboard: { member: 'scorer_scoreboard_member', team: 'scorer_scoreboard_duty_team', name: 'scorer_scoreboard_confirmed_by_name', at: 'scorer_scoreboard_confirmed_at' },
    referee: { member: 'referee_member', team: 'referee_duty_team', name: 'referee_confirmed_by_name', at: 'referee_confirmed_at' },
    bb_scorer: { member: 'bb_scorer_member', team: 'bb_scorer_duty_team', name: 'bb_scorer_confirmed_by_name', at: 'bb_scorer_confirmed_at' },
    bb_timekeeper: { member: 'bb_timekeeper_member', team: 'bb_timekeeper_duty_team', name: 'bb_timekeeper_confirmed_by_name', at: 'bb_timekeeper_confirmed_at' },
    bb_24s_official: { member: 'bb_24s_official', team: 'bb_24s_duty_team', name: 'bb_24s_confirmed_by_name', at: 'bb_24s_confirmed_at' },
  }
  async function transferDelegatedDuty(delegationId, accountability) {
    const d = await database('scorer_delegations').where('id', delegationId).first()
    if (!d || d.status !== 'accepted' || !d.game || !d.to_member) return
    const cols = DELEG_ROLE_MEMBER[d.role]
    if (!cols) { log.warn(`[delegation-transfer] unknown role ${d.role} on delegation ${delegationId}`); return }
    // Security (HOOK-1 / PG-1): this raw-knex games write bypasses the
    // LEADER-only games.update permission. For a non-admin items-API actor,
    // only allow the transfer when (a) the acting user is the RECIPIENT
    // accepting — never the sender self-accepting a duty onto a victim — AND
    // (b) the delegator actually currently holds the duty being handed off.
    // Admin / system context (no accountability.user) bypasses; the accept
    // ENDPOINT does its own recipient + duty-ownership checks.
    if (accountability?.user && !accountability.admin) {
      const actor = await database('members').where('user', accountability.user).first('id')
      if (!actor || Number(actor.id) !== Number(d.to_member)) {
        log.warn(`[delegation-transfer] ${delegationId}: acting user is not the recipient — refusing transfer`)
        return
      }
      const game = await database('games').where('id', d.game).first(cols.member)
      if (!game || game[cols.member] == null || Number(game[cols.member]) !== Number(d.from_member)) {
        log.warn(`[delegation-transfer] ${delegationId}: delegator ${d.from_member} does not currently hold ${d.role} on game ${d.game} — refusing`)
        return
      }
    }
    const updates = { [cols.member]: d.to_member }
    // Set the role's duty team to the recipient's team. Prefer the delegation's
    // to_team; if it's blank (the modal couldn't resolve it), fall back to the
    // recipient's own membership — otherwise the game keeps a stale/empty team
    // and the assignment shows a person with no team (bug 2026-07-11).
    if (cols.team) {
      let toTeam = d.to_team || null
      if (!toTeam) {
        // ACTIVE team, deterministically chosen — an unqualified read picks an
        // arbitrary row with no ORDER BY, and 648 of prod's rows sit on archived
        // teams, so the assignment gets stamped with last season's team. Twin of
        // the same fallback in kscw-endpoints/src/duty-late.js — keep in step.
        const mt = await database('member_teams as mt')
          .join('teams as t', 't.id', 'mt.team')
          .where('mt.member', d.to_member).where('t.active', true)
          .orderBy('mt.team', 'asc').first('mt.team as team')
        toTeam = mt?.team ?? null
      }
      if (toTeam) updates[cols.team] = toTeam
    }
    const m = await database('members').where('id', d.to_member).first('first_name', 'last_name')
    updates[cols.name] = m ? ([m.first_name, m.last_name].filter(Boolean).join(' ').trim() || null) : null
    updates[cols.at] = new Date().toISOString()
    await database('games').where('id', d.game).update(updates)
  }
  // Bilingual (DE · EN) role labels for delegation notifications.
  const DELEG_ROLE_LABEL = {
    scorer: 'Schreiber · Scorer', scoreboard: 'Täfeler · Scoreboard',
    scorer_scoreboard: 'Schreiber+Täfeler · Scorer+Scoreboard', referee: 'Schiedsrichter · Referee',
    bb_scorer: 'Scorer', bb_timekeeper: 'Zeitnehmer · Timekeeper', bb_24s_official: '24s',
  }
  // In-app notification + web push for a delegation lifecycle event. Delegations
  // previously notified NOBODY (bug 2026-07-11): requested → tell the recipient,
  // accepted/declined → tell the delegator.
  async function notifyDelegation(delegationId, kind) {
    const d = await database('scorer_delegations').where('id', delegationId).first()
    if (!d) return
    const roleLabel = DELEG_ROLE_LABEL[d.role] || d.role
    const game = d.game ? await database('games').where('id', d.game).first('home_team', 'away_team') : null
    const matchup = game ? `${game.home_team || ''} – ${game.away_team || ''}`.trim() : ''
    const [from, to] = await Promise.all([
      database('members').where('id', d.from_member).first('first_name', 'last_name'),
      database('members').where('id', d.to_member).first('first_name', 'last_name'),
    ])
    const fromName = from ? `${from.first_name} ${from.last_name}`.trim() : '—'
    const toName = to ? `${to.first_name} ${to.last_name}`.trim() : '—'
    const url = `${FRONTEND_URL}/scorer`
    const tag = `delegation-${d.id}`
    const activityId = d.game != null ? String(d.game) : null
    let recipient, title, body, team
    if (kind === 'requested') {
      recipient = d.to_member; team = d.to_team || null
      title = 'Einsatz-Anfrage · Duty request'
      body = `${fromName} möchte dir den Dienst «${roleLabel}» übergeben (${matchup}) — bitte bestätigen · asked you to take the ${roleLabel} duty — please confirm.`
    } else if (kind === 'accepted') {
      recipient = d.from_member; team = d.from_team || null
      title = 'Angenommen · Accepted'
      body = `${toName} hat deine Übergabe «${roleLabel}» angenommen (${matchup}) · accepted your ${roleLabel} delegation.`
    } else { // declined
      recipient = d.from_member; team = d.from_team || null
      title = 'Abgelehnt · Declined'
      body = `${toName} hat deine Übergabe «${roleLabel}» abgelehnt (${matchup}) · declined your ${roleLabel} delegation.`
    }
    if (recipient == null) return
    await database('notifications').insert({ member: recipient, type: 'scorer_delegation', title, body, activity_type: 'game', activity_id: activityId, team, read: false })
    try { await sendPushToMembers(database, [recipient], title, body, url, tag, log) }
    catch (e) { log.error({ msg: `[delegation-notify] push failed: ${e.message}`, stack: e.stack }) }
  }

  action('scorer_delegations.items.create', async ({ key }, context) => {
    try {
      if (key == null) return
      await transferDelegatedDuty(key, context?.accountability)
      await notifyDelegation(key, 'requested') // pending → ask the recipient to confirm
    } catch (err) { log.error({ msg: `[delegation-transfer] create: ${err.message}`, stack: err.stack }) }
  })
  action('scorer_delegations.items.update', async ({ keys, payload }, context) => {
    const status = payload?.status
    if (status !== 'accepted' && status !== 'declined') return
    try {
      for (const k of keys) {
        if (status === 'accepted') await transferDelegatedDuty(k, context?.accountability)
        await notifyDelegation(k, status === 'accepted' ? 'accepted' : 'declined')
      }
    } catch (err) { log.error({ msg: `[delegation-transfer] update: ${err.message}`, stack: err.stack }) }
  })

  action('games.items.update', async ({ keys, payload }) => {
    if (payload && 'date' in payload) {
      try {
        for (const k of keys) {
          const g = await database('games').where('id', k).first()
          if (!g || !g.kscw_team || !g.date) continue
          if (['completed', 'postponed', 'cancelled'].includes(g.status)) continue
          const dateStr = g.date.toISOString?.().split('T')[0] || String(g.date).split('T')[0]
          await reEvalActivityAutoDeclines('game', k, g.kscw_team, dateStr)
        }
      } catch (err) {
        log.error({ msg: `[absence-auto-decline] Game update: ${err.message}`, event: 'absence_auto_decline_game_update', keys, stack: err.stack })
      }
    }

    if (payload && 'auto_confirm_rsvp' in payload) {
      try {
        for (const k of keys) {
          const c = await autoConfirmGame(k, { onlyIfFuture: true })
          if (c > 0) log.info(`[auto-confirm] Game ${k} update: ${c} members auto-confirmed`)
        }
      } catch (err) {
        log.error({ msg: `[auto-confirm] Game update: ${err.message}`, keys, stack: err.stack })
      }
    }
  })

  // Team toggle flip → backfill future activities that still inherit (auto_confirm_rsvp IS NULL).
  //
  // Also fires on a STAFF change (`coach` / `team_responsible` in the payload —
  // how ManageStaffModal and MemberRow write the junctions, as a nested M2M on
  // teams). A newly attached coach has to be caught here rather than by the
  // junction's own items.create event, because a nested M2M write is not
  // guaranteed to surface as one. Re-reads the team's CURRENT features_enabled
  // in that case: the payload only carries the junctions, so the toggle state
  // has to come from the row.
  action('teams.items.update', async ({ keys, payload }) => {
    if (!payload) return
    const staffChanged = 'coach' in payload || 'team_responsible' in payload
    if (!('features_enabled' in payload) && !staffChanged) return

    try {
      for (const teamId of keys) {
        const fe = 'features_enabled' in payload
          ? parseTeamFeatures(payload.features_enabled)
          : parseTeamFeatures((await database('teams').where('id', teamId).first('features_enabled'))?.features_enabled)
        const wantsTraining = fe.training_auto_confirm === true
        const wantsGame = fe.game_auto_confirm === true
        if (!wantsTraining && !wantsGame) continue

        if (wantsTraining) {
          const rows = await database.raw(`
            INSERT INTO participations (member, activity_type, activity_id, status, note, guest_count, is_staff)
            SELECT e.member, 'training', t.id::text, 'confirmed', '', 0, e.is_staff
            FROM trainings t
            JOIN LATERAL ${teamPeopleSql('t.team')} e ON true
            WHERE t.team = ?::integer
              AND t.cancelled = false
              AND t.date >= CURRENT_DATE
              AND t.auto_confirm_rsvp IS NULL
              AND NOT (COALESCE(t.excluded_guest_levels, '[]')::jsonb @> to_jsonb(e.guest_level))
              AND NOT EXISTS (
                SELECT 1 FROM participations p
                WHERE p.activity_type = 'training' AND p.activity_id = t.id::text AND p.member = e.member
              )
            ON CONFLICT DO NOTHING
          `, [teamId])
          if (rows?.rowCount > 0) log.info(`[auto-confirm] Team ${teamId} training backfill: ${rows.rowCount} confirmed`)
        }
        if (wantsGame) {
          const rows = await database.raw(`
            INSERT INTO participations (member, activity_type, activity_id, status, note, guest_count, is_staff)
            SELECT e.member, 'game', g.id::text, 'confirmed', '', 0, e.is_staff
            FROM games g
            JOIN LATERAL ${teamPeopleSql('g.kscw_team')} e ON true
            WHERE g.kscw_team = ?::integer
              AND g.date >= CURRENT_DATE
              AND g.auto_confirm_rsvp IS NULL
              AND COALESCE(g.status, '') NOT IN ('completed','postponed','cancelled')
              AND e.guest_level = 0
              AND ${notGuestAnywhereSql('e.member')}
              AND NOT EXISTS (
                SELECT 1 FROM participations p
                WHERE p.activity_type = 'game' AND p.activity_id = g.id::text AND p.member = e.member
              )
            ON CONFLICT DO NOTHING
          `, [teamId])
          if (rows?.rowCount > 0) log.info(`[auto-confirm] Team ${teamId} game backfill: ${rows.rowCount} confirmed`)
        }
      }
    } catch (err) {
      log.error({ msg: `[auto-confirm] Team toggle backfill: ${err.message}`, keys, stack: err.stack })
    }
  })

  // Somebody joins a team → backfill the activities that already exist.
  //
  // Auto-confirm used to fire only on activity creation and on the two toggle
  // flips, all of which are keyed on the activity or the setting — never on the
  // roster. So a player added after their team's trainings were generated was
  // never picked up and stayed "not responded" forever (HU14's roster, filled
  // 2026-07-04 against trainings generated earlier: 1–5 RSVPs on a 21-strong
  // team). Games hid the same gap because sweepGameAutoConfirm re-runs after
  // every SVRZ/Basketplan sync; trainings had no equivalent until now.
  //
  // Both the junction create hooks and the nightly sweep exist deliberately:
  // these make it immediate, the sweep is the backstop for every write path
  // that never reaches an items event (raw SQL, imports, nested M2M).
  const backfillJoinerAutoConfirm = async (teamId, memberId, source) => {
    if (teamId == null || memberId == null) return
    try {
      const t = await autoConfirmJoiner(teamId, memberId, 'training')
      const g = await autoConfirmJoiner(teamId, memberId, 'game')
      if (t + g > 0) log.info(`[auto-confirm] ${source}: member ${memberId} joined team ${teamId} → ${t} training + ${g} game confirmed`)
    } catch (err) {
      log.error({ msg: `[auto-confirm] ${source} backfill: ${err.message}`, teamId, memberId, stack: err.stack })
    }
  }

  // One person, one team, all future activities of that team. Effective
  // auto-confirm is evaluated per activity — COALESCE(activity override, team
  // default, false) OR the person's own opt-in — mirroring the sweeps exactly,
  // so a per-activity `false` suppresses the team default but not a personal
  // opt-in.
  async function autoConfirmJoiner(teamId, memberId, type) {
    if (type === 'training') {
      const res = await database.raw(`
        INSERT INTO participations (member, activity_type, activity_id, status, note, guest_count, is_staff)
        SELECT e.member, 'training', tr.id::text, 'confirmed', '', 0, e.is_staff
        FROM trainings tr
        JOIN teams t ON t.id = tr.team
        JOIN LATERAL ${teamPeopleSql('tr.team')} e ON e.member = ?::integer
        JOIN members m ON m.id = e.member
        WHERE tr.team = ?::integer
          AND tr.cancelled = false
          AND tr.date::date >= CURRENT_DATE
          AND (
            COALESCE(tr.auto_confirm_rsvp,
                     NULLIF(t.features_enabled->>'training_auto_confirm', '')::boolean,
                     false) = true
            OR m.auto_confirm_trainings = true
          )
          AND NOT (COALESCE(tr.excluded_guest_levels, '[]')::jsonb @> to_jsonb(e.guest_level))
          AND NOT EXISTS (
            SELECT 1 FROM participations p
            WHERE p.activity_type = 'training' AND p.activity_id = tr.id::text AND p.member = e.member
          )
        ON CONFLICT DO NOTHING
      `, [memberId, teamId])
      return res?.rowCount || 0
    }
    const res = await database.raw(`
      INSERT INTO participations (member, activity_type, activity_id, status, note, guest_count, is_staff)
      SELECT e.member, 'game', g.id::text, 'confirmed', '', 0, e.is_staff
      FROM games g
      JOIN teams t ON t.id = g.kscw_team
      JOIN LATERAL ${teamPeopleSql('g.kscw_team')} e ON e.member = ?::integer
      JOIN members m ON m.id = e.member
      WHERE g.kscw_team = ?::integer
        AND g.date::date >= CURRENT_DATE
        AND COALESCE(g.status, '') NOT IN ('completed','postponed','cancelled')
        AND e.guest_level = 0
        AND ${notGuestAnywhereSql('e.member')}
        AND (
          COALESCE(g.auto_confirm_rsvp,
                   NULLIF(t.features_enabled->>'game_auto_confirm', '')::boolean,
                   false) = true
          OR m.auto_confirm_games = true
        )
        AND NOT EXISTS (
          SELECT 1 FROM participations p
          WHERE p.activity_type = 'game' AND p.activity_id = g.id::text AND p.member = e.member
        )
      ON CONFLICT DO NOTHING
    `, [memberId, teamId])
    return res?.rowCount || 0
  }

  action('member_teams.items.create', async ({ key, payload }) => {
    const row = key != null
      ? await database('member_teams').where('id', key).first('team', 'member')
      : null
    await backfillJoinerAutoConfirm(row?.team ?? payload?.team, row?.member ?? payload?.member, 'member_teams.create')
  })
  // A staff-only person's rows carry is_staff = true, and a person who is BOTH
  // coach and player is a player — teamPeopleSql decides that, not the callsite.
  for (const junction of ['teams_coaches', 'teams_responsibles']) {
    action(`${junction}.items.create`, async ({ key, payload }) => {
      const row = key != null
        ? await database(junction).where('id', key).first('teams_id', 'members_id')
        : null
      await backfillJoinerAutoConfirm(row?.teams_id ?? payload?.teams_id, row?.members_id ?? payload?.members_id, `${junction}.create`)
    })
  }

  action('events.items.update', async ({ keys, payload }) => {
    // Migration 324: guests just got un-invited — drop the RSVPs they can no
    // longer make. Leaving them is the documented count-drift bug: the roster
    // modal filters excluded guests out while ParticipationSummary counts every
    // participations row, so the bricks say 8 and the list shows 6. The rows are
    // logged before deletion; flipping the switch back does NOT restore them.
    if (payload && payload.invite_guests === false) {
      for (const k of keys) {
        try {
          const doomed = await database.raw(`
            DELETE FROM participations p
            USING member_teams mt, events_teams et
            WHERE p.activity_type = 'event' AND p.activity_id = ?::text
              AND mt.member = p.member
              AND et.events_id = ?::integer
              AND mt.team = et.teams_id
              AND COALESCE(mt.guest_level, 0) > 0
              -- Core on ANY invited team, or invited by name → still invited.
              AND NOT EXISTS (
                SELECT 1 FROM events_teams et2 JOIN member_teams mt2 ON mt2.team = et2.teams_id
                WHERE et2.events_id = ?::integer AND mt2.member = p.member
                  AND COALESCE(mt2.guest_level, 0) = 0
              )
              AND NOT EXISTS (
                SELECT 1 FROM events_members em
                WHERE em.events_id = ?::integer AND em.members_id = p.member
              )
            RETURNING p.member, p.status, p.note
          `, [String(k), k, k, k])
          const rows = doomed?.rows ?? []
          if (rows.length > 0) {
            log.info(`[invite-guests] Event ${k}: removed ${rows.length} guest RSVP(s): ${
              rows.map((r) => `${r.member}=${r.status}${r.note ? ` (${r.note})` : ''}`).join(', ')}`)
          }
        } catch (err) {
          log.error({ msg: `[invite-guests] Event ${k}: ${err.message}`, event: 'invite_guests_cleanup', keys: [k], stack: err.stack })
        }
      }
    }

    if (!payload || !('start_date' in payload)) return
    try {
      for (const k of keys) await reEvalEventAutoDeclines(k)
    } catch (err) {
      log.error({ msg: `[absence-auto-decline] Event update: ${err.message}`, event: 'absence_auto_decline_event_update', keys, stack: err.stack })
    }
  })

  // ── Hall Closure → Training Auto-Cancel ────────────────────────
  // When a hall_closures record is created or moved, cancel all future trainings
  // in that hall+date range. When the closure is deleted (or no longer covers
  // a training's date), reverse any trainings this closure had auto-cancelled.
  // Manual cancels are protected by the clear-marker trigger.

  async function applyClosureAutoCancel(closureId) {
    try {
      const c = await database('hall_closures').where('id', closureId).first()
      if (!c) return
      const start = c.start_date?.toISOString?.().split('T')[0]
        || String(c.start_date).split('T')[0]
      const end = c.end_date?.toISOString?.().split('T')[0]
        || String(c.end_date).split('T')[0]
      const today = new Date().toISOString().split('T')[0]
      const effectiveStart = start > today ? start : today
      const reason = c.reason || 'Halle geschlossen'

      // 1. Reverse trainings this closure had previously cancelled that no
      //    longer fall in its (new) window — covers date-range edits.
      //
      // ⚠ `auto_cancelled_by_closure` is SINGLE-VALUED but closures overlap
      // routinely (48 overlapping same-hall pairs on prod). The cancel pass
      // below requires `cancelled = false`, so the second closure to cover a
      // training silently no-ops and records nothing — the marker names only the
      // FIRST one. Reversing on the marker alone therefore re-activates
      // trainings that another closure still covers (audit 2026-08-08,
      // finding 20). Re-derive coverage instead of trusting the marker, and
      // bound to today forward so a range edit cannot retroactively un-cancel
      // history (the notify trigger skips past dates, so that would be silent).
      await database.raw(`
        UPDATE trainings
        SET cancelled = false,
            cancel_reason = '',
            auto_cancelled_by_closure = NULL
        WHERE auto_cancelled_by_closure = ?::integer
          AND (hall != ? OR date < ?::date OR date > ?::date)
          AND date >= CURRENT_DATE
          AND NOT EXISTS (
            SELECT 1 FROM hall_closures c2
            WHERE c2.hall = trainings.hall
              AND c2.id <> ?::integer
              AND trainings.date BETWEEN c2.start_date AND c2.end_date
          )
      `, [closureId, c.hall, start, end, closureId])

      // 2. Auto-cancel non-cancelled future trainings newly covered.
      const res = await database.raw(`
        UPDATE trainings
        SET cancelled = true,
            cancel_reason = ?,
            auto_cancelled_by_closure = ?::integer
        WHERE hall = ?
          AND date >= ?::date AND date <= ?::date
          AND cancelled = false
      `, [reason, closureId, c.hall, effectiveStart, end])
      if (res?.rowCount > 0) log.info(`[closure-auto-cancel] Closure ${closureId}: ${res.rowCount} trainings auto-cancelled`)
    } catch (err) {
      log.error({ msg: `[closure-auto-cancel] ${err.message}`, event: 'closure_auto_cancel', closureId, stack: err.stack })
    }
  }

  action('hall_closures.items.create', async ({ key }) => { await applyClosureAutoCancel(key) })
  action('hall_closures.items.update', async ({ keys }) => { for (const k of keys) await applyClosureAutoCancel(k) })
  action('hall_closures.items.delete', async ({ keys }) => {
    try {
      for (const k of keys) {
        // Same re-derivation as pass 1: deleting one of two overlapping
        // closures must not re-activate a training the other still shuts. The
        // deleted row is already gone by the time this action runs, so the
        // `c2.id <> k` guard is belt-and-braces rather than load-bearing.
        // Without the date bound this also silently un-cancelled past sessions.
        const res = await database.raw(`
          UPDATE trainings
          SET cancelled = false, cancel_reason = '', auto_cancelled_by_closure = NULL
          WHERE auto_cancelled_by_closure = ?::integer
            AND date >= CURRENT_DATE
            AND NOT EXISTS (
              SELECT 1 FROM hall_closures c2
              WHERE c2.hall = trainings.hall
                AND c2.id <> ?::integer
                AND trainings.date BETWEEN c2.start_date AND c2.end_date
            )
        `, [k, k])
        if (res?.rowCount > 0) log.info(`[closure-auto-cancel] Closure ${k} deleted: ${res.rowCount} trainings reversed`)
      }
    } catch (err) {
      log.error({ msg: `[closure-auto-cancel] delete: ${err.message}`, event: 'closure_auto_cancel_delete', stack: err.stack })
    }
  })

  // ── Cron: Absence Auto-Decline Sweep (01:30 UTC) ────────────────
  // Catches gaps: existing absences + newly generated recurring trainings,
  // or any edge case missed by the create/update hooks above.
  schedule('30 1 * * *', async () => {
    try {
      let total = 0

      // Trainings: decline for absent members who have no participation yet
      // (waitlisted_at sentinel marks these auto-decline-created → unwind DELETEs)
      const t1 = await database.raw(`
        INSERT INTO participations (member, activity_type, activity_id, status, note, guest_count, is_staff, auto_declined_by, waitlisted_at)
        SELECT mt.member, 'training', t.id::text, 'declined', COALESCE(a.reason, ''), 0, mt.is_staff, a.id, '1970-01-01 00:00:00+00'::timestamptz
        FROM trainings t
        JOIN LATERAL ${teamPeopleSql('t.team')} mt ON true
        JOIN absences a ON a.member = mt.member
        WHERE t.date >= CURRENT_DATE AND t.cancelled = false
          AND a.start_date::date <= t.date AND a.end_date::date >= t.date
          AND (a.affects::jsonb @> '"all"' OR a.affects::jsonb @> '"trainings"')
          AND (a.type IS DISTINCT FROM 'weekly' OR (a.days_of_week::jsonb @> to_jsonb(((EXTRACT(DOW FROM t.date)::int + 6) % 7))))
          AND NOT EXISTS (
            SELECT 1 FROM participations p
            WHERE p.activity_type = 'training' AND p.activity_id = t.id::text AND p.member = mt.member
          )
        ON CONFLICT DO NOTHING
      `)
      total += t1?.rowCount || 0

      // Games
      const t2 = await database.raw(`
        INSERT INTO participations (member, activity_type, activity_id, status, note, guest_count, is_staff, auto_declined_by, waitlisted_at)
        SELECT mt.member, 'game', g.id::text, 'declined', COALESCE(a.reason, ''), 0, mt.is_staff, a.id, '1970-01-01 00:00:00+00'::timestamptz
        FROM games g
        ${GAME_SQUAD_JOIN}
        JOIN absences a ON a.member = mt.member
        WHERE g.date >= CURRENT_DATE AND g.kscw_team IS NOT NULL
          AND COALESCE(g.status, '') NOT IN ('completed', 'postponed', 'cancelled')
          AND a.start_date::date <= g.date AND a.end_date::date >= g.date
          AND (a.affects::jsonb @> '"all"' OR a.affects::jsonb @> '"games"')
          AND (a.type IS DISTINCT FROM 'weekly' OR (a.days_of_week::jsonb @> to_jsonb(((EXTRACT(DOW FROM g.date)::int + 6) % 7))))
          AND NOT EXISTS (
            SELECT 1 FROM participations p
            WHERE p.activity_type = 'game' AND p.activity_id = g.id::text AND p.member = mt.member
          )
        ON CONFLICT DO NOTHING
      `)
      total += t2?.rowCount || 0

      // Events — eligibility mirrors autoConfirmEvent (invited teams ∪ invited
      // members ∪ everyone active when club-wide), so club-wide events can't
      // dodge the sweep. DISTINCT ON so overlapping absences produce one row
      // per member. events.start_date is timestamptz → localize to Zurich for
      // the calendar-date window/DOW match (a 01:00 Zurich event is the prior
      // day in UTC). Whole-mode events only here — sessioned events follow.
      // Sentinel waitlisted_at marks these auto-decline-created → unwind DELETEs.
      const t3 = await database.raw(`
        INSERT INTO participations (member, activity_type, activity_id, status, note, guest_count, is_staff, auto_declined_by, waitlisted_at)
        SELECT DISTINCT ON (a.member, e.id) a.member, 'event', e.id::text, 'declined', COALESCE(a.reason, ''), 0, false, a.id, '1970-01-01 00:00:00+00'::timestamptz
        FROM events e
        JOIN absences a ON a.start_date::date <= (e.start_date AT TIME ZONE 'Europe/Zurich')::date
                       AND a.end_date::date >= (e.start_date AT TIME ZONE 'Europe/Zurich')::date
        WHERE (e.start_date AT TIME ZONE 'Europe/Zurich')::date >= CURRENT_DATE
          AND (e.participation_mode IS NULL OR e.participation_mode = 'whole')
          AND (a.affects::jsonb @> '"all"' OR a.affects::jsonb @> '"events"')
          AND (a.type IS DISTINCT FROM 'weekly' OR (a.days_of_week::jsonb @> to_jsonb(((EXTRACT(DOW FROM (e.start_date AT TIME ZONE 'Europe/Zurich')::date)::int + 6) % 7))))
          AND ${eventEligibilitySql('e.id', 'a.member')}
          AND NOT EXISTS (
            SELECT 1 FROM participations p
            WHERE p.activity_type = 'event' AND p.activity_id = e.id::text AND p.member = a.member
          )
        ON CONFLICT DO NOTHING
      `)
      total += t3?.rowCount || 0

      // per_day/per_session events — one declined row per event_sessions day
      // the absence covers (session_id = event_sessions.id::text), matched on
      // the session's own date. A NULL-session row would be invisible to the
      // per-day roster readers, and day 2 of a camp can be covered while day 1
      // is not.
      const t4 = await database.raw(`
        INSERT INTO participations (member, activity_type, activity_id, status, note, guest_count, is_staff, auto_declined_by, waitlisted_at, session_id)
        SELECT DISTINCT ON (a.member, s.id) a.member, 'event', e.id::text, 'declined', COALESCE(a.reason, ''), 0, false, a.id, '1970-01-01 00:00:00+00'::timestamptz, s.id::text
        FROM events e
        JOIN event_sessions s ON s.event = e.id
        JOIN absences a ON a.start_date::date <= s.date AND a.end_date::date >= s.date
        WHERE s.date >= CURRENT_DATE
          AND e.participation_mode IN ('per_day', 'per_session')
          AND (a.affects::jsonb @> '"all"' OR a.affects::jsonb @> '"events"')
          AND (a.type IS DISTINCT FROM 'weekly' OR (a.days_of_week::jsonb @> to_jsonb((EXTRACT(DOW FROM s.date)::int + 6) % 7)))
          AND ${eventEligibilitySql('e.id', 'a.member')}
          AND NOT EXISTS (
            SELECT 1 FROM participations p
            WHERE p.activity_type = 'event' AND p.activity_id = e.id::text AND p.member = a.member
              AND p.session_id = s.id::text
          )
        ON CONFLICT DO NOTHING
      `)
      total += t4?.rowCount || 0

      if (total > 0) log.info(`[absence-sweep] Auto-declined ${total} participations`)
    } catch (err) {
      log.error({ msg: `[absence-sweep] ${err.message}`, event: 'cron.absence_sweep', stack: err.stack })
      logCronError('absence_sweep', err)
    }
  })

  // ── 2. Cron: Shell Account Expiry (02:00 UTC) ──────────────────
  // Batch UPDATE — no loop needed

  schedule('0 2 * * *', async () => {
    try {
      const count = await database('members')
        .where('shell', true)
        .where('shell_expires', '<', new Date().toISOString())
        .whereNotNull('shell_expires')
        .where('kscw_membership_active', true)
        .update({ kscw_membership_active: false })
      if (count > 0) log.info(`Shell expiry: ${count} deactivated`)
    } catch (err) {
      log.error({ msg: `Shell expiry: ${err.message}`, event: 'cron.shell_expiry', stack: err.stack })
      logCronError('shell_expiry', err)
    }
  })

  // ── 3. Cron: Invite Expiry (03:00 UTC) ─────────────────────────
  // Expire pending team_invites past their expiry date

  schedule('0 3 * * *', async () => {
    try {
      const count = await database('team_invites')
        .where('status', 'pending')
        .where('expires_at', '<', new Date().toISOString())
        .update({ status: 'expired' })
      if (count > 0) log.info(`Invite expiry: ${count} expired`)
    } catch (err) {
      log.error({ msg: `Invite expiry: ${err.message}`, event: 'cron.invite_expiry', stack: err.stack })
      logCronError('invite_expiry', err)
    }
  })

  // ── 4. Cron: Scorer Delegation Expiry (05:00 UTC) ──────────────
  // Expire pending delegations for past games

  schedule('0 5 * * *', async () => {
    try {
      const today = new Date().toISOString().split('T')[0]
      const count = await database('scorer_delegations')
        .where('status', 'pending')
        .whereIn('game', function () {
          this.select('id').from('games').where('date', '<', today)
        })
        .update({ status: 'expired' })
      if (count > 0) log.info(`Delegation expiry: ${count} expired`)
    } catch (err) {
      log.error({ msg: `Delegation expiry: ${err.message}`, event: 'cron.delegation_expiry', stack: err.stack })
      logCronError('delegation_expiry', err)
    }
  })

  // ── 4b. Cron: participation_visibility drift check (04:20 UTC) ──
  //
  // `participation_visibility` (migration 341) materialises the guest-roster
  // branch of the `participations` read policy, because expressing it as a filter
  // cost 254× — Directus compiles a policy `_or` into flat sibling LEFT JOINs that
  // cross-multiply (26.08.2026: 302 rows → 148,915,476 intermediate rows).
  //
  // ⚠⚠ The table is reconciled by ~10 triggers. A missed trigger SOURCE is a
  // SILENT LEAK — someone keeps read access they should have lost — and that is
  // strictly worse than the performance bug it replaced, because nobody notices.
  // This cron is the safety net that makes it noisy instead.
  //
  // `extra`   = readable by someone who must NOT → treat as a security incident.
  // `missing` = not readable by someone who should → merely annoying.
  //
  // It HEALS as well as reports: leaving a known leak open until a human reads a
  // log is not a defensible default. The drift is logged in full FIRST, so the
  // evidence survives the repair and the missing trigger can still be found.
  schedule('20 4 * * *', async () => {
    try {
      // Tolerate an environment where migration 341 has not been applied yet
      // (fresh install, or a dev DB restored from an older baseline) — otherwise
      // this would log a fatal every night on a perfectly healthy system.
      const fn = await database.raw(
        "SELECT to_regprocedure('verify_participation_visibility()') IS NOT NULL AS present")
      if (!fn?.rows?.[0]?.present) return

      const before = (await database.raw('SELECT kind, participation, viewer_user FROM verify_participation_visibility()'))?.rows ?? []
      if (before.length === 0) return

      const extra = before.filter((r) => r.kind === 'extra')
      const missing = before.filter((r) => r.kind === 'missing')
      log.error({
        msg: `participation_visibility DRIFT: ${extra.length} extra (LEAK), ${missing.length} missing`,
        event: 'cron.participation_visibility_drift',
        sample: before.slice(0, 20),
      })
      logCronError('participation_visibility_drift',
        new Error(`${extra.length} extra (leak), ${missing.length} missing — a trigger source is missing`))

      await database.raw('SELECT refresh_participation_visibility()')
      const after = (await database.raw('SELECT count(*)::int AS n FROM verify_participation_visibility()'))?.rows?.[0]?.n ?? -1
      if (after === 0) {
        log.info('participation_visibility: drift healed by refresh — find the missing trigger source')
      } else {
        // Refresh could not fix it ⇒ the view itself disagrees with reality, which
        // is a different and worse bug than a stale trigger.
        log.error({
          msg: `participation_visibility: STILL ${after} drifted after refresh`,
          event: 'cron.participation_visibility_drift',
        })
      }
    } catch (err) {
      log.error({ msg: `participation_visibility check: ${err.message}`, event: 'cron.participation_visibility_drift', stack: err.stack })
      logCronError('participation_visibility_drift', err)
    }
  })

  // ── 5. Cron: Notification Cleanup (04:00 UTC) ──────────────────
  // 1) Delete notifications for past activities (day after activity date)
  // 2) Delete orphaned notifications (activity was deleted)
  // 3) Fallback: delete remaining notifications older than 30 days

  schedule('0 4 * * *', async () => {
    try {
      // 1) Past activities — delete notifications whose game/training/event already happened
      const pastGames = await database.raw(`
        DELETE FROM notifications n
        USING games g
        WHERE n.activity_type = 'game' AND n.activity_id = g.id::text
          AND g.date < CURRENT_DATE
      `)
      const pastTrainings = await database.raw(`
        DELETE FROM notifications n
        USING trainings t
        WHERE n.activity_type = 'training' AND n.activity_id = t.id::text
          AND t.date < CURRENT_DATE
      `)
      const pastEvents = await database.raw(`
        DELETE FROM notifications n
        USING events e
        WHERE n.activity_type = 'event' AND n.activity_id = e.id::text
          AND e.start_date::date < CURRENT_DATE
      `)

      // 2) Orphaned — activity was deleted but notification lingers
      const orphaned = await database.raw(`
        DELETE FROM notifications
        WHERE activity_type IN ('game', 'training', 'event')
          AND activity_id IS NOT NULL AND activity_id != ''
          AND (
            (activity_type = 'game'     AND NOT EXISTS (SELECT 1 FROM games     WHERE id::text = notifications.activity_id))
            OR (activity_type = 'training' AND NOT EXISTS (SELECT 1 FROM trainings WHERE id::text = notifications.activity_id))
            OR (activity_type = 'event'    AND NOT EXISTS (SELECT 1 FROM events    WHERE id::text = notifications.activity_id))
          )
      `)

      // 3) Fallback — catch-all for non-activity notifications (team, poll, etc.)
      const cutoff = new Date()
      cutoff.setDate(cutoff.getDate() - 30)
      const old = await database('notifications')
        .where('date_created', '<', cutoff.toISOString())
        .delete()

      const pastCount = (pastGames?.rowCount || 0) + (pastTrainings?.rowCount || 0) + (pastEvents?.rowCount || 0)
      const total = pastCount + (orphaned?.rowCount || 0) + old
      if (total > 0) log.info(`Notification cleanup: ${total} deleted (past=${pastCount}, orphaned=${orphaned?.rowCount || 0}, old=${old})`)
    } catch (err) {
      log.error({ msg: `Notification cleanup: ${err.message}`, event: 'cron.notification_cleanup', stack: err.stack })
      logCronError('notification_cleanup', err)
    }
  })

  // ── No-response deadline sweep (migration 352) ─────────────────
  //
  // "Late sign-in" used to catch exactly one thing: a leader confirming
  // somebody past respond_by, which pops IssueFineModal in the roster. The
  // member who never answered AT ALL was invisible to it — no participation
  // row, so no prompt, no fine, and a roster that counted them as undecided
  // right up to the whistle. Ignoring the deadline is the behaviour the rule
  // was written to price, and it was the one behaviour the rule could not see.
  //
  // Once the deadline has passed this writes the decline they never sent and
  // auto-issues the late_signin fine for it.
  //
  // ⚠ Opt-in is ONE switch: the team must hold an ENABLED `fine_rules` row for
  // `late_signin`. No rule → not swept, not declined, not fined. A team that
  // has never opened the Fines panel is untouched by all of this.
  //
  // ⚠ Bounded at BOTH ends. Upper: the deadline has actually passed. Lower:
  // no longer ago than DEADLINE_SWEEP_LOOKBACK_DAYS. Without a lower bound the
  // first run after deploy reaches back across every activity whose deadline
  // had ever passed and fines a whole club at once for deadlines nobody was
  // told had teeth. A few days rather than one, so an overnight cron failure
  // still catches up instead of letting a day's worth escape forever.
  //
  // ⚠ Staff are out (`is_staff = false`) — a late sign-in is a player rule,
  // not a coach one, the same line the roster's manual prompt draws.
  //
  // ⚠ Called-up guests are out: the GAME branch joins `teamPeopleSql`, NOT
  // `GAME_SQUAD_JOIN`, so `game_guests` never appear. Somebody doing another
  // team a favour for a single fixture does not owe that team a fine, and the
  // escalation counter keys on member×team — a team they are not even on.
  //
  // ⚠ `activity_id` is POLYMORPHIC (a varchar whose meaning depends on
  // activity_type) and the training/game id spaces overlap almost completely,
  // both sequences starting at 1. Every correlation below carries atype WITH
  // aid — the exact mistake the 2026-08-08 audit found in the sibling
  // tentative sweep, where training 137's deadline declined a maybe on GAME 137.
  const DEADLINE_SWEEP_LOOKBACK_DAYS = 3

  /** SQL mirror of getDeadlineDate() (src/utils/dateHelpers.ts): a respond_by
   *  whose Europe/Zurich wall time is exactly 00:00:00 is the "no time given"
   *  SENTINEL, not a midnight deadline — it resolves to the activity's own
   *  start time, else 23:59. Comparing the raw column would fire the sweep up
   *  to a full day EARLY on every row carrying the sentinel, declining and
   *  fining people whose deadline had not arrived yet. */
  function effectiveDeadlineSql(col, startCol) {
    return `(CASE
        WHEN (${col} AT TIME ZONE 'Europe/Zurich')::time = '00:00:00'
        THEN (((${col} AT TIME ZONE 'Europe/Zurich')::date
               + COALESCE(${startCol}, '23:59'::time)) AT TIME ZONE 'Europe/Zurich')
        ELSE ${col}
      END)`
  }

  /**
   * Cancel trainings whose sign-up deadline has passed without reaching
   * `min_participants`.
   *
   * ⚠ `p.is_staff = false` is load-bearing: `min_participants` counts PLAYERS.
   * The frontend has always agreed (`countConfirmedPlayers` in
   * src/utils/participationWarnings.ts drops staff rows), but this query
   * counted every confirmed row, so a coach's RSVP could hold a training open
   * that the UI was already warning would be cancelled. Harmless while staff
   * rarely had a row at all; from 2026-08-15 auto-confirm creates one for every
   * coach on every training, which would have quietly raised the effective
   * threshold on every auto-cancel team.
   *
   * ⚠⚠ The deadline bound is the INSTANT, not its calendar day. Until
   * 2026-09-06 this read `respond_by::date <= CURRENT_DATE`, so the 07:00 UTC
   * run cancelled a training up to a full day BEFORE its deadline expired —
   * killing sessions that still had every chance of filling, and killing them
   * on the strength of a headcount taken before the people it was counting
   * were done answering. Same sentinel handling as everywhere else
   * (`effectiveDeadlineSql`), and it is why this now needs its own schedule:
   * an honest bound on a once-daily cron would only cancel the morning AFTER
   * the deadline, which for a team on `training_respond_by_days = 0` is after
   * the training has already happened.
   *
   * ⚠ `date >= CURRENT_DATE` is new and was missing entirely — without a floor
   * the sweep reached the whole back-catalogue and could rewrite historical
   * attendance, the same shape the 2026-08-08 audit fixed in the tentative
   * sweep. (Nothing to repair: prod holds no past uncancelled under-min
   * training, checked before shipping.)
   */
  async function autoCancelTrainingsUnderMin() {
    return database.raw(`
      UPDATE trainings SET cancelled = true, cancel_reason = 'auto_cancel_min_not_met'
      WHERE auto_cancel_on_min = true
        AND cancelled = false
        AND respond_by IS NOT NULL
        AND date >= CURRENT_DATE
        AND min_participants > 0
        AND (
          SELECT COUNT(*) FROM participations p
          WHERE p.activity_type = 'training' AND p.activity_id = trainings.id::text
            AND p.status = 'confirmed' AND p.is_staff = false
        ) < min_participants
        AND ${effectiveDeadlineSql('respond_by', 'start_time')} < now()
    `)
  }

  /**
   * Decline one activity kind's non-responders and report exactly who was
   * declined. The INSERT lives in a data-modifying CTE alongside the candidate
   * SELECT, so the rows handed back are the rows whose insert actually landed —
   * a member who acquired a participation row between the two halves of a
   * SELECT-then-INSERT can never be fined for silence they didn't keep.
   *
   * @param {'training'|'game'} kind
   */
  async function declineNoResponders(kind) {
    const isTraining = kind === 'training'
    const table = isTraining ? 'trainings' : 'games'
    const teamCol = isTraining ? 'a.team' : 'a.kscw_team'
    // `games` names its clock column "time" (reserved word, hence quoted);
    // `trainings` calls the same thing start_time.
    const startCol = isTraining ? 'a.start_time' : 'a."time"'
    const liveClause = isTraining
      ? 'a.cancelled = false'
      : `COALESCE(a.status, '') NOT IN ('completed', 'postponed', 'cancelled')`
    // Trainings let guests answer unless the training excluded their level;
    // games never do (trg_participations_guest_block hard-blocks a guest's
    // confirm), which is why the deadline reminder drops them there too — and
    // a member who cannot answer must never be fined for not answering.
    const guestClause = isTraining
      ? `AND NOT (COALESCE(a.excluded_guest_levels, '[]')::jsonb @> to_jsonb(mt.guest_level))`
      : 'AND mt.guest_level = 0'
    const deadline = effectiveDeadlineSql('a.respond_by', startCol)

    const res = await database.raw(`
      WITH cand AS (
        SELECT '${kind}'::text                      AS atype,
               a.id::text                           AS aid,
               ${teamCol}                           AS team_id,
               to_char(a.date, 'YYYY-MM-DD')        AS adate_iso,
               to_char(a.date, 'DD.MM.YYYY')        AS adate_label,
               COALESCE(tm.name, '')                AS team_name,
               mt.member                            AS member
        FROM ${table} a
        JOIN LATERAL ${teamPeopleSql(teamCol)} mt ON true
        JOIN fine_rules fr
          ON fr.team = ${teamCol}
         AND fr.category = 'late_signin'
         AND fr.enabled = true
        LEFT JOIN teams tm ON tm.id = ${teamCol}
        WHERE ${teamCol} IS NOT NULL
          AND ${liveClause}
          AND a.respond_by IS NOT NULL
          AND a.date IS NOT NULL
          AND ${deadline} < now()
          AND ${deadline} >= now() - (?::integer * interval '1 day')
          AND a.date >= CURRENT_DATE
          AND mt.is_staff = false
          ${guestClause}
          AND NOT EXISTS (
            SELECT 1 FROM participations p
            WHERE p.activity_type = '${kind}'
              AND p.activity_id = a.id::text
              AND p.member = mt.member
          )
      ), ins AS (
        INSERT INTO participations
          (member, activity_type, activity_id, status, note, guest_count, is_staff, auto_declined_deadline)
        SELECT member, atype, aid, 'declined', '', 0, false, true FROM cand
        RETURNING member, activity_type, activity_id
      )
      SELECT c.atype, c.aid, c.team_id, c.adate_iso, c.adate_label, c.team_name, c.member
      FROM cand c
      JOIN ins i
        ON i.member = c.member
       AND i.activity_type = c.atype
       AND i.activity_id = c.aid
    `, [DEADLINE_SWEEP_LOOKBACK_DAYS])
    return res?.rows || []
  }

  /**
   * The sweep proper: decline every non-responder past their deadline, issue
   * the fine, tell them once.
   *
   * The fine goes through ItemsService rather than a raw insert precisely so
   * `filter('fines.items.create')` runs it through kscw_compute_fine_amount —
   * the escalation tier is the whole point, and a raw insert would have to
   * re-derive it. `auto_issued: true` survives because there is no
   * accountability.user here; the same filter forces it false for every human
   * caller, so the flag cannot be forged from the API.
   *
   * One push per member, not two: `action('fines.items.create')` skips its own
   * push for auto-issued rows and leaves the bell entry, so the member gets a
   * single notification that names both the decline and the money.
   */
  async function sweepDeadlineNoResponses() {
    const declined = [
      ...(await declineNoResponders('training')),
      ...(await declineNoResponders('game')),
    ]
    if (declined.length === 0) return { declined: 0, fined: 0 }

    const schema = await getSchema()
    const { ItemsService } = services
    const finesService = new ItemsService('fines', { schema, knex: database })

    let fined = 0
    for (const row of declined) {
      let amountStr = null
      try {
        const fineId = await finesService.createOne({
          member: Number(row.member),
          team: Number(row.team_id),
          category: 'late_signin',
          activity_type: row.atype,
          activity_id: Number(row.aid),
          activity_date: row.adate_iso,
          auto_issued: true,
        })
        const fine = await database('fines').where('id', fineId).first('amount', 'currency')
        if (fine) amountStr = formatChf(fine.amount, fine.currency)
        fined += 1
      } catch (err) {
        // A rule that is enabled but has no tiers configured throws
        // FINE_NO_RULE — the team asked for the deadline to bite but never
        // priced it. The decline still stands (the roster is honest either
        // way); only the charge is skipped. Same for the unique-index backstop
        // if this ever runs twice against one activity.
        log.warn({
          msg: `[deadline-sweep] no fine for member ${row.member} on ${row.atype} ${row.aid}: ${err.message}`,
          event: 'deadline_sweep_fine_skipped',
        })
      }

      try {
        const titleKey = row.atype === 'training' ? 'autoDeclinedTraining' : 'autoDeclinedGame'
        const bodyKey = amountStr ? 'autoDeclinedFined.body' : 'autoDeclined.body'
        const vars = { date: row.adate_label, team: row.team_name, amount: amountStr || '' }

        await database('notifications').insert({
          member: row.member,
          type: 'auto_declined_deadline',
          title: amountStr ? 'auto_declined_deadline_fined' : 'auto_declined_deadline',
          body: JSON.stringify(vars),
          activity_type: row.atype,
          activity_id: String(row.aid),
          team: row.team_id,
          read: false,
        })

        await sendLocalizedPush(
          database, [row.member],
          (ids, title, body) => sendPushToMembers(
            database, ids, title, body,
            `${FRONTEND_URL}/${row.atype}s/${row.aid}`,
            `deadline-decline-${row.atype}-${row.aid}`,
            log,
          ),
          `${titleKey}.title`, bodyKey, vars,
        )
      } catch (err) {
        // Never let a notification failure strand the sweep — the decline and
        // the fine are already committed, and the member still sees both in
        // the app.
        log.warn({
          msg: `[deadline-sweep] notify failed for member ${row.member}: ${err.message}`,
          event: 'deadline_sweep_notify_failed',
        })
      }
    }
    return { declined: declined.length, fined }
  }

  // ── Cron: Auto-cancel under-min trainings (every 30 min, :02/:32) ──
  //
  // Its own schedule because the bound is now the deadline INSTANT and the
  // daily 07:00 run is far too coarse for it: a deadline at 20:00 would not be
  // acted on until 07:00 the next morning, and a team on
  // `training_respond_by_days = 0` (a real setting — "respond before it
  // starts") would have its training cancelled after it had already been
  // played. Half-hourly means the cancellation lands within 30 minutes of the
  // deadline, which is when the answer is actually known.
  //
  // ⚠ Offset to :02/:32 rather than :00/:30 so it never races the 07:00
  // participation cron, which calls the same helper first precisely so a
  // training about to be cancelled cannot first decline and fine its
  // non-responders.
  schedule('2,32 * * * *', async () => {
    try {
      const res = await autoCancelTrainingsUnderMin()
      if (res?.rowCount > 0) log.info(`Auto-cancel under-min: ${res.rowCount} training(s) cancelled`)
    } catch (err) {
      log.error({ msg: `Auto-cancel under-min: ${err.message}`, event: 'cron.auto_cancel_under_min', stack: err.stack })
      logCronError('auto_cancel_under_min', err)
    }
  })

  // ── 6. Cron: Participation Reminders (07:00 UTC) ───────────────
  // Creates in-app notifications for unresponded members when deadline is tomorrow.
  // Uses batch INSERT...SELECT — no per-member loop.

  schedule('0 7 * * *', async () => {
    try {
      const tomorrow = new Date()
      tomorrow.setDate(tomorrow.getDate() + 1)
      const tomorrowStr = tomorrow.toISOString().split('T')[0]

      // Games with respond_by = tomorrow. Skip cancelled/postponed/completed
      // games (mirror the upcoming-games query) and guests — guests are hard-
      // blocked from game RSVPs (trg_participations_guest_block), so a reminder
      // they can't answer is just noise. COALESCE so NULL status/guest_level
      // rows aren't dropped.
      const gamesInserted = await database.raw(`
        INSERT INTO notifications (member, type, title, body, activity_type, activity_id, team, read)
        SELECT mt.member, 'deadline_reminder',
               'RSVP: ' || COALESCE(g.home_team, '') || ' vs ' || COALESCE(g.away_team, ''),
               COALESCE(g.date::text, ''),
               'game', g.id::text, g.kscw_team, false
        FROM games g
        ${GAME_SQUAD_JOIN}
        WHERE g.respond_by::date = ?::date
          AND g.kscw_team IS NOT NULL
          AND COALESCE(g.status, '') NOT IN ('completed', 'postponed', 'cancelled')
          AND COALESCE(mt.guest_level, 0) = 0
          AND NOT EXISTS (
            SELECT 1 FROM participations p
            WHERE p.activity_type = 'game' AND p.activity_id = g.id::text AND p.member = mt.member
          )
      `, [tomorrowStr])

      // Trainings with respond_by = tomorrow
      const trainingsInserted = await database.raw(`
        INSERT INTO notifications (member, type, title, body, activity_type, activity_id, team, read)
        SELECT mt.member, 'deadline_reminder',
               'deadline_training',
               json_build_object(
                 'date', COALESCE(to_char(t.date, 'DD.MM.YYYY'), ''),
                 'hall', COALESCE(h.name, '')
               )::text,
               'training', t.id::text, t.team, false
        FROM trainings t
        JOIN LATERAL ${teamPeopleSql('t.team')} mt ON true
        LEFT JOIN halls h ON h.id = t.hall
        WHERE t.respond_by::date = ?::date
          AND t.team IS NOT NULL
          AND t.cancelled = false
          AND NOT (COALESCE(t.excluded_guest_levels, '[]')::jsonb @> to_jsonb(mt.guest_level))
          AND NOT EXISTS (
            SELECT 1 FROM participations p
            WHERE p.activity_type = 'training' AND p.activity_id = t.id::text AND p.member = mt.member
          )
      `, [tomorrowStr])

      // Auto-cancel trainings past deadline with insufficient participation.
      // Runs here as well as on its own half-hourly schedule so it is
      // GUARANTEED to have settled before the two sweeps below: a training that
      // is about to be auto-cancelled must not first decline and fine its
      // non-responders. Idempotent (`cancelled = false` guard), so the double
      // call costs one no-op UPDATE.
      const autoCancelled = await autoCancelTrainingsUnderMin()

      // Auto-decline tentatives past deadline (per-team feature)
      //
      // ⚠ `participations.activity_id` is POLYMORPHIC — its meaning depends on
      // `activity_type`, and the two id spaces overlap almost completely because
      // both sequences START WITH 1. Until 2026-08-10 this UNION collapsed them
      // and correlated on `aid` ALONE (audit 2026-08-08, finding 13), so
      // training 137 being past its deadline declined member 42's "maybe" on
      // GAME 137 — a different team's activity entirely. Worse, the
      // `features_enabled` flag was read from whichever row happened to collide,
      // so one team enabling `auto_decline_tentative` silently applied it
      // club-wide, and team A's setting decided team B's RSVPs.
      //
      // `atype` now travels with each branch and is correlated, which is what
      // the table's own identity index (activity_type, activity_id, member)
      // implies and what every sibling query in this same cron block already did.
      //
      // The date bound is the second half of the fix: with no lower bound the
      // sweep reached the entire back-catalogue and rewrote historical
      // attendance. `trg_participations_clear_auto_marker` strips the marker
      // afterwards, so a bogus flip is indistinguishable from a real one — there
      // is no repair path, only prevention.
      //
      // ⚠⚠ The bound is the deadline INSTANT, not its calendar day. Until
      // 2026-09-06 this read `a.respond_by::date <= CURRENT_DATE`, which is
      // true from midnight of the deadline day onward — so a 07:00 UTC run
      // flipped a member's "maybe" to "declined" up to a full day BEFORE their
      // deadline expired. A team with respond_by at the activity's own start
      // time (what migration 322 derives, e.g. 20:00) lost the entire day it
      // had been promised to make up its mind, and the member had no way to
      // tell: `trg_participations_clear_auto_marker` leaves no marker on this
      // path, so an early flip is indistinguishable from a real one. 5 teams
      // had the feature on when this was found.
      //
      // `effectiveDeadlineSql` is the same getDeadlineDate() mirror the
      // no-response sweep uses, and it is needed here for the same reason: a
      // Europe/Zurich wall time of exactly 00:00:00 is the "no time given"
      // SENTINEL, which resolves to the activity's own start time (else 23:59),
      // NOT to midnight. Hence `astart` carried through both UNION branches —
      // trainings call it start_time, games call it "time".
      await database.raw(`
        UPDATE participations SET status = 'declined'
        WHERE status = 'tentative'
          AND activity_type IN ('game', 'training')
          AND EXISTS (
            SELECT 1 FROM (
              SELECT 'training' AS atype, id::text AS aid, respond_by, start_time AS astart, date AS adate, team AS team_id
                FROM trainings WHERE respond_by IS NOT NULL
              UNION ALL
              SELECT 'game' AS atype, id::text AS aid, respond_by, "time" AS astart, date AS adate, kscw_team AS team_id
                FROM games WHERE respond_by IS NOT NULL
            ) a
            JOIN teams t ON t.id = a.team_id
            WHERE a.atype = participations.activity_type
              AND a.aid = participations.activity_id
              AND ${effectiveDeadlineSql('a.respond_by', 'a.astart')} < now()
              AND a.adate >= CURRENT_DATE
              AND (t.features_enabled->>'auto_decline_tentative')::boolean = true
          )
      `)

      // Non-responders past their deadline (migration 352). Runs AFTER the
      // tentative sweep on purpose: a `tentative` that just became `declined`
      // already has a row, so it is not a non-responder and must not be fined
      // for a maybe it did give.
      let noResponse = { declined: 0, fined: 0 }
      try {
        noResponse = await sweepDeadlineNoResponses()
      } catch (sweepErr) {
        log.error({ msg: `Deadline no-response sweep: ${sweepErr.message}`, event: 'cron.deadline_no_response_sweep', stack: sweepErr.stack })
        logCronError('deadline_no_response_sweep', sweepErr)
      }

      log.info(`Participation reminders: games=${gamesInserted?.rowCount || 0}, trainings=${trainingsInserted?.rowCount || 0}, auto-cancelled=${autoCancelled?.rowCount || 0}, no-response-declined=${noResponse.declined}, auto-fined=${noResponse.fined}`)

      // Send push notifications for deadline reminders
      try {
        const deadlineMembers = await database('notifications')
          .where('type', 'deadline_reminder')
          .where('read', false)
          .whereRaw("date_created::date = CURRENT_DATE")
          .distinct('member')
          .pluck('member')
        if (deadlineMembers.length > 0) {
          await sendLocalizedPush(
            database, deadlineMembers,
            (ids, title, body) => sendPushToMembers(database, ids, title, body, FRONTEND_URL, 'deadline_reminder', log),
            'deadline.title', 'deadline.body',
          )
        }
      } catch (pushErr) {
        log.warn({ msg: `Deadline push: ${pushErr.message}`, event: 'cron.deadline_push', stack: pushErr.stack })
        logCronError('deadline_push', pushErr)
      }
    } catch (err) {
      log.error({ msg: `Participation reminders: ${err.message}`, event: 'cron.participation_reminders', stack: err.stack })
      logCronError('participation_reminders', err)
    }
  })

  // ── 7. Cron: Daily Notification Reminders (06:30 UTC) ──────────
  // Upcoming activity notifications for tomorrow's games/trainings/events

  schedule('30 6 * * *', async () => {
    try {
      const tomorrow = new Date()
      tomorrow.setDate(tomorrow.getDate() + 1)
      const tomorrowStr = tomorrow.toISOString().split('T')[0]

      // Games tomorrow
      await database.raw(`
        INSERT INTO notifications (member, type, title, body, activity_type, activity_id, team, read)
        SELECT mt.member, 'upcoming_activity',
               'upcoming_game',
               json_build_object(
                 'home_team', COALESCE(g.home_team, ''),
                 'away_team', COALESCE(g.away_team, ''),
                 'date', COALESCE(to_char(g.date, 'DD.MM.YYYY'), ''),
                 'time', COALESCE(to_char(g.time, 'HH24:MI'), ''),
                 'hall', COALESCE(h.name, '')
               )::text,
               'game', g.id::text, g.kscw_team, false
        FROM games g
        ${GAME_SQUAD_JOIN}
        LEFT JOIN halls h ON h.id = g.hall
        WHERE g.date = ?::date AND g.kscw_team IS NOT NULL
          AND COALESCE(g.status, '') NOT IN ('completed', 'postponed', 'cancelled')
      `, [tomorrowStr])

      // Trainings tomorrow
      await database.raw(`
        INSERT INTO notifications (member, type, title, body, activity_type, activity_id, team, read)
        SELECT mt.member, 'upcoming_activity',
               'upcoming_training',
               json_build_object(
                 'date', COALESCE(to_char(t.date, 'DD.MM.YYYY'), ''),
                 'time', COALESCE(to_char(t.start_time, 'HH24:MI'), ''),
                 'hall', COALESCE(h.name, '')
               )::text,
               'training', t.id::text, t.team, false
        FROM trainings t
        JOIN LATERAL ${teamPeopleSql('t.team')} mt ON true
        LEFT JOIN halls h ON h.id = t.hall
        WHERE t.date = ?::date AND t.team IS NOT NULL AND t.cancelled = false
      `, [tomorrowStr])

      // Events tomorrow — events.start_date is timestamptz, so localize to
      // Zurich for both the displayed date/time and the day filter (UTC would
      // show 17:00 for a 19:00 Zurich game and bucket a 00:00–02:00 Zurich
      // event onto the wrong calendar day).
      await database.raw(`
        INSERT INTO notifications (member, type, title, body, activity_type, activity_id, team, read)
        SELECT DISTINCT mt.member, 'upcoming_activity',
               'upcoming_event',
               json_build_object(
                 'title', COALESCE(e.title, 'Event'),
                 'date', COALESCE(to_char(e.start_date AT TIME ZONE 'Europe/Zurich', 'DD.MM.YYYY'), ''),
                 'time', COALESCE(to_char(e.start_date AT TIME ZONE 'Europe/Zurich', 'HH24:MI'), ''),
                 'location', COALESCE(NULLIF(h.name, ''), e.location, '')
               )::text,
               'event', e.id::text, et.teams_id, false
        FROM events e
        JOIN events_teams et ON et.events_id = e.id
        JOIN member_teams mt ON mt.team = et.teams_id
        LEFT JOIN halls h ON h.id = e.hall
        WHERE (e.start_date AT TIME ZONE 'Europe/Zurich')::date = ?::date
          -- Migration 324: don't remind a guest about an event they were not
          -- invited to. Per member (a core row on any other invited team of the
          -- same event keeps them in), which the DISTINCT above already folds.
          AND (e.invite_guests IS NOT FALSE OR COALESCE(mt.guest_level, 0) = 0)
      `, [tomorrowStr])

      log.info('Daily notification reminders sent')

      // Send push notifications for upcoming activities
      try {
        const upcomingMembers = await database('notifications')
          .where('type', 'upcoming_activity')
          .where('read', false)
          .whereRaw("date_created::date = CURRENT_DATE")
          .distinct('member')
          .pluck('member')
        if (upcomingMembers.length > 0) {
          await sendLocalizedPush(
            database, upcomingMembers,
            (ids, title, body) => sendPushToMembers(database, ids, title, body, FRONTEND_URL, 'upcoming_activity', log),
            'tomorrow.title', 'tomorrow.body',
          )
        }
      } catch (pushErr) {
        log.warn({ msg: `Upcoming push: ${pushErr.message}`, event: 'cron.upcoming_push', stack: pushErr.stack })
        logCronError('upcoming_push', pushErr)
      }
    } catch (err) {
      log.error({ msg: `Daily reminders: ${err.message}`, event: 'cron.daily_reminders', stack: err.stack })
      logCronError('daily_reminders', err)
    }
  })

  // ── 8. Cron: Shell Reminder (09:00 UTC) ────────────────────────
  // Email shell members 10 days before expiry

  schedule('0 9 * * *', async () => {
    try {
      const reminderDate = new Date()
      reminderDate.setDate(reminderDate.getDate() + 10)
      const reminderStr = reminderDate.toISOString().split('T')[0]

      const expiring = await database('members')
        .where('shell', true)
        .where('kscw_membership_active', true)
        .where('shell_reminder_sent', false)
        .whereNotNull('shell_expires')
        .whereRaw("shell_expires::date <= ?::date", [reminderStr])
        .select('id', 'email', 'first_name', 'shell_expires', 'user')

      if (expiring.length === 0) return

      const schema = await getSchema()
      const { MailService } = services
      const mailService = new MailService({ schema, knex: database })

      for (const m of expiring) {
        if (!m.email || m.email.includes('@placeholder')) continue
        try {
          // Account-less shells (registration-born or unclaimed invites) get a
          // fresh member-bound signup link — the reminder used to dead-end
          // with no link at all.
          let linkLine = ''
          if (!m.user) {
            try {
              const { token } = await mintSignupToken(database, m.id, { mintedVia: 'reminder' })
              linkLine = `\n\nDu hast noch kein Konto? Erstelle es hier (Link 30 Tage gültig):\n${signupInviteUrl(token)}`
            } catch { /* best-effort — reminder still goes out without a link */ }
          }
          await mailService.send({
            to: m.email,
            subject: 'WiediSync — Dein Gastkonto läuft bald ab',
            text: `Hallo ${m.first_name || ''},\n\nDein WiediSync-Gastkonto läuft am ${m.shell_expires} ab.\nMelde dich bei deinem Coach, um es zu verlängern.${linkLine}\n\nKSC Wiedikon`,
          })
          await database('members').where('id', m.id).update({ shell_reminder_sent: true })
        } catch (mailErr) {
          log.warn({ msg: `Shell reminder mail failed for member ${m.id}`, event: 'cron.shell_reminder', memberId: m.id, stack: mailErr.stack })
          logCronError('shell_reminder_mail', mailErr, { memberId: m.id })
        }
      }
      log.info(`Shell reminder: ${expiring.length} members notified`)
    } catch (err) {
      log.error({ msg: `Shell reminder: ${err.message}`, event: 'cron.shell_reminder', stack: err.stack })
      logCronError('shell_reminder', err)
    }
  })

  // ── 9. Cron: Swiss Volley Sync (06:00 UTC) ────────────────────
  // Calls the existing SV sync endpoint via internal HTTP

  schedule('0 6 * * *', async () => {
    const startedAt = Date.now()
    try {
      const token = await getCronAccessToken(log, 'SV sync')
      if (!token) return
      const res = await fetch('http://localhost:8055/kscw/admin/sv-sync', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = await res.text()
      if (!res.ok) throw new Error(`${res.status} ${body}`)
      log.info(`SV sync cron: ${body}`)
      await logCronRun(database, 'sv_sync', { status: 'ok', durationMs: Date.now() - startedAt })
    } catch (err) {
      log.error({ msg: `SV sync cron: ${err.message}`, event: 'cron.sv_sync', stack: err.stack })
      logCronError('sv_sync', err)
      await logCronRun(database, 'sv_sync', { status: 'error', durationMs: Date.now() - startedAt, errorMessage: err.message })
    }
  })

  // ── 9b. Cron: stage ClubDesk value conflicts after a cron sync-down ──────────
  // Migration 338 made a value disagreement a DECISION (a `conflict` proposal)
  // instead of a row on a board that could not remember an answer. Staging runs
  // in kscw-endpoints off computeClubdeskDrift() — the same JS comparison that
  // renders the finding, and the only correct one — and the Data Health page
  // calls it after every sync-down a human triggers.
  //
  // The WEEKLY sync-down (Sat 22:00 UTC) has no browser to make that call, and a
  // host-run sync has none either. Their conflicts would wait for somebody to
  // happen to press "Sync down" in the app — silent, and in the worse direction:
  // an empty decision queue reads as "nothing to decide".
  //
  // ⚠ Watermark, not a timer. It fires on down_last_success_at moving past
  // conflicts_staged_at (migration 339), so it covers the weekly cron, a hand-run
  // host sync and a dispatcher retry without assuming when any of them happen —
  // and it does NOT re-do a staging the UI already did seconds earlier.
  // ⚠ down_last_SUCCESS_at, never down_finished_at: the latter is stamped on
  // failure too, and staging drift against a half-loaded clubdesk_export is how
  // you propose that every member's data disagrees.
  // ⚠ Calls the ROUTE rather than importing the function: staging is a closure
  // over `database` inside registerClubdeskUpdate, and the route carries the
  // gate, the watermark and the audit row with it. Same shape as the SV/BP sync
  // crons above.
  schedule('*/15 * * * *', async () => {
    const startedAt = Date.now()
    try {
      const row = await database('clubdesk_member_sync').where('id', 1)
        .first('down_last_success_at', 'conflicts_staged_at')
      if (!row?.down_last_success_at) return
      const synced = new Date(row.down_last_success_at).getTime()
      const watermark = row.conflicts_staged_at ? new Date(row.conflicts_staged_at).getTime() : 0
      if (watermark >= synced) return

      const token = await getCronAccessToken(log, 'ClubDesk conflict staging')
      if (!token) return
      const res = await fetch('http://localhost:8055/kscw/clubdesk-sync/proposals/detect', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = await res.text()
      if (!res.ok) throw new Error(`${res.status} ${body.slice(0, 200)}`)
      // ⚠ A capped run answers 200 with staged:0. Logged at warn, because the
      // count it refused is a data fault worth chasing (a stale or half-loaded
      // clubdesk_export), and at info level it would read as a quiet no-op.
      let staged = 0
      try {
        const parsed = JSON.parse(body)
        staged = Number(parsed?.staged) || 0
        if (parsed?.capped) {
          log.warn(`ClubDesk conflict staging: ${parsed.considered} conflicts exceed the cap of ${parsed.cap} — staged none`)
        }
      } catch { /* body already logged below */ }
      log.info(`ClubDesk conflict staging: ${body}`)
      await logCronRun(database, 'clubdesk_conflict_staging', { status: 'ok', rowsChanged: staged, durationMs: Date.now() - startedAt })
    } catch (err) {
      log.error({ msg: `ClubDesk conflict staging: ${err.message}`, event: 'cron.clubdesk_conflict_staging', stack: err.stack })
      logCronError('clubdesk_conflict_staging', err)
      await logCronRun(database, 'clubdesk_conflict_staging', { status: 'error', durationMs: Date.now() - startedAt, errorMessage: err.message })
    }
  })

  // ── 10. Cron: Basketplan Sync (06:05 UTC) ─────────────────────
  // Calls the existing BP sync endpoint via internal HTTP

  schedule('5 6 * * *', async () => {
    const startedAt = Date.now()
    try {
      const token = await getCronAccessToken(log, 'BP sync')
      if (!token) return
      const res = await fetch('http://localhost:8055/kscw/admin/bp-sync', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = await res.text()
      if (!res.ok) throw new Error(`${res.status} ${body}`)
      log.info(`BP sync cron: ${body}`)
      await logCronRun(database, 'bp_sync', { status: 'ok', durationMs: Date.now() - startedAt })
    } catch (err) {
      log.error({ msg: `BP sync cron: ${err.message}`, event: 'cron.bp_sync', stack: err.stack })
      logCronError('bp_sync', err)
      await logCronRun(database, 'bp_sync', { status: 'error', durationMs: Date.now() - startedAt, errorMessage: err.message })
    }
  })

  // ── 10b. Cron: Volleymanager Sync (weekly, Mondays 04:00 UTC) ──
  // Runs vm-sync-check.mjs: team metadata → `teams`, players/writers/referees
  // → `sv_vm_check` + members licence flags. Weekly (was monthly) so team
  // name/league corrections — heaviest around season rollover — propagate fast.
  // Shared runner so both the weekly cron and the failure-watchdog (below) use
  // the same spawn/log path. In-memory lock prevents overlapping runs (the
  // watchdog could otherwise fire while a run is still in flight).
  // How many consecutive soft defers are still credibly "VM is having a bad
  // window". Past this the watchdog stops retrying (below) — and, since
  // 2026-08-13, the run also stops calling itself `ok`: an upstream problem
  // that has outlived six retries is a real, reportable failure, and recording
  // it green is how a permanently-denied sync stayed invisible for a week.
  const DEFER_RETRY_CAP = 6
  let vmSyncRunning = false
  // ── Shared Volleymanager account lock ──────────────────────────────────────
  // vm-sync-check.mjs and svrz-scheduling-sync.mjs both log into the ONE
  // Volleymanager account the club owns, and VM's ACTIVE ROLE is per-ACCOUNT and
  // persists — svrz-scheduling-sync flips it to Spielplaner for its whole run.
  // Two of them overlapping means one scrapes under the other's role, which VM
  // answers with 403s / empty groups rather than an error (exactly the failure
  // the "check the ACTIVE VM ROLE" hint further down was written for).
  //
  // They genuinely collide: the watchdog below ticks at :00/:30, so a
  // watchdog-retry fires on the same minute the 04:30 SVRZ cron starts, and a
  // VM sync may run for up to 10 min (SVRZ up to 15).
  //
  // Both runs are AWAITED children with SIGKILL timeouts, so this in-process
  // holder covers a run's whole lifetime and cannot outlive a crash — a lost
  // worker takes the container with it and a restart clears the flag.
  // ⚠ Process-local: it would not survive multi-instance scaling, and it is
  // invisible to the on-demand POST /admin/svrz-sync, which lives in the
  // separate kscw-endpoints module with its own memory.
  // ⚠ Shared with kscw-endpoints/src/vm-account-lock.js via globalThis — the two
  // extension bundles cannot import from one another but run in the SAME Directus
  // process, and `vmAccountHolder` being module-local is exactly why an admin
  // pressing "Sync now" could collide with these crons on the one shared
  // Volleymanager account (where the active role persists per ACCOUNT). Keep the
  // key and the record shape identical to that file. Leased, so a lost run frees it.
  const VM_ACCOUNT_KEY = '__kscw_vm_account_holder'
  const VM_LEASE_MS = 20 * 60 * 1000
  const vmAccountHeldBy = () => {
    const held = globalThis[VM_ACCOUNT_KEY]
    if (!held) return null
    return Date.now() - held.at < VM_LEASE_MS ? held.who : null
  }
  const claimVmAccount = (who) => {
    if (vmAccountHeldBy()) return null
    const token = `${who}:${Date.now()}:${Math.round(Math.random() * 1e9)}`
    globalThis[VM_ACCOUNT_KEY] = { who, at: Date.now(), token }
    let released = false
    return () => {
      if (released) return
      released = true
      if (globalThis[VM_ACCOUNT_KEY]?.token === token) globalThis[VM_ACCOUNT_KEY] = null
    }
  }
  async function runVmSync(reason) {
    if (!process.env.VM_USERNAME || !process.env.VM_PASSWORD) {
      log.warn('VM sync skipped: VM_USERNAME or VM_PASSWORD not set')
      return
    }
    if (vmSyncRunning) {
      log.info(`VM sync (${reason}) skipped: a run is already in progress`)
      return
    }
    const releaseVmAccount = claimVmAccount('vm_sync')
    if (!releaseVmAccount) {
      // Deliberate skip, not a failure — do not record a cron error for it.
      // The weekly run or the next watchdog tick picks it up.
      log.warn(`VM sync (${reason}) skipped: the shared Volleymanager account is busy (${vmAccountHeldBy()})`)
      return
    }
    vmSyncRunning = true
    const startedAt = Date.now()
    try {
      const token = await getCronAccessToken(log, 'VM sync')
      if (!token) return
      const { spawn } = await import('node:child_process')
      const env = {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        VM_USERNAME: process.env.VM_USERNAME,
        VM_PASSWORD: process.env.VM_PASSWORD,
        DIRECTUS_URL: 'http://127.0.0.1:8055',
        DIRECTUS_TOKEN: token,
      }
      const result = await new Promise((resolve, reject) => {
        const child = spawn('node', ['/directus/scripts/vm-sync-check.mjs'], { env })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
        child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(Object.assign(new Error('VM sync timed out after 10 min'), { status: null }))
        }, 600_000)
        child.on('close', (code) => {
          clearTimeout(timer)
          // 0 = full sync, 75 = soft defer (transient VM unavailability), other =
          // hard failure. Resolve 0/75 so only real failures reach the catch
          // (which alerts); reject everything else.
          if (code === 0 || code === 75) resolve({ code, stdout })
          else reject(Object.assign(new Error(`VM sync exited ${code}: ${stderr.slice(-500)}`), { status: code }))
        })
        child.on('error', (err) => { clearTimeout(timer); reject(err) })
      })
      if (result.code === 75) {
        // Transient VM unavailability — a group was deferred. sync_runs.status is
        // constrained to ok|error, so record status `ok` (no alert) and carry the
        // defer signal + attempt counter in error_message. The watchdog reads the
        // counter to retry a few times, then backs off; a later full success
        // clears error_message → the watchdog goes quiet.
        const prior = await database('sync_runs').where({ source: 'vm_sync' }).first().catch(() => null)
        const priorN = prior ? parseInt(String(prior.error_message || '').match(/deferred \(attempt (\d+)\)/)?.[1] || '0', 10) : 0
        const attempt = priorN + 1
        // Past the cap, "transient" is no longer a defensible reading. Record
        // `error` so it alerts and shows red, and mark it `exhausted` so the
        // watchdog does NOT start retrying it every 30 min through the `error`
        // branch — visibility and retry cadence are separate decisions, and
        // hammering volleyball.ch was the reason for the backoff in the first
        // place. The next weekly run is the retry; a success clears the message.
        const exhausted = attempt >= DEFER_RETRY_CAP
        const detail = `deferred (attempt ${attempt}): VM temporarily unavailable`
        log.info(`VM sync cron (${reason}): deferred attempt ${attempt}${exhausted ? ' — RETRIES EXHAUSTED, reporting as error' : ''} — ${result.stdout.split('\n').slice(-4).join(' | ')}`)
        if (exhausted) {
          const msg = `${detail} — retries exhausted after ${attempt} attempts. `
            + 'If every group 403s, check the ACTIVE VM ROLE before assuming an outage: the account is '
            + 'shared with svrz_rc and the role is per-account, not per-session.'
          logCronError('vm_sync', new Error(msg))
          await logCronRun(database, 'vm_sync', { status: 'error', durationMs: Date.now() - startedAt, errorMessage: msg })
        } else {
          await logCronRun(database, 'vm_sync', { status: 'ok', durationMs: Date.now() - startedAt, errorMessage: detail })
        }
      } else {
        log.info(`VM sync cron (${reason}): ${result.stdout.split('\n').slice(-6).join(' | ')}`)
        await logCronRun(database, 'vm_sync', { status: 'ok', durationMs: Date.now() - startedAt })
      }
    } catch (err) {
      log.error({ msg: `VM sync cron (${reason}): ${err.message}`, exitCode: err.status, event: 'cron.vm_sync' })
      logCronError('vm_sync', new Error(err.message))
      await logCronRun(database, 'vm_sync', { status: 'error', durationMs: Date.now() - startedAt, errorMessage: err.message })
    } finally {
      vmSyncRunning = false
      releaseVmAccount()
    }
  }

  schedule('0 4 * * 1', () => runVmSync('weekly'))

  // ── 10b¹. Licence status sweep (migration 301) ──────────────────
  // Daily rather than weekly, for two reasons that have nothing to do with the
  // volleyball register: the 1 June season rollover has to land on 1 June, not
  // on the following Monday, and Basketplan is scraped by hand — a scrape run
  // on a Wednesday should show up on Wednesday. It is two local Postgres
  // statements, so daily costs nothing.
  //
  // 05:45 UTC: after the Monday 04:00 VM sync has refreshed sv_vm_check (a
  // licence activated in Volleymanager over the weekend is confirmed the same
  // morning) and clear of the 05:15 VIS run.
  schedule('45 5 * * *', async () => {
    const startedAt = Date.now()
    try {
      const result = await runLicenceStatusSweep(database, log, { actorName: 'Daily sweep' })
      await logCronRun(database, 'licence_status', {
        status: 'success',
        rowsChanged: result.reset + result.promoted.length,
        durationMs: Date.now() - startedAt,
      })
    } catch (err) {
      log.error({ msg: `[licence-status] daily sweep: ${err.message}`, event: 'licence_status_sweep_failed', stack: err.stack })
      logCronError('licence_status', err)
      await logCronRun(database, 'licence_status', {
        status: 'error', rowsChanged: 0, durationMs: Date.now() - startedAt, errorMessage: err.message,
      }).catch(() => {})
    }
  })

  // ── 10b². Watchdog: retry VM sync every 30 min while it's failing/deferred ──
  // VM's indoor data API intermittently 403s/stalls (2026-06-08, 2026-06-18).
  // Two retry-worthy states, both quiet once it recovers (status flips to `ok`):
  //   • `error`  — a hard failure: retry every 30 min until it succeeds.
  //   • `deferred` — a transient VM bad window (no alert): retry up to
  //     DEFER_RETRY_CAP times to catch a healthy window, then back off to the
  //     weekly run so a long outage doesn't hammer volleyball.ch all week. At
  //     the cap the run itself flips to `error` (see runVmSync) so the backoff
  //     is silent about RETRYING, not about the FAILURE.
  // Bounded: skip the <25min just-ran/in-progress window so it never races the
  // weekly run, and the 12h ceiling guards the `error` case.
  // (DEFER_RETRY_CAP is declared above runVmSync — both halves read it.)
  schedule('*/30 * * * *', async () => {
    if (!process.env.VM_USERNAME || !process.env.VM_PASSWORD) return
    try {
      const row = await database('sync_runs').where({ source: 'vm_sync' }).first()
      if (!row || !row.last_run_at) return
      const ageMin = (Date.now() - new Date(row.last_run_at).getTime()) / 60000
      if (ageMin < 25 || ageMin > 720) return
      // A soft defer is recorded as status `ok` + an error_message carrying the
      // attempt count (sync_runs.status is constrained to ok|error). A full
      // success clears error_message to null → no deferred-retry.
      const deferMatch = String(row.error_message || '').match(/deferred \(attempt (\d+)\)/)
      // An exhausted defer is recorded as `error` so it alerts — but it is
      // still the same upstream problem the backoff decided to stop retrying,
      // so it must not fall into the `error` branch's 30-min retry loop.
      if (/retries exhausted/.test(String(row.error_message || ''))) return
      if (row.status === 'error') {
        log.info(`VM sync watchdog: last run errored ~${Math.round(ageMin)}min ago — retrying`)
        await runVmSync('watchdog-retry')
      } else if (deferMatch) {
        const attempt = parseInt(deferMatch[1], 10)
        if (attempt >= DEFER_RETRY_CAP) return  // backed off — wait for the weekly run
        log.info(`VM sync watchdog: last run deferred (attempt ${attempt}) ~${Math.round(ageMin)}min ago — retrying`)
        await runVmSync('watchdog-deferred-retry')
      }
    } catch (err) {
      log.error({ msg: `VM sync watchdog: ${err.message}`, event: 'cron.vm_sync_watchdog' })
    }
  })

  // ── 10c. Cron: SVRZ scheduling sync (daily 04:30 UTC) ──
  // Calls svrz-scheduling-sync.mjs — walks SVRZ JSON API, upserts games + contacts
  schedule('30 4 * * *', async () => {
    if (!process.env.VM_USERNAME || !process.env.VM_PASSWORD) {
      log.warn('SVRZ sync skipped: VM_USERNAME or VM_PASSWORD not set')
      return
    }
    const releaseSvrzVmAccount = claimVmAccount('svrz_sync')
    if (!releaseSvrzVmAccount) {
      // Deliberate skip, not a failure: a VM sync is mid-run and would be
      // scraped out from under by this run's role switch. Do NOT record a cron
      // error here — that would paint the status card red for a healthy system.
      // Tomorrow's 04:30 tick runs normally.
      log.warn({ msg: `SVRZ sync skipped: the shared Volleymanager account is busy (${vmAccountHeldBy()})`, event: 'cron.svrz_sync_busy' })
      return
    }
    const startedAt = Date.now()
    try {
      const token = await getCronAccessToken(log, 'SVRZ sync')
      if (!token) return
      const { spawn } = await import('node:child_process')
      const now = new Date()
      const startYear = seasonStartYear(now)
      const seasonName = `${startYear}/${startYear + 1}`
      const known = await database('svrz_spielplaner_contacts')
        .where('season_name', seasonName).whereNotNull('season_uuid').first()
      const seasonUuid = known?.season_uuid || 'dcafddfe-8139-4e02-baad-d3f88ec00cd0'
      const env = {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        VM_USERNAME: process.env.VM_USERNAME,
        VM_PASSWORD: process.env.VM_PASSWORD,
        DIRECTUS_URL: 'http://127.0.0.1:8055',
        DIRECTUS_TOKEN: token,
        SVRZ_SEASON_UUID: seasonUuid,
        SVRZ_SEASON_NAME: seasonName,
      }
      // Async spawn keeps the Directus event loop responsive while the sync runs
      // (cold run ≈9 min, ~2970 serial PATCHes). execSync previously blocked
      // /server/ping long enough to trigger uptime 503 alerts.
      const output = await new Promise((resolve, reject) => {
        const child = spawn('node', ['/directus/scripts/svrz-scheduling-sync.mjs'], { env })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
        child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(Object.assign(new Error('SVRZ sync timed out after 15 min'), { status: null }))
        }, 900_000)
        child.on('error', (err) => { clearTimeout(timer); reject(err) })
        child.on('close', (code) => {
          clearTimeout(timer)
          if (code === 0) resolve(stdout)
          else reject(Object.assign(new Error(stderr.trim() || `exited ${code}`), { status: code }))
        })
      })
      log.info(`SVRZ sync cron: ${output.split('\n').slice(-6).join(' | ')}`)
      await logCronRun(database, 'svrz_sync', { status: 'ok', durationMs: Date.now() - startedAt })
    } catch (err) {
      log.error({ msg: `SVRZ sync cron: ${err.message}`, exitCode: err.status, event: 'cron.svrz_sync' })
      logCronError('svrz_sync', new Error(err.message))
      await logCronRun(database, 'svrz_sync', { status: 'error', durationMs: Date.now() - startedAt, errorMessage: err.message })
    } finally {
      releaseSvrzVmAccount()
    }
  })

  // ── 10e. Cron: Google Calendar / hall events sync (daily 04:00 UTC) ──
  // The /admin/gcal-sync endpoint was admin-trigger only, so hall_events
  // never refreshed automatically — /status orange "Hall schedule sync"
  // 41d ago was the consequence. Cron now hits the same endpoint nightly
  // with a system-context token so the venue feed stays fresh.
  schedule('0 4 * * *', async () => {
    const startedAt = Date.now()
    try {
      const token = await getCronAccessToken(log, 'GCal sync')
      if (!token) return
      const res = await fetch('http://localhost:8055/kscw/admin/gcal-sync', {
        method: 'POST',
        // Labels the club-admin change digest "Nightly sync" instead of "Manual".
        headers: { Authorization: `Bearer ${token}`, 'x-kscw-trigger': 'cron' },
      })
      const body = await res.text()
      if (!res.ok) throw new Error(`${res.status} ${body}`)
      log.info(`GCal sync cron: ${body.slice(0, 200)}`)
      await logCronRun(database, 'gcal_sync', { status: 'ok', durationMs: Date.now() - startedAt })
    } catch (err) {
      log.error({ msg: `GCal sync cron: ${err.message}`, event: 'cron.gcal_sync', stack: err.stack })
      logCronError('gcal_sync', err)
      await logCronRun(database, 'gcal_sync', { status: 'error', durationMs: Date.now() - startedAt, errorMessage: err.message })
    }
  })

  // ── 10e². Cron: Spielplanung mailbox sync (every 10 min) ──
  // Pulls the Migadu mailboxes spielplanung@volleyball.kscw.ch + spielplanung@basketball.kscw.ch
  // (INBOX + Sent each) into scheduling_emails via the kscw-endpoints IMAP sync,
  // so opponent replies surface in the Mailbox tab. The endpoint syncs every
  // configured account; this stays dormant until at least one account's IMAP
  // password is set on the container.
  schedule('*/10 * * * *', async () => {
    if (!process.env.SCHEDULING_IMAP_PASSWORD && !process.env.SCHEDULING_IMAP_PASSWORD_BASKETBALL) return
    const startedAt = Date.now()
    try {
      const token = await getCronAccessToken(log, 'Mailbox sync')
      if (!token) return
      const res = await fetch('http://localhost:8055/kscw/admin/terminplanung/mailbox/sync', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = await res.text()
      if (!res.ok) throw new Error(`${res.status} ${body}`)
      const result = JSON.parse(body)
      if (result.processed > 0) log.info(`Mailbox sync cron: ${result.processed} new messages`)
      await logCronRun(database, 'mailbox_sync', { status: 'ok', durationMs: Date.now() - startedAt, rowsChanged: result.processed || 0 })
    } catch (err) {
      log.error({ msg: `Mailbox sync cron: ${err.message}`, event: 'cron.mailbox_sync', stack: err.stack })
      logCronError('mailbox_sync', err)
      await logCronRun(database, 'mailbox_sync', { status: 'error', durationMs: Date.now() - startedAt, errorMessage: err.message })
    }
  })

  // ── 10f. Cron: Schulferien sync (monthly, 1st @ 04:30 UTC) ──
  // Imports the City of Zürich school-holiday calendar into hall_closures
  // (source='school_holidays') so the halls show as closed during the holidays
  // and holiday-date trainings auto-cancel. The published calendar only changes
  // a few times a year, so a monthly poll is plenty; the job is idempotent so a
  // missed month self-heals on the next run.
  schedule('30 4 1 * *', async () => {
    const startedAt = Date.now()
    try {
      const token = await getCronAccessToken(log, 'Schulferien sync')
      if (!token) return
      const res = await fetch('http://localhost:8055/kscw/admin/schulferien-sync', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = await res.text()
      if (!res.ok) throw new Error(`${res.status} ${body}`)
      log.info(`Schulferien sync cron: ${body.slice(0, 200)}`)
      await logCronRun(database, 'schulferien_sync', { status: 'ok', durationMs: Date.now() - startedAt })
    } catch (err) {
      log.error({ msg: `Schulferien sync cron: ${err.message}`, event: 'cron.schulferien_sync', stack: err.stack })
      logCronError('schulferien_sync', err)
      await logCronRun(database, 'schulferien_sync', { status: 'error', durationMs: Date.now() - startedAt, errorMessage: err.message })
    }
  })

  // ── 10d. Cron: Refresh teams.season dropdown choices (May 1 annually, 03:00 UTC) ──
  // Earliest allowed season is the one currently "live": Jan-Apr → last autumn's; May onwards → this autumn's.
  // The window only shifts on May 1 (old season ends), so one run per year is enough.
  // Past seasons are removed so admins can't accidentally assign a team to a finished season.

  function computeSeasonChoices(now = new Date(), count = 5) {
    // ⚠ Uses the SHARED Jun-1 cutover (season.js), not a local month test. This
    // was `m >= 4` on 0-indexed months in server-local time — a MAY 1 cutover,
    // one month ahead of every other season source in the codebase. For the
    // whole of May the live season was therefore missing from the teams.season
    // dropdown, so an admin creating a team in May was steered into stamping it
    // a season AHEAD; the rollover then skips that team (it selects by
    // from_season) and it stays active across the cutover, while roster rows
    // added to it carry a season the team does not have.
    const startYear = seasonStartYear(now)
    const choices = []
    for (let i = 0; i < count; i++) {
      const a = startYear + i
      const b = String(a + 1).slice(2)
      const v = `${a}/${b}`
      choices.push({ text: v, value: v })
    }
    return choices
  }

  async function refreshSeasonChoices() {
    const choices = computeSeasonChoices()
    const options = { choices, allowOther: false }
    await database('directus_fields')
      .where({ collection: 'teams', field: 'season' })
      .update({ interface: 'select-dropdown', options: JSON.stringify(options) })
    return choices.map(c => c.value).join(', ')
  }

  // Jun 1, matching the cutover in season.js (was 1 May — see computeSeasonChoices).
  schedule('0 3 1 6 *', async () => {
    try {
      const seasons = await refreshSeasonChoices()
      log.info(`[season-refresh] teams.season choices set to: ${seasons}`)
    } catch (err) {
      log.error({ msg: `Season refresh cron: ${err.message}`, event: 'cron.season_refresh', stack: err.stack })
      logCronError('season_refresh', err)
    }
  })

  // ── 11. Filter: Member Privacy (birthdate_visibility, hide_phone, hide_email) ──
  // Enforces privacy settings at the API level so even direct API access respects them.
  // Staff tiers and the member's own record are exempt.

  /**
   * Who reads the register as it actually is.
   *
   * ⚠ `context.accountability.admin` alone is NOT enough. It is true only for
   * policies carrying `admin_access` — Administrator and Superuser. Sport admins
   * used to satisfy it via a hand-made `Sport Admin → KSCW Admin` attachment
   * (admin_access = true, created 2026-03-29) which §3b of setup-permissions.mjs
   * now prunes, correctly: that row made every vb_admin/bb_admin a full Directus
   * superadmin. The prune also, silently, made this hook start redacting them.
   *
   * The result was two layers disagreeing with the hook winning: Directus grants
   * `KSCW Sport Admin` a `members` read with fields = '*', while this filter
   * nulled `birthdate` for the 620 of 677 active members still on the
   * `birthdate_visibility = 'hidden'` Postgres DEFAULT (so it read as "the club
   * has no birthdates"), and nulled `ahv_nummer` for every member without
   * exception. A sport admin is the club's admin for their sport — age bands,
   * the U16 scorer-licence surcharge and licence paperwork all need these.
   *
   * ⚠ SPORT-SCOPED. A vb_admin sees the volleyball section unredacted and a
   * bb_admin the basketball one; each still gets the ordinary member view of the
   * other section. The boundary is `member-sport.js`, the SAME module that gates
   * the member DELETE (delete-impact.js `sportScopeError`) — one rule, so the
   * two can never drift. A dual sport admin holds both flags and is unconfined.
   * Club-level / unresolvable members answer 'both' and stay visible to either
   * section on purpose: a passive member or a fresh signup with no roster row yet
   * must not vanish from the people who have to process them.
   */
  const PRIVACY_FULL_ROLES = ['admin', 'superuser']
  const PRIVACY_SPORT_ROLES = ['vb_admin', 'bb_admin']

  filter('members.items.read', async (payload, meta, context) => {
    // Administrator / Superuser — admin_access bypasses policies entirely.
    if (context.accountability?.admin) return payload

    const currentUser = context.accountability?.user || null

    // The caller's own roles: ONE indexed lookup per REQUEST, not per item —
    // the Data Explorer reads ~700 members in a single call.
    //
    // `scope` is the section this caller reads unredacted:
    //   null              → not staff, redact everything below (the common path)
    //   'all'             → full admin or dual sport admin, nothing to redact
    //   'volleyball'|'basketball' → per-item, decided against the member's section
    let scope = null
    if (currentUser) {
      const me = await database('members').where('user', currentUser).select('role').first()
      const myRoles = Array.isArray(me?.role) ? me.role : []
      if (myRoles.some((r) => PRIVACY_FULL_ROLES.includes(r))) return payload
      if (myRoles.some((r) => PRIVACY_SPORT_ROLES.includes(r))) {
        // sportAdminScope returns null for a DUAL sport admin (no boundary can
        // be drawn between two sections you both run) — which, having already
        // established the caller is a sport admin, means unconfined.
        scope = sportAdminScope(myRoles) ?? 'all'
      }
    }
    if (scope === 'all') return payload

    const items = Array.isArray(payload) ? payload : [payload]

    // Re-fetch the gating flags (user, hide_phone, hide_email, birthdate_visibility)
    // directly from the DB keyed by member id. The redaction MUST NOT depend on the
    // caller's `?fields=` projection — if the gating flags are omitted from the
    // requested fields, the in-payload values are undefined and a JS `=== true`
    // scrub silently leaks the hidden phone/email/birthdate. By reading the
    // authoritative flags from the DB we enforce privacy regardless of projection,
    // and fail closed (redact) when an item's gating flag can't be resolved.
    const ids = []
    for (const item of items) {
      if (item && item.id != null) ids.push(item.id)
    }
    const gateById = new Map()
    let gateRows = []
    if (ids.length > 0) {
      gateRows = await database('members')
        .whereIn('id', ids)
        .select('id', 'user', 'hide_phone', 'hide_email', 'birthdate_visibility', 'website_name_private',
          // Only for the sport resolver below — passing these in is what keeps it
          // from running its own `members` query over the same ids.
          'sektion', 'beitragskategorie')
      for (const row of gateRows) gateById.set(row.id, row)
    }

    // Section of each member on this page, for a sport-confined caller only:
    // four queries for the WHOLE page (three junctions + teams — the `members`
    // rows are already in hand above), and none at all for everybody else.
    const sportById = scope && ids.length > 0
      ? await resolveMemberSports(database, ids, { memberRows: gateRows })
      : new Map()

    for (const item of items) {
      if (!item) continue

      // Authoritative gating flags from the DB (never the requested projection).
      const gate = item.id != null ? gateById.get(item.id) : undefined

      // Skip filtering for the member's own record (resolved from the DB so the
      // self-check is correct even when `user` isn't in the projection).
      if (currentUser && gate && gate.user === currentUser) continue

      // A sport admin reads their own section — and club-level members, which
      // resolve to 'both' — unredacted. The other section stays redacted, i.e.
      // they get the ordinary member view of it.
      //
      // ⚠ An item with NO id cannot be resolved to a section at all, so it falls
      // through to the redaction below rather than being exposed. An id that IS
      // present but whose section is unresolvable answers 'both' and is shown:
      // that is member-sport.js's documented, deliberate permissiveness (a
      // passive member or a fresh signup with no roster row must not vanish from
      // the section that has to process them), not an accident of this call.
      if (scope && item.id != null && sportScopeAllows(scope, sportById.get(String(item.id)))) continue

      // Birthdate visibility — fail closed (hide) when the flag can't be resolved.
      const birthdateVisibility = gate ? gate.birthdate_visibility : 'hidden'
      if (birthdateVisibility === 'hidden') {
        if ('birthdate' in item) item.birthdate = null
      } else if (birthdateVisibility === 'year_only' && item.birthdate) {
        // Extract just the year (handles both '1990-01-01' and ISO datetime strings)
        item.birthdate = String(item.birthdate).substring(0, 4)
      }

      // Phone visibility — fail closed (hide) when the flag can't be resolved.
      if (!gate || gate.hide_phone === true) {
        if ('phone' in item) item.phone = null
      }

      // Email visibility — fail closed (hide) when the flag can't be resolved.
      if (!gate || gate.hide_email === true) {
        if ('email' in item) item.email = null
      }

      // Website name-privacy (migration 116) — ANONYMOUS callers only. This is a
      // website-scoped control, so logged-in members (who have a currentUser and
      // never reach here unless reading someone else) keep full names; only the
      // public website / raw public /items/members read is minimised. Mirrors the
      // /public/team endpoint: surname → initial, birthdate dropped. Fail closed
      // (abbreviate) when the gating flag can't be resolved for an anonymous read.
      if (!currentUser && (!gate || gate.website_name_private === true)) {
        if ('last_name' in item && item.last_name) {
          const s = String(item.last_name).trim()
          item.last_name = s ? s.charAt(0).toUpperCase() + '.' : ''
        }
        if ('birthdate' in item) item.birthdate = null
      }

      // AHV number — self, full admins, and a sport admin reading their own
      // section; all three `continue`d above. Everybody who reaches this line,
      // including coaches, team responsibles and a sport admin looking at the
      // OTHER section, gets null.
      if ('ahv_nummer' in item) item.ahv_nummer = null
    }

    return Array.isArray(payload) ? items : items[0]
  })

  // ── 12. Cron: Error Log Cleanup (03:30 UTC) ─────────────────────
  // Delete error log files older than 30 days

  schedule('30 3 * * *', () => {
    try {
      cleanOldLogs()
      log.info('Error log cleanup completed')
    } catch (err) {
      log.error({ msg: `Error log cleanup: ${err.message}`, event: 'cron.error_log_cleanup', stack: err.stack })
    }
  })

  // ── 13. Registration Approval → CSV email ─────────────────────
  // When a registration status changes to 'approved', generate a CSV
  // and email it to the club admin mailbox.

  // ⚠ Was hardcoded to a personal Gmail, so setting OWNER_EMAIL in the container
  // env moved every OTHER consumer and silently left this one behind. Reads the
  // env now: one address, one place to change it.
  const OWNER_EMAIL = process.env.OWNER_EMAIL || 'admin@wiedisync.kscw.ch'
  const RADO_EMAIL = 'radomir.radovanovic.b@gmail.com'
  const VB_ADMIN_EMAIL = 'thamayanth.kanagalingam@uzh.ch'
  const BB_ADMIN_EMAIL = 'kscwiedikonbasketball@gmail.com'

  // Resolve members carrying the sport's admin role (bb_admin / vb_admin) so
  // role holders — e.g. the youth admin — are looped in on approvals without
  // hardcoding their address. Mirrors the submit-time notification's resolution.
  async function getSportAdminRoleEmails(membershipType) {
    const adminRole = membershipType === 'basketball' ? 'bb_admin'
      : membershipType === 'volleyball' ? 'vb_admin' : null
    if (!adminRole) return []
    const rows = await database('members')
      .join('directus_users', 'members.user', 'directus_users.id')
      .whereNotNull('directus_users.email')
      .whereRaw("members.role::jsonb @> ?", [JSON.stringify(adminRole)])
      .select('directus_users.email')
    return [...new Set(rows.map(r => r.email.toLowerCase()))]
  }

  async function getApprovalRecipients(membershipType) {
    // Sport-admin role holders ride along as CC (the fixed alias stays the TO).
    const roleCc = await getSportAdminRoleEmails(membershipType)
    switch (membershipType) {
      case 'basketball':
        return { to: [BB_ADMIN_EMAIL], cc: [OWNER_EMAIL, ...roleCc] }
      case 'volleyball':
        return { to: [VB_ADMIN_EMAIL, RADO_EMAIL], cc: [OWNER_EMAIL, ...roleCc] }
      default: // passive, unknown
        return { to: [OWNER_EMAIL], cc: [] }
    }
  }

  function csvEscapeHook(val) {
    let s = String(val ?? '')
    // Neutralize spreadsheet formula injection (HOOK-3): a cell beginning with
    // = + - @ (or tab/CR) can execute when an admin opens the emailed CSV in
    // Excel/LibreOffice/ClubDesk. Prefix with a single quote so it stays text.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s
    if (s.includes(';') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"'
    return s
  }

  // ClubDesk's CSV interface is Windows-1252, not UTF-8 (its export is CP1252 and
  // the scripted sync-up push iconv-transcodes before upload — see
  // clubdesk-member-up-dispatch.sh). This attachment gets imported into ClubDesk
  // by hand, so a UTF-8 file mangles every accented name (ü → Ã¼). Encode CP1252
  // and transliterate the few letters CP1252 can't hold (ć → c, ń → n) instead of
  // shipping mojibake into the legal member register.
  const CP1252_EXTRA = {
    '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85,
    '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8A,
    '‹': 0x8B, 'Œ': 0x8C, 'Ž': 0x8E, '‘': 0x91, '’': 0x92,
    '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97,
    '˜': 0x98, '™': 0x99, 'š': 0x9A, '›': 0x9B, 'œ': 0x9C,
    'ž': 0x9E, 'Ÿ': 0x9F,
  }
  // Letters with no CP1252 slot and no combining-mark decomposition.
  const CP1252_TRANSLIT = { 'đ': 'd', 'Đ': 'D', 'ł': 'l', 'Ł': 'L' }
  function toCp1252Buffer(str) {
    const bytes = []
    const pushChar = (ch) => {
      const cp = ch.codePointAt(0)
      if (cp <= 0x7F || (cp >= 0xA0 && cp <= 0xFF)) { bytes.push(cp); return true }
      if (CP1252_EXTRA[ch] !== undefined) { bytes.push(CP1252_EXTRA[ch]); return true }
      return false
    }
    for (const ch of str) {
      if (pushChar(ch)) continue
      const base = CP1252_TRANSLIT[ch] || ch.normalize('NFKD').replace(/[̀-ͯ]/g, '')
      let ok = base.length > 0
      const mark = bytes.length
      for (const b of base) if (!pushChar(b)) { ok = false; break }
      if (!ok) { bytes.length = mark; bytes.push(0x3F) } // '?'
    }
    return Buffer.from(bytes)
  }

  function buildRegistrationCSV(item) {
    const headers = [
      'Nachname', 'Vorname', 'Firma', 'Adresse', 'PLZ', 'Ort',
      'Telefon Privat', 'Telefon Mobil', '[Gruppen]', 'Sektion', 'Gruppe', 'Gruppen',
      'Anrede', 'Titel', 'Briefanrede', 'Benutzer-Id', 'Adress-Zusatz', 'Land',
      'Nationalität', 'Telefon Geschäft', 'Fax', 'E-Mail', 'E-Mail Alternativ',
      'Status', '[Rolle]', 'Eintritt', 'Mitgliedsjahre', 'Austritt', 'Zivilstand',
      'Geschlecht', 'Geburtsdatum', 'Jahrgang', 'Alter', 'Bemerkungen',
      'Firmen-Webseite', 'Rechnungsversand', 'Nie mahnen', 'IBAN', 'BIC', 'Kontoinhaber',
      'Lizenznummer', 'Lizenzart', 'Lizenz bestellt', 'Beitragskategorie',
      'Betrag Bezahlt', 'Clubnummer', 'Mittelschule ZH', 'Offiziellen Lizenz',
      'Mitgliederbeitrag', 'AHV Nummer', 'Passivmitglied', 'Offiziellen 100er',
      'Funktion', 'Rolle'
    ]

    let dob = ''
    let jahrgang = ''
    if (item.geburtsdatum) {
      const parts = String(item.geburtsdatum).substring(0, 10).split('-')
      dob = parts[2] + '.' + parts[1] + '.' + parts[0]
      jahrgang = parts[0]
    }

    const now = new Date()
    const todayStr = String(now.getDate()).padStart(2, '0') + '.' +
      String(now.getMonth() + 1).padStart(2, '0') + '.' + now.getFullYear()

    const sektion = item.membership_type === 'volleyball' ? 'Volleyball'
      : item.membership_type === 'basketball' ? 'Basketball' : 'KSCW'
    const status = item.membership_type === 'passive' ? 'Passivmitglied' : 'Aktivmitglied'
    const isPassive = item.membership_type === 'passive' ? 'ja' : ''

    const row = [
      item.nachname || '', item.vorname || '', '',
      item.adresse || '', item.plz || '', item.ort || '',
      '', item.telefon_mobil || '',
      item.team || '', sektion, '', '',
      item.anrede || '', '', '', '', '', 'Schweiz',
      // ClubDesk's Nationalität is a single-value German picklist and wants the
      // PRIMARY nationality, so it stays on the free-text name the form submits.
      // The FIBA "a Swiss passport among several makes you Swiss" rule is a
      // document-gate rule only — applying it here would file a CH/IT dual
      // national who listed IT first as Swiss in the members register.
      item.nationalitaet || '', '', '',
      item.email || '', '',
      status, '', todayStr, '', '', '',
      item.geschlecht || '', dob, jahrgang, '',
      item.bemerkungen || '',
      '', 'E-Mail', 'Nein', '', '', '',
      '', '', '',
      item.beitragskategorie || '',
      '', '',
      item.kantonsschule || '',
      item.lizenz || '',
      '',
      item.ahv_nummer || '',
      isPassive, '',
      item.rolle || '', '',
    ].map(csvEscapeHook)

    return '\uFEFF' + headers.join(';') + '\n' + row.join(';')
  }

  // ── i18n for registration status emails ───────────────────────
  const REG_T = {
    de: {
      approvedTitle: 'Anmeldung bestätigt',
      approvedSubtitle: 'Willkommen beim KSC Wiedikon!',
      approvedSubject: 'Anmeldung bestätigt — KSC Wiedikon',
      approvedGreeting: name => `Hallo ${name},`,
      approvedBody: `<p style="text-align:justify">Deine Anmeldung wurde geprüft und bestätigt. Willkommen beim KSC Wiedikon!</p>
        <p style="text-align:justify"><strong style="color:#e2e8f0">So erstellst du dein Konto auf WiediSync:</strong></p>`,
      approvedSteps: ['Klicke unten auf den Button.', 'Wähle ein Passwort und bestätige es.', 'Fertig — du siehst Spielpläne, Trainings und Teaminfos.'],
      approvedContactLine: `<p style="text-align:justify">Bei Fragen erreichst du uns unter <a href="mailto:kontakt@kscw.ch" style="color:#4A55A2">kontakt@kscw.ch</a>.</p>`,
      approvedCtaLabel: 'Konto erstellen',
      approvedCtaLabelLogin: 'Zum Login',
      approvedBodyExisting: `<p style="text-align:justify">Deine Anmeldung wurde geprüft und bestätigt. Willkommen beim KSC Wiedikon!</p>
        <p style="text-align:justify"><strong style="color:#e2e8f0">Nächster Schritt:</strong> Melde dich mit deinem bestehenden WiediSync-Konto an, um Spielpläne, Trainings und Teaminfos zu sehen.</p>
        <p style="text-align:justify">Bei Fragen erreichst du uns unter <a href="mailto:kontakt@kscw.ch" style="color:#4A55A2">kontakt@kscw.ch</a>.</p>`,
      approvedTokenNote: 'Der Link ist 30 Tage gültig und kann nur einmal verwendet werden.',
      approvedFooter: 'Sportliche Grüsse — KSC Wiedikon',
      rejectedTitle: 'Anmeldung abgelehnt',
      rejectedSubtitle: 'KSC Wiedikon',
      rejectedSubject: 'Anmeldung abgelehnt — KSC Wiedikon',
      rejectedGreeting: name => `Hallo ${name},`,
      rejectedReasonLabel: 'Begründung',
      rejectedBody: `<p style="text-align:justify">Leider wurde deine Anmeldung abgelehnt.</p>`,
      rejectedContact: `<p style="text-align:justify">Falls du Fragen hast, melde dich bei <a href="mailto:kontakt@kscw.ch" style="color:#4A55A2">kontakt@kscw.ch</a>.</p>`,
      rejectedFooter: 'KSC Wiedikon',
      name: 'Name', team: 'Team', sport: 'Sportart', ref: 'Referenz',
    },
    en: {
      approvedTitle: 'Registration Approved',
      approvedSubtitle: 'Welcome to KSC Wiedikon!',
      approvedSubject: 'Registration Approved — KSC Wiedikon',
      approvedGreeting: name => `Hello ${name},`,
      approvedBody: `<p style="text-align:justify">Your registration has been reviewed and approved. Welcome to KSC Wiedikon!</p>
        <p style="text-align:justify"><strong style="color:#e2e8f0">How to create your account on WiediSync:</strong></p>`,
      approvedSteps: ['Tap the button below.', 'Choose a password and confirm it.', 'Done — you can see schedules, trainings, and team info.'],
      approvedContactLine: `<p style="text-align:justify">For questions, reach us at <a href="mailto:kontakt@kscw.ch" style="color:#4A55A2">kontakt@kscw.ch</a>.</p>`,
      approvedCtaLabel: 'Create account',
      approvedCtaLabelLogin: 'Log in',
      approvedBodyExisting: `<p style="text-align:justify">Your registration has been reviewed and approved. Welcome to KSC Wiedikon!</p>
        <p style="text-align:justify"><strong style="color:#e2e8f0">Next step:</strong> Log in with your existing WiediSync account to see schedules, trainings, and team info.</p>
        <p style="text-align:justify">For questions, reach us at <a href="mailto:kontakt@kscw.ch" style="color:#4A55A2">kontakt@kscw.ch</a>.</p>`,
      approvedTokenNote: 'The link is valid for 30 days and can only be used once.',
      approvedFooter: 'Best regards — KSC Wiedikon',
      rejectedTitle: 'Registration Rejected',
      rejectedSubtitle: 'KSC Wiedikon',
      rejectedSubject: 'Registration Rejected — KSC Wiedikon',
      rejectedGreeting: name => `Hello ${name},`,
      rejectedReasonLabel: 'Reason',
      rejectedBody: `<p style="text-align:justify">Unfortunately, your registration has been rejected.</p>`,
      rejectedContact: `<p style="text-align:justify">If you have any questions, contact us at <a href="mailto:kontakt@kscw.ch" style="color:#4A55A2">kontakt@kscw.ch</a>.</p>`,
      rejectedFooter: 'KSC Wiedikon',
      name: 'Name', team: 'Team', sport: 'Sport', ref: 'Reference',
    },
  }
  function regT(locale) { return REG_T[locale] || REG_T.de }

  // ── Helper: season string (e.g. "2025/26") ─────────────────────
  // Season cutover is JUNE 1 (m=5), matching the canonical reader in
  // src/utils/dateHelpers.ts. Before June → previous autumn's season; June
  // onwards → this autumn's. (Was Sept/m<8, which disagreed with the frontend
  // and mis-stamped seasons for June–August writes.)
  const getCurrentSeason = currentSeasonShort

  // ── Normalize registration geschlecht to member sex (m/f) ───
  function normalizeSex(val) {
    if (!val) return null
    const v = val.toLowerCase()
    if (v === 'm' || v === 'männlich' || v === 'male') return 'm'
    if (v === 'f' || v === 'weiblich' || v === 'female') return 'f'
    return null
  }

  // ── Map registration licence strings to member licence codes ───
  function mapLicences(lizenzStr, membershipType) {
    if (!lizenzStr) return []
    const parts = lizenzStr.split(',').map(s => s.trim().toLowerCase())
    const mapped = []
    for (const p of parts) {
      if (membershipType === 'volleyball') {
        if (p.includes('schreiber') || p === 'scorer') mapped.push('scorer_vb')
        if (p.includes('schiedsrichter') || p === 'referee') mapped.push('referee_vb')
      } else if (membershipType === 'basketball') {
        if (p.includes('otr 1') || p === 'otr1') mapped.push('otr1_bb')
        if (p.includes('otr 2') || p === 'otr2') mapped.push('otr2_bb')
        // OTN is level-split since migration 228 (Basketplan issues OTN 1 and
        // OTN 2 separately), and migration 303 dropped the coarse `otn_bb` flag
        // that used to catch a level-less "OTN". A registration that names no
        // level therefore sets NO column — deliberately: asserting OTN 1 for
        // somebody who may hold OTN 2 is a licence claim the club cannot back,
        // and the applicant's raw answer survives on `registrations.lizenz` for
        // an admin (or the Basketplan import) to resolve into a real level.
        if (p.includes('otn 1') || p.includes('otn1')) mapped.push('otn1_bb')
        if (p.includes('otn 2') || p.includes('otn2')) mapped.push('otn2_bb')
        if (p.includes('schiedsrichter') || p === 'referee') mapped.push('referee_bb')
      }
    }
    return [...new Set(mapped)]
  }

  // ── Coded nationality / federation for a member row (migration 223) ───
  // The ISO code list a registration should hand the member, in order of trust:
  //   1. the form's own code list        (nationalitaet_codes, multi-select)
  //   2. the legacy singular code        (nationalitaet_code, migration 161)
  //   3. the free-text country name resolved through country_name_aliases
  //      (migration 224 — same table the members trigger parses with)
  // Returns null when nothing resolves, so the member simply keeps no coded
  // nationality instead of tripping members_nationalitaet_codes_fmt and
  // aborting the whole approval.
  async function registrationNatCodes(db, reg) {
    const clean = (v) => [...new Set(
      String(v || '').split(',').map(s => s.trim().toUpperCase()).filter(s => /^[A-Z]{2}$/.test(s)),
    )]
    const codes = clean(reg.nationalitaet_codes)
    if (codes.length) return codes.join(',')
    const single = clean(reg.nationalitaet_code)
    if (single.length) return single[0]
    const name = String(reg.nationalitaet || '').trim().toLowerCase()
    if (!name) return null
    const alias = await db('country_name_aliases').where('alias', name).first('code')
    return alias?.code || null
  }

  // 'NONE' ("never licensed with another federation") is a real answer and must
  // stay distinct from NULL ("didn't answer"). Shape-guarded because the column
  // carries a CHECK — a stray value would fail the approval, not the field.
  function normalizeFederation(val) {
    const v = String(val || '').trim().toUpperCase()
    if (v === 'NONE') return 'NONE'
    return /^[A-Z]{2}$/.test(v) ? v : null
  }

  // ── Create or link member from approved registration ───────────
  // Symmetric first-name-prefix match (same rule the ClubDesk linker uses):
  // "Dani" ↔ "Daniel" is the same person; "Anna" ↔ "Luca" is not. Missing
  // data counts as a match so legacy rows without names still link.
  function firstNamesMatch(a, b) {
    const x = String(a || '').toLowerCase().trim()
    const y = String(b || '').toLowerCase().trim()
    if (!x || !y) return true
    return x === y || x.startsWith(y) || y.startsWith(x)
  }

  async function createMemberFromRegistration(db, reg, log) {
    const email = reg.email.toLowerCase().trim()
    const rolle = (reg.rolle || '').toLowerCase()

    // 0. A staff-confirmed link wins over every heuristic below. /admin/anmeldungen
    // can merge a registration onto an existing member (registration.js →
    // /registration/:id/merge) — typically a returning ehemalige, or somebody who
    // re-registered under a NEW address. Email matching cannot see either case, so
    // without this an approval would happily mint a SECOND member row for a person
    // an admin had just finished identifying by hand.
    let existingMember = null
    if (reg.member) {
      existingMember = await db('members').where('id', reg.member).first()
      if (existingMember) {
        log.info({ msg: 'Registration carries a staff-confirmed member link', memberId: existingMember.id, email })
      } else {
        log.warn({ msg: `registrations.member=${reg.member} points at no member row — falling back to email matching`, email })
      }
    }

    // 1. Otherwise match by email (case-insensitive). Fetch ALL rows for the
    // email and pick the NAME-MATCHING one. A bare .first() with no ORDER BY
    // returns an arbitrary same-email row when a family shares the address — if
    // it happened to return the sibling, the name guard below nulled it and a
    // duplicate row was created for a person who already existed. This is why
    // members.email deliberately has no unique index.
    const emailRows = existingMember ? [] : await db('members').whereRaw('LOWER(email) = ?', [email])
    if (!existingMember) existingMember = emailRows.find(r => firstNamesMatch(r.first_name, reg.vorname)) || null
    if (!existingMember && emailRows.length) {
      // Same email, no name match → a DIFFERENT person shares the address
      // (parent/sibling). Create a separate row rather than graft onto them.
      log.warn({
        msg: `Registration email matches ${emailRows.length} member(s) but none name-matches "${reg.vorname}" — creating a separate member (shared family email)`,
        email,
      })
    }

    // Orphan directus_users with this email (account imported/created outside
    // the normal flow) — link it so the approval email says "log in" instead
    // of minting a dead invite. CRITICAL: "orphan" means NO member row
    // references this user. A same-email user that a DIFFERENT member already
    // owns (parent's activated account under a shared family email) must NOT
    // be adopted here — that would point two member rows at one login and let
    // the sibling's session resolve to the parent's identity. Leave the new
    // row unlinked; its signup token will hit the directus_users.email unique
    // constraint and the redeemer is told to get a personal email.
    const orphanUser = await db('directus_users')
      .whereRaw('LOWER(directus_users.email) = ?', [email])
      .whereNotExists(function () {
        this.select(db.raw('1')).from('members').whereRaw('members."user" = directus_users.id')
      })
      .select('id').first()

    let memberId
    if (existingMember) {
      memberId = existingMember.id
      log.info({ msg: 'Member already exists, linking registration', memberId, email })
      // Update fields that might be missing
      const updates = {}
      if (!existingMember.phone && reg.telefon_mobil) updates.phone = reg.telefon_mobil
      if (!existingMember.adresse && reg.adresse) updates.adresse = reg.adresse
      if (!existingMember.plz && reg.plz) updates.plz = reg.plz
      if (!existingMember.ort && reg.ort) updates.ort = reg.ort
      if (!existingMember.birthdate && reg.geburtsdatum) updates.birthdate = reg.geburtsdatum
      if (!existingMember.nationalitaet && reg.nationalitaet) updates.nationalitaet = reg.nationalitaet
      // Coded nationality (migration 223) — fill-only like the rest. When both
      // land in one update the members trigger's codes→name branch wins, so the
      // free-text fill above is only ever decisive for a registration whose
      // country name resolves to no code at all.
      const existingNatCodes = await registrationNatCodes(db, reg)
      if (!existingMember.nationalitaet_codes && existingNatCodes) updates.nationalitaet_codes = existingNatCodes
      const existingFederation = normalizeFederation(reg.federation_of_origin)
      if (!existingMember.federation_of_origin && existingFederation) updates.federation_of_origin = existingFederation
      if (!existingMember.sex && reg.geschlecht) updates.sex = normalizeSex(reg.geschlecht)
      // Salutation ('Herr'/'Frau') — the ClubDesk sync-up reads its Anrede column off the member.
      if (!existingMember.anrede && ['Herr', 'Frau'].includes(reg.anrede)) updates.anrede = reg.anrede
      if (!existingMember.ahv_nummer && reg.ahv_nummer) updates.ahv_nummer = reg.ahv_nummer
      // Payout IBAN from the signup form (migration 185) — fill-only, and
      // confirmed: the member typed it themselves. Registration values arrive
      // already mod-97-validated + normalized (registration.js).
      if (!existingMember.iban && reg.iban) { updates.iban = reg.iban; updates.iban_confirmed = true }
      if (!existingMember.beitragskategorie && reg.beitragskategorie) updates.beitragskategorie = reg.beitragskategorie
      // Licences are per-flag booleans (migration 067; legacy `licences` json
      // dropped in migration 119). Additive: only ever set a flag true here.
      const newLicences = mapLicences(reg.lizenz, reg.membership_type)
      for (const lic of newLicences) {
        if (!existingMember[lic]) updates[lic] = true
      }
      if (!existingMember.user && orphanUser) updates.user = orphanUser.id
      if (Object.keys(updates).length) {
        await db('members').where('id', memberId).update(updates)
      }
    } else {
      // 2. Create new shell member
      const shellExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      const licences = mapLicences(reg.lizenz, reg.membership_type)
      const lang = reg.locale === 'en' ? 'english' : 'german'
      // Nationality is CODED from here on (migration 223). Writing the codes and
      // letting the members trigger derive the German `nationalitaet` mirror also
      // closes a real gap: `registrations.nationalitaet_code` existed since
      // migration 161 but was NEVER propagated, so approval silently threw the
      // ISO code away and left the member with free text only.
      const natCodes = await registrationNatCodes(db, reg)

      const [member] = await db('members').insert({
        first_name: reg.vorname,
        last_name: reg.nachname,
        email,
        phone: reg.telefon_mobil || null,
        adresse: reg.adresse || null,
        plz: reg.plz || null,
        ort: reg.ort || null,
        birthdate: reg.geburtsdatum || null,
        nationalitaet_codes: natCodes,
        // The German name is DERIVED — set it only as the last-resort carrier
        // for a country nothing could resolve to a code (an unknown spelling),
        // so approval never silently drops what the applicant typed.
        nationalitaet: natCodes ? null : (reg.nationalitaet || null),
        federation_of_origin: normalizeFederation(reg.federation_of_origin),
        sex: normalizeSex(reg.geschlecht),
        anrede: ['Herr', 'Frau'].includes(reg.anrede) ? reg.anrede : null,
        ahv_nummer: reg.ahv_nummer || null,
        // Payout IBAN from the signup form (migration 185) — pre-validated
        // (mod-97) + normalized by registration.js; confirmed since the member
        // typed it themselves.
        iban: reg.iban || null,
        iban_confirmed: !!reg.iban,
        beitragskategorie: reg.beitragskategorie || null,
        // Per-flag licence booleans (migration 067; legacy `licences` json dropped in 119).
        scorer_vb: licences.includes('scorer_vb'),
        referee_vb: licences.includes('referee_vb'),
        otr1_bb: licences.includes('otr1_bb'),
        otr2_bb: licences.includes('otr2_bb'),
        // Two OTN columns, one per Basketplan level (migration 228; the coarse
        // `otn_bb` was dropped by 303). A registration naming no level sets
        // neither — see mapLicences().
        otn1_bb: licences.includes('otn1_bb'),
        otn2_bb: licences.includes('otn2_bb'),
        referee_bb: licences.includes('referee_bb'),
        shell: true,
        shell_expires: shellExpires,
        shell_reminder_sent: false,
        wiedisync_active: false,
        coach_approved_team: true,
        kscw_membership_active: true,
        birthdate_visibility: 'hidden',
        language: lang,
        role: JSON.stringify(['user']),
        ...(orphanUser ? { user: orphanUser.id } : {}),
      }).returning('id')

      memberId = member.id || member
      log.info({ msg: 'Shell member created from registration', memberId, email })
    }

    // Flag the member for the next ClubDesk sync-up push (a new shell needs
    // creating in ClubDesk; a re-linked member may have gained contact fields
    // above). Best-effort — never fail the registration over the push flag.
    try {
      await db('members').where('id', memberId).update({ clubdesk_push_pending: true })
    } catch (flagErr) {
      log.warn({ msg: `clubdesk push-flag (registration) failed: ${flagErr.message}`, memberId })
    }

    // 3. Link to team(s) based on rolle
    if (reg.team && reg.membership_type !== 'passive') {
      const teamNames = reg.team.split(',').map(t => t.trim()).filter(Boolean)
      // `season` is selected so the roster insert below can stamp the TEAM's own
      // season instead of the wall clock (they disagree for all of May and
      // between the Jun-1 cutover and the rollover).
      const teamRows = await db('teams')
        .whereIn('name', teamNames).andWhere('active', true).select('id', 'name', 'season')

      const season = getCurrentSeason()

      for (const team of teamRows) {
        if (rolle.includes('trainer') || rolle.includes('coach') ||
            rolle.includes('teamverantwortlich') || rolle.includes('team responsible')) {
          // COACH / TR requested (2026-07-05 audit MED #6). `rolle` + `team` are
          // applicant-controlled public-form fields, and coach/TR membership
          // materializes the LEADER policy (team leadership + member-PII access +
          // roster/game/fine write scope). Auto-granting that on a routine
          // approval let an applicant self-assert leadership over any existing
          // team. Do NOT auto-create the coach/TR junction here — leadership is
          // an explicit, deliberate staff action (roster editor / admin, which is
          // itself scope-guarded now). Surface a clear, admin-visible warning so
          // staff know to grant it manually.
          log.warn({ msg: `Registration approval requested COACH/TR on "${team.name}" — NOT auto-granted (applicant-supplied rolle). Grant leadership manually if intended.`, memberId, team: team.name, rolle })
          logWarning('registration_leader_not_autogranted',
            `Member ${memberId} approved with rolle="${rolle}" on team "${team.name}" — coach/TR NOT auto-granted; assign manually if intended.`,
            { memberId, team: team.name, rolle })
        } else {
          // Everyone else (player / andere / other / unspecified) → roster player.
          // A guest registration (funktion "Guest" → rolle) is rostered as a guest
          // (guest_level 1): lower training priority, blocked from league games,
          // and expected in ClubDesk's '<group> (Guest)' subgroup by the sync check
          // (user 2026-07-15). Core players stay guest_level 0.
          const isGuestRolle = rolle === 'guest' || rolle === 'gast'
          // Probe by (member, team) — the UNIQUE key — not by season, and stamp
          // the TEAM's own season rather than the wall clock. Keyed on season the
          // probe missed an existing row whose stamp lagged and the insert then
          // hit the unique constraint; stamping the clock wrote a season the team
          // does not have, which the rollover's clone then skips.
          const rosterSeason = team.season ?? season
          const exists = await db('member_teams')
            .where({ member: memberId, team: team.id }).first()
          if (!exists) {
            await db('member_teams').insert({
              member: memberId, team: team.id, season: rosterSeason, guest_level: isGuestRolle ? 1 : 0,
            })
            log.info({ msg: 'Added to team roster', memberId, team: team.name, season: rosterSeason, guest: isGuestRolle })
          }
        }
      }
    }

    return memberId
  }

  // ── Approval document gate ──────────────────────────────────────
  // A basketball registration cannot be approved while its required documents
  // are missing (ID front/back + licence application; non-Swiss additionally
  // self declaration + national team declaration). The create route enforces
  // this for NEW submissions (registration.js docs_required); this filter
  // closes the path for rows that predate the enforcement — e.g. upload-phase
  // failures like REG-2026-5041, which was approved with 0 documents. The
  // family completes the docs via the website's "Dokumente nachreichen" page
  // first. Legacy rows without a stored nationality code only need the base 3
  // (the non-CH requirement can't be derived for them).
  filter('registrations.items.update', async (payload, meta) => {
    if (payload?.status !== 'approved') return payload
    const keys = (meta.keys || []).map(Number).filter(Number.isInteger)
    for (const key of keys) {
      const reg = await database('registrations').where('id', key)
        .first('id', 'membership_type', 'nationalitaet_code', 'nationalitaet_codes', 'geburtsdatum', 'bb_situation', 'bb_recent_licence', 'reference_number',
          'bb_docs_waived',
          'id_upload_front', 'id_upload_back', 'bb_doc_lizenz', 'bb_doc_freibrief', 'bb_doc_selfdecl', 'bb_doc_natdecl', 'bb_doc_u18parents', 'bb_doc_schoolcert')
      if (!reg || reg.membership_type !== 'basketball') continue
      // The same PATCH may edit situation/nationality/DOB *and* approve — evaluate
      // the required set against the post-update values (payload wins), so a
      // single Data-Studio save that turns the row into a Swiss-club transfer
      // can't approve it before the Freibrief lands.
      const situation = payload.bb_situation !== undefined ? payload.bb_situation : reg.bb_situation
      // Multi-nationality (migration 223): a Swiss passport anywhere in the list
      // makes the applicant Swiss for FIBA, so the gate must not read the primary
      // code alone — otherwise a CH/IT dual national who listed IT first is asked
      // for foreign-player documents the create route never demanded.
      const natCodes = payload.nationalitaet_codes !== undefined ? payload.nationalitaet_codes : reg.nationalitaet_codes
      const natSingle = payload.nationalitaet_code !== undefined ? payload.nationalitaet_code : reg.nationalitaet_code
      const natCode = fibaNatCode(natCodes, natSingle)
      const dob = payload.geburtsdatum !== undefined ? payload.geburtsdatum : reg.geburtsdatum
      // Situation + nationality + age driven (mirrors registration.js bbRequiredDocs;
      // school certificate stays optional). Rows without a situation fall back to the
      // legacy natCode-only rule inside the helper.
      // Freibrief waiver (migration 232): the applicant's own answer decides, so
      // it must reach the gate — otherwise approving a waived transfer_ch would
      // demand a release letter the create route rightly never asked for.
      const recentLicence = payload.bb_recent_licence !== undefined ? payload.bb_recent_licence : reg.bb_recent_licence
      // Waiver (migration 358) — payload wins, because the admin page waives and
      // approves in ONE patch: the approver could not otherwise set a waiver on a
      // row this same filter is about to refuse.
      const waived = payload.bb_docs_waived !== undefined ? payload.bb_docs_waived : reg.bb_docs_waived
      const required = bbRequiredDocsAfterWaiver(situation, natCode, dob, recentLicence, waived)
      // The same update may attach a doc and approve in one call — payload wins.
      const missing = required.filter((k) => (payload[k] === undefined ? !reg[k] : !payload[k]))
      if (missing.length) {
        // kscwScopeError (hoisted, defined with the games scope guards) carries
        // status/code so Directus surfaces a 400 instead of an opaque 500.
        throw kscwScopeError(
          `Cannot approve ${reg.reference_number}: required documents missing (${missing.join(', ')})`,
          400, 'DOCS_REQUIRED',
        )
      }
    }
    return payload
  })

  // ── Document waiver: canonicalize, demand a reason, stamp the approver ──────
  //
  // The waiver is the one way past the gate above, so it has to carry its own
  // evidence. Three things happen here and nowhere else:
  //
  //   - the stored list is rewritten to the recognised column names only, so a
  //     typo waives nothing rather than something adjacent
  //   - a waiver with no reason is refused with a readable 400 (the CHECK in
  //     migration 358 would refuse it too, as an unreadable constraint error)
  //   - who and when are stamped from accountability, never from the payload —
  //     a self-declared "waived by" is not evidence
  //
  // Clearing the waiver (empty/null) is allowed and clears the stamps with it:
  // re-imposing a requirement is always safe.
  filter('registrations.items.update', async (payload, _meta, { accountability, database: db }) => {
    if (payload?.bb_docs_waived === undefined) return payload

    const waived = parseWaivedDocs(payload.bb_docs_waived)
    if (!waived.length) {
      payload.bb_docs_waived = null
      payload.bb_docs_waived_reason = null
      payload.bb_docs_waived_by_name = null
      payload.bb_docs_waived_by_email = null
      payload.bb_docs_waived_at = null
      return payload
    }

    const reason = String(payload.bb_docs_waived_reason ?? '').trim()
    if (!reason) {
      throw kscwScopeError(
        'A document waiver needs a reason: say why the licence can be issued without it.',
        400, 'WAIVER_REASON_REQUIRED',
      )
    }

    payload.bb_docs_waived = waived.join(',')
    payload.bb_docs_waived_reason = reason
    payload.bb_docs_waived_by_name = null
    payload.bb_docs_waived_by_email = null
    if (accountability?.user) {
      try {
        const m = await db('members').where('user', accountability.user)
          .first('first_name', 'last_name', 'email')
        payload.bb_docs_waived_by_name = m ? [m.first_name, m.last_name].filter(Boolean).join(' ') || null : null
        payload.bb_docs_waived_by_email = m?.email ?? null
      } catch { /* stamping is best-effort; the reason check above is not */ }
    }
    payload.bb_docs_waived_at = new Date()
    return payload
  })

  // ── Email templates: validate + sanitize + stamp the editor ─────────────────
  //
  // Enforced in a hook rather than only in the admin page because the items API is
  // reachable from the Directus admin app and any API client, and the output of a
  // bad template lands in a real member's inbox. The rules are the ones a send
  // cannot recover from on its own: an unknown placeholder would ship literally as
  // "{{nmae}}", and a body without {{documents}} tells a family that something is
  // missing without ever saying what.
  //
  // Validation runs against the MERGED row (stored values + this patch), not the
  // patch alone — otherwise clearing only the subject would be judged as though the
  // body were empty too.
  const validateEmailTemplateWrite = async (payload, keys, db, accountability) => {
    const touched = TEMPLATE_FIELDS.filter((f) => payload[f] !== undefined)
    if (!touched.length && payload.template_key === undefined) return payload

    const rows = keys?.length
      ? await db('email_templates').whereIn('id', keys).select('id', 'template_key', ...TEMPLATE_FIELDS)
      : [null]

    for (const row of rows) {
      const key = payload.template_key ?? row?.template_key
      const merged = {}
      for (const f of TEMPLATE_FIELDS) {
        merged[f] = payload[f] !== undefined ? payload[f] : row?.[f]
      }
      const errors = validateTemplate(key, merged)
      if (errors.length) {
        throw kscwScopeError(errors.join(' '), 400, 'TEMPLATE_INVALID')
      }
    }

    // Strip script/style/handlers on the way in, so the stored value is already
    // safe for the admin preview to render. The send path sanitizes again — this
    // is defence in depth, not a substitute.
    if (typeof payload.body_html === 'string') {
      payload.body_html = sanitizeTemplateHtml(payload.body_html)
    }

    // Who last touched the copy. These emails go out over the club's name, so
    // "who changed this wording" has to be answerable.
    if (accountability?.user) {
      try {
        const m = await db('members').where('user', accountability.user)
          .first('id', 'first_name', 'last_name', 'email')
        payload.updated_by_name = m ? [m.first_name, m.last_name].filter(Boolean).join(' ') || null : null
        payload.updated_by_email = m?.email ?? null
      } catch { /* stamping is best-effort; validation above is not */ }
    }
    payload.date_updated = new Date()
    return payload
  }

  filter('email_templates.items.update', async (payload, meta, { accountability, database: db }) =>
    validateEmailTemplateWrite(payload, meta?.keys, db, accountability))
  filter('email_templates.items.create', async (payload, _meta, { accountability, database: db }) =>
    validateEmailTemplateWrite(payload, null, db, accountability))

  // The archive is written by the backend and read by staff — never edited, or it
  // stops being evidence of what was actually sent.
  filter('email_sends.items.update', async () => {
    throw kscwScopeError('Sent emails are a record and cannot be edited.', 403, 'READ_ONLY')
  })
  filter('email_sends.items.delete', async () => {
    throw kscwScopeError('Sent emails are a record and cannot be deleted.', 403, 'READ_ONLY')
  })

  // Same reasoning for the audit trail itself. `user_logs` is append-only: the
  // app writes entries via logActivity and the superadmin audit page reads them.
  // Editing or deleting an entry lets the tier under audit rewrite its own
  // history, so both are refused for everyone the policy layer applies to
  // (audit 2026-08-08, finding 1 — the Sport Admin tier held unfiltered
  // update/delete here until that pass). Admin accountability bypasses filter
  // hooks, so a genuine root can still correct the table if it ever needs it.
  filter('user_logs.items.update', async () => {
    throw kscwScopeError('The audit log is a record and cannot be edited.', 403, 'READ_ONLY')
  })
  filter('user_logs.items.delete', async () => {
    throw kscwScopeError('The audit log is a record and cannot be deleted.', 403, 'READ_ONLY')
  })

  // ── Cron: registration-document orphan sweep (04:30 UTC) ────────
  // The eager-upload form puts files into the private registration folder
  // BEFORE the registration exists, so abandoned forms and re-picked files
  // leave orphans behind. Delete folder files older than 7 days that no
  // registrations doc column references. Scoped strictly to the registration
  // folder — folder-less files are the public site's images, never touched.
  schedule('30 4 * * *', async () => {
    try {
      const rows = await database('directus_files')
        .where('folder', REGISTRATION_FILES_FOLDER)
        .where('uploaded_on', '<', database.raw("now() - interval '7 days'"))
        .whereNotExists(function () {
          this.select(database.raw('1')).from('registrations').whereRaw(
            `registrations.id_upload_front = directus_files.id
             OR registrations.id_upload_back = directus_files.id
             OR registrations.bb_doc_lizenz = directus_files.id
             OR registrations.bb_doc_freibrief = directus_files.id
             OR registrations.bb_doc_selfdecl = directus_files.id
             OR registrations.bb_doc_natdecl = directus_files.id
             OR registrations.bb_doc_u18parents = directus_files.id
             OR registrations.bb_doc_schoolcert = directus_files.id`,
          )
        })
        .select('id')
      if (!rows.length) return
      const { FilesService } = services
      const schema = await getSchema()
      const filesService = new FilesService({ schema, knex: database })
      await filesService.deleteMany(rows.map((r) => r.id))
      log.info(`Registration-doc orphan sweep: deleted ${rows.length} unreferenced file(s)`)
    } catch (err) {
      log.error({ msg: `Registration-doc orphan sweep: ${err.message}`, event: 'cron.registration_doc_sweep', stack: err.stack })
      logCronError('registration_doc_sweep', err)
    }
  })

  // Registration approvals currently being processed, keyed by registration id.
  //
  // Directus does not await action handlers, so two overlapping
  // PATCH /items/registrations/:id {status:'approved'} run their handlers
  // CONCURRENTLY — and the pending list is cached for 30s with no realtime, so a
  // second sport admin's tab keeps rendering a live Approve button long after the
  // first admin approved the row. Both handlers then miss each other's member
  // (there is deliberately NO unique on members.email — families legitimately
  // share an address, see createMemberFromRegistration), both INSERT one, and
  // both mail the family and the sport admins.
  //
  // The claim cannot be a conditional UPDATE on registrations.status: this is an
  // ACTION hook, so Directus has already committed status='approved' before we
  // run and every claimant would lose. Keyed per registration, so two different
  // registrations never block each other, and released in a finally — a thrown
  // handler, or a container restart, leaves nothing stranded, so the deliberate
  // re-approval the member-creation-failure alert below asks admins to perform
  // still works exactly as before.
  // ⚠ Process-local: it would not survive multi-instance scaling. Directus runs
  // as a single container here.
  const approvalsInFlight = new Set()

  action('items.update', async ({ collection, keys, payload }, { schema }) => {
    if (collection !== 'registrations') return
    if (payload.status !== 'approved' && payload.status !== 'rejected') return

    const claimedApprovals = []
    try {
      const { ItemsService, MailService } = services
      const itemsService = new ItemsService('registrations', { schema, knex: database })
      const mail = new MailService({ schema, knex: database })

      for (const id of keys) {
        const reg = await itemsService.readOne(id)
        const locale = reg.locale || 'de'
        const l = regT(locale)
        const sport = reg.membership_type === 'volleyball' ? 'volleyball'
          : reg.membership_type === 'basketball' ? 'basketball' : null

        const summaryCard = buildInfoCard([
          { label: l.name, value: `${reg.vorname} ${reg.nachname}`, halfWidth: true },
          { label: l.sport, value: reg.membership_type.charAt(0).toUpperCase() + reg.membership_type.slice(1), halfWidth: true },
          { label: l.team, value: reg.team || '-', halfWidth: true },
          { label: l.ref, value: reg.reference_number, halfWidth: true },
        ])

        if (payload.status === 'approved') {
          // ── 0. Claim this approval (see approvalsInFlight above) ──
          // String key: Directus may hand the PK through as a number or a
          // string, and a Set compares by identity.
          const claimKey = String(id)
          if (approvalsInFlight.has(claimKey)) {
            log.warn({
              msg: 'Registration approval skipped: a concurrent approval of the same registration is already running',
              event: 'registration.approve_in_flight', id,
            })
            continue
          }
          approvalsInFlight.add(claimKey)
          claimedApprovals.push(claimKey)

          // ── 1. Gather coach/TR emails for CC ──
          let coachTrCc = []
          if (reg.team && reg.membership_type !== 'passive') {
            try {
              const teamNames = reg.team.split(',').map(t => t.trim()).filter(Boolean)
              const teamRows = await database('teams')
                .whereIn('name', teamNames).andWhere('active', true).select('id')
              if (teamRows.length) {
                const teamIds = teamRows.map(r => r.id)
                const coachRows = await database('teams_coaches')
                  .whereIn('teams_id', teamIds)
                  .join('members', 'teams_coaches.members_id', 'members.id')
                  .join('directus_users', 'members.user', 'directus_users.id')
                  .whereNotNull('directus_users.email').select('directus_users.email')
                const trRows = await database('teams_responsibles')
                  .whereIn('teams_id', teamIds)
                  .join('members', 'teams_responsibles.members_id', 'members.id')
                  .join('directus_users', 'members.user', 'directus_users.id')
                  .whereNotNull('directus_users.email').select('directus_users.email')
                coachTrCc = [...new Set([...coachRows, ...trRows].map(r => r.email.toLowerCase()))]
                  .filter(e => e !== reg.email.toLowerCase())
              }
            } catch (teamErr) {
              log.warn({ msg: `Coach/TR lookup failed: ${teamErr.message}`, id })
            }
          }

          // ── 2. Create or link member in Directus FIRST ──
          // The approval email carries a member-bound signup token, so the
          // member row must exist before the email is built. (The old order —
          // email first, creation second with failures swallowed — could send
          // a CTA into the void with no member row at all.)
          let memberId = null
          try {
            memberId = await createMemberFromRegistration(database, reg, log)
          } catch (memberErr) {
            log.error({ msg: `Member creation failed: ${memberErr.message}`, id, stack: memberErr.stack })
          }
          // Stamp the authoritative registration → member link (migration 194).
          // createMemberFromRegistration returns the id on BOTH paths (created
          // + linked-to-existing); persisting it here means every later
          // consumer (ClubDesk status badge, per-registration zone) resolves
          // by ID instead of re-deriving via email/name heuristics — which
          // false-negative on divergent emails (parent-email registrations).
          if (memberId) {
            try {
              await database('registrations').where('id', id).update({ member: memberId })
            } catch (stampErr) {
              log.warn({ msg: `registrations.member stamp failed: ${stampErr.message}`, id, memberId })
            }
          }

          // ── 3. Mint a signup token when the member has no account yet ──
          let inviteToken = null
          let hasAccount = false
          if (memberId) {
            try {
              const memberRow = await database('members')
                .where('id', memberId).select('user').first()
              hasAccount = !!memberRow?.user
              if (!hasAccount) {
                const minted = await mintSignupToken(database, memberId, { mintedVia: 'registration' })
                inviteToken = minted.token
              }
            } catch (mintErr) {
              // Token is an enhancement — the member can still claim via
              // /signup email-match if minting fails.
              log.error({ msg: `Signup token mint failed: ${mintErr.message}`, id, memberId, stack: mintErr.stack })
            }
          }

          // ── 4. Confirmation email to user (CC coach/TR) ──
          if (memberId) {
            // CTA: invite link when we minted a token; /login when the person
            // already has an account; otherwise (mint failed for an
            // account-less member) /signup — the email-match claim flow still
            // lets an existing member activate. Never pair a "create account"
            // body with a "log in" button (dead end for the account-less).
            const ctaUrl = inviteToken ? signupInviteUrl(inviteToken)
              : (hasAccount ? `${FRONTEND_URL}/login` : `${FRONTEND_URL}/signup`)
            const ctaLabel = (inviteToken || !hasAccount) ? l.approvedCtaLabel : l.approvedCtaLabelLogin
            // Account-less registrants get the numbered how-to guide; people
            // who already have an account get the "log in" copy (no guide).
            const guideHtml = (!hasAccount && l.approvedSteps) ? buildGuideHtml(l.approvedSteps) : ''
            const contactLine = l.approvedContactLine || ''
            const bodyCopy = hasAccount ? l.approvedBodyExisting : (l.approvedBody + guideHtml + contactLine)
            const tokenNote = inviteToken
              ? `<p style="text-align:justify;color:#64748b;font-size:12px;margin-top:8px">${l.approvedTokenNote}</p>`
              : ''
            const approvalHtml = buildEmailLayout(
              summaryCard + `<div style="font-size:13px;color:#94a3b8;line-height:1.7;margin-top:12px">${bodyCopy}${tokenNote}</div>`,
              { title: l.approvedTitle, subtitle: l.approvedSubtitle, sport, greeting: l.approvedGreeting(reg.vorname), footerExtra: l.approvedFooter, ctaUrl, ctaLabel }
            )
            await mail.send({
              to: reg.email,
              ...(coachTrCc.length ? { cc: coachTrCc } : {}),
              subject: l.approvedSubject,
              html: approvalHtml,
            })
            log.info({ msg: 'Approval confirmation sent', id, email: reg.email, cc: coachTrCc.length, invited: !!inviteToken })
          } else {
            // Member creation failed → registrant email would be a dead end
            // (open registration is closed). Alert the sport admins instead so
            // they can fix the data and re-approve.
            try {
              const recipients = await getApprovalRecipients(reg.membership_type)
              const alertTos = [...new Set([...(recipients.to || []), ...(recipients.cc || [])])]
              if (alertTos.length) {
                await mail.send({
                  to: alertTos,
                  subject: `[KSCW] Anmeldung ${reg.reference_number}: Mitglied-Erstellung fehlgeschlagen`,
                  html: buildEmailLayout(
                    summaryCard + `<div style="font-size:13px;color:#94a3b8;line-height:1.7;margin-top:12px"><p style="text-align:justify">Die Anmeldung wurde auf "bestätigt" gesetzt, aber das Mitglied konnte nicht erstellt werden. Der/die Anmeldende hat KEINE Bestätigungs-E-Mail erhalten. Bitte Daten prüfen und die Anmeldung erneut bestätigen (Status kurz auf "pending" und wieder auf "approved" setzen).</p></div>`,
                    { title: 'Mitglied-Erstellung fehlgeschlagen', subtitle: reg.reference_number, sport }
                  ),
                })
              }
            } catch (alertErr) {
              log.error({ msg: `Member-creation-failure alert failed: ${alertErr.message}`, id })
            }
          }

          // ── 5. CSV email to sport-specific admins (per-recipient locale) ──
          const csv = buildRegistrationCSV(reg)
          const csvBuffer = toCp1252Buffer(csv)
          const filename = `anmeldung_${reg.nachname}_${reg.vorname}_${reg.reference_number}.csv`
          const recipients = await getApprovalRecipients(reg.membership_type)
          // Sport type is stored lowercase ("volleyball"); show it capitalized in
          // the subject, TYPE field, and subtitle (matches the member email above).
          const sportLabel = reg.membership_type
            ? reg.membership_type.charAt(0).toUpperCase() + reg.membership_type.slice(1)
            : reg.membership_type
          const adminCsvCopy = {
            de: {
              name: 'Name', type: 'Typ', team: 'Team', email: 'E-Mail', ref: 'Referenz',
              intro: 'Die Anmeldung wurde bestätigt. Die CSV-Datei für den ClubDesk-Import ist im Anhang.',
              title: 'Anmeldung bestätigt', cta: 'Im Admin öffnen',
              subject: `[KSCW] Anmeldung bestätigt: ${reg.vorname} ${reg.nachname} (${sportLabel})`,
            },
            en: {
              name: 'Name', type: 'Type', team: 'Team', email: 'Email', ref: 'Reference',
              intro: 'The registration has been approved. The CSV file for the ClubDesk import is attached.',
              title: 'Registration approved', cta: 'Open in admin',
              subject: `[KSCW] Registration approved: ${reg.vorname} ${reg.nachname} (${sportLabel})`,
            },
          }
          const ccLower = (recipients.cc || []).map(e => e.toLowerCase())
          const toLower = (recipients.to || []).map(e => e.toLowerCase())
          const toBuckets = await bucketEmailsByLocale(database, toLower)
          const ccBuckets = await bucketEmailsByLocale(database, ccLower)
          // CC riders on the same locale bucket; if their bucket has no TO, promote them to TO.
          // Iterate every bucket (not just de/en) so a role-CC'd admin in another
          // language isn't silently dropped — fall back to the German copy.
          for (const loc of ['de', 'gsw', 'en', 'fr', 'it']) {
            let tos = toBuckets[loc]
            const ccs = ccBuckets[loc].filter(e => !tos.includes(e))
            if (!tos.length && !ccs.length) continue
            if (!tos.length) {
              tos = ccs
              ccBuckets[loc] = []
            }
            const c = adminCsvCopy[loc] || adminCsvCopy.de
            const adminCsvBody = buildInfoCard([
              { label: c.name, value: `${reg.vorname} ${reg.nachname}`, halfWidth: true },
              { label: c.type, value: sportLabel, halfWidth: true },
              { label: c.team, value: reg.team || '-', halfWidth: true },
              { label: c.email, value: reg.email, halfWidth: true },
              { label: c.ref, value: reg.reference_number },
            ]) + `<div style="font-size:13px;color:#94a3b8;line-height:1.7;margin-top:12px;text-align:justify"><p>${c.intro}</p></div>`
            const adminCsvHtml = buildEmailLayout(adminCsvBody, {
              title: c.title,
              subtitle: `${reg.vorname} ${reg.nachname} — ${sportLabel}`,
              sport,
              ctaUrl: 'https://wiedisync.kscw.ch/admin/anmeldungen',
              ctaLabel: c.cta,
            })
            await mail.send({
              to: tos,
              ...(ccBuckets[loc].length ? { cc: ccBuckets[loc] } : {}),
              subject: c.subject,
              html: adminCsvHtml,
              attachments: [{ filename, content: csvBuffer, contentType: 'application/vnd.ms-excel' }],
            })
          }
          log.info({ msg: 'Approval CSV sent', id, ref: reg.reference_number })

        } else if (payload.status === 'rejected') {
          // ── Rejection email to user ──
          const reason = payload.rejection_reason || reg.rejection_reason || ''
          // Admin-supplied rejection reason ends up in the user's mailbox.
          // Escape HTML so an admin can't inject phishing markup or a tracking
          // pixel into the email body.
          const reasonBlock = reason
            ? `<div style="background:#450a0a;border:1px solid #7f1d1d;border-radius:8px;padding:12px 16px;margin:12px 0"><div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#f87171;font-weight:700;margin-bottom:4px">${l.rejectedReasonLabel}</div><div style="font-size:13px;color:#fca5a5">${escapeEmailHtml(reason)}</div></div>`
            : ''
          const rejectionHtml = buildEmailLayout(
            summaryCard + `<div style="font-size:13px;color:#94a3b8;line-height:1.7;margin-top:12px">${l.rejectedBody}</div>` + reasonBlock + `<div style="font-size:13px;color:#94a3b8;line-height:1.7;margin-top:12px">${l.rejectedContact}</div>`,
            { title: l.rejectedTitle, subtitle: l.rejectedSubtitle, greeting: l.rejectedGreeting(reg.vorname), footerExtra: l.rejectedFooter }
          )
          await mail.send({ to: reg.email, subject: l.rejectedSubject, html: rejectionHtml })
          log.info({ msg: 'Rejection email sent to user', id, email: reg.email })
        }
      }
    } catch (err) {
      log.error({ msg: `Registration status email: ${err.message}`, event: 'registration.status', stack: err.stack })
    } finally {
      for (const claimKey of claimedApprovals) approvalsInFlight.delete(claimKey)
    }
  })

  // Messaging retention (Plan 05 / spec §9)
  // Runs nightly at 03:00 UTC. Failures isolated via try/catch.
  schedule('0 3 * * *', async () => {
    try {
      const db = database
      const now = new Date()

      const r1 = await db('messages')
        .whereRaw(`created_at < NOW() - INTERVAL '12 months'`)
        .del()
      const r2 = await db('messages')
        .whereRaw(`deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '30 days'`)
        .del()
      const r3 = await db('message_requests')
        .where('status', 'declined')
        .andWhereRaw(`resolved_at < NOW() - INTERVAL '90 days'`)
        .del()

      logger.info({
        plan: 'messaging-05-retention',
        at: now.toISOString(),
        purged: { old_messages: r1, soft_deleted_messages: r2, declined_requests: r3 },
      }, 'messaging retention cron complete')
    } catch (err) {
      logger.error({ err: err?.message ?? String(err) }, 'messaging retention cron failed')
    }
  })

  // ── Spielplaner scope guard on games.create ──────────────────────────────
  // Directus permission filters on the CREATE action don't evaluate relational
  // conditions against the incoming payload (only scalar fields work, e.g.
  // "source == manual"). The KSCW Spielplaner policy relies on a relational
  // filter (kscw_team ∈ caller's spielplaner_assignments) which Directus
  // silently treats as satisfied at CREATE time. This hook enforces that check
  // server-side for non-admin callers creating manual games.
  //
  // Admins and service calls (no accountability.user) bypass.
  // Club-wide Spielplaners (members.is_spielplaner = true) bypass the team check.
  // ⚠ `name = 'DirectusError'` is what makes the message reach the user, and it
  // is the whole point of writing these messages. Directus's REST error handler
  // runs every thrown error through `isDirectusError`, which tests nothing but
  // `err.name === 'DirectusError'`. Anything else is logged at ERROR level and
  // answered with a blanket 500 "An unexpected error occurred." — except for
  // callers with `accountability.admin`, who DO get the real message. That
  // asymmetry is why the hole survived: every one of these guards read correctly
  // in admin testing and returned an unexplained 500 to the coach or sport admin
  // it was written for (observed 2026-08-07 on member_teams + teams_coaches).
  // With the name set, `status` and `message` are honoured as written.
  function kscwScopeError(message, status, code) {
    const err = new Error(message)
    err.name = 'DirectusError'
    err.status = status
    err.code = code
    err.extensions = { code }
    return err
  }
  filter('games.items.create', async (payload, _meta, { accountability, database: db }) => {
    if (!accountability?.user) return payload
    if (accountability.admin) return payload
    if (payload?.source !== 'manual') return payload

    const member = await db('members').where('user', accountability.user).first('id', 'is_spielplaner')
    if (!member) return payload // not a member — let Directus deny via its own check
    if (member.is_spielplaner === true) return payload // club-wide scope

    const team = payload?.kscw_team
    if (team == null) {
      throw kscwScopeError('Manual game requires kscw_team', 400, 'INVALID_PAYLOAD')
    }

    const assigned = await db('spielplaner_assignments')
      .where('member', member.id)
      .andWhere('kscw_team', team)
      .first('id')
    if (!assigned) {
      throw kscwScopeError('Team is not in your Spielplaner scope', 403, 'FORBIDDEN')
    }
    return payload
  })

  // ── Manual-game update/delete: per-team scope for assignment-scoped ──────
  // Spielplaners. The per-user 'KSCW Spielplaner' policy grants games
  // update/delete row-filtered to source='manual' (setup-permissions.mjs §9d)
  // but has no team dimension — this guard adds it, mirroring the create
  // guard above. Members with no spielplaner relation (e.g. TRs confirming
  // duties) pass through: their own policies' row filters are the gate.
  // payloadTeam: on UPDATE, the destination team the payload wants to set (if
  // it touches kscw_team) — a scoped spielplaner must not move a manual game
  // INTO a team outside their scope either, so the target team is validated
  // against the same allowed set as the stored team.
  async function assertManualGamesInScope(db, accountability, gameIds, payloadTeam) {
    if (!accountability?.user || accountability.admin) return
    if (!Array.isArray(gameIds) || !gameIds.length) return
    const member = await db('members')
      .where('user', accountability.user).first('id', 'is_spielplaner')
    if (!member) return
    if (member.is_spielplaner === true) return // club-wide scope
    const assignments = (await db('spielplaner_assignments')
      .where('member', member.id).pluck('kscw_team')).filter(v => v != null)
    if (!assignments.length) return // not a spielplaner — policy filters gate
    // Dual-role: a coach/TR keeps their LEADER-policy write on manual games of
    // teams they lead even when those teams aren't in their Spielplaner
    // assignments. Union them in so the guard never 403s an update the LEADER
    // policy legitimately grants (the policy's own kscw_team row filter is the
    // real gate for that path).
    const coachTeams = await db('teams_coaches').where('members_id', member.id).pluck('teams_id')
    const trTeams = await db('teams_responsibles').where('members_id', member.id).pluck('teams_id')
    const allowed = new Set([...assignments, ...coachTeams, ...trTeams].filter(v => v != null))
    const rows = await db('games').whereIn('id', gameIds).select('id', 'source', 'kscw_team')
    for (const r of rows) {
      if (r.source !== 'manual') continue
      if (!allowed.has(r.kscw_team)) {
        throw kscwScopeError('Game is not in your Spielplaner scope', 403, 'FORBIDDEN')
      }
      // Block moving a manual game INTO an out-of-scope team.
      if (payloadTeam != null && payloadTeam !== r.kscw_team && !allowed.has(payloadTeam)) {
        throw kscwScopeError('Target team is not in your Spielplaner scope', 403, 'FORBIDDEN')
      }
    }
  }
  filter('games.items.update', async (payload, meta, { accountability, database: db }) => {
    const payloadTeam = payload && 'kscw_team' in payload ? payload.kscw_team : undefined
    await assertManualGamesInScope(db, accountability, meta?.keys || [], payloadTeam)
    return payload
  })
  filter('games.items.delete', async (keys, _meta, { accountability, database: db }) => {
    await assertManualGamesInScope(db, accountability, keys || [])
    return keys
  })

  // ── Scheduling blocks create: stamp creator + enforce team scope ────────
  // The `scheduling_blocks.create` policy permission is unfiltered (Directus
  // can't validate a relational filter on a not-yet-existing row), so this
  // filter is the real gate: a coach/TR may only block a team they coach or are
  // responsible for. Club-wide Spielplaner + full admin may block any team
  // (mirrors games.items.create). created_by is stamped from accountability.
  filter('scheduling_blocks.items.create', async (payload, _meta, { accountability, database: db }) => {
    if (!accountability?.user) return payload
    const member = await db('members').where('user', accountability.user).first('id', 'is_spielplaner')
    const out = member?.id ? { ...payload, created_by: payload?.created_by ?? member.id } : payload
    if (accountability.admin) return out            // full admin — any team
    if (!member) return out                         // not a member — Directus denies via policy
    if (member.is_spielplaner === true) return out  // club-wide Spielplaner — any team
    const team = out.team
    if (team == null) {
      throw kscwScopeError('Team blocking requires a team', 400, 'INVALID_PAYLOAD')
    }
    // Coach/TR of the team — or a sport admin of that team's sport, which is
    // the club-wide `scheduling_blocks` CRUD the Sport Admin policy grants
    // ("club-wide CRUD for any team's blackouts").
    if (!(await actorLeadsTeam(db, accountability, team))) {
      throw kscwScopeError('You can only block teams you coach or are responsible for', 403, 'FORBIDDEN')
    }
    return out
  })

  // ── Participation create: absence-aware auto-decline ────────────────────
  // System-context creates (the cron writing a fresh declined row when an
  // absence is created) still get auto-flipped to declined. User-driven
  // creates DO NOT — a member's explicit "Yes" / "Maybe" click is the source
  // of truth, even if a covering absence still exists. Policy aligned with
  // the BEFORE UPDATE trigger from migration 038, which clears
  // `auto_declined_by` on any user-initiated status change for the same
  // reason: the user's last manual action wins.
  filter('participations.items.create', async (payload, _meta, { database: db, accountability }) => {
    try {
      if (!payload || !payload.activity_type || !payload.activity_id || !payload.member) return payload
      // If already declined, nothing to do.
      if (payload.status === 'declined') return payload
      // Skip when the request is user-driven — trust the explicit RSVP.
      // Cron writes have null accountability (system context), so
      // autoDeclineForAbsence's INSERT path still passes through this filter
      // and would no-op (it sets status=declined upfront).
      if (accountability?.user) return payload

      // Resolve activity date based on activity_type
      let activityDate = null
      let affectsKey = null
      if (payload.activity_type === 'training') {
        const row = await db('trainings').where('id', payload.activity_id).first('date', 'cancelled')
        if (!row || row.cancelled) return payload
        activityDate = row.date
        affectsKey = 'trainings'
      } else if (payload.activity_type === 'game') {
        const row = await db('games').where('id', payload.activity_id).first('date', 'status')
        if (!row) return payload
        if (['completed', 'postponed', 'cancelled'].includes(row.status || '')) return payload
        activityDate = row.date
        affectsKey = 'games'
      } else if (payload.activity_type === 'event') {
        const row = await db('events').where('id', payload.activity_id).first('start_date')
        if (!row) return payload
        activityDate = row.start_date
        affectsKey = 'events'
      } else {
        return payload
      }
      if (!activityDate) return payload

      // Trainings/games have date-typed columns — the ISO split is the plain
      // calendar date. events.start_date is timestamptz, so derive its date in
      // Zurich like every other event/absence matcher in this file (the UTC
      // date is the previous day for a 00:00–01:59 Zurich event).
      let dateStr
      if (affectsKey === 'events') {
        const ds = await db.raw(
          `SELECT to_char((? ::timestamptz AT TIME ZONE 'Europe/Zurich')::date, 'YYYY-MM-DD') AS d`,
          [activityDate],
        )
        dateStr = ds?.rows?.[0]?.d
      } else {
        dateStr = activityDate.toISOString?.().split('T')[0] || String(activityDate).split('T')[0]
      }
      if (!dateStr) return payload
      const res = await db.raw(`
        SELECT a.id, COALESCE(a.reason, '') AS reason
        FROM absences a
        WHERE a.member = ?::integer
          AND a.start_date::date <= ?::date AND a.end_date::date >= ?::date
          AND (a.affects::jsonb @> '"all"' OR a.affects::jsonb @> ?::jsonb)
          AND (a.type IS DISTINCT FROM 'weekly' OR a.days_of_week::jsonb @> to_jsonb((EXTRACT(DOW FROM ?::date)::int + 6) % 7))
        ORDER BY a.id ASC
        LIMIT 1
      `, [payload.member, dateStr, dateStr, JSON.stringify(affectsKey), dateStr])

      const absence = res?.rows?.[0]
      if (!absence) return payload

      log.info(`[absence-auto-decline] participation create override: member=${payload.member} ${payload.activity_type}=${payload.activity_id} → declined (absence ${absence.id})`)
      return {
        ...payload,
        status: 'declined',
        note: payload.note || absence.reason,
        auto_declined_by: absence.id,
      }
    } catch (err) {
      log.error({ msg: `[absence-auto-decline] participation create filter: ${err.message}`, event: 'absence_auto_decline_part_create', stack: err.stack })
      return payload
    }
  })

  // ── Guest-level RSVP gate ───────────────────────────────────────────────
  // Trainings can configure `excluded_guest_levels` (jsonb array, e.g. [1,2,3])
  // to block guests at specific tiers from confirming/tentative. Games are a
  // hardcoded hard rule: guests of any level can't RSVP yes/maybe to a game.
  // Events ask one yes/no — `invite_guests` (migration 324), default true, so
  // they stay open unless the organiser says otherwise. Declined is always
  // allowed (lets the user cleanly opt out without an admin doing it for them).
  /**
   * The gate itself, shared by create and update.
   *
   * `rsvp` is the RESOLVED state a write would produce — {activity_type,
   * activity_id, member, status} — not the raw payload, because a PATCH carries
   * none of the first three and they have to come from the stored row.
   * Throws GUEST_RSVP_BLOCKED, or returns normally when allowed.
   */
  async function assertGuestMayRsvp(db, rsvp) {
    const payload = rsvp
    {
      if (!payload || !payload.activity_type || !payload.activity_id || !payload.member) return
      if (payload.status !== 'confirmed' && payload.status !== 'tentative') return

      // Events are multi-team, so they can't go through the single-team lookup
      // below — migration 324's switch is answered per MEMBER across every
      // invited team. Mirrors isGuestExcludedFromEvent() in the frontend's
      // eventHelpers.ts; change one, change the other.
      if (payload.activity_type === 'event') {
        const ev = await db('events').where('id', payload.activity_id).first('invite_guests')
        if (!ev || ev.invite_guests !== false) return
        const rows = await db('member_teams')
          .join('events_teams', 'events_teams.teams_id', 'member_teams.team')
          .where('events_teams.events_id', payload.activity_id)
          .andWhere('member_teams.member', payload.member)
          .select('member_teams.guest_level')
        // On none of the invited teams → they got here by role, by name, or the
        // event is club-wide. Not a roster question.
        if (rows.length === 0) return
        // Core player on at least one invited team → invited.
        if (rows.some((r) => Number(r.guest_level || 0) === 0)) return
        // A personal invite outranks the team-level switch.
        const named = await db('events_members')
          .where('events_id', payload.activity_id)
          .andWhere('members_id', payload.member)
          .first('id')
        if (named) return
        log.info(`[guest-rsvp-gate] block event=${payload.activity_id} member=${payload.member} (invite_guests off)`)
        throw kscwScopeError(
          'Guest players are not invited to this event',
          403,
          'GUEST_RSVP_BLOCKED',
        )
      }

      let teamId = null
      let excluded = null  // null = "block any positive level" (games), array = explicit list
      if (payload.activity_type === 'training') {
        const row = await db('trainings').where('id', payload.activity_id).first('team', 'excluded_guest_levels')
        if (!row || !row.team) return
        teamId = row.team
        const raw = row.excluded_guest_levels
        const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? JSON.parse(raw) : [])
        if (!list.length) return
        excluded = list.map((v) => Number(v)).filter((n) => !Number.isNaN(n))
      } else if (payload.activity_type === 'game') {
        const row = await db('games').where('id', payload.activity_id).first('kscw_team')
        if (!row || !row.kscw_team) return
        teamId = row.kscw_team
        // null = block any positive guest_level
      } else {
        return
      }

      const mt = await db('member_teams')
        .where('member', payload.member)
        .andWhere('team', teamId)
        .first('guest_level')
      const level = Number(mt?.guest_level || 0)
      if (level === 0) return  // not a guest, always allowed

      const blocked = excluded === null ? level > 0 : excluded.includes(level)
      if (!blocked) return

      log.info(`[guest-rsvp-gate] block ${payload.activity_type}=${payload.activity_id} member=${payload.member} level=${level}`)
      throw kscwScopeError(
        payload.activity_type === 'game'
          ? 'Guests cannot participate in games'
          : 'Your guest level is excluded from this training',
        403,
        'GUEST_RSVP_BLOCKED',
      )
    }
  }

  filter('participations.items.create', async (payload, _meta, { database: db }) => {
    try {
      await assertGuestMayRsvp(db, payload)
      return payload
    } catch (err) {
      if (err?.extensions?.code === 'GUEST_RSVP_BLOCKED' || err?.status === 403) throw err
      log.error({ msg: `[guest-rsvp-gate] ${err.message}`, event: 'guest_rsvp_gate', stack: err.stack })
      return payload
    }
  })

  // The UPDATE twin. Missing until 2026-08-10 (audit 2026-08-08, finding 24),
  // and the update leg is the app's PRIMARY write path — useParticipation
  // PATCHes an existing row — so the gate only ever covered the less-used half.
  // An excluded guest POSTed `declined` (which early-returns past the gate),
  // then PATCHed to `confirmed`; they then counted toward `min_participants`,
  // which feeds the training auto-cancel sweep.
  //
  // A PATCH carries no activity_type/activity_id/member, so the stored row
  // supplies them and the payload supplies only the new status. The Postgres
  // backstop `trg_participations_guest_block` is games-only despite being
  // declared BEFORE INSERT OR UPDATE with a TG_OP='UPDATE' arm — trainings were
  // simply never added there either.
  filter('participations.items.update', async (payload, meta, { database: db }) => {
    try {
      if (!payload || (payload.status !== 'confirmed' && payload.status !== 'tentative')) return payload
      const ids = Array.isArray(meta?.keys) ? meta.keys : (meta?.key != null ? [meta.key] : [])
      if (!ids.length) return payload
      const rows = await db('participations').whereIn('id', ids)
        .select('activity_type', 'activity_id', 'member')
      for (const row of rows) {
        await assertGuestMayRsvp(db, { ...row, status: payload.status })
      }
      return payload
    } catch (err) {
      if (err?.extensions?.code === 'GUEST_RSVP_BLOCKED' || err?.status === 403) throw err
      log.error({ msg: `[guest-rsvp-gate/update] ${err.message}`, event: 'guest_rsvp_gate', stack: err.stack })
      return payload
    }
  })

  // ── Edit attribution (migration 047, replaces 046) ──────────────────────
  // Per-field trackers: `last_status_edited_*` and `last_note_edited_*`.
  // The roster modal renders "Edited to <status> by <name> on <date>" and
  // "Note edited by <name> on <date>" as INDEPENDENT lines, so a coach who
  // edits only the note doesn't reset the status attribution and vice
  // versa. Logic:
  //   • If `status` is in the payload → stamp last_status_edited_*
  //   • If `note`   is in the payload → stamp last_note_edited_*
  // System-context writes (null accountability — cron auto-decline,
  // hall-closure unwind) leave both pairs untouched so they remain
  // distinguishable from staff edits. Filters always overwrite the
  // client-supplied tracker fields so they can't be spoofed from the API.
  filter('participations.items.create', async (payload, _meta, { accountability }) => {
    if (!accountability?.user) return payload
    const now = new Date().toISOString()
    const out = { ...payload }
    if (Object.prototype.hasOwnProperty.call(payload, 'status')) {
      out.last_status_edited_by = accountability.user
      out.last_status_edited_at = now
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'note') && (payload.note ?? '') !== '') {
      out.last_note_edited_by = accountability.user
      out.last_note_edited_at = now
    }
    return out
  })
  filter('participations.items.update', async (payload, _meta, { accountability }) => {
    if (!accountability?.user) return payload
    const now = new Date().toISOString()
    const out = { ...payload }
    if (Object.prototype.hasOwnProperty.call(payload, 'status')) {
      out.last_status_edited_by = accountability.user
      out.last_status_edited_at = now
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'note')) {
      out.last_note_edited_by = accountability.user
      out.last_note_edited_at = now
    }
    return out
  })

  // ── Self-scoped CREATE ownership guard (security audit 2026-05-31) ────────
  // Directus enforces neither the `permissions` row-filter nor a relational
  // `validation` on CREATE (no existing row to match; a `member.user`
  // validation can't be resolved against the payload and rejects ALL creates),
  // so the self-scope filters in setup-permissions.mjs do NOT block a Member
  // from POSTing a participation/absence/vote/request/etc. with someone else's
  // owner id. Verified on dev: such a create returned 200. These filters enforce
  // ownership server-side. Pass-through: system writes (null accountability —
  // crons, auto-confirm/auto-decline, triggers) and admins. For participations/
  // absences a team coach/TR may also write for their own team members (roster
  // editing); the strictly-personal collections are self-only.
  // Collections a household guardian may NOT write even though the acting swap
  // makes her look exactly like the member (migration 348).
  //
  // ⚠⚠ WITHOUT THIS SET, THE SWAP SILENTLY INVERTS THE RULE BELOW. Acting makes
  // `editor.id === affectedMemberId`, so the "self only" branch returns early and
  // every strictly-personal collection quietly becomes guardian-writable. The
  // comment on the allowLeader:false list says "nobody votes or delegates on
  // another member's behalf" — this is what keeps that true.
  //
  // ⚠ push_subscriptions and team_requests are deliberately NOT here: writing a
  // child's push row from the parent's device is exactly the intent (Stage 5),
  // and requesting to join a team is a legitimate parent action.
  const GUARDIAN_FORBIDDEN_CREATE = new Set(['poll_votes', 'scorer_delegations'])

  async function assertCreateOwnership(accountability, db, affectedMemberId, { allowLeader, collection }) {
    if (!accountability?.user) return          // system context
    if (accountability.admin) return           // admins bypass
    if (affectedMemberId == null) return        // owner omitted — NOT NULL / other filters handle it
    if (accountability.kscwGuardian && collection && GUARDIAN_FORBIDDEN_CREATE.has(collection)) {
      throw kscwScopeError('Not permitted while using another account', 403, 'NOT_OWNER')
    }
    const editor = await db('members').where('user', accountability.user).select('id').first()
    if (editor && Number(editor.id) === Number(affectedMemberId)) return  // self
    if (allowLeader && editor) {
      const teamIds = (await db('member_teams').where('member', affectedMemberId).select('team'))
        .map((r) => r.team).filter(Boolean)
      if (teamIds.length) {
        const isCoach = await db('teams_coaches').whereIn('teams_id', teamIds).andWhere('members_id', editor.id).first()
        const isTR = isCoach || await db('teams_responsibles').whereIn('teams_id', teamIds).andWhere('members_id', editor.id).first()
        if (isCoach || isTR) return            // coach/TR of the member's team
        // …or a sport admin of one of those teams' sport — same reasoning as
        // actorIsSportAdminForTeam: the policy already grants participations +
        // absences club-wide. `allowLeader: false` collections (poll_votes,
        // push_subscriptions, team_requests, scorer_delegations) stay self-only
        // — nobody votes or delegates on another member's behalf.
        for (const teamId of teamIds) {
          if (await actorIsSportAdminForTeam(db, accountability, teamId)) return
        }
      }
    }
    throw kscwScopeError('You can only create this for yourself', 403, 'NOT_OWNER')
  }

  // member-owned, coach/TR of the member's team may also create (roster editing)
  for (const coll of ['participations', 'absences']) {
    filter(`${coll}.items.create`, async (payload, _meta, { database: db, accountability }) => {
      await assertCreateOwnership(accountability, db, payload?.member, { allowLeader: true, collection: coll })
      return payload
    })
  }
  // strictly personal — self (or admin/system) only
  for (const [coll, field] of [
    ['poll_votes', 'member'], ['push_subscriptions', 'member'], ['team_requests', 'member'],
    ['scorer_delegations', 'from_member'],
  ]) {
    filter(`${coll}.items.create`, async (payload, _meta, { database: db, accountability }) => {
      await assertCreateOwnership(accountability, db, payload?.[field], { allowLeader: false, collection: coll })
      return payload
    })
  }

  // Audit-integrity (PERM-2): user_logs has a Member create grant (the FE
  // fire-and-forget logActivity), but it was unfiltered + unstamped, letting a
  // member POST a log row attributed to ANY member (forging the audit trail
  // that /admin/audit surfaces). Force the actor to the caller's own member id
  // so client-supplied `user` can't be spoofed. System/admin context passes.
  filter('user_logs.items.create', async (payload, _meta, { database: db, accountability }) => {
    if (!payload) return payload
    if (!accountability?.user || accountability.admin) return payload // system / admin — trust
    const me = await db('members').where('user', accountability.user).select('id').first()
    if (me) payload.user = me.id
    return payload
  })

  // member_teams delete scope — the policy grants the row-level delete filter,
  // but Directus delete filters key on the junction id, and a coach's delete
  // perm is NOT team-scoped here, so without this a coach could delete ANY
  // team's roster rows (cross-team roster tampering). A non-admin may delete a
  // member_teams row only when (a) it's their own membership, or (b) they
  // coach / are responsible for that row's team. System + admin pass.
  filter('member_teams.items.delete', async (keys, _meta, { database: db, accountability }) => {
    if (!accountability?.user) return keys   // system context (cron/hook/cascade)
    if (accountability.admin) return keys     // admins bypass
    const ids = Array.isArray(keys) ? keys : (keys != null ? [keys] : [])
    if (ids.length === 0) return keys
    const editor = await db('members').where('user', accountability.user).select('id').first()
    if (!editor) throw kscwScopeError('You cannot delete these team memberships', 403, 'NOT_OWNER')
    const rows = await db('member_teams').whereIn('id', ids).select('id', 'member', 'team')
    for (const row of rows) {
      if (Number(row.member) === Number(editor.id)) continue   // own membership
      if (row.team == null) {
        throw kscwScopeError('You cannot delete these team memberships', 403, 'NOT_OWNER')
      }
      // Coach/TR of the row's team — or a sport admin of that team's sport.
      if (!(await actorLeadsTeam(db, accountability, row.team))) {
        throw kscwScopeError('You can only remove members from teams you coach or are responsible for', 403, 'NOT_OWNER')
      }
    }
    return keys
  })

  // Junction-write scope (2026-07-05 audit — HIGH #1/#2 + MED #3). The LEADER
  // policy grants teams_coaches / teams_responsibles / member_teams CREATE (so a
  // coach can manage their own team's staff + roster), but Directus cannot
  // row-filter a CREATE (no pre-existing row to match — see setup-permissions.mjs
  // §"CREATE grants"), and the only hooks on the coach/TR junctions were the
  // POST-insert action hooks above, which ATTACH the LEADER policy via
  // ensureLeaderAccess and therefore GRANT access — they cannot reject the write.
  // So a coach/TR of ANY single team could POST teams_coaches
  // {teams_id:<any team B>, members_id:<self>} and self-escalate to team B's
  // roster/games/fines/absences/events (horizontal privilege escalation). Require
  // the acting member to ALREADY lead the target team (or be admin/system).
  // Mirrors the member_teams.items.delete guard + assertFineTeamScope.
  async function actorLeadsTeam(db, accountability, teamId) {
    if (teamId == null) return false
    const editor = await db('members').where('user', accountability.user).select('id').first()
    if (!editor) return false
    const isCoach = await db('teams_coaches').where({ teams_id: teamId, members_id: editor.id }).first('id')
    if (isCoach) return true
    const isTR = await db('teams_responsibles').where({ teams_id: teamId, members_id: editor.id }).first('id')
    if (isTR) return true
    return actorIsSportAdminForTeam(db, accountability, teamId)
  }

  // A sport admin (vb_admin / bb_admin) leads EVERY team of their own sport.
  //
  // The leader guards above exist to stop a coach of team A from writing team
  // B's roster/staff — a sport admin is simply not that actor. The `KSCW Sport
  // Admin` policy already grants member_teams / teams_coaches /
  // teams_responsibles / fines / scheduling_blocks / participations / absences
  // club-wide CRUD (setup-permissions.mjs §9 SPORT_ADMIN_FULL_CRUD), and the app
  // shows them the roster editor + coach picker for every team of their sport
  // (`hasAdminAccessToTeam` in AuthProvider). Without this the two layers
  // disagreed: the UI offered the edit, the policy allowed it, and the hook
  // killed it — as a bare 500 "An unexpected error occurred.", because these are
  // filter-hook throws, not Directus permission denials. Surfaced 2026-08-07
  // from a bb_admin editing the MU8 / 2xDU18 rosters and MU8's coaching staff.
  //
  // Deliberately sport-scoped and nothing more: a bb_admin still cannot touch a
  // volleyball roster, a team with no sport matches nobody, and full
  // admins/superusers never reach here (accountability.admin returns first).
  async function actorIsSportAdminForTeam(db, accountability, teamId) {
    if (teamId == null) return false
    const me = await db('members').where('user', accountability.user).select('role').first()
    const roles = Array.isArray(me?.role) ? me.role : []
    const isVb = roles.includes('vb_admin')
    const isBb = roles.includes('bb_admin')
    if (!isVb && !isBb) return false
    const team = await db('teams').where('id', teamId).select('sport').first()
    if (!team) return false
    return (team.sport === 'volleyball' && isVb) || (team.sport === 'basketball' && isBb)
  }

  for (const coll of ['teams_coaches', 'teams_responsibles']) {
    filter(`${coll}.items.create`, async (payload, _meta, { database: db, accountability }) => {
      if (!accountability?.user) return payload   // system context (cron/hook/cascade)
      if (accountability.admin) return payload     // admins bypass
      if (!(await actorLeadsTeam(db, accountability, toIdValue(payload?.teams_id)))) {
        throw kscwScopeError('You can only assign staff to a team you coach or are responsible for', 403, 'NOT_TEAM_LEADER')
      }
      return payload
    })
  }

  // member_teams CREATE/UPDATE: same class as the delete guard above. Create is
  // scoped to teams the caller leads (roster editing); update must not re-point a
  // row to (or away from) a team the caller doesn't lead. Self-add to an
  // unrelated team IS the escalation, so there is deliberately no "self" bypass.
  filter('member_teams.items.create', async (payload, _meta, { database: db, accountability }) => {
    if (!accountability?.user) return payload
    if (accountability.admin) return payload
    if (!(await actorLeadsTeam(db, accountability, toIdValue(payload?.team)))) {
      throw kscwScopeError('You can only add members to a team you coach or are responsible for', 403, 'NOT_TEAM_LEADER')
    }
    return payload
  })
  filter('member_teams.items.update', async (payload, meta, { database: db, accountability }) => {
    if (!accountability?.user) return payload
    if (accountability.admin) return payload
    const ids = Array.isArray(meta?.keys) ? meta.keys : (meta?.key != null ? [meta.key] : [])
    const rows = ids.length ? await db('member_teams').whereIn('id', ids).select('team') : []
    for (const row of rows) {
      if (!(await actorLeadsTeam(db, accountability, row.team))) {
        throw kscwScopeError('You can only edit rosters for teams you coach or are responsible for', 403, 'NOT_TEAM_LEADER')
      }
    }
    if (payload?.team != null && !(await actorLeadsTeam(db, accountability, toIdValue(payload.team)))) {
      throw kscwScopeError('You can only move members to teams you coach or are responsible for', 403, 'NOT_TEAM_LEADER')
    }
    return payload
  })

  // ── CREATE guards for the LEADER grants Directus cannot filter ──
  //
  // `setup-permissions.mjs` scoped update/delete on all of these on 2026-08-10
  // (audit 2026-08-08, finding 7), but a Directus row filter is a no-op on
  // CREATE — there is no row to match yet. The script's own note says such
  // grants are "enforced in the kscw-hooks *.items.create filter guard"; for
  // these five that guard did not exist, which is what made the grants
  // effectively club-wide. Same arrangement as `member_teams` above.
  //
  // A blocking `filter` (not `action`) is required: an action hook runs after
  // the insert and cannot refuse it.

  /** Shared shape: refuse unless the caller leads `teamId`. */
  async function assertLeadsTeamForCreate(db, accountability, teamId, message) {
    if (!accountability?.user) return          // system context (cron/endpoint)
    if (accountability.admin) return           // full admins bypass by design
    if (!(await actorLeadsTeam(db, accountability, teamId))) {
      throw kscwScopeError(message, 403, 'NOT_TEAM_LEADER')
    }
  }

  // hall_slots: a slot's teams arrive as the `teams` M2M payload, so the guard
  // reads the payload rather than a column. A slot created with no team at all is
  // refused for a non-admin — an unowned slot on the shared Hallenplan is a
  // club-level act.
  filter('hall_slots.items.create', async (payload, _meta, { database: db, accountability }) => {
    if (!accountability?.user || accountability.admin) return payload
    const links = Array.isArray(payload?.teams) ? payload.teams : []
    const teamIds = links.map((l) => toIdValue(typeof l === 'object' ? (l.teams_id ?? l) : l)).filter((v) => v != null)
    if (teamIds.length === 0) {
      throw kscwScopeError('A hall slot must be created for a team you coach or are responsible for', 403, 'NOT_TEAM_LEADER')
    }
    for (const teamId of teamIds) {
      await assertLeadsTeamForCreate(db, accountability, teamId, 'You can only create hall slots for teams you coach or are responsible for')
    }
    return payload
  })

  // hall_slots_teams: attaching a team to an existing slot. Guarding only the
  // team side is enough — this is what a takeover would use to graft another
  // team's slot onto itself.
  filter('hall_slots_teams.items.create', async (payload, _meta, { database: db, accountability }) => {
    await assertLeadsTeamForCreate(db, accountability, toIdValue(payload?.teams_id),
      'You can only attach hall slots to teams you coach or are responsible for')
    return payload
  })

  filter('events_teams.items.create', async (payload, _meta, { database: db, accountability }) => {
    await assertLeadsTeamForCreate(db, accountability, toIdValue(payload?.teams_id),
      'You can only target events at teams you coach or are responsible for')
    return payload
  })

  // team_invites: an invite is a bearer credential redeemed by an
  // UNAUTHENTICATED endpoint whose raw-knex transaction never reaches the
  // member_teams guard above. Minting one for a team you do not lead is
  // therefore a direct route onto that team's roster.
  filter('team_invites.items.create', async (payload, _meta, { database: db, accountability }) => {
    await assertLeadsTeamForCreate(db, accountability, toIdValue(payload?.team),
      'You can only invite people to a team you coach or are responsible for')
    return payload
  })

  // polls: a TEAM poll must belong to a team the caller leads. A chat poll
  // (team null, conversation set) is created by /kscw/messaging/polls in system
  // context and is not this guard's business.
  filter('polls.items.create', async (payload, _meta, { database: db, accountability }) => {
    if (!accountability?.user || accountability.admin) return payload
    const teamId = toIdValue(payload?.team)
    if (teamId == null) return payload
    await assertLeadsTeamForCreate(db, accountability, teamId,
      'You can only create polls for teams you coach or are responsible for')
    return payload
  })

  // ── Game guest invitations (migration 271) ─────────────────────
  // Opening a game to another team / to individual players. The Directus grant for
  // CREATE is necessarily unfiltered (a relational validation cannot be resolved
  // against a create payload — see the setPerm note in setup-permissions.mjs), so
  // this BLOCKING filter is the real scope gate: you may only open a game whose own
  // team you coach or are responsible for. Without it any coach could invite
  // themselves onto any game in the club.
  async function guestGameLeadGuard(payload, db, accountability, verb) {
    if (!accountability?.user) return payload  // system context (trigger/cron/cascade)
    if (accountability.admin) return payload
    const gameId = toIdValue(payload?.game)
    const game = gameId != null
      ? await db('games').where('id', gameId).select('kscw_team').first()
      : null
    if (!game || !(await actorLeadsTeam(db, accountability, game.kscw_team))) {
      throw kscwScopeError(`You can only ${verb} for a game of a team you coach or are responsible for`, 403, 'NOT_TEAM_LEADER')
    }
    return payload
  }

  // Actor capture. These rows are written through the items API, so Directus
  // revision-logs them — but the roster UI wants to name the inviter inline without
  // reading the revision trail, and the trigger that materializes a team opening into
  // per-person rows copies these two columns down onto every child row.
  async function stampInviter(payload, db, accountability) {
    if (!accountability?.user) return payload
    const me = await db('members').where('user', accountability.user)
      .select('first_name', 'last_name', 'email').first()
    if (!me) return payload
    payload.invited_by_name = `${me.first_name ?? ''} ${me.last_name ?? ''}`.trim() || null
    payload.invited_by_email = me.email ?? null
    return payload
  }

  for (const coll of ['game_guests', 'game_guest_teams']) {
    const verb = coll === 'game_guests' ? 'invite a player' : 'open a game to a team'
    filter(`${coll}.items.create`, async (payload, _meta, { database: db, accountability }) => {
      await guestGameLeadGuard(payload, db, accountability, verb)
      return stampInviter(payload, db, accountability)
    })
  }

  // Tell the invited player. This is the whole point of the feature — the game lands
  // on their home page and calendar silently otherwise, and a cup game they were
  // borrowed for is exactly the one they must not miss.
  //
  // Fires per materialized row, which covers both paths: an individual invite is one
  // row, and a team opening is one row per player written by the migration-271
  // trigger. Trigger-written rows carry no accountability, so the guard above lets
  // them through and this action still runs.
  async function notifyGameGuest(guestId) {
    const guest = await database('game_guests').where('id', guestId)
      .select('id', 'game', 'member', 'via_team').first()
    if (!guest?.member || !guest.game) return

    const game = await database('games').where('id', guest.game)
      .select('id', 'home_team', 'away_team', 'date', 'kscw_team', 'status').first()
    if (!game || !game.date) return
    // A past or called-off game is not worth a push.
    const dateStr = safeDateStr(game.date)
    const today = safeDateStr(new Date())
    if (!dateStr || (today && dateStr < today)) return
    if (['completed', 'postponed', 'cancelled'].includes(game.status ?? '')) return

    // Dormant accounts get the in-app row but no push, mirroring notifyTrainingCancelled.
    const member = await database('members').where('id', guest.member)
      .select('id', 'wiedisync_active').first()
    if (!member) return

    const teamRow = game.kscw_team != null
      ? await database('teams').where('id', game.kscw_team).select('name').first()
      : null
    const teamName = teamRow?.name || ''
    const matchup = `${game.home_team ?? ''} - ${game.away_team ?? ''}`.trim()
    const dateFmt = dateStr.split('-').reverse().join('.')  // dd.mm.yyyy

    await database('notifications').insert({
      member: guest.member,
      type: 'game_invite',
      title: 'game_invite',
      body: JSON.stringify({ team: teamName, matchup, date: dateFmt }),
      activity_type: 'game',
      activity_id: String(game.id),
      team: game.kscw_team ?? null,
      read: false,
    })

    if (!member.wiedisync_active) return
    await sendLocalizedPush(
      database,
      [guest.member],
      (ids, title, body) => sendPushToMembers(database, ids, title, body, `${FRONTEND_URL}/games`, `game-invite-${game.id}`, log),
      'gameInvite.title',
      'gameInvite.body',
      { team: teamName, matchup, date: dateFmt },
    )
  }

  async function notifyGuestIds(ids, source) {
    for (const id of ids) {
      try { await notifyGameGuest(id) }
      catch (err) { log.error({ msg: `[game-guest-notify] ${source}: ${err.message}`, event: 'game_guest_notify', guestId: id, stack: err.stack }) }
    }
  }

  // Individually invited player — one items-API insert, one notification.
  action('game_guests.items.create', async ({ key, keys }) => {
    await notifyGuestIds(Array.isArray(keys) ? keys : (key != null ? [key] : []), 'individual')
  })

  // A team opening materializes its per-person rows inside Postgres (migration 271),
  // which never touches the items API — so `game_guests.items.create` above does NOT
  // fire for them and the borrowed players would be invited in silence. Read the rows
  // the trigger just wrote and notify from here instead. The trigger runs in the same
  // transaction as this insert, so by the time an action hook (post-commit) runs they
  // are all there.
  action('game_guest_teams.items.create', async ({ key, keys }) => {
    const openingIds = Array.isArray(keys) ? keys : (key != null ? [key] : [])
    if (openingIds.length === 0) return
    try {
      const openings = await database('game_guest_teams').whereIn('id', openingIds).select('game', 'team')
      if (openings.length === 0) return
      const rows = await database('game_guests')
        .whereIn('game', openings.map(o => o.game))
        .whereIn('via_team', openings.map(o => o.team))
        .select('id')
      await notifyGuestIds(rows.map(r => r.id), 'team-opening')
    } catch (err) {
      log.error({ msg: `[game-guest-notify] opening: ${err.message}`, event: 'game_guest_notify', stack: err.stack })
    }
  })

  // ── Hall-slot → trainings cascade ──────────────────────────────
  // Snapshot pre-state in a filter hook (Directus has already merged the
  // payload into `payload` here, but we need the BEFORE values to detect
  // what actually changed). The action then re-reads post-state and
  // applies the cascade. Map is keyed by slotId so concurrent updates
  // don't clobber each other's snapshots.
  const pendingSlotPreState = new Map()

  filter('hall_slots.items.update', async (payload, meta) => {
    try {
      const keys = Array.isArray(meta?.keys) ? meta.keys : (meta?.key != null ? [meta.key] : [])
      for (const k of keys) {
        if (!pendingSlotPreState.has(k)) {
          const pre = await snapshotSlot(database, k)
          if (pre) pendingSlotPreState.set(k, pre)
        }
      }
    } catch (err) {
      log.error({ msg: `[slot-cascade] snapshot failed: ${err.message}`, event: 'slot_cascade_snapshot_failed', stack: err.stack })
    }
    return payload
  })

  action('hall_slots.items.update', async ({ keys }) => {
    const ids = Array.isArray(keys) ? keys : (keys != null ? [keys] : [])
    for (const id of ids) {
      const pre = pendingSlotPreState.get(id)
      pendingSlotPreState.delete(id)
      try {
        const createdIds = await cascadeSlotUpdate(database, id, pre, log)
        for (const tid of createdIds || []) await applyTrainingAutoRSVP(tid)
      } catch (err) {
        log.error({ msg: `[slot-cascade] update cascade failed: ${err.message}`, event: 'slot_cascade_update_failed', slot: id, stack: err.stack })
      }
    }
    // Cascaded trainings may land on game days — apply the game sweeps now.
    await runGameTrainingSweeps()
  })

  action('hall_slots.items.create', async ({ key }) => {
    try {
      const createdIds = await generateInitialTrainings(database, key, log)
      for (const tid of createdIds || []) await applyTrainingAutoRSVP(tid)
    } catch (err) {
      log.error({ msg: `[slot-cascade] initial generation failed: ${err.message}`, event: 'slot_cascade_create_failed', slot: key, stack: err.stack })
    }
    // Generated trainings may land on game days — apply the game sweeps now.
    await runGameTrainingSweeps()
  })

  // Slot deletion → wipe future trainings derived from it. Historic trainings
  // (date < today) stay so attendance records aren't lost; future ones are
  // generator output and would otherwise dangle with a now-invalid hall_slot
  // FK. Participations are deleted in the same txn (no FK cascade — activity_id
  // is a polymorphic int, not a real FK).
  filter('hall_slots.items.delete', async (keys) => {
    const ids = Array.isArray(keys) ? keys : (keys != null ? [keys] : [])
    if (!ids.length) return keys
    try {
      const futureIds = await database('trainings')
        .whereIn('hall_slot', ids)
        .andWhere('date', '>=', database.raw("(now() AT TIME ZONE 'Europe/Zurich')::date"))
        .pluck('id')
      if (futureIds.length) {
        await database('participations')
          .where('activity_type', 'training')
          .whereIn(database.raw('activity_id::int'), futureIds)
          .delete()
        const deleted = await database('trainings').whereIn('id', futureIds).delete()
        log.info({ msg: `[slot-cascade] deleted ${deleted} future trainings for slot(s) ${ids.join(',')}`, event: 'slot_cascade_delete', slots: ids, count: deleted })
      }
    } catch (err) {
      log.error({ msg: `[slot-cascade] delete cascade failed: ${err.message}`, event: 'slot_cascade_delete_failed', slots: ids, stack: err.stack })
    }
    return keys
  })

  // ── Training occurrence tombstones (migration 162) ─────────────────
  // A coach deleting one training, or editing its time so it detaches from its
  // slot, must STICK — otherwise the slot generator (nightly top-up + on-edit
  // fill) sees that (hall_slot, date) "missing" and resurrects it (surfaced
  // 2026-06-30: D4's Monday 20:00 phantom that came back every night). We
  // tombstone the vacated (hall_slot, date) in `training_slot_skips`; the three
  // generators in slot-cascade.js filter against it. The cascade's own raw-knex
  // INSERT/UPDATE/DELETE on `trainings` do NOT fire these items hooks, so only
  // genuine user/API edits land here — no feedback loop.
  const pendingTrainingPreState = new Map()
  // The filter snapshots pre-state keyed by training id and the action drains
  // it. If an update is aborted AFTER this filter runs (a later filter throws,
  // a DB constraint rejects the write), the matching action never fires and the
  // entry would leak for the process lifetime. Stamp each entry and sweep stale
  // ones (a filter→action cycle is sub-second; 5 min is a generous ceiling).
  const PRESTATE_TTL_MS = 5 * 60 * 1000
  const prunePendingTrainingPreState = () => {
    if (pendingTrainingPreState.size === 0) return
    const cutoff = Date.now() - PRESTATE_TTL_MS
    for (const [k, v] of pendingTrainingPreState) {
      if (!v || v.ts == null || v.ts < cutoff) pendingTrainingPreState.delete(k)
    }
  }
  const isoDay = (d) => {
    if (!d) return null
    if (d instanceof Date) {
      const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0')
      return `${y}-${m}-${day}`
    }
    return String(d).slice(0, 10)
  }

  // DELETE → tombstone each slot-linked occurrence (in the filter, before the
  // row is gone — mirrors the hall_slots delete hook). Standalone trainings
  // (no hall_slot) need none: nothing regenerates them.
  filter('trainings.items.delete', async (keys, _meta, ctx) => {
    const ids = Array.isArray(keys) ? keys : (keys != null ? [keys] : [])
    if (!ids.length) return keys
    try {
      const rows = await database('trainings').whereIn('id', ids).select('hall_slot', 'date')
      const actor = ctx?.accountability?.user || null
      for (const row of rows) {
        if (row?.hall_slot) await addTrainingSkip(database, row.hall_slot, row.date, actor)
      }
    } catch (err) {
      log.error({ msg: `[slot-cascade] delete tombstone failed: ${err.message}`, event: 'training_skip_del_failed', stack: err.stack })
    }
    return keys
  })

  // UPDATE → if an edit moves/detaches a slot-linked occurrence, tombstone the
  // vacated (slot, date); if it (re)attaches one, clear that tombstone. A pure
  // time/note/cancel edit keeps (hall_slot, date) put → nothing to do. Pre-state
  // is snapshotted in the filter (keyed by training id); the action re-reads the
  // committed post-state and diffs. (Runs alongside the existing cancel-notify
  // trainings.items.update action — Directus fans out to both.)
  filter('trainings.items.update', async (payload, meta, ctx) => {
    try {
      if (payload && !('hall_slot' in payload) && !('date' in payload)) return payload
      prunePendingTrainingPreState()
      const keys = Array.isArray(meta?.keys) ? meta.keys : (meta?.key != null ? [meta.key] : [])
      for (const k of keys) {
        if (!pendingTrainingPreState.has(k)) {
          const pre = await database('trainings').where('id', k).first('hall_slot', 'date')
          if (pre) pendingTrainingPreState.set(k, { pre, actor: ctx?.accountability?.user || null, ts: Date.now() })
        }
      }
    } catch (err) {
      log.error({ msg: `[slot-cascade] update tombstone snapshot failed: ${err.message}`, event: 'training_skip_upd_snapshot_failed', stack: err.stack })
    }
    return payload
  })

  action('trainings.items.update', async ({ keys }) => {
    const ids = Array.isArray(keys) ? keys : (keys != null ? [keys] : [])
    for (const id of ids) {
      const snap = pendingTrainingPreState.get(id)
      pendingTrainingPreState.delete(id)
      if (!snap) continue
      try {
        const post = await database('trainings').where('id', id).first('hall_slot', 'date')
        if (!post) continue
        const preSlot = snap.pre.hall_slot ?? null
        const postSlot = post.hall_slot ?? null
        const samePair = preSlot === postSlot && isoDay(snap.pre.date) === isoDay(post.date)
        if (preSlot != null && !samePair) await addTrainingSkip(database, preSlot, snap.pre.date, snap.actor)
        if (postSlot != null && !samePair) await clearTrainingSkip(database, postSlot, post.date)
      } catch (err) {
        log.error({ msg: `[slot-cascade] update tombstone failed: ${err.message}`, event: 'training_skip_upd_failed', training: id, stack: err.stack })
      }
    }
  })

  // Nightly rolling top-up for indefinite training slots. A slot with an
  // explicit `valid_until` generates its whole remaining window in one pass;
  // an undated one keeps ~12 weeks populated and needs the daily push to keep
  // that horizon advancing. Runs at 02:00 UTC (04:00 Zurich, after most sync
  // crons) to give a fresh batch each morning. logCronRun gives the /status
  // dashboard a heartbeat to confirm the cron is alive.
  schedule('0 2 * * *', async () => {
    const startedAt = Date.now()
    try {
      const created = await topUpIndefiniteSlots(database, log, async (ids) => {
        for (const tid of ids) await applyTrainingAutoRSVP(tid)
      })
      log.info({ msg: `[slot-cascade] nightly top-up: ${created} trainings created`, event: 'slot_topup_cron_done', count: created, duration_ms: Date.now() - startedAt })
    } catch (err) {
      log.error({ msg: `[slot-cascade] nightly top-up failed: ${err.message}`, event: 'slot_topup_cron_failed', stack: err.stack })
    }
  })

  // Home-game → training auto-shorten (migration 191). Nightly at 02:20 UTC,
  // right after the top-up above so freshly generated trainings get shortened
  // the same night. Also swept on games.items.* actions for admin-UI edits;
  // sv-sync/bp-sync/spielplanung write games via raw knex (no items hooks),
  // which the nightly run covers.
  schedule('20 2 * * *', async () => {
    try {
      const res = await sweepGameTrainingShorten(database, log)
      log.info({ msg: `[game-training-shorten] nightly sweep: ${res.shortened} shortened, ${res.restored} restored, ${res.ownCancelled} own-team cancelled`, event: 'game_training_shorten_cron_done', ...res })
    } catch (err) {
      log.error({ msg: `[game-training-shorten] nightly sweep failed: ${err.message}`, event: 'game_training_shorten_cron_failed', stack: err.stack })
      logCronError('game_training_shorten', err)
    }
    try {
      const res = await sweepGameClashDeclines(database, log)
      log.info({ msg: `[game-clash-decline] nightly sweep: ${res.overridden + res.seeded} declined, ${res.deleted + res.reverted} unwound`, event: 'game_clash_decline_cron_done', ...res })
    } catch (err) {
      log.error({ msg: `[game-clash-decline] nightly sweep failed: ${err.message}`, event: 'game_clash_decline_cron_failed', stack: err.stack })
      logCronError('game_clash_decline', err)
    }
  })

  // Training auto-confirm backstop, 02:40 UTC — after the 02:00 top-up (so the
  // night's new trainings are already there) and after the 02:20 shorten/cancel
  // sweep (so trainings cancelled by it are skipped, `cancelled = false`).
  //
  // The games counterpart runs off the back of each SVRZ/Basketplan sync, which
  // is why the roster-join gap only ever bit trainings. Both are pure NOT
  // EXISTS + ON CONFLICT DO NOTHING, so a no-op night costs one statement.
  schedule('40 2 * * *', async () => {
    try {
      const n = await sweepTrainingAutoConfirm(database, log)
      log.info({ msg: `[training-auto-confirm-sweep] nightly sweep: ${n} confirmed`, event: 'training_auto_confirm_cron_done', count: n })
    } catch (err) {
      log.error({ msg: `[training-auto-confirm-sweep] nightly sweep failed: ${err.message}`, event: 'training_auto_confirm_cron_failed', stack: err.stack })
      logCronError('training_auto_confirm_sweep', err)
    }
  })

  // ── Cron: auto-file the Volleymanager Einsatzliste from confirmed RSVPs ──
  //
  // Picks up games whose kickoff is ~60 min out and whose effective
  // auto_nomination_list flag is on, and spawns scripts/vm-push-nomination.mjs to
  // file the nomination list in VM. Opt-in per game, defaulting to the team's
  // setting — the same override cascade as auto-confirm RSVP:
  //
  //   COALESCE(games.auto_nomination_list,
  //            teams.features_enabled->>'auto_nomination_list',
  //            false)
  //
  // Resolved HERE, at push time, rather than stamped at game-create time — which is
  // why this needs no backfill hook when the team toggle flips, and why the ~350
  // games/season that sv-sync inserts via raw knex (bypassing every items hook) are
  // covered for free.
  //
  // The window is deliberately wide (T-65 → T-35) and the job is idempotent, so a
  // failed or slow tick simply retries on the next one. VM requires the list closed
  // by ~T-40, so the last useful attempt is around then; after that the coach files
  // it by hand. Anything already `closed` or `skipped` is never touched again.
  //
  // ⚠ This writes into the real Swiss Volley production system on BOTH dev and prod
  // — there is no VM staging. The worker refuses to close a list that VM flags with
  // an unresolved fineable issue (too few players, no coach); see vm-push-nomination.mjs.
  const NOMINATION_LEAD_MS = 65 * 60 * 1000
  const NOMINATION_FLOOR_MS = 35 * 60 * 1000
  let nominationRunning = false

  async function spawnNominationPush(gameId) {
    const { spawn } = await import('node:child_process')
    const { openSync } = await import('node:fs')
    let logOut
    try { logOut = openSync('/directus/logs/vm-nomination.log', 'a') } catch { logOut = 'ignore' }
    // Scoped env — forward only what the child needs (no process.env spread).
    const env = {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      VM_USERNAME: process.env.VM_USERNAME,
      VM_PASSWORD: process.env.VM_PASSWORD,
      KSCW_SVRZ_CLUB_ID: process.env.KSCW_SVRZ_CLUB_ID || '',
      DIRECTUS_URL: 'http://127.0.0.1:8055',
      DIRECTUS_SYNC_EMAIL: process.env.DIRECTUS_SYNC_EMAIL,
      DIRECTUS_SYNC_PASSWORD: process.env.DIRECTUS_SYNC_PASSWORD,
      GAME_ID: String(gameId),
      // Lets the worker refuse to write from the dev DB — VM has no staging, so a dev
      // push would file a real Einsatzliste. See vm-push-nomination.mjs.
      DB_DATABASE: process.env.DB_DATABASE || '',
      VM_NOMINATION_ALLOW_DEV_WRITE: process.env.VM_NOMINATION_ALLOW_DEV_WRITE || '',
      ...(process.env.VM_NOMINATION_DRY_RUN ? { DRY_RUN: '1' } : {}),
    }
    const child = spawn('node', ['/directus/scripts/vm-push-nomination.mjs'], {
      detached: true, stdio: ['ignore', logOut, logOut], env,
    })
    child.unref()
  }

  schedule('*/5 * * * *', async () => {
    if (!process.env.VM_USERNAME || !process.env.VM_PASSWORD) return
    if (nominationRunning) {
      log.info({ msg: '[vm-nomination] tick skipped: a run is already in progress', event: 'vm_nomination_cron_busy' })
      return
    }
    nominationRunning = true
    const startedAt = Date.now()
    try {
      // Candidate games are filtered in SQL on everything that is cheap, then on
      // kickoff in JS — `games.date` + `games.time` are separate DST-naive columns,
      // so the instant has to come from gameStartMs(), not from date+time arithmetic
      // in Postgres.
      // ── Reclaim stale leases, INDEPENDENTLY of the push window ──
      //
      // ⚠⚠ The lease alone is not enough, and this is the second time this shape
      // has bitten. A claim taken at lead < 45 min whose worker dies expires at
      // lead < 35 min — i.e. below NOMINATION_FLOOR_MS, so the `due` filter below
      // will never offer that game again — while `vm_nomination_status='pending'`
      // simultaneously hides the coach's "Push now" button, which only renders on
      // 'failed'. The list would then be unreachable by cron AND by hand, for ever,
      // in exactly the last minutes of the window where filing by hand is the whole
      // fallback.
      //
      // So a lease that ran out is resolved to 'failed' rather than left 'pending':
      // that is the state the UI offers a button for and the one the cron retries.
      // Deliberately NOT restricted to `due` games or to today — a stranded row must
      // be reachable whenever the tick runs. Losing a genuinely-still-running worker
      // to this is not possible below the lease interval, and above it the worker is
      // gone by definition (it is detached inside a container that has restarted).
      const reclaimed = await database('games')
        .whereRaw("COALESCE(vm_nomination_status, '') = 'pending'")
        .whereRaw("COALESCE(vm_nomination_claimed_at, 'epoch'::timestamptz) < now() - interval '10 minutes'")
        .update({
          vm_nomination_status: 'failed',
          vm_nomination_error: 'Push worker did not finish (claim expired) — file the list by hand or press Push now',
          vm_nomination_claimed_at: null,
        })
      if (reclaimed) {
        log.warn({
          msg: `[vm-nomination] ${reclaimed} stale push claim(s) expired — reset to 'failed' so the cron and the coach's button can reach them`,
          event: 'vm_nomination_claim_reclaimed', count: reclaimed,
        })
      }

      const rows = await database('games as g')
        .leftJoin('teams as t', 't.id', 'g.kscw_team')
        .whereRaw("g.game_id LIKE 'vb_%'")
        .where('g.status', 'scheduled')
        .whereNotNull('g.kscw_team')
        .whereNotNull('g.time')
        .whereRaw("COALESCE(g.vm_nomination_status, '') NOT IN ('closed', 'skipped')")
        .whereRaw(
          "COALESCE(g.auto_nomination_list, NULLIF(t.features_enabled->>'auto_nomination_list', '')::boolean, false) = true",
        )
        .whereBetween('g.date', [
          new Date(Date.now() - 86400000).toISOString().slice(0, 10),
          new Date(Date.now() + 86400000).toISOString().slice(0, 10),
        ])
        .select('g.id', 'g.date', 'g.time')

      const now = Date.now()
      const due = rows.filter((g) => {
        const kickoff = gameStartMs(g)
        if (kickoff == null) return false
        const lead = kickoff - now
        return lead <= NOMINATION_LEAD_MS && lead >= NOMINATION_FLOOR_MS
      })
      if (!due.length) return

      // ── Claim each game before spawning (migration 354) ──
      //
      // The worker files an Einsatzliste into the REAL Swiss Volley production
      // system, and it only writes vm_nomination_status at the very END of its
      // run — so between spawn and finish the row still looks eligible and the
      // next tick (or a coach's "Push now") spawns a SECOND worker on the same
      // fixture. Two workers both read "no list exists" in VM and both create
      // one, and whichever finishes last stamps its journal over the other's.
      //
      // One UPDATE is atomic under READ COMMITTED: a second claimant blocks on
      // the row lock, re-evaluates its WHERE against the committed new version
      // and matches 0 rows. Per-game, so two different fixtures never block
      // each other.
      //
      // ⚠ The claim is a LEASE, not a flag. vm_nomination_claimed_at is the
      // whole point: an earlier attempt claimed 'pending' with no expiry and a
      // worker lost to an `ext:deploy` restart stranded the row for ever — the
      // cron then skipped it AND the coach's manual push (which only renders
      // for status 'failed') could not reach it, so the list could never be
      // filed at all. Here a stale claim is taken back after 10 minutes, and
      // NULL coalesces to 'epoch' on purpose so an unclaimed 'pending' (an
      // older build's write) is reclaimable immediately rather than stranded.
      //
      // The candidate SELECT above is deliberately left alone — it must keep
      // offering stale 'pending' rows for exactly that reason, and this
      // predicate is the single place that decides. The worker overwrites
      // vm_nomination_status in finish(), so the documented retry behaviour
      // ('filled' / 'failed' are re-attempted on the next tick) is unchanged.
      let spawned = 0
      for (const g of due) {
        const claimed = await database('games')
          .where('id', g.id)
          // Re-check the terminal states: a worker may have finished between
          // the SELECT above and this UPDATE, and re-claiming a closed list
          // would file it a second time.
          .whereRaw("COALESCE(vm_nomination_status, '') NOT IN ('closed', 'skipped')")
          .whereRaw(
            "(COALESCE(vm_nomination_status, '') <> 'pending'"
            + " OR COALESCE(vm_nomination_claimed_at, 'epoch'::timestamptz) < now() - interval '10 minutes')",
          )
          .update({ vm_nomination_status: 'pending', vm_nomination_claimed_at: database.fn.now() })
        if (claimed !== 1) {
          log.warn({
            msg: `[vm-nomination] game ${g.id} skipped: a push is already in flight (claim lost)`,
            event: 'vm_nomination_claim_lost', gameId: g.id,
          })
          continue
        }
        await spawnNominationPush(g.id)
        spawned += 1
      }
      log.info({ msg: `[vm-nomination] spawned ${spawned} push(es) of ${due.length} due`, event: 'vm_nomination_cron_done', count: spawned })
      await logCronRun(database, 'vm_nomination', { status: 'ok', durationMs: Date.now() - startedAt, rowsChanged: spawned })
    } catch (err) {
      log.error({ msg: `[vm-nomination] cron failed: ${err.message}`, event: 'vm_nomination_cron_failed', stack: err.stack })
      logCronError('vm_nomination', err)
      await logCronRun(database, 'vm_nomination', { status: 'error', durationMs: Date.now() - startedAt, errorMessage: err.message })
    } finally {
      nominationRunning = false
    }
  })

  action('games.items.create', runGameTrainingSweeps)
  action('games.items.update', runGameTrainingSweeps)
  action('games.items.delete', runGameTrainingSweeps)
  // (runGameTrainingSweeps is defined near the trainings.items.create action
  // — it is also re-run whenever trainings appear or move.)

  // ── Fines (migration 069) — escalation engine + notifications ──
  //
  // filter('fines.items.create'):
  //   `member` may be null — that's a TEAM-level fine (migration 350), owed by
  //   the team itself. It skips the escalation engine (which counts offenses
  //   per member×team×category) and therefore needs an explicit amount.
  //   If the leader leaves `amount` null, compute it via the SQL helper
  //   kscw_compute_fine_amount(member,team,category) and snapshot
  //   tier_offense + reset_window_at_issue onto the row. If amount is
  //   non-null (leader override), still snapshot the tier metadata for
  //   audit but DON'T overwrite their amount. Auto-fill `issued_by` from
  //   accountability.user → members.id and force `auto_issued = false` for
  //   every human caller — only system context (the deadline sweep below)
  //   may set it true, so the flag cannot be forged from the API.
  //
  // filter('fines.items.update'):
  //   Block edits to amount / category / reason / member / team to enforce
  //   the "waive + reissue" audit model. Status flips + payment fields +
  //   waive metadata remain editable. Admins (accountability.admin) bypass.
  //
  // action('fines.items.create'):
  //   Push + email the member: "{team} • CHF X: {reason}".
  // action('fines.items.update'):
  //   Push the member on status → paid or waived.
  //
  // cron 'fines_reminder' (daily 09:00 UTC):
  //   For each member with ≥1 'open' fine, send a single rolled-up push
  //   ("You have N open fines — total CHF X"). Throttled by `notes`
  //   marker on the fine to avoid repeat-spam.
  const FINE_BLOCKED_UPDATE_FIELDS = ['amount', 'category', 'reason', 'member', 'team', 'tier_offense', 'reset_window_at_issue', 'auto_issued']

  function formatChf(amount, currency = 'CHF') {
    const n = Number(amount)
    if (!Number.isFinite(n)) return `${currency} ?`
    return `${currency} ${n.toFixed(2)}`
  }

  // Team-scope guard for fine writes — Directus enforces the team-scoped
  // update/delete filters but NOT create (no existing row to filter), so a
  // coach could otherwise POST a fine for ANY team. Passes for system context
  // + admins; a normal caller must coach / be responsible for `team`. Mirrors
  // scheduling_blocks.items.create. Throws the project scope-error on failure.
  async function assertFineTeamScope(accountability, db, teamId) {
    if (!accountability?.user) return   // system context (cron/hook)
    if (accountability.admin) return    // admins bypass
    if (teamId == null) {
      throw kscwScopeError('Fine requires a team', 400, 'INVALID_PAYLOAD')
    }
    const member = await db('members').where('user', accountability.user).first('id')
    if (!member) return // not a member — let Directus deny via its own policy
    // Coach/TR of the team — or a sport admin of that team's sport, which is
    // exactly the "override coach-only scope for cross-team rule edits +
    // correction of bad fines" that the Sport Admin `fines` grant documents.
    if (!(await actorLeadsTeam(db, accountability, teamId))) {
      throw kscwScopeError('You can only manage fines for teams you coach or are responsible for', 403, 'FORBIDDEN')
    }
  }

  filter('fines.items.create', async (payload, _meta, { accountability, database: db }) => {
    try {
      if (!payload) return payload
      // `member` is optional since migration 350: a member-less row is a
      // TEAM-level fine (forfait, missing scorer) owed by the team itself.
      if (!payload.team || !payload.category) {
        throw kscwScopeError('fines.create requires team, category', 400, 'INVALID_PAYLOAD')
      }
      const isTeamFine = payload.member == null

      // 0. Team-scope gate — caller must coach / be TR of payload.team.
      await assertFineTeamScope(accountability, db, payload.team)

      // 1. Resolve leader's member id from accountability (skip for system/admin).
      let issuerId = payload.issued_by ?? null
      if (!issuerId && accountability?.user) {
        const issuer = await db('members').where('user', accountability.user).first('id')
        if (issuer?.id) issuerId = issuer.id
      }

      // 2. Engine snapshot — runs whether or not amount was provided. Caller's
      //    amount wins (leader override), but tier_offense + reset_window_at_issue
      //    always reflect the engine's view for audit.
      //    A team fine has no offense counter (the engine keys on member×team×
      //    category), so it skips the engine entirely and must carry an amount.
      let computed = null
      try {
        if (!isTeamFine) {
          const res = await db.raw(
            'SELECT amount, tier_offense, reset_window_at_issue FROM kscw_compute_fine_amount(?::int, ?::int, ?::text)',
            [Number(payload.member), Number(payload.team), String(payload.category)],
          )
          computed = res?.rows?.[0] || null
        }
      } catch (err) {
        // Engine errors shouldn't block the insert — leaders can still issue
        // ad-hoc fines without a rule. Just log + skip snapshot.
        log.warn({ msg: `[fines] engine query failed: ${err.message}`, event: 'fines_engine_query_failed', payload: { member: payload.member, team: payload.team, category: payload.category } })
      }

      const filled = { ...payload }
      if (filled.amount == null) {
        if (!computed) {
          throw kscwScopeError(
            isTeamFine
              ? 'A team-level fine has no escalation tier — supply an explicit amount.'
              : 'No fine_rule for this team/category and no amount supplied — set an explicit amount or configure a rule first.',
            400, 'FINE_NO_RULE',
          )
        }
        filled.amount = computed.amount
      }
      if (computed) {
        filled.tier_offense = filled.tier_offense ?? computed.tier_offense
        filled.reset_window_at_issue = filled.reset_window_at_issue ?? computed.reset_window_at_issue
      }
      if (issuerId) filled.issued_by = issuerId
      // `auto_issued` is server-owned. Forced false for anyone carrying an
      // accountability.user, so a coach cannot POST a fine that claims the
      // system issued it. System context — the no-response deadline sweep in
      // the daily participation cron — is the one path allowed to set it, and
      // that flag is the whole difference between a charge a leader stands
      // behind and one nobody clicked.
      filled.auto_issued = accountability?.user ? false : payload.auto_issued === true
      return filled
    } catch (err) {
      // Security gates (scope + payload validation) must fail closed — never
      // swallow them and create the fine anyway.
      if (err?.code === 'INVALID_PAYLOAD' || err?.code === 'FINE_NO_RULE' || err?.code === 'FORBIDDEN') throw err
      log.error({ msg: `[fines] create filter: ${err.message}`, event: 'fines_create_filter_failed', stack: err.stack })
      return payload
    }
  })

  // Fine-rule creation is team-scoped the same way: a coach/TR may only
  // configure a fine_rule for a team they lead. The fine_rules update/delete
  // policy filters are team-scoped, but create isn't enforced by Directus —
  // this is the real gate.
  filter('fine_rules.items.create', async (payload, _meta, { accountability, database: db }) => {
    if (!payload) return payload
    await assertFineTeamScope(accountability, db, payload.team)
    return payload
  })

  filter('fines.items.update', async (payload, _meta, { accountability }) => {
    if (!payload) return payload
    if (accountability?.admin) return payload // admin bypass — manual fixups
    for (const f of FINE_BLOCKED_UPDATE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(payload, f)) {
        throw kscwScopeError(
          `Cannot edit ${f} on a fine — waive and reissue instead.`,
          403, 'FINE_IMMUTABLE_FIELD',
        )
      }
    }
    return payload
  })

  /**
   * Team-level fines (member IS NULL, migration 350) have no recipient of their
   * own — the Teamkasse owes them, not a person. Until now that meant NOBODY
   * was told: both fine actions bail on a member-less row and the reminder cron
   * skips them, so a team fine only existed for whoever happened to open
   * /fines. Fan the bell + push out to the team instead.
   *
   * `teamPeopleSql`, not a bare `member_teams` scan: a staff-only coach / team
   * responsible has no roster row, and they are exactly the people who settle a
   * Teamkasse fine. The placeholder is interpolated twice — bind the team id
   * twice.
   */
  async function notifyTeamFine(fine, kind) {
    const teamRow = await database('teams').where('id', fine.team).first('name')
    const teamName = teamRow?.name || `Team ${fine.team}`
    const amountStr = formatChf(fine.amount, fine.currency)
    const reasonStr = (fine.reason || '').trim().slice(0, 80) || ''

    const people = await database.raw(
      `SELECT e.member AS member
         FROM ${teamPeopleSql('?::integer')} e
         JOIN members m ON m.id = e.member
        WHERE m.wiedisync_active = true`,
      [fine.team, fine.team],
    )
    const recipientIds = [...new Set((people?.rows || []).map(r => r.member).filter(Boolean))]
    if (recipientIds.length === 0) return

    const type = kind === 'issued' ? 'team_fine_issued' : kind === 'paid' ? 'team_fine_paid' : 'team_fine_waived'
    const pushKey = kind === 'issued' ? 'teamFineIssued' : kind === 'paid' ? 'teamFinePaid' : 'teamFineWaived'

    await database('notifications').insert(recipientIds.map(rid => ({
      member: rid,
      type,
      title: type,
      body: JSON.stringify({ team: teamName, amount: amountStr, reason: reasonStr, fineId: fine.id }),
      activity_type: 'fine',
      activity_id: String(fine.id),
      team: fine.team,
      read: false,
    })))

    await sendLocalizedPush(
      database, recipientIds,
      (ids, title, body) => sendPushToMembers(database, ids, title, body, `${FRONTEND_URL}/fines`, `team-fine-${fine.id}-${kind}`, log),
      `${pushKey}.title`, `${pushKey}.body`,
      { team: teamName, amount: amountStr, reason: reasonStr },
    )
  }

  action('fines.items.create', async ({ key }) => {
    try {
      if (!key) return
      const fine = await database('fines').where('id', key).first(
        'id', 'member', 'team', 'category', 'amount', 'currency', 'reason', 'auto_issued',
      )
      if (!fine) return
      if (!fine.member) { await notifyTeamFine(fine, 'issued'); return }
      const team = await database('teams').where('id', fine.team).first('name')
      const teamName = team?.name || `Team ${fine.team}`
      const amountStr = formatChf(fine.amount, fine.currency)
      const reasonStr = (fine.reason || '').trim().slice(0, 80) || ''

      // In-app notification (always)
      await database('notifications').insert({
        member: fine.member,
        type: 'fine_issued',
        title: 'fine_issued',
        body: JSON.stringify({ team: teamName, amount: amountStr, reason: reasonStr, fineId: fine.id, category: fine.category }),
        activity_type: 'fine',
        activity_id: String(fine.id),
        team: fine.team,
        read: false,
      })

      // Push to the recipient — EXCEPT for the deadline sweep's own fines.
      // That sweep declines the member and fines them in one stroke, and
      // pushes once itself naming both; a second "New fine" buzz for the same
      // event is noise the member cannot act on separately. The bell entry
      // above still lands, so /fines stays one tap away.
      if (fine.auto_issued) return
      await sendLocalizedPush(
        database, [fine.member],
        (ids, title, body) => sendPushToMembers(database, ids, title, body, `${FRONTEND_URL}/fines`, `fine-${fine.id}`, log),
        'fineIssued.title', 'fineIssued.body',
        { team: teamName, amount: amountStr, reason: reasonStr },
      )
    } catch (err) {
      log.error({ msg: `[fines] create action: ${err.message}`, event: 'fines_create_action_failed', stack: err.stack })
    }
  })

  action('fines.items.update', async ({ keys, payload }) => {
    try {
      if (!Array.isArray(keys) || keys.length === 0) return
      const statusChanged = payload && Object.prototype.hasOwnProperty.call(payload, 'status')
      if (!statusChanged) return
      const newStatus = payload.status
      if (newStatus !== 'paid' && newStatus !== 'waived') return

      const rows = await database('fines').whereIn('id', keys).select(
        'id', 'member', 'team', 'amount', 'currency', 'reason',
      )
      for (const fine of rows) {
        if (!fine) continue
        // Team-level fine: the team settled it, so the team hears about it.
        if (!fine.member) { await notifyTeamFine(fine, newStatus); continue }
        const team = await database('teams').where('id', fine.team).first('name')
        const teamName = team?.name || `Team ${fine.team}`
        const amountStr = formatChf(fine.amount, fine.currency)
        const titleKey = newStatus === 'paid' ? 'finePaid.title' : 'fineWaived.title'
        const bodyKey  = newStatus === 'paid' ? 'finePaid.body'  : 'fineWaived.body'

        await database('notifications').insert({
          member: fine.member,
          type: newStatus === 'paid' ? 'fine_paid' : 'fine_waived',
          title: newStatus === 'paid' ? 'fine_paid' : 'fine_waived',
          body: JSON.stringify({ team: teamName, amount: amountStr, fineId: fine.id }),
          activity_type: 'fine',
          activity_id: String(fine.id),
          team: fine.team,
          read: false,
        })
        await sendLocalizedPush(
          database, [fine.member],
          (ids, title, body) => sendPushToMembers(database, ids, title, body, `${FRONTEND_URL}/fines`, `fine-${fine.id}-${newStatus}`, log),
          titleKey, bodyKey,
          { team: teamName, amount: amountStr },
        )
      }
    } catch (err) {
      log.error({ msg: `[fines] update action: ${err.message}`, event: 'fines_update_action_failed', stack: err.stack })
    }
  })

  // Daily reminder for open fines older than 14 days. Single rolled-up push
  // per member per day (kscw_fines_reminder_sent_at column is too heavy — use
  // notification dedupe via tag `fines-reminder-YYYY-MM-DD`).
  schedule('0 9 * * *', async () => {
    const startedAt = Date.now()
    let sent = 0
    try {
      const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
      const rows = await database('fines')
        .where('status', 'open')
        .where('issued_at', '<=', cutoff)
        // Team-level fines (member IS NULL, migration 350) have no recipient —
        // aggregating them would push to a phantom member id.
        .whereNotNull('member')
        .select('member', 'amount', 'currency')
      if (rows.length === 0) {
        log.info({ msg: '[fines] reminder cron: no overdue fines', event: 'fines_reminder_cron_noop', duration_ms: Date.now() - startedAt })
        await logCronRun(database, 'fines_reminder', { status: 'ok', durationMs: Date.now() - startedAt })
        return
      }
      // Aggregate per member: count + total amount (assume CHF — multi-currency
      // out of scope for v1).
      const agg = new Map()
      for (const r of rows) {
        const m = agg.get(r.member) || { count: 0, total: 0 }
        m.count += 1
        m.total += Number(r.amount) || 0
        agg.set(r.member, m)
      }
      const today = new Date().toISOString().slice(0, 10)
      for (const [memberId, info] of agg) {
        const amountStr = formatChf(info.total)
        await sendLocalizedPush(
          database, [memberId],
          (ids, title, body) => sendPushToMembers(database, ids, title, body, `${FRONTEND_URL}/fines`, `fines-reminder-${today}`, log),
          'fineReminder.title', 'fineReminder.body',
          { count: info.count, amount: amountStr },
        )
        sent += 1
      }
      log.info({ msg: `[fines] reminder cron: ${sent} member(s) reminded`, event: 'fines_reminder_cron_done', sent, duration_ms: Date.now() - startedAt })
      await logCronRun(database, 'fines_reminder', { status: 'ok', durationMs: Date.now() - startedAt })
    } catch (err) {
      log.error({ msg: `[fines] reminder cron failed: ${err.message}`, event: 'fines_reminder_cron_failed', stack: err.stack })
      logCronError('fines_reminder', err)
      await logCronRun(database, 'fines_reminder', { status: 'error', durationMs: Date.now() - startedAt, errorMessage: err.message })
    }
  })

  // ── Audit hook — server-authoritative user_logs writes ─────────
  registerAuditHook({ action, schedule }, { database, logger })

  log.info('KSCW hooks loaded: role-sync (5 actions, 2 filters), Turnstile, member privacy, registration approval, Spielplaner scope guard, participation absence-aware decline, guest-level RSVP gate, edit-attribution (migration 046), audit log, fines engine (migration 069), 12 crons (validations+notifications in Postgres)')
}
