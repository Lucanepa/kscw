/**
 * Game Scheduling (Terminplanung)
 * Public: register, view slots, book home, propose away
 * Admin: generate slots, confirm away, block slot
 */

import crypto from 'crypto'
import { claimVmAccount, vmAccountHeldBy } from './vm-account-lock.js'
import nodemailer from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer/index.js'
import { SCHEDULING_URL, buildEmailLayout, buildInfoCard, escHtml } from './email-template.js'
import { VALID_LANGS, schedEmail, inviteEmail } from './terminplanung-emails.js'
import { writeUserLog } from './activity-log.js'
import { logCronRun } from './error-log.js'
import { seasonStartYear } from './season.js'

const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || ''

// Spielplanung mail identity. volleyball.kscw.ch is SES-verified (Easy DKIM),
// so SES can send From it with DKIM-aligned DMARC. From + replies both land on
// the dedicated Migadu mailbox spielplanung@volleyball.kscw.ch. (The kscw.ch
// apex stays ClubDesk's — we never send from it.)
//
// We send scheduling mail through the SES SMTP transport directly (see
// sendSchedulingMail) rather than the Directus MailService: the MailService
// forces the global EMAIL_FROM_NAME ("WiediSync") as the display name and
// treats `from` as the ADDRESS only, so a "Name <addr>" string collapses into a
// quoted junk local-part. Owning the MIME lets the From header carry the proper
// name below (and matches the mailbox reply path in scheduling-mailbox.js).
const SCHEDULING_FROM = 'spielplanung@volleyball.kscw.ch'
const SCHEDULING_REPLY_TO = 'spielplanung@volleyball.kscw.ch'
// Display name on the From header of outgoing scheduling mail (invites,
// reminders, confirmations). Keep in sync with FROM_NAME in scheduling-mailbox.js.
const SCHEDULING_FROM_NAME = 'KSCW VB Spielplanung'

// Wrap a German admin-notify body (the internal spielplanung-mailbox emails) in
// the shared branded layout. Dates must already be Swiss-formatted by the
// caller. `infoRows` (optional) renders as an info card between the lead and any
// trailing CTA paragraph.
function adminNotifyHtml({ title, lead, infoRows, ctaText, ctaUrl, ctaLabel }) {
  const para = (s) => `<p style="font-size:14px;color:#e2e8f0;line-height:1.6;margin:0 0 12px">${escHtml(s)}</p>`
  let body = ''
  if (lead) body += para(lead)
  if (infoRows && infoRows.length) {
    body += buildInfoCard(infoRows) + '<div style="height:12px;font-size:0;line-height:0">&nbsp;</div>'
  }
  if (ctaText) body += para(ctaText)
  return buildEmailLayout(body, {
    title,
    sport: 'vb',
    ctaUrl: ctaUrl || undefined,
    ctaLabel: ctaUrl ? (ctaLabel || 'Dashboard öffnen') : undefined,
  })
}

async function verifyTurnstile(token) {
  if (!TURNSTILE_SECRET) {
    console.error('[game-scheduling] TURNSTILE_SECRET not configured — rejecting request')
    return false
  }
  const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `secret=${TURNSTILE_SECRET}&response=${token}`,
  })
  return (await resp.json()).success === true
}

// Format a stored date / naive datetime for emails as Swiss { date: dd.mm.yyyy,
// time: HH:MM }. Values arrive either as ISO strings ('YYYY-MM-DD' or
// 'YYYY-MM-DDTHH:MM…Z', a naive wall-clock stored with a Z suffix) OR — when the
// pg driver hydrates a DATE/timestamp column from `select('*')` — as a JS Date
// object. Both the date columns (UTC midnight) and the naive datetimes are
// UTC-anchored, so read Date objects via their UTC parts; slice ISO strings.
// Never fall through to String(Date), which leaks 'Fri Oct 23 2026 … GMT'.
function fmtDateMail(val) {
  if (val instanceof Date && !isNaN(val)) {
    const dd = String(val.getUTCDate()).padStart(2, '0')
    const mo = String(val.getUTCMonth() + 1).padStart(2, '0')
    const yy = val.getUTCFullYear()
    const h = val.getUTCHours(), mi = val.getUTCMinutes()
    return {
      date: `${dd}.${mo}.${yy}`,
      time: (h || mi) ? `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}` : '',
    }
  }
  const m = String(val || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/)
  if (!m) return { date: String(val || ''), time: '' }
  return { date: `${m[3]}.${m[2]}.${m[1]}`, time: m[4] ? `${m[4]}:${m[5]}` : '' }
}

// Weekday (Mon-Fri) home games are always at 20:00 — the slot is just the hall
// window (e.g. 19:30-21:30). Weekend slots (Spielsamstag / junior Sunday) keep
// their start time. Used in confirm + finalize emails so they match the calendar
// / export / VM push. Returns 'HH:MM'.
function weekdayHomeTime(dateYmd, startTime) {
  const dow = new Date(`${String(dateYmd || '').slice(0, 10)}T00:00:00Z`).getUTCDay() // 0=Sun..6=Sat
  return dow >= 1 && dow <= 5 ? '20:00' : String(startTime || '').slice(0, 5)
}

export function registerGameScheduling(router, { database, logger, services, getSchema }) {
  const log = logger.child({ endpoint: 'game-scheduling' })

  // Guards a single in-flight manual SVRZ sync (the daily cron is separate).
  // Prevents a double-click spawning two ~minutes-long syncs, and lets the
  // route 409 a concurrent trigger instead of piling on.
  let svrzManualSyncRunning = false

  // Fire-and-forget push of a confirmed HOME booking's date/time/hall into
  // VolleyManager (volleymanager.volleyball.ch) via scripts/vm-push-game.mjs.
  // The child self-authenticates (sync admin + VM creds) and writes the push
  // result back onto the booking (vm_push_status/…). Never blocks the request;
  // a VM failure is recorded on the booking, not surfaced as an HTTP error.
  async function spawnVmPush(bookingId, { svrzId = null } = {}) {
    try {
      if (!process.env.VM_USERNAME || !process.env.VM_PASSWORD) {
        log.warn('VM push skipped: VM_USERNAME/VM_PASSWORD not set')
        return
      }
      if (!process.env.DIRECTUS_SYNC_EMAIL || !process.env.DIRECTUS_SYNC_PASSWORD) {
        log.warn('VM push skipped: DIRECTUS_SYNC_EMAIL/PASSWORD not set')
        return
      }
      const { spawn } = await import('node:child_process')
      const { openSync } = await import('node:fs')
      let logOut, logErr
      try { logOut = openSync('/directus/logs/vm-push.log', 'a'); logErr = logOut } catch { logOut = 'ignore'; logErr = 'ignore' }
      // Scoped env — forward only what the child needs (no process.env spread).
      const env = {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        VM_USERNAME: process.env.VM_USERNAME,
        VM_PASSWORD: process.env.VM_PASSWORD,
        VM_CLUB_UUID: process.env.VM_CLUB_UUID || '',
        KSCW_SVRZ_CLUB_ID: process.env.KSCW_SVRZ_CLUB_ID || '',
        DIRECTUS_URL: 'http://127.0.0.1:8055',
        DIRECTUS_SYNC_EMAIL: process.env.DIRECTUS_SYNC_EMAIL,
        DIRECTUS_SYNC_PASSWORD: process.env.DIRECTUS_SYNC_PASSWORD,
        BOOKING_ID: String(bookingId),
        ...(svrzId ? { FORCE_SVRZ_ID: String(svrzId) } : {}),
      }
      const child = spawn('node', ['/directus/scripts/vm-push-game.mjs'], { env, detached: true, stdio: ['ignore', logOut, logErr] })
      child.unref()
    } catch (e) {
      log.warn(`spawnVmPush failed: ${e.message}`)
    }
  }

  // An opponent's contact_email may hold SEVERAL addresses (a club often lists
  // multiple Spielplanverantwortliche) joined by comma/semicolon. Split into a
  // clean array so every contact receives the invite + all scheduling mail.
  // Directus MailService accepts a string[] for `to`/`cc`.
  // Scraped SVRZ contacts feed straight into the SMTP recipient list, so harden
  // each part: strip CR/LF (header-injection defence) and drop anything that
  // isn't a plausible bare address. Returns '' when nothing valid survives — the
  // send path skips + logs rather than handing garbage to the mailer.
  const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/
  function parseRecipients(v) {
    const clean = (s) => String(s).replace(/[\r\n]+/g, '').trim()
    const raw = Array.isArray(v) ? v.map(clean) : clean(v).split(/[,;]+/).map((s) => s.trim())
    const parts = raw.filter((s) => s && EMAIL_RE.test(s))
    return parts.length > 1 ? parts : (parts[0] || '')
  }

  // Send a Terminplanung email from the dedicated spielplanung identity.
  // Best-effort: callers wrap in try/catch so a mail failure never blocks the action.
  // attachments: optional nodemailer attachment objects ({ filename, content: Buffer, contentType }).
  async function sendSchedulingMail(to, subject, text, cc = null, html = null, attachments = null) {
    const recipients = parseRecipients(to)
    // No valid address survived sanitisation — skip the send (don't throw).
    if (!recipients || (Array.isArray(recipients) && recipients.length === 0)) {
      log.warn(`Scheduling email skipped: no valid recipient (subject: ${subject})`)
      return
    }
    const toList = Array.isArray(recipients) ? recipients : [recipients]
    const ccRecipients = cc ? parseRecipients(cc) : undefined
    const ccList = Array.isArray(ccRecipients) ? ccRecipients : (ccRecipients ? [ccRecipients] : [])

    // Build our own MIME so the From header carries the real display name
    // ("KSCW VB Spielplanung <…>"); the Directus MailService can't (see the
    // identity comment above). Sent over the container's SES SMTP, DKIM-aligned
    // for volleyball.kscw.ch — same transport the mailbox reply path uses.
    const messageId = `<${crypto.randomUUID()}@volleyball.kscw.ch>`
    const composer = new MailComposer({
      from: { name: SCHEDULING_FROM_NAME, address: SCHEDULING_FROM },
      to: toList,
      cc: ccList.length ? ccList : undefined,
      replyTo: SCHEDULING_REPLY_TO,
      subject,
      text,
      html: html || undefined,
      attachments: attachments && attachments.length ? attachments : undefined,
      messageId,
    })
    const raw = await composer.compile().build()
    const transport = nodemailer.createTransport({
      host: process.env.EMAIL_SMTP_HOST,
      port: Number(process.env.EMAIL_SMTP_PORT || 587),
      secure: String(process.env.EMAIL_SMTP_SECURE) === 'true',
      auth: { user: process.env.EMAIL_SMTP_USER, pass: process.env.EMAIL_SMTP_PASSWORD },
    })
    await transport.sendMail({ envelope: { from: SCHEDULING_FROM, to: [...toList, ...ccList] }, raw })
  }

  // Coach + team-responsible emails for a KSCW team (deduped, real addresses
  // only). M2M: teams_coaches / teams_responsibles (teams_id, members_id) join
  // members.email — same pattern as contact-form.js. Used to inform team staff
  // on slot confirmations: they're told the outcome, they don't decide.
  async function teamStaffEmails(teamId) {
    if (!teamId) return []
    const [coaches, trs] = await Promise.all([
      database('teams_coaches')
        .join('members', 'members.id', 'teams_coaches.members_id')
        .where('teams_coaches.teams_id', teamId)
        .whereNotNull('members.email')
        .select('members.email'),
      database('teams_responsibles')
        .join('members', 'members.id', 'teams_responsibles.members_id')
        .where('teams_responsibles.teams_id', teamId)
        .whereNotNull('members.email')
        .select('members.email'),
    ])
    return Array.from(new Set(
      [...coaches, ...trs].map(r => r.email).filter(e => e && !e.includes('@placeholder'))
    ))
  }

  // POST /kscw/terminplanung/register — opponent registers (public + Turnstile)
  router.post('/terminplanung/register', async (req, res) => {
    try {
      const { team_name, contact_name, contact_email, turnstile_token, kscw_team, language } = req.body
      if (!team_name || !contact_name || !contact_email || !kscw_team) {
        return res.status(400).json({ error: 'team_name, contact_name, contact_email, kscw_team required' })
      }
      // Audit EP-SCH-2: mirror the sibling public form (Turnstile + per-IP limit
      // + email-format validation), and never insert/email for a non-existent team.
      if (!rateLimit(registerAttempts, req, 8, 10 * 60 * 1000)) {
        return res.status(429).json({ error: 'Too many requests. Please try again later.' })
      }
      if (!EMAIL_RE.test(String(contact_email))) {
        return res.status(400).json({ error: 'Invalid email address' })
      }
      const lang = VALID_LANGS.includes(String(language || '').toLowerCase()) ? String(language).toLowerCase() : null
      if (!turnstile_token || !(await verifyTurnstile(turnstile_token))) {
        return res.status(400).json({ error: 'Captcha verification failed' })
      }

      const teamRow = await database('teams').where('id', kscw_team).first('id')
      if (!teamRow) {
        return res.status(400).json({ error: 'Invalid team' })
      }

      const token = crypto.randomBytes(16).toString('hex')
      const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString()

      await database('game_scheduling_opponents').insert({
        team_name, contact_name, contact_email: contact_email.toLowerCase().trim(),
        token, kscw_team, status: 'active', expires_at: expiresAt, language: lang,
      })

      // Send confirmation email (branded HTML + plain-text fallback).
      try {
        const accessUrl = `${SCHEDULING_URL}/terminplanung/${token}`
        const text = `Hallo ${contact_name},\n\nDein Zugangslink zur Spielplanung:\n${accessUrl}\n\nDieser Link ist 30 Tage gültig.\n\nKSC Wiedikon`
        const html = buildEmailLayout(
          `<p style="font-size:14px;color:#e2e8f0;line-height:1.6;margin:0 0 12px">Dein Zugangslink zur Spielplanung ist bereit. Der Link ist 30 Tage gültig.</p>`,
          {
            title: 'Spielplanung',
            sport: 'vb',
            greeting: `Hallo ${contact_name},`,
            ctaUrl: accessUrl,
            ctaLabel: 'Zur Spielplanung',
            footerExtra: 'Sportliche Grüsse, KSC Wiedikon',
          },
        )
        await sendSchedulingMail(contact_email, 'KSC Wiedikon – Spielplanung', text, null, html)
      } catch (mailErr) {
        log.warn(`Scheduling email failed: ${mailErr.message}`)
      }

      // Notify the spielplanung mailbox (auto-forwards to the VB Spielplanung
      // group) that a new opponent registered. Best-effort.
      try {
        const team = await database('teams').where('id', kscw_team).first('name')
        const kscw = `KSCW ${team?.name || ''}`.trim()
        const text = `${team_name} (${contact_name}, ${contact_email}) hat sich für die Spielplanung gegen ${kscw} registriert.`
        const html = adminNotifyHtml({
          title: 'Neue Anmeldung Spielplanung',
          lead: `${team_name} hat sich für die Spielplanung gegen ${kscw} registriert.`,
          infoRows: [
            { label: 'Team', value: team_name },
            { label: 'Kontakt', value: contact_name },
            { label: 'E-Mail', value: contact_email },
            { label: 'Gegner', value: kscw },
          ],
        })
        await sendSchedulingMail(SCHEDULING_REPLY_TO, `Neue Anmeldung Spielplanung – ${team_name} (${kscw})`, text, null, html)
      } catch (mailErr) {
        log.warn(`Scheduling group notice failed: ${mailErr.message}`)
      }

      // Do NOT return the token here — it travels via email only. Returning
      // it in the response would let any caller who passes Turnstile receive
      // a token bound to an arbitrary contact_email they don't control.
      res.json({ success: true, expires_at: expiresAt })
    } catch (err) {
      log.error({ msg: `terminplanung/register: ${err.message}`, endpoint: 'terminplanung/register', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // In-memory rate limiter for token lookups and writes (per IP)
  const tokenAttempts = new Map() // ip → { count, resetAt }
  const writeAttempts = new Map() // ip → { count, resetAt }
  const langAttempts = new Map()  // ip → { count, resetAt } — language flips (generous)
  const registerAttempts = new Map() // ip → { count, resetAt } — public opponent self-registration (audit EP-SCH-2)

  function rateLimit(map, req, maxAttempts, windowMs) {
    // 2026-05-12 audit #20: prefer CF-Connecting-IP (set by Cloudflare Tunnel)
    // over `req.ip` (which is the tunnel IP under reverse proxy) over
    // X-Forwarded-For (spoofable if `trust proxy` isn't set on Express).
    // Documented gap in SECURITY.md: limiter is safe ONLY behind CF Tunnel.
    const xff = req.headers['x-forwarded-for']
    const ip = req.headers['cf-connecting-ip']
      || (typeof xff === 'string' ? xff.split(',')[0].trim() : '')
      || req.ip
      || 'unknown'
    const now = Date.now()
    const attempt = map.get(ip)
    if (attempt && now < attempt.resetAt) {
      if (attempt.count >= maxAttempts) return false
      attempt.count++
    } else {
      map.set(ip, { count: 1, resetAt: now + windowMs })
    }
    if (map.size > 1000) {
      for (const [k, v] of map) { if (now > v.resetAt) map.delete(k) }
    }
    return true
  }

  // Validate + normalise the proposer (the opponent-club person confirming) from
  // a propose-home / propose-away body. Both fields are required so the
  // spielplaner always knows who to follow up with. Returns { ok, name, email }
  // on success, or { ok:false, error } with a stable error code on failure.
  function parseProposer(body) {
    const name = String(body?.proposer_name || '').trim().slice(0, 200)
    const email = String(body?.proposer_email || '').trim().slice(0, 200)
    if (!name || !email) return { ok: false, error: 'proposer_required' }
    if (!EMAIL_RE.test(email)) return { ok: false, error: 'invalid_email' }
    return { ok: true, name, email }
  }

  // True if the caller is a full admin OR a club-wide Spielplaner
  // (members.is_spielplaner = true). Used to gate the operational
  // /admin/terminplanung/* action endpoints (the items-API reads/writes are
  // gated by the "KSCW Terminplanung" Directus policy instead). Structural
  // season ops (restore/archive/rollover) stay admin-only.
  async function isAdminOrSpielplaner(req) {
    if (req.accountability?.admin) return true
    const userId = req.accountability?.user
    if (!userId) return false
    const member = await database('members').where('user', userId).select('is_spielplaner').first()
    return member?.is_spielplaner === true
  }

  // Per-team scheduler authorisation (migration 031 design): a caller may manage a
  // given team's scheduling if they are (a) a full admin, (b) a per-team scheduler
  // (`spielplaner_assignments` row for that team), or (c) a CLUB-WIDE Spielplaner
  // (`members.is_spielplaner = true`) with NO assignment rows — the documented
  // unrestricted role. A scoped scheduler (≥1 assignment) is limited to their
  // assigned teams; a club-wide scheduler keeps full access (never locked out).
  async function spielplanerCanManageTeam(req, teamId) {
    if (req.accountability?.admin) return true
    const userId = req.accountability?.user
    if (!userId) return false
    const member = await database('members').where('user', userId).select('id', 'is_spielplaner').first()
    if (!member) return false
    const assigns = await database('spielplaner_assignments').where('member', member.id).pluck('kscw_team')
    if (assigns.length > 0) return assigns.map(Number).includes(Number(teamId)) // scoped scheduler
    return member.is_spielplaner === true // club-wide (documented design) — unrestricted
  }

  // Team ids where this Directus user is a coach or team responsible — resolved
  // member-first (members.user → members_id in the teams_coaches /
  // teams_responsibles junctions). Feeds canViewTeamScheduling only.
  async function coachOrTrTeamIds(database, userId) {
    if (!userId) return []
    const member = await database('members').where('user', userId).first('id')
    if (!member) return []
    const [coachRows, trRows] = await Promise.all([
      database('teams_coaches').where('members_id', member.id).pluck('teams_id'),
      database('teams_responsibles').where('members_id', member.id).pluck('teams_id'),
    ])
    return [...new Set([...coachRows, ...trRows].map(Number).filter(Number.isFinite))]
  }

  // READ-ONLY per-team authorisation (v1 coach/TR planner access): true for a
  // full admin, a club-wide Spielplaner, a per-team scheduler assigned to this
  // team, OR a coach / team responsible of this team. Apply ONLY to read
  // endpoints the planner calendar needs — every mutation (confirm, book,
  // block, invite, manual game) keeps the stricter spielplanerCanManageTeam.
  async function canViewTeamScheduling(req, teamId) {
    if (await spielplanerCanManageTeam(req, teamId)) return true
    const ids = await coachOrTrTeamIds(database, req.accountability?.user)
    return ids.includes(Number(teamId))
  }

  // Superadmin-only gate for club-wide settings (the global blocked-dates blackout).
  // Directus admin OR the 'superuser'/'admin' member role — tighter than
  // isAdminOrSpielplaner (a spielplaner must NOT edit the club-wide blackout).
  async function isSuperadmin(req) {
    if (req.accountability?.admin) return true
    const userId = req.accountability?.user
    if (!userId) return false
    const m = await database('members').where('user', userId).first('role')
    if (!m) return false
    const roles = Array.isArray(m.role)
      ? m.role
      : (m.role ? (() => { try { return JSON.parse(m.role) } catch { return [] } })() : [])
    return roles.includes('superuser') || roles.includes('admin')
  }

  // Who (KSCW side) is performing this action — resolved from the authenticated
  // member, for the booking audit line ("Confirmed by …", migration 112). Best
  // effort: returns {name:null,email:null} for an admin token with no linked
  // member, or when unauthenticated.
  async function resolveActingUser(req) {
    const userId = req.accountability?.user
    if (!userId) return { name: null, email: null }
    const m = await database('members').where('user', userId).first('first_name', 'last_name', 'email')
    if (!m) return { name: null, email: null }
    const name = [m.first_name, m.last_name].filter(Boolean).join(' ').trim() || null
    return { name, email: m.email || null }
  }

  // Default game-spacing gaps (days) when a season has no gap_config. ±N means
  // the team never plays two games closer than N days apart (date ± N → a
  // (2N+1)-day exclusion span per game). Per-season overrides live in
  // game_scheduling_seasons.gap_config (migration 083); home and away proposals
  // can differ, and the lenient 3rd away proposal can use a smaller gap.
  const DEFAULT_GAPS = { home: 4, proposal: 4, proposal3: 2 }

  // How wide a *held* first proposal (choice 1) blocks others — a soft reserve,
  // intentionally narrower than the full game-spacing gap. Choices 2 & 3 don't
  // hold (they warn; see the admin review's windowed contention: ±2 / ±1).
  const HOLD_WINDOW_DAYS = 2

  // Read the per-season gaps, falling back to DEFAULT_GAPS for missing/invalid
  // values. gap_config is jsonb → knex returns a parsed object.
  async function seasonGaps(seasonId) {
    let cfg = {}
    if (seasonId) {
      const row = await database('game_scheduling_seasons').where('id', seasonId).first('gap_config')
      if (row && row.gap_config && typeof row.gap_config === 'object') cfg = row.gap_config
    }
    const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : d)
    return {
      home: num(cfg.home, DEFAULT_GAPS.home),
      proposal: num(cfg.proposal, DEFAULT_GAPS.proposal),
      proposal3: num(cfg.proposal3, DEFAULT_GAPS.proposal3),
    }
  }

  // Advisory-lock namespace (classid) for serializing home-slot bookings per
  // team. pg_advisory_xact_lock(GSCH_BOOK_LOCK_CLASS, kscw_team) makes two
  // opponents booking different-but-nearby slots for the same team wait in line,
  // so the gap + Saturday-cap checks can't be raced (the per-slot FOR UPDATE
  // only guards the same slot row). Arbitrary constant, unused elsewhere.
  const GSCH_BOOK_LOCK_CLASS = 920601

  // Advisory-lock namespace (classid) for season-wide slot REGENERATION.
  // generate-slots deletes every `available` slot in a season and rebuilds it,
  // while propose-home writes a booking pointing at three of those slots after a
  // long unserialised validation pass. Unordered, a regeneration starting
  // mid-proposal deletes the picked slots and its own orphan sweep then deletes
  // the brand-new booking — after the opponent club already got its "picks
  // recorded" receipt. Both sides take pg_advisory_xact_lock(GSCH_GEN_LOCK_CLASS,
  // season), so only the two clean orderings remain. Keyed on the SEASON, so two
  // seasons never block each other; transaction-scoped, so a crashed or restarted
  // container releases it automatically — there is no claim to reclaim by hand.
  const GSCH_GEN_LOCK_CLASS = 920602

  // Advisory-lock namespace for opponent-INVITE creation. Both writers
  // (POST /admin/terminplanung/invites and .../invites/ensure-from-svrz) dedupe by
  // normalised opponent team name with a SELECT-then-INSERT, and
  // game_scheduling_opponents has no unique index behind it — so two concurrent
  // callers both miss and both insert, mailing the opponent club two different
  // scheduling links. Keyed on kscw_team: different teams never block each other.
  const GSCH_INVITE_LOCK_CLASS = 920603

  // Dates (YYYY-MM-DD) the KSCW team is already committed to play — real SVRZ
  // games, home slots an opponent has already booked, and confirmed away
  // proposals — each expanded ±gapDays so the team never plays games closer
  // together than that. A booked slot or a confirmed proposal therefore blocks
  // exactly like a real game: no other opponent can take that date or one within
  // the window (home-slot list + away proposals + away calendar greying). The
  // window size is caller-supplied because home games, away proposals 1-2 and
  // away proposal 3 may each use a different gap (see seasonGaps).
  //
  // opts.includeHeld: also treat the FIRST proposal of any *pending* booking as
  // committed ("held") — a held home slot-1 / away date-1 reserves the date the
  // same way a real game does, so no one else can take it. Proposals 2 & 3 never
  // hold (they're soft alternatives — the admin just gets a contention warning).
  // opts.excludeOpponent: skip that opponent's own holds, so their slot-1 reserve
  // doesn't block their own alternatives (2 & 3) or their re-proposal.
  async function committedGameDates(kscwTeamId, gapDays = DEFAULT_GAPS.home, opts = {}) {
    const set = new Set()
    const addWindow = (val, w = gapDays) => {
      if (!val) return
      const base = new Date(`${String(val).slice(0, 10)}T00:00:00Z`)
      if (Number.isNaN(base.getTime())) return
      for (let off = -w; off <= w; off++) {
        const x = new Date(base); x.setUTCDate(x.getUTCDate() + off)
        set.add(x.toISOString().slice(0, 10))
      }
    }
    const games = await database('games')
      .where('kscw_team', kscwTeamId).whereNotNull('date')
      .select(database.raw('games.date::text as d'))
    games.forEach((g) => addWindow(g.d))
    const booked = await database('game_scheduling_slots')
      .where('kscw_team', kscwTeamId).where('status', 'booked')
      .select(database.raw('date::text as d'))
    booked.forEach((s) => addWindow(s.d))
    const confirmed = await database('game_scheduling_bookings as b')
      .join('game_scheduling_opponents as o', 'o.id', 'b.opponent')
      .where('o.kscw_team', kscwTeamId)
      .where('b.type', 'away_proposal').where('b.status', 'confirmed')
      .select('b.confirmed_proposal as n', database.raw('b.proposed_datetime_1::text as d1'),
              database.raw('b.proposed_datetime_2::text as d2'), database.raw('b.proposed_datetime_3::text as d3'))
    confirmed.forEach((b) => addWindow(b[`d${b.n}`]))
    // Confirmed intra-club derby legs are real games — block their gap window
    // too (Art. 27). A team is team_a or team_b of the pair.
    const derbies = await database('game_scheduling_derbies')
      .where('confirmed', true)
      .where(function () { this.where('team_a', kscwTeamId).orWhere('team_b', kscwTeamId) })
      .select(database.raw('leg1_date::text as leg1_date'), database.raw('leg2_date::text as leg2_date'))
    derbies.forEach((r) => { addWindow(r.leg1_date); addWindow(r.leg2_date) })

    if (opts.includeHeld) {
      const heldBase = () => {
        const q = database('game_scheduling_bookings as b')
          .join('game_scheduling_opponents as o', 'o.id', 'b.opponent')
          .where('o.kscw_team', kscwTeamId).where('b.status', 'pending')
        if (opts.excludeOpponent) q.whereNot('b.opponent', opts.excludeOpponent)
        return q
      }
      // Home: pending proposed_slot_1 → its slot date. Held with the fixed,
      // narrow HOLD_WINDOW_DAYS (not the context gap) — a soft reserve.
      const heldHome = await heldBase()
        .where('b.type', 'home_slot_pick').whereNotNull('b.proposed_slot_1')
        .join('game_scheduling_slots as s', 's.id', 'b.proposed_slot_1')
        .select(database.raw('s.date::text as d'))
      heldHome.forEach((r) => addWindow(r.d, HOLD_WINDOW_DAYS))
      // Away: pending proposed_datetime_1.
      const heldAway = await heldBase()
        .where('b.type', 'away_proposal').whereNotNull('b.proposed_datetime_1')
        .select(database.raw('b.proposed_datetime_1::text as d'))
      heldAway.forEach((r) => addWindow(r.d, HOLD_WINDOW_DAYS))
    }
    return set
  }

  // ── Scheduling-rule helpers (A1–A4, C1 cross-team) ───────────────────────
  // Juniors (HU23-1, HU20, DU23-1, DU23-2, …) are detected by name pattern: a
  // "U" followed by a digit. They have no Saturday cap and are the only teams
  // eligible for Sunday home slots.
  const isJuniorTeam = (name) => /u\d/i.test(String(name || ''))

  // UTC day-of-week from a YYYY-MM-DD string (0=Sun … 6=Sat). Matches the UTC
  // date math used elsewhere in this file; never use local getDay() (TZ shift).
  const dowUTC = (ymd) => new Date(`${String(ymd).slice(0, 10)}T00:00:00Z`).getUTCDay()
  const isSaturday = (ymd) => dowUTC(ymd) === 6
  const isSunday = (ymd) => dowUTC(ymd) === 0

  // A team "has an evening slot" if it owns a KWI block ending 21:30 OR uses a
  // volleyball Döltschi slot — i.e. it would NOT fall back to the club Spielhalle
  // pool in generate-slots. Teams with no evening slot get a higher Saturday cap.
  async function hasEveningSlot(teamId, db = database) {
    const ownKwi = await db('hall_slots')
      .join('hall_slots_teams', 'hall_slots.id', 'hall_slots_teams.hall_slots_id')
      .join('halls', 'hall_slots.hall', 'halls.id')
      .where('hall_slots_teams.teams_id', teamId)
      .whereRaw("hall_slots.end_time::text LIKE '21:30%'")
      .whereRaw("LOWER(halls.name) LIKE '%kwi%'")
      .first()
    if (ownKwi) return true
    const doltschi = await db('hall_slots')
      .join('hall_slots_teams', 'hall_slots.id', 'hall_slots_teams.hall_slots_id')
      .join('halls', 'hall_slots.hall', 'halls.id')
      .where('hall_slots_teams.teams_id', teamId)
      .where('hall_slots.sport', 'volleyball')
      .whereRaw("(LOWER(halls.name) LIKE '%döltschi%' OR LOWER(halls.name) LIKE '%doltschi%')")
      .first()
    return !!doltschi
  }

  // Per-team opt-out: teams.features_enabled.no_saturday_games → no Saturday games
  // (home OR away). Already-confirmed Saturdays are untouched; just no NEW ones.
  async function teamNoSaturday(teamId, db = database) {
    const row = await db('teams').where('id', teamId).first('features_enabled')
    let f = row?.features_enabled
    if (typeof f === 'string') { try { f = JSON.parse(f) } catch { f = {} } }
    return !!(f && f.no_saturday_games)
  }

  // Effective max number of Saturday home games per season for a team:
  //   junior → ∞ (A2), flagged no_saturday_games → 0, no evening slot → 3 (A4), else 2 (A1).
  async function teamSaturdayCap(team, db = database) {
    if (isJuniorTeam(team?.name)) return Infinity
    if (team?.id && (await teamNoSaturday(team.id, db))) return 0
    if (!(await hasEveningSlot(team.id, db))) return 3
    return 2
  }

  // Other team ids that share ≥1 person with this team — counting any role: a
  // real player (member_teams, guest_level 0/null), a coach (teams_coaches), or a
  // team-responsible (teams_responsibles). A person can't be in two places on the
  // same day, so e.g. someone who PLAYS for D1 and COACHES D2 makes D1 & D2
  // mutually exclusive that day. Drives the cross-team same-day rule.
  async function sharedPlayerTeams(teamId, db = database) {
    // Everyone linked to THIS team, by any role.
    const memberIds = new Set()
    ;(await db('member_teams').where('team', teamId)
      .where(function () { this.where('guest_level', 0).orWhereNull('guest_level') })
      .pluck('member')).forEach((m) => memberIds.add(m))
    ;(await db('teams_coaches').where('teams_id', teamId).pluck('members_id')).forEach((m) => memberIds.add(m))
    ;(await db('teams_responsibles').where('teams_id', teamId).pluck('members_id')).forEach((m) => memberIds.add(m))
    if (memberIds.size === 0) return []
    const ids = [...memberIds]
    // Other ACTIVE teams those people are linked to, by any role. Without the
    // active gate archived teams — including this team's OWN previous-season
    // clone — enter the same-day exclusion set and block a date with no visible
    // reason. Matches sv-sync.js's active-only team map.
    const out = new Set()
    ;(await db('member_teams as mt').join('teams as t', 't.id', 'mt.team')
      .whereIn('mt.member', ids).whereNot('mt.team', teamId).where('t.active', true)
      .where(function () { this.where('mt.guest_level', 0).orWhereNull('mt.guest_level') })
      .pluck('mt.team')).forEach((t) => out.add(t))
    ;(await db('teams_coaches as j').join('teams as t', 't.id', 'j.teams_id')
      .whereIn('j.members_id', ids).whereNot('j.teams_id', teamId).where('t.active', true)
      .pluck('j.teams_id')).forEach((t) => out.add(t))
    ;(await db('teams_responsibles as j').join('teams as t', 't.id', 'j.teams_id')
      .whereIn('j.members_id', ids).whereNot('j.teams_id', teamId).where('t.active', true)
      .pluck('j.teams_id')).forEach((t) => out.add(t))
    return [...out]
  }

  // Which of the given teams have a committed game (real game, booked home slot,
  // or confirmed away proposal) on the exact date `ymd`. Returns the conflicting
  // team ids (empty = none). Drives the cross-team same-day rule + its message.
  async function teamsCommittedOnDate(teamIds, ymd, db = database) {
    const out = new Set()
    if (!teamIds || teamIds.length === 0) return []
    const day = String(ymd).slice(0, 10)
    const games = await db('games').whereIn('kscw_team', teamIds)
      .whereRaw('date::text = ?', [day]).pluck('kscw_team')
    games.forEach((id) => out.add(id))
    const booked = await db('game_scheduling_slots').whereIn('kscw_team', teamIds)
      .where('status', 'booked').whereRaw('date::text = ?', [day]).pluck('kscw_team')
    booked.forEach((id) => out.add(id))
    const confirmed = await db('game_scheduling_bookings as b')
      .join('game_scheduling_opponents as o', 'o.id', 'b.opponent')
      .whereIn('o.kscw_team', teamIds)
      .where('b.type', 'away_proposal').where('b.status', 'confirmed')
      .select('o.kscw_team as t', 'b.confirmed_proposal as n',
              database.raw('b.proposed_datetime_1::text as d1'), database.raw('b.proposed_datetime_2::text as d2'), database.raw('b.proposed_datetime_3::text as d3'))
    confirmed.forEach((b) => { if (String(b[`d${b.n}`] || '').slice(0, 10) === day) out.add(b.t) })
    return [...out]
  }

  // Sundays another junior team (volleyball, active, name ~ u\d) already plays —
  // a booked home slot or a confirmed KSCW home game. Drives junior co-scheduling:
  // such a Sunday becomes a strict (pick 1 & 2) home option for the OTHER junior
  // teams so the U-teams cluster onto the same Sunday ("play together if possible").
  // excludeTeamId is the team being offered to (its own games don't count).
  async function juniorSundaysInUse(excludeTeamId, db = database) {
    const juniorIds = await db('teams').where('sport', 'volleyball').where('active', true)
      .whereRaw("name ~* 'u[0-9]'").whereNot('id', excludeTeamId).pluck('id')
    const out = new Set()
    if (!juniorIds.length) return out
    const bk = await db('game_scheduling_slots').whereIn('kscw_team', juniorIds)
      .where('status', 'booked').select(database.raw('date::text as d'))
    const hg = await db('games').whereIn('kscw_team', juniorIds).whereNotNull('date')
      .whereRaw("LOWER(home_team) LIKE 'ksc wiedikon%'").select(database.raw('date::text as d'))
    for (const r of [...bk, ...hg]) { const d = String(r.d).slice(0, 10); if (isSunday(d)) out.add(d) }
    return out
  }

  // First day of a scheduling season's cycle (July 1 of the season's start
  // year, i.e. between the old season's last game and the new one's first).
  // Counters scoped "per season" must floor on this: until the club rollover
  // runs, LAST season's games still sit on the ACTIVE team ids, so an
  // unfloored count over `games` silently includes them. Falls back to the
  // open season when no id is given; null (= no floor) when none resolvable.
  async function seasonFloorYmd(seasonId, db = database) {
    let name = null
    if (seasonId) {
      const row = await db('game_scheduling_seasons').where('id', seasonId).first('season')
      name = row?.season
    }
    if (!name) {
      const row = await db('game_scheduling_seasons').where('status', 'open').orderBy('id', 'desc').first('season')
      name = row?.season
    }
    const m = String(name || '').match(/(\d{4})/)
    return m ? `${m[1]}-07-01` : null
  }

  // Distinct Saturday dates a team already has a HOME game on THIS SEASON —
  // booked home slots (the tool's own picks) plus KSCW-home rows in `games`
  // (home_team is KSCW), deduped by date, floored at the season start so last
  // season's games (same team ids until rollover) don't eat the allotment.
  // Drives the Saturday cap (A1/A4).
  async function committedSaturdayDates(teamId, db = database, seasonId = null) {
    const floor = await seasonFloorYmd(seasonId, db)
    const set = new Set()
    let bookedQ = db('game_scheduling_slots').where('kscw_team', teamId).where('status', 'booked')
    if (floor) bookedQ = bookedQ.whereRaw('date::date >= ?::date', [floor])
    const booked = await bookedQ.select(db.raw('date::text as d'))
    booked.forEach((s) => { if (isSaturday(s.d)) set.add(String(s.d).slice(0, 10)) })
    let gamesQ = db('games').where('kscw_team', teamId).whereNotNull('date')
      .whereRaw("LOWER(home_team) LIKE 'ksc wiedikon%'")
    if (floor) gamesQ = gamesQ.whereRaw('date::date >= ?::date', [floor])
    const homeGames = await gamesQ.select(db.raw('date::text as d'))
    homeGames.forEach((g) => { if (isSaturday(g.d)) set.add(String(g.d).slice(0, 10)) })
    return set
  }

  // Distinct Saturday dates a team already plays AWAY on this season — KSCW-away
  // rows in `games` plus confirmed away proposals, deduped by date, same season
  // floor as the home counter. Informational only: there is NO away Saturday cap
  // (A3 limits Saturdays per proposal, not per season).
  async function committedAwaySaturdayDates(teamId, db = database, seasonId = null) {
    const floor = await seasonFloorYmd(seasonId, db)
    const set = new Set()
    let gamesQ = db('games').where('kscw_team', teamId).whereNotNull('date')
      .whereRaw("LOWER(away_team) LIKE 'ksc wiedikon%'")
    if (floor) gamesQ = gamesQ.whereRaw('date::date >= ?::date', [floor])
    const awayGames = await gamesQ.select(db.raw('date::text as d'))
    awayGames.forEach((g) => { if (isSaturday(g.d)) set.add(String(g.d).slice(0, 10)) })
    const confirmed = await db('game_scheduling_bookings as b')
      .join('game_scheduling_opponents as o', 'o.id', 'b.opponent')
      .where('o.kscw_team', teamId)
      .where('b.type', 'away_proposal').where('b.status', 'confirmed')
      .select('b.confirmed_proposal as n',
              db.raw('b.proposed_datetime_1::text as d1'), db.raw('b.proposed_datetime_2::text as d2'), db.raw('b.proposed_datetime_3::text as d3'))
    confirmed.forEach((b) => {
      const d = String(b[`d${b.n}`] || '').slice(0, 10)
      if (d && isSaturday(d) && (!floor || d >= floor)) set.add(d)
    })
    return set
  }

  // ── Cross-sport: basketball holds a KWI floor (migrations 346 + 351) ──
  // A basketball home game reaches the database by two roads: a `basketball_slot_plan`
  // placement (migration 295 projects it onto the physical floors it occupies) and a
  // `games` row — the Spielplanung editor's manual home game, and everything bp-sync
  // scrapes out of Basketplan (migration 351 projects those the same way). That court
  // is then gone for volleyball too, so a home slot standing on it must stop being
  // offered and must not be bookable — until this, the coordination ran one way only
  // and the basketball chip on the planner's calendar was the sole warning.
  //
  // ⚠ Read `bb_floor_claims_all` (migration 351's union), NEVER either claims table
  // directly: a slot must disappear whichever road took the court, and a query against
  // `basketball_floor_claims` alone silently ignores every Basketplan fixture.
  //
  // Both helpers below express the SAME predicate, in SQL, via the two functions
  // migration 346 adds — which in turn mirror `vbBlocksSlot()` in
  // src/modules/gameScheduling/utils/hallOccupancy.ts (volleyball occupies
  // start−30…end+30, basketball tip…tip+120). The planner's calendar computes it in
  // TypeScript from the same numbers; a divergence would show as a slot the
  // calendar counts as open and the backend refuses to book.
  //
  // ⚠ Draft placements block too — see migration 295: a draft occupies the physical
  // court exactly as much as a confirmed game, and the claims table carries no
  // status to filter on.

  /** knex modifier: drop every slot a basketball placement has taken the floor from. */
  const excludeBbFloorClaims = (q) => q.whereNotExists(function () {
    this.select(database.raw('1'))
      .from('bb_floor_claims_all as fc')
      .whereRaw('fc.date = game_scheduling_slots.date')
      .whereRaw('fc.floor = ANY (vb_slot_floors(game_scheduling_slots.hall, game_scheduling_slots.additional_halls::jsonb))')
      .whereRaw('bb_vb_time_overlap(game_scheduling_slots.start_time, game_scheduling_slots.end_time, fc."time")')
  })

  /**
   * The basketball placement standing on a would-be home booking, or null.
   *
   * Returns the row (not a boolean) so the refusal can name the game and the court —
   * "KWI B is taken by KSCW Herren 2 (basketball) at 20:00" is actionable, "slot
   * unavailable" is not. Takes raw values rather than a slot id because the manual
   * booking path invents its slot on the fly.
   */
  async function bbFloorConflict(dateYmd, hallId, additionalHalls, startTime, endTime, db = database) {
    if (!dateYmd || hallId == null) return null
    // `additional_halls` is a plain `json` column, so pg hands it back already parsed.
    // Binding a JS array would make knex send a Postgres ARRAY literal ('{1,2}'), which
    // ::jsonb rejects — stringify it back into JSON text first.
    const extra = additionalHalls == null
      ? null
      : (typeof additionalHalls === 'string' ? additionalHalls : JSON.stringify(additionalHalls))
    // The view already resolves hall / team / opponent for both roads, so there is
    // nothing left to join — and nothing left that could quietly drop one source.
    return db('bb_floor_claims_all as fc')
      .where('fc.date', dateYmd)
      .whereRaw('fc.floor = ANY (vb_slot_floors(?::int, ?::jsonb))', [hallId, extra])
      .whereRaw('bb_vb_time_overlap(?::time, ?::time, fc."time")', [startTime ?? null, endTime ?? null])
      .first('fc.bb_hall', 'fc.time as bb_time', 'fc.bb_opponent', 'fc.bb_team')
  }

  /** Human-readable refusal for a slot a basketball game already holds. */
  const bbConflictMessage = (hit) =>
    `${hit.bb_hall} is taken by ${hit.bb_team ? `KSCW ${hit.bb_team}` : 'a basketball game'}` +
    `${hit.bb_opponent ? ` vs ${hit.bb_opponent}` : ''} (basketball) at ${String(hit.bb_time).slice(0, 5)} — pick another court or time.`

  // ── Intra-club derby anchoring (Art. 27 SVRZ) ────────────────────────
  // When two KSCW teams share a league group (e.g. H1 & H3 in 2L), their two
  // head-to-head games MUST be the first game of the Vorrunde and of the
  // Rückrunde (Art. 27 Abs. 6 lit. a — forfait otherwise). The spielplaner fixes
  // those two dates manually (game_scheduling_derbies); once confirmed, every
  // OTHER home-slot offer + away-date proposal for both teams is clamped to
  // after the relevant derby date, per half.

  // Normalise a date column value (pg Date object or ISO string) → 'YYYY-MM-DD'.
  const ymdOf = (v) => {
    if (!v) return null
    if (typeof v === 'string') return v.slice(0, 10)
    const d = new Date(v)
    if (Number.isNaN(d.getTime())) return null
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  }

  // Boundary between the Vorrunde and the Rückrunde = 01.01 of the season's
  // second year. Swiss indoor volleyball always spans the new year (Vorrunde
  // Sep–Dec, Rückrunde Jan–Mar), so the year turn is the reliable split and
  // needs no per-season config. Returns 'YYYY-01-01' or null if unparseable.
  const rueckrundeStart = (seasonRow) => {
    const m = String(seasonRow?.season || '').match(/(\d{4})\D+(\d{2,4})/)
    if (!m) return null
    let y2 = parseInt(m[2], 10)
    if (y2 < 100) y2 = 2000 + y2
    return `${y2}-01-01`
  }

  // The selectable offer window [start, end] (YYYY-MM-DD) for a season — bounds
  // the home slots and away dates the tool offers, and the calendars' selectable
  // range (anything before start / after end is greyed out). Uses the per-season
  // configurable season_opens / season_closes dates when set (migration 108),
  // otherwise derives Sep 1 (first year) → Mar 31 (second year) from the season
  // name (e.g. "2026/27") — the value that was hardcoded before. Either bound may
  // be configured independently; the other falls back to the derived default.
  const seasonOfferWindow = (seasonRow) => {
    // pg returns `date` columns as JS Date objects — format with local getters
    // (matching the ymd() helper) so we get 'YYYY-MM-DD', not 'Mon Sep 14'.
    const toYmd = (v) => {
      if (!v) return null
      if (typeof v === 'string') return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null
      const d = new Date(v)
      if (Number.isNaN(d.getTime())) return null
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    const opens = toYmd(seasonRow?.season_opens)
    const closes = toYmd(seasonRow?.season_closes)
    let dStart = null
    let dEnd = null
    const m = String(seasonRow?.season || '').match(/(\d{4})\D+(\d{2,4})/)
    if (m) {
      const y1 = parseInt(m[1], 10)
      let y2 = parseInt(m[2], 10)
      if (y2 < 100) y2 = 2000 + y2
      dStart = `${y1}-09-01`
      dEnd = `${y2}-03-31`
    }
    const start = opens || dStart
    const end = closes || dEnd
    return start && end ? { start, end } : null
  }

  // Confirmed-derby anchors for a team in a season: the LATEST Vorrunde-leg date
  // and the LATEST Rückrunde-leg date across every confirmed derby the team is in
  // (latest, so ALL its derbies come first when a club has 3+ teams in a group).
  // A leg counts as Vorrunde if its date < boundary, else Rückrunde.
  async function confirmedDerbyAnchors(kscwTeamId, seasonId, boundary) {
    const anchors = { vor: null, rueck: null }
    if (!kscwTeamId || !seasonId || !boundary) return anchors
    const rows = await database('game_scheduling_derbies')
      .where('season', seasonId).where('confirmed', true)
      .where(function () { this.where('team_a', kscwTeamId).orWhere('team_b', kscwTeamId) })
      .select('leg1_date', 'leg2_date')
    for (const r of rows) {
      for (const raw of [r.leg1_date, r.leg2_date]) {
        const d = ymdOf(raw)
        if (!d) continue
        if (d < boundary) { if (!anchors.vor || d > anchors.vor) anchors.vor = d }
        else { if (!anchors.rueck || d > anchors.rueck) anchors.rueck = d }
      }
    }
    return anchors
  }

  // Is candidate date `d` blocked by the derby anchors — i.e. on/before the
  // derby date within its own half? (The derby is first; nothing else before it.)
  const derbyDateBlocked = (d, anchors, boundary) => {
    if (!d || !anchors || !boundary) return false
    const day = String(d).slice(0, 10)
    return day < boundary
      ? !!(anchors.vor && day <= anchors.vor)
      : !!(anchors.rueck && day <= anchors.rueck)
  }

  // Materialise the blocked dates across the season window (used to grey the
  // away calendar, which works off explicit date lists). ~270 iterations.
  const buildDerbyBlockedSet = (anchors, boundary, seasonRow) => {
    const set = new Set()
    if (!anchors || (!anchors.vor && !anchors.rueck) || !boundary) return set
    const m = String(seasonRow?.season || '').match(/(\d{4})\D+(\d{2,4})/)
    if (!m) return set
    const y1 = parseInt(m[1], 10)
    let y2 = parseInt(m[2], 10)
    if (y2 < 100) y2 = 2000 + y2
    const cur = new Date(`${y1}-08-01T00:00:00Z`)
    const end = new Date(`${y2}-04-30T00:00:00Z`)
    for (; cur <= end; cur.setUTCDate(cur.getUTCDate() + 1)) {
      const day = cur.toISOString().slice(0, 10)
      if (derbyDateBlocked(day, anchors, boundary)) set.add(day)
    }
    return set
  }

  // ── Item 3: home-proposal health (revalidation) ──────────────────────────
  // A pending home_slot_pick proposal can silently rot after it was made: the
  // slot gets booked by another opponent, blocked, hit by a hall closure, lands
  // too close to a newly-confirmed game, or falls before a confirmed derby. This
  // re-validates every pending home proposal against the LIVE state (read-only),
  // mirroring the confirm-home guards that bite day to day: taken / team event /
  // team block / hall closure / gap (too close) / derby / Döltschi cap + date.
  // The rarer Saturday-cap and cross-team races stay enforced HARD at confirm
  // time, so a stale "valid" here can never become a bad booking. `reason` is a
  // short code the admin UI maps to a localised label.
  // Sorted, distinct YYYY-MM-DD list of a team's already-scheduled games (real
  // games + booked home slots + confirmed away proposals + confirmed derby
  // legs) — so the review can say how a proposed date spaces against the
  // nearest game before/after it.
  async function teamGameDateList(kscwTeamId) {
    const dates = new Set()
    const add = (v) => { const k = v ? String(v).slice(0, 10) : ''; if (/^\d{4}-\d{2}-\d{2}$/.test(k)) dates.add(k) }
    ;(await database('games').where('kscw_team', kscwTeamId).whereNotNull('date')
      .select(database.raw('games.date::text as d'))).forEach((g) => add(g.d))
    ;(await database('game_scheduling_slots').where('kscw_team', kscwTeamId).where('status', 'booked')
      .select(database.raw('date::text as d'))).forEach((s) => add(s.d))
    ;(await database('game_scheduling_bookings as b')
      .join('game_scheduling_opponents as o', 'o.id', 'b.opponent')
      .where('o.kscw_team', kscwTeamId).where('b.type', 'away_proposal').where('b.status', 'confirmed')
      .select('b.confirmed_proposal as n', database.raw('b.proposed_datetime_1::text as d1'),
        database.raw('b.proposed_datetime_2::text as d2'), database.raw('b.proposed_datetime_3::text as d3')))
      .forEach((b) => add(b[`d${b.n}`]))
    ;(await database('game_scheduling_derbies').where('confirmed', true)
      .where(function () { this.where('team_a', kscwTeamId).orWhere('team_b', kscwTeamId) })
      .select(database.raw('leg1_date::text as leg1_date'), database.raw('leg2_date::text as leg2_date')))
      .forEach((r) => { add(r.leg1_date); add(r.leg2_date) })
    return [...dates].sort()
  }

  // Nearest scheduled game strictly before / after `day` (both 'YYYY-MM-DD'),
  // with the day-gap. `dateList` must be sorted ascending.
  const adjacentGames = (dateList, day) => {
    let prev = null
    let next = null
    for (const d of dateList) {
      if (d < day) prev = d
      else if (d > day && !next) next = d
    }
    const diff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000)
    return {
      prev_game: prev ? { date: prev, days: diff(prev, day) } : null,
      next_game: next ? { date: next, days: diff(day, next) } : null,
    }
  }

  // Game-affecting one-off absences across a team's roster (weekly recurrences +
  // guests excluded — mirrors slots/:token abs_count) → count + NAME lookups by
  // day. Shared by the proposal-health context and the manual-booking date hint.
  async function teamAbsenceLookup(teamId) {
    const absRows = await database('absences as a')
      .join('member_teams as mt', 'mt.member', 'a.member')
      .where('mt.team', teamId)
      .where(function () { this.where('mt.guest_level', 0).orWhereNull('mt.guest_level') })
      .whereRaw("a.type IS DISTINCT FROM 'weekly'")
      .whereRaw('a.blocking IS NOT FALSE')
      .whereRaw('a.start_date IS NOT NULL AND a.end_date IS NOT NULL')
      .whereRaw("(a.affects::jsonb @> '\"all\"' OR a.affects::jsonb @> '\"games\"')")
      .select('a.member', database.raw('a.start_date::text as s'), database.raw('a.end_date::text as e'))
    const absences = absRows.map((r) => ({ m: r.member, s: String(r.s).slice(0, 10), e: String(r.e).slice(0, 10) }))
    const nameById = new Map()
    const memberIds = [...new Set(absences.map((a) => a.m))]
    if (memberIds.length) {
      ;(await database('members').whereIn('id', memberIds).select('id', 'first_name', 'last_name'))
        .forEach((m) => nameById.set(m.id, [m.first_name, m.last_name].filter(Boolean).join(' ').trim() || `#${m.id}`))
    }
    const absentCountOn = (day) => {
      const ms = new Set()
      for (const a of absences) if (a.s <= day && day <= a.e) ms.add(a.m)
      return ms.size
    }
    const absentNamesOn = (day) => {
      const seen = new Set()
      const names = []
      for (const a of absences) {
        if (a.s <= day && day <= a.e && !seen.has(a.m)) { seen.add(a.m); names.push(nameById.get(a.m) || `#${a.m}`) }
      }
      return names.sort((x, y) => x.localeCompare(y))
    }
    return { absentCountOn, absentNamesOn }
  }

  // Live validity + decision context (absent players, adjacent-game spacing) of
  // every pending HOME proposal. With { includeAway: true } it also appends
  // pending AWAY proposals (date spacing + absences only — away validity is the
  // opponent's hall, not ours). Away entries are OFF by default so the
  // home-only request-new-slots caller keeps matching the right booking.
  async function homeProposalHealth(seasonId, opts = {}) {
    const bookings = await database('game_scheduling_bookings as b')
      .join('game_scheduling_opponents as o', 'o.id', 'b.opponent')
      .where('b.season', seasonId)
      .where('b.type', 'home_slot_pick')
      .where('b.status', 'pending')
      .select(
        'b.id as booking_id', 'b.opponent as opponent_id', 'b.svrz_game_id',
        'b.proposed_slot_1', 'b.proposed_slot_2', 'b.proposed_slot_3',
        'o.kscw_team', 'o.club_name', 'o.team_name',
      )
    const awayBookings = opts.includeAway
      ? await database('game_scheduling_bookings as b')
        .join('game_scheduling_opponents as o', 'o.id', 'b.opponent')
        .where('b.season', seasonId)
        .where('b.type', 'away_proposal')
        .where('b.status', 'pending')
        .select(
          'b.id as booking_id', 'b.opponent as opponent_id', 'b.svrz_game_id',
          database.raw('b.proposed_datetime_1::text as d1'), database.raw('b.proposed_datetime_2::text as d2'),
          database.raw('b.proposed_datetime_3::text as d3'),
          'o.kscw_team', 'o.club_name', 'o.team_name',
        )
      : []
    if (!bookings.length && !awayBookings.length) return []

    const seasonRow = await database('game_scheduling_seasons').where('id', seasonId).first()
    const gaps = await seasonGaps(seasonId)
    const boundary = rueckrundeStart(seasonRow)
    const doltschiHallIds = await database('halls')
      .whereRaw("LOWER(name) LIKE '%döltschi%' OR LOWER(name) LIKE '%doltschi%'").pluck('id')

    // Every slot referenced by any proposal (one fetch).
    const slotIds = [...new Set(bookings.flatMap((b) =>
      [b.proposed_slot_1, b.proposed_slot_2, b.proposed_slot_3]).filter(Boolean))]
    const slotRows = slotIds.length
      ? await database('game_scheduling_slots').whereIn('id', slotIds).select('*')
      : []
    const slotById = new Map(slotRows.map((s) => [s.id, s]))

    // Closures (whole table; checked per slot in JS against hall + date range).
    const closureRows = await database('hall_closures')
      .select('hall', database.raw('start_date::text as s'), database.raw('end_date::text as e'))

    // Döltschi: club-wide booked DATES (one game per date) + the season count.
    let doltschiCount = 0
    const doltschiDates = new Set()
    if (doltschiHallIds.length) {
      const bookedD = await database('game_scheduling_slots')
        .where('season', seasonId).where('status', 'booked')
        .whereIn('hall', doltschiHallIds).select(database.raw('date::text as d'))
      doltschiCount = bookedD.length
      for (const r of bookedD) doltschiDates.add(String(r.d).slice(0, 10))
    }

    const expandDays = (s, e) => {
      const out = []
      if (!s) return out
      const start = new Date(`${String(s).slice(0, 10)}T00:00:00Z`)
      const end = e ? new Date(`${String(e).slice(0, 10)}T00:00:00Z`) : start
      for (let d = new Date(start), g = 0; d <= end && g < 400; d.setUTCDate(d.getUTCDate() + 1), g++) {
        out.push(d.toISOString().slice(0, 10))
      }
      return out
    }

    // Club-wide blocked dates (superadmin blackout, migration 160) — no HOME games
    // for ANY team on these days. Fetched once; checked in validate() below for
    // every team, on top of each team's own scheduling_blocks.
    // ⚠ sport IS NULL (club-wide) OR volleyball — never a bare equality, which would
    //   drop the club-wide rows. See migration 286.
    const globalBlockRows = await database('scheduling_global_blocks')
      .where((q) => q.whereNull('sport').orWhere('sport', 'volleyball'))
      .select(database.raw('start_date::text as s'), database.raw('end_date::text as e'))
    const globalBlockDates = new Set(globalBlockRows.flatMap((r) => expandDays(r.s, r.e)))

    // Per-team caches (a season has few teams; many opponents reuse them).
    const teamCache = new Map()
    const getTeamCtx = async (teamId) => {
      if (teamCache.has(teamId)) return teamCache.get(teamId)
      const committedHome = await committedGameDates(teamId, gaps.home)
      const committedProposal3 = await committedGameDates(teamId, gaps.proposal3)
      const derbyAnchors = await confirmedDerbyAnchors(teamId, seasonId, boundary)
      const eventRows = await database('events as e')
        .join('events_teams as et', 'et.events_id', 'e.id')
        .where('et.teams_id', teamId)
        .select(
          database.raw("(e.start_date AT TIME ZONE 'Europe/Zurich')::date::text as s"),
          database.raw("(COALESCE(e.end_date, e.start_date) AT TIME ZONE 'Europe/Zurich')::date::text as e"),
        )
      const eventDates = new Set(eventRows.flatMap((r) => expandDays(r.s, r.e)))
      const blockRows = await database('scheduling_blocks')
        .where('team', teamId)
        .select(database.raw('start_date::text as s'), database.raw('end_date::text as e'))
      const blockDates = new Set(blockRows.flatMap((r) => expandDays(r.s, r.e)))

      // Saturday cap (A1/A4) — how many Saturday home games this team may have and
      // which Saturdays it already uses.
      const teamRow = await database('teams').where('id', teamId).first('id', 'name')
      const satCap = await teamSaturdayCap(teamRow)
      const satDates = await committedSaturdayDates(teamId, database, seasonId)

      // Cross-team (C1): exact dates any team sharing a person with this one is
      // already committed to — those days are blocked for this team too. Keep the
      // committing team id per day so the UI can say WHO conflicts.
      const sharedTeams = await sharedPlayerTeams(teamId)
      const sharedCommitted = new Map() // 'YYYY-MM-DD' -> Set<teamId>
      const sharedNames = new Map()     // teamId -> name
      const addShared = (d, tid) => {
        const k = String(d).slice(0, 10)
        if (!sharedCommitted.has(k)) sharedCommitted.set(k, new Set())
        sharedCommitted.get(k).add(tid)
      }
      if (sharedTeams.length) {
        ;(await database('teams').whereIn('id', sharedTeams).select('id', 'name'))
          .forEach((t) => sharedNames.set(t.id, t.name))
        ;(await database('games').whereIn('kscw_team', sharedTeams).whereNotNull('date')
          .select('kscw_team', database.raw('date::text as d'))).forEach((r) => addShared(r.d, r.kscw_team))
        ;(await database('game_scheduling_slots').whereIn('kscw_team', sharedTeams).where('status', 'booked')
          .select('kscw_team', database.raw('date::text as d'))).forEach((r) => addShared(r.d, r.kscw_team))
        ;(await database('game_scheduling_bookings as bk')
          .join('game_scheduling_opponents as o', 'o.id', 'bk.opponent')
          .whereIn('o.kscw_team', sharedTeams).where('bk.type', 'away_proposal').where('bk.status', 'confirmed')
          .select('o.kscw_team as tid', 'bk.confirmed_proposal as n', database.raw('bk.proposed_datetime_1::text as d1'), database.raw('bk.proposed_datetime_2::text as d2'), database.raw('bk.proposed_datetime_3::text as d3')))
          .forEach((r) => { const d = r[`d${r.n}`]; if (d) addShared(d, r.tid) })
      }

      // One-off blocking absences (affecting games) across this team's roster, so
      // the lenient 3rd pick can show WHO would miss that date.
      const { absentCountOn, absentNamesOn } = await teamAbsenceLookup(teamId)

      // This team's already-scheduled game dates → adjacent-game spacing hints.
      const gameDates = await teamGameDateList(teamId)

      const ctx = { committedHome, committedProposal3, derbyAnchors, eventDates, blockDates, satCap, satDates, sharedCommitted, sharedNames, absentCountOn, absentNamesOn, gameDates }
      teamCache.set(teamId, ctx)
      return ctx
    }

    const validate = (ctx, slotId, n) => {
      const slot = slotById.get(slotId)
      if (!slot) return { valid: false, reason: 'taken' }
      if (slot.status !== 'available') return { valid: false, reason: 'taken' }
      const day = ymdOf(slot.date)
      if (ctx.eventDates.has(day)) return { valid: false, reason: 'team_event' }
      if (ctx.blockDates.has(day)) return { valid: false, reason: 'team_block' }
      if (globalBlockDates.has(day)) return { valid: false, reason: 'club_block' }
      if (closureRows.some((c) => c.hall === slot.hall
        && day >= String(c.s).slice(0, 10) && day <= String(c.e).slice(0, 10))) {
        return { valid: false, reason: 'hall_closed' }
      }
      if (derbyDateBlocked(day, ctx.derbyAnchors, boundary)) return { valid: false, reason: 'derby' }
      if (ctx.sharedCommitted.has(day)) {
        return { valid: false, reason: 'cross_team', teams: [...ctx.sharedCommitted.get(day)].map((id) => ctx.sharedNames.get(id) || String(id)) }
      }
      const gapSet = n < 3 ? ctx.committedHome : ctx.committedProposal3
      if (gapSet.has(day)) return { valid: false, reason: 'too_close' }
      if (isSaturday(day) && !ctx.satDates.has(day) && ctx.satDates.size >= ctx.satCap) {
        return { valid: false, reason: 'saturday_cap' }
      }
      if (doltschiHallIds.includes(slot.hall)) {
        if (doltschiCount >= 10) return { valid: false, reason: 'doltschi_cap' }
        if (doltschiDates.has(day)) return { valid: false, reason: 'doltschi_taken' }
      }
      return { valid: true, reason: null }
    }

    const out = []
    for (const b of bookings) {
      const ctx = await getTeamCtx(b.kscw_team)
      const proposals = []
      for (const n of [1, 2, 3]) {
        const sid = b[`proposed_slot_${n}`]
        if (sid == null) continue
        const v = validate(ctx, sid, n)
        const entry = { num: n, slot_id: sid, valid: v.valid, reason: v.reason }
        if (v.reason === 'cross_team' && v.teams?.length) entry.teams = v.teams
        const slot = slotById.get(sid)
        if (slot) {
          const day = ymdOf(slot.date)
          const adj = adjacentGames(ctx.gameDates, day)
          entry.prev_game = adj.prev_game
          entry.next_game = adj.next_game
          // Picks 1 & 2 are strict (0 absences by construction); only the lenient
          // 3rd pick can carry absentees, so surface WHO there.
          if (n === 3) {
            entry.absences = ctx.absentCountOn(day)
            entry.absent_names = ctx.absentNamesOn(day)
          }
        }
        proposals.push(entry)
      }
      const aliveCount = proposals.filter((p) => p.valid).length
      out.push({
        booking_id: b.booking_id,
        opponent_id: b.opponent_id,
        svrz_game_id: b.svrz_game_id || null,
        opponent_label: b.team_name || b.club_name || '',
        kscw_team: b.kscw_team,
        proposals,
        alive_count: aliveCount,
        all_dead: proposals.length > 0 && aliveCount === 0,
      })
    }

    // Away proposals: no home-slot validity (the venue is the opponent's hall),
    // but the spielplaner still wants the spacing + who'd be absent for each
    // date the opponent picked. Empty unless opts.includeAway.
    for (const b of awayBookings) {
      const ctx = await getTeamCtx(b.kscw_team)
      const proposals = []
      for (const n of [1, 2, 3]) {
        const dt = b[`d${n}`]
        if (!dt) continue
        const day = ymdOf(dt)
        if (!day) continue
        const adj = adjacentGames(ctx.gameDates, day)
        proposals.push({
          num: n,
          slot_id: 0,
          valid: true,
          reason: null,
          prev_game: adj.prev_game,
          next_game: adj.next_game,
          absences: ctx.absentCountOn(day),
          absent_names: ctx.absentNamesOn(day),
        })
      }
      out.push({
        booking_id: b.booking_id,
        opponent_id: b.opponent_id,
        svrz_game_id: b.svrz_game_id || null,
        opponent_label: b.team_name || b.club_name || '',
        kscw_team: b.kscw_team,
        proposals,
        alive_count: proposals.length,
        all_dead: false,
      })
    }
    return out
  }

  // GET /kscw/terminplanung/team-calendar/:teamId — read-only schedule for one
  // team, visible to ANY authenticated member (the team page is open to all
  // logged-in users). Reads via knex (bypasses item permissions) and returns
  // ONLY the fields the calendar needs — never the opponent's contact name,
  // contact email, invite token, or admin notes. Mirrors the active-season
  // pick the frontend makes (status='open', else most recent).
  router.get('/terminplanung/team-calendar/:teamId', async (req, res) => {
    try {
      if (!req.accountability?.user && !req.accountability?.admin) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      const teamId = Number(req.params.teamId)
      if (!Number.isFinite(teamId)) return res.status(400).json({ error: 'Invalid team' })

      const seasons = await database('game_scheduling_seasons')
        .select('id', 'season', 'status', 'spielsamstage')
        .orderBy('date_created', 'desc')
      const season = seasons.find((s) => s.status === 'open') || seasons[0] || null
      if (!season) return res.json({ season: null, slots: [], bookings: [] })

      const slots = await database('game_scheduling_slots')
        .where({ season: season.id, kscw_team: teamId })
        .select(
          'id', database.raw('date::text as date'), 'start_time', 'end_time',
          'status', 'source', 'hall', 'kscw_team',
        )
        .orderBy('date', 'asc')

      // Opponents of this team → their bookings. Only safe label fields are
      // selected; contact_email / contact_name / token are never read here.
      const opponents = await database('game_scheduling_opponents')
        .where({ season: season.id, kscw_team: teamId })
        .select('id', 'kscw_team', 'club_name', 'team_name')
      const oppById = new Map(opponents.map((o) => [o.id, o]))
      const oppIds = opponents.map((o) => o.id)

      let bookings = []
      if (oppIds.length) {
        const rows = await database('game_scheduling_bookings')
          .where('season', season.id)
          .whereIn('opponent', oppIds)
          .select(
            'id', 'type', 'status', 'opponent', 'slot', 'confirmed_proposal',
            database.raw('proposed_datetime_1::text as proposed_datetime_1'),
            database.raw('proposed_datetime_2::text as proposed_datetime_2'),
            database.raw('proposed_datetime_3::text as proposed_datetime_3'),
            'proposed_slot_1', 'proposed_slot_2', 'proposed_slot_3',
          )
        bookings = rows.map((b) => ({ ...b, opponent: oppById.get(b.opponent) || null }))
      }

      return res.json({ season, slots, bookings })
    } catch (err) {
      log.error({ msg: `team-calendar: ${err.message}`, endpoint: 'terminplanung/team-calendar', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      return res.status(500).json({ error: 'Failed to load team calendar' })
    }
  })

  // ── Cross-team conflicts for the spielplanung calendar overlay ────────────
  // For the given KSCW team(s), the dates a roster-sharing team (shared player or
  // coach, via sharedPlayerTeams) already plays — a real game, a booked home slot,
  // or a confirmed away proposal. These are the exact days the cross-team same-day
  // rule blocks a home slot on (see the slots/:token + confirm guards), surfaced on
  // the calendar so a planner can SEE why a date is unavailable. Read-only.
  router.get('/terminplanung/admin/cross-team-conflicts', async (req, res) => {
    try {
      if (!req.accountability?.user && !req.accountability?.admin) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      const teamIds = String(req.query.teams || '').split(',')
        .map((x) => Number(x)).filter((x) => Number.isFinite(x))
      if (!teamIds.length) return res.json({ conflicts: [] })

      // Map each roster-sharing team → the selected team(s) it affects.
      const sharedToSelected = new Map()
      for (const tid of teamIds) {
        for (const s of await sharedPlayerTeams(tid)) {
          if (!sharedToSelected.has(s)) sharedToSelected.set(s, new Set())
          sharedToSelected.get(s).add(tid)
        }
      }
      const sharedIds = [...sharedToSelected.keys()]
      if (!sharedIds.length) return res.json({ conflicts: [] })

      const nameById = new Map((await database('teams')
        .whereIn('id', [...new Set([...teamIds, ...sharedIds])]).select('id', 'name'))
        .map((t) => [t.id, t.name]))

      // date 'YYYY-MM-DD' -> conflict items. One row per (date, shared team): a real
      // game wins over a booked slot / away proposal for the same fixture.
      const byDate = new Map()
      const seen = new Set()
      const add = (date, sharedTeamId, extra) => {
        const d = String(date || '').slice(0, 10)
        if (!d) return
        const k = `${d}|${sharedTeamId}`
        if (seen.has(k)) return
        seen.add(k)
        const affects = [...(sharedToSelected.get(sharedTeamId) || [])]
          .map((id) => nameById.get(id)).filter(Boolean).sort()
        let arr = byDate.get(d)
        if (!arr) { arr = []; byDate.set(d, arr) }
        arr.push({
          team_id: sharedTeamId,
          team_name: nameById.get(sharedTeamId) || String(sharedTeamId),
          affects,
          ...extra,
        })
      }

      // Real games carry home/away text for a readable matchup.
      ;(await database('games').whereIn('kscw_team', sharedIds).whereNotNull('date')
        .select('kscw_team', database.raw('date::text as d'), 'home_team', 'away_team'))
        .forEach((g) => add(g.d, g.kscw_team, {
          matchup: [g.home_team, g.away_team].filter(Boolean).join(' – ') || null, kind: 'game',
        }))
      // Booked home slots (fixture decided, game row may not exist yet).
      ;(await database('game_scheduling_slots').whereIn('kscw_team', sharedIds)
        .where('status', 'booked').select('kscw_team', database.raw('date::text as d')))
        .forEach((s) => add(s.d, s.kscw_team, { matchup: null, kind: 'home' }))
      // Confirmed away proposals.
      ;(await database('game_scheduling_bookings as b')
        .join('game_scheduling_opponents as o', 'o.id', 'b.opponent')
        .whereIn('o.kscw_team', sharedIds).where('b.type', 'away_proposal').where('b.status', 'confirmed')
        .select('o.kscw_team as t', 'b.confirmed_proposal as n',
          database.raw('b.proposed_datetime_1::text as d1'), database.raw('b.proposed_datetime_2::text as d2'), database.raw('b.proposed_datetime_3::text as d3')))
        .forEach((b) => { const d = b[`d${b.n}`]; if (d) add(d, b.t, { matchup: null, kind: 'away' }) })

      const conflicts = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, items]) => ({ date, items: items.sort((x, y) => x.team_name.localeCompare(y.team_name)) }))
      return res.json({ conflicts })
    } catch (err) {
      log.error({ msg: `cross-team-conflicts: ${err.message}`, endpoint: 'terminplanung/admin/cross-team-conflicts', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      return res.status(500).json({ error: 'Failed to load cross-team conflicts' })
    }
  })

  // ── Admin: full availability picture for one team ─────────────────────────
  // Mirrors the offer computation of GET /terminplanung/slots/:token (keep the
  // two in sync!) but with no opponent context: every pending first-proposal
  // hold counts as taken (no excludeOpponent) — the conservative view a
  // spielplaner can email to any opponent. Returns the offered home slots
  // tiered strict / 3rd-pick-only plus the blocked away-date sets.
  async function computeTeamAvailability(seasonRow, teamRow) {
    const seasonId = seasonRow.id
    const teamId = teamRow.id
    const gaps = await seasonGaps(seasonId)
    const held = { includeHeld: true }
    const committedHome = await committedGameDates(teamId, gaps.home, held)
    const committedProposal = await committedGameDates(teamId, gaps.proposal, held)
    const committedProposal3 = await committedGameDates(teamId, gaps.proposal3, held)

    const rueckStart = rueckrundeStart(seasonRow)
    const derbyAnchors = await confirmedDerbyAnchors(teamId, seasonId, rueckStart)
    const derbyBlocked = buildDerbyBlockedSet(derbyAnchors, rueckStart, seasonRow)
    // Configurable season offer window — bounds home slots + away dates.
    const offerWindow = seasonOfferWindow(seasonRow)

    const DOLTSCHI_SEASON_CAP = 10
    const doltschiHallIds = await database('halls')
      .whereRaw("LOWER(name) LIKE '%döltschi%' OR LOWER(name) LIKE '%doltschi%'").pluck('id')
    const isDoltschiHall = (h) => h != null && doltschiHallIds.includes(h)
    let doltschiFull = false
    const doltschiTakenDates = new Set()
    if (doltschiHallIds.length) {
      const bookedDoltschi = await database('game_scheduling_slots')
        .where('season', seasonId).where('status', 'booked')
        .whereIn('hall', doltschiHallIds)
        .select(database.raw('date::text as d'))
      doltschiFull = bookedDoltschi.length >= DOLTSCHI_SEASON_CAP
      for (const r of bookedDoltschi) doltschiTakenDates.add(String(r.d).slice(0, 10))
    }
    const offeredDoltschiDates = new Set()

    const slotRows = await database('game_scheduling_slots')
      .where('kscw_team', teamId)
      .where('status', 'available')
      // Configurable season window: never offer a slot outside [open, close].
      .modify((q) => { if (offerWindow) q.whereBetween('date', [offerWindow.start, offerWindow.end]) })
      .whereNotExists(function () {
        this.select(database.raw('1'))
          .from('events as e')
          .join('events_teams as et', 'et.events_id', 'e.id')
          .whereRaw('et.teams_id = ?', [teamId])
          .whereRaw(
            'game_scheduling_slots.date BETWEEN ' +
            "(e.start_date AT TIME ZONE 'Europe/Zurich')::date " +
            "AND (COALESCE(e.end_date, e.start_date) AT TIME ZONE 'Europe/Zurich')::date"
          )
      })
      .whereNotExists(function () {
        this.select(database.raw('1'))
          .from('scheduling_blocks as sb')
          .whereRaw('sb.team = ?', [teamId])
          .whereRaw('game_scheduling_slots.date BETWEEN sb.start_date AND sb.end_date')
      })
      .whereNotExists(function () {
        this.select(database.raw('1'))
          .from('hall_closures as hc')
          .whereRaw('hc.hall = game_scheduling_slots.hall')
          .whereRaw('game_scheduling_slots.date BETWEEN hc.start_date AND hc.end_date')
      })
      // A basketball game on that court takes the floor for volleyball too
      // (migration 346). Read-time like the closures above, so a placement made
      // after slot generation is respected without regenerating.
      .modify(excludeBbFloorClaims)
      // Never offer a court that a multi-hall game already claims (migration 221).
      // A combo booking marks only its PRIMARY hall taken; the extra courts live
      // in `additional_halls`, which no other availability query reads. Slots are
      // per-team and A and B are routinely offered to two different teams at the
      // same time, so without this an opponent could book KWI B underneath an
      // A+B derby and put two games on one court.
      .whereNotExists(function () {
        this.select(database.raw('1'))
          .from('game_scheduling_slots as combo')
          .whereRaw('combo.date = game_scheduling_slots.date')
          .whereRaw('combo.start_time = game_scheduling_slots.start_time')
          .whereRaw('combo.id <> game_scheduling_slots.id')
          .whereRaw("combo.status IN ('booked','blocked')")
          .whereRaw('combo.additional_halls IS NOT NULL')
          .whereRaw('combo.additional_halls::jsonb @> to_jsonb(game_scheduling_slots.hall)')
      })
      .select('game_scheduling_slots.*', database.raw(
        '(SELECT count(DISTINCT a.member) FROM absences a ' +
        'JOIN member_teams mt ON mt.member = a.member ' +
        'WHERE mt.team = ? AND (mt.guest_level = 0 OR mt.guest_level IS NULL) ' +
        "AND a.type IS DISTINCT FROM 'weekly' " +
        'AND a.blocking IS NOT FALSE ' +
        'AND a.start_date::date <= game_scheduling_slots.date AND a.end_date::date >= game_scheduling_slots.date ' +
        "AND (a.affects::jsonb @> '\"all\"' OR a.affects::jsonb @> '\"games\"')) as abs_count",
        [teamId],
      ))
      .orderBy('date')

    const hallNameById = {}
    ;(await database('halls').select('id', 'name')).forEach((h) => { hallNameById[h.id] = h.name })
    const ymd = (v) => {
      if (typeof v === 'string') return v.slice(0, 10)
      const d = new Date(v)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    const isJr = isJuniorTeam(teamRow.name)
    const spielsamstagDates = new Set(
      (Array.isArray(seasonRow?.spielsamstage)
        ? seasonRow.spielsamstage
        : (() => { try { return JSON.parse(seasonRow?.spielsamstage || '[]') } catch { return [] } })())
        .map((x) => String(x?.date || '').slice(0, 10)).filter(Boolean),
    )
    const isSpielsamstagWeekendSunday = (date) => {
      const sat = new Date(`${date}T00:00:00Z`)
      sat.setUTCDate(sat.getUTCDate() - 1)
      return spielsamstagDates.has(sat.toISOString().slice(0, 10))
    }

    const xTeams = await sharedPlayerTeams(teamId)
    const xCommitted = new Set()
    if (xTeams.length) {
      ;(await database('games').whereIn('kscw_team', xTeams).whereNotNull('date')
        .select(database.raw('date::text as d'))).forEach((r) => xCommitted.add(String(r.d).slice(0, 10)))
      ;(await database('game_scheduling_slots').whereIn('kscw_team', xTeams).where('status', 'booked')
        .select(database.raw('date::text as d'))).forEach((r) => xCommitted.add(String(r.d).slice(0, 10)))
      ;(await database('game_scheduling_bookings as bk')
        .join('game_scheduling_opponents as o', 'o.id', 'bk.opponent')
        .whereIn('o.kscw_team', xTeams).where('bk.type', 'away_proposal').where('bk.status', 'confirmed')
        .select('bk.confirmed_proposal as n', database.raw('bk.proposed_datetime_1::text as d1'), database.raw('bk.proposed_datetime_2::text as d2'), database.raw('bk.proposed_datetime_3::text as d3')))
        .forEach((r) => { const d = r[`d${r.n}`]; if (d) xCommitted.add(String(d).slice(0, 10)) })
    }

    const satCap = await teamSaturdayCap(teamRow)
    const satDates = await committedSaturdayDates(teamId, database, seasonId)
    const awaySatDates = await committedAwaySaturdayDates(teamId, database, seasonId)

    const slots = slotRows
      .map((s) => {
        const date = ymd(s.date)
        const absCount = Number(s.abs_count || 0)
        if (committedProposal3.has(date) || absCount >= 3) return null
        if (derbyBlocked.has(date)) return null
        if (xCommitted.has(date)) return null
        if (isSaturday(date) && !satDates.has(date) && satDates.size >= satCap) return null
        if (isDoltschiHall(s.hall)) {
          if (doltschiFull || doltschiTakenDates.has(date) || offeredDoltschiDates.has(date)) return null
          offeredDoltschiDates.add(date)
        }
        return {
          id: s.id,
          date,
          start_time: String(s.start_time).slice(0, 5),
          end_time: String(s.end_time).slice(0, 5),
          source: s.source,
          hall_id: s.hall,
          hall_name: hallNameById[s.hall] || '',
          abs_count: absCount,
          strict: !committedHome.has(date) && absCount === 0 && !(isJr && (isSunday(date) || s.source === 'spielhalle')),
        }
      })
      .filter(Boolean)

    // Juniors: promote last-resort tiers to strict (pick 1 & 2) — Friday Spielhalle
    // when the strict pool (own slot / Spielsamstag / Döltschi) has fewer than 2
    // distinct dates, Sundays a sibling junior team plays (cluster the U-teams), then
    // any Sunday as a fallback when still under 2. Mirrors GET slots/:token so the
    // team-availability dialog shows the same tiering.
    if (isJr) {
      const usedJuniorSundays = await juniorSundaysInUse(teamId)
      const strictDates = new Set(slots.filter((s) => s.strict).map((s) => s.date))
      const promote = (match) => {
        for (const s of slots) {
          if (match(s) && s.abs_count === 0 && !committedHome.has(s.date)) {
            s.strict = true
            strictDates.add(s.date)
          }
        }
      }
      if (strictDates.size < 2) promote((s) => s.source === 'spielhalle' && !isSunday(s.date))
      promote((s) => isSunday(s.date) && usedJuniorSundays.has(s.date))
      if (strictDates.size < 2) promote((s) => isSunday(s.date))
    }

    // Away blocked-date sets — same composition as slots/:token.
    const eventSet = new Set()
    const addRange = (s, e) => {
      if (!s) return
      const d = new Date(`${s}T00:00:00Z`)
      const end = new Date(`${e || s}T00:00:00Z`)
      for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) eventSet.add(d.toISOString().slice(0, 10))
    }
    const evRows = await database('events as e')
      .join('events_teams as et', 'et.events_id', 'e.id')
      .where('et.teams_id', teamId)
      .select(
        database.raw("(e.start_date AT TIME ZONE 'Europe/Zurich')::date::text as s"),
        database.raw("(COALESCE(e.end_date, e.start_date) AT TIME ZONE 'Europe/Zurich')::date::text as e"),
      )
    evRows.forEach((r) => addRange(r.s, r.e))
    const blockRows = await database('scheduling_blocks')
      .where('team', teamId)
      .select(database.raw('start_date::text as s'), database.raw('end_date::text as e'))
    blockRows.forEach((r) => addRange(r.s, r.e))
    for (const d of derbyBlocked) eventSet.add(d)
    for (const d of xCommitted) eventSet.add(d)
    const absRows = await database('absences as a')
      .join('member_teams as mt', 'mt.member', 'a.member')
      .where('mt.team', teamId)
      .where(function () { this.where('mt.guest_level', 0).orWhereNull('mt.guest_level') })
      .whereRaw("a.type IS DISTINCT FROM 'weekly'")
      .whereRaw('a.blocking IS NOT FALSE')
      .whereRaw("(a.affects::jsonb @> '\"all\"' OR a.affects::jsonb @> '\"games\"')")
      .select(database.raw('a.member as member'), database.raw('a.start_date::text as s'), database.raw('a.end_date::text as e'))
    const absByDate = {}
    for (const r of absRows) {
      const d = new Date(`${r.s}T00:00:00Z`)
      const end = new Date(`${r.e || r.s}T00:00:00Z`)
      for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        const k = d.toISOString().slice(0, 10)
        ;(absByDate[k] || (absByDate[k] = new Set())).add(r.member)
      }
    }
    const strictSet = new Set(eventSet)
    for (const d of committedProposal) strictSet.add(d)
    const looseSet = new Set(eventSet)
    for (const d of committedProposal3) looseSet.add(d)
    for (const [k, members] of Object.entries(absByDate)) {
      strictSet.add(k)
      if (members.size >= 3) looseSet.add(k)
    }
    const noSatAway = await teamNoSaturday(teamId)
    if ((!isJr || noSatAway) && offerWindow) {
      const swEnd = new Date(`${offerWindow.end}T00:00:00Z`)
      for (const d = new Date(`${offerWindow.start}T00:00:00Z`); d <= swEnd; d.setUTCDate(d.getUTCDate() + 1)) {
        const dow = d.getUTCDay()
        if ((!isJr && dow === 0) || (noSatAway && dow === 6)) { const k = d.toISOString().slice(0, 10); strictSet.add(k); looseSet.add(k) }
      }
    }

    const season_window = offerWindow

    return {
      team: { id: teamId, name: teamRow.name || '' },
      slots,
      blocked_away_strict: [...strictSet].sort(),
      blocked_away_loose: [...looseSet].sort(),
      season_window,
      saturday: {
        cap: Number.isFinite(satCap) ? satCap : null,
        used: satDates.size,
        away_used: awaySatDates.size,
        no_saturday: noSatAway,
      },
    }
  }

  // GET /kscw/terminplanung/admin/team-availability?kscw_team=&season= — the
  // spielplaner's view of everything still offerable for one team (home slots
  // tiered + away blocked dates), e.g. to email an opponent or export.
  // Read-only → coaches/TRs of the team may also view (canViewTeamScheduling).
  router.get('/terminplanung/admin/team-availability', async (req, res) => {
    try {
      const { kscw_team, season } = req.query
      if (!kscw_team || !season) return res.status(400).json({ error: 'kscw_team, season required' })
      if (!(await canViewTeamScheduling(req, kscw_team))) return res.status(403).json({ error: 'Not authorized for this team' })
      const seasonRow = await database('game_scheduling_seasons').where('id', season).first()
      if (!seasonRow) return res.status(404).json({ error: 'season not found' })
      const teamRow = await database('teams').where('id', kscw_team).first()
      if (!teamRow) return res.status(404).json({ error: 'kscw_team not found' })
      res.json(await computeTeamAvailability(seasonRow, teamRow))
    } catch (err) {
      log.error({ msg: `team-availability: ${err.message}`, endpoint: 'terminplanung/admin/team-availability', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // ── Saturday hall rule (KWI gym is shared with basketball) ────────────────
  // The KWI gym is a double hall (KWI A + KWI B) plus a single hall (KWI C). A
  // lone Saturday home game only needs one court, so it belongs in KWI C —
  // leaving the double hall (A+B) free for basketball. Two games at the same
  // time take the double hall (A+B); three fill A+B+C. The rule is self-healing:
  // it runs on every booking change (via reconcileBookingsToGames and the direct
  // confirm/manual/delete endpoints), so adding or removing a game at a given
  // time re-sorts that time's halls automatically. Only KWI home games are
  // touched (Döltschi / away / other venues are left alone) and a hall closed
  // that day is never targeted. Concurrency is grouped by exact start time — the
  // Spielsamstag grid is fixed and 2.5 h apart, so two games never overlap
  // across adjacent times.

  // Resolve the KWI A/B/C hall ids by name (robust to a hall re-id between
  // dev/prod). Returns { A, B, C } with null for any that's missing.
  async function kwiHallIds(db = database) {
    const rows = await db('halls')
      .whereRaw("LOWER(name) IN ('kwi a', 'kwi b', 'kwi c')")
      .select('id', 'name')
    const byName = {}
    for (const r of rows) byName[String(r.name).trim().toLowerCase()] = r.id
    return { A: byName['kwi a'] ?? null, B: byName['kwi b'] ?? null, C: byName['kwi c'] ?? null }
  }

  // Normalize the hall of every confirmed Saturday KWI home game in a season per
  // the rule above. Updates game_scheduling_slots.hall in place; returns the list
  // of bookings whose hall changed so the caller can re-push them to VolleyManager
  // (this function never pushes — separation of concerns). Idempotent: re-running
  // with no concurrency change moves nothing.
  async function rebalanceSaturdayHalls(seasonId, { db = database } = {}) {
    const kwi = await kwiHallIds(db)
    if (!kwi.A || !kwi.B || !kwi.C) return { moved: [], groups: 0 } // halls missing → no-op
    const kwiIds = [kwi.A, kwi.B, kwi.C]

    // Confirmed, still-upcoming home games this season sitting in a KWI hall,
    // with their booking. Past/played games are skipped — their hall is settled
    // and VM rejects edits to a played game.
    const rows = await db('game_scheduling_slots as s')
      .join('game_scheduling_bookings as b', 'b.slot', 's.id')
      .where('b.type', 'home_slot_pick').where('b.status', 'confirmed')
      .where('s.season', seasonId).where('s.status', 'booked')
      .whereRaw('s.date >= CURRENT_DATE')
      .whereIn('s.hall', kwiIds)
      // A multi-court booking (migration 221 — e.g. an H1/H3 derby deliberately
      // played across KWI A+B) opts OUT of this rule. The rule assumes one game
      // = one court and rewrites `hall` in place; applied to a combo it would
      // silently move the primary and strand `additional_halls`, leaving a set
      // like {C, B} that no VM gym exists for. Someone ticked both courts on
      // purpose — that beats the automatic re-sort.
      .whereNull('s.additional_halls')
      .select('s.id as slot_id', 's.hall', 'b.id as booking_id', 'b.svrz_game_id',
        db.raw('s.date::text as d'), db.raw('s.start_time::text as st'))

    // Group Saturday slots by date|start_time.
    const groups = new Map()
    for (const r of rows) {
      const ymd = String(r.d).slice(0, 10)
      if (!isSaturday(ymd)) continue
      const key = `${ymd}|${String(r.st).slice(0, 5)}`
      if (!groups.has(key)) groups.set(key, { ymd, items: [] })
      groups.get(key).items.push(r)
    }
    if (!groups.size) return { moved: [], groups: 0 }

    // Which KWI halls are closed on a given date (cached per date).
    const closedCache = new Map()
    const closedKwiOn = async (ymd) => {
      if (closedCache.has(ymd)) return closedCache.get(ymd)
      const closed = await db('hall_closures')
        .whereIn('hall', kwiIds)
        .whereRaw('?::date BETWEEN start_date AND end_date', [ymd])
        .pluck('hall')
      const set = new Set(closed.map(Number))
      closedCache.set(ymd, set)
      return set
    }

    const moved = []
    for (const { ymd, items } of groups.values()) {
      const closed = await closedKwiOn(ymd)
      const isOpen = (id) => !closed.has(Number(id))
      // Lone game → C first (fallback A, B). Pairs/trios → the double hall A+B
      // first, then C. Filter to halls that are open that day.
      const pref = (items.length === 1 ? [kwi.C, kwi.A, kwi.B] : [kwi.A, kwi.B, kwi.C]).filter(isOpen)
      // Deterministic item order (by slot id) so re-runs are stable.
      const sorted = [...items].sort((a, b) => Number(a.slot_id) - Number(b.slot_id))
      for (let i = 0; i < sorted.length; i++) {
        const it = sorted[i]
        // pref[i] is this game's DISTINCT open hall (pref holds distinct ids, so
        // games 0..pref.length-1 never collide). Once the open KWI halls are
        // exhausted — more concurrent games than open halls — there is none.
        const target = i < pref.length ? pref[i] : null
        if (target == null) {
          // No distinct open hall remains. The game still sits in a KWI hall
          // (query filter) that is now either a duplicate of a hall already
          // assigned above or a closed one — leaving it silently double-books a
          // court or pins the game to a shut hall. Clear the stale override to
          // null so the over-subscription surfaces (visible + re-pushed) and
          // needs manual resolution, instead of being hidden as a valid booking.
          if (it.hall != null) {
            await db('game_scheduling_slots').where('id', it.slot_id).update({ hall: null })
            moved.push({ slotId: it.slot_id, bookingId: it.booking_id, svrzId: it.svrz_game_id || null, date: ymd, from: it.hall, to: null })
          }
          continue
        }
        if (Number(it.hall) === Number(target)) continue
        await db('game_scheduling_slots').where('id', it.slot_id).update({ hall: target })
        moved.push({ slotId: it.slot_id, bookingId: it.booking_id, svrzId: it.svrz_game_id || null, date: ymd, from: it.hall, to: target })
      }
    }
    return { moved, groups: groups.size }
  }

  // Background, staggered VM re-push for bookings whose hall the Saturday rebalance
  // changed. Staggered so a big first run doesn't hit VolleyManager with dozens of
  // simultaneous logins (no batch VM API — each push is a child process). Detached
  // from the request lifecycle: callers never await it.
  function repushMovedBookings(moved, { excludeBookingId = null } = {}) {
    const list = (moved || []).filter((m) => m && m.bookingId && Number(m.bookingId) !== Number(excludeBookingId))
    if (!list.length) return
    ;(async () => {
      for (const m of list) {
        try {
          await database('game_scheduling_bookings').where('id', m.bookingId).update({ vm_push_status: 'queued', vm_push_error: null })
          await spawnVmPush(m.bookingId, { svrzId: m.svrzId || null })
        } catch (e) { log.warn(`Saturday-hall VM re-push failed (booking ${m.bookingId}): ${e.message}`) }
        await new Promise((r) => setTimeout(r, 700)) // stagger child spawns
      }
    })().catch((e) => log.warn(`Saturday-hall VM re-push batch failed: ${e.message}`))
  }

  // Actor trail for the Saturday rebalance cascade: it can silently move (or, on
  // over-subscription, null out) OTHER teams' confirmed bookings — a previously
  // lone game bumped into the A+B double hall when a second game lands at its
  // time. Record one audit line per bumped booking so the cascade is attributable
  // to whoever triggered it. The triggering action's own booking is excluded (it
  // already has its own confirm/manual log line). Best-effort, mirrors the
  // excludeBookingId filter used by repushMovedBookings.
  async function logRebalanceMoves(req, moved, { excludeBookingId = null } = {}) {
    const others = (moved || []).filter((m) => m && m.bookingId && Number(m.bookingId) !== Number(excludeBookingId))
    for (const m of others) {
      await writeUserLog(database, log, {
        accountability: req.accountability,
        action: 'update',
        collection: 'game_scheduling_slots',
        recordId: m.slotId,
        data: { kind: 'saturday_rebalance_move', booking: m.bookingId, date: m.date, from_hall: m.from ?? null, to_hall: m.to ?? null },
      })
    }
  }

  // ── Mirror confirmed bookings into the `games` collection ─────────────────
  // Booked games only reach the member-facing calendars once a `games` row
  // exists, but the SV national feed (sv-sync) lags the scheduling tool by
  // months at season start. So every confirmed booking is mirrored into
  // `games` in exactly the shape sv-sync would create (game_id
  // `vb_<svrz_number>`, source 'swiss_volley') — when the national feed goes
  // live, sv-sync matches by game_id and simply adopts the row. Create/update
  // only, never deletes: a row with no matching booking may be legitimately
  // scheduled outside the tool (VM is the source of truth there). Rows at
  // status 'completed' are never touched.
  async function reconcileBookingsToGames(seasonId, { silent = false } = {}) {
    const seasonRow = await database('game_scheduling_seasons').where('id', seasonId).first()
    if (!seasonRow) return { created: 0, updated: 0, skipped: 0, moved: [] }

    // Normalize Saturday KWI halls FIRST so the games mirror below reflects the
    // corrected slot halls. Self-heals any path that lands here (confirm-away,
    // sync-away, the reconcile/optimize endpoints). Best-effort.
    let rebalanced = { moved: [], groups: 0 }
    try { rebalanced = await rebalanceSaturdayHalls(seasonId) } catch (e) { log.warn(`Saturday hall rebalance failed: ${e.message}`) }

    const opps = await database('game_scheduling_opponents as o')
      .where('o.season', seasonId)
      .whereExists(function () {
        this.select(database.raw('1')).from('game_scheduling_bookings as b')
          .whereRaw('b.opponent = o.id').where('b.status', 'confirmed')
      })
      .select('o.*')

    let created = 0, updated = 0, skipped = 0
    const desired = []
    for (const opp of opps) {
      const fixtures = await opponentSvrzFixtures(opp)
      if (!fixtures.length) { skipped++; continue }
      const fxRows = await database('svrz_games').whereIn('svrz_persistence_id', fixtures.map((f) => f.id))
      const fxById = new Map(fxRows.map((r) => [String(r.svrz_persistence_id), r]))
      const bookings = await database('game_scheduling_bookings')
        .where('opponent', opp.id).where('status', 'confirmed')
        .select('*',
          database.raw('proposed_datetime_1::text as d1'),
          database.raw('proposed_datetime_2::text as d2'),
          database.raw('proposed_datetime_3::text as d3'))
      for (const b of bookings) {
        const isHome = b.type === 'home_slot_pick'
        const side = fixtures.filter((f) => f.is_home_kscw === isHome)
        const fxMeta = b.svrz_game_id
          ? side.find((f) => String(f.id) === String(b.svrz_game_id))
          : side[0]
        const fx = fxMeta ? fxById.get(String(fxMeta.id)) : null
        if (!fx || !fx.svrz_number) { skipped++; continue }

        let date = null, time = null, hallId = null, place = ''
        if (isHome) {
          if (!b.slot) { skipped++; continue }
          const slot = await database('game_scheduling_slots').where('id', b.slot)
            .first('hall', database.raw('date::text as d'), database.raw('start_time::text as st'))
          if (!slot?.d) { skipped++; continue }
          date = String(slot.d).slice(0, 10)
          time = weekdayHomeTime(date, slot.st)
          hallId = slot.hall || null
        } else {
          const dt = b[`d${b.confirmed_proposal || 1}`] || ''
          date = String(dt).slice(0, 10)
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { skipped++; continue }
          const m = String(dt).match(/[T ](\d{2}:\d{2})/)
          time = m ? m[1] : null
          place = String(b[`proposed_place_${b.confirmed_proposal || 1}`] || '')
        }

        desired.push({
          game_id: `vb_${fx.svrz_number}`,
          home_team: fx.home_team_name || '',
          away_team: fx.away_team_name || '',
          kscw_team: opp.kscw_team,
          hall: hallId,
          away_hall_json: !isHome && place ? JSON.stringify({ name: place, address: '', city: '', plus_code: '' }) : null,
          date,
          time,
          league: fx.league_name || fx.league_short || '',
          round: '',
          season: seasonRow.season || '',
          type: isHome ? 'home' : 'away',
          status: 'scheduled',
          home_score: 0,
          away_score: 0,
          sets_json: '[]',
          referees_json: '[]',
          source: 'swiss_volley',
        })
      }
    }

    const apply = async (db) => {
      for (const data of desired) {
        const existing = await db('games')
          .where('game_id', data.game_id).where('kscw_team', data.kscw_team)
          .first('id', 'status', 'home_team', 'away_team', 'type', 'hall',
            database.raw('date::text as date_txt'), database.raw('time::text as time_txt'))
        if (existing) {
          // Never touch a played game; sv-sync owns results.
          if (existing.status === 'completed') { skipped++; continue }
          const changed =
            String(existing.date_txt || '').slice(0, 10) !== data.date ||
            String(existing.time_txt || '').slice(0, 5) !== String(data.time || '').slice(0, 5) ||
            String(existing.hall ?? '') !== String(data.hall ?? '') ||
            String(existing.home_team || '') !== data.home_team ||
            String(existing.away_team || '') !== data.away_team ||
            String(existing.type || '') !== data.type
          if (!changed) { skipped++; continue }
          await db('games').where('id', existing.id).update({
            date: data.date, time: data.time, hall: data.hall,
            home_team: data.home_team, away_team: data.away_team, type: data.type,
            away_hall_json: data.away_hall_json,
            date_updated: new Date(),
          })
          updated++
        } else {
          await db('games').insert({ ...data, date_created: new Date(), date_updated: new Date() })
          created++
        }
      }
    }
    if (silent) {
      // Transaction-scoped GUC silences trg_games_notify (migration 095) so a
      // bulk backfill doesn't push "new game" to every roster at once.
      await database.transaction(async (trx) => {
        await trx.raw("SELECT set_config('kscw.skip_games_notify', 'on', true)")
        await apply(trx)
      })
    } else {
      await apply(database)
    }
    // Re-push to VM any booking the Saturday rebalance moved (background, staggered).
    repushMovedBookings(rebalanced.moved)
    return { created, updated, skipped, moved: rebalanced.moved }
  }

  // POST /kscw/terminplanung/admin/reconcile-games { season, silent? } — manual
  // run of the booking→games mirror (backfill after deploy; re-run anytime,
  // idempotent). silent defaults to true: no notification fanout.
  router.post('/terminplanung/admin/reconcile-games', async (req, res) => {
    try {
      if (!req.accountability?.admin) return res.status(403).json({ error: 'Admin access required' })
      const seasonId = req.body?.season
      if (!seasonId) return res.status(400).json({ error: 'season required' })
      const silent = req.body?.silent !== false
      res.json(await reconcileBookingsToGames(seasonId, { silent }))
    } catch (err) {
      log.error({ msg: `reconcile-games: ${err.message}`, endpoint: 'terminplanung/admin/reconcile-games', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /kscw/terminplanung/admin/rebalance-saturday-halls { season } — run the
  // Saturday hall rule now (lone game → KWI C, pairs → KWI A+B). The rule also
  // runs automatically on every booking change; this is the admin "do it now /
  // show me what moved" trigger. Reconcile does the rebalance, mirrors the new
  // halls into `games`, and queues the VM re-push for every moved game.
  router.post('/terminplanung/admin/rebalance-saturday-halls', async (req, res) => {
    try {
      if (!(await isAdminOrSpielplaner(req))) return res.status(403).json({ error: 'Admin only' })
      const seasonId = req.body?.season
      if (!seasonId) return res.status(400).json({ error: 'season required' })
      const result = await reconcileBookingsToGames(seasonId, { silent: true })
      const moved = result.moved || []
      if (moved.length) {
        await writeUserLog(database, log, { accountability: req.accountability, action: 'update', collection: 'game_scheduling_slots', recordId: null, data: { kind: 'rebalance_saturday_halls', season: seasonId, moved: moved.length } })
      }
      res.json({ moved: moved.length, details: moved })
    } catch (err) {
      log.error({ msg: `rebalance-saturday-halls: ${err.message}`, endpoint: 'terminplanung/admin/rebalance-saturday-halls', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // GET /kscw/terminplanung/slots/:token — view available slots
  router.get('/terminplanung/slots/:token', async (req, res) => {
    try {
      // Rate limit: max 60 token lookups per 15 min per IP. This is a read-only
      // lookup the opponent page re-fetches on EVERY action (initial load +
      // after propose-home / propose-away / save-note / language flips), so it
      // needs a far higher budget than the write routes (10–20). 10 was tripping
      // 429s during normal use/testing and for clubs behind shared NAT. Keyed on
      // cf-connecting-ip (real client IP), so still tight against token scraping.
      if (!rateLimit(tokenAttempts, req, 60, 15 * 60 * 1000)) {
        return res.status(429).json({ error: 'Too many requests. Try again later.' })
      }

      const opponent = await database('game_scheduling_opponents')
        .where('token', req.params.token)
        .whereIn('status', ['active', 'invited', 'viewed', 'booked'])
        .first()
      if (!opponent) return res.status(404).json({ error: 'Invalid or expired link' })
      // A booked opponent may always VIEW their confirmed schedule past expiry;
      // only block fresh proposals (the propose endpoints re-check expiry below).
      if (opponent.status !== 'booked' && opponent.expires_at && new Date() > new Date(opponent.expires_at)) {
        return res.status(400).json({ error: 'Link expired' })
      }

      // Status lifecycle: first view transitions invited → viewed
      if (opponent.status === 'invited') {
        const nowIso = new Date().toISOString()
        await database('game_scheduling_opponents')
          .where('id', opponent.id)
          .update({ status: 'viewed', first_viewed_at: nowIso })
        opponent.status = 'viewed'
        opponent.first_viewed_at = nowIso
      }

      return res.json(await computeOpponentSlotsPayload(opponent))
    } catch (err) {
      log.error({ msg: `terminplanung/slots: ${err.message}`, endpoint: 'terminplanung/slots', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // Core slot/booking payload for ONE opponent pairing (one KSCW team ↔ one
  // opposing team). Extracted from the /terminplanung/slots/:token route so the
  // per-token page AND the club-portal aggregate endpoint (/terminplanung/club/
  // slots/:token) share ONE computation — every cap/derby/junior rule is applied
  // per pairing exactly as before. Reads only from the resolved `opponent` row;
  // returns the exact object the opponent page consumes. Throws on error (callers
  // wrap in try/catch). Declaration-hoisted, so the route above may call it.
  async function computeOpponentSlotsPayload(opponent) {
      // Games, booked home slots and confirmed away proposals — expanded by the
      // season's gap. Home slots use the home gap; away proposals use the
      // proposal gap (1-2) and the lenient proposal-3 gap.
      const gaps = await seasonGaps(opponent.season)
      // Include other opponents' held first-proposals (slot-1 / date-1 reserve the
      // date); exclude this opponent's own holds so their alternatives stay open.
      const held = { includeHeld: true, excludeOpponent: opponent.id }
      const committedHome = await committedGameDates(opponent.kscw_team, gaps.home, held)
      const committedProposal = await committedGameDates(opponent.kscw_team, gaps.proposal, held)
      const committedProposal3 = await committedGameDates(opponent.kscw_team, gaps.proposal3, held)

      // Intra-club derby clamp (Art. 27): once this team's derby dates are
      // confirmed, nothing may be offered/booked before the relevant derby date
      // within its half — neither a home slot nor an away date. `derbyBlocked` is
      // the materialised set of pre-derby dates, applied to home slots below and
      // merged into the away strict/loose sets further down.
      const seasonRow = await database('game_scheduling_seasons').where('id', opponent.season).first()
      const rueckStart = rueckrundeStart(seasonRow)
      const derbyAnchors = await confirmedDerbyAnchors(opponent.kscw_team, opponent.season, rueckStart)
      const derbyBlocked = buildDerbyBlockedSet(derbyAnchors, rueckStart, seasonRow)
      // Configurable season offer window — bounds home slots + away dates.
      const offerWindow = seasonOfferWindow(seasonRow)

      // Döltschi rules: the club may schedule at most DOLTSCHI_SEASON_CAP games in
      // Döltschi per season (club-wide), and a Döltschi DATE counts as ONE slot —
      // irrespective of the time (19:00 / 20:30) or which hall (Döltschi 1 or 2).
      // So only one Döltschi game per date, club-wide. From booked Döltschi slots.
      const DOLTSCHI_SEASON_CAP = 10
      const doltschiHallIds = await database('halls')
        .whereRaw("LOWER(name) LIKE '%döltschi%' OR LOWER(name) LIKE '%doltschi%'").pluck('id')
      const isDoltschiHall = (h) => h != null && doltschiHallIds.includes(h)
      let doltschiFull = false
      const doltschiTakenDates = new Set() // 'YYYY-MM-DD' already booked in Döltschi (any time/hall)
      if (doltschiHallIds.length) {
        const bookedDoltschi = await database('game_scheduling_slots')
          .where('season', opponent.season).where('status', 'booked')
          .whereIn('hall', doltschiHallIds)
          .select(database.raw('date::text as d'))
        doltschiFull = bookedDoltschi.length >= DOLTSCHI_SEASON_CAP
        for (const r of bookedDoltschi) {
          doltschiTakenDates.add(String(r.d).slice(0, 10))
        }
      }
      // Offer at most one Döltschi slot per DATE (time + hall 1/2 irrelevant).
      const offeredDoltschiDates = new Set()

      // Exclude slots whose date falls within any event linked to this team
      // (single-day or multi-day) — e.g. tournament weekend, team trip. Filter
      // at read time (not generation) so events added after slot generation
      // are respected without regenerating. Applies even on Spielsamstage.
      const slotRows = await database('game_scheduling_slots')
        .where('kscw_team', opponent.kscw_team)
        // Only offer available slots — a booked KWI A drops out so KWI B shows alone.
        .where('status', 'available')
        // Configurable season window: never offer a slot outside [open, close].
        .modify((q) => { if (offerWindow) q.whereBetween('date', [offerWindow.start, offerWindow.end]) })
        .whereNotExists(function () {
          this.select(database.raw('1'))
            .from('events as e')
            .join('events_teams as et', 'et.events_id', 'e.id')
            .whereRaw('et.teams_id = ?', [opponent.kscw_team])
            .whereRaw(
              'game_scheduling_slots.date BETWEEN ' +
              "(e.start_date AT TIME ZONE 'Europe/Zurich')::date " +
              "AND (COALESCE(e.end_date, e.start_date) AT TIME ZONE 'Europe/Zurich')::date"
            )
        })
        // Team blocking (migration 085) — a hard block on every proposal, like an
        // event. Dates are plain `date` columns so no TZ conversion needed.
        .whereNotExists(function () {
          this.select(database.raw('1'))
            .from('scheduling_blocks as sb')
            .whereRaw('sb.team = ?', [opponent.kscw_team])
            .whereRaw('game_scheduling_slots.date BETWEEN sb.start_date AND sb.end_date')
        })
        // Club-wide blackout (migration 160) — superadmin "no games" dates for the
        // whole club, on top of the per-team block above. Home-slot filter, same as
        // a per-team block but team-agnostic.
        .whereNotExists(function () {
          this.select(database.raw('1'))
            .from('scheduling_global_blocks as gb')
            .whereRaw('game_scheduling_slots.date BETWEEN gb.start_date AND gb.end_date')
            // Migration 286: NULL sport = club-wide; a basketball-only block must not
            // remove a volleyball slot (that is the bug the column was added for).
            .whereRaw("(gb.sport IS NULL OR gb.sport = 'volleyball')")
        })
        // Hall closures (e.g. gcal-synced Hallen-geschlossen / external hall use)
        // block HOME slots whose own hall is closed that day — you can't host
        // there. HOME-ONLY on purpose: away games are at the opponent's hall, so
        // a KWI closure must NOT block away proposals (the away sets below never
        // read hall_closures).
        .whereNotExists(function () {
          this.select(database.raw('1'))
            .from('hall_closures as hc')
            .whereRaw('hc.hall = game_scheduling_slots.hall')
            .whereRaw('game_scheduling_slots.date BETWEEN hc.start_date AND hc.end_date')
        })
        // A basketball game on that court takes the floor for volleyball too
        // (migration 346). Read-time like the closures above, so a placement made
        // after slot generation is respected without regenerating.
        .modify(excludeBbFloorClaims)
        // Games / booked slots / confirmed proposals are filtered in JS below via
        // the committed sets. Per-slot absent-player count is kept as a COLUMN
        // (not a hard filter) so the tiering below can offer absence-laden slots
        // only as the lenient 3rd pick — mirrors the away strict/loose split.
        // (one-off blocking absences affecting games; guests + weekly don't count)
        .select('game_scheduling_slots.*', database.raw(
          '(SELECT count(DISTINCT a.member) FROM absences a ' +
          'JOIN member_teams mt ON mt.member = a.member ' +
          'WHERE mt.team = ? AND (mt.guest_level = 0 OR mt.guest_level IS NULL) ' +
          "AND a.type IS DISTINCT FROM 'weekly' " +
          'AND a.blocking IS NOT FALSE ' +
          'AND a.start_date::date <= game_scheduling_slots.date AND a.end_date::date >= game_scheduling_slots.date ' +
          "AND (a.affects::jsonb @> '\"all\"' OR a.affects::jsonb @> '\"games\"')) as abs_count",
          [opponent.kscw_team],
        ))
        .orderBy('date')

      // Shape the raw slot rows into the SlotData the opponent UI expects:
      // hall_name (rows only carry the hall id), date as yyyy-MM-dd (pg returns
      // a Date/ISO — use local getters so it isn't shifted a day by TZ), HH:MM.
      const hallNameById = {}
      ;(await database('halls').select('id', 'name')).forEach((h) => { hallNameById[h.id] = h.name })
      const ymd = (v) => {
        if (typeof v === 'string') return v.slice(0, 10)
        const d = new Date(v)
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      }
      const team = await database('teams').where('id', opponent.kscw_team).first()
      const isJr = isJuniorTeam(team?.name)
      // Junior Sunday priority: a Sunday on a Spielsamstag weekend ranks above a
      // standalone Sunday. seasonRow (fetched above for the derby clamp) holds the
      // Spielsamstag dates that tell them apart.
      const spielsamstagDates = new Set(
        (Array.isArray(seasonRow?.spielsamstage)
          ? seasonRow.spielsamstage
          : (() => { try { return JSON.parse(seasonRow?.spielsamstage || '[]') } catch { return [] } })())
          .map((x) => String(x?.date || '').slice(0, 10)).filter(Boolean),
      )
      const isSpielsamstagWeekendSunday = (date) => {
        const sat = new Date(`${date}T00:00:00Z`)
        sat.setUTCDate(sat.getUTCDate() - 1)
        return spielsamstagDates.has(sat.toISOString().slice(0, 10))
      }

      // Cross-team rule — mirror the dashboard health-check + confirm guard: don't
      // OFFER a home slot on a day a team sharing a player/coach with this team
      // already plays, else the opponent picks a date we can never confirm. This
      // filter was missing here, so blocked dates leaked into the pick page (an
      // opponent could select e.g. a day a shared team already plays at Wetzikon).
      const xTeams = await sharedPlayerTeams(opponent.kscw_team)
      const xCommitted = new Set()
      if (xTeams.length) {
        ;(await database('games').whereIn('kscw_team', xTeams).whereNotNull('date')
          .select(database.raw('date::text as d'))).forEach((r) => xCommitted.add(String(r.d).slice(0, 10)))
        ;(await database('game_scheduling_slots').whereIn('kscw_team', xTeams).where('status', 'booked')
          .select(database.raw('date::text as d'))).forEach((r) => xCommitted.add(String(r.d).slice(0, 10)))
        ;(await database('game_scheduling_bookings as bk')
          .join('game_scheduling_opponents as o', 'o.id', 'bk.opponent')
          .whereIn('o.kscw_team', xTeams).where('bk.type', 'away_proposal').where('bk.status', 'confirmed')
          .select('bk.confirmed_proposal as n', database.raw('bk.proposed_datetime_1::text as d1'), database.raw('bk.proposed_datetime_2::text as d2'), database.raw('bk.proposed_datetime_3::text as d3')))
          .forEach((r) => { const d = r[`d${r.n}`]; if (d) xCommitted.add(String(d).slice(0, 10)) })
      }

      // Saturday cap (A1/A4) — once a team has used its Saturday home-game
      // allotment, don't OFFER further Saturday slots (the health-check + confirm-
      // home guard otherwise reject the pick → an un-confirmable date was offered).
      const teamRowSat = await database('teams').where('id', opponent.kscw_team).first('id', 'name')
      const satCap = await teamSaturdayCap(teamRowSat)
      const satDates = await committedSaturdayDates(opponent.kscw_team, database, opponent.season)

      // Two-tier home slots: a slot is OFFERED if it clears the LOOSE bar
      // (proposal-3 gap + <3 absences). `strict` marks the stricter bar (home
      // gap + 0 absences) required for home picks 1 & 2; pick 3 may use any
      // offered slot. Mirrors the away strict/loose split.
      const slots = slotRows
        .map((s) => {
          const date = ymd(s.date)
          const absCount = Number(s.abs_count || 0)
          if (committedProposal3.has(date) || absCount >= 3) return null
          if (derbyBlocked.has(date)) return null  // before the derby in this half (Art. 27)
          if (xCommitted.has(date)) return null    // a shared-roster team plays that day (cross-team)
          if (isSaturday(date) && !satDates.has(date) && satDates.size >= satCap) return null // Saturday home-game cap reached
          const startHM = String(s.start_time).slice(0, 5)
          if (isDoltschiHall(s.hall)) {
            // Döltschi: drop if the season cap is reached, this date is already
            // booked in Döltschi, or we've already offered this date — one Döltschi
            // game per date (time + hall 1/2 irrelevant).
            if (doltschiFull || doltschiTakenDates.has(date) || offeredDoltschiDates.has(date)) return null
            offeredDoltschiDates.add(date)
          }
          return {
            id: s.id,
            date,
            start_time: startHM,
            end_time: String(s.end_time).slice(0, 5),
            source: s.source,
            hall_id: s.hall,
            hall_name: hallNameById[s.hall] || '',
            // Juniors: the Friday Spielhalle pool AND Sundays are last-resort —
            // never strict, so they can only be the 3rd (lenient) home pick.
            // Picks 1 & 2 take the own slot / Spielsamstag / Döltschi; pick 3
            // then prefers Friday Spielhalle, then Sundays (front-end tiering).
            strict: !committedHome.has(date) && absCount === 0 && !(isJr && (isSunday(date) || s.source === 'spielhalle')),
          }
        })
        .filter(Boolean)

      // Juniors: promote last-resort tiers to strict (pick 1 & 2), in order:
      //   1. Friday Spielhalle — when the strict pool (own slot / Spielsamstag /
      //      Döltschi) has fewer than 2 distinct strict DATES (count dates, not rows:
      //      two slots on one Saturday are one usable pick).
      //   2. Cluster Sundays — a Sunday another junior team already plays, ALWAYS, so
      //      the U-teams play together ("if possible").
      //   3. Any Sunday — fallback when steps 1-2 still leave fewer than 2 dates, so
      //      a team is never unable to propose (and can seed the cluster).
      // The confirm guard recomputes the same rules.
      let usedJuniorSundays = new Set()
      if (isJr) {
        usedJuniorSundays = await juniorSundaysInUse(opponent.kscw_team)
        const absById = new Map(slotRows.map((r) => [r.id, Number(r.abs_count || 0)]))
        const strictDates = new Set(slots.filter((s) => s.strict).map((s) => s.date))
        const promote = (match) => {
          for (const s of slots) {
            if (match(s) && absById.get(s.id) === 0 && !committedHome.has(s.date)) {
              s.strict = true
              strictDates.add(s.date)
            }
          }
        }
        if (strictDates.size < 2) promote((s) => s.source === 'spielhalle' && !isSunday(s.date)) // Friday
        promote((s) => isSunday(s.date) && usedJuniorSundays.has(s.date))                        // cluster Sundays
        if (strictDates.size < 2) promote((s) => isSunday(s.date))                               // fallback: any Sunday
      }

      const bookings = await database('game_scheduling_bookings')
        .where('opponent', opponent.id)
        .select('*')

      // Attach the official VM game number (svrz_number) to each booking from its
      // fixture — resolved across ALL statuses (not just open/waitingForApproval),
      // so a game already APPROVED in VolleyManager (which drops out of the offered
      // `games` list) still shows its number on the confirmed card.
      const bookingFixtureIds = [...new Set(bookings.map((b) => b.svrz_game_id).filter(Boolean))]
      if (bookingFixtureIds.length) {
        const numRows = await database('svrz_games')
          .whereIn('svrz_persistence_id', bookingFixtureIds)
          .select('svrz_persistence_id', 'svrz_number')
        const numById = new Map(numRows.map((r) => [String(r.svrz_persistence_id), r.svrz_number]))
        for (const b of bookings) {
          if (b.svrz_game_id != null) b.svrz_number = numById.get(String(b.svrz_game_id)) ?? null
        }
      }

      // Attach the chosen home slot's date/time/hall so the opponent sees the
      // decided home game (the slot itself is no longer in the available list).
      for (const b of bookings) {
        if (b.type === 'home_slot_pick' && b.slot) {
          const sl = await database('game_scheduling_slots').where('id', b.slot).first()
          if (sl) {
            b.slot_date = ymd(sl.date)
            b.slot_start = String(sl.start_time).slice(0, 5)
            b.slot_end = String(sl.end_time).slice(0, 5)
            b.slot_hall_name = hallNameById[sl.hall] || ''
          }
        }
        // Pending home proposal: resolve the up-to-3 proposed slots so the
        // opponent sees what they proposed + whether each is still available.
        if (b.type === 'home_slot_pick' && b.status === 'pending') {
          const ids = [b.proposed_slot_1, b.proposed_slot_2, b.proposed_slot_3].filter((x) => x != null)
          const sls = ids.length ? await database('game_scheduling_slots').whereIn('id', ids).select('*') : []
          const byId = new Map(sls.map((x) => [x.id, x]))
          b.proposed_slots = ids.map((id) => {
            const sl = byId.get(id)
            if (!sl) return { slot_id: id, available: false }
            return {
              slot_id: id,
              date: ymd(sl.date),
              start: String(sl.start_time).slice(0, 5),
              end: String(sl.end_time).slice(0, 5),
              hall_name: hallNameById[sl.hall] || '',
              available: sl.status === 'available',
            }
          })
        }
      }

      // Blocked away-proposal dates for this team — team events, games (±1 day)
      // and one-off PLAYER absences (guests + weekly unavailabilities don't
      // count). The opponent's calendar greys these out (mirrors the
      // propose-away rejection below).
      // Conflict dates for away proposals. Events are HARD blocks on every
      // proposal. Games / booked slots / confirmed proposals are gap-expanded:
      // proposals 1 & 2 use the proposal gap, proposal 3 the (smaller) proposal-3
      // gap. Absences are graded: proposals 1 & 2 reject ANY player absence;
      // proposal 3 rejects only 3+ absent. So expose two sets — strict (events ∪
      // proposal-gap games ∪ any-absence) and loose (events ∪ proposal3-gap games
      // ∪ 3+-absence).
      const eventSet = new Set()
      const addRange = (s, e) => {
        if (!s) return
        const d = new Date(`${s}T00:00:00Z`)
        const end = new Date(`${e || s}T00:00:00Z`)
        for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) eventSet.add(d.toISOString().slice(0, 10))
      }
      const evRows = await database('events as e')
        .join('events_teams as et', 'et.events_id', 'e.id')
        .where('et.teams_id', opponent.kscw_team)
        .select(
          database.raw("(e.start_date AT TIME ZONE 'Europe/Zurich')::date::text as s"),
          database.raw("(COALESCE(e.end_date, e.start_date) AT TIME ZONE 'Europe/Zurich')::date::text as e"),
        )
      evRows.forEach((r) => addRange(r.s, r.e))
      // Team blocking (migration 085) — merged into eventSet so it lands in BOTH
      // strictSet and looseSet: a hard block on away proposals 1, 2 AND 3.
      const blockRows = await database('scheduling_blocks')
        .where('team', opponent.kscw_team)
        .select(database.raw('start_date::text as s'), database.raw('end_date::text as e'))
      blockRows.forEach((r) => addRange(r.s, r.e))
      // Intra-club derby clamp — pre-derby dates hard-block every away proposal
      // too (merged into eventSet → lands in both strictSet and looseSet).
      for (const d of derbyBlocked) eventSet.add(d)
      // Cross-team — a day a roster-sharing team already plays hard-blocks every
      // away proposal too (propose-away/confirm-away reject it). Reuse the set
      // built for the home offer above so both surfaces agree.
      for (const d of xCommitted) eventSet.add(d)
      const absRows = await database('absences as a')
        .join('member_teams as mt', 'mt.member', 'a.member')
        .where('mt.team', opponent.kscw_team)
        .where(function () { this.where('mt.guest_level', 0).orWhereNull('mt.guest_level') })
        .whereRaw("a.type IS DISTINCT FROM 'weekly'")
        .whereRaw('a.blocking IS NOT FALSE') // non-blocking absences (injury, maternity) don't block scheduling
        .whereRaw("(a.affects::jsonb @> '\"all\"' OR a.affects::jsonb @> '\"games\"')")
        .select(database.raw('a.member as member'), database.raw('a.start_date::text as s'), database.raw('a.end_date::text as e'))
      const absByDate = {}
      for (const r of absRows) {
        const d = new Date(`${r.s}T00:00:00Z`)
        const end = new Date(`${r.e || r.s}T00:00:00Z`)
        for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
          const k = d.toISOString().slice(0, 10)
          ;(absByDate[k] || (absByDate[k] = new Set())).add(r.member)
        }
      }
      const strictSet = new Set(eventSet)
      for (const d of committedProposal) strictSet.add(d)
      const looseSet = new Set(eventSet)
      for (const d of committedProposal3) looseSet.add(d)
      for (const [k, members] of Object.entries(absByDate)) {
        strictSet.add(k)                        // proposals 1 & 2: any absence
        if (members.size >= 3) looseSet.add(k)  // proposal 3: only 3+ absent
      }
      // Season-window day exclusions: teams flagged no_saturday_games never play
      // away on Saturdays — grey those so they're never offered. Sundays are NOT
      // excluded away: KSCW doesn't own the opponent's venue, so the opponent may
      // host on a Sunday. (The Sunday-as-last-resort rule is HOME-only.)
      const noSatAway = await teamNoSaturday(opponent.kscw_team)
      if (noSatAway && offerWindow) {
        const swEnd = new Date(`${offerWindow.end}T00:00:00Z`)
        for (const d = new Date(`${offerWindow.start}T00:00:00Z`); d <= swEnd; d.setUTCDate(d.getUTCDate() + 1)) {
          if (d.getUTCDay() === 6) { const k = d.toISOString().slice(0, 10); strictSet.add(k); looseSet.add(k) }
        }
      }
      const blocked_away_strict = [...strictSet].sort()
      const blocked_away_loose = [...looseSet].sort()

      // SVRZ fixtures between this KSCW team and this opponent — one card per
      // fixture on the page (multi-game pairings get 2-3). Season-scoped +
      // our-side-checked, in the deterministic order bookings are keyed by.
      const svrzGames = await opponentSvrzFixtures(opponent)

      // Season offer window (configurable via season_opens/season_closes, else
      // Sep 1 → Mar 31) so the away calendar can bound itself.
      const season_window = offerWindow

      // Junior Sunday steer: a Sunday slot is "preferred" when it lands on a
      // Spielsamstag weekend (rule: Spielsamstag-weekend Sundays before other
      // Sundays) OR on a Sunday another junior team already plays a HOME game on
      // (cluster juniors onto shared Sundays). No hard block — Sundays stay
      // bookable, but only as the 3rd home pick (strict=false above).
      let slotsOut = slots
      if (isJr) {
        // usedJuniorSundays already computed above for the strict-cluster promotion.
        slotsOut = slots.map((s) => ({
          ...s,
          preferred: s.source === 'spielsonntag' && (isSpielsamstagWeekendSunday(s.date) || usedJuniorSundays.has(s.date)),
        }))
      }

      return {
        opponent: {
          id: opponent.id,
          club_name: opponent.club_name || opponent.team_name || '',
          team_name: opponent.team_name || '',
          contact_name: opponent.contact_name || '',
          contact_email: opponent.contact_email || '',
          kscw_team_id: opponent.kscw_team,
          kscw_team_name: team?.name || '',
          kscw_team_gender: team?.gender || null,
          club_id: opponent.club_id || null,
          home_game: opponent.home_game,
          away_game: opponent.away_game,
          source: opponent.source || 'self_registration',
          status: opponent.status || 'active',
          language: opponent.language || null,
          kscw_note: opponent.kscw_note || '',
          opponent_note: opponent.opponent_note || '',
        },
        games: svrzGames,
        slots: slotsOut,
        bookings,
        blocked_away_strict,
        blocked_away_loose,
        season_window,
      }
  }

  // POST /kscw/terminplanung/propose-home/:token — propose exactly 3 home slots
  // (opponent picks slots in OUR hall; the spielplaner confirms one). Mirrors
  // propose-away. Slots are NOT reserved on proposal — only the confirmed one
  // books the slot, so two opponents may propose the same slot (admin arbitrates;
  // the opponent + admin are warned a proposed slot might not be available).
  const handleProposeHome = async (req, res) => {
    try {
      if (!rateLimit(writeAttempts, req, 10, 15 * 60 * 1000)) {
        return res.status(429).json({ error: 'Too many requests. Try again later.' })
      }

      const opponent = await database('game_scheduling_opponents')
        .where('token', req.params.token)
        .whereIn('status', ['active', 'invited', 'viewed', 'booked'])
        .first()
      if (!opponent) return res.status(404).json({ error: 'Invalid link' })
      if (opponent.expires_at && new Date() > new Date(opponent.expires_at)) {
        return res.status(400).json({ error: 'Link expired' })
      }

      // Remember the language the opponent is acting in (for emails).
      const lang = VALID_LANGS.includes(String(req.body?.language || '').toLowerCase()) ? String(req.body.language).toLowerCase() : null
      if (lang) {
        await database('game_scheduling_opponents').where('id', opponent.id).update({ language: lang })
        opponent.language = lang
      }

      // Who at the opponent club is confirming (required — captured by the modal
      // on the "Confirm home games" button so we know who to follow up with).
      const proposer = parseProposer(req.body)
      if (!proposer.ok) return res.status(400).json({ error: proposer.error })

      const ids = Array.isArray(req.body?.slot_ids) ? req.body.slot_ids.map((x) => Number(x)) : []
      // 1-3 picks: when fewer than 3 slots are available a team may offer fewer
      // (no mandatory 3). Each must be a positive integer and distinct.
      if (ids.length < 1 || ids.length > 3 || ids.some((x) => !Number.isInteger(x) || x <= 0)) {
        return res.status(400).json({ error: '1 to 3 slot_ids required' })
      }
      if (new Set(ids).size !== ids.length) {
        return res.status(400).json({ error: 'slot_ids must be distinct' })
      }

      // Multi-game: which fixture of this pairing the picks are for. Absent
      // svrz_game_id targets the first home fixture (legacy clients).
      const fixtures = await opponentSvrzFixtures(opponent)
      const target = resolveTargetFixture(fixtures, true, req.body?.svrz_game_id || null)
      if (!target) return res.status(400).json({ error: 'Invalid game for this opponent' })
      // The same opponent's OTHER home games: their picks must not collide —
      // each fixture needs its own 3 distinct slots — and a fixture that's
      // already booked can't be re-proposed (the unique index would trip too).
      const allHome = await database('game_scheduling_bookings')
        .where({ opponent: opponent.id, type: 'home_slot_pick' })
        .orderBy('id').select('*')
      if (allHome.some((b) => bookingMatchesFixture(b, target) && b.status === 'confirmed')) {
        return res.status(400).json({ error: 'This game is already booked' })
      }
      const siblingSlotIds = new Set(
        allHome.filter((b) => !bookingMatchesFixture(b, target))
          .flatMap((b) => [b.proposed_slot_1, b.proposed_slot_2, b.proposed_slot_3, b.slot])
          .filter((v) => v != null).map((v) => Number(v)),
      )
      if (ids.some((x) => siblingSlotIds.has(x))) {
        return res.status(400).json({ error: 'A chosen slot is already proposed for another of your games — each game needs its own slots.' })
      }

      // Validate each proposed slot against its tier (picks 1-2 strict: home gap
      // + 0 absences; pick 3 lenient: proposal-3 gap + <3 absences), mirroring the
      // read-time list. Slots are not held.
      const gaps = await seasonGaps(opponent.season)
      const held = { includeHeld: true, excludeOpponent: opponent.id }
      const committedHome = await committedGameDates(opponent.kscw_team, gaps.home, held)
      const committedProposal3 = await committedGameDates(opponent.kscw_team, gaps.proposal3, held)
      const toYmd = (v) => (typeof v === 'string' ? v.slice(0, 10) : new Date(v).toISOString().slice(0, 10))
      const homeTeam = await database('teams').where('id', opponent.kscw_team).first()
      const homeIsJr = isJuniorTeam(homeTeam?.name)
      // Intra-club derby clamp (Art. 27): a stale page must not submit a slot
      // before this team's confirmed derby date within its half.
      const homeSeasonRow = await database('game_scheduling_seasons').where('id', opponent.season).first()
      const homeRueckStart = rueckrundeStart(homeSeasonRow)
      const homeDerbyAnchors = await confirmedDerbyAnchors(opponent.kscw_team, opponent.season, homeRueckStart)
      const homeWindow = seasonOfferWindow(homeSeasonRow)
      // Guards a stale page might bypass: the three picks must be on three
      // DIFFERENT days (same-day/different-time makes no sense), within the
      // Saturday cap, and clear of the cross-team same-day rule.
      const usedDays = new Set()
      const sharedTeamsHome = await sharedPlayerTeams(opponent.kscw_team)
      const satCapHome = await teamSaturdayCap(homeTeam)
      const satDatesHome = await committedSaturdayDates(opponent.kscw_team, database, opponent.season)

      // Friday Spielhalle and Sundays are a junior team's last-resort picks. GET
      // slots/:token promotes them to strict (pick 1 & 2): Friday when the strict
      // pool (own slot / Spielsamstag / Döltschi) has fewer than 2 distinct dates;
      // a Sunday when another junior team already plays it (cluster the U-teams);
      // and — as a fallback so a team is never stuck — ANY Sunday when the strict
      // pool + Friday + clustered Sundays still total fewer than 2 dates. This guard
      // must accept exactly what that endpoint offered, so recompute the same flags.
      let homeFridayPromoted = false
      let homeSundayBlanket = false
      let homeJuniorSundays = new Set()
      if (homeIsJr) {
        homeJuniorSundays = await juniorSundaysInUse(opponent.kscw_team)
        const dHallIds = await database('halls')
          .whereRaw("LOWER(name) LIKE '%döltschi%' OR LOWER(name) LIKE '%doltschi%'").pluck('id')
        const bookedD = dHallIds.length
          ? await database('game_scheduling_slots').where('season', opponent.season)
              .where('status', 'booked').whereIn('hall', dHallIds)
              .select(database.raw('date::text as d'))
          : []
        const doltschiFull = bookedD.length >= 10
        const doltschiTaken = new Set(bookedD.map((r) => String(r.d).slice(0, 10)))
        // Cross-team committed dates (shared player/coach) — mirror slots/:token.
        const xDates = new Set()
        if (sharedTeamsHome.length) {
          ;(await database('games').whereIn('kscw_team', sharedTeamsHome).whereNotNull('date')
            .select(database.raw('date::text as d'))).forEach((r) => xDates.add(String(r.d).slice(0, 10)))
          ;(await database('game_scheduling_slots').whereIn('kscw_team', sharedTeamsHome).where('status', 'booked')
            .select(database.raw('date::text as d'))).forEach((r) => xDates.add(String(r.d).slice(0, 10)))
          ;(await database('game_scheduling_bookings as bk')
            .join('game_scheduling_opponents as o', 'o.id', 'bk.opponent')
            .whereIn('o.kscw_team', sharedTeamsHome).where('bk.type', 'away_proposal').where('bk.status', 'confirmed')
            .select('bk.confirmed_proposal as n', database.raw('bk.proposed_datetime_1::text as d1'), database.raw('bk.proposed_datetime_2::text as d2'), database.raw('bk.proposed_datetime_3::text as d3')))
            .forEach((r) => { const d = r[`d${r.n}`]; if (d) xDates.add(String(d).slice(0, 10)) })
        }
        // Event + team-block date ranges that cover home slots.
        const blockedDates = new Set()
        const addRange = (s, e) => {
          if (!s) return
          const d = new Date(`${s}T00:00:00Z`); const end = new Date(`${e || s}T00:00:00Z`)
          for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) blockedDates.add(d.toISOString().slice(0, 10))
        }
        ;(await database('events as e').join('events_teams as et', 'et.events_id', 'e.id')
          .where('et.teams_id', opponent.kscw_team)
          .select(database.raw("(e.start_date AT TIME ZONE 'Europe/Zurich')::date::text as s"),
            database.raw("(COALESCE(e.end_date, e.start_date) AT TIME ZONE 'Europe/Zurich')::date::text as e")))
          .forEach((r) => addRange(r.s, r.e))
        ;(await database('scheduling_blocks').where('team', opponent.kscw_team)
          .select(database.raw('start_date::text as s'), database.raw('end_date::text as e')))
          .forEach((r) => addRange(r.s, r.e))
        // Scan available non-Friday/non-Sunday slots for a surviving strict pick.
        const candRows = await database('game_scheduling_slots')
          .where('kscw_team', opponent.kscw_team).where('status', 'available')
          .modify((q) => { if (homeWindow) q.whereBetween('date', [homeWindow.start, homeWindow.end]) })
          .select('hall', 'source', database.raw('date::text as d'), database.raw(
            '(SELECT count(DISTINCT a.member) FROM absences a ' +
            'JOIN member_teams mt ON mt.member = a.member ' +
            'WHERE mt.team = ? AND (mt.guest_level = 0 OR mt.guest_level IS NULL) ' +
            "AND a.type IS DISTINCT FROM 'weekly' AND a.blocking IS NOT FALSE " +
            'AND a.start_date::date <= game_scheduling_slots.date AND a.end_date::date >= game_scheduling_slots.date ' +
            "AND (a.affects::jsonb @> '\"all\"' OR a.affects::jsonb @> '\"games\"')) as abs_count",
            [opponent.kscw_team]))
        // Distinct offerable dates per tier: tier1 = strict pool (own slot /
        // Spielsamstag / Döltschi), fri = Friday Spielhalle, clusterSun = Sundays a
        // sibling junior team plays. Mirrors the cascade in GET slots/:token.
        const tier1Dates = new Set()
        const friDates = new Set()
        const clusterSunDates = new Set()
        for (const r of candRows) {
          const d = String(r.d).slice(0, 10)
          if (Number(r.abs_count || 0) !== 0) continue
          if (committedHome.has(d)) continue
          if (xDates.has(d)) continue
          if (blockedDates.has(d)) continue
          if (derbyDateBlocked(d, homeDerbyAnchors, homeRueckStart)) continue
          if (isSunday(d)) { if (homeJuniorSundays.has(d)) clusterSunDates.add(d); continue }
          if (r.source === 'spielhalle') { friDates.add(d); continue }
          if (dHallIds.includes(r.hall) && (doltschiFull || doltschiTaken.has(d))) continue
          if (isSaturday(d) && !satDatesHome.has(d) && satDatesHome.size >= satCapHome) continue
          tier1Dates.add(d)
        }
        homeFridayPromoted = tier1Dates.size < 2
        // Blanket Sunday fallback fires when, after Friday + clustered Sundays, the
        // strict total is still under 2 (disjoint tiers → sum = union size).
        const strictBeforeBlanket = tier1Dates.size
          + (homeFridayPromoted ? friDates.size : 0) + clusterSunDates.size
        homeSundayBlanket = strictBeforeBlanket < 2
      }

      for (let i = 0; i < ids.length; i++) {
        const slot = await database('game_scheduling_slots').where('id', ids[i]).first()
        if (!slot || slot.kscw_team !== opponent.kscw_team) {
          return res.status(400).json({ error: `Slot ${i + 1} is invalid` })
        }
        if (slot.status !== 'available') {
          return res.status(400).json({ error: `Slot ${i + 1} is no longer available — please pick another.` })
        }
        const day = toYmd(slot.date)
        if (usedDays.has(day)) {
          return res.status(400).json({ error: `Slot ${i + 1} is on the same day as another of your picks — your three options must be on three different days.` })
        }
        usedDays.add(day)
        if (homeWindow && (day < homeWindow.start || day > homeWindow.end)) {
          return res.status(400).json({ error: `Slot ${i + 1} is outside the season window — please pick another.` })
        }
        if (isSaturday(day) && !satDatesHome.has(day) && satDatesHome.size >= satCapHome) {
          return res.status(400).json({ error: `Slot ${i + 1} is a Saturday but this team has used its Saturday home-game allotment — please pick another.` })
        }
        const xConflict = await teamsCommittedOnDate(sharedTeamsHome, day, database)
        if (xConflict.length) {
          const xNames = await database('teams').whereIn('id', xConflict).pluck('name')
          return res.status(400).json({ error: `Slot ${i + 1} is on a day a team sharing a player/coach already plays (${xNames.join(', ')}) — please pick another.` })
        }
        // Juniors: Friday Spielhalle and Sundays are last-resort home picks. Friday
        // is allowed at picks 1 & 2 when promoted (strict pool < 2 dates); a Sunday
        // is allowed when a sibling junior team already plays it (cluster the
        // U-teams) OR when the blanket fallback fired. Mirrors GET slots/:token.
        if (homeIsJr && i < 2 && ids.length === 3 && (
          (isSunday(day) && !homeJuniorSundays.has(day) && !homeSundayBlanket) ||
          (slot.source === 'spielhalle' && !homeFridayPromoted)
        )) {
          return res.status(400).json({ error: `Slot ${i + 1} must be the own slot, Spielsamstag or Döltschi — Friday Spielhalle and Sundays are only allowed as your 3rd choice.` })
        }
        const eventCover = await database('events as e')
          .join('events_teams as et', 'et.events_id', 'e.id')
          .where('et.teams_id', opponent.kscw_team)
          .whereRaw("?::date BETWEEN (e.start_date AT TIME ZONE 'Europe/Zurich')::date AND (COALESCE(e.end_date, e.start_date) AT TIME ZONE 'Europe/Zurich')::date", [day])
          .first()
        if (eventCover) return res.status(400).json({ error: `Slot ${i + 1} falls on a team event — please pick another.` })

        const blockCover = await database('scheduling_blocks')
          .where('team', opponent.kscw_team)
          .whereRaw('?::date BETWEEN start_date AND end_date', [day])
          .first()
        if (blockCover) return res.status(400).json({ error: `Slot ${i + 1} falls on a team block — please pick another.` })

        if (derbyDateBlocked(day, homeDerbyAnchors, homeRueckStart)) {
          return res.status(400).json({ error: `Slot ${i + 1} falls before the intra-club derby for this half — please pick another.` })
        }

        const absRow = await database('absences as a')
          .join('member_teams as mt', 'mt.member', 'a.member')
          .where('mt.team', opponent.kscw_team)
          .where(function () { this.where('mt.guest_level', 0).orWhereNull('mt.guest_level') })
          .whereRaw("a.type IS DISTINCT FROM 'weekly'")
          .whereRaw('a.blocking IS NOT FALSE')
          .whereRaw('a.start_date::date <= ?::date AND a.end_date::date >= ?::date', [day, day])
          .whereRaw("(a.affects::jsonb @> '\"all\"' OR a.affects::jsonb @> '\"games\"')")
          .countDistinct('a.member as c')
          .first()
        const absCount = Number(absRow?.c || 0)
        const gapSet = i < 2 ? committedHome : committedProposal3
        const absMax = i < 2 ? 0 : 2
        if (gapSet.has(day)) {
          return res.status(400).json({ error: `Slot ${i + 1} is too close to an existing game — please pick another.` })
        }
        if (absCount > absMax) {
          return res.status(400).json({ error: `Slot ${i + 1} has too many absent players — please pick another.` })
        }
      }

      // Replace any prior PENDING home proposal FOR THIS FIXTURE in place so the
      // booking id stays stable across re-proposals — a delete+insert mints a new
      // id, and an admin dashboard still holding the old id then 400s with
      // "Invalid booking" on confirm. Confirmed proposals + other fixtures'
      // bookings stay intact. The update also stamps svrz_game_id, upgrading a
      // legacy NULL row to its fixture.
      const priorHome = allHome
        .filter((b) => bookingMatchesFixture(b, target) && b.status === 'pending')
        .map((b) => b.id)
      // ⚠ Concurrency: the per-slot validation above ran on the bare handle across
      // ~15 sequential round trips, and slots are not reserved on proposal. Two
      // things could land inside that window. (1) generate-slots deletes every
      // `available` slot in the season and then sweeps pending proposals whose slots
      // are all gone — so this booking was written against dead slot ids and then
      // deleted outright, after the club had already been mailed its receipt and the
      // opponent flipped to 'booked' with no booking behind it. (2) confirm-home may
      // have confirmed this very fixture, and the in-place update below would blank
      // its `slot`/`confirmed_proposal` back to NULL while leaving status='confirmed'.
      // Close both by re-checking the picks and writing inside ONE transaction that
      // holds the SAME season advisory lock generate-slots takes, and by re-asserting
      // status='pending' on the in-place update. The loser now fails loudly at the
      // opponent (409, pick again) instead of losing its proposal in silence. The
      // emails stay outside the transaction; the lock is transaction-scoped, so a
      // crash mid-write releases it and rolls the partial write back.
      let raceError = null
      await database.transaction(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(?, ?)', [GSCH_GEN_LOCK_CLASS, Number(opponent.season) || 0])
        const liveSlots = await trx('game_scheduling_slots')
          .whereIn('id', ids).forUpdate().select('id', 'status')
        const liveById = new Map(liveSlots.map((s) => [Number(s.id), s]))
        for (let i = 0; i < ids.length; i++) {
          const live = liveById.get(ids[i])
          if (!live || live.status !== 'available') {
            raceError = `Slot ${i + 1} is no longer available — please pick another.`
            return
          }
        }
        if (priorHome.length > 0) {
          const replaced = await trx('game_scheduling_bookings')
            .where({ id: priorHome[0], status: 'pending' })
            .update({
              season: opponent.season,
              svrz_game_id: target.fixtureId,
              proposed_slot_1: ids[0] ?? null,
              proposed_slot_2: ids[1] ?? null,
              proposed_slot_3: ids[2] ?? null,
              proposed_by_name: proposer.name,
              proposed_by_email: proposer.email,
              confirmed_proposal: null,
              slot: null,
            })
          if (replaced !== 1) {
            raceError = 'This game was confirmed while you were picking — please reload the page.'
            return
          }
          if (priorHome.length > 1) {
            await trx('game_scheduling_bookings').whereIn('id', priorHome.slice(1)).where('status', 'pending').del()
          }
        } else {
          await trx('game_scheduling_bookings').insert({
            opponent: opponent.id,
            season: opponent.season,
            type: 'home_slot_pick',
            status: 'pending',
            svrz_game_id: target.fixtureId,
            proposed_slot_1: ids[0] ?? null,
            proposed_slot_2: ids[1] ?? null,
            proposed_slot_3: ids[2] ?? null,
            proposed_by_name: proposer.name,
            proposed_by_email: proposer.email,
          })
        }

        await trx('game_scheduling_opponents')
          .where('id', opponent.id)
          .whereIn('status', ['invited', 'viewed'])
          .update({ status: 'booked' })
        // Fresh proposals clear any pending "pick new slots" re-request flag.
        await trx('game_scheduling_opponents')
          .where('id', opponent.id).update({ new_slots_requested_at: null })
      })
      // Nothing was written when a race was detected (the checks precede every
      // write), so the commit above is a no-op and this is a clean rejection.
      if (raceError) return res.status(409).json({ error: raceError })

      // Receipt to the opponent (their language) + KSCW notify. Best-effort.
      try {
        const team = await database('teams').where('id', opponent.kscw_team).first()
        const hallNameById = {}
        ;(await database('halls').select('id', 'name')).forEach((h) => { hallNameById[h.id] = h.name })
        const kscw = `KSCW ${team?.name || ''}`.trim()
        const opp = opponent.club_name || opponent.team_name || ''
        const slotsFull = await database('game_scheduling_slots').whereIn('id', ids).select('*')
        const byId = new Map(slotsFull.map((s) => [s.id, s]))
        // Structured rows for HTML info cards + parallel plain-text lines.
        const slotRowsMail = ids.map((id) => {
          const s = byId.get(id)
          if (!s) return null
          const { date } = fmtDateMail(s.date)
          const hall = hallNameById[s.hall] || ''
          return { date, time: weekdayHomeTime(s.date, s.start_time), hall }
        }).filter(Boolean)
        const list = slotRowsMail.map((r) => `• ${r.date}, ${r.time}${r.hall ? `, ${r.hall}` : ''}`).join('\n')
        // Receipt to the person who confirmed (always known now) + CC the club's
        // contact list, so the individual always gets a copy.
        const { subject, text, html } = schedEmail(opponent.language, 'home_proposals_sent', {
          contact: proposer.name || opponent.contact_name || '', kscw, opp, list, slots: slotRowsMail,
        })
        await sendSchedulingMail(proposer.email, subject, text, opponent.contact_email || null, html)
        const adminText = `${opp} hat Heimspiel-Slots vorgeschlagen (${kscw}):\n${list}\n\nBitte im Dashboard einen bestätigen:\n${SCHEDULING_URL}/admin/terminplanung/dashboard`
        const adminHtml = adminNotifyHtml({
          title: 'Heim-Slot-Vorschläge',
          lead: `${opp} hat Heimspiel-Slots vorgeschlagen (${kscw}):`,
          infoRows: slotRowsMail.map((r, i) => ({ label: `Slot ${i + 1}`, value: `${r.date}, ${r.time}${r.hall ? `, ${r.hall}` : ''}` })),
          ctaText: 'Bitte im Dashboard einen Slot bestätigen.',
          ctaUrl: `${SCHEDULING_URL}/admin/terminplanung/dashboard`,
        })
        await sendSchedulingMail(SCHEDULING_REPLY_TO, `Heim-Slot-Vorschläge – ${opp} (${kscw})`, adminText, null, adminHtml)
      } catch (mailErr) {
        log.warn(`propose-home email failed: ${mailErr.message}`)
      }

      res.json({ success: true, proposals_count: 3 })
    } catch (err) {
      log.error({ msg: `terminplanung/propose-home: ${err.message}`, endpoint: 'terminplanung/propose-home', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  }
  router.post('/terminplanung/propose-home/:token', handleProposeHome)

  // POST /kscw/terminplanung/admin/confirm-home — confirm one of an opponent's 3
  // proposed home slots. Body: { booking_id, proposal_number (1-3), admin_notes? }.
  // Mirrors confirm-away, but books a real slot: it applies the SAME locks the old
  // instant-book did (advisory lock + FOR UPDATE + availability + event + gap +
  // Saturday cap + cross-team), marks the chosen slot booked and copies it into
  // `slot`. Pick 3 (n===3) uses the lenient gap, mirroring how it was proposed.
  router.post('/terminplanung/admin/confirm-home', async (req, res) => {
    try {
      const { booking_id, proposal_number, admin_notes } = req.body || {}
      const n = Number(proposal_number)
      if (!booking_id || ![1, 2, 3].includes(n)) {
        return res.status(400).json({ error: 'booking_id and proposal_number (1-3) required' })
      }
      const booking = await database('game_scheduling_bookings').where('id', booking_id).first()
      if (!booking || booking.type !== 'home_slot_pick') {
        return res.status(400).json({ error: 'Invalid booking' })
      }
      // Only a pending proposal may be confirmed. Re-confirming a second proposal
      // of an already-confirmed booking would book a new slot while orphaning the
      // first one as `booked` forever — reject instead.
      if (booking.status !== 'pending') {
        return res.status(400).json({ error: 'This proposal is already confirmed' })
      }
      const slotId = booking[`proposed_slot_${n}`]
      if (!slotId) return res.status(400).json({ error: `Proposal ${n} is empty` })
      const opponent = await database('game_scheduling_opponents').where('id', booking.opponent).first()
      if (!opponent) return res.status(400).json({ error: 'Opponent not found' })
      if (!(await spielplanerCanManageTeam(req, opponent.kscw_team))) return res.status(403).json({ error: 'Not authorized for this team' })
      const actor = await resolveActingUser(req)

      await database.transaction(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(?, ?)', [GSCH_BOOK_LOCK_CLASS, opponent.kscw_team])
        const slot = await trx('game_scheduling_slots').where('id', slotId).forUpdate().first()
        if (!slot || slot.status === 'blocked' || slot.status === 'booked') {
          throw Object.assign(new Error('Slot is no longer available'), { httpStatus: 400 })
        }
        if (slot.kscw_team !== opponent.kscw_team) {
          throw Object.assign(new Error('Slot does not belong to this team'), { httpStatus: 400 })
        }
        // ⚠ Concurrency: the `status !== 'pending'` check above ran on the outer
        // handle BEFORE this lock, so two planners (or one in two tabs) confirming two
        // DIFFERENT proposals of the same booking both pass it. The advisory lock
        // serialises them but re-validates nothing, and the FOR UPDATE above covers
        // only the chosen slot — a different row for each proposal — so the loser used
        // to book its own slot and overwrite the booking, leaving the winner's slot
        // `booked` with nothing referencing it: unreclaimable (delete-booking frees
        // only booking.slot, block-slot refuses a booked slot) and withheld from the
        // offer pool for the rest of the season. Re-read the booking under the lock.
        // ⚠ Order matters: the slot row is locked FIRST, above. Every handler in this
        // file that touches both takes slots before bookings (delete-booking,
        // manual-booking, generate-slots) — re-reading the booking earlier would
        // invert that pair and open a deadlock window against generate-slots.
        const freshBooking = await trx('game_scheduling_bookings').where('id', booking_id).forUpdate().first()
        if (!freshBooking || freshBooking.status !== 'pending') {
          throw Object.assign(new Error('This proposal is already confirmed'), { httpStatus: 409 })
        }
        if (Number(freshBooking[`proposed_slot_${n}`]) !== Number(slotId)) {
          throw Object.assign(new Error('This proposal changed while you were confirming — reload the dashboard.'), { httpStatus: 409 })
        }
        const slotYmd = (typeof slot.date === 'string' ? slot.date : new Date(slot.date).toISOString()).slice(0, 10)

        const eventCover = await trx('events as e')
          .join('events_teams as et', 'et.events_id', 'e.id')
          .where('et.teams_id', opponent.kscw_team)
          .whereRaw("?::date BETWEEN (e.start_date AT TIME ZONE 'Europe/Zurich')::date AND (COALESCE(e.end_date, e.start_date) AT TIME ZONE 'Europe/Zurich')::date", [slot.date])
          .first()
        if (eventCover) throw Object.assign(new Error('Slot falls on a team event'), { httpStatus: 400 })

        const blockCover = await trx('scheduling_blocks')
          .where('team', opponent.kscw_team)
          .whereRaw('?::date BETWEEN start_date AND end_date', [slot.date])
          .first()
        if (blockCover) throw Object.assign(new Error('Slot falls on a team block'), { httpStatus: 400 })

        // Home-only: can't host in a hall that's closed that day (gcal closures etc).
        const closureCover = await trx('hall_closures')
          .where('hall', slot.hall)
          .whereRaw('?::date BETWEEN start_date AND end_date', [slot.date])
          .first()
        if (closureCover) throw Object.assign(new Error('Slot falls on a hall closure'), { httpStatus: 400 })

        // Same court, other sport: a placed basketball game holds this floor
        // (migration 346). The offer query already hides such slots, so reaching
        // here means the placement landed AFTER the opponent picked — refuse
        // rather than put two games on one court.
        const bbHit = await bbFloorConflict(slotYmd, slot.hall, slot.additional_halls, slot.start_time, slot.end_time, trx)
        if (bbHit) throw Object.assign(new Error(bbConflictMessage(bbHit)), { httpStatus: 400 })

        // Intra-club derby clamp (Art. 27): nothing may be booked before this
        // team's confirmed derby date within its half. Mirrors offer-time + health.
        const derbySeasonRow = await trx('game_scheduling_seasons').where('id', opponent.season).first()
        const derbyRueckStart = rueckrundeStart(derbySeasonRow)
        const derbyAnchors = await confirmedDerbyAnchors(opponent.kscw_team, opponent.season, derbyRueckStart)
        if (derbyDateBlocked(slotYmd, derbyAnchors, derbyRueckStart)) {
          throw Object.assign(new Error('Slot falls before the intra-club derby for this half'), { httpStatus: 400 })
        }

        const gaps = await seasonGaps(opponent.season)
        const gap = n < 3 ? gaps.home : gaps.proposal3
        const committed = await committedGameDates(opponent.kscw_team, gap)
        if (committed.has(slotYmd)) throw Object.assign(new Error('Too close to another game for this team'), { httpStatus: 400 })

        // Döltschi: club-wide season cap (10) + one game per DATE there — a Döltschi
        // date is ONE slot regardless of the time (19:00 / 20:30) or hall (1 or 2).
        // Checked across all teams. (Admin confirms are sequential in practice; the
        // per-team advisory lock above doesn't serialise cross-team, but a stray
        // race is caught on the next confirm.)
        const doltschiHallIds = await trx('halls')
          .whereRaw("LOWER(name) LIKE '%döltschi%' OR LOWER(name) LIKE '%doltschi%'").pluck('id')
        if (doltschiHallIds.includes(slot.hall)) {
          const bookedD = await trx('game_scheduling_slots')
            .where('season', opponent.season).where('status', 'booked')
            .whereIn('hall', doltschiHallIds)
            .select(trx.raw('date::text as d'))
          if (bookedD.length >= 10) {
            throw Object.assign(new Error('Döltschi season limit (10 games) reached'), { httpStatus: 400 })
          }
          // One Döltschi game per date (time + hall 1/2 irrelevant).
          if (bookedD.some((r) => String(r.d).slice(0, 10) === slotYmd)) {
            throw Object.assign(new Error('Another game is already booked in Döltschi that day'), { httpStatus: 400 })
          }
        }

        const team = await trx('teams').where('id', opponent.kscw_team).first('id', 'name')
        if (isSaturday(slotYmd)) {
          const cap = await teamSaturdayCap(team, trx)
          const satDates = await committedSaturdayDates(team.id, trx, opponent.season)
          if (satDates.size + 1 > cap) throw Object.assign(new Error('Saturday home-game cap reached for this team'), { httpStatus: 400 })
        }
        const others = await sharedPlayerTeams(team.id, trx)
        const conflictTeams = await teamsCommittedOnDate(others, slotYmd, trx)
        if (conflictTeams.length) {
          const names = await trx('teams').whereIn('id', conflictTeams).pluck('name')
          throw Object.assign(new Error(`Cross-team conflict: ${names.join(', ')} already play that day`), { httpStatus: 400 })
        }

        // Conditional write used as the final arbiter: act only when this UPDATE
        // matched the row we validated. Redundant with the FOR UPDATE re-read above
        // by design — it keeps the "a confirmed booking is never re-confirmed"
        // guarantee local to the statement that would break it.
        const bookingUpdated = await trx('game_scheduling_bookings')
          .where({ id: booking_id, status: 'pending' })
          .update({
            status: 'confirmed',
            confirmed_proposal: n,
            slot: slotId,
            admin_notes: admin_notes || booking.admin_notes || null,
            confirmed_by_name: actor.name,
            confirmed_by_email: actor.email,
            confirmed_at: trx.fn.now(),
          })
        if (bookingUpdated !== 1) {
          throw Object.assign(new Error('This proposal is already confirmed'), { httpStatus: 409 })
        }
        await trx('game_scheduling_slots').where('id', slotId).update({ status: 'booked' })
      })

      await writeUserLog(database, log, { accountability: req.accountability, action: 'update', collection: 'game_scheduling_bookings', recordId: booking_id, data: { kind: 'confirm_home', proposal: n, slot: slotId } })

      // Confirmation email to the opponent (their language) + mailbox notice.
      try {
        const slot = await database('game_scheduling_slots').where('id', slotId).first()
        const team = await database('teams').where('id', opponent.kscw_team).first()
        const hall = slot?.hall ? await database('halls').where('id', slot.hall).first() : null
        const { date } = fmtDateMail(slot?.date)
        const timeRange = weekdayHomeTime(slot?.date, slot?.start_time)
        const kscw = `KSCW ${team?.name || ''}`.trim()
        const opp = opponent.club_name || opponent.team_name || ''
        if (opponent.contact_email) {
          const { subject, text, html } = schedEmail(opponent.language, 'home_booked', {
            contact: opponent.contact_name || '', kscw, opp, date, time: timeRange, hall: hall?.name || '',
          })
          await sendSchedulingMail(opponent.contact_email, subject, text, null, html)
        }
        const adminText = `Heimspiel bestätigt:\n\n${kscw} (Heim) vs ${opp}\n${date}, ${timeRange} Uhr${hall?.name ? `, ${hall.name}` : ''}.`
        const adminHtml = adminNotifyHtml({
          title: 'Heimspiel bestätigt',
          lead: `${kscw} (Heim) vs ${opp}`,
          infoRows: [
            { label: 'Spiel', value: `${kscw} (Heim) vs ${opp}` },
            { label: 'Datum', value: date, halfWidth: true },
            { label: 'Zeit', value: timeRange, halfWidth: true },
            ...(hall?.name ? [{ label: 'Halle', value: hall.name }] : []),
          ],
        })
        await sendSchedulingMail(SCHEDULING_REPLY_TO, `Heimspiel bestätigt – ${opp} (${kscw})`, adminText, null, adminHtml)
      } catch (mailErr) {
        log.warn(`confirm-home email failed: ${mailErr.message}`)
      }

      // Apply the Saturday hall rule before pushing so VolleyManager receives the
      // final hall (a lone Saturday game lands in KWI C, not the gym this team's
      // open slots are in). Any OTHER game this booking bumped (a previously-lone
      // game now sharing the time → A+B) is re-pushed in the background.
      let satReb = { moved: [] }
      try { satReb = await rebalanceSaturdayHalls(opponent.season) } catch (e) { log.warn(`confirm-home Saturday rebalance failed: ${e.message}`) }

      // Push the confirmed date/time/hall into VolleyManager (best-effort). A
      // fixture-keyed booking pushes to exactly that VM game — no needs_pick
      // ambiguity when the pairing has several home fixtures.
      try {
        await database('game_scheduling_bookings').where('id', booking_id).update({ vm_push_status: 'queued', vm_push_error: null })
        await spawnVmPush(booking_id, { svrzId: booking.svrz_game_id || null })
      } catch (pushErr) {
        log.warn(`confirm-home VM push enqueue failed: ${pushErr.message}`)
      }
      repushMovedBookings(satReb.moved, { excludeBookingId: booking_id })
      await logRebalanceMoves(req, satReb.moved, { excludeBookingId: booking_id })

      // Mirror into `games` so the new fixture shows on member calendars right
      // away (fire-and-forget; sv-sync adopts the row later).
      reconcileBookingsToGames(opponent.season).catch((e) => log.warn(`confirm-home games reconcile failed: ${e.message}`))

      res.json({ success: true, confirmed_proposal: n })
    } catch (err) {
      if (err && err.httpStatus) {
        return res.status(err.httpStatus).json({ error: err.message })
      }
      log.error({ msg: `confirm-home: ${err.message}`, endpoint: 'terminplanung/admin/confirm-home', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /kscw/terminplanung/propose-away/:token — propose 3 away dates
  const handleProposeAway = async (req, res) => {
    try {
      // Rate limit: max 10 proposal attempts per 15 min per IP
      if (!rateLimit(writeAttempts, req, 10, 15 * 60 * 1000)) {
        return res.status(429).json({ error: 'Too many requests. Try again later.' })
      }

      const opponent = await database('game_scheduling_opponents')
        .where('token', req.params.token)
        .whereIn('status', ['active', 'invited', 'viewed', 'booked'])
        .first()
      if (!opponent) return res.status(404).json({ error: 'Invalid link' })
      if (opponent.expires_at && new Date() > new Date(opponent.expires_at)) {
        return res.status(400).json({ error: 'Link expired' })
      }

      // Remember the language the opponent is acting in (for emails).
      const lang = VALID_LANGS.includes(String(req.body?.language || '').toLowerCase()) ? String(req.body.language).toLowerCase() : null
      if (lang) {
        await database('game_scheduling_opponents').where('id', opponent.id).update({ language: lang })
        opponent.language = lang
      }

      // Who at the opponent club is confirming (required — captured by the modal
      // on the "Confirm away games" button so we know who to follow up with).
      const proposer = parseProposer(req.body)
      if (!proposer.ok) return res.status(400).json({ error: proposer.error })

      const { proposals } = req.body
      if (!Array.isArray(proposals) || proposals.length === 0 || proposals.length > 3) {
        return res.status(400).json({ error: '1-3 proposals required' })
      }

      // Multi-game: which away fixture of this pairing the proposals are for.
      // Absent svrz_game_id targets the first away fixture (legacy clients).
      const fixtures = await opponentSvrzFixtures(opponent)
      const target = resolveTargetFixture(fixtures, false, req.body?.svrz_game_id || null)
      if (!target) return res.status(400).json({ error: 'Invalid game for this opponent' })
      const allAway = await database('game_scheduling_bookings')
        .where({ opponent: opponent.id, type: 'away_proposal' })
        .orderBy('id').select('*')
      if (allAway.some((b) => bookingMatchesFixture(b, target) && b.status === 'confirmed')) {
        return res.status(400).json({ error: 'This game is already confirmed' })
      }

      // Schema stores up to 3 proposals as parallel columns on a single booking row
      const row = {
        opponent: opponent.id,
        // Without season the admin dashboard never sees the proposal — it filters
        // bookings by season, so a null-season row is silently dropped (opponent
        // submits, admin sees "Pending" forever). opponent.season is the season id,
        // the same value the home booking copies from slot.season.
        season: opponent.season,
        type: 'away_proposal',
        status: 'pending',
        svrz_game_id: target.fixtureId,
        proposed_by_name: proposer.name,
        proposed_by_email: proposer.email,
      }
      // 2026-05-12 audit #22: validate date/time/location before storing or
      // later emailing. Token-flow rate-limit + auth are intact, but garbage
      // data lands in admin UI + outbound emails (HTML-rendered). Return a
      // proper 400 with the message (was throwing into the generic 500 catch).
      const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
      const TIME_RE = /^\d{2}:\d{2}(?::\d{2})?$/

      const team = await database('teams').where('id', opponent.kscw_team).first('id', 'name')
      const isJunior = isJuniorTeam(team?.name)

      // A3 — for non-junior teams, the away proposals may include at most one
      // Saturday (none for no_saturday_games teams). Juniors are exempt. Sundays
      // are allowed away (the Sunday-last-resort rule is home-only — the opponent
      // owns their venue). Malformed dates are caught per-proposal below.
      if (!isJunior) {
        const validDates = proposals.filter((p) => p?.date && DATE_RE.test(String(p.date)))
        const noSatProp = await teamNoSaturday(opponent.kscw_team)
        if (noSatProp && validDates.some((p) => isSaturday(p.date))) {
          return res.status(400).json({ error: 'away_no_saturday' })
        }
        if (!noSatProp && validDates.filter((p) => isSaturday(p.date)).length > 1) {
          return res.status(400).json({ error: 'away_max_one_saturday' })
        }
      }

      // C1 cross-team — teams sharing players with this one must not already play
      // on a proposed date (checked per proposal in the loop). Applies to juniors
      // too — it's player-driven, not team-type-driven.
      const sharedTeams = await sharedPlayerTeams(opponent.kscw_team)

      // Games / booked home slots / confirmed away proposals — a new proposal
      // can't land within the gap of any of them. Proposals 1-2 use the proposal
      // gap; proposal 3 the (smaller) proposal-3 gap (mirrors the strict/loose
      // sets the calendar greys with).
      const proposalGaps = await seasonGaps(opponent.season)
      const held = { includeHeld: true, excludeOpponent: opponent.id }
      const committedStrict = await committedGameDates(opponent.kscw_team, proposalGaps.proposal, held)
      const committedLoose = await committedGameDates(opponent.kscw_team, proposalGaps.proposal3, held)
      // Intra-club derby clamp (Art. 27): reject any away date before this team's
      // confirmed derby date within its half.
      const awaySeasonRow = await database('game_scheduling_seasons').where('id', opponent.season).first()
      const awayRueckStart = rueckrundeStart(awaySeasonRow)
      const awayDerbyAnchors = await confirmedDerbyAnchors(opponent.kscw_team, opponent.season, awayRueckStart)
      // Season window: no away date may fall outside [open, close] either.
      const awayWindow = seasonOfferWindow(awaySeasonRow)
      const usedAwayDays = new Set()
      for (let i = 0; i < proposals.length; i++) {
        const p = proposals[i]
        if (!p.date || !DATE_RE.test(String(p.date))) {
          return res.status(400).json({ error: 'Each proposal needs a valid date (YYYY-MM-DD)' })
        }
        const pDay = String(p.date).slice(0, 10)
        if (usedAwayDays.has(pDay)) {
          return res.status(400).json({ error: `${p.date} is the same day as another of your proposals — your dates must be on different days.` })
        }
        usedAwayDays.add(pDay)
        // Season window: reject away dates before the season opens / after it closes.
        if (awayWindow && (pDay < awayWindow.start || pDay > awayWindow.end)) {
          return res.status(400).json({ error: 'away_outside_season' })
        }
        if (p.start_time && !TIME_RE.test(String(p.start_time))) {
          return res.status(400).json({ error: 'start_time must be HH:MM' })
        }
        // Reject dates before this team's confirmed derby in that half (Art. 27).
        if (derbyDateBlocked(p.date, awayDerbyAnchors, awayRueckStart)) {
          return res.status(400).json({ error: 'away_before_derby' })
        }
        // Reject dates that hit an event for this KSCW team — the team is busy
        // (mirrors the home-slot event exclusion). Zurich-local date compare.
        const eventCover = await database('events as e')
          .join('events_teams as et', 'et.events_id', 'e.id')
          .where('et.teams_id', opponent.kscw_team)
          .whereRaw(
            "?::date BETWEEN (e.start_date AT TIME ZONE 'Europe/Zurich')::date " +
            "AND (COALESCE(e.end_date, e.start_date) AT TIME ZONE 'Europe/Zurich')::date",
            [String(p.date)],
          )
          .first('e.title')
        if (eventCover) {
          return res.status(400).json({ error: `${p.date} falls on a team event${eventCover.title ? ` (${eventCover.title})` : ''} — please pick another date.` })
        }
        // Reject if the team already plays within the gap of this date — a real
        // game, a home slot another opponent booked, or a confirmed away proposal
        // (pending proposals don't count). Proposal 3 (i===2) uses the lenient gap.
        const committedForProposal = i < 2 ? committedStrict : committedLoose
        if (committedForProposal.has(String(p.date).slice(0, 10))) {
          return res.status(400).json({ error: `${p.date} is too close to an existing game — please pick another date.` })
        }
        // C1 cross-team: a roster-sharing team must not already play this date.
        const xTeams = await teamsCommittedOnDate(sharedTeams, String(p.date), database)
        if (xTeams.length) {
          const names = await database('teams').whereIn('id', xTeams).pluck('name')
          return res.status(400).json({ error: 'conflict_cross_team', teams: names.join(', ') })
        }
        // Reject if any rostered member has a one-off absence (NOT a weekly
        // unavailability) affecting games on that date. "No game if absence."
        const absRow = await database('absences as a')
          .join('member_teams as mt', 'mt.member', 'a.member')
          .where('mt.team', opponent.kscw_team)
          // Players only — guests (guest_level > 0) don't block.
          .where(function () { this.where('mt.guest_level', 0).orWhereNull('mt.guest_level') })
          // One-off absences only, not weekly unavailabilities. IS DISTINCT FROM
          // so a NULL type (legacy one-off) still counts (`!= 'weekly'` is NULL).
          .whereRaw("a.type IS DISTINCT FROM 'weekly'")
          // Non-blocking absences (long-term injury, maternity) don't block scheduling.
          .whereRaw('a.blocking IS NOT FALSE')
          .whereRaw("a.start_date::date <= ?::date AND a.end_date::date >= ?::date", [String(p.date), String(p.date)])
          .whereRaw("(a.affects::jsonb @> '\"all\"' OR a.affects::jsonb @> '\"games\"')")
          .countDistinct('a.member as c')
          .first()
        // Proposals 1 & 2 (i < 2) must be absence-free; proposal 3 (i === 2)
        // tolerates 1-2 absences and only blocks at 3+.
        const absThreshold = i < 2 ? 1 : 3
        if (Number(absRow?.c || 0) >= absThreshold) {
          return res.status(400).json({
            error: i < 2
              ? `${p.date}: proposals 1 and 2 must have no player absences.`
              : `${p.date} has 3 or more players absent — please pick another date.`,
          })
        }
        const rawPlace = String(p.location || p.place || '').slice(0, 200)
        const dt = p.start_time ? `${p.date}T${p.start_time}` : p.date
        row[`proposed_datetime_${i + 1}`] = dt
        row[`proposed_place_${i + 1}`] = rawPlace
      }
      // "Update proposals" re-submits via the same endpoint — replace any prior
      // pending away_proposal FOR THIS FIXTURE in place so the booking id stays
      // stable (a delete+insert mints a new id and the admin dashboard's stale id
      // then 400s "Invalid booking" on confirm). Confirmed bookings and other
      // fixtures' proposals are left intact; `row` stamps svrz_game_id, upgrading
      // a legacy NULL row to its fixture.
      const priorAway = allAway
        .filter((b) => bookingMatchesFixture(b, target) && b.status === 'pending')
        .map((b) => b.id)
      if (priorAway.length > 0) {
        await database('game_scheduling_bookings').where('id', priorAway[0]).update({
          // Clear all proposal columns first so a shorter re-proposal doesn't
          // leave a stale slot 3 behind; `row` re-sets the submitted ones.
          proposed_datetime_1: null, proposed_datetime_2: null, proposed_datetime_3: null,
          proposed_place_1: null, proposed_place_2: null, proposed_place_3: null,
          ...row,
          confirmed_proposal: null,
          slot: null,
        })
        if (priorAway.length > 1) {
          await database('game_scheduling_bookings').whereIn('id', priorAway.slice(1)).del()
        }
      } else {
        await database('game_scheduling_bookings').insert(row)
      }

      // Status lifecycle: away proposal transitions invited/viewed → booked
      await database('game_scheduling_opponents')
        .where('id', opponent.id)
        .whereIn('status', ['invited', 'viewed'])
        .update({ status: 'booked' })

      // Receipt email to the opponent (their language) + KSCW notify to confirm.
      // Best-effort — never blocks the submission.
      try {
        const team = await database('teams').where('id', opponent.kscw_team).first()
        const kscw = `KSCW ${team?.name || ''}`.trim()
        const opp = opponent.club_name || opponent.team_name || ''
        // Structured rows for HTML info cards + parallel plain-text lines.
        // Away proposals carry a datetime → render as dd.mm.yyyy HH:MM.
        const slotRowsMail = []
        for (let i = 1; i <= 3; i++) {
          const dt = row[`proposed_datetime_${i}`]
          if (!dt) continue
          const { date, time } = fmtDateMail(dt)
          slotRowsMail.push({ date, time })
        }
        const list = slotRowsMail.map((r) => `• ${r.date}${r.time ? `, ${r.time}` : ''}`).join('\n')
        // Receipt to the person who confirmed (always known now) + CC the club's
        // contact list, so the individual always gets a copy.
        const { subject, text, html } = schedEmail(opponent.language, 'proposals_sent', {
          contact: proposer.name || opponent.contact_name || '', kscw, opp, list, slots: slotRowsMail,
        })
        await sendSchedulingMail(proposer.email, subject, text, opponent.contact_email || null, html)
        const adminText = `${opp} hat Auswärts-Termine vorgeschlagen (${kscw}):\n${list}\n\nBitte im Dashboard einen bestätigen:\n${SCHEDULING_URL}/admin/terminplanung/dashboard`
        const adminHtml = adminNotifyHtml({
          title: 'Auswärts-Terminvorschläge',
          lead: `${opp} hat Auswärts-Termine vorgeschlagen (${kscw}):`,
          infoRows: slotRowsMail.map((r, i) => ({ label: `Termin ${i + 1}`, value: `${r.date}${r.time ? `, ${r.time}` : ''}` })),
          ctaText: 'Bitte im Dashboard einen Termin bestätigen.',
          ctaUrl: `${SCHEDULING_URL}/admin/terminplanung/dashboard`,
        })
        await sendSchedulingMail(SCHEDULING_REPLY_TO, `Auswärts-Terminvorschläge – ${opp} (${kscw})`, adminText, null, adminHtml)
      } catch (mailErr) {
        log.warn(`propose-away email failed: ${mailErr.message}`)
      }

      res.json({ success: true, proposals_count: proposals.length })
    } catch (err) {
      log.error({ msg: `terminplanung/propose-away: ${err.message}`, endpoint: 'terminplanung/propose-away', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  }
  router.post('/terminplanung/propose-away/:token', handleProposeAway)

  // POST /kscw/terminplanung/set-language/:token — remember the opponent's UI
  // language so transactional emails go out in it. Called on page load and each
  // time the opponent flips the language switcher. Idempotent.
  const handleSetLanguage = async (req, res) => {
    try {
      if (!rateLimit(langAttempts, req, 40, 15 * 60 * 1000)) {
        return res.status(429).json({ error: 'Too many requests. Try again later.' })
      }
      const language = String(req.body?.language || '').toLowerCase()
      if (!VALID_LANGS.includes(language)) {
        return res.status(400).json({ error: 'Invalid language' })
      }
      // Resolve first so expiry can be tested — the blind UPDATE could not.
      const opp = await database('game_scheduling_opponents')
        .where('token', req.params.token)
        .whereIn('status', ['active', 'invited', 'viewed', 'booked'])
        .first('id', 'expires_at', 'status')
      if (!opp) return res.status(404).json({ error: 'Invalid link' })
      if (opp.status !== 'booked' && opp.expires_at && new Date() > new Date(opp.expires_at)) {
        return res.status(400).json({ error: 'Link expired' })
      }
      await database('game_scheduling_opponents').where('id', opp.id).update({ language })
      res.json({ success: true })
    } catch (err) {
      log.error({ msg: `terminplanung/set-language: ${err.message}`, endpoint: 'terminplanung/set-language', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  }
  router.post('/terminplanung/set-language/:token', handleSetLanguage)

  // POST /kscw/terminplanung/note/:token — the opponent saves/updates their free
  // -text remark to KSCW (shown to the spielplaner in the dashboard). Token-gated,
  // independent of proposing so they can leave a note even with no workable slot.
  const handleSaveNote = async (req, res) => {
    try {
      if (!rateLimit(writeAttempts, req, 20, 15 * 60 * 1000)) {
        return res.status(429).json({ error: 'Too many requests. Try again later.' })
      }
      const note = String(req.body?.note ?? '').slice(0, 2000)
      const opp = await database('game_scheduling_opponents')
        .where('token', req.params.token)
        .whereIn('status', ['active', 'invited', 'viewed', 'booked'])
        .first('id', 'expires_at', 'status')
      if (!opp) return res.status(404).json({ error: 'Invalid link' })
      if (opp.status !== 'booked' && opp.expires_at && new Date() > new Date(opp.expires_at)) {
        return res.status(400).json({ error: 'Link expired' })
      }
      await database('game_scheduling_opponents').where('id', opp.id).update({ opponent_note: note })
      res.json({ success: true })
    } catch (err) {
      log.error({ msg: `terminplanung/note: ${err.message}`, endpoint: 'terminplanung/note', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  }
  router.post('/terminplanung/note/:token', handleSaveNote)

  // ─────────────────────────────────────────────────────────────────────
  // Club portal — ONE opponent link/page per CLUB (use_club_portals seasons).
  // A portal (game_scheduling_club_portals, keyed by season+club_id) owns a
  // shared token and fans out to the club's per-team game_scheduling_opponents
  // rows. The public endpoints reuse the exact per-pairing engine:
  //   * GET slots → computeOpponentSlotsPayload() per pairing
  //   * mutations → re-dispatched to the per-opponent handlers via a synthetic
  //     request carrying the target opponent's own token, so every cap / derby
  //     clamp / booking-upsert / receipt+admin email runs unchanged.
  // Portal status only transitions invited→viewed (cosmetic; the per-pairing
  // open/proposed/confirmed badges remain authoritative for booking state).
  // ─────────────────────────────────────────────────────────────────────
  const CLUB_PORTAL_VIEW_STATUSES = ['invited', 'viewed', 'booked']

  // ⚠ `sport` is REQUIRED here. Since migration 280 this table holds BOTH sports'
  // club portals, and tokens are globally unique — so a basketball token hitting
  // the volleyball route would otherwise resolve to a real portal and be driven
  // through the volleyball club flow. Every volleyball query on this table must
  // carry this filter.
  /**
   * `true` when a portal's link has lapsed. Mirrors basketball-portal.js's
   * `portalExpired` — a booked portal stays readable so the club can see what
   * they agreed to.
   */
  const clubPortalExpired = (portal) =>
    portal.status !== 'booked' && portal.expires_at && new Date() > new Date(portal.expires_at)

  /**
   * Resolve a club portal by token.
   *
   * ⚠ Callers that WRITE must also reject an expired portal — use
   * `clubPortalForWrite`. Nothing flips `status` when `expires_at` lapses (only
   * the admin archive and the season rollover do), and there is no revoke
   * endpoint for club portals at all, so `expires_at` is the ONLY retirement
   * lever. Migration 094 pinned `expires_at = 2026-06-30` on live 2025/26 rows
   * without touching status, so every un-archived token is expired-but-writable
   * unless this is checked (audit 2026-08-08, finding 23).
   */
  async function clubPortalByToken(token) {
    return database('game_scheduling_club_portals')
      .where('token', token)
      .where('sport', 'volleyball')
      .whereIn('status', CLUB_PORTAL_VIEW_STATUSES)
      .first()
  }

  /**
   * Portal resolution for WRITE routes: same lookup, plus the expiry test, so a
   * new write route cannot silently inherit the read behaviour. Returns null for
   * "no such token" and the string 'expired' for a lapsed one, so the caller can
   * answer 404 vs 400 without repeating the rule.
   */
  async function clubPortalForWrite(token) {
    const portal = await clubPortalByToken(token)
    if (!portal) return null
    return clubPortalExpired(portal) ? 'expired' : portal
  }

  // The club's per-team opponent anchor rows for a portal (season + club_id).
  async function clubPortalOpponents(portal) {
    return database('game_scheduling_opponents')
      .where('season', portal.season)
      .where('club_id', portal.club_id)
      .whereIn('status', ['active', 'invited', 'viewed', 'booked'])
      .orderBy('kscw_team', 'asc')
  }

  // Which of the portal's opponent rows owns a given SVRZ fixture id? A fixture
  // belongs to exactly one (kscw_team ↔ opp team) pairing.
  async function findPortalOpponentByFixture(opponents, svrzGameId) {
    if (!svrzGameId) return null
    for (const opp of opponents) {
      const fixtures = await opponentSvrzFixtures(opp)
      if (fixtures.some((f) => String(f.id) === String(svrzGameId))) return opp
    }
    return null
  }

  // Re-dispatch a club mutation to a per-opponent handler by faking the token on
  // a prototype-chained request clone (body/headers/accountability inherited).
  const dispatchAsOpponent = (handler, req, res, opponent) => {
    const subReq = Object.create(req)
    subReq.params = { ...(req.params || {}), token: opponent.token }
    return handler(subReq, res)
  }

  // GET /kscw/terminplanung/club/slots/:token — aggregate slots for ALL the
  // club's pairings on one page.
  router.get('/terminplanung/club/slots/:token', async (req, res) => {
    try {
      if (!rateLimit(tokenAttempts, req, 60, 15 * 60 * 1000)) {
        return res.status(429).json({ error: 'Too many requests. Try again later.' })
      }
      const portal = await clubPortalByToken(req.params.token)
      if (!portal) return res.status(404).json({ error: 'Invalid or expired link' })
      if (portal.status !== 'booked' && portal.expires_at && new Date() > new Date(portal.expires_at)) {
        return res.status(400).json({ error: 'Link expired' })
      }
      if (portal.status === 'invited') {
        const nowIso = new Date().toISOString()
        await database('game_scheduling_club_portals').where('id', portal.id)
          .update({ status: 'viewed', first_viewed_at: nowIso, date_updated: nowIso })
        portal.status = 'viewed'
      }
      const seasonRow = await database('game_scheduling_seasons').where('id', portal.season).first('id', 'season')
      const opponents = await clubPortalOpponents(portal)
      const pairings = []
      for (const opp of opponents) {
        // Flip the anchor row invited→viewed too so the admin dashboard reflects
        // engagement (the same transition the per-token route does).
        if (opp.status === 'invited') {
          const nowIso = new Date().toISOString()
          await database('game_scheduling_opponents').where('id', opp.id)
            .update({ status: 'viewed', first_viewed_at: nowIso })
          opp.status = 'viewed'
        }
        pairings.push(await computeOpponentSlotsPayload(opp))
      }
      res.json({
        portal: {
          id: portal.id,
          club_id: portal.club_id,
          club_name: portal.club_name || '',
          status: portal.status || 'invited',
          language: portal.language || null,
          contact_name: portal.contact_name || '',
          contact_email: portal.contact_email || '',
          club_note: portal.club_note || '',
          season_id: portal.season,
          season_name: seasonRow?.season || '',
        },
        pairings,
      })
    } catch (err) {
      log.error({ msg: `terminplanung/club/slots: ${err.message}`, endpoint: 'terminplanung/club/slots', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /kscw/terminplanung/club/propose-home/:token — delegate to the per-
  // opponent home handler for the pairing that owns req.body.svrz_game_id.
  router.post('/terminplanung/club/propose-home/:token', async (req, res) => {
    try {
      const portal = await clubPortalByToken(req.params.token)
      if (!portal) return res.status(404).json({ error: 'Invalid or expired link' })
      if (portal.status !== 'booked' && portal.expires_at && new Date() > new Date(portal.expires_at)) {
        return res.status(400).json({ error: 'Link expired' })
      }
      const opponents = await clubPortalOpponents(portal)
      const target = await findPortalOpponentByFixture(opponents, req.body?.svrz_game_id)
      if (!target) return res.status(400).json({ error: 'invalid_game' })
      return await dispatchAsOpponent(handleProposeHome, req, res, target)
    } catch (err) {
      log.error({ msg: `terminplanung/club/propose-home: ${err.message}`, endpoint: 'terminplanung/club/propose-home', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /kscw/terminplanung/club/propose-away/:token — same, away handler.
  router.post('/terminplanung/club/propose-away/:token', async (req, res) => {
    try {
      const portal = await clubPortalByToken(req.params.token)
      if (!portal) return res.status(404).json({ error: 'Invalid or expired link' })
      if (portal.status !== 'booked' && portal.expires_at && new Date() > new Date(portal.expires_at)) {
        return res.status(400).json({ error: 'Link expired' })
      }
      const opponents = await clubPortalOpponents(portal)
      const target = await findPortalOpponentByFixture(opponents, req.body?.svrz_game_id)
      if (!target) return res.status(400).json({ error: 'invalid_game' })
      return await dispatchAsOpponent(handleProposeAway, req, res, target)
    } catch (err) {
      log.error({ msg: `terminplanung/club/propose-away: ${err.message}`, endpoint: 'terminplanung/club/propose-away', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /kscw/terminplanung/club/note/:token — one shared remark; store on the
  // portal + mirror onto every opponent row so the admin dashboard shows it.
  router.post('/terminplanung/club/note/:token', async (req, res) => {
    try {
      if (!rateLimit(writeAttempts, req, 20, 15 * 60 * 1000)) {
        return res.status(429).json({ error: 'Too many requests. Try again later.' })
      }
      const note = String(req.body?.note ?? '').slice(0, 2000)
      const portal = await clubPortalForWrite(req.params.token)
      if (!portal) return res.status(404).json({ error: 'Invalid link' })
      if (portal === 'expired') return res.status(400).json({ error: 'Link expired' })
      const nowIso = new Date().toISOString()
      await database('game_scheduling_club_portals').where('id', portal.id)
        .update({ club_note: note, date_updated: nowIso })
      await database('game_scheduling_opponents')
        .where('season', portal.season).where('club_id', portal.club_id)
        .whereIn('status', ['active', 'invited', 'viewed', 'booked'])
        .update({ opponent_note: note })
      res.json({ success: true })
    } catch (err) {
      log.error({ msg: `terminplanung/club/note: ${err.message}`, endpoint: 'terminplanung/club/note', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /kscw/terminplanung/club/set-language/:token — one shared language;
  // store on the portal + propagate to opponent rows (per-opponent receipt
  // emails read opponent.language).
  router.post('/terminplanung/club/set-language/:token', async (req, res) => {
    try {
      if (!rateLimit(langAttempts, req, 40, 15 * 60 * 1000)) {
        return res.status(429).json({ error: 'Too many requests. Try again later.' })
      }
      const language = String(req.body?.language || '').toLowerCase()
      if (!VALID_LANGS.includes(language)) return res.status(400).json({ error: 'Invalid language' })
      const portal = await clubPortalForWrite(req.params.token)
      if (!portal) return res.status(404).json({ error: 'Invalid link' })
      if (portal === 'expired') return res.status(400).json({ error: 'Link expired' })
      await database('game_scheduling_club_portals').where('id', portal.id)
        .update({ language, date_updated: new Date().toISOString() })
      await database('game_scheduling_opponents')
        .where('season', portal.season).where('club_id', portal.club_id)
        .whereIn('status', ['active', 'invited', 'viewed', 'booked'])
        .update({ language })
      res.json({ success: true })
    } catch (err) {
      log.error({ msg: `terminplanung/club/set-language: ${err.message}`, endpoint: 'terminplanung/club/set-language', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /kscw/admin/terminplanung/opponent-note — the spielplaner saves the note
  // shown to an opponent on their proposal page. Body: { opponent_id, kscw_note }.
  router.post('/admin/terminplanung/opponent-note', async (req, res) => {
    try {
      const opponentId = Number(req.body?.opponent_id)
      if (!opponentId) return res.status(400).json({ error: 'opponent_id required' })
      const opp = await database('game_scheduling_opponents').where('id', opponentId).first()
      if (!opp) return res.status(404).json({ error: 'Opponent not found' })
      if (!(await spielplanerCanManageTeam(req, opp.kscw_team))) return res.status(403).json({ error: 'Not authorized for this team' })
      const note = String(req.body?.kscw_note ?? '').slice(0, 2000)
      await database('game_scheduling_opponents').where('id', opponentId).update({ kscw_note: note })
      res.json({ success: true })
    } catch (err) {
      log.error({ msg: `admin/terminplanung/opponent-note: ${err.message}`, endpoint: 'admin/terminplanung/opponent-note', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /kscw/terminplanung/admin/generate-slots — (re)generate home slots for
  // a season from its Spielsamstage + per-team slot config. Body: { season_id }.
  // Idempotent: clears existing *available* slots for the season (booked/blocked
  // survive), then regenerates for each team with an explicit team_slot_config
  // entry ('spielsamstag' → Game-Saturday pool; 'hall_slot' → the team's weekly
  // hall slots expanded across the picked-Saturday span; 'manual' → skipped).
  router.post('/terminplanung/admin/generate-slots', async (req, res) => {
    if (!(await isAdminOrSpielplaner(req))) return res.status(403).json({ error: 'Admin only' })
    try {
      const { season_id } = req.body || {}
      if (!season_id) return res.status(400).json({ error: 'season_id required' })

      const season = await database('game_scheduling_seasons').where('id', season_id).first()
      if (!season) return res.status(404).json({ error: 'Season not found' })

      // JSON columns — jsonb comes back parsed, but guard against a string.
      const parseJson = (v, fallback) => {
        if (v == null) return fallback
        if (typeof v === 'string') { try { return JSON.parse(v) } catch { return fallback } }
        return v
      }
      const spielsamstage = parseJson(season.spielsamstage, [])
      const teamConfig = parseJson(season.team_slot_config, {})
      const seasonKey = Number(season_id)

      // ⚠ Concurrency: the DELETE below, the per-team clash check and the chunked
      // INSERTs are one logical operation, and they ran on the bare handle. Two
      // overlapping regenerations (two spielplaner, or one reload after this endpoint
      // appears to hang — Node does not abort the first handler on client disconnect)
      // each deleted, each then read a clash set that did not yet contain the other's
      // rows, and each inserted the full candidate set: every offer listed twice in
      // the opponent's picker. Worse, a regeneration overlapping an opponent's
      // propose-home deleted the three slots that proposal points at and then swept
      // the proposal itself as an orphan, silently, after the club had already been
      // sent its receipt. One transaction holding a SEASON-scoped advisory lock fixes
      // both: propose-home takes the same lock, so the two orderings are the only two
      // possible (regenerate first → the opponent gets a loud "slot no longer
      // available"; propose first → its slots are in heldRows and survive). The
      // transaction also means a throw mid-loop rolls the DELETE back instead of
      // leaving the season with no offers at all. Different seasons never block each
      // other, and the lock dies with the transaction, so a crash strands nothing.
      const { total_created, orphans_deleted } = await database.transaction(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(?, ?)', [GSCH_GEN_LOCK_CLASS, seasonKey])
        // "Overwrites not-yet-booked slots": drop existing available slots for the
        // season before regenerating. Booked + blocked rows are preserved — AND so
        // are slots a PENDING home proposal points to, otherwise regenerating mints
        // new slot ids and orphans the proposal (confirm then 400s "Slot is no
        // longer available"). The clash check below skips re-creating a duplicate.
        const heldRows = await trx('game_scheduling_bookings')
          .where('season', seasonKey).where('type', 'home_slot_pick').where('status', 'pending')
          .select('proposed_slot_1', 'proposed_slot_2', 'proposed_slot_3')
        const heldSlotIds = [...new Set(
          heldRows.flatMap((r) => [r.proposed_slot_1, r.proposed_slot_2, r.proposed_slot_3]).filter((v) => v != null),
        )]
        await trx('game_scheduling_slots')
          .where('season', seasonKey).where('status', 'available')
          .modify((q) => { if (heldSlotIds.length) q.whereNotIn('id', heldSlotIds) })
          .del()

        const addHours = (hhmm, hrs) => {
          const [h, m] = String(hhmm).split(':').map(Number)
          const d = new Date(Date.UTC(2000, 0, 1, h || 0, m || 0))
          d.setUTCHours(d.getUTCHours() + hrs)
          return d.toISOString().slice(11, 16)
        }

        // Evening (hall_slot) mode repeats weekly across the season offer window —
        // configurable via season_opens/season_closes (migration 108), else
        // Sep 1 (first year) → Mar 31 (second year) derived from the season name
        // (e.g. "2026/27"). Generation is bounded to it so no slot is ever created
        // outside the window (the offer queries also re-filter, belt and braces).
        const ow = seasonOfferWindow(season)
        const eveningWindow = ow
          ? { start: new Date(`${ow.start}T00:00:00Z`), end: new Date(`${ow.end}T00:00:00Z`) }
          : null

        // Club-wide Spielhalle pool: the shared game-hall slots (label
        // 'Spielhalle', no team assigned — KWI A/B on Friday). Any team without
        // its own 21:30 Döltschi/KWI slot falls back to these.
        const spielhalleSlots = await trx('hall_slots')
          .whereRaw("LOWER(label) = 'spielhalle'")
          .select('day_of_week', 'start_time', 'end_time', 'hall')

        // Shared VOLLEYBALL Döltschi pool: the Under teams take each other's
        // Tuesday Döltschi slots. Volleyball only — the BB Döltschi slots stay out.
        const doltschiVbPool = await trx('hall_slots')
          .join('halls', 'hall_slots.hall', 'halls.id')
          .where('hall_slots.sport', 'volleyball')
          .whereRaw("(LOWER(halls.name) LIKE '%döltschi%' OR LOWER(halls.name) LIKE '%doltschi%')")
          .select('hall_slots.day_of_week', 'hall_slots.start_time', 'hall_slots.end_time', 'hall_slots.hall')

        // KWI game halls — used for junior Sunday slots (rule A2/C1). Juniors may
        // play home games on any Sunday; the times are fixed.
        const kwiHalls = await trx('halls')
          .whereRaw("LOWER(name) LIKE '%kwi%'").orderBy('name').select('id')
        const SUNDAY_TIMES = ['11:00', '13:00', '15:00']

        // Teams excluded from Terminplanung entirely (no league fixtures to
        // schedule) — mirrors SCHEDULING_EXCLUDED_TEAM_NAMES in the frontend
        // (src/modules/gameScheduling/utils/schedulableTeams.ts). No slots generated.
        const SCHEDULING_EXCLUDED_TEAM_NAMES = ['MiniVB', 'DU20']
        const teams = await trx('teams')
          .where('sport', 'volleyball').where('active', true)
          .whereNotIn('name', SCHEDULING_EXCLUDED_TEAM_NAMES).select('id', 'name')

        // B1/B2 — Friday gym split with basketball. Until the October vacation
        // (Herbstferien) volleyball uses both halls every Friday. After it, Fridays
        // alternate VB / BB, so VB only gets every other Friday. Parity (documented):
        // the first Friday on/after Herbstferien end is a VB Friday. If no
        // Herbstferien closure is found, keep the pre-vacation behaviour (all Fridays).
        let herbstStart = null
        let herbstEndExclusive = null // first open day after the vacation
        if (eveningWindow) {
          const herbst = await trx('hall_closures')
            .where('source', 'school_holidays')
            .whereRaw("LOWER(reason) LIKE '%herbst%'")
            .andWhere('end_date', '>=', eveningWindow.start)
            .andWhere('start_date', '<=', eveningWindow.end)
            .select(trx.raw('MIN(start_date)::text as s'), trx.raw('MAX(end_date)::text as e'))
            .first()
          if (herbst?.s) herbstStart = new Date(`${herbst.s.slice(0, 10)}T00:00:00Z`)
          if (herbst?.e) herbstEndExclusive = new Date(`${herbst.e.slice(0, 10)}T00:00:00Z`)
        }
        // The reference VB Friday after the vacation = the first Friday on/after the
        // first open day. Used to compute alternating-week parity.
        let firstPostHerbstFriday = null
        if (herbstEndExclusive) {
          const d = new Date(herbstEndExclusive)
          while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1)
          firstPostHerbstFriday = d
        }
        // Smart alternating: VB shares post-vacation Fridays 50/50 with basketball
        // (the gym is VB or BB on a given Friday, club-wide — can't differ per team).
        // Of the two every-other-Friday parities, pick the one that leaves the
        // WORST-AFFECTED Friday team with the fewest absence-hit VB Fridays — i.e.
        // protect the team that has the most absences on its Friday slots (minimax),
        // tie → fewest overall. Only NON-junior teams without their own KWI evening
        // slot count here: those genuinely depend on the Friday Spielhalle as a home
        // option. Juniors are excluded — Friday Spielhalle is a low-priority fallback
        // for them (their priority is own slot / Spielsamstag / Döltschi / Sunday),
        // so their Friday absences shouldn't drive the offset. Strict alternation is
        // preserved; only the offset is chosen.
        let vbFridaySet = null
        if (eveningWindow && herbstStart && firstPostHerbstFriday) {
          const teamsWithOwnSlot = new Set(
            await trx('hall_slots')
              .join('hall_slots_teams', 'hall_slots.id', 'hall_slots_teams.hall_slots_id')
              .join('halls', 'hall_slots.hall', 'halls.id')
              .whereRaw("hall_slots.end_time::text LIKE '21:30%'")
              .whereRaw("LOWER(halls.name) LIKE '%kwi%'")
              .distinct('hall_slots_teams.teams_id')
              .pluck('hall_slots_teams.teams_id'),
          )
          const fridayTeamIds = teams
            .filter((tm) => !isJuniorTeam(tm.name) && !teamsWithOwnSlot.has(tm.id))
            .map((tm) => tm.id)
          const absRows = fridayTeamIds.length
            ? await trx('absences as a')
                .join('member_teams as mt', 'mt.member', 'a.member')
                .whereIn('mt.team', fridayTeamIds)
                .where(function () { this.where('mt.guest_level', 0).orWhereNull('mt.guest_level') })
                .whereRaw("a.type IS DISTINCT FROM 'weekly'")
                .whereRaw('a.blocking IS NOT FALSE')
                .whereRaw("(a.affects::jsonb @> '\"all\"' OR a.affects::jsonb @> '\"games\"')")
                .where('a.end_date', '>=', eveningWindow.start)
                .where('a.start_date', '<=', eveningWindow.end)
                .select(trx.raw('mt.team as team'), trx.raw('a.start_date::date::text as s'), trx.raw('a.end_date::date::text as e'))
            : []
          const fridays = []
          for (const d = new Date(firstPostHerbstFriday); d <= eveningWindow.end; d.setUTCDate(d.getUTCDate() + 7)) {
            fridays.push(d.toISOString().slice(0, 10))
          }
          // Which teams have a game-affecting absence on each Friday.
          const teamsAbsentOn = new Map()
          for (const r of absRows) {
            for (const f of fridays) {
              if (r.s <= f && f <= r.e) {
                if (!teamsAbsentOn.has(f)) teamsAbsentOn.set(f, new Set())
                teamsAbsentOn.get(f).add(r.team)
              }
            }
          }
          // For an offset: worst = the most absence-hit VB Fridays any single team
          // would carry; total = the same summed over all teams. Pick the offset
          // that minimises the WORST team first, then the total as a tiebreaker.
          const burdenStats = (parity) => {
            const cnt = new Map()
            fridays.forEach((f, i) => {
              if (i % 2 !== parity) return
              for (const team of teamsAbsentOn.get(f) || []) cnt.set(team, (cnt.get(team) || 0) + 1)
            })
            const vals = [...cnt.values()]
            return { worst: vals.length ? Math.max(...vals) : 0, total: vals.reduce((a, b) => a + b, 0) }
          }
          const b0 = burdenStats(0)
          const b1 = burdenStats(1)
          const vbParity = b1.worst !== b0.worst
            ? (b1.worst < b0.worst ? 1 : 0)
            : (b1.total < b0.total ? 1 : 0) // worst-team tie → fewer absences overall; full tie → 0 (default)
          vbFridaySet = new Set(fridays.filter((_, i) => i % 2 === vbParity))
        }
        // Should a Friday `spielhalle` slot be generated for volleyball on `date`?
        const fridayIsVolleyball = (date) => {
          if (!herbstStart || !firstPostHerbstFriday) return true // no Herbst data → all Fridays
          if (date < herbstStart) return true                    // before vacation → every Friday
          if (date < firstPostHerbstFriday) return false         // inside vacation / pre-first-VB-Friday
          if (!vbFridaySet) return true
          return vbFridaySet.has(date instanceof Date ? date.toISOString().slice(0, 10) : String(date).slice(0, 10))
        }

        let total_created = 0
        for (const team of teams) {
          const cfg = teamConfig[String(team.id)]
          // Additive sources. Default (no config) = both. Explicit empty = manual.
          let sources
          if (Array.isArray(cfg?.sources)) sources = cfg.sources
          else if (cfg?.source === 'manual') sources = []
          else if (cfg?.source) sources = [cfg.source]
          else sources = ['hall_slot', 'spielsamstag']
          if (sources.length === 0) continue

          const candidates = []

          // Game-Saturday pool: every picked Saturday × its configured slots.
          if (sources.includes('spielsamstag')) {
            for (const sat of (Array.isArray(spielsamstage) ? spielsamstage : [])) {
              if (!sat?.date || !Array.isArray(sat.slots)) continue
              for (const s of sat.slots) {
                if (!s?.time || !s?.hall_id) continue
                candidates.push({
                  date: sat.date, start_time: s.time, end_time: addHours(s.time, 2),
                  hall: parseInt(s.hall_id, 10) || null, source: 'spielsamstag',
                })
              }
            }
            // A2/C1 — juniors may play home games on ANY Sunday. Generate a Sunday
            // slot on every Sunday in the season window at the fixed times × KWI
            // halls. Not a curated "game-Sunday" list; the soft clustering onto
            // Sundays another junior already uses happens at slot-display time.
            if (isJuniorTeam(team.name) && eveningWindow) {
              const d = new Date(eveningWindow.start)
              while (d <= eveningWindow.end) {
                if (d.getUTCDay() === 0) {
                  const date = d.toISOString().slice(0, 10)
                  for (const time of SUNDAY_TIMES) {
                    for (const h of kwiHalls) {
                      candidates.push({
                        date, start_time: time, end_time: addHours(time, 2),
                        hall: h.id, source: 'spielsonntag',
                      })
                    }
                  }
                }
                d.setUTCDate(d.getUTCDate() + 1)
              }
            }
          }

          // Standard slot (volleyball-only generator):
          //  - KWI teams: their own latest KWI block (ends 21:30).
          //  - Döltschi (Under) teams: the SHARED volleyball Döltschi pool — any
          //    team that uses Döltschi can take any VB Döltschi slot.
          //  - Neither: fall back to the club Spielhalle pool (KWI A/B Friday).
          // day_of_week is 0=Mon in the DB -> JS getUTCDay (0=Sun) via (dow + 1) % 7.
          if (sources.includes('hall_slot') && eveningWindow) {
            const ownKwi = await trx('hall_slots')
              .join('hall_slots_teams', 'hall_slots.id', 'hall_slots_teams.hall_slots_id')
              .join('halls', 'hall_slots.hall', 'halls.id')
              .where('hall_slots_teams.teams_id', team.id)
              .whereRaw("hall_slots.end_time::text LIKE '21:30%'")
              .whereRaw("LOWER(halls.name) LIKE '%kwi%'")
              .select('hall_slots.day_of_week', 'hall_slots.start_time', 'hall_slots.end_time', 'hall_slots.hall')
            const usesDoltschi = await trx('hall_slots')
              .join('hall_slots_teams', 'hall_slots.id', 'hall_slots_teams.hall_slots_id')
              .join('halls', 'hall_slots.hall', 'halls.id')
              .where('hall_slots_teams.teams_id', team.id)
              .where('hall_slots.sport', 'volleyball')
              .whereRaw("(LOWER(halls.name) LIKE '%döltschi%' OR LOWER(halls.name) LIKE '%doltschi%')")
              .first()
            // Build (slot, source-tag) entries. Juniors (Under teams) ALWAYS get the
            // shared VB Döltschi pool — they may play in Döltschi even when it isn't
            // their own slot — AND the club Spielhalle pool (both). Non-juniors keep
            // their own KWI slot, take the Döltschi pool only if assigned, and fall
            // back to Spielhalle only when they have no evening slot at all.
            const isJr = isJuniorTeam(team.name)
            const stdEntries = ownKwi.map((hs) => ({ hs, tag: 'hall_slot' }))
            if (usesDoltschi || isJr) {
              for (const hs of doltschiVbPool) stdEntries.push({ hs, tag: 'hall_slot' })
            }
            if (isJr) {
              for (const hs of spielhalleSlots) stdEntries.push({ hs, tag: 'spielhalle' })
            } else if (stdEntries.length === 0) {
              for (const hs of spielhalleSlots) stdEntries.push({ hs, tag: 'spielhalle' })
            }
            for (const { hs, tag } of stdEntries) {
              const targetJsDay = (hs.day_of_week + 1) % 7
              const d = new Date(eveningWindow.start)
              while (d <= eveningWindow.end) {
                if (d.getUTCDay() === targetJsDay) {
                  // B1/B2 — the shared Friday Spielhalle pool alternates with
                  // basketball after the October vacation. Skip VB-off Fridays.
                  const isFridaySpielhalle = tag === 'spielhalle' && targetJsDay === 5
                  if (!isFridaySpielhalle || fridayIsVolleyball(d)) {
                    candidates.push({
                      date: d.toISOString().slice(0, 10), start_time: hs.start_time,
                      end_time: hs.end_time, hall: hs.hall, source: tag,
                    })
                  }
                }
                d.setUTCDate(d.getUTCDate() + 1)
              }
            }
          }

          // Don't duplicate a surviving booked/blocked slot at the same key.
          //
          // This used to be two queries PER CANDIDATE inside this per-team loop — a
          // SELECT to look for a clash and an INSERT — which came to ~4,000 sequential
          // round-trips for a season across 11 teams (~2,200 candidates, and because
          // the pre-pass deletes every `available` slot first, nearly all of them miss
          // and insert). Each query was itself fast (index scan, 0.13 ms); the cost was
          // purely round-trip count, ~3-8 s of it, in front of a spielplaner staring at
          // a spinner. One SELECT + chunked INSERTs instead.
          //
          // ⚠ The clash key is asymmetric and that is not an accident — the old query
          // only constrained `hall` when the candidate HAD one, so a hall-less candidate
          // clashed with a slot at that date/time in ANY hall. Both shapes are kept.
          //
          // ⚠ No season filter, also deliberate: the original clash check had none, so a
          // slot left over from another season at the same key still blocks. Preserved.
          const existingRows = await trx('game_scheduling_slots')
            .where('kscw_team', team.id)
            .select(
              trx.raw("to_char(date, 'YYYY-MM-DD') AS date"),
              trx.raw("to_char(start_time, 'HH24:MI:SS') AS start_time"),
              'hall',
            )
          const tkey = (v) => String(v).slice(0, 8)
          // Exact (date, time, hall) — used when the candidate names a hall.
          const takenWithHall = new Set(existingRows.map((r) => `${r.date}|${tkey(r.start_time)}|${r.hall}`))
          // (date, time) regardless of hall — used when the candidate has none.
          const takenAnyHall = new Set(existingRows.map((r) => `${r.date}|${tkey(r.start_time)}`))

          const pending = []
          for (const c of candidates) {
            const t = tkey(c.start_time)
            const clash = c.hall != null
              ? takenWithHall.has(`${c.date}|${t}|${c.hall}`)
              : takenAnyHall.has(`${c.date}|${t}`)
            if (clash) continue
            // ⚠ The old loop inserted immediately, so a later duplicate candidate found
            // the earlier one and was skipped. Batching would lose that unless the sets
            // are updated as we accept — two identical candidates would both insert.
            takenAnyHall.add(`${c.date}|${t}`)
            if (c.hall != null) takenWithHall.add(`${c.date}|${t}|${c.hall}`)
            pending.push({
              season: seasonKey, kscw_team: team.id, date: c.date,
              start_time: c.start_time, end_time: c.end_time, hall: c.hall,
              source: c.source, status: 'available',
            })
          }
          const INSERT_CHUNK = 400
          for (let i = 0; i < pending.length; i += INSERT_CHUNK) {
            await trx('game_scheduling_slots').insert(pending.slice(i, i + INSERT_CHUNK))
          }
          total_created += pending.length
        }

        // Auto-cleanup: drop any PENDING home proposal left orphaned — none of its
        // proposed_slot_1/2/3 reference a slot that still exists. The held-slot
        // exclusion above keeps live proposals intact, so this only removes ones
        // whose slots were already gone (otherwise confirm would 400 forever with
        // "Slot is no longer available").
        const pendingHome = await trx('game_scheduling_bookings')
          .where('season', seasonKey).where('type', 'home_slot_pick').where('status', 'pending')
          .select('id', 'proposed_slot_1', 'proposed_slot_2', 'proposed_slot_3')
        let orphans_deleted = 0
        if (pendingHome.length) {
          const refIds = [...new Set(
            pendingHome.flatMap((b) => [b.proposed_slot_1, b.proposed_slot_2, b.proposed_slot_3]).filter((v) => v != null),
          )]
          const liveIds = new Set(
            refIds.length
              ? (await trx('game_scheduling_slots').whereIn('id', refIds).pluck('id')).map((v) => String(v))
              : [],
          )
          const deadBookingIds = pendingHome
            .filter((b) => ![b.proposed_slot_1, b.proposed_slot_2, b.proposed_slot_3].some((s) => s != null && liveIds.has(String(s))))
            .map((b) => b.id)
          if (deadBookingIds.length) {
            await trx('game_scheduling_bookings').whereIn('id', deadBookingIds).del()
            orphans_deleted = deadBookingIds.length
          }
        }

        return { total_created, orphans_deleted }
      })

      res.json({ success: true, total_created, orphans_deleted })
    } catch (err) {
      log.error({ msg: `generate-slots: ${err.message}`, endpoint: 'terminplanung/admin/generate-slots', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /kscw/terminplanung/admin/confirm-away — confirm one of an opponent's
  // away-date proposals. Body: { booking_id, proposal_number (1-3), admin_notes? }.
  // Away proposals live on a single booking row (type 'away_proposal', status
  // 'pending') with up to 3 proposed_datetime_N / proposed_place_N columns.
  router.post('/terminplanung/admin/confirm-away', async (req, res) => {
    try {
      const { booking_id, proposal_number, admin_notes } = req.body || {}
      const n = Number(proposal_number)
      if (!booking_id || ![1, 2, 3].includes(n)) {
        return res.status(400).json({ error: 'booking_id and proposal_number (1-3) required' })
      }

      const booking = await database('game_scheduling_bookings').where('id', booking_id).first()
      if (!booking || booking.type !== 'away_proposal') {
        return res.status(400).json({ error: 'Invalid booking' })
      }
      const chosenDateTime = booking[`proposed_datetime_${n}`]
      if (!chosenDateTime) return res.status(400).json({ error: `Proposal ${n} is empty` })

      const awayOpponent = await database('game_scheduling_opponents').where('id', booking.opponent).first()
      if (!awayOpponent) return res.status(400).json({ error: 'Opponent not found' })
      if (!(await spielplanerCanManageTeam(req, awayOpponent.kscw_team))) return res.status(403).json({ error: 'Not authorized for this team' })

      // Re-validate the chosen proposal against the same offer-time guards (state
      // may have changed since the opponent proposed): derby clamp (Art. 27), team
      // event, game-spacing gap and cross-team same-day. Mirrors propose-away.
      {
        // proposed_datetime_N comes back from knex as a JS Date — String(Date)
        // gives "Sat Feb 13 …", so slice(0,10) yields garbage that 500s the
        // ?::date guards below. Normalise to a YYYY-MM-DD first.
        const chosenDay = String(chosenDateTime instanceof Date ? chosenDateTime.toISOString() : chosenDateTime).slice(0, 10)
        const awaySeasonRow = await database('game_scheduling_seasons').where('id', awayOpponent.season).first()
        const awayRueckStart = rueckrundeStart(awaySeasonRow)
        const awayDerbyAnchors = await confirmedDerbyAnchors(awayOpponent.kscw_team, awayOpponent.season, awayRueckStart)
        if (derbyDateBlocked(chosenDay, awayDerbyAnchors, awayRueckStart)) {
          return res.status(400).json({ error: 'away_before_derby' })
        }
        const eventCover = await database('events as e')
          .join('events_teams as et', 'et.events_id', 'e.id')
          .where('et.teams_id', awayOpponent.kscw_team)
          .whereRaw(
            "?::date BETWEEN (e.start_date AT TIME ZONE 'Europe/Zurich')::date " +
            "AND (COALESCE(e.end_date, e.start_date) AT TIME ZONE 'Europe/Zurich')::date",
            [chosenDay],
          )
          .first('e.title')
        if (eventCover) {
          return res.status(400).json({ error: `${chosenDay} falls on a team event${eventCover.title ? ` (${eventCover.title})` : ''} — please pick another date.` })
        }
        // Gap: the chosen proposal slot decides strict vs lenient (1-2 strict, 3 loose).
        const awayGaps = await seasonGaps(awayOpponent.season)
        const held = { includeHeld: true, excludeOpponent: awayOpponent.id }
        const committedGap = await committedGameDates(awayOpponent.kscw_team, n < 3 ? awayGaps.proposal : awayGaps.proposal3, held)
        if (committedGap.has(chosenDay)) {
          return res.status(400).json({ error: `${chosenDay} is too close to an existing game — please pick another date.` })
        }
        const sharedTeams = await sharedPlayerTeams(awayOpponent.kscw_team)
        const xTeams = await teamsCommittedOnDate(sharedTeams, chosenDay, database)
        if (xTeams.length) {
          const names = await database('teams').whereIn('id', xTeams).pluck('name')
          return res.status(400).json({ error: 'conflict_cross_team', teams: names.join(', ') })
        }
      }

      const actor = await resolveActingUser(req)
      await database('game_scheduling_bookings').where('id', booking_id).update({
        status: 'confirmed',
        confirmed_proposal: n,
        admin_notes: admin_notes || booking.admin_notes || null,
        confirmed_by_name: actor.name,
        confirmed_by_email: actor.email,
        confirmed_at: database.fn.now(),
      })

      await writeUserLog(database, log, { accountability: req.accountability, action: 'update', collection: 'game_scheduling_bookings', recordId: booking_id, data: { kind: 'confirm_away', proposal: n } })

      // Mirror into `games` so the away fixture shows on member calendars right
      // away (fire-and-forget; sv-sync adopts the row later).
      reconcileBookingsToGames(awayOpponent.season).catch((e) => log.warn(`confirm-away games reconcile failed: ${e.message}`))

      // Confirmation email to the opponent in their language — final date +
      // "enter it in VolleyManager, we'll do the home game". Best-effort.
      try {
        const opponent = await database('game_scheduling_opponents').where('id', booking.opponent).first()
        if (opponent) {
          const team = await database('teams').where('id', opponent.kscw_team).first()
          const kscw = `KSCW ${team?.name || ''}`.trim()
          const opp = opponent.club_name || opponent.team_name || ''
          const { date, time } = fmtDateMail(chosenDateTime)
          const place = booking[`proposed_place_${n}`] || ''

          // Opponent confirmation (their language).
          if (opponent.contact_email) {
            const { subject, text, html } = schedEmail(opponent.language, 'game_confirmed', {
              contact: opponent.contact_name || '', kscw, opp, date, time,
            })
            await sendSchedulingMail(opponent.contact_email, subject, text, null, html)
          }

          // Per-leg notice → spielplanung mailbox only (auto-forwards to the VB
          // Spielplanung group). Coaches/TR are NOT notified here — they get a
          // single combined summary once the full schedule is confirmed.
          const adminText = `Auswärtsspiel bestätigt:\n\n${kscw} (Auswärts) bei ${opp}\n${date}${time ? `, ${time} Uhr` : ''}${place ? `, ${place}` : ''}`
          const adminHtml = adminNotifyHtml({
            title: 'Auswärtsspiel bestätigt',
            lead: `${kscw} (Auswärts) bei ${opp}`,
            infoRows: [
              { label: 'Spiel', value: `${kscw} (Auswärts) bei ${opp}` },
              { label: 'Datum', value: date, halfWidth: !!time },
              ...(time ? [{ label: 'Zeit', value: time, halfWidth: true }] : []),
              ...(place ? [{ label: 'Ort', value: place }] : []),
            ],
          })
          await sendSchedulingMail(SCHEDULING_REPLY_TO, `Auswärtsspiel bestätigt – ${opp} (${kscw})`, adminText, null, adminHtml)
        }
      } catch (mailErr) {
        log.warn(`Confirm-away email failed: ${mailErr.message}`)
      }

      res.json({ success: true, confirmed_proposal: n })
    } catch (err) {
      log.error({ msg: `confirm-away: ${err.message}`, endpoint: 'terminplanung/admin/confirm-away', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /kscw/terminplanung/admin/manual-booking — record an already-agreed
  // matchup directly, skipping the opponent's propose/choose flow. Used when the
  // spielplaner has settled the date(s) by email/phone outside the tool. Body:
  //   { opponent_id, home?: { date, start_time, end_time?, hall }, away?: { date, start_time?, place? } }
  // Either leg (or both) may be supplied. The home leg books a real slot (reusing
  // an existing open slot at that date/time/hall if one exists, else creating a
  // manual one) so it shows on the season calendar and feeds the cross-team /
  // Döltschi checks going forward. No emails are sent — the agreement already
  // happened; coaches get the combined summary via finalize-notify. Deliberately
  // permissive (no Saturday-cap / gap / cross-team rejection): the admin is
  // overriding on purpose. The one hard guard is "don't steal a slot another
  // opponent already booked".
  router.post('/terminplanung/admin/manual-booking', async (req, res) => {
    try {
      const { opponent_id, home, away } = req.body || {}
      if (!opponent_id) return res.status(400).json({ error: 'opponent_id required' })
      if (!home && !away) return res.status(400).json({ error: 'Provide a home and/or away game' })
      const opponent = await database('game_scheduling_opponents').where('id', opponent_id).first()
      if (!opponent) return res.status(404).json({ error: 'Opponent not found' })
      if (!(await spielplanerCanManageTeam(req, opponent.kscw_team))) return res.status(403).json({ error: 'Not authorized for this team' })
      const actor = await resolveActingUser(req)
      const seasonId = opponent.season
      let homeBookingId = null

      // Guard against date typos (e.g. 10.02.2026 for a 2026/27 season): a manual
      // game's date must fall within the season's offer window. Auto-tracks the
      // configured season_opens / season_closes (migration 108), so it stays
      // correct across seasons without hardcoding. Both legs are checked.
      const manualSeasonRow = await database('game_scheduling_seasons').where('id', opponent.season).first()
      const offerWindow = seasonOfferWindow(manualSeasonRow)
      const fmtWin = (ymd) => { const [y, m, d] = ymd.split('-'); return `${d}.${m}.${y}` }
      const outsideWindow = (ymd) => offerWindow && (ymd < offerWindow.start || ymd > offerWindow.end)
      const windowError = () => `Date must be within the season window (${fmtWin(offerWindow.start)} – ${fmtWin(offerWindow.end)}).`

      // Multi-game: each leg may name its fixture; absent → first of its side.
      const fixtures = await opponentSvrzFixtures(opponent)
      const homeTarget = home ? resolveTargetFixture(fixtures, true, home.svrz_game_id || null) : null
      if (home && !homeTarget) return res.status(400).json({ error: 'Invalid home game for this opponent' })
      const awayTarget = away ? resolveTargetFixture(fixtures, false, away.svrz_game_id || null) : null
      if (away && !awayTarget) return res.status(400).json({ error: 'Invalid away game for this opponent' })

      const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
      const TIME_RE = /^\d{2}:\d{2}(?::\d{2})?$/

      if (home) {
        if (!DATE_RE.test(String(home.date || ''))) return res.status(400).json({ error: 'home.date must be YYYY-MM-DD' })
        if (outsideWindow(String(home.date))) return res.status(400).json({ error: windowError() })
        // Club-wide blackout (migration 160): no HOME game on a superadmin-blocked
        // date, even via manual booking — remove the block first to override.
        {
          const blocked = await database('scheduling_global_blocks')
            .whereRaw('? BETWEEN start_date AND end_date', [String(home.date)])
            // Migration 286: club-wide (NULL) or volleyball only.
            .where((q) => q.whereNull('sport').orWhere('sport', 'volleyball'))
            .first('id')
          if (blocked) return res.status(400).json({ error: 'This date is blocked club-wide (no home games). Remove the block to book it.' })
        }
        if (!home.start_time || !TIME_RE.test(String(home.start_time))) return res.status(400).json({ error: 'home.start_time must be HH:MM' })
        if (home.end_time && !TIME_RE.test(String(home.end_time))) return res.status(400).json({ error: 'home.end_time must be HH:MM' })
        if (!home.hall) return res.status(400).json({ error: 'home.hall required' })

        // Optional multi-court booking (migration 221): a game played across more
        // than one hall, e.g. an H1/H3 derby over KWI A+B with the divider open.
        // VolleyManager models that as ONE combo gym, so the push translates the
        // SET {hall, ...additional_halls} → a gym uuid (see scripts/vm-halls.mjs);
        // it refuses rather than guessing if the set has no registered gym.
        // Validated here so a typo can't reach the push as a silent half-booking.
        let homeExtraHalls = null
        if (home.additional_halls != null) {
          if (!Array.isArray(home.additional_halls)) {
            return res.status(400).json({ error: 'home.additional_halls must be an array of hall IDs' })
          }
          const extras = [...new Set(home.additional_halls.map((h) => Number(h)).filter((h) => Number.isFinite(h)))]
            .filter((h) => String(h) !== String(home.hall))   // the primary is implicit
          if (extras.length !== new Set(home.additional_halls.map(String)).size - (home.additional_halls.map(String).includes(String(home.hall)) ? 1 : 0)) {
            return res.status(400).json({ error: 'home.additional_halls must contain only numeric hall IDs' })
          }
          if (extras.length) {
            const known = await database('halls').whereIn('id', extras).pluck('id')
            const unknown = extras.filter((h) => !known.map(String).includes(String(h)))
            if (unknown.length) return res.status(400).json({ error: `Unknown hall ID(s): ${unknown.join(', ')}` })

            // An extra court must actually be FREE at that moment. Slots are
            // per-team and each team gets its own hall from the Trainingsplan, so
            // KWI A and KWI B are routinely offered to two different teams at the
            // same time — claiming B for an A+B game while another team already
            // has B booked would put two games on one court. Nothing else checks
            // this: `additional_halls` is invisible to every availability query.
            const clash = await database('game_scheduling_slots as s')
              .leftJoin('teams as t', 't.id', 's.kscw_team')
              .whereIn('s.hall', extras)
              .where('s.date', home.date)
              .where('s.start_time', home.start_time)
              .whereIn('s.status', ['booked', 'blocked'])
              .first('s.hall', 's.status', 't.name as team_name')
            if (clash) {
              const hallRow = await database('halls').where('id', clash.hall).first('name')
              return res.status(400).json({
                error: `${hallRow?.name || `Hall ${clash.hall}`} is already ${clash.status} at that time${clash.team_name ? ` (${clash.team_name})` : ''} — it cannot also be used by this game.`,
              })
            }
            homeExtraHalls = JSON.stringify(extras)
          }
        }

        // Cross-sport (migration 346): a placed basketball game holds this floor.
        // Checked for the primary hall AND any extra court, and before the
        // transaction so the refusal names the game rather than dying on a
        // half-built booking. A manual booking is the planner overriding the offer
        // list, which is exactly the path that never saw the basketball placement.
        const bbHit = await bbFloorConflict(home.date, home.hall, homeExtraHalls, home.start_time, home.end_time || null)
        if (bbHit) return res.status(400).json({ error: bbConflictMessage(bbHit) })

        await database.transaction(async (trx) => {
          await trx.raw('SELECT pg_advisory_xact_lock(?, ?)', [GSCH_BOOK_LOCK_CLASS, opponent.kscw_team])
          // Releasing-on-overwrite: if this opponent already had a confirmed home
          // slot FOR THIS FIXTURE, free it (set back to available) so a re-entry
          // doesn't orphan a booked slot on the calendar. Captured before we
          // delete the booking. Other fixtures' bookings stay untouched.
          const prior = await scopeToFixture(
            trx('game_scheduling_bookings')
              .where({ opponent: opponent.id, type: 'home_slot_pick', status: 'confirmed' }),
            homeTarget,
          ).whereNotNull('slot').first()
          const priorSlotId = prior ? prior.slot : null

          // Reuse an existing slot at this exact key so the calendar doesn't end up
          // with a duplicate (one available, one booked). Else mint a manual slot.
          const existing = await trx('game_scheduling_slots')
            .where({ kscw_team: opponent.kscw_team, date: home.date, start_time: home.start_time })
            .where('hall', home.hall)
            .forUpdate().first()
          let slotId
          if (existing) {
            // Booked by a DIFFERENT opponent → real conflict. Booked by this same
            // opponent (re-confirming the identical slot) → fine, just re-book it.
            if (existing.status === 'booked' && String(existing.id) !== String(priorSlotId)) {
              throw Object.assign(new Error('A game is already booked in that slot'), { httpStatus: 400 })
            }
            // Never silently promote a deliberately blocked slot to booked.
            if (existing.status === 'blocked') {
              throw Object.assign(new Error('That slot is blocked — unblock it first'), { httpStatus: 400 })
            }
            await trx('game_scheduling_slots').where('id', existing.id)
              .update({
                status: 'booked',
                end_time: home.end_time || existing.end_time || null,
                // Always write the caller's intent, including back to NULL — a
                // re-entry that drops the extra hall must shrink the booking, not
                // silently keep yesterday's combo and push two courts.
                additional_halls: homeExtraHalls,
              })
            slotId = existing.id
          } else {
            const inserted = await trx('game_scheduling_slots').insert({
              season: seasonId, kscw_team: opponent.kscw_team, date: home.date,
              start_time: home.start_time, end_time: home.end_time || null, hall: home.hall,
              additional_halls: homeExtraHalls,
              source: 'manual', status: 'booked',
            }).returning('id')
            slotId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0]
          }
          await scopeToFixture(
            trx('game_scheduling_bookings').where({ opponent: opponent.id, type: 'home_slot_pick' }),
            homeTarget,
          ).del()
          // Free the previously-booked slot (now detached) unless it's the one we
          // just re-booked. A 'manual' source slot left empty is just deleted.
          if (priorSlotId && String(priorSlotId) !== String(slotId)) {
            const priorSlot = await trx('game_scheduling_slots').where('id', priorSlotId).first()
            if (priorSlot && priorSlot.source === 'manual') {
              await trx('game_scheduling_slots').where('id', priorSlotId).del()
            } else if (priorSlot) {
              await trx('game_scheduling_slots').where('id', priorSlotId).update({ status: 'available' })
            }
          }
          const insHome = await trx('game_scheduling_bookings').insert({
            opponent: opponent.id, season: seasonId, type: 'home_slot_pick',
            status: 'confirmed', confirmed_proposal: 1, proposed_slot_1: slotId, slot: slotId,
            svrz_game_id: homeTarget.fixtureId,
            admin_notes: 'Manuell erfasst',
            confirmed_by_name: actor.name, confirmed_by_email: actor.email, confirmed_at: trx.fn.now(),
          }).returning('id')
          homeBookingId = typeof insHome[0] === 'object' ? insHome[0].id : insHome[0]
        })
        // VM push happens below, after the Saturday hall rule has settled the
        // final hall (so a lone Saturday game pushes as KWI C, not the picked hall).
      }

      if (away) {
        if (!DATE_RE.test(String(away.date || ''))) return res.status(400).json({ error: 'away.date must be YYYY-MM-DD' })
        if (outsideWindow(String(away.date))) return res.status(400).json({ error: windowError() })
        if (away.start_time && !TIME_RE.test(String(away.start_time))) return res.status(400).json({ error: 'away.start_time must be HH:MM' })
        const dt = away.start_time ? `${away.date}T${away.start_time}` : away.date
        await scopeToFixture(
          database('game_scheduling_bookings').where({ opponent: opponent.id, type: 'away_proposal' }),
          awayTarget,
        ).del()
        await database('game_scheduling_bookings').insert({
          opponent: opponent.id, season: seasonId, type: 'away_proposal',
          status: 'confirmed', confirmed_proposal: 1,
          svrz_game_id: awayTarget.fixtureId,
          proposed_datetime_1: dt, proposed_place_1: String(away.place || '').slice(0, 200),
          admin_notes: 'Manuell erfasst',
          confirmed_by_name: actor.name, confirmed_by_email: actor.email, confirmed_at: database.fn.now(),
        })
      }

      if (home) await writeUserLog(database, log, { accountability: req.accountability, action: 'create', collection: 'game_scheduling_bookings', recordId: homeBookingId, data: { kind: 'manual_home', date: home.date, start_time: home.start_time, hall: home.hall } })
      if (away) await writeUserLog(database, log, { accountability: req.accountability, action: 'create', collection: 'game_scheduling_bookings', recordId: null, data: { kind: 'manual_away', opponent: opponent.id, date: away.date } })

      await database('game_scheduling_opponents').where('id', opponent.id).update({ status: 'booked' })

      // Apply the Saturday hall rule before pushing so VM receives the final hall
      // (a lone Saturday game lands in KWI C). Then push this home booking and any
      // other game it bumped (a previously-lone game now sharing the time → A+B).
      let satReb = { moved: [] }
      try { satReb = await rebalanceSaturdayHalls(opponent.season) } catch (e) { log.warn(`manual-booking Saturday rebalance failed: ${e.message}`) }
      if (home && homeBookingId) {
        try {
          await database('game_scheduling_bookings').where('id', homeBookingId).update({ vm_push_status: 'queued', vm_push_error: null })
          await spawnVmPush(homeBookingId, { svrzId: homeTarget.fixtureId || null })
        } catch (pushErr) { log.warn(`manual-booking VM push enqueue failed: ${pushErr.message}`) }
      }
      repushMovedBookings(satReb.moved, { excludeBookingId: homeBookingId })
      await logRebalanceMoves(req, satReb.moved, { excludeBookingId: homeBookingId })

      // Mirror into `games` so the manual booking shows on member calendars
      // right away (fire-and-forget; sv-sync adopts the row later).
      reconcileBookingsToGames(opponent.season).catch((e) => log.warn(`manual-booking games reconcile failed: ${e.message}`))

      res.json({ success: true })
    } catch (err) {
      if (err && err.httpStatus) return res.status(err.httpStatus).json({ error: err.message })
      log.error({ msg: `manual-booking: ${err.message}`, endpoint: 'terminplanung/admin/manual-booking', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /kscw/terminplanung/admin/delete-booking { booking_id } — cancel a
  // CONFIRMED game so the matchup can be rescheduled. Deletes the booking, frees
  // its home slot (a 'manual' slot is removed, a real one goes back to
  // available), and clears the mirrored `games` row (skip-notify, so the
  // cancellation doesn't fan out a push — a later rebook re-notifies). VM is NOT
  // un-pushed: there's no VM delete API, so a game already in VolleyManager must
  // be removed/rescheduled there by hand (the UI warns about this).
  router.post('/terminplanung/admin/delete-booking', async (req, res) => {
    try {
      const bookingId = req.body?.booking_id
      if (!bookingId) return res.status(400).json({ error: 'booking_id required' })
      const booking = await database('game_scheduling_bookings').where('id', bookingId).first()
      if (!booking) return res.status(404).json({ error: 'Booking not found' })
      if (booking.status !== 'confirmed') return res.status(400).json({ error: 'Only a confirmed game can be deleted here' })
      const opponent = await database('game_scheduling_opponents').where('id', booking.opponent).first()
      if (!opponent) return res.status(404).json({ error: 'Opponent not found' })
      if (!(await spielplanerCanManageTeam(req, opponent.kscw_team))) return res.status(403).json({ error: 'Not authorized for this team' })
      const actor = await resolveActingUser(req)
      const isHome = booking.type === 'home_slot_pick'

      // Resolve the member-calendar row key (vb_<svrz_number> + kscw_team) for
      // this fixture before the txn — same mapping reconcileBookingsToGames uses.
      let gameId = null
      try {
        const fixtures = await opponentSvrzFixtures(opponent)
        const side = fixtures.filter((f) => f.is_home_kscw === isHome)
        const fxMeta = booking.svrz_game_id ? side.find((f) => String(f.id) === String(booking.svrz_game_id)) : side[0]
        if (fxMeta) {
          const fx = await database('svrz_games').where('svrz_persistence_id', fxMeta.id).first('svrz_number')
          if (fx?.svrz_number) gameId = `vb_${fx.svrz_number}`
        }
      } catch (e) { log.warn(`delete-booking: games-row resolve failed: ${e.message}`) }

      await database.transaction(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(?, ?)', [GSCH_BOOK_LOCK_CLASS, opponent.kscw_team])
        // Free the home slot (away legs hold no slot). A 'manual' slot is a
        // one-off → delete it; a real generated slot goes back to available.
        if (isHome && booking.slot) {
          const slot = await trx('game_scheduling_slots').where('id', booking.slot).first()
          if (slot && slot.source === 'manual') {
            await trx('game_scheduling_slots').where('id', slot.id).del()
          } else if (slot) {
            await trx('game_scheduling_slots').where('id', slot.id).update({ status: 'available' })
          }
        }
        await trx('game_scheduling_bookings').where('id', bookingId).del()
        // Remove the member-calendar mirror for this fixture (never a played
        // game — sv-sync owns results). Suppress the notify fanout.
        if (gameId) {
          await trx.raw("SELECT set_config('kscw.skip_games_notify', 'on', true)")
          await trx('games').where({ game_id: gameId, kscw_team: opponent.kscw_team })
            .whereNot('status', 'completed').del()
        }
      })

      await writeUserLog(database, log, {
        accountability: req.accountability, action: 'delete', collection: 'game_scheduling_bookings',
        recordId: bookingId,
        data: { kind: isHome ? 'delete_confirmed_home' : 'delete_confirmed_away', opponent: opponent.id, freed_slot: isHome ? booking.slot : null },
      })

      // Freeing a slot can leave a previously-paired Saturday game alone at its
      // time → spill it back into KWI C. Re-push any game whose hall moved, then
      // mirror the new halls into `games`.
      let satReb = { moved: [] }
      try { satReb = await rebalanceSaturdayHalls(opponent.season) } catch (e) { log.warn(`delete-booking Saturday rebalance failed: ${e.message}`) }
      repushMovedBookings(satReb.moved)
      await logRebalanceMoves(req, satReb.moved)
      reconcileBookingsToGames(opponent.season).catch((e) => log.warn(`delete-booking games reconcile failed: ${e.message}`))

      res.json({ success: true })
    } catch (err) {
      if (err && err.httpStatus) return res.status(err.httpStatus).json({ error: err.message })
      log.error({ msg: `delete-booking: ${err.message}`, endpoint: 'terminplanung/admin/delete-booking', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /kscw/admin/terminplanung/vm-push — (re)push a confirmed HOME booking's
  // date/time/hall into VolleyManager. Used for manual retry of a failed push and
  // for resolving an ambiguous match: pass svrz_persistence_id to pick the exact
  // fixture when the booking is in 'needs_pick'. Fire-and-forget; the child writes
  // the result back onto the booking (vm_push_status/…).
  router.post('/admin/terminplanung/vm-push', async (req, res) => {
    try {
      if (!(await isAdminOrSpielplaner(req))) return res.status(403).json({ error: 'Admin only' })
      const { booking_id, svrz_persistence_id } = req.body || {}
      if (!booking_id) return res.status(400).json({ error: 'booking_id required' })
      const booking = await database('game_scheduling_bookings').where('id', booking_id).first()
      if (!booking || booking.type !== 'home_slot_pick') return res.status(400).json({ error: 'Not a home booking' })
      if (booking.status !== 'confirmed') return res.status(400).json({ error: 'Booking is not confirmed' })
      const opponent = await database('game_scheduling_opponents').where('id', booking.opponent).first()
      if (!opponent || !(await spielplanerCanManageTeam(req, opponent.kscw_team))) return res.status(403).json({ error: 'Not authorized for this team' })
      await database('game_scheduling_bookings').where('id', booking_id).update({ vm_push_status: 'queued', vm_push_error: null })
      await spawnVmPush(booking_id, { svrzId: svrz_persistence_id || null })
      res.json({ queued: true })
    } catch (err) {
      log.error({ msg: `vm-push: ${err.message}`, endpoint: 'admin/terminplanung/vm-push', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /kscw/terminplanung/admin/finalize-notify — send the finalized schedule
  // (all confirmed home + away games) for one team+season to the team's coaches
  // + team-responsibles AND the spielplanung mailbox (which auto-forwards to the
  // VB Spielplanung group). Manual: the spielplaner clicks this once the schedule
  // is complete. Opponents are NOT included — they already received per-leg
  // confirmations, and a team-wide summary would leak other clubs' games.
  // Body: { team_id, season_id }.
  router.post('/terminplanung/admin/finalize-notify', async (req, res) => {
    try {
      const teamId = Number(req.body?.team_id)
      const seasonId = Number(req.body?.season_id)
      if (!teamId || !seasonId) return res.status(400).json({ error: 'team_id and season_id required' })
      if (!(await spielplanerCanManageTeam(req, teamId))) return res.status(403).json({ error: 'Not authorized for this team' })

      const [team, season] = await Promise.all([
        database('teams').where('id', teamId).first('id', 'name'),
        database('game_scheduling_seasons').where('id', seasonId).first('id', 'season'),
      ])
      if (!team) return res.status(404).json({ error: 'Team not found' })
      const kscw = `KSCW ${team.name || ''}`.trim()
      const seasonLabel = season?.season || ''

      const opponents = await database('game_scheduling_opponents')
        .where('kscw_team', teamId).where('season', seasonId)
        .whereNotIn('status', ['revoked', 'expired'])
        .select('id', 'team_name', 'club_name')
      const oppName = (o) => (o && (o.club_name || o.team_name)) || '—'
      const oppById = new Map(opponents.map((o) => [o.id, o]))
      const oppIds = opponents.map((o) => o.id)

      let homeRows = [], awayRows = []
      if (oppIds.length) {
        ;[homeRows, awayRows] = await Promise.all([
          database('game_scheduling_bookings as b')
            .join('game_scheduling_slots as s', 's.id', 'b.slot')
            .leftJoin('halls as h', 'h.id', 's.hall')
            .whereIn('b.opponent', oppIds).where('b.type', 'home_slot_pick').where('b.status', 'confirmed')
            .select('b.opponent', 's.date', 's.start_time', 's.end_time', 'h.name as hall'),
          database('game_scheduling_bookings')
            .whereIn('opponent', oppIds).where('type', 'away_proposal').where('status', 'confirmed')
            .select('opponent', 'confirmed_proposal',
              'proposed_datetime_1', 'proposed_datetime_2', 'proposed_datetime_3',
              'proposed_place_1', 'proposed_place_2', 'proposed_place_3'),
        ])
      }

      const homeCountByOpp = new Map()
      homeRows.forEach((r) => homeCountByOpp.set(r.opponent, (homeCountByOpp.get(r.opponent) || 0) + 1))
      const awayCountByOpp = new Map()
      awayRows.forEach((r) => awayCountByOpp.set(r.opponent, (awayCountByOpp.get(r.opponent) || 0) + 1))

      // Home game lines, sorted by date.
      const homeLines = homeRows.map((r) => {
        const { date } = fmtDateMail(r.date)
        const start = String(r.start_time || '').slice(0, 5)
        const end = String(r.end_time || '').slice(0, 5)
        const time = start ? `${start}${end ? `–${end}` : ''}` : ''
        return { sort: String(r.date || ''), text: `• ${date}${time ? `, ${time} Uhr` : ''}${r.hall ? `, ${r.hall}` : ''} – vs ${oppName(oppById.get(r.opponent))}` }
      }).sort((a, b) => a.sort.localeCompare(b.sort)).map((x) => x.text)

      // Away game lines (confirmed proposal), sorted by datetime.
      const awayLines = awayRows.map((r) => {
        const dt = r[`proposed_datetime_${r.confirmed_proposal}`]
        const place = r[`proposed_place_${r.confirmed_proposal}`] || ''
        const { date, time } = fmtDateMail(dt)
        return { sort: String(dt || ''), text: `• ${date}${time ? `, ${time} Uhr` : ''}${place ? `, ${place}` : ''} – bei ${oppName(oppById.get(r.opponent))}` }
      }).sort((a, b) => a.sort.localeCompare(b.sort)).map((x) => x.text)

      // Opponents still missing a confirmed game — per FIXTURE: a pairing can
      // be played 2-3× (junior triple round-robin), so compare confirmed
      // bookings per side against the synced fixture count (1+1 fallback when
      // the opponent has no synced fixtures).
      const pending = []
      for (const o of opponents) {
        const fixtures = await opponentSvrzFixtures({ ...o, kscw_team: teamId, season: seasonId })
        const homeTotal = fixtures.length ? fixtures.filter((f) => f.is_home_kscw).length : 1
        const awayTotal = fixtures.length ? fixtures.filter((f) => !f.is_home_kscw).length : 1
        const homeMiss = homeTotal - (homeCountByOpp.get(o.id) || 0)
        const awayMiss = awayTotal - (awayCountByOpp.get(o.id) || 0)
        const miss = []
        if (homeMiss > 0) miss.push(homeMiss > 1 ? `${homeMiss} Heimspiele` : 'Heimspiel')
        if (awayMiss > 0) miss.push(awayMiss > 1 ? `${awayMiss} Auswärtsspiele` : 'Auswärtsspiel')
        if (miss.length) pending.push(`• ${oppName(o)}: ${miss.join(' + ')} offen`)
      }

      const parts = [`Spielplan ${kscw}${seasonLabel ? ` – Saison ${seasonLabel}` : ''}`, '']
      parts.push(`Heimspiele (${homeLines.length}):`, ...(homeLines.length ? homeLines : ['• keine']), '')
      parts.push(`Auswärtsspiele (${awayLines.length}):`, ...(awayLines.length ? awayLines : ['• keine']))
      if (pending.length) parts.push('', `Noch offen (${pending.length}):`, ...pending)
      const text = parts.join('\n')

      // Branded HTML — render each section as its own info card (strip the leading
      // `• ` from the already Swiss-formatted lines). Dates are produced via
      // fmtDateMail above, never raw Date strings.
      const stripBullet = (s) => String(s).replace(/^•\s*/, '')
      const sectionCard = (heading, lines, empty) => {
        const para = `<p style="font-size:13px;text-transform:uppercase;letter-spacing:0.5px;color:#94a3b8;font-weight:700;margin:0 0 8px">${escHtml(heading)}</p>`
        const rows = (lines.length ? lines : [empty]).map((l, i) => ({ label: String(i + 1), value: stripBullet(l) }))
        return para + buildInfoCard(rows) + '<div style="height:14px;font-size:0;line-height:0">&nbsp;</div>'
      }
      let finalizeBody = sectionCard(`Heimspiele (${homeLines.length})`, homeLines, '• keine')
      finalizeBody += sectionCard(`Auswärtsspiele (${awayLines.length})`, awayLines, '• keine')
      if (pending.length) finalizeBody += sectionCard(`Noch offen (${pending.length})`, pending, '')
      const finalizeHtml = buildEmailLayout(finalizeBody, {
        title: 'Spielplan',
        subtitle: `${kscw}${seasonLabel ? ` – Saison ${seasonLabel}` : ''}`,
        sport: 'vb',
        footerExtra: 'Sportliche Grüsse, KSC Wiedikon',
      })

      // Optional Excel + PDF report, generated client-side and uploaded as
      // base64. Decoded to Buffers for nodemailer. Whitelisted to the two report
      // types and capped (4 files / 8 MB total) so the field can't be abused.
      const ALLOWED_ATTACH = new Set([
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/pdf',
      ])
      const attachments = []
      if (Array.isArray(req.body?.attachments)) {
        let totalBytes = 0
        for (const a of req.body.attachments.slice(0, 4)) {
          if (!a || typeof a.filename !== 'string' || typeof a.content_base64 !== 'string') continue
          if (!ALLOWED_ATTACH.has(a.content_type)) continue
          const content = Buffer.from(a.content_base64, 'base64')
          totalBytes += content.length
          if (!content.length || totalBytes > 8 * 1024 * 1024) continue
          attachments.push({ filename: a.filename.slice(0, 120), content, contentType: a.content_type })
        }
      }

      // To: the spielplanung mailbox (auto-forwards to the VB Spielplanung
      // group). Cc: the team's coaches + team-responsibles.
      const staff = await teamStaffEmails(teamId)
      await sendSchedulingMail(SCHEDULING_REPLY_TO, `Spielplan ${kscw}${seasonLabel ? ` ${seasonLabel}` : ''}`, text, staff.length ? staff.join(',') : null, finalizeHtml, attachments)

      res.json({ success: true, staff: staff.length, home: homeLines.length, away: awayLines.length, pending: pending.length, attachments: attachments.length })
    } catch (err) {
      log.error({ msg: `finalize-notify: ${err.message}`, endpoint: 'terminplanung/admin/finalize-notify', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /kscw/admin/terminplanung/restore-season/:id — undo an archive
  // Reactivates volleyball teams for the season and flips status archived → closed.
  // Does NOT reissue individual invites that were expired by the archive
  // (those tokens stay dead — admin can reissue per invite if needed).
  router.post('/admin/terminplanung/restore-season/:id', async (req, res) => {
    if (!req.accountability?.admin) return res.status(403).json({ error: 'Admin only' })
    try {
      const seasonId = parseInt(req.params.id, 10)
      if (!seasonId) return res.status(400).json({ error: 'invalid season id' })

      const season = await database('game_scheduling_seasons').where('id', seasonId).first()
      if (!season) return res.status(404).json({ error: 'season not found' })
      if (season.status !== 'archived') {
        return res.status(400).json({ error: 'only archived seasons can be restored' })
      }
      if (!season.season) return res.status(400).json({ error: 'season has no name — cannot match teams' })

      // Guard against the rollover double-activation trap: if a NEWER season
      // already has active volleyball teams, this season was rolled forward and
      // reactivating it would leave two active teams per logical team — the
      // exact dual-active state migration 075 had to clean up (broken calendar
      // name/sport resolution, duplicate rosters). 'YYYY/YY' sorts correctly as
      // a string within this century. Caller can force past it knowingly.
      const newerActive = await database('teams')
        .where('sport', 'volleyball')
        .where('active', true)
        .where('season', '>', season.season)
        .first()
      if (newerActive && req.body?.force !== true) {
        return res.status(409).json({
          error: 'A newer active season exists — this season was rolled over. Restoring would create duplicate active teams. Re-send with { "force": true } to override.',
        })
      }

      const teamsRestored = await database('teams')
        .where('sport', 'volleyball')
        .where('season', season.season)
        .where('active', false)
        .update({ active: true })

      await database('game_scheduling_seasons').where('id', seasonId).update({ status: 'closed' })

      // Un-archive the restored teams' chats (inverse of archive-season below).
      await database.raw(
        `UPDATE conversation_members cm SET archived = false
         FROM conversations c
         WHERE cm.conversation = c.id AND c.type = 'team'
           AND c.team IN (SELECT id FROM teams WHERE sport = 'volleyball' AND season = ? AND active = true)`,
        [season.season],
      )

      log.info({
        msg: `restore-season id=${seasonId} (${season.season})`,
        teams_restored: teamsRestored,
        userId: req.accountability?.user || null,
      })
      res.json({ success: true, season: season.season, teams_restored: teamsRestored })
    } catch (err) {
      log.error({ msg: `restore-season: ${err.message}`, endpoint: 'admin/terminplanung/restore-season', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /kscw/admin/terminplanung/archive-season/:id — volleyball-only
  // Season must already be 'closed'. Marks teams inactive, expires lingering
  // invites, flips season status to 'archived'. Reversible by flipping
  // teams.active back to true in Directus admin.
  router.post('/admin/terminplanung/archive-season/:id', async (req, res) => {
    if (!req.accountability?.admin) return res.status(403).json({ error: 'Admin only' })
    try {
      const seasonId = parseInt(req.params.id, 10)
      if (!seasonId) return res.status(400).json({ error: 'invalid season id' })

      const season = await database('game_scheduling_seasons').where('id', seasonId).first()
      if (!season) return res.status(404).json({ error: 'season not found' })
      if (season.status !== 'closed') {
        return res.status(400).json({ error: 'season must be closed before it can be archived' })
      }
      if (!season.season) return res.status(400).json({ error: 'season has no name — cannot match teams' })

      // 1. Deactivate volleyball teams for this season string
      const teamsArchived = await database('teams')
        .where('sport', 'volleyball')
        .where('season', season.season)
        .where('active', true)
        .update({ active: false })

      // 2. Expire any lingering active invites for this season
      const invitesExpired = await database('game_scheduling_opponents')
        .where('season', seasonId)
        .whereIn('status', ['active', 'invited', 'viewed', 'booked'])
        .update({ status: 'expired' })

      // 2b. Archive the archived teams' chats so they drop off members' inboxes
      // (restore-season un-archives them). Mirrors the rollover archive step.
      await database.raw(
        `UPDATE conversation_members cm SET archived = true
         FROM conversations c
         WHERE cm.conversation = c.id AND c.type = 'team'
           AND c.team IN (SELECT id FROM teams WHERE sport = 'volleyball' AND season = ? AND active = false)`,
        [season.season],
      )

      // 3. Flip season to 'archived'
      await database('game_scheduling_seasons').where('id', seasonId).update({ status: 'archived' })

      log.info({
        msg: `archive-season id=${seasonId} (${season.season})`,
        teams_archived: teamsArchived,
        invites_expired: invitesExpired,
        userId: req.accountability?.user || null,
      })
      res.json({
        success: true,
        season: season.season,
        teams_archived: teamsArchived,
        invites_expired: invitesExpired,
      })
    } catch (err) {
      log.error({ msg: `archive-season: ${err.message}`, endpoint: 'admin/terminplanung/archive-season', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /kscw/admin/terminplanung/rollover-season — club-wide season rollover
  // Deep-clones every team of `from_season` into `to_season` (all sports), carrying
  // coaches, responsibles, captain, sponsors, hall-slot assignments and the full
  // roster (member_teams, incl. guests), then archives the source season's teams
  // (active=false). Idempotent: teams already present in `to_season` (matched by
  // external team_id, falling back to name) are skipped, so re-runs fill gaps
  // without duplicating. Whole operation runs in one transaction. With
  // `dry_run: true` the work is rolled back and only the projected counts return —
  // used to populate the confirmation dialog. Full Directus admin only.
  router.post('/admin/terminplanung/rollover-season', async (req, res) => {
    if (!req.accountability?.admin) return res.status(403).json({ error: 'Admin only' })
    try {
      // Derive defaults from the Jun 1 cutover (mirrors currentSeasonLong in
      // src/.../formatSeason.ts — Swiss Volley publishes new-season fixtures in June).
      const now = new Date()
      const startYear = seasonStartYear(now)
      const short = (a, b) => `${a}/${String(b).slice(-2)}`
      const defaultTo = short(startYear, startYear + 1)
      const defaultFrom = short(startYear - 1, startYear)

      const fromSeason = (req.body?.from_season || defaultFrom).trim()
      const toSeason = (req.body?.to_season || defaultTo).trim()
      const dryRun = req.body?.dry_run === true

      if (!fromSeason || !toSeason) return res.status(400).json({ error: 'from_season and to_season required' })
      if (fromSeason === toSeason) return res.status(400).json({ error: 'from_season and to_season must differ' })

      // Columns never copied verbatim onto the clone
      const OMIT = new Set(['id', 'date_created', 'date_updated'])

      let counts
      try {
        await database.transaction(async (trx) => {
          // Idempotency keys already present in the target season
          const existing = await trx('teams').where('season', toSeason).select('team_id', 'name')
          const seen = new Set(existing.map((t) => t.team_id || `name:${t.name}`))

          const sourceTeams = await trx('teams').where('season', fromSeason)
          if (sourceTeams.length === 0) {
            const err = new Error('no teams found in from_season')
            err.httpStatus = 400
            throw err
          }

          const map = {} // oldTeamId -> newTeamId
          let teamsCloned = 0
          let skipped = 0
          for (const team of sourceTeams) {
            const key = team.team_id || `name:${team.name}`
            if (seen.has(key)) { skipped++; continue }
            const row = {}
            for (const [k, v] of Object.entries(team)) {
              if (OMIT.has(k)) continue
              row[k] = v
            }
            row.season = toSeason
            row.active = true
            // Stamp audit timestamps — raw knex inserts bypass Directus' date
            // managers, so before this every rolled-over team/roster row landed
            // with a NULL date_created.
            row.date_created = now
            row.date_updated = now
            // Stale per-team dashboard window — let the new season recompute its default
            row.dashboard_range_from = null
            row.dashboard_range_to = null
            // json/jsonb columns: pg won't accept a parsed object in a
            // parameterised insert — stringify both (recruiting_positions is
            // jsonb and would otherwise throw and abort the whole rollover).
            if (row.features_enabled != null && typeof row.features_enabled === 'object') {
              row.features_enabled = JSON.stringify(row.features_enabled)
            }
            if (row.recruiting_positions != null && typeof row.recruiting_positions === 'object') {
              row.recruiting_positions = JSON.stringify(row.recruiting_positions)
            }
            const inserted = await trx('teams').insert(row).returning('id')
            const newId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0]
            map[team.id] = newId
            teamsCloned++
          }

          // Clone team junctions for every freshly-cloned team
          const cloneJunction = async (table, cols) => {
            let n = 0
            for (const [oldId, newId] of Object.entries(map)) {
              const rows = await trx(table).where('teams_id', oldId)
              for (const r of rows) {
                const ins = { teams_id: newId }
                for (const c of cols) ins[c] = r[c]
                await trx(table).insert(ins)
                n++
              }
            }
            return n
          }
          const coaches = await cloneJunction('teams_coaches', ['members_id'])
          const responsibles = await cloneJunction('teams_responsibles', ['members_id'])
          const sponsors = await cloneJunction('teams_sponsors', ['sponsors_id'])

          // Clone a team-owned config table (FK column `fkCol`) old->new team.
          // Copies every column except id / audit fields / the FK, repoints the
          // FK, JSON-stringifies object columns (jsonb like fine_rules.tiers),
          // and renders pg `date` columns (returned by pg-node as a Date at
          // LOCAL midnight) back to a YYYY-MM-DD string via the local calendar
          // parts — avoids the documented pg-node date TZ-shift gotcha.
          // `restrict` optionally narrows which source rows clone.
          const pad2 = (x) => String(x).padStart(2, '0')
          const cloneTeamTable = async (table, fkCol, restrict) => {
            const OMIT_ROW = new Set(['id', 'date_created', 'date_updated', 'user_created', 'user_updated', fkCol])
            let n = 0
            for (const [oldId, newId] of Object.entries(map)) {
              let q = trx(table).where(fkCol, oldId)
              if (restrict) q = restrict(q)
              const rows = await q
              for (const r of rows) {
                const ins = { [fkCol]: Number(newId) }
                for (const [k, v] of Object.entries(r)) {
                  if (OMIT_ROW.has(k)) continue
                  if (v instanceof Date) {
                    ins[k] = `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}`
                  } else if (v != null && typeof v === 'object') {
                    ins[k] = JSON.stringify(v)
                  } else {
                    ins[k] = v
                  }
                }
                await trx(table).insert(ins)
                n++
              }
            }
            return n
          }
          // Fine catalog + per-team game-scheduling blackouts + spielplaner
          // assignments are team CONFIG, not history — they must follow the
          // active team or the new season silently starts with an empty fine
          // catalog (auto-fine engine returns null), no blackout dates, and a
          // per-team Spielplaner who loses sandbox edit access. scheduling_blocks
          // only carry forward blocks that still end in the future.
          const startIsoRoll = now.toISOString().slice(0, 10)
          const fineRules = await cloneTeamTable('fine_rules', 'team')
          const spielplanerAssignments = await cloneTeamTable('spielplaner_assignments', 'kscw_team')
          const schedulingBlocks = await cloneTeamTable('scheduling_blocks', 'team', (q) => q.where('end_date', '>=', startIsoRoll))

          // Hall-plan links MOVE to the new team (re-point), they do NOT
          // duplicate. The recurring hall_slots are shared club infrastructure
          // and must follow the active team, not stay pinned to the team we're
          // about to archive. Cloning here (the pre-fix behaviour) left every
          // slot dual-linked [archived, active] with the archived team sorting
          // first — which broke the calendar's name/sport resolution and the
          // VB/BB filter (migration 075 cleans up the rows that bug already
          // wrote). Re-point where the new team isn't already on the slot, then
          // drop any leftover old links so the archived team leaves the plan.
          let hallSlots = 0
          for (const [oldId, newId] of Object.entries(map)) {
            const moved = await trx('hall_slots_teams')
              .where('teams_id', oldId)
              .whereNotIn('hall_slots_id', trx('hall_slots_teams').select('hall_slots_id').where('teams_id', newId).whereNotNull('hall_slots_id'))
              .update({ teams_id: newId })
            hallSlots += moved
            await trx('hall_slots_teams').where('teams_id', oldId).del()
          }

          // Clone the roster (member_teams, all guest levels) for cloned teams only
          let memberTeams = 0
          const clonedOldIds = Object.keys(map).map(Number)
          if (clonedOldIds.length > 0) {
            // ⚠ Selected by TEAM only — no `season` predicate. Every row on a
            // from_season team belongs to that season by construction, so the
            // predicate could only SUBTRACT: a row written between the Jun-1
            // cutover and this rollover carries the NEW season on an OLD team,
            // so it was skipped here and then orphaned by the archive two
            // statements down. Nothing surfaced, because the dry run counted the
            // same filtered set.
            const mtRows = await trx('member_teams').whereIn('team', clonedOldIds)
            const inserts = mtRows
              .filter((r) => map[r.team])
              .map((r) => ({ member: r.member, team: map[r.team], season: toSeason, guest_level: r.guest_level, date_created: now }))
            if (inserts.length > 0) {
              await trx('member_teams').insert(inserts)
              memberTeams = inserts.length
            }
            // Report anything the clone could not carry forward, rather than
            // letting a silent delta look like a clean run.
            const skipped = mtRows.length - inserts.length
            if (skipped > 0) {
              log.warn({ msg: 'rollover: member_teams rows not carried forward', skipped, fromSeason, toSeason })
            }
          }

          // Archive the source season's teams (club-wide, all sports)
          const teamsArchived = await trx('teams')
            .where('season', fromSeason)
            .where('active', true)
            .update({ active: false })

          // Carry UPCOMING events onto the new-season teams: re-point future
          // events_teams links from each cloned old team to its new id, so
          // event-day blocking (the Terminplanung slot picker) follows the
          // active team. Past events stay on the archived team as history.
          // Skip events already linked to the new team (avoids a dup junction).
          let eventsRelinked = 0
          for (const [oldId, newId] of Object.entries(map)) {
            const updated = await trx('events_teams')
              .where('teams_id', oldId)
              .whereIn('events_id', trx('events').select('id').where('start_date', '>=', now))
              .whereNotIn('events_id', trx('events_teams').select('events_id').where('teams_id', newId).whereNotNull('events_id'))
              .update({ teams_id: newId })
            eventsRelinked += updated
          }

          // Same for OPEN team-scoped forms — re-point their forms_teams links from
          // each cloned old team to its new id so the form still reaches the
          // rolled-over roster. Draft/closed forms stay on the archived team.
          // Skip forms already linked to the new team (avoids a dup junction).
          let formsRelinked = 0
          for (const [oldId, newId] of Object.entries(map)) {
            const updated = await trx('forms_teams')
              .where('teams_id', oldId)
              .whereIn('forms_id', trx('forms').select('id').where('status', 'open'))
              .whereNotIn('forms_id', trx('forms_teams').select('forms_id').where('teams_id', newId).whereNotNull('forms_id'))
              .update({ teams_id: newId })
            formsRelinked += updated
          }

          // Carry UPCOMING trainings onto the new-season teams. The recurring
          // hall_slots already moved to the new team above, and the nightly
          // slot-cascade generates fresh trainings against whichever team owns
          // the slot — but the ~12 weeks of trainings ALREADY generated still
          // point at the old team. Without this re-point they're stranded on
          // the archived team: invisible to the rolled-over roster, so every
          // player's training list (and home-page RSVP) breaks the morning
          // after rollover (the 2026-06-01 incident — 341 trainings orphaned).
          // Re-point future trainings old->new, preserving id + hall_slot so
          // existing RSVPs/absence-declines survive and the cron's
          // hall_slot+date dedup never double-generates. Suppress
          // trg_trainings_notify (GUC, txn-local) so the bulk move is silent.
          // SYNCED games are intentionally NOT re-pointed: future fixtures
          // re-sync from Swiss Volley / Basketplan onto the active team daily
          // (kscw_team is now in their COMPARE_FIELDS so an unchanged fixture
          // re-points on the next sync). MANUAL (sandbox) games never re-sync,
          // so they ARE re-pointed below.
          let trainingsRelinked = 0
          {
            const startIso = now.toISOString().slice(0, 10)
            await trx.raw("SELECT set_config('kscw.skip_trainings_notify', 'on', true)")
            for (const [oldId, newId] of Object.entries(map)) {
              const moved = await trx('trainings')
                .where('team', oldId)
                .andWhere('date', '>=', startIso)
                .update({ team: newId })
              trainingsRelinked += moved
            }
          }

          // Carry UPCOMING manual games onto the new-season teams. Unlike synced
          // games these never re-sync, so without this they strand on the
          // archived team and vanish from the team-scoped games/home/calendar
          // views. Suppress trg_games_notify (GUC, txn-local — added in
          // migration 095) so the bulk move doesn't fan out "game updated" pushes.
          let manualGamesRelinked = 0
          {
            const startIso = now.toISOString().slice(0, 10)
            await trx.raw("SELECT set_config('kscw.skip_games_notify', 'on', true)")
            for (const [oldId, newId] of Object.entries(map)) {
              const moved = await trx('games')
                .where('kscw_team', oldId)
                .andWhere('source', 'manual')
                .andWhere('date', '>=', startIso)
                .update({ kscw_team: newId })
              manualGamesRelinked += moved
            }
          }

          // Expire pending join requests to the now-archived source teams — they
          // can't be approved into an archived team, and the member should
          // re-request the new-season team (a different id).
          const sourceTeamIds = sourceTeams.map((t) => t.id)
          const requestsExpired = await trx('team_requests')
            .whereIn('team', sourceTeamIds)
            .where('status', 'pending')
            .update({ status: 'expired' })

          // Archive the dead season's team chats. The clone INSERT already fired
          // the messaging trigger to auto-create a fresh team conversation for
          // each new team (roster auto-joined), so without this every member
          // would carry both the old (dead) and new team chat in their inbox,
          // accreting one stale chat per season. restore-season un-archives them.
          await trx.raw(
            `UPDATE conversation_members cm SET archived = true
             FROM conversations c
             WHERE cm.conversation = c.id AND c.type = 'team'
               AND c.team IN (SELECT id FROM teams WHERE season = ? AND active = false)`,
            [fromSeason],
          )

          counts = {
            from_season: fromSeason,
            to_season: toSeason,
            teams_cloned: teamsCloned,
            skipped,
            coaches,
            responsibles,
            sponsors,
            hall_slots: hallSlots,
            member_teams: memberTeams,
            fine_rules: fineRules,
            spielplaner_assignments: spielplanerAssignments,
            scheduling_blocks: schedulingBlocks,
            teams_archived: teamsArchived,
            events_relinked: eventsRelinked,
            forms_relinked: formsRelinked,
            trainings_relinked: trainingsRelinked,
            manual_games_relinked: manualGamesRelinked,
            team_requests_expired: requestsExpired,
          }

          if (dryRun) {
            const rollback = new Error('__dry_run__')
            rollback.__dryRun = true
            throw rollback
          }
        })
      } catch (err) {
        if (!err?.__dryRun) {
          if (err?.httpStatus) return res.status(err.httpStatus).json({ error: err.message })
          throw err
        }
      }

      log.info({
        msg: `rollover-season ${counts.from_season} → ${counts.to_season}${dryRun ? ' (dry-run)' : ''}`,
        ...counts,
        dry_run: dryRun,
        userId: req.accountability?.user || null,
      })
      res.json({ success: true, dry_run: dryRun, ...counts })
    } catch (err) {
      log.error({ msg: `rollover-season: ${err.message}`, endpoint: 'admin/terminplanung/rollover-season', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /kscw/terminplanung/admin/block-slot — block/unblock a slot.
  // Body: { slot_id, action: 'block' | 'unblock' }.
  router.post('/terminplanung/admin/block-slot', async (req, res) => {
    try {
      const { slot_id, action } = req.body || {}
      if (!slot_id) return res.status(400).json({ error: 'slot_id required' })
      const slot = await database('game_scheduling_slots').where('id', slot_id).first()
      if (!slot) return res.status(404).json({ error: 'Slot not found' })
      if (!(await spielplanerCanManageTeam(req, slot.kscw_team))) return res.status(403).json({ error: 'Not authorized for this team' })
      // Only available ⇄ blocked transitions — never overwrite a booked slot.
      if (slot.status !== 'available' && slot.status !== 'blocked') {
        return res.status(400).json({ error: 'Slot is booked — free it before blocking' })
      }
      await database('game_scheduling_slots').where('id', slot_id)
        .update({ status: action === 'block' ? 'blocked' : 'available' })
      await writeUserLog(database, log, { accountability: req.accountability, action: 'update', collection: 'game_scheduling_slots', recordId: slot_id, data: { kind: action === 'block' ? 'block_slot' : 'unblock_slot' } })
      res.json({ success: true })
    } catch (err) {
      log.error({ msg: `block-slot: ${err.message}`, endpoint: 'terminplanung/admin/block-slot', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // ── Club-wide blocked dates (superadmin blackout, migration 160) ─────────────
  // Blocking a date range stops HOME games for EVERY team on those days (on top of
  // the per-team scheduling_blocks). GET: planners may read (to show on the
  // calendar). POST/DELETE: superadmin only.
  const DATE_YMD_RE = /^\d{4}-\d{2}-\d{2}$/
  router.get('/terminplanung/admin/club-blocked-dates', async (req, res) => {
    try {
      // Read is open to any authenticated user — the dates are non-sensitive and
      // the scheduling calendar surfaces them so a blocked day isn't a mystery.
      // (POST/DELETE below stay superadmin-only.)
      if (!req.accountability?.user) return res.status(401).json({ error: 'Authentication required' })
      // `?sport=` narrows to what that sport actually observes: its own blocks plus the
      // club-wide ones. Omitted → every row, which is what a superadmin managing the
      // list needs to see. Migration 286.
      const wantSport = String(req.query?.sport || '').trim()
      const blocks = await database('scheduling_global_blocks')
        .modify((q) => {
          if (wantSport === 'volleyball' || wantSport === 'basketball') {
            q.where((w) => w.whereNull('sport').orWhere('sport', wantSport))
          }
        })
        .select('id', database.raw('start_date::text as start_date'), database.raw('end_date::text as end_date'),
          'reason', 'sport', database.raw('date_created::text as date_created'))
        .orderBy('start_date')
      res.json({ blocks })
    } catch (err) {
      log.error({ msg: `club-blocked-dates list: ${err.message}`, endpoint: 'terminplanung/admin/club-blocked-dates', stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  router.post('/terminplanung/admin/club-blocked-dates', async (req, res) => {
    try {
      if (!(await isSuperadmin(req))) return res.status(403).json({ error: 'Superadmin only' })
      const { start_date, end_date, reason } = req.body || {}
      if (!DATE_YMD_RE.test(String(start_date || ''))) return res.status(400).json({ error: 'start_date must be YYYY-MM-DD' })
      const end = DATE_YMD_RE.test(String(end_date || '')) ? String(end_date) : String(start_date)
      if (end < String(start_date)) return res.status(400).json({ error: 'end_date must be on/after start_date' })
      let createdBy = null
      const uid = req.accountability?.user
      if (uid) { const mm = await database('members').where('user', uid).first('id'); createdBy = mm?.id || null }
      // Migration 286: optional sport. Anything not exactly 'volleyball'/'basketball'
      // — including absent, empty and junk — falls back to NULL = club-wide. Defaulting
      // WIDE is the safe direction: an unscoped block keeps blocking everyone until
      // someone narrows it deliberately, whereas defaulting to one sport would silently
      // stop blocking the other.
      const rawSport = String(req.body?.sport || '').trim()
      const sport = rawSport === 'volleyball' || rawSport === 'basketball' ? rawSport : null
      const ins = await database('scheduling_global_blocks')
        .insert({ start_date, end_date: end, reason: reason ? String(reason).slice(0, 500) : null, sport, created_by: createdBy })
        .returning('id')
      const id = ins[0]?.id ?? ins[0]
      await writeUserLog(database, log, { accountability: req.accountability, action: 'create', collection: 'scheduling_global_blocks', recordId: id, data: { kind: 'club_block_create', start_date, end_date: end, reason: reason || null, sport } })
      res.json({ id, start_date, end_date: end, reason: reason || null, sport })
    } catch (err) {
      log.error({ msg: `club-blocked-dates create: ${err.message}`, endpoint: 'terminplanung/admin/club-blocked-dates', stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  router.delete('/terminplanung/admin/club-blocked-dates/:id', async (req, res) => {
    try {
      if (!(await isSuperadmin(req))) return res.status(403).json({ error: 'Superadmin only' })
      const id = Number(req.params.id)
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' })
      const n = await database('scheduling_global_blocks').where('id', id).del()
      if (!n) return res.status(404).json({ error: 'Not found' })
      await writeUserLog(database, log, { accountability: req.accountability, action: 'delete', collection: 'scheduling_global_blocks', recordId: id, data: { kind: 'club_block_delete' } })
      res.json({ success: true })
    } catch (err) {
      log.error({ msg: `club-blocked-dates delete: ${err.message}`, endpoint: 'terminplanung/admin/club-blocked-dates', stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /kscw/admin/terminplanung/svrz-sync — manual trigger for bulk SVRZ sync
  // Spawns the sync script detached; the HTTP caller returns immediately.
  // Child stdout + stderr are piped to /directus/logs/svrz-sync.log so failures
  // in the detached run leave a trail. The daily cron path uses execSync and
  // already emits to Sentry via logCronError on non-zero exit.
  router.post('/admin/terminplanung/svrz-sync', async (req, res) => {
    if (!(await isAdminOrSpielplaner(req))) return res.status(403).json({ error: 'Admin only' })
    try {
      const { season_uuid, season_name } = req.body || {}
      // The spielplanung app authenticates via the .kscw.ch session cookie
      // (cookie-session SSO) — there is NO Authorization: Bearer header to
      // forward. svrz-scheduling-sync.mjs requires a real bearer token
      // (DIRECTUS_TOKEN, no email/password fallback), so mint a short-lived one
      // from the sync service account here — same source the cron and the
      // sibling /admin/svrz-sync route use. Never run the child on the caller's
      // own token.
      const syncEmail = process.env.DIRECTUS_SYNC_EMAIL
      const syncPassword = process.env.DIRECTUS_SYNC_PASSWORD
      if (!syncEmail || !syncPassword) return res.status(503).json({ error: 'Sync credentials not configured' })
      let token = null
      try {
        const r = await fetch('http://127.0.0.1:8055/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: syncEmail, password: syncPassword }),
        })
        if (r.ok) { const { data } = await r.json(); token = data?.access_token || null }
      } catch { /* token stays null → 502 below */ }
      if (!token) return res.status(502).json({ error: 'Could not mint sync token' })

      // Derive defaults from the current date (Jun 1 cutover — Swiss Volley
      // publishes new-season fixtures in June). Look up the matching SVRZ UUID
      // from the most recent sync for that season; fall back to the 2025/26 UUID.
      const now = new Date()
      const startYear = seasonStartYear(now)
      const defaultSeasonName = `${startYear}/${startYear + 1}`
      const known = await database('svrz_spielplaner_contacts')
        .where('season_name', defaultSeasonName).whereNotNull('season_uuid').first()
      const defaultSeasonUuid = known?.season_uuid || 'dcafddfe-8139-4e02-baad-d3f88ec00cd0'

      if (svrzManualSyncRunning) {
        return res.status(409).json({ status: 'skipped', reason: 'already-running' })
      }
      // Same shared Volleymanager account as the crons and the admin sync buttons.
      const releaseVm = claimVmAccount('terminplanung:svrz-sync')
      if (!releaseVm) {
        return res.status(409).json({ status: 'skipped', reason: 'already-running', holder: vmAccountHeldBy() })
      }

      const { spawn } = await import('node:child_process')
      // Pipe child stdout + stderr to a persistent log so the run leaves a
      // trail when it fails. Without this, stdio: 'ignore' would silently
      // swallow all output and we'd never know why a sync failed.
      const { openSync } = await import('node:fs')
      let logOut, logErr
      try {
        logOut = openSync('/directus/logs/svrz-sync.log', 'a')
        logErr = openSync('/directus/logs/svrz-sync.log', 'a')
      } catch {
        logOut = 'ignore'; logErr = 'ignore'
      }
      // Scoped env — do NOT spread process.env; forward only the secrets the child needs
      const env = {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        VM_USERNAME: process.env.VM_USERNAME,
        VM_PASSWORD: process.env.VM_PASSWORD,
        DIRECTUS_URL: 'http://127.0.0.1:8055',
        DIRECTUS_TOKEN: token,
        SVRZ_SEASON_UUID: season_uuid || defaultSeasonUuid,
        SVRZ_SEASON_NAME: season_name || defaultSeasonName,
      }
      // Managed (non-detached) spawn: respond 202 immediately, but keep a close
      // listener so the run records a sync_runs heartbeat on completion — the
      // same 'svrz_sync' source the daily cron and /admin/svrz-sync write. That
      // heartbeat is what the admin "Sync now" UI polls for live progress
      // (running → ✓/✗). A SIGKILL watchdog bounds a hung run at 15 min.
      const startedAt = Date.now()
      let settled = false
      svrzManualSyncRunning = true
      const child = spawn('node', ['/directus/scripts/svrz-scheduling-sync.mjs'], {
        env,
        stdio: ['ignore', logOut, logErr],
      })
      const watchdog = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, 900_000)
      const settle = async (status, errorMessage) => {
        if (settled) return
        settled = true
        clearTimeout(watchdog)
        svrzManualSyncRunning = false
        releaseVm()
        await logCronRun(database, 'svrz_sync', { status, durationMs: Date.now() - startedAt, errorMessage: errorMessage || null }).catch(() => {})
      }
      child.on('error', (err) => {
        log.error({ msg: `svrz-sync spawn error: ${err.message}`, endpoint: 'admin/terminplanung/svrz-sync' })
        settle('error', err.message)
      })
      child.on('close', (code) => {
        if (code === 0) settle('ok')
        // Exit 75 = deferred (VM temporarily unavailable, transient) — not a failure.
        else if (code === 75) settle('ok', 'deferred: VM temporarily unavailable')
        else settle('error', `exited ${code}`)
      })
      log.info({ msg: `svrz-sync spawned`, pid: child.pid, userId: req.accountability?.user })
      res.status(202).json({ status: 'started', pid: child.pid })
    } catch (err) {
      log.error({ msg: `svrz-sync: ${err.message}`, endpoint: 'admin/terminplanung/svrz-sync', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Admin invites (per-verein tokenized links, auto-populated from SVRZ)
  // ─────────────────────────────────────────────────────────────────────────

  // Invite links stay valid until the season's scheduling deadline (30.06 of the
  // season's END year), not a rolling TTL — every opponent works to the same
  // VolleyManager cutoff, derived per-season so links never mint born-expired.
  const ACTIVE_INVITE_STATUSES = ['invited', 'viewed', 'booked', 'active']
  const KSCW_SVRZ_CLUB_ID = process.env.KSCW_SVRZ_CLUB_ID || '912530'

  // ─── Cup fixtures never enter Terminplanung ────────────────────────────────
  // The tool negotiates the SEASON schedule with a fixed set of league opponents.
  // Cup rounds (national "Mobiliar Volley Cup", regional "Züri Cup") are drawn
  // late, dated by the association / the drawn home club, and settled straight in
  // VolleyManager — there is nothing to negotiate, and a cup pairing is a SINGLE
  // fixture, so letting one in also produced a phantom second leg on the empty
  // side of the card (2026-08-04: D1 "Appenzeller Bären 1" showed 2 games for one
  // Cup R1 tie, plus an auto-minted invite).
  // ⚠ `league_short` CANNOT detect this — it holds the *team's* league category
  // ("2L"), so a cup tie is indistinguishable from a league game there. The
  // competition name only lives in `league_name` ("#7244 | Mobiliar Volley Cup |
  // ♀"), matched with the same wide net as sv-sync's CUP_RE / the frontend's
  // detectCupMatch(). Cup games still reach the member calendar via sv-sync
  // (`/indoor/games?includeCup=true`) — this filter is scheduling-only.
  // `!~*` is NULL-propagating, so a fixture with no league label would be dropped
  // silently — spell the NULL case out and keep it.
  const excludeCupFixtures = (q) => q.whereRaw("(league_name is null or league_name !~* '(cup|pokal|coupe|coppa)')")

  // ─── Stable team-ID matching (VM is the source of truth for names) ──────────
  // SVRZ fixture labels ("KSC Wiedikon DU23-1") can lag VM's renames: when a
  // junior team changes Stärkeklasse it becomes e.g. DU23-2 in VM (which owns
  // teams.name) before the SVRZ feed catches up. Matching our team to its
  // fixtures by NAME then silently breaks (0 opponents). But VM and SVRZ key the
  // team by the SAME stable `staticTeamIdentifier`, which we already store as
  // `teams.team_id` ("vb_2301"). Match on that id so VM can own the display name
  // without breaking fixture resolution. Falls back to the name label when a
  // fixture's raw payload lacks the id (older rows / non-SVRZ data).
  const staticIdFromTeamId = (teamId) => {
    const m = String(teamId || '').match(/(\d+)\s*$/)
    return m ? Number(m[1]) : null
  }
  // staticTeamIdentifier on a given side ('home'|'away') of an svrz_games row,
  // read from the stored raw payload; null if absent/unparseable.
  const sideStaticId = (g, side) => {
    let raw = g && g.raw
    if (typeof raw === 'string') { try { raw = JSON.parse(raw) } catch { return null } }
    const enc = raw && raw.encounter
    const team = enc && (side === 'home' ? enc.teamHome : enc.teamAway)
    const v = team && team.staticTeamIdentifier
    return v == null ? null : Number(v)
  }
  // staticTeamIdentifier of the KSCW side of a fixture (home/away decided by which
  // side carries our club id), or null if raw lacks it.
  const kscwSideStaticId = (g) =>
    sideStaticId(g, String(g.home_club_id) === String(KSCW_SVRZ_CLUB_ID) ? 'home' : 'away')

  // ── Multi-game per opponent: bookings are keyed per SVRZ fixture ──────────
  // A pairing can be played 2-3× per season (junior triple round-robin), so a
  // booking carries `svrz_game_id` (= svrz_games.svrz_persistence_id). This
  // resolves an opponent row to its season fixtures: KSCW club one side + the
  // opponent's team_name the other, scoped to the season's start year +
  // open/waitingForApproval, and the KSCW side must be THIS kscw_team
  // (static-id match, name fallback) — otherwise a club facing two KSCW teams
  // in one group (H1 & H3 in 2L) would leak the other team's fixtures into
  // this opponent's page. Deterministic order (starting_date_time, then id):
  // the FIRST fixture of a side also "owns" legacy bookings whose
  // svrz_game_id is NULL (pre-migration-105 rows / non-SVRZ opponents).
  async function opponentSvrzFixtures(opponent) {
    if (!opponent || !opponent.team_name) return []
    const seasonRow = opponent.season
      ? await database('game_scheduling_seasons').where('id', opponent.season).first('season')
      : null
    const svrzSeasonName = String(seasonRow?.season || '').split('/')[0].trim()
    const team = await database('teams').where('id', opponent.kscw_team).first('id', 'name', 'team_id')
    const ourStaticId = staticIdFromTeamId(team?.team_id)
    const wantName = `ksc wiedikon ${String(team?.name || '').trim().toLowerCase()}`

    // Base query: this season's still-schedulable fixtures in deterministic order
    // (the FIRST fixture of a side also "owns" legacy NULL-svrz_game_id bookings).
    const baseQuery = () => database('svrz_games')
      .whereIn('status', ['open', 'waitingForApproval'])
      .modify(excludeCupFixtures)
      .modify((q) => { if (svrzSeasonName) q.where('season_name', svrzSeasonName) })
      .orderBy([
        { column: 'starting_date_time', order: 'asc' },
        { column: 'svrz_persistence_id', order: 'asc' },
      ])

    // Keep only fixtures of THIS kscw_team: pin our side by the stable
    // staticTeamIdentifier (VM owns the display name, so name-matching our own
    // side is unreliable); fall back to the name label for rows lacking the id.
    const keepOurs = (rows) => rows.filter((g) => {
      const sid = kscwSideStaticId(g)
      if (sid != null && ourStaticId != null) return sid === ourStaticId
      const isHomeKscw = String(g.home_club_id) === String(KSCW_SVRZ_CLUB_ID)
      return String((isHomeKscw ? g.home_team_name : g.away_team_name) || '').trim().toLowerCase() === wantName
    })
    const shape = (rows) => rows.map((g) => ({
      id: g.svrz_persistence_id,
      number: g.svrz_number ?? null,
      display_name: g.display_name,
      starting_date_time: g.starting_date_time,
      is_home_kscw: String(g.home_club_id) === String(KSCW_SVRZ_CLUB_ID),
      league: g.league_short,
      status: g.status,
    }))

    // Fast path: opponent side matches the stored team_name exactly (the common
    // case, kept verbatim so already-correct opponents never change behaviour).
    const exact = keepOurs(await baseQuery().where(function () {
      this.where(function () {
        this.where('home_club_id', KSCW_SVRZ_CLUB_ID).where('away_team_name', opponent.team_name)
      }).orWhere(function () {
        this.where('away_club_id', KSCW_SVRZ_CLUB_ID).where('home_team_name', opponent.team_name)
      })
    }))
    if (exact.length) return shape(exact)

    // Robustness fallback: VM appends a team designation to the opponent name for
    // multi-round groups ("VBC Limmattal" → "VBC Limmattal HU23-1"), which the
    // exact match above silently drops → 0 fixtures → the tool falls back to a
    // single home/away game and loses the extra fixtures (surfaced 2026-06-24 for
    // Limmattal HU23, a Dreifachrunde with 2 home games). Re-fetch this team's
    // season fixtures (KSCW on either side) and match the opponent by a
    // suffix-tolerant, word-boundary name compare. keepOurs() already pins our
    // side to THIS team via static id, so a loose opponent compare cannot leak
    // another KSCW team's opponent in — it only re-attaches fixtures of the same
    // opponent club whose VM label gained/lost a trailing designation.
    const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')
    const want = norm(opponent.team_name)
    if (!want) return []
    const ours = keepOurs(await baseQuery().where(function () {
      this.where('home_club_id', KSCW_SVRZ_CLUB_ID).orWhere('away_club_id', KSCW_SVRZ_CLUB_ID)
    }))
    const oppName = (g) => (String(g.home_club_id) === String(KSCW_SVRZ_CLUB_ID) ? g.away_team_name : g.home_team_name)
    const matched = ours.filter((g) => {
      const o = norm(oppName(g))
      // Equal, or one is the other plus a trailing " <designation>" (the space
      // boundary stops "VBC Limmattal" matching e.g. "VBC Limmattaler …").
      return o === want || o.startsWith(`${want} `) || want.startsWith(`${o} `)
    })
    return shape(matched)
  }

  // Resolve + validate the fixture a proposal/booking targets on one side
  // (home/away). `requestedId` comes from the request body; absent → the first
  // fixture of that side (matches the legacy single-game clients). Returns
  // { fixtureId, isFirst } — fixtureId null when the opponent has no synced
  // fixtures at all (non-SVRZ flow: bookings keep svrz_game_id NULL) — or null
  // when the requested id isn't one of this opponent's fixtures on that side.
  const resolveTargetFixture = (fixtures, isHome, requestedId) => {
    const side = fixtures.filter((f) => f.is_home_kscw === isHome)
    if (side.length === 0) return requestedId ? null : { fixtureId: null, isFirst: true }
    if (!requestedId) return { fixtureId: side[0].id, isFirst: true }
    const idx = side.findIndex((f) => String(f.id) === String(requestedId))
    if (idx === -1) return null
    return { fixtureId: side[idx].id, isFirst: idx === 0 }
  }

  // Does a booking row belong to the target fixture? Exact svrz_game_id match;
  // a NULL (legacy) row belongs to the FIRST fixture of its side.
  const bookingMatchesFixture = (b, target) => {
    if (!target) return false
    if (target.fixtureId == null) return b.svrz_game_id == null
    if (String(b.svrz_game_id || '') === String(target.fixtureId)) return true
    return target.isFirst && b.svrz_game_id == null
  }

  // SQL flavour of bookingMatchesFixture for scoped UPDATE/DELETE.
  const scopeToFixture = (q, target) => {
    if (target.fixtureId == null) return q.whereNull('svrz_game_id')
    if (target.isFirst) {
      return q.where(function () {
        this.where('svrz_game_id', String(target.fixtureId)).orWhereNull('svrz_game_id')
      })
    }
    return q.where('svrz_game_id', String(target.fixtureId))
  }

  // Expiry = 30.06 of the season's END year, parsed from a "YYYY/YY" season
  // string (e.g. "2026/27" → 2027-06-30T23:59:59Z; end year = start + 1). If the
  // season string is missing/unparseable, fall back to now + 1 year so a link is
  // never born already expired.
  function newInviteExpiry(seasonStr) {
    const m = String(seasonStr || '').match(/(\d{4})/)
    if (m) {
      const endYear = Number(m[1]) + 1
      return new Date(`${endYear}-06-30T23:59:59.000Z`).toISOString()
    }
    const d = new Date()
    d.setUTCFullYear(d.getUTCFullYear() + 1)
    return d.toISOString()
  }

  // GET /admin/terminplanung/svrz-available-seasons — list seasons seen in synced data
  router.get('/admin/terminplanung/svrz-available-seasons', async (req, res) => {
    if (!(await isAdminOrSpielplaner(req))) return res.status(403).json({ error: 'Admin only' })
    try {
      const rows = await database('svrz_spielplaner_contacts')
        .distinct('season_uuid', 'season_name')
        .whereNotNull('season_uuid')
        .orderBy('season_name', 'desc')
      res.json({ data: rows.map((r) => ({ uuid: r.season_uuid, name: r.season_name })) })
    } catch (err) {
      log.error({ msg: `svrz-available-seasons: ${err.message}`, endpoint: 'admin/terminplanung/svrz-available-seasons', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // GET /admin/terminplanung/svrz-status?season_name= — at-a-glance summary of the
  // synced SVRZ feed for a season: last sync time + game counts (total / KSCW home
  // / KSCW away). Shown next to "Sync SVRZ now".
  router.get('/admin/terminplanung/svrz-status', async (req, res) => {
    if (!(await isAdminOrSpielplaner(req))) return res.status(403).json({ error: 'Admin only' })
    try {
      const seasonName = String(req.query.season_name || '').split('/')[0].trim()
      const row = await database('svrz_games')
        .modify((q) => { if (seasonName) q.where('season_name', seasonName) })
        .select(
          database.raw('count(*)::int as total'),
          database.raw('count(*) FILTER (WHERE home_club_id = ?)::int as home', [KSCW_SVRZ_CLUB_ID]),
          database.raw('count(*) FILTER (WHERE away_club_id = ?)::int as away', [KSCW_SVRZ_CLUB_ID]),
          database.raw('max(last_synced_at) as last_synced_at'),
        )
        .first()
      res.json({
        total: Number(row?.total) || 0,
        home: Number(row?.home) || 0,
        away: Number(row?.away) || 0,
        last_synced_at: row?.last_synced_at || null,
      })
    } catch (err) {
      log.error({ msg: `svrz-status: ${err.message}`, endpoint: 'admin/terminplanung/svrz-status', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /admin/terminplanung/invites — create tokenized invites
  router.post('/admin/terminplanung/invites', async (req, res) => {
    try {
      const { kscw_team, season, rows } = req.body || {}
      if (!kscw_team || !season || !Array.isArray(rows)) {
        return res.status(400).json({ error: 'kscw_team, season, rows[] required' })
      }
      if (!(await spielplanerCanManageTeam(req, kscw_team))) return res.status(403).json({ error: 'Not authorized for this team' })
      const seasonRow = await database('game_scheduling_seasons').where('id', season).first()
      const created = []
      const existing = []
      // ⚠ Concurrency: the dedupe below is a name-keyed SELECT-then-INSERT and
      // game_scheduling_opponents carries no uniqueness on (kscw_team, season,
      // team_name). Two callers for the same team+season — this endpoint racing the
      // panel's auto-populate (ensure-from-svrz), or two spielplaner at season-open —
      // both miss and both insert, so /invites/send mails the opponent club two
      // different links and whichever they use leaves the twin at "not answered".
      // Serialize per kscw_team on an advisory lock and do the check + insert inside
      // one transaction; two DIFFERENT teams never block each other. Transaction-
      // scoped, so a crashed request releases the lock with its connection.
      const inviteLockKey = Number.isInteger(Number(kscw_team)) ? Number(kscw_team) : 0
      await database.transaction(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(?, ?)', [GSCH_INVITE_LOCK_CLASS, inviteLockKey])
        for (const r of rows) {
          const email = (r.contact_email || '').toLowerCase().trim()
          if (!email || !r.team_name) continue
          // Dedupe by opponent TEAM NAME, not by exact contact_email. The resolved
          // contact set legitimately changes over time (e.g. team responsibles got
          // merged in alongside the club calendar responsible) — an email-string
          // match then misses the existing invite and spawns a phantom duplicate
          // (8 such rows accreted on DU23-1 after the 2026-06-15 contacts merge).
          // One opponent team = one invite row per kscw_team+season; refresh its
          // contacts in place instead of inserting a clone.
          const existingRow = await trx('game_scheduling_opponents')
            .where({ kscw_team, season })
            .whereIn('status', ACTIVE_INVITE_STATUSES)
            .whereRaw('lower(trim(team_name)) = ?', [String(r.team_name).trim().toLowerCase()])
            .first()
          if (existingRow) {
            // Never blank contacts; only refresh when the new set is non-empty and
            // differs (keeps the richer merged list flowing onto the live invite).
            const patch = {}
            if (email && (existingRow.contact_email || '').toLowerCase().trim() !== email) patch.contact_email = email
            if (r.contact_name && existingRow.contact_name !== r.contact_name) patch.contact_name = r.contact_name
            if (Object.keys(patch).length) await trx('game_scheduling_opponents').where('id', existingRow.id).update(patch)
            existing.push({ id: existingRow.id, token: existingRow.token, email, team_name: existingRow.team_name })
            continue
          }
          const token = crypto.randomBytes(16).toString('hex')
          const expiresAt = newInviteExpiry(seasonRow?.season)
          const inserted = await trx('game_scheduling_opponents').insert({
            kscw_team, season, team_name: r.team_name, contact_email: email,
            contact_name: r.contact_name || '', token, status: 'invited',
            source: r.source || 'manual', created_by_admin: true, expires_at: expiresAt,
            club_id: r.club_id || null,
          }).returning(['id'])
          const newId = Array.isArray(inserted) ? (inserted[0]?.id ?? inserted[0]) : inserted
          created.push({ id: newId, token, email, team_name: r.team_name })
        }
      })
      res.json({ created: created.length, existing: existing.length, rows: [...created, ...existing] })
    } catch (err) {
      log.error({ msg: `invites create: ${err.message}`, endpoint: 'admin/terminplanung/invites', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // GET /admin/terminplanung/invites?kscw_team=&season= — list invites
  router.get('/admin/terminplanung/invites', async (req, res) => {
    try {
      const { kscw_team, season } = req.query
      if (!kscw_team) return res.status(400).json({ error: 'kscw_team required' })
      if (!(await spielplanerCanManageTeam(req, kscw_team))) return res.status(403).json({ error: 'Not authorized for this team' })
      const q = database('game_scheduling_opponents').where('kscw_team', kscw_team)
      if (season) q.where('season', season)
      const invites = await q.orderBy('date_created', 'desc')
      res.json({ data: invites })
    } catch (err) {
      log.error({ msg: `invites list: ${err.message}`, endpoint: 'admin/terminplanung/invites', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /admin/terminplanung/invites/:id/reissue — new token + reset lifecycle
  router.post('/admin/terminplanung/invites/:id/reissue', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10)
      if (!id) return res.status(400).json({ error: 'invalid id' })
      const opp = await database('game_scheduling_opponents').where('id', id).first()
      if (!opp) return res.status(404).json({ error: 'not found' })
      if (!(await spielplanerCanManageTeam(req, opp.kscw_team))) return res.status(403).json({ error: 'Not authorized for this team' })
      const seasonRow = opp.season ? await database('game_scheduling_seasons').where('id', opp.season).first() : null
      const token = crypto.randomBytes(16).toString('hex')
      const expiresAt = newInviteExpiry(seasonRow?.season)
      await database('game_scheduling_opponents')
        .where('id', id)
        .update({ token, status: 'invited', first_viewed_at: null, expires_at: expiresAt })
      res.json({ success: true, expires_at: expiresAt })
    } catch (err) {
      log.error({ msg: `invites reissue: ${err.message}`, endpoint: 'admin/terminplanung/invites/:id/reissue', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /admin/terminplanung/invites/:id/revoke — disable token
  router.post('/admin/terminplanung/invites/:id/revoke', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10)
      if (!id) return res.status(400).json({ error: 'invalid id' })
      const opp = await database('game_scheduling_opponents').where('id', id).first()
      if (!opp) return res.status(404).json({ error: 'not found' })
      if (!(await spielplanerCanManageTeam(req, opp.kscw_team))) return res.status(403).json({ error: 'Not authorized for this team' })
      await database('game_scheduling_opponents')
        .where('id', id).update({ status: 'revoked' })
      // Clean up the revoked opponent's still-pending proposals so they don't
      // linger as ghost slots on the calendar (confirmed bookings are kept).
      await database('game_scheduling_bookings')
        .where('opponent', id).where('status', 'pending').del()
      res.json({ success: true })
    } catch (err) {
      log.error({ msg: `invites revoke: ${err.message}`, endpoint: 'admin/terminplanung/invites/:id/revoke', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /admin/terminplanung/invites/:id/mark-sent — flag that the invite email
  // was sent outside the bulk flow (the per-card "Draft email" mailto opens the
  // admin's mail client, which the app can't observe). Stamps email_sent_at so
  // the list flips from "Not sent" to "Invited". Idempotent; never touches the
  // lifecycle status.
  router.post('/admin/terminplanung/invites/:id/mark-sent', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10)
      if (!id) return res.status(400).json({ error: 'invalid id' })
      const opp = await database('game_scheduling_opponents').where('id', id).first()
      if (!opp) return res.status(404).json({ error: 'not found' })
      if (!(await spielplanerCanManageTeam(req, opp.kscw_team))) return res.status(403).json({ error: 'Not authorized for this team' })
      await database('game_scheduling_opponents')
        .where('id', id).update({ email_sent_at: new Date().toISOString() })
      res.json({ success: true })
    } catch (err) {
      log.error({ msg: `invites mark-sent: ${err.message}`, endpoint: 'admin/terminplanung/invites/:id/mark-sent', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /admin/terminplanung/invites/send — bulk-send (or preview) invite emails
  // for a team. Body: { ids:number[], dry_run?:bool, season_name, kscw_team_name,
  // kscw_league }. dry_run=true renders the emails WITHOUT sending, so the admin's
  // preview is byte-identical to what goes out. Emails are bilingual DE+EN (the
  // club hasn't picked a language yet) and go from the spielplanung identity;
  // contact_email may hold several addresses (parseRecipients splits them). The
  // invite link base is the env-aware FRONTEND_URL, not a client value.
  router.post('/admin/terminplanung/invites/send', async (req, res) => {
    try {
      const { ids, dry_run, season_name = '', kscw_team_name = '', kscw_league = '', contacts_group = 'all' } = req.body || {}
      if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids[] required' })
      // Which contacts to email: 'all' (union, default), 'calendar' (club
      // Spielplanverantwortliche) or 'team' (the opponent team's responsibles).
      // Falls back to the union when a row has no split stored yet (legacy rows
      // not re-synced) so a chosen group never silently sends to nobody.
      const recipientsFor = (row) => {
        if (contacts_group === 'calendar') return row.calendar_contact_email || row.contact_email || ''
        if (contacts_group === 'team') return row.team_contact_email || row.contact_email || ''
        return row.contact_email || ''
      }
      const rows = await database('game_scheduling_opponents')
        .whereIn('id', ids)
        .whereNotIn('status', ['revoked', 'expired'])
      // Authorise against every distinct team the selected invites belong to —
      // a scoped scheduler may only send for their own team(s).
      const sendTeamIds = [...new Set(rows.map((r) => r.kscw_team))]
      for (const tId of sendTeamIds) {
        if (!(await spielplanerCanManageTeam(req, tId))) return res.status(403).json({ error: 'Not authorized for this team' })
      }
      const fmtDate = (ts) => {
        if (!ts) return ''
        const d = new Date(ts)
        if (isNaN(d.getTime())) return ''
        const p = (n) => String(n).padStart(2, '0')
        return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`
      }
      // Resolve each opponent's KSCW team name from the DB so the per-opponent
      // subject ("Spielplanung - KSCW <team> / <opponent>") is correct even when
      // the batch spans multiple teams — the body param is only a fallback.
      const teamNameById = new Map()
      for (const tr of await database('teams').whereIn('id', [...new Set(rows.map((r) => r.kscw_team))]).select('id', 'name')) {
        teamNameById.set(tr.id, tr.name)
      }
      const previews = []
      const failed = []
      let sent = 0
      for (const row of rows) {
        const url = `${SCHEDULING_URL}/terminplanung/${row.token}`
        const { subject, text, html } = inviteEmail({
          contact: row.contact_name || '',
          kscw: teamNameById.get(row.kscw_team) || kscw_team_name,
          opponent: row.team_name || '',
          league: kscw_league,
          season: season_name,
          url,
          expires: fmtDate(row.expires_at),
        })
        const toAddrs = recipientsFor(row)
        previews.push({ id: row.id, to: toAddrs, team_name: row.team_name, subject, html, text })
        if (!dry_run) {
          // Skip rows with no valid (sanitised) recipient — count as failed, don't
          // stamp them as sent.
          const recipients = parseRecipients(toAddrs)
          if (!recipients || (Array.isArray(recipients) && recipients.length === 0)) {
            failed.push({ id: row.id, error: 'no valid recipient' })
            continue
          }
          try {
            // CC the club's scheduling mailbox so the spielplaner has a copy of
            // every invite that went out.
            await sendSchedulingMail(toAddrs, subject, text, SCHEDULING_REPLY_TO, html)
            // Stamp the send so the list shows "Invited" (vs "Not sent") — never
            // touches the lifecycle status (a reminder to a viewed/booked row
            // keeps that status).
            await database('game_scheduling_opponents')
              .where('id', row.id)
              .update({ email_sent_at: new Date().toISOString() })
            sent++
          } catch (e) {
            failed.push({ id: row.id, error: e.message })
          }
        }
      }
      res.json({ previews, sent, failed, dry_run: !!dry_run })
    } catch (err) {
      log.error({ msg: `invites send: ${err.message}`, endpoint: 'admin/terminplanung/invites/send', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /admin/terminplanung/invites/remind — send a REMINDER invite to every
  // opponent of a season (optionally one team) that still has an unscheduled
  // home OR away game. The incomplete set is computed server-side with the same
  // rule as finalize-notify's "Noch offen": per opponent, confirmed bookings per
  // side vs the synced SVRZ fixture count (1+1 fallback when un-synced). Reuses
  // the invite email with an added "ignore if you're already set" line. Body:
  // { season_id, team_id?, dry_run? }. dry_run renders previews (with the missing
  // home/away count per opponent) WITHOUT sending. Stamps reminder_sent_at.
  // Fully-scheduled opponents (e.g. all legs booked) are skipped — no email.
  router.post('/admin/terminplanung/invites/remind', async (req, res) => {
    try {
      const { season_id, team_id = null, dry_run } = req.body || {}
      if (!season_id) return res.status(400).json({ error: 'season_id required' })
      const seasonRow = await database('game_scheduling_seasons').where('id', season_id).first()
      if (!seasonRow) return res.status(404).json({ error: 'season not found' })

      let oppQuery = database('game_scheduling_opponents')
        .where('season', season_id).whereNotIn('status', ['revoked', 'expired'])
      if (team_id) oppQuery = oppQuery.where('kscw_team', team_id)
      const allOpps = await oppQuery.select('*')

      // Keep only opponents whose KSCW team the caller may manage (a full admin /
      // unrestricted spielplaner keeps all; a scoped one keeps their teams).
      const allTeamIds = [...new Set(allOpps.map((o) => o.kscw_team))]
      const manageable = new Set()
      for (const tId of allTeamIds) { if (await spielplanerCanManageTeam(req, tId)) manageable.add(tId) }
      if (manageable.size === 0) return res.status(403).json({ error: 'Not authorized for any team in scope' })
      const opps = allOpps.filter((o) => manageable.has(o.kscw_team))
      const teamNameById = new Map()
      for (const tr of await database('teams').whereIn('id', [...manageable]).select('id', 'name')) teamNameById.set(tr.id, tr.name)

      // Confirmed bookings per opponent + side (mirrors finalize-notify counts).
      const homeConf = new Map(); const awayConf = new Map()
      const confRows = await database('game_scheduling_bookings as b')
        .join('game_scheduling_opponents as o', 'o.id', 'b.opponent')
        .where('o.season', season_id).where('b.status', 'confirmed')
        .modify((q) => { if (team_id) q.where('o.kscw_team', team_id) })
        .groupBy('b.opponent', 'b.type')
        .select('b.opponent', 'b.type', database.raw('count(*) as c'))
      for (const r of confRows) {
        if (r.type === 'home_slot_pick') homeConf.set(r.opponent, Number(r.c))
        else if (r.type === 'away_proposal') awayConf.set(r.opponent, Number(r.c))
      }
      const fmtDate = (ts) => {
        if (!ts) return ''
        const d = new Date(ts); if (isNaN(d.getTime())) return ''
        const p = (n) => String(n).padStart(2, '0')
        return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`
      }
      // Resolve each opponent's team responsibles so reminders reach them too
      // (not just the saved Spielplan contact in contact_email).
      const contactsMap = await opponentContactsBySeason(seasonRow, manageable)

      const previews = []; const failed = []
      let sent = 0; let skipped_complete = 0; let skipped_no_email = 0
      for (const o of opps) {
        const fixtures = await opponentSvrzFixtures(o)
        const homeTotal = fixtures.length ? fixtures.filter((f) => f.is_home_kscw).length : 1
        const awayTotal = fixtures.length ? fixtures.filter((f) => !f.is_home_kscw).length : 1
        const homeMiss = Math.max(0, homeTotal - (homeConf.get(o.id) || 0))
        const awayMiss = Math.max(0, awayTotal - (awayConf.get(o.id) || 0))
        if (homeMiss === 0 && awayMiss === 0) { skipped_complete++; continue } // fully scheduled — never remind
        const url = `${SCHEDULING_URL}/terminplanung/${o.token}`
        const { subject, text, html } = inviteEmail({
          kscw: teamNameById.get(o.kscw_team) || '',
          opponent: o.team_name || '',
          season: seasonRow.season || '',
          url,
          expires: fmtDate(o.expires_at),
          reminder: true,
        })
        // Recipients = the opponent TEAM's own responsibles when we have them,
        // else fall back to the saved Spielplan contact(s). Mirrors the send-invite
        // 'team' default: a club that registers one big club-wide Spielplan list
        // (e.g. Volley Uster's 25) must not have every team's reminder blast all of
        // them — only that team's people. Falls back so clubs with no per-team
        // responsibles still get reached.
        const trEmails = (contactsMap.get(o.id)?.team_responsibles || []).map((c) => c.email).filter(Boolean)
        const toCombined = (trEmails.length ? trEmails : [o.contact_email || '']).filter(Boolean).join(', ')
        previews.push({ id: o.id, to: toCombined, team_name: o.team_name, kscw: teamNameById.get(o.kscw_team) || '', team_responsibles: trEmails.join(', '), missing: { home: homeMiss, away: awayMiss }, subject, html, text })
        if (!dry_run) {
          const recipients = parseRecipients(toCombined)
          if (!recipients || (Array.isArray(recipients) && recipients.length === 0)) {
            skipped_no_email++; failed.push({ id: o.id, error: 'no valid recipient' }); continue
          }
          try {
            await sendSchedulingMail(toCombined, subject, text, SCHEDULING_REPLY_TO, html)
            await database('game_scheduling_opponents').where('id', o.id).update({ reminder_sent_at: new Date().toISOString() })
            sent++
          } catch (e) {
            failed.push({ id: o.id, error: e.message })
          }
        }
      }
      res.json({ previews, sent, failed, skipped_complete, skipped_no_email, dry_run: !!dry_run })
    } catch (err) {
      log.error({ msg: `invites remind: ${err.message}`, endpoint: 'admin/terminplanung/invites/remind', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // GET /admin/terminplanung/invites/import-from-svrz?kscw_team=&season= — preview
  // Lists opponent clubs from synced svrz_games plus per-game Spielplanverantwortlicher
  // contacts, with fallback to the bulk svrz_spielplaner_contacts feed.
  router.get('/admin/terminplanung/invites/import-from-svrz', async (req, res) => {
    try {
      const { kscw_team, season } = req.query
      if (!kscw_team || !season) return res.status(400).json({ error: 'kscw_team, season required' })
      if (!(await spielplanerCanManageTeam(req, kscw_team))) return res.status(403).json({ error: 'Not authorized for this team' })

      const seasonRow = await database('game_scheduling_seasons').where('id', season).first()
      if (!seasonRow) return res.status(404).json({ error: 'season not found' })
      const kscwTeamRow = await database('teams').where('id', kscw_team).first()
      if (!kscwTeamRow) return res.status(404).json({ error: 'kscw_team not found' })
      const seasonUuid = seasonRow.svrz_season_uuid || process.env.SVRZ_SEASON_UUID || ''

      // 1. Pull schedulable KSCW games, then scope to THIS team. Filtering by
      // league_short alone is ambiguous — several KSCW teams share a code (H1,
      // H3 and D1 are all "2L" this season), so a club-level group previously
      // lumped every KSCW-vs-club game together and inflated the game count
      // (e.g. "VBC Wetzikon — 8 games" when H1 plays them only twice). Scope to
      // games whose KSCW side IS this exact team — SVRZ names them
      // "KSC Wiedikon <team>", matching teams.name.
      // SVRZ stores season_name as the start year ("2026" for 2026/27). Scope to
      // it so stale `waitingForApproval` fixtures from old seasons (which never
      // got approved) don't leak in and double the game count.
      // Scope to THIS team by NAME, not league. `teams.league` doesn't reliably
      // match SVRZ's `league_short`: juniors are the clear case — wiedisync stores
      // "HU20"/"DU20" but SVRZ files those games under "U20 Ligamodus", so the old
      // hard league gate silently dropped every junior fixture (0 opponents). The
      // reliable signal is the SVRZ side name, always "KSC Wiedikon <team>"
      // (suffix and all, e.g. "KSC Wiedikon HU23-1"). Pull all KSCW season games
      // and match on a normalised identity (lowercase, strip the "KSC Wiedikon"
      // prefix, drop punctuation/spacing). This scopes H1 vs H3, and the
      // same-league-code HU23 vs DU23 (both "U23", different gender), precisely —
      // and naturally yields 0 for a team with no synced fixtures (e.g. DU20,
      // which has none) instead of a garbage superset.
      const svrzSeasonName = String(seasonRow.season || '').split('/')[0].trim()
      const allGames = await database('svrz_games')
        .whereIn('status', ['open', 'waitingForApproval'])
        .where(function () {
          this.where('home_club_id', KSCW_SVRZ_CLUB_ID).orWhere('away_club_id', KSCW_SVRZ_CLUB_ID)
        })
        .modify(excludeCupFixtures)
        .modify((q) => { if (svrzSeasonName) q.where('season_name', svrzSeasonName) })
        .orderBy('starting_date_time')
      const normTeamId = (s) =>
        String(s || '').toLowerCase().trim().replace(/^ksc\s+wiedikon\s+/, '').replace(/[^a-z0-9]/g, '')
      const teamId = normTeamId(kscwTeamRow.name)
      const ourStaticId = staticIdFromTeamId(kscwTeamRow.team_id)
      const kscwSideName = (g) =>
        (String(g.home_club_id) === String(KSCW_SVRZ_CLUB_ID) ? g.home_team_name : g.away_team_name) || ''
      // Identify OUR fixtures by the stable staticTeamIdentifier (VM may rename
      // the team ahead of the SVRZ label); fall back to the name when raw lacks it.
      const isOurTeam = (g) => {
        const sid = kscwSideStaticId(g)
        if (sid != null && ourStaticId != null) return sid === ourStaticId
        return normTeamId(kscwSideName(g)) === teamId
      }
      // The SVRZ feed sometimes lists a fixture TWICE (two persistence ids, same
      // matchup + datetime) — dedupe by matchup+datetime so the game count is the
      // real one (e.g. 2 home+away, not a doubled 4).
      const seenGame = new Set()
      const games = allGames
        .filter(isOurTeam)
        .filter((g) => {
          const k = `${g.home_team_name}|${g.away_team_name}|${g.starting_date_time || ''}`
          if (seenGame.has(k)) return false
          seenGame.add(k)
          return true
        })

      // 2. Group by opponent TEAM (club id + team name). Grouping by club alone
      // merged a club's several teams into one row; keying on the opposing team
      // gives each opponent team its own invite + correct game count.
      const byClub = new Map()
      for (const g of games) {
        const isHomeKscw = String(g.home_club_id) === String(KSCW_SVRZ_CLUB_ID)
        const oppClubId = isHomeKscw ? g.away_club_id : g.home_club_id
        const oppClubName = isHomeKscw ? g.away_club_name : g.home_club_name
        const oppTeamName = isHomeKscw ? g.away_team_name : g.home_team_name
        if (!oppClubId) continue
        // Skip intra-club fixtures (e.g. H1 vs H3 — both share league "2L"): the
        // opponent is KSCW itself, never an external invite.
        if (String(oppClubId) === String(KSCW_SVRZ_CLUB_ID)) continue
        const key = `${oppClubId}::${oppTeamName || ''}`
        if (!byClub.has(key)) {
          byClub.set(key, { club_id: oppClubId, club_name: oppClubName, team_name: oppTeamName, games: [], contacts: new Map() })
        }
        byClub.get(key).games.push({ id: g.svrz_persistence_id, display_name: g.display_name, starting_date_time: g.starting_date_time, is_home_kscw: isHomeKscw })
      }

      // 3. Per-game contact lookup (primary). Fall back to bulk feed if empty.
      let jar = null
      let ctx = null
      const tryLogin = async () => {
        if (jar) return true
        try {
          const vm = await import('/directus/scripts/vm-client.mjs')
          if (!process.env.VM_USERNAME || !process.env.VM_PASSWORD) return false
          jar = await vm.vmLogin({ username: process.env.VM_USERNAME, password: process.env.VM_PASSWORD })
          ctx = await vm.csrfFromPage(jar, '/sportmanager.indoorvolleyball/game/index')
          ctx.VM_BASE = vm.VM_BASE
          ctx.UA = vm.UA
          return true
        } catch (e) {
          log.warn(`[invites import] SVRZ login failed: ${e.message}`)
          return false
        }
      }

      async function getGameContacts(gameUuid) {
        if (!(await tryLogin())) return null
        const url = `${ctx.VM_BASE}/api/sportmanager.indoorvolleyball/api%5cgame/getTeamContactInfosByGame?game=${gameUuid}`
        const headers = {
          'User-Agent': ctx.UA, Accept: '*/*', Cookie: jar.header(),
          Referer: `${ctx.VM_BASE}/sportmanager.indoorvolleyball/game/index`,
        }
        if (ctx.wuid) headers['Window-Unique-Id'] = ctx.wuid
        try {
          const r = await fetch(url, { headers })
          if (!r.ok) return null
          return await r.json()
        } catch (e) {
          log.warn(`[invites import] game contacts fetch ${gameUuid}: ${e.message}`)
          return null
        }
      }

      for (const group of byClub.values()) {
        // Primary: the synced club feed — the scheduling responsible
        // (Spielplanverantwortlicher). Match by club_id + current season START
        // YEAR ("2026"); season_uuid is NOT a reliable season key (one uuid spans
        // several seasons) and season_name varies ("2026/27" vs "2026/2027").
        // Then prefer the contact(s) responsible for THIS team's league —
        // club_league_categories is a JSON array of league codes like
        // ["2L","5L","U23"]; if none match, use ALL the club's contacts. Every
        // match is returned — the invite is one link emailed to all of them.
        const synced = await database('svrz_spielplaner_contacts')
          .where('club_id', String(group.club_id))
          .modify((q) => { if (svrzSeasonName) q.where('season_name', 'like', `${svrzSeasonName}%`) })
          .whereNotNull('contact_email')
        // Club calendar responsible(s) from the synced feed
        // (Spielplanverantwortlicher). The `tr:` rows are team responsibles —
        // handled live below, so only take the real Spielplaner rows here.
        const spielSynced = synced.filter((c) => !String(c.svrz_persistence_id || '').startsWith('tr:'))
        const league = String(kscwTeamRow.league || '').toLowerCase().replace(/\s+/g, '')
        const inLeague = (c) => {
          let cats = c.club_league_categories
          if (typeof cats === 'string') { try { cats = JSON.parse(cats) } catch { cats = [] } }
          if (!Array.isArray(cats)) return false
          return cats.some((x) => String(x).toLowerCase().replace(/\s+/g, '') === league)
        }
        // Prefer the calendar responsible(s) for THIS team's league; if none
        // match, take all the club's calendar responsibles.
        const leagueMatched = league ? spielSynced.filter(inLeague) : []
        for (const c of (leagueMatched.length ? leagueMatched : spielSynced)) {
          const email = (c.contact_email || '').toLowerCase().trim()
          if (!email || group.contacts.has(email)) continue
          group.contacts.set(email, {
            name: c.contact_name || '',
            email,
            phone: c.contact_phone || '',
            source: leagueMatched.length ? 'club_league' : 'club_fallback',
          })
        }

        // ALSO this team's own responsible(s) (Teamverantwortlicher) live from the
        // per-game contact feed — MERGED with the calendar responsible above, not
        // an either/or fallback. One game's contacts are enough (same team across
        // its fixtures), so stop once a game yields any.
        for (const g of group.games) {
          const resp = await getGameContacts(g.id)
          if (!resp) continue
          const pool = g.is_home_kscw ? (resp.teamAway || []) : (resp.teamHome || [])
          let added = false
          for (const c of pool) {
            const title = c.addressOrganisationMemberFunctionTitle || ''
            if (!/spielplan|teamverantwort/i.test(title)) continue
            const email = (c.primaryEmailAddress || '').toLowerCase().trim()
            if (!email || group.contacts.has(email)) continue
            group.contacts.set(email, {
              name: `${c.firstName || ''} ${c.lastName || ''}`.trim(),
              email,
              phone: c.primaryPhoneNumber || '',
              source: 'team_responsible',
            })
            added = true
          }
          if (added) break
        }
      }

      const opponents = [...byClub.values()].map((g) => {
        const contacts = [...g.contacts.values()]
        return {
          club_id: g.club_id,
          club_name: g.club_name,
          team_name: g.team_name,
          game_count: g.games.length,
          games: g.games.map((x) => ({ date: x.starting_date_time, display_name: x.display_name, is_home_kscw: x.is_home_kscw })),
          contacts,
          warning: contacts.length === 0 ? 'no_contact' : undefined,
          source: contacts.length === 0 ? 'none' : contacts[0].source,
        }
      })

      res.json({
        season: seasonRow.season,
        season_uuid: seasonUuid || null,
        kscw_team: { id: kscwTeamRow.id, name: kscwTeamRow.name, league: kscwTeamRow.league },
        opponents,
        total_games_matched: games.length,
      })
    } catch (err) {
      log.error({ msg: `import-from-svrz: ${err.message}`, endpoint: 'admin/terminplanung/invites/import-from-svrz', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // Resolve a KSCW team's external opponents for a season from ALREADY-SYNCED
  // SVRZ data (svrz_games + bulk svrz_spielplaner_contacts) — no live login.
  // Shared by svrz-clubs (auto-fill drafts) and ensure-from-svrz (auto-create
  // invites). Returns [{ club_id, club_name, team_name, game_count, games[],
  // suggested_contacts[] }] sorted by club name.
  async function resolveSyncedOpponents(seasonRow, kscwTeamRow) {
    // All KSCW schedulable games this season, then keep the ones for THIS team
    // by matching the KSCW-side team name. SVRZ labels our teams "KSC Wiedikon
    // H3" etc., so the name reliably identifies the team. League-string matching
    // is unreliable (verbose teams.league vs SVRZ "3L" codes) and would conflate
    // same-league teams (e.g. D2 & D3 are both 3L). Naming caveat: teams whose
    // SVRZ label differs from teams.name (e.g. U23 → "KSC Wiedikon 1") won't match.
    // CRITICAL: scope to the CURRENT season (start year, e.g. "2026"). svrz_games
    // keeps fixtures going back years, and old seasons can still sit at
    // 'waitingForApproval' — without this filter a team's opponents balloon
    // (e.g. H1 = 8 this season + a stale 2020 batch = 17). Mirrors import-from-svrz.
    const svrzSeasonName = String(seasonRow.season || '').split('/')[0].trim()
    const games = await database('svrz_games')
      .whereIn('status', ['open', 'waitingForApproval'])
      .where(function () {
        this.where('home_club_id', KSCW_SVRZ_CLUB_ID).orWhere('away_club_id', KSCW_SVRZ_CLUB_ID)
      })
      .modify(excludeCupFixtures)
      .modify((q) => { if (svrzSeasonName) q.where('season_name', svrzSeasonName) })
      // Same deterministic order as opponentSvrzFixtures — the placeholder
      // starting_date_time is identical across unscheduled fixtures, so the id
      // tiebreak keeps "first fixture of a side" consistent everywhere.
      .orderBy([
        { column: 'starting_date_time', order: 'asc' },
        { column: 'svrz_persistence_id', order: 'asc' },
      ])

    const wantName = `ksc wiedikon ${String(kscwTeamRow.name || '').trim().toLowerCase()}`
    const ourStaticId = staticIdFromTeamId(kscwTeamRow.team_id)
    const byClub = new Map()
    for (const g of games) {
      const isHomeKscw = String(g.home_club_id) === String(KSCW_SVRZ_CLUB_ID)
      // Prefer the stable staticTeamIdentifier (VM may rename our team ahead of
      // the SVRZ label); fall back to the name when raw lacks the id.
      const sid = kscwSideStaticId(g)
      const matchesOurTeam = (sid != null && ourStaticId != null)
        ? sid === ourStaticId
        : String((isHomeKscw ? g.home_team_name : g.away_team_name) || '').trim().toLowerCase() === wantName
      if (!matchesOurTeam) continue
      const clubId = isHomeKscw ? g.away_club_id : g.home_club_id
      const clubName = isHomeKscw ? g.away_club_name : g.home_club_name
      const teamName = isHomeKscw ? g.away_team_name : g.home_team_name
      if (!clubId) continue
      // Skip intra-club fixtures (e.g. H1 vs H3, both "2L") — the opponent is
      // KSCW itself, never an external invite.
      if (String(clubId) === String(KSCW_SVRZ_CLUB_ID)) continue
      // Key by club id + opponent TEAM name so a club's two teams in our group get
      // their own invite each (keying by club alone merged them). Contacts are
      // still looked up per club_id (kept on the entry). Mirrors import-from-svrz.
      const key = `${clubId}::${teamName || ''}`
      // Opponent team's staticTeamIdentifier (from raw) — used to attach the
      // team's own responsible(s) to THIS team, not the whole club.
      const oppStaticId = sideStaticId(g, isHomeKscw ? 'away' : 'home')
      if (!byClub.has(key)) byClub.set(key, { club_id: clubId, club_name: clubName, team_name: teamName, opp_static_id: oppStaticId, game_count: 0, games: [] })
      const entry = byClub.get(key)
      entry.game_count++
      entry.games.push({
        svrz_game_id: g.svrz_persistence_id || null,
        number: g.svrz_number ?? null,
        date: g.starting_date_time || null,
        display_name: g.display_name || null,
        is_home_kscw: isHomeKscw,
      })
    }

    // Contact suggestions from the bulk feed only — no live per-game fetch.
    // Match by season START YEAR ("2026%"), NOT season_uuid: SVRZ issues several
    // uuids for the same season and the bulk feed often syncs under a different
    // uuid than game_scheduling_seasons.svrz_season_uuid, so a uuid match silently
    // returns ~nothing (prod: 1/27 opponents vs 26/27 by name). Mirrors the
    // start-year LIKE that import-from-svrz already uses. (svrzSeasonName is
    // already computed above for the games filter.)
    const clubIds = [...new Set([...byClub.values()].map((c) => c.club_id))]
    // Each opponent team's contacts = the club calendar responsible(s)
    // (Spielplanverantwortlicher, bulk feed, club-level) MERGED with that team's
    // own responsible(s) (Teamverantwortlicher, synthetic `tr:` rows keyed by the
    // opponent team's staticTeamIdentifier). Both are offered — the team
    // responsible is the person who actually handles that team's scheduling.
    const spiel = new Map()      // club_id -> Map(email -> contact)
    const trByTeam = new Map()   // team_identifier -> Map(email -> contact)
    const trByClub = new Map()   // club_id -> Map(email -> contact)  (legacy/club-wide tr rows)
    if (svrzSeasonName && clubIds.length) {
      const bulk = await database('svrz_spielplaner_contacts')
        .whereIn('club_id', clubIds)
        .where('season_name', 'like', `${svrzSeasonName}%`)
      const add = (map, mapKey, c) => {
        const email = (c.contact_email || '').toLowerCase().trim()
        if (!email || mapKey == null || mapKey === '') return
        if (!map.has(mapKey)) map.set(mapKey, new Map())
        const m = map.get(mapKey)
        if (!m.has(email)) m.set(email, { name: c.contact_name || '', email, phone: c.contact_phone || '' })
      }
      for (const c of bulk) {
        const isTeamResp = String(c.svrz_persistence_id || '').startsWith('tr:')
        if (!isTeamResp) { add(spiel, String(c.club_id), c); continue }
        const tid = c.team_identifier == null ? '' : String(c.team_identifier)
        if (tid) add(trByTeam, tid, c)
        else add(trByClub, String(c.club_id), c)
      }
    }
    // Calendar / Spielplan responsible(s) for the club (club-level).
    const calendarContacts = (entry) => [...(spiel.get(String(entry.club_id))?.values() || [])]
    // Team responsible(s) for THIS opponent team (team-keyed `tr:` rows, plus any
    // legacy club-wide tr rows), deduped by email.
    const teamResponsibleContacts = (entry) => {
      const out = new Map()
      const take = (m) => { if (m) for (const [email, v] of m) if (!out.has(email)) out.set(email, v) }
      if (entry.opp_static_id != null) take(trByTeam.get(String(entry.opp_static_id)))
      take(trByClub.get(String(entry.club_id)))
      return [...out.values()]
    }
    // Merge calendar + team responsibles, deduped by email (calendar first).
    const mergeContacts = (entry) => {
      const out = new Map()
      const take = (list) => { for (const v of list) if (!out.has(v.email)) out.set(v.email, v) }
      take(calendarContacts(entry))
      take(teamResponsibleContacts(entry))
      return [...out.values()]
    }

    return [...byClub.values()]
      .map((c) => ({
        ...c,
        suggested_contacts: mergeContacts(c),
        calendar_contacts: calendarContacts(c),
        team_responsible_contacts: teamResponsibleContacts(c),
      }))
      .sort((a, b) => (a.club_name || '').localeCompare(b.club_name || ''))
  }

  // Per-opponent resolved contacts for a season, split into calendar (Spielplan)
  // vs team responsibles. Keyed by stored opponent id. Resolves once per KSCW
  // team (resolveSyncedOpponents scans svrz_games per team) and matches stored
  // opponents to feed entries by team name. `restrict` (Set of team ids) limits
  // to teams the caller manages. Used by the export column + reminder recipients.
  async function opponentContactsBySeason(seasonRow, restrict = null) {
    const opps = await database('game_scheduling_opponents')
      .where('season', seasonRow.id).whereNotIn('status', ['revoked', 'expired'])
      .select('id', 'kscw_team', 'team_name')
    const byTeam = new Map()
    for (const o of opps) {
      if (restrict && !restrict.has(o.kscw_team)) continue
      if (!byTeam.has(o.kscw_team)) byTeam.set(o.kscw_team, [])
      byTeam.get(o.kscw_team).push(o)
    }
    const out = new Map()
    for (const [teamId, list] of byTeam) {
      const teamRow = await database('teams').where('id', teamId).first()
      if (!teamRow) continue
      const entries = await resolveSyncedOpponents(seasonRow, teamRow)
      const byName = new Map(entries.map((e) => [String(e.team_name || '').trim().toLowerCase(), e]))
      for (const o of list) {
        const e = byName.get(String(o.team_name || '').trim().toLowerCase())
        out.set(o.id, { calendar: e?.calendar_contacts || [], team_responsibles: e?.team_responsible_contacts || [] })
      }
    }
    return out
  }

  // GET /admin/terminplanung/opponent-contacts?season= — per-opponent calendar
  // (Spielplan) + team-responsible emails for the season, keyed by opponent id.
  // Feeds the export's "Team responsibles" column.
  router.get('/admin/terminplanung/opponent-contacts', async (req, res) => {
    try {
      const { season } = req.query
      if (!season) return res.status(400).json({ error: 'season required' })
      const seasonRow = await database('game_scheduling_seasons').where('id', season).first()
      if (!seasonRow) return res.status(404).json({ error: 'season not found' })
      const teamIds = await database('game_scheduling_opponents')
        .where('season', season).whereNotIn('status', ['revoked', 'expired']).distinct('kscw_team').pluck('kscw_team')
      const manageable = new Set()
      for (const tId of teamIds) { if (await spielplanerCanManageTeam(req, tId)) manageable.add(tId) }
      const map = await opponentContactsBySeason(seasonRow, manageable)
      const join = (list) => [...new Set(list.map((c) => c.email).filter(Boolean))].join(', ')
      const out = {}
      for (const [id, v] of map) out[id] = { calendar: join(v.calendar), team_responsibles: join(v.team_responsibles) }
      res.json({ contacts: out })
    } catch (err) {
      log.error({ msg: `opponent-contacts: ${err.message}`, endpoint: 'admin/terminplanung/opponent-contacts', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // GET /admin/terminplanung/season-summary?season= — fixture-aware home/away
  // tallies for the dashboard cards + per-team header counter. The page itself
  // only knows opponents+bookings (fixtures load lazily per accordion), so it
  // can't tell that a junior triple round-robin pairing carries 2 home + 1 away
  // (or 1+2) legs — which is why the booking-count numerator was overshooting a
  // one-leg-per-opponent denominator (e.g. away 75/74). Here we resolve each
  // opponent's SVRZ fixtures and total per side, exactly like finalize-notify /
  // invites/remind: homeTotal = home-side fixtures (1 fallback when an opponent
  // has no synced fixtures). The total is floored at the confirmed count so a
  // stale orphan booking on a dropped fixture can never read numerator>total.
  // Scoped to the teams the caller may manage — or, read-only, coach/view
  // (canViewTeamScheduling: coaches/TRs see their own team's tallies).
  // No actor logging.
  router.get('/admin/terminplanung/season-summary', async (req, res) => {
    try {
      const { season } = req.query
      if (!season) return res.status(400).json({ error: 'season required' })
      const seasonRow = await database('game_scheduling_seasons').where('id', season).first('id')
      if (!seasonRow) return res.status(404).json({ error: 'season not found' })

      const allOpps = await database('game_scheduling_opponents')
        .where('season', season).whereNotIn('status', ['revoked', 'expired'])
        .select('id', 'kscw_team', 'team_name', 'club_name', 'season')

      const allTeamIds = [...new Set(allOpps.map((o) => o.kscw_team))]
      const manageable = new Set()
      for (const tId of allTeamIds) { if (await canViewTeamScheduling(req, tId)) manageable.add(tId) }
      const opps = allOpps.filter((o) => manageable.has(o.kscw_team))

      // Confirmed bookings per opponent + side (mirrors finalize-notify counts).
      const homeConf = new Map(); const awayConf = new Map()
      if (opps.length) {
        const confRows = await database('game_scheduling_bookings')
          .whereIn('opponent', opps.map((o) => o.id)).where('status', 'confirmed')
          .groupBy('opponent', 'type')
          .select('opponent', 'type', database.raw('count(*) as c'))
        for (const r of confRows) {
          if (r.type === 'home_slot_pick') homeConf.set(r.opponent, Number(r.c))
          else if (r.type === 'away_proposal') awayConf.set(r.opponent, Number(r.c))
        }
      }

      const byTeam = {}
      const bucket = (tid) => (byTeam[tid] || (byTeam[tid] = { homeConfirmed: 0, homeTotal: 0, awayConfirmed: 0, awayTotal: 0 }))
      for (const o of opps) {
        const fixtures = await opponentSvrzFixtures(o)
        const homeFx = fixtures.length ? fixtures.filter((f) => f.is_home_kscw).length : 1
        const awayFx = fixtures.length ? fixtures.filter((f) => !f.is_home_kscw).length : 1
        const hc = homeConf.get(o.id) || 0
        const ac = awayConf.get(o.id) || 0
        const b = bucket(String(o.kscw_team))
        b.homeConfirmed += hc
        b.awayConfirmed += ac
        b.homeTotal += Math.max(homeFx, hc) // floor at confirmed → never numerator>total
        b.awayTotal += Math.max(awayFx, ac)
      }

      const totals = Object.values(byTeam).reduce((acc, b) => {
        acc.homeConfirmed += b.homeConfirmed; acc.homeTotal += b.homeTotal
        acc.awayConfirmed += b.awayConfirmed; acc.awayTotal += b.awayTotal
        return acc
      }, { homeConfirmed: 0, homeTotal: 0, awayConfirmed: 0, awayTotal: 0 })

      res.json({ totals, byTeam })
    } catch (err) {
      log.error({ msg: `season-summary: ${err.message}`, endpoint: 'admin/terminplanung/season-summary', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // GET /admin/terminplanung/away-vm-check?season= — for each CONFIRMED away
  // game, compare the agreed date/time (the confirmed proposal, stored lexically
  // as Zurich wall-clock) against what's in VolleyManager (svrz_games
  // .starting_date_time, a true-UTC instant → converted to Zurich). The opponent
  // owns the away hall, so THEY enter the date in VM; this surfaces whether they
  // did. Keyed by booking id:
  //   match    (green)  — VM equals the agreed slot.
  //   unset    (yellow) — VM still at the season-start placeholder (not updated).
  //   mismatch (red)    — VM has a different real date/time (diff shown).
  //   no_vm    (grey)   — no synced fixture / no VM datetime to compare.
  // A real game whose VM date == agreed wins as `match` before the placeholder
  // check (covers the edge where the game genuinely falls on the placeholder day).
  router.get('/admin/terminplanung/away-vm-check', async (req, res) => {
    try {
      const { season } = req.query
      if (!season) return res.status(400).json({ error: 'season required' })
      const seasonRow = await database('game_scheduling_seasons').where('id', season).first()
      if (!seasonRow) return res.status(404).json({ error: 'season not found' })
      // VM's unscheduled placeholder sits at the season start — anything on/before
      // the configured season-open date that isn't the agreed slot is "not set yet".
      const offerWindow = seasonOfferWindow(seasonRow)
      const placeholderMax = offerWindow ? offerWindow.start : null // 'YYYY-MM-DD'

      const rows = await database('game_scheduling_bookings as b')
        .join('game_scheduling_opponents as o', 'o.id', 'b.opponent')
        .leftJoin('svrz_games as g', 'g.svrz_persistence_id', 'b.svrz_game_id')
        .where('o.season', season).where('b.type', 'away_proposal').where('b.status', 'confirmed')
        .select('b.id', 'o.kscw_team', 'b.confirmed_proposal as cp',
          database.raw('b.proposed_datetime_1::text as d1'),
          database.raw('b.proposed_datetime_2::text as d2'),
          database.raw('b.proposed_datetime_3::text as d3'),
          database.raw("to_char(g.starting_date_time AT TIME ZONE 'Europe/Zurich', 'DD.MM.YYYY HH24:MI') as vm_zurich"),
          database.raw("to_char((g.starting_date_time AT TIME ZONE 'Europe/Zurich')::date, 'YYYY-MM-DD') as vm_date_iso"))

      // Manageability is checked per team; cache so the unbooked scan below reuses
      // the same verdicts instead of re-querying policy for every opponent.
      const manageCache = new Map()
      const canManage = async (teamId) => {
        const k = String(teamId)
        if (!manageCache.has(k)) manageCache.set(k, await spielplanerCanManageTeam(req, teamId))
        return manageCache.get(k)
      }

      // Confirmed proposal → lexical Zurich wall-clock dd.mm.yyyy HH:MM.
      const lexical = (s) => {
        const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/)
        return m ? `${m[3]}.${m[2]}.${m[1]}${m[4] ? ` ${m[4]}:${m[5]}` : ''}` : ''
      }
      const out = {}
      for (const r of rows) {
        if (!(await canManage(r.kscw_team))) continue
        const agreed = lexical(r[`d${r.cp || 1}`])
        if (!r.vm_zurich) { out[r.id] = { status: 'no_vm', agreed, vm: null }; continue }
        if (r.vm_zurich === agreed) { out[r.id] = { status: 'match', agreed, vm: r.vm_zurich }; continue }
        const isPlaceholder = placeholderMax && r.vm_date_iso && r.vm_date_iso <= placeholderMax
        out[r.id] = { status: isPlaceholder ? 'unset' : 'mismatch', agreed, vm: r.vm_zurich }
      }

      // Away fixtures VolleyManager has actually scheduled (a real date past the
      // placeholder) but where we hold NO confirmed booking — so the admin can
      // pull them in with one click ("add it if no game was confirmed"). One
      // opponentSvrzFixtures() pass per opponent; this endpoint is admin-rare.
      const oppRows = await database('game_scheduling_opponents')
        .where('season', season)
        .select('id', 'kscw_team', 'team_name', 'club_name', 'season')
      const confirmedAway = await database('game_scheduling_bookings')
        .where({ season, type: 'away_proposal', status: 'confirmed' })
        .select('opponent', 'svrz_game_id')
      const bookedExact = new Set()     // `${opponent}:${svrz_game_id}`
      const bookedFirstAway = new Set() // opponents whose first away fixture is held by a legacy NULL booking
      for (const b of confirmedAway) {
        if (b.svrz_game_id) bookedExact.add(`${b.opponent}:${b.svrz_game_id}`)
        else bookedFirstAway.add(String(b.opponent))
      }
      const candidates = []
      for (const opp of oppRows) {
        if (!(await canManage(opp.kscw_team))) continue
        const fixtures = await opponentSvrzFixtures(opp)
        const awayFx = fixtures.filter((f) => !f.is_home_kscw && f.starting_date_time)
        awayFx.forEach((f, idx) => {
          if (bookedExact.has(`${opp.id}:${f.id}`)) return
          if (idx === 0 && bookedFirstAway.has(String(opp.id))) return
          candidates.push({ opponent_id: String(opp.id), svrz_game_id: String(f.id) })
        })
      }
      const unbooked = []
      if (candidates.length) {
        const ids = [...new Set(candidates.map((c) => c.svrz_game_id))]
        const vmRows = await database('svrz_games')
          .whereIn('svrz_persistence_id', ids)
          .select('svrz_persistence_id',
            database.raw("to_char(starting_date_time AT TIME ZONE 'Europe/Zurich', 'DD.MM.YYYY HH24:MI') as vm_zurich"),
            database.raw("to_char((starting_date_time AT TIME ZONE 'Europe/Zurich')::date, 'YYYY-MM-DD') as vm_date_iso"))
        const vmById = new Map(vmRows.map((v) => [String(v.svrz_persistence_id), v]))
        for (const c of candidates) {
          const v = vmById.get(c.svrz_game_id)
          if (!v || !v.vm_zurich) continue
          if (placeholderMax && v.vm_date_iso && v.vm_date_iso <= placeholderMax) continue
          unbooked.push({ opponent_id: c.opponent_id, svrz_game_id: c.svrz_game_id, vm: v.vm_zurich })
        }
      }
      res.json({ checks: out, unbooked })
    } catch (err) {
      log.error({ msg: `away-vm-check: ${err.message}`, endpoint: 'admin/terminplanung/away-vm-check', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // GET /admin/terminplanung/home-vm-check?season= — the HOME counterpart of
  // away-vm-check. WE own the home hall, so WE push the date into VolleyManager;
  // this surfaces confirmed home games that are NOT in VM (never pushed / push
  // failed) or whose VM date/time DRIFTED from our slot after we pushed it.
  // Keyed by booking id:
  //   not_pushed (alert) — confirmed but not successfully pushed (failed / no_fixture / needs_pick / queued / never).
  //   mismatch   (alert) — pushed, but VM was re-scraped AFTER our push and now shows a different date/time.
  //   match      (ok)    — pushed and VM equals our slot (or VM not re-scraped since the push → trust our push).
  //   no_vm      (ok)    — pushed but no linked VM fixture / no VM datetime to compare.
  // The weekday→20:00 rule (weekdayHomeTime) is applied to the slot so a
  // correctly-pushed weekday game (slot 19:30 → game 20:00) is NOT mis-flagged.
  router.get('/admin/terminplanung/home-vm-check', async (req, res) => {
    try {
      const { season } = req.query
      if (!season) return res.status(400).json({ error: 'season required' })

      const rows = await database('game_scheduling_bookings as b')
        .join('game_scheduling_opponents as o', 'o.id', 'b.opponent')
        .join('game_scheduling_slots as s', 's.id', 'b.slot')
        .leftJoin('svrz_games as g', 'g.svrz_persistence_id', 'b.svrz_game_id')
        .where('o.season', season).where('b.type', 'home_slot_pick').where('b.status', 'confirmed')
        .select('b.id', 'o.kscw_team', 'b.vm_push_status as vps', 'b.vm_pushed_at as pushed_at',
          database.raw('s.date::text as slot_date'),
          database.raw('s.start_time::text as slot_st'),
          database.raw("to_char(g.starting_date_time AT TIME ZONE 'Europe/Zurich', 'DD.MM.YYYY HH24:MI') as vm_zurich"),
          'g.last_synced_at as vm_synced_at')

      const manageCache = new Map()
      const canManage = async (teamId) => {
        const k = String(teamId)
        if (!manageCache.has(k)) manageCache.set(k, await spielplanerCanManageTeam(req, teamId))
        return manageCache.get(k)
      }

      // Once the season's SV-feed takeover date (vm_authority_date) passes, the
      // official feed is authoritative for date/time/venue (same rule sv-sync
      // applies to the games mirror) — a home game whose VM date then differs
      // from our frozen slot is the feed's call, not a "you must re-push".
      const seasonRow = await database('game_scheduling_seasons').where('id', season).first('vm_authority_date')
      const takeover = seasonRow?.vm_authority_date ? new Date(seasonRow.vm_authority_date).toISOString().slice(0, 10) : null
      const todayStr = new Date().toISOString().slice(0, 10)
      const feedHasTakenOver = !!(takeover && todayStr >= takeover)

      // Our scheduled slot → lexical dd.mm.yyyy HH:MM with the weekday-20:00 rule.
      const fmtAgreed = (dateYmd, st) => {
        const m = String(dateYmd || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
        if (!m) return ''
        const time = weekdayHomeTime(dateYmd, st)
        return `${m[3]}.${m[2]}.${m[1]}${time ? ` ${time}` : ''}`
      }
      const PUSHED = new Set(['pushed', 'pushed_no_hall'])
      const out = {}
      for (const r of rows) {
        if (!(await canManage(r.kscw_team))) continue
        const agreed = fmtAgreed(r.slot_date, r.slot_st)
        // Already in sync: VM (the SVRZ mirror) carries our exact agreed
        // date/time — regardless of push status. This covers league-APPROVED
        // fixtures, which reject any further push (vm_push_status stays 'failed'
        // with "VM game status is approved, not open") even though VM already
        // matches: not pushed, but nothing to push → a match, not an alert.
        if (r.vm_zurich && r.vm_zurich === agreed) { out[r.id] = { status: 'match', agreed, vm: r.vm_zurich, push: r.vps }; continue }
        // Past the takeover date the feed wins date/time/venue: surface a VM≠agreed
        // divergence as feed_authority (not an actionable re-push alert). The
        // dashboard alert ignores any status other than not_pushed/mismatch.
        if (feedHasTakenOver && r.vm_zurich) { out[r.id] = { status: 'feed_authority', agreed, vm: r.vm_zurich, push: r.vps }; continue }
        if (!PUSHED.has(r.vps)) { out[r.id] = { status: 'not_pushed', agreed, vm: r.vm_zurich || null, push: r.vps || null }; continue }
        if (!r.vm_zurich) { out[r.id] = { status: 'no_vm', agreed, vm: null, push: r.vps }; continue }
        // VM differs from our slot — only a genuine drift if VM was re-scraped
        // AFTER we pushed (else svrz_games is just lagging our own push).
        const drifted = r.vm_synced_at && r.pushed_at && new Date(r.vm_synced_at) > new Date(r.pushed_at)
        out[r.id] = { status: drifted ? 'mismatch' : 'match', agreed, vm: r.vm_zurich, push: r.vps }
      }
      res.json({ checks: out })
    } catch (err) {
      log.error({ msg: `home-vm-check: ${err.message}`, endpoint: 'admin/terminplanung/home-vm-check', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /admin/terminplanung/sync-away-from-vm — adopt VolleyManager's agreed
  // date/time (and gym, if available) for ONE away game. The opponent owns the
  // away hall, so THEY enter the date in VM; this is the admin's one-click "take
  // what's in VM" for the divergent (red) and not-yet-booked rows the
  // away-vm-check surfaces. Body is either:
  //   { booking_id }                 → overwrite an existing confirmed away slot
  //   { opponent_id, svrz_game_id }  → create a confirmed away booking from VM
  // The synced date came FROM VM, so we deliberately do NOT push it back; the
  // sv-sync guard then treats the booking as authoritative (date == VM ⇒ no drift).
  router.post('/admin/terminplanung/sync-away-from-vm', async (req, res) => {
    try {
      const { booking_id, opponent_id, svrz_game_id } = req.body || {}
      if (!booking_id && !(opponent_id && svrz_game_id)) {
        return res.status(400).json({ error: 'booking_id or (opponent_id + svrz_game_id) required' })
      }

      // Resolve the target opponent + fixture from either entry point.
      let booking = null
      let opponent = null
      let fixtureId = svrz_game_id ? String(svrz_game_id) : null
      if (booking_id) {
        booking = await database('game_scheduling_bookings').where('id', booking_id).first()
        if (!booking || booking.type !== 'away_proposal') return res.status(404).json({ error: 'Away booking not found' })
        opponent = await database('game_scheduling_opponents').where('id', booking.opponent).first()
        fixtureId = booking.svrz_game_id ? String(booking.svrz_game_id) : null
      } else {
        opponent = await database('game_scheduling_opponents').where('id', opponent_id).first()
      }
      if (!opponent) return res.status(404).json({ error: 'Opponent not found' })
      if (!(await spielplanerCanManageTeam(req, opponent.kscw_team))) return res.status(403).json({ error: 'Not authorized for this team' })
      if (!fixtureId) return res.status(400).json({ error: 'No SVRZ fixture to sync from' })

      // VolleyManager date/time (Zurich wall-clock) for this fixture, from the
      // national feed mirror. proposed_datetime_* is stored as a naive wall-clock,
      // so we format the same way (no tz suffix).
      const vm = await database('svrz_games')
        .where('svrz_persistence_id', fixtureId)
        .first('svrz_number',
          database.raw("to_char(starting_date_time AT TIME ZONE 'Europe/Zurich', 'YYYY-MM-DD\"T\"HH24:MI') as dt_naive"),
          database.raw("to_char((starting_date_time AT TIME ZONE 'Europe/Zurich')::date, 'YYYY-MM-DD') as date_iso"))
      if (!vm || !vm.dt_naive) return res.status(400).json({ error: 'VolleyManager has no date for this game yet' })

      // Never adopt the league's unscheduled placeholder over a real slot.
      const seasonRow = await database('game_scheduling_seasons').where('id', opponent.season).first()
      const offerWindow = seasonOfferWindow(seasonRow)
      if (offerWindow && vm.date_iso && vm.date_iso <= offerWindow.start) {
        return res.status(400).json({ error: 'VolleyManager still shows the placeholder date — nothing to sync' })
      }

      // Gym: the opponent's hall, mirrored into games.away_hall_json by sv-sync
      // (present once VM carries it). "Add the gym if available" → only set when found.
      let place = ''
      if (vm.svrz_number != null) {
        const g = await database('games').where('game_id', `vb_${vm.svrz_number}`).first('away_hall_json')
        if (g && g.away_hall_json) {
          try {
            const h = typeof g.away_hall_json === 'string' ? JSON.parse(g.away_hall_json) : g.away_hall_json
            place = [h.name, h.address, h.city].filter(Boolean).join(', ').trim().slice(0, 200)
          } catch { /* malformed hall json — leave the gym unset */ }
        }
      }

      const actor = await resolveActingUser(req)
      const seasonId = opponent.season
      let resultBookingId = booking_id || null

      if (booking) {
        // Overwrite the confirmed proposal's slot in place (keep the chosen number).
        const cp = Number(booking.confirmed_proposal) || 1
        const patch = {
          status: 'confirmed', confirmed_proposal: cp,
          [`proposed_datetime_${cp}`]: vm.dt_naive,
          confirmed_by_name: actor.name, confirmed_by_email: actor.email, confirmed_at: database.fn.now(),
        }
        if (place) patch[`proposed_place_${cp}`] = place
        await database('game_scheduling_bookings').where('id', booking.id).update(patch)
      } else {
        // Create from scratch — mirrors manual-booking's away leg.
        const fixtures = await opponentSvrzFixtures(opponent)
        const target = resolveTargetFixture(fixtures, false, fixtureId)
        if (!target) return res.status(400).json({ error: 'Invalid away game for this opponent' })
        await scopeToFixture(
          database('game_scheduling_bookings').where({ opponent: opponent.id, type: 'away_proposal' }),
          target,
        ).del()
        const ins = await database('game_scheduling_bookings').insert({
          opponent: opponent.id, season: seasonId, type: 'away_proposal',
          status: 'confirmed', confirmed_proposal: 1,
          svrz_game_id: target.fixtureId,
          proposed_datetime_1: vm.dt_naive, proposed_place_1: place || null,
          admin_notes: 'Von VolleyManager übernommen',
          confirmed_by_name: actor.name, confirmed_by_email: actor.email, confirmed_at: database.fn.now(),
        }).returning('id')
        resultBookingId = typeof ins[0] === 'object' ? ins[0].id : ins[0]
        await database('game_scheduling_opponents').where('id', opponent.id).update({ status: 'booked' })
      }

      await writeUserLog(database, log, {
        accountability: req.accountability, action: booking ? 'update' : 'create',
        collection: 'game_scheduling_bookings', recordId: resultBookingId,
        data: { kind: 'sync_away_from_vm', opponent: opponent.id, svrz_game_id: fixtureId, vm: vm.dt_naive },
      })

      // Mirror into `games` so member calendars reflect the synced date right away.
      reconcileBookingsToGames(opponent.season).catch((e) => log.warn(`sync-away-from-vm reconcile failed: ${e.message}`))

      res.json({ success: true })
    } catch (err) {
      if (err && err.httpStatus) return res.status(err.httpStatus).json({ error: err.message })
      log.error({ msg: `sync-away-from-vm: ${err.message}`, endpoint: 'admin/terminplanung/sync-away-from-vm', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // GET /admin/terminplanung/invites/svrz-clubs?kscw_team=&season= — fast list of
  // the clubs in this team's league for the semi-manual invite flow. Unlike
  // import-from-svrz this does NO live SVRZ login: the club list comes straight
  // from synced svrz_games (KSCW-scoped, league-filtered → in a round-robin league
  // that's every other club) and contacts are only *suggestions* from the bulk
  // svrz_spielplaner_contacts feed. The admin fills in / confirms each contact.
  router.get('/admin/terminplanung/invites/svrz-clubs', async (req, res) => {
    try {
      const { kscw_team, season } = req.query
      if (!kscw_team || !season) return res.status(400).json({ error: 'kscw_team, season required' })
      if (!(await spielplanerCanManageTeam(req, kscw_team))) return res.status(403).json({ error: 'Not authorized for this team' })

      const seasonRow = await database('game_scheduling_seasons').where('id', season).first()
      if (!seasonRow) return res.status(404).json({ error: 'season not found' })
      const kscwTeamRow = await database('teams').where('id', kscw_team).first()
      if (!kscwTeamRow) return res.status(404).json({ error: 'kscw_team not found' })
      const seasonUuid = seasonRow.svrz_season_uuid || process.env.SVRZ_SEASON_UUID || ''

      const clubs = await resolveSyncedOpponents(seasonRow, kscwTeamRow)

      res.json({
        season: seasonRow.season,
        season_uuid: seasonUuid || null,
        kscw_team: { id: kscwTeamRow.id, name: kscwTeamRow.name, league: kscwTeamRow.league },
        clubs,
      })
    } catch (err) {
      log.error({ msg: `svrz-clubs: ${err.message}`, endpoint: 'admin/terminplanung/invites/svrz-clubs', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /admin/terminplanung/invites/ensure-from-svrz — auto-create invite links
  // for every synced opponent that has a contact email and isn't already invited,
  // so the panel's invite list populates itself once the SVRZ contacts are there.
  // Idempotent: deduped by normalised opponent team name, so re-running only adds
  // newly-appeared opponents. Opponents with NO contact are skipped (nothing to
  // email). Does NOT send anything — emailing stays a separate explicit action.
  router.post('/admin/terminplanung/invites/ensure-from-svrz', async (req, res) => {
    try {
      const { kscw_team, season } = req.body || {}
      if (!kscw_team || !season) return res.status(400).json({ error: 'kscw_team, season required' })
      if (!(await spielplanerCanManageTeam(req, kscw_team))) return res.status(403).json({ error: 'Not authorized for this team' })
      const seasonRow = await database('game_scheduling_seasons').where('id', season).first()
      if (!seasonRow) return res.status(404).json({ error: 'season not found' })
      const kscwTeamRow = await database('teams').where('id', kscw_team).first()
      if (!kscwTeamRow) return res.status(404).json({ error: 'kscw_team not found' })

      const opponents = await resolveSyncedOpponents(seasonRow, kscwTeamRow)

      // Dedupe against ALL existing rows for this team+season (any status) by
      // normalised opponent team name, so re-running never mints a second link
      // for an opponent that already has one — and a deliberately *revoked* or
      // expired invite is never silently resurrected with a fresh token. To
      // bring a revoked opponent back, the admin uses Reissue (same row, new
      // token), not auto-populate.
      // ⚠ Concurrency: the dedupe below is a name-keyed check-then-act and
      // game_scheduling_opponents has no unique index behind it. The invites panel
      // fires this endpoint from a mount effect, so two admins opening the setup
      // page at season-open — or one navigating back while the first call is still
      // walking its ~27 opponents — both read an opponent-free table and both insert
      // the whole set: two invite rows, two tokens, two mails to the same opponent
      // club, and their picks land under the row the coordinator is not watching.
      // Serialize per kscw_team on an advisory lock and re-read `existing` INSIDE the
      // same transaction, so the second caller sees the first caller's rows and only
      // refreshes them (created stays 0 — a visible, honest no-op, not an error: this
      // endpoint is called unprompted on mount and must not paint the page red).
      // The slow resolveSyncedOpponents() walk above deliberately stays OUTSIDE the
      // lock. The lock is transaction-scoped, so a crash or container restart
      // releases it automatically — there is no claim left behind to clean up.
      let created = 0
      let refreshed = 0
      await database.transaction(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(?, ?)', [GSCH_INVITE_LOCK_CLASS, kscwTeamRow.id])
        const existing = await trx('game_scheduling_opponents')
          .where({ kscw_team, season })
        const norm = (s) => String(s || '').trim().toLowerCase()
        const existingByName = new Map(existing.map((e) => [norm(e.team_name), e]))
        const insertedNames = new Set()

        // A resolved contact list → comma-joined { names, emails }.
        const joinContacts = (list) => ({
          names: (list || []).map((c) => c.name).filter(Boolean).join(', '),
          emails: (list || []).map((c) => c.email).filter(Boolean).join(', '),
        })

        for (const opp of opponents) {
          const union = joinContacts(opp.suggested_contacts)
          if (!union.emails) continue
          const cal = joinContacts(opp.calendar_contacts)
          const team = joinContacts(opp.team_responsible_contacts)
          const teamName = opp.team_name || opp.club_name
          // contact_email/contact_name stay the UNION (send path + everything else
          // reads these); the split columns label who's a calendar vs team contact.
          const contactFields = {
            contact_email: union.emails, contact_name: union.names,
            calendar_contact_email: cal.emails, calendar_contact_name: cal.names,
            team_contact_email: team.emails, team_contact_name: team.names,
            // club_id groups this opponent row under the per-club portal (season, club_id).
            club_id: opp.club_id || null,
          }
          const existingRow = existingByName.get(norm(teamName))
          if (existingRow) {
            // Refresh contacts in place — this is what recovers per-team
            // responsibles that were dropped before they'd been synced (they're
            // matched by the opponent team's staticTeamIdentifier). Never touches
            // token/status/expiry, so a revoked invite stays revoked. Only writes
            // when the union (or a split group), or the club_id, actually changed.
            const changed =
              (existingRow.contact_email || '') !== contactFields.contact_email ||
              (existingRow.calendar_contact_email || '') !== contactFields.calendar_contact_email ||
              (existingRow.team_contact_email || '') !== contactFields.team_contact_email ||
              (!!opp.club_id && (existingRow.club_id || '') !== String(opp.club_id))
            if (changed) { await trx('game_scheduling_opponents').where('id', existingRow.id).update(contactFields); refreshed++ }
            continue
          }
          if (insertedNames.has(norm(teamName))) continue
          await trx('game_scheduling_opponents').insert({
            kscw_team, season, team_name: teamName,
            ...contactFields,
            token: crypto.randomBytes(16).toString('hex'), status: 'invited',
            source: 'svrz', created_by_admin: true, expires_at: newInviteExpiry(seasonRow.season),
          })
          insertedNames.add(norm(teamName))
          created++
        }
      })

      const invites = await database('game_scheduling_opponents')
        .where('kscw_team', kscw_team).where('season', season)
        .orderBy('date_created', 'desc')
      res.json({ created, refreshed, invites })
    } catch (err) {
      log.error({ msg: `invites ensure-from-svrz: ${err.message}`, endpoint: 'admin/terminplanung/invites/ensure-from-svrz', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // ── Club portals (admin) — one opponent link per CLUB (use_club_portals) ──
  // GET /admin/terminplanung/club-portals?season= — list a season's portals.
  router.get('/admin/terminplanung/club-portals', async (req, res) => {
    if (!(await isAdminOrSpielplaner(req))) return res.status(403).json({ error: 'Admin only' })
    try {
      const season = Number(req.query.season)
      if (!season) return res.status(400).json({ error: 'season required' })
      // sport filter: this table is shared with basketball since migration 280.
      const portals = await database('game_scheduling_club_portals')
        .where('season', season).where('sport', 'volleyball').orderBy('club_name', 'asc')
      res.json({ portals })
    } catch (err) {
      log.error({ msg: `club-portals list: ${err.message}`, endpoint: 'admin/terminplanung/club-portals', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /admin/terminplanung/club-portals/ensure — mint/refresh one portal per
  // (season, club_id) from the season's opponent anchor rows. Idempotent: never
  // touches an existing portal's token/status/expiry; only unions in fresh
  // contacts and fills the club name. Requires the season's use_club_portals flag.
  router.post('/admin/terminplanung/club-portals/ensure', async (req, res) => {
    if (!(await isAdminOrSpielplaner(req))) return res.status(403).json({ error: 'Admin only' })
    try {
      const season = Number(req.body?.season)
      if (!season) return res.status(400).json({ error: 'season required' })
      const seasonRow = await database('game_scheduling_seasons').where('id', season).first()
      if (!seasonRow) return res.status(404).json({ error: 'season not found' })
      if (!seasonRow.use_club_portals) return res.status(400).json({ error: 'club_portals_disabled' })
      // Group opponent anchor rows by club. The contact union is derived from the
      // rows themselves (their contact_email is already the resolved team+calendar
      // union), so every recipient a per-team send would reach still gets the link.
      const opps = await database('game_scheduling_opponents')
        .where('season', season).whereNotNull('club_id')
        .whereIn('status', ['active', 'invited', 'viewed', 'booked'])
      const splitList = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean)
      const byClub = new Map()
      for (const o of opps) {
        const key = String(o.club_id)
        if (!byClub.has(key)) byClub.set(key, { club_id: key, club_name: o.club_name || '', emails: new Map(), names: new Set() })
        const g = byClub.get(key)
        if (!g.club_name && o.club_name) g.club_name = o.club_name
        for (const e of splitList(o.contact_email)) { const lc = e.toLowerCase(); if (!g.emails.has(lc)) g.emails.set(lc, e) }
        for (const n of splitList(o.contact_name)) g.names.add(n)
      }
      let created = 0, refreshed = 0
      for (const g of byClub.values()) {
        const emails = [...g.emails.values()].join(', ')
        const names = [...g.names].join(', ')
        // sport filter: `club_id` is only unique WITHIN a sport (basketball stores
        // basketplan_clubs.id here, volleyball an SVRZ club id — small integers
        // that collide), and the uniqueness constraint is (season, sport, club_id).
        const existing = await database('game_scheduling_club_portals')
          .where({ season, club_id: g.club_id, sport: 'volleyball' }).first()
        if (existing) {
          const patch = {}
          if ((existing.contact_email || '') !== emails) patch.contact_email = emails
          if ((existing.contact_name || '') !== names) patch.contact_name = names
          if (!existing.club_name && g.club_name) patch.club_name = g.club_name
          if (Object.keys(patch).length) {
            patch.date_updated = new Date().toISOString()
            await database('game_scheduling_club_portals').where('id', existing.id).update(patch)
            refreshed++
          }
          continue
        }
        await database('game_scheduling_club_portals').insert({
          season, club_id: g.club_id, club_name: g.club_name, sport: 'volleyball',
          token: crypto.randomBytes(16).toString('hex'), status: 'invited',
          contact_email: emails, contact_name: names,
          expires_at: newInviteExpiry(seasonRow.season), created_by_admin: true,
        })
        created++
      }
      const portals = await database('game_scheduling_club_portals')
        .where('season', season).where('sport', 'volleyball').orderBy('club_name', 'asc')
      res.json({ created, refreshed, portals })
    } catch (err) {
      log.error({ msg: `club-portals ensure: ${err.message}`, endpoint: 'admin/terminplanung/club-portals/ensure', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /admin/terminplanung/club-portals/send — email the one club link to each
  // portal's recipients (union of the club's team contacts). dry_run → preview.
  router.post('/admin/terminplanung/club-portals/send', async (req, res) => {
    if (!(await isAdminOrSpielplaner(req))) return res.status(403).json({ error: 'Admin only' })
    try {
      const { season, ids = null, dry_run } = req.body || {}
      if (!season) return res.status(400).json({ error: 'season required' })
      const seasonRow = await database('game_scheduling_seasons').where('id', season).first()
      if (!seasonRow) return res.status(404).json({ error: 'season not found' })
      // ⚠ sport filter is load-bearing: without it this VOLLEYBALL send would mail
      // every BASKETBALL opponent club a volleyball invite carrying a basketball
      // token (shared table since migration 280).
      let q = database('game_scheduling_club_portals')
        .where('season', season).where('sport', 'volleyball')
        .whereNotIn('status', ['revoked', 'expired'])
      if (Array.isArray(ids) && ids.length) q = q.whereIn('id', ids)
      const portals = await q
      const fmtDate = (ts) => {
        if (!ts) return ''
        const d = new Date(ts); if (isNaN(d.getTime())) return ''
        const p = (n) => String(n).padStart(2, '0')
        return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`
      }
      const previews = []; const failed = []; let sent = 0
      for (const portal of portals) {
        const url = `${SCHEDULING_URL}/terminplanung/club/${portal.token}`
        const { subject, text, html } = inviteEmail({
          club: true, opponent: portal.club_name || '',
          season: seasonRow.season || '', url, expires: fmtDate(portal.expires_at),
        })
        previews.push({ id: portal.id, to: portal.contact_email, club_name: portal.club_name, subject, html, text })
        if (!dry_run) {
          const recipients = parseRecipients(portal.contact_email)
          if (!recipients || (Array.isArray(recipients) && recipients.length === 0)) {
            failed.push({ id: portal.id, error: 'no valid recipient' }); continue
          }
          try {
            await sendSchedulingMail(portal.contact_email, subject, text, SCHEDULING_REPLY_TO, html)
            await database('game_scheduling_club_portals').where('id', portal.id)
              .update({ email_sent_at: new Date().toISOString() })
            sent++
          } catch (e) { failed.push({ id: portal.id, error: e.message }) }
        }
      }
      res.json({ previews, sent, failed, dry_run: !!dry_run })
    } catch (err) {
      log.error({ msg: `club-portals send: ${err.message}`, endpoint: 'admin/terminplanung/club-portals/send', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // ── Intra-club derby anchoring (Art. 27 SVRZ) ────────────────────────
  // GET /admin/terminplanung/derbies?season= — detect KSCW team pairs that share
  // a league group (an all-KSCW fixture exists in the SVRZ feed → they play each
  // other) and merge with any dates the spielplaner has fixed. Each pair carries
  // its two head-to-head legs (with the round the feed currently files them
  // under, e.g. "Runde 7" — the case Art. 27 overrides).
  router.get('/admin/terminplanung/derbies', async (req, res) => {
    if (!(await isAdminOrSpielplaner(req))) return res.status(403).json({ error: 'Admin only' })
    try {
      const { season } = req.query
      if (!season) return res.status(400).json({ error: 'season required' })
      const seasonRow = await database('game_scheduling_seasons').where('id', season).first()
      if (!seasonRow) return res.status(404).json({ error: 'season not found' })
      const boundary = rueckrundeStart(seasonRow)
      const svrzSeasonName = String(seasonRow.season || '').split('/')[0].trim()

      // All-KSCW fixtures this season (both sides our club). Cups excluded like
      // everywhere else in the tool — Art. 27 anchoring is a Vor-/Rückrunde rule,
      // and a cup derby isn't ours to schedule anyway.
      const games = await database('svrz_games')
        .whereIn('status', ['open', 'waitingForApproval'])
        .where('home_club_id', KSCW_SVRZ_CLUB_ID)
        .where('away_club_id', KSCW_SVRZ_CLUB_ID)
        .modify(excludeCupFixtures)
        .modify((q) => { if (svrzSeasonName) q.where('season_name', svrzSeasonName) })
        .orderBy('starting_date_time')

      // Map SVRZ side name → KSCW team (active volleyball teams = current season).
      const normTeamId = (s) =>
        String(s || '').toLowerCase().trim().replace(/^ksc\s+wiedikon\s+/, '').replace(/[^a-z0-9]/g, '')
      const teamRows = await database('teams')
        .where('sport', 'volleyball').where('active', true).select('id', 'name', 'team_id')
      const teamByNorm = new Map()
      const teamByStaticId = new Map()
      for (const t of teamRows) {
        teamByNorm.set(normTeamId(t.name), t)
        const sid = staticIdFromTeamId(t.team_id)
        if (sid != null) teamByStaticId.set(sid, t)
      }
      // Resolve a fixture side to a KSCW team: prefer the stable
      // staticTeamIdentifier (raw), fall back to the SVRZ name label.
      const resolveSide = (g, side, label) => {
        const sid = sideStaticId(g, side)
        if (sid != null && teamByStaticId.has(sid)) return teamByStaticId.get(sid)
        return teamByNorm.get(normTeamId(label))
      }

      const pairKey = (a, b) => `${Math.min(a, b)}:${Math.max(a, b)}`
      const stored = await database('game_scheduling_derbies').where('season', season)
        .select('id', 'team_a', 'team_b', 'leg1_svrz_id', database.raw('leg1_date::text as leg1_date'),
                'leg2_svrz_id', database.raw('leg2_date::text as leg2_date'), 'confirmed')
      const storedByKey = new Map(stored.map((s) => [pairKey(s.team_a, s.team_b), s]))

      const pairs = new Map()
      for (const g of games) {
        const homeT = resolveSide(g, 'home', g.home_team_name)
        const awayT = resolveSide(g, 'away', g.away_team_name)
        if (!homeT || !awayT || homeT.id === awayT.id) continue
        const [a, b] = homeT.id < awayT.id ? [homeT, awayT] : [awayT, homeT]
        const key = pairKey(a.id, b.id)
        if (!pairs.has(key)) pairs.set(key, { team_a: a, team_b: b, legs: [] })
        const raw = g.raw && typeof g.raw === 'object' ? g.raw : null
        // Only surface a value that actually denotes a round/matchday ("Runde N"),
        // not the league/phase label ("Männer 2. Liga" / "Vor- & Rückrunde"). The
        // numeric matchday VM shows in its own UI isn't in our stored feed, so this
        // is null for most league games and the panel simply hides the line then.
        const groupName = raw?.group?.name || ''
        const phaseName = raw?.group?.phase?.name || ''
        const round = /runde/i.test(groupName) ? groupName
          : /runde/i.test(phaseName) ? phaseName : null
        pairs.get(key).legs.push({
          svrz_id: g.svrz_persistence_id,
          display_name: g.display_name,
          home_team: { id: homeT.id, name: homeT.name },
          away_team: { id: awayT.id, name: awayT.name },
          feed_datetime: g.starting_date_time,
          round,
        })
      }

      const derbies = [...pairs.values()].map((p) => {
        const s = storedByKey.get(pairKey(p.team_a.id, p.team_b.id))
        const dateBySvrz = {}
        if (s) {
          if (s.leg1_svrz_id) dateBySvrz[s.leg1_svrz_id] = s.leg1_date
          if (s.leg2_svrz_id) dateBySvrz[s.leg2_svrz_id] = s.leg2_date
        }
        const legs = p.legs.map((lg) => {
          const date = dateBySvrz[lg.svrz_id] || null
          return { ...lg, date, half: date && boundary ? (date < boundary ? 'vorrunde' : 'rueckrunde') : null }
        })
        return {
          team_a: { id: p.team_a.id, name: p.team_a.name },
          team_b: { id: p.team_b.id, name: p.team_b.name },
          legs,
          confirmed: s?.confirmed === true,
          stored_id: s?.id ?? null,
        }
      }).sort((x, y) => (x.team_a.name || '').localeCompare(y.team_a.name || ''))

      res.json({ season: seasonRow.season, boundary, derbies })
    } catch (err) {
      log.error({ msg: `derbies GET: ${err.message}`, endpoint: 'admin/terminplanung/derbies', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /admin/terminplanung/derbies — the spielplaner fixes the two derby
  // dates. Body: { season, team_a, team_b, legs:[{svrz_id, home_team_id, date}, …×2], confirmed }.
  // Confirm requires both dates set and exactly one per half (Vor-/Rückrunde).
  router.post('/admin/terminplanung/derbies', async (req, res) => {
    if (!(await isAdminOrSpielplaner(req))) return res.status(403).json({ error: 'Admin only' })
    try {
      const { season, legs, confirmed } = req.body || {}
      let team_a = parseInt(req.body?.team_a, 10)
      let team_b = parseInt(req.body?.team_b, 10)
      if (!season || !Number.isInteger(team_a) || !Number.isInteger(team_b) || team_a === team_b) {
        return res.status(400).json({ error: 'season, team_a, team_b required' })
      }
      if (!Array.isArray(legs) || legs.length !== 2) {
        return res.status(400).json({ error: 'exactly 2 legs required' })
      }
      const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
      for (const lg of legs) {
        if (lg?.date != null && lg.date !== '' && !DATE_RE.test(String(lg.date))) {
          return res.status(400).json({ error: 'leg date must be YYYY-MM-DD' })
        }
      }
      if (team_a > team_b) { const t = team_a; team_a = team_b; team_b = t }

      const seasonRow = await database('game_scheduling_seasons').where('id', season).first()
      if (!seasonRow) return res.status(404).json({ error: 'season not found' })
      const boundary = rueckrundeStart(seasonRow)

      const wantConfirm = confirmed === true || confirmed === 'true'
      const dates = legs.map((l) => (l?.date ? String(l.date).slice(0, 10) : null))
      if (wantConfirm) {
        if (dates.some((d) => !d)) return res.status(400).json({ error: 'both_dates_required' })
        if (boundary) {
          const halves = dates.map((d) => (d < boundary ? 'v' : 'r')).sort().join('')
          if (halves !== 'rv') return res.status(400).json({ error: 'one_per_half' })
        }
      }
      const homeId = (v) => (Number.isInteger(parseInt(v, 10)) ? parseInt(v, 10) : null)

      const row = {
        season,
        team_a,
        team_b,
        leg1_svrz_id: legs[0].svrz_id || null,
        leg1_home_team: homeId(legs[0].home_team_id),
        leg1_date: dates[0],
        leg2_svrz_id: legs[1].svrz_id || null,
        leg2_home_team: homeId(legs[1].home_team_id),
        leg2_date: dates[1],
        confirmed: wantConfirm,
        date_updated: new Date().toISOString(),
        user_updated: req.accountability?.user || null,
      }
      const existing = await database('game_scheduling_derbies').where({ season, team_a, team_b }).first('id')
      if (existing) {
        await database('game_scheduling_derbies').where('id', existing.id).update(row)
      } else {
        await database('game_scheduling_derbies').insert({ ...row, user_created: req.accountability?.user || null })
      }
      res.json({ success: true, confirmed: wantConfirm })
    } catch (err) {
      log.error({ msg: `derbies POST: ${err.message}`, endpoint: 'admin/terminplanung/derbies', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // GET /kscw/admin/terminplanung/proposal-health?season_id= — live validity of
  // every pending home proposal, so the dashboard can flag rotten slots and
  // surface opponents whose all-three picks are gone (Item 3).
  router.get('/admin/terminplanung/proposal-health', async (req, res) => {
    if (!(await isAdminOrSpielplaner(req))) return res.status(403).json({ error: 'Admin only' })
    try {
      const seasonId = req.query.season_id
      if (!seasonId) return res.status(400).json({ error: 'season_id required' })
      const health = await homeProposalHealth(seasonId, { includeAway: true })
      res.json({ health })
    } catch (err) {
      log.error({ msg: `proposal-health: ${err.message}`, endpoint: 'admin/terminplanung/proposal-health', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // GET /kscw/admin/terminplanung/date-context?kscw_team=&dates=YYYY-MM-DD,… — for
  // the manual-booking form: who'd be absent + how each typed date spaces against
  // the team's nearest already-scheduled games. Per-team read: schedulers who
  // manage the team plus (read-only, v1) its coaches/TRs — who already see their
  // own team's absences in the member app. Returns { context: { [date]: … } }.
  router.get('/admin/terminplanung/date-context', async (req, res) => {
    try {
      const kscwTeam = Number(req.query.kscw_team)
      if (!kscwTeam) return res.status(400).json({ error: 'kscw_team required' })
      if (!(await canViewTeamScheduling(req, kscwTeam))) return res.status(403).json({ error: 'Not authorized for this team' })
      const dates = String(req.query.dates || '')
        .split(',').map((d) => d.trim()).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 6)
      if (!dates.length) return res.json({ context: {} })
      const gameDates = await teamGameDateList(kscwTeam)
      const { absentCountOn, absentNamesOn } = await teamAbsenceLookup(kscwTeam)
      const context = {}
      for (const day of dates) {
        const adj = adjacentGames(gameDates, day)
        context[day] = {
          absences: absentCountOn(day),
          absent_names: absentNamesOn(day),
          prev_game: adj.prev_game,
          next_game: adj.next_game,
        }
      }
      res.json({ context })
    } catch (err) {
      log.error({ msg: `date-context: ${err.message}`, endpoint: 'admin/terminplanung/date-context', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /kscw/admin/terminplanung/request-new-slots — semi-automatic: the admin
  // confirms in the dashboard that an opponent's home proposals are all gone, and
  // this emails them (their language) to pick 3 new slots via their existing link,
  // clearing the dead pending proposal so they re-propose into a clean slate.
  // Body: { opponent_id }. Refuses if any proposal is still valid (race guard).
  router.post('/admin/terminplanung/request-new-slots', async (req, res) => {
    try {
      const opponentId = Number(req.body?.opponent_id)
      // Multi-game: booking_id scopes the re-request to ONE fixture's dead
      // proposal — the opponent's other games keep their proposals/bookings.
      const bookingId = Number(req.body?.booking_id) || null
      if (!opponentId) return res.status(400).json({ error: 'opponent_id required' })
      const opponent = await database('game_scheduling_opponents').where('id', opponentId).first()
      if (!opponent) return res.status(404).json({ error: 'Opponent not found' })
      if (!(await spielplanerCanManageTeam(req, opponent.kscw_team))) return res.status(403).json({ error: 'Not authorized for this team' })
      if (!opponent.contact_email) return res.status(400).json({ error: 'no_contact_email' })

      // Race guard: only re-request if this pending home proposal is genuinely
      // all-dead right now (a slot may have freed up since page load). Also
      // refuse when there's no pending health row at all (`mine` undefined,
      // e.g. the opponent just got confirmed) — re-requesting would wrongly
      // downgrade a booked opponent back to 'viewed'.
      const health = await homeProposalHealth(opponent.season)
      const mine = bookingId
        ? health.find((h) => Number(h.booking_id) === bookingId && h.opponent_id === opponentId)
        : health.find((h) => h.opponent_id === opponentId)
      if (!mine || !mine.all_dead) {
        return res.status(409).json({ error: 'proposals_still_valid' })
      }

      // Clear the dead pending home proposal (so chips/contention clear) and stamp
      // the re-request; reset a booked/viewed/invited opponent to 'viewed' so their
      // link still serves the propose-home flow.
      await database('game_scheduling_bookings')
        .where({ opponent: opponentId, type: 'home_slot_pick', status: 'pending' })
        .modify((q) => { if (bookingId) q.where('id', bookingId) })
        .del()
      await database('game_scheduling_opponents').where('id', opponentId).update({
        status: ['invited', 'viewed', 'booked'].includes(opponent.status) ? 'viewed' : opponent.status,
        new_slots_requested_at: new Date().toISOString(),
      })

      try {
        const team = await database('teams').where('id', opponent.kscw_team).first()
        const kscw = `KSCW ${team?.name || ''}`.trim()
        const opp = opponent.club_name || opponent.team_name || ''
        const url = `${SCHEDULING_URL}/terminplanung/${opponent.token}`
        const { subject, text, html } = schedEmail(opponent.language, 'home_reproposal_request', {
          contact: opponent.contact_name || '', kscw, opp, url,
        })
        await sendSchedulingMail(opponent.contact_email, subject, text, null, html)
        const adminText = `Neue Heimspiel-Slots angefragt bei ${opp} (${kscw}) – alle bisherigen Vorschläge sind nicht mehr verfügbar.`
        await sendSchedulingMail(SCHEDULING_REPLY_TO, `Neue Slots angefragt – ${opp} (${kscw})`, adminText)
      } catch (mailErr) {
        log.warn(`request-new-slots email failed: ${mailErr.message}`)
      }

      res.json({ success: true })
    } catch (err) {
      log.error({ msg: `request-new-slots: ${err.message}`, endpoint: 'admin/terminplanung/request-new-slots', userId: req.accountability?.user || null, method: req.method, stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })
}
