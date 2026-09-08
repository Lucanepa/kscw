/**
 * Mailbox (Terminplanung + club admin)
 *
 * Embedded email client. The "server" is a dedicated Migadu mailbox per account
 * (incoming) + SES SMTP (outgoing). Migadu's send quota is never consumed —
 * only a human sending from Migadu webmail touches it.
 *
 * FOUR accounts (see ACCOUNTS): spielplanung@volleyball.kscw.ch /
 * spielplanung@basketball.kscw.ch
 * for the Spielplanung dashboard, admin@wiedisync.kscw.ch for club
 * correspondence (migration 222), and vis_transfers@mail.kscw.ch for transfer
 * casework. The module name and the `scheduling_emails` table predate all but
 * the first two — `account` is a partition key, not a sport.
 *
 * The club account additionally supports a GROUP SEND (see the bulk route at
 * the bottom): pick an audience, get one personalised message per recipient.
 *
 * Routes come in two families, sharing the same handlers so they can't drift:
 *   /admin/terminplanung/mailbox*  → Spielplanung, account from ?sport=
 *   /admin/mailbox*                → club admin, account pinned
 * The split is a security boundary, not cosmetics: the Spielplanung gate grants
 * is_spielplaner, which must never imply access to the club's general inbox.
 *
 * This module:
 *
 *  - syncs INBOX + Sent over IMAP (imapflow) into `scheduling_emails`,
 *    parsing MIME with mailparser and deduping by Message-ID
 *  - serves the message list / detail to the admin dashboard
 *  - sends replies as raw MIME (nodemailer MailComposer over the container's
 *    EMAIL_SMTP_* transport) so Message-ID + In-Reply-To/References are under
 *    our control, then appends the same bytes to the Migadu Sent folder so
 *    webmail stays consistent
 *  - streams attachment bytes on demand from IMAP (content is never stored)
 *
 * Opponent matching is computed CLIENT-side by address intersection with
 * game_scheduling_opponents.contact_email — no FK, nothing goes stale.
 *
 * Env (feature is dormant without the password — endpoints report
 * configured:false and the cron no-ops):
 *   SCHEDULING_IMAP_HOST      default imap.migadu.com
 *   SCHEDULING_IMAP_PORT      default 993
 *   SCHEDULING_IMAP_USER      default spielplanung@volleyball.kscw.ch
 *   SCHEDULING_IMAP_PASSWORD  required to activate
 *   SCHEDULING_MAILBOX_SYNC_DAYS  IMAP search window, default 60
 *   ADMIN_MAILBOX_IMAP_USER      default admin@wiedisync.kscw.ch
 *   ADMIN_MAILBOX_IMAP_PASSWORD  required to activate the club-admin account
 *   VIS_MAILBOX_IMAP_USER        default vis_transfers@mail.kscw.ch
 *   VIS_MAILBOX_IMAP_PASSWORD    required to activate the VIS-transfers account
 *
 * NB env-file changes need a container RECREATE, not `docker restart` — a
 * restart silently keeps the old env and the account just reports
 * configured:false. See INFRA.md → "Restart Directus (recreate with env file)".
 */

import crypto from 'crypto'
import Busboy from 'busboy'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import nodemailer from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer/index.js'
import { escHtml } from './email-template.js'
import { writeUserLog } from './activity-log.js'
import { MAILBOX_GROUPS, resolveClubdeskRecipients, resolveMemberAudience, resolveRegisterEmails, teamAudienceCounts } from './audience.js'
import { combineClauseSets, parseClauses, parseList, splitSeason } from './mailbox-audience-select.js'
import { loadSuppressed } from './email-suppression.js'
import { deriveMitgliederbeitrag, guestMemberIdSet, FEE_OVERRIDE_FIELDS } from './clubdesk-update.js'
import { currentSeasonShort } from './season.js'
import { applyMergeFields, mergeValues, usedMergeFields } from './merge-fields.js'
import {
  SCHEDULING_SIGNATURE_LIGHT_HTML, SCHEDULING_SIGNATURE_TEXT,
  SCHEDULING_SIGNATURE_BASKETBALL_LIGHT_HTML, SCHEDULING_SIGNATURE_BASKETBALL_TEXT,
  ADMIN_SIGNATURE_LIGHT_HTML, ADMIN_SIGNATURE_TEXT,
} from './scheduling-signature.js'

// Same Migadu server for both mailboxes; only the credentials + From differ.
const IMAP_HOST = process.env.SCHEDULING_IMAP_HOST || 'imap.migadu.com'
const IMAP_PORT = Number(process.env.SCHEDULING_IMAP_PORT || 993)
const SYNC_DAYS = Number(process.env.SCHEDULING_MAILBOX_SYNC_DAYS || 60)

// The two mailbox accounts, keyed by sport. Each is "configured" (live) only
// once its IMAP password env is set — volleyball keeps the original
// SCHEDULING_IMAP_PASSWORD name for back-compat, basketball adds a *_BASKETBALL
// pair. Outgoing mail is sent from each account's own address (DKIM-aligned for
// that account's own domain — volleyball.kscw.ch / basketball.kscw.ch, each an
// SES identity in its own right) with its own branded signature. FROM_NAME stays in sync
// with SCHEDULING_FROM_NAME in game-scheduling.js for the volleyball account.
// Exported so other modules send FROM the same identity instead of re-declaring
// it (basketball-portal.js uses ACCOUNTS.basketball for the club-portal mail).
// Read-only for consumers — mutating an entry would silently reconfigure IMAP.
export const ACCOUNTS = {
  volleyball: {
    sport: 'volleyball',
    imapUser: process.env.SCHEDULING_IMAP_USER || 'spielplanung@volleyball.kscw.ch',
    imapPassword: process.env.SCHEDULING_IMAP_PASSWORD || '',
    fromAddress: 'spielplanung@volleyball.kscw.ch',
    fromName: 'KSCW VB Spielplanung',
    msgIdDomain: 'volleyball.kscw.ch',
    signatureHtml: SCHEDULING_SIGNATURE_LIGHT_HTML,
    signatureText: SCHEDULING_SIGNATURE_TEXT,
    // Google Group the mailbox re-mails inbound correspondence to (option 4:
    // repost AS the mailbox so it authenticates, replacing Migadu's transparent
    // forward that Google spoof-rejects for -all senders). Empty = disabled.
    groupAddress: (process.env.SCHEDULING_GROUP_ADDRESS || 'vb_spieplanung_kscw@googlegroups.com').trim().toLowerCase(),
  },
  basketball: {
    sport: 'basketball',
    imapUser: process.env.SCHEDULING_IMAP_USER_BASKETBALL || 'spielplanung@basketball.kscw.ch',
    imapPassword: process.env.SCHEDULING_IMAP_PASSWORD_BASKETBALL || '',
    fromAddress: 'spielplanung@basketball.kscw.ch',
    fromName: 'KSCW BB Spielplanung',
    msgIdDomain: 'basketball.kscw.ch',
    signatureHtml: SCHEDULING_SIGNATURE_BASKETBALL_LIGHT_HTML,
    signatureText: SCHEDULING_SIGNATURE_BASKETBALL_TEXT,
    groupAddress: (process.env.SCHEDULING_GROUP_ADDRESS_BASKETBALL || '').trim().toLowerCase(),
  },
  // Club-admin mailbox (migration 222). Not a sport — `sport` here is the
  // account key, which is what the field has always really been. Served at its
  // own /admin/mailbox routes rather than /admin/terminplanung/mailbox.
  //
  // ⚠ Sending needs wiedisync.kscw.ch verified as an SES identity AND
  // `include:amazonses.com` in its SPF. That domain is DMARC p=quarantine, so
  // without both, replies fail SPF and are silently quarantined at the receiver
  // — the same failure mode as finance@mail.kscw.ch forwarding via ClubDesk and
  // the Google Group before the option-4 remailer. Nothing surfaces in a log.
  admin: {
    sport: 'admin',
    imapUser: process.env.ADMIN_MAILBOX_IMAP_USER || 'admin@wiedisync.kscw.ch',
    imapPassword: process.env.ADMIN_MAILBOX_IMAP_PASSWORD || '',
    fromAddress: 'admin@wiedisync.kscw.ch',
    fromName: 'KSC Wiedikon',
    msgIdDomain: 'wiedisync.kscw.ch',
    signatureHtml: ADMIN_SIGNATURE_LIGHT_HTML,
    signatureText: ADMIN_SIGNATURE_TEXT,
    // No group repost — that exists to work around Google Groups spoof-rejecting
    // Migadu's transparent forward for the VB scheduling list. Nothing analogous here.
    groupAddress: '',
    // Several admins read this box independently, so one person opening a message
    // must not mark it read for everyone. Reads live in scheduling_email_reads
    // instead of the shared scheduling_emails.read_at (migration 222).
    perUserReads: true,
  },
  // FIVB VIS international-transfer status mails (2026-07-25). Swiss Volley:
  // "jede Handlung am internationalen Transfer löst jeweils ein Status-Mail aus",
  // and the ITC itself arrives by mail — so this inbox is the one transfer signal
  // that survives VIS changing its app, which Swiss Volley warns happens yearly.
  //
  // Read-only in practice: nobody replies to FIVB from here, so there is no SES
  // identity to verify and no group repost. fromAddress is set only because the
  // shared machinery expects one.
  //
  // ⚠ mail.kscw.ch is a DIFFERENT domain from the other three boxes
  // (volleyball.kscw.ch / basketball.kscw.ch / wiedisync.kscw.ch) but the same Migadu tenant — its
  // MX is aspmx1/aspmx2.migadu.com, so SCHEDULING_IMAP_HOST still applies.
  vis_transfers: {
    sport: 'vis_transfers',
    imapUser: process.env.VIS_MAILBOX_IMAP_USER || 'vis_transfers@mail.kscw.ch',
    imapPassword: process.env.VIS_MAILBOX_IMAP_PASSWORD || '',
    fromAddress: 'vis_transfers@mail.kscw.ch',
    fromName: 'KSCW VIS transfers',
    msgIdDomain: 'mail.kscw.ch',
    signatureHtml: ADMIN_SIGNATURE_LIGHT_HTML,
    signatureText: ADMIN_SIGNATURE_TEXT,
    groupAddress: '',
    // Same reasoning as the admin box: several people work transfers, so one
    // opening a mail must not mark it read for everyone.
    perUserReads: true,
  },
}

// Repost commit gate: only actually send to the group when explicitly enabled
// (prod). Anything else (dev, unset) is a dry-run that logs + stamps but never
// posts, so dev never double-posts to the club's real group off the same mailbox.
const GROUP_REPOST_COMMIT = process.env.SCHEDULING_GROUP_REPOST_COMMIT === '1'
// Only repost inbound newer than this (defence-in-depth against a backlog dump;
// migration 178 already seals pre-existing rows). Days.
const GROUP_REPOST_WINDOW_DAYS = Number(process.env.SCHEDULING_GROUP_REPOST_WINDOW_DAYS || 3)

const accountConfigured = (acct) => Boolean(acct && acct.imapPassword)

// Resolve a sport param to an ACCOUNTS entry, defaulting to volleyball for
// back-compat. Returns null for an unknown sport so the route can 400.
//
// `admin` is NOT reachable this way: it isn't a sport, and the Spielplanung
// routes must not become a second door to the club mailbox (their gate grants
// is_spielplaner, which must never imply club-admin mail access). The
// /admin/mailbox routes pin the account explicitly via adminAccount() instead.
function resolveAccount(raw) {
  const sport = String(raw || 'volleyball').toLowerCase()
  if (sport === 'admin') return null
  return ACCOUNTS[sport] || null
}

/** The club-admin mailbox account, for the /admin/mailbox route family. */
function adminAccount() {
  return ACCOUNTS.admin
}

/** Accounts whose read state is per-user (migration 222) rather than the shared read_at. */
const usesPerUserReads = (acct) => acct?.perUserReads === true

// Body columns are text; cap to keep pathological messages from bloating rows.
const MAX_BODY_CHARS = 500_000
const LIST_LIMIT = 500

// Outgoing-attachment limits. SES accepts large messages but many receiving
// servers cap at ~25 MB, so 10 MB total is a safe, generous ceiling for the
// PDFs/schedules opponents actually exchange. Enforced server-side regardless
// of what the frontend allows.
/** AWS SES refuses a message addressed to more than 50 recipients (To+Cc+Bcc
 *  combined). The personalised group run is immune — it is one message per
 *  person — but the single shared Cc/Bcc copy is not, and neither is the plain
 *  reply/compose handler, which builds ONE envelope out of To+Cc. */
const SES_MAX_RECIPIENTS_PER_MESSAGE = 50
/** Ceiling on a single pasted recipient list (POST /admin/mailbox/lookup).
 *  The club has ~700 member addresses, so this is roomy for any real list while
 *  keeping the IN-clause a bounded query. */
const LOOKUP_MAX_ADDRESSES = 1000
const ATTACH_MAX_FILES = 10
const ATTACH_MAX_PER_FILE = 10 * 1024 * 1024
const ATTACH_MAX_TOTAL = 10 * 1024 * 1024

/**
 * Parse a multipart/form-data reply (text fields + attachment files) with
 * busboy. We parse it here rather than letting attachments ride in a JSON body
 * because Directus caps the JSON body parser at MAX_PAYLOAD_SIZE (1 MB default).
 * Resolves { fields, files:[{filename, contentType, content:Buffer}] }; rejects
 * on any limit breach so the route can answer 413.
 */
function parseMultipartReply(req) {
  return new Promise((resolve, reject) => {
    let bb
    try {
      bb = Busboy({ headers: req.headers, limits: { files: ATTACH_MAX_FILES, fileSize: ATTACH_MAX_PER_FILE } })
    } catch (err) { return reject(err) }
    const fields = {}
    const files = []
    let total = 0
    let done = false
    const fail = (err) => { if (!done) { done = true; reject(err); req.unpipe(bb); req.resume() } }
    bb.on('field', (name, val) => { fields[name] = val })
    bb.on('file', (_name, stream, info) => {
      const chunks = []
      let truncated = false
      stream.on('data', (d) => { total += d.length; chunks.push(d) })
      stream.on('limit', () => { truncated = true })
      stream.on('error', fail)
      stream.on('close', () => {
        if (done) return
        if (truncated) return fail(new Error('Attachment too large'))
        if (total > ATTACH_MAX_TOTAL) return fail(new Error('Attachments exceed total size limit'))
        files.push({
          filename: String(info?.filename || 'attachment').replace(/[\r\n"]/g, '').slice(0, 200),
          contentType: info?.mimeType || 'application/octet-stream',
          content: Buffer.concat(chunks),
        })
      })
    })
    bb.on('filesLimit', () => fail(new Error('Too many attachments')))
    bb.on('error', fail)
    bb.on('close', () => { if (!done) { done = true; resolve({ fields, files }) } })
    req.pipe(bb)
  })
}

/**
 * Defence-in-depth scrub of admin-authored reply HTML (the TipTap editor already
 * emits a constrained whitelist; this guards the raw endpoint). Drops scripts/
 * styles/frames, inline event handlers, and javascript:/data: URLs.
 */
function sanitizeOutgoingHtml(html) {
  if (!html) return ''
  return String(html)
    .replace(/<(script|style|iframe|object|embed|link|meta|base)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|style|iframe|object|embed|link|meta|base)\b[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*(?:javascript|data|vbscript):[^"']*\2/gi, '$1=$2#$2')
}

/** Best-effort HTML → plain text for the text/plain MIME part + search/storage. */
function htmlToPlain(html) {
  if (!html) return ''
  return String(html)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<blockquote[^>]*>/gi, '> ')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&(?:#0*39|#x0*27|apos);/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function imapClient(acct) {
  return new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: acct.imapUser, pass: acct.imapPassword },
    logger: false,
  })
}

// Same sanitiser as game-scheduling.js parseRecipients: bare plausible
// addresses only, CR/LF stripped (header-injection defence).
const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/
function cleanAddresses(v) {
  const clean = (s) => String(s).replace(/[\r\n]+/g, '').trim()
  const raw = Array.isArray(v) ? v.map(clean) : clean(v || '').split(/[,;]+/).map((s) => s.trim())
  return raw.filter((s) => s && EMAIL_RE.test(s))
}

// mailparser AddressObject (or array of them) -> flat [{address, name}].
function flattenAddresses(obj) {
  if (!obj) return []
  const list = Array.isArray(obj) ? obj : [obj]
  return list.flatMap((o) => o?.value || []).filter((a) => a?.address)
}

const stripBrackets = (id) => String(id || '').replace(/^<|>$/g, '').trim()

function parsedToRow(parsed, { account, folder, uid, uidValidity, internalDate, direction }) {
  const from = flattenAddresses(parsed.from)[0] || null
  const to = flattenAddresses(parsed.to).map((a) => a.address)
  const cc = flattenAddresses(parsed.cc).map((a) => a.address)
  const refs = Array.isArray(parsed.references) ? parsed.references.join(' ') : (parsed.references || null)
  const attachments = (parsed.attachments || []).map((a, i) => ({
    filename: a.filename || `attachment-${i + 1}`,
    contentType: a.contentType || 'application/octet-stream',
    size: a.size || 0,
  }))
  const messageId = stripBrackets(parsed.messageId) || `${folder}-${uidValidity || 0}-${uid}@sync.local`
  return {
    account,
    message_id: messageId,
    in_reply_to: stripBrackets(parsed.inReplyTo) || null,
    references_ids: refs,
    direction,
    folder,
    imap_uid: uid,
    from_address: from?.address?.toLowerCase() || null,
    from_name: from?.name || null,
    to_addresses: to.map((a) => a.toLowerCase()).join(',') || null,
    cc_addresses: cc.map((a) => a.toLowerCase()).join(',') || null,
    subject: parsed.subject || null,
    body_text: (parsed.text || '').slice(0, MAX_BODY_CHARS) || null,
    body_html: (typeof parsed.html === 'string' ? parsed.html : '').slice(0, MAX_BODY_CHARS) || null,
    has_attachments: attachments.length > 0,
    attachments: attachments.length ? JSON.stringify(attachments) : null,
    date_sent: parsed.date || internalDate || null,
  }
}

// Re-fetch a stored message's parsed attachments live from IMAP (content is
// never stored locally). Shared by the forward path (re-attach the original's
// files) and the single-attachment download route. Throws an Error with a
// `.status` (404/410) when the source can't be resolved to the same message.
async function fetchParsedSource(acct, row) {
  if (!row.folder || !row.imap_uid) { const e = new Error('No IMAP source for this message'); e.status = 410; throw e }
  const client = imapClient(acct)
  await client.connect()
  try {
    const lock = await client.getMailboxLock(row.folder)
    let msg
    try {
      msg = await client.fetchOne(String(row.imap_uid), { source: true }, { uid: true })
    } finally {
      lock.release()
    }
    if (!msg || !msg.source) { const e = new Error('Message no longer at stored IMAP location'); e.status = 410; throw e }
    const parsed = await simpleParser(msg.source)
    // UID reuse safety: make sure we fetched the same message we stored.
    if (stripBrackets(parsed.messageId) !== row.message_id) { const e = new Error('Message no longer at stored IMAP location'); e.status = 410; throw e }
    return parsed
  } finally {
    await client.logout().catch(() => {})
  }
}

async function fetchMessageAttachments(acct, row) {
  return (await fetchParsedSource(acct, row)).attachments || []
}

async function findSentFolder(client) {
  const folders = await client.list()
  const byUse = folders.find((f) => f.specialUse === '\\Sent')
  if (byUse) return byUse.path
  const byName = folders.find((f) => /^sent/i.test(f.path))
  return byName?.path || 'Sent'
}

async function syncFolder(client, database, log, folder, direction, since, acct) {
  const lock = await client.getMailboxLock(folder)
  let processed = 0
  try {
    const uidValidity = client.mailbox?.uidValidity ? String(client.mailbox.uidValidity) : null
    const uids = await client.search({ since }, { uid: true })
    if (!uids || uids.length === 0) return 0
    // Cheap delta: skip UIDs we already hold for this account+folder, so the
    // 10-min cron doesn't re-download the whole window every run. Message-ID
    // conflict handling below stays the actual dedupe (covers moves + app-sent
    // copies). Scoped by account so the two mailboxes never alias UIDs.
    const existing = await database('scheduling_emails')
      .where({ account: acct.sport, folder })
      .whereIn('imap_uid', uids)
      .pluck('imap_uid')
    const existingSet = new Set(existing.map(Number))
    const todo = uids.filter((u) => !existingSet.has(Number(u)))
    for (const uid of todo) {
      try {
        const msg = await client.fetchOne(String(uid), { source: true, internalDate: true }, { uid: true })
        if (!msg || !msg.source) continue
        const parsed = await simpleParser(msg.source)
        const row = parsedToRow(parsed, { account: acct.sport, folder, uid, uidValidity, internalDate: msg.internalDate, direction })
        // App-sent replies are inserted at send time with folder=null; when the
        // Sent sync later sees the appended copy, merge folder/uid back in so
        // attachments stay streamable. Everything else: first writer wins.
        // Dedup is per-account (UNIQUE (account, message_id) — migration 141).
        await database('scheduling_emails')
          .insert(row)
          .onConflict(['account', 'message_id'])
          .merge(['folder', 'imap_uid'])
        processed++
      } catch (err) {
        log.warn(`Mailbox sync: failed to ingest ${acct.sport} ${folder} uid ${uid}: ${err.message}`)
      }
    }
    return processed
  } finally {
    lock.release()
  }
}

// ── Google Group repost (option 4) ────────────────────────────────────────
// Migadu's transparent forward keeps the external sender's From, so Google
// Groups spoof-rejects mail from -all/no-DMARC domains (e.g. svrz.ch) and it
// never posts. Instead we re-mail qualifying inbound AS the mailbox itself
// (DKIM-aligned for volleyball.kscw.ch → authenticates → posts), with
// Reply-To pointed back at the original sender so replies still reach them.

const SWISS_DT = new Intl.DateTimeFormat('de-CH', {
  timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hour12: false,
})
const fmtSwiss = (d) => { try { return SWISS_DT.format(d instanceof Date ? d : new Date(d)) } catch { return '' } }

// Row-level filter (no IMAP fetch): human correspondence only — drop our own
// address, the group itself, and automated system/no-reply/bounce senders.
function repostSkipReason(row, acct) {
  const from = (row.from_address || '').toLowerCase()
  if (!from) return 'no-sender'
  if (from === acct.fromAddress.toLowerCase()) return 'self'
  if (acct.groupAddress && from === acct.groupAddress) return 'group'
  if (/@([^@]*\.)?amazonses\.com$/.test(from)) return 'system-ses'
  if (/@(bounce\.)?noreply\.kscw\.ch$/.test(from)) return 'system-kscw'
  if (/(^|[.+_-])(no-?reply|mailer-daemon|postmaster|bounce|do-?not-?reply)([.+_@-]|$)/.test(from)) return 'system-noreply'
  return null
}

// Header-level loop guard: never repost a message the group (or any list) already
// distributed back to the mailbox. simpleParser exposes headers as a Map.
function isListOrGroupMail(parsed, acct) {
  const h = parsed.headers
  if (!h) return false
  const listId = String(h.get('list-id') || '').toLowerCase()
  if (listId && (/googlegroups\.com/.test(listId) || (acct.groupAddress && listId.includes(acct.groupAddress.split('@')[0])))) return true
  if (h.get('x-google-group-id') || h.get('list-post')) return true
  if (String(h.get('x-kscw-group-repost') || '') === '1') return true
  return false
}

// Compose the reposted message as the mailbox (raw MIME, ready for SMTP).
function buildGroupRepostRaw(parsed, row, acct) {
  const orig = flattenAddresses(parsed.from)[0] || { address: row.from_address, name: row.from_name }
  const origAddr = (orig.address || row.from_address || '').trim()
  const origName = orig.name || origAddr || 'Unknown'
  const subject = String(parsed.subject || row.subject || '(no subject)').replace(/[\r\n]+/g, ' ').slice(0, 300)
  const when = parsed.date || row.date_sent
  const headerLines = [
    `From: ${origName} <${origAddr}>`,
    ...(when ? [`Date: ${fmtSwiss(when)}`] : []),
    `Subject: ${subject}`,
    ...(row.to_addresses ? [`To: ${row.to_addresses}`] : []),
  ]

  const origText = (parsed.text || htmlToPlain(typeof parsed.html === 'string' ? parsed.html : '') || '').trim()
  const text = `[Reposted by KSCW Spielplanung — reply goes to ${origAddr}]\n\n` +
    headerLines.join('\n') + `\n\n` + origText

  const origHtml = (typeof parsed.html === 'string' && parsed.html.trim())
    ? sanitizeOutgoingHtml(parsed.html)
    : escHtml(origText).replace(/\n/g, '<br>')
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;font-size:14px;line-height:1.5">` +
    `<div style="font-size:12px;color:#64748b;margin-bottom:10px">Reposted by KSCW Spielplanung — replies go to ${escHtml(origAddr)}.</div>` +
    `<div style="border-left:3px solid #cbd5e1;padding-left:12px;color:#334155;font-size:12px;margin-bottom:12px">` +
    headerLines.map((l) => `<div>${escHtml(l)}</div>`).join('') +
    `</div><div>${origHtml}</div></div>`

  // Preserve attachments (incl. inline CID images) unless they blow the cap, in
  // which case drop them all and note it rather than fail the repost.
  let attachments = (parsed.attachments || []).map((a, i) => ({
    filename: a.filename || `attachment-${i + 1}`,
    content: a.content,
    contentType: a.contentType || 'application/octet-stream',
    ...(a.contentId ? { cid: stripBrackets(a.contentId) } : {}),
    ...(a.contentDisposition === 'inline' ? { contentDisposition: 'inline' } : {}),
  }))
  const total = attachments.reduce((n, a) => n + (a.content?.length || 0), 0)
  let bodyHtml = html
  if (attachments.length > ATTACH_MAX_FILES || total > ATTACH_MAX_TOTAL) {
    attachments = []
    bodyHtml = html.replace('</div></div>', '</div><div style="margin-top:10px;font-size:12px;color:#b45309">[Attachments omitted — too large to repost; see the mailbox.]</div></div>')
  }

  // Thread the repost into the original's conversation so group replies chain.
  const inReplyTo = row.message_id && !row.message_id.endsWith('@sync.local') ? `<${row.message_id}>` : undefined
  const references = [row.references_ids, inReplyTo].filter(Boolean).join(' ') || undefined

  const composer = new MailComposer({
    // Just the original sender's name — Google Groups appends its own
    // "via VB Spielplanung KSCW" wrapper, so an extra "(via …)" here doubles it.
    from: { name: origName, address: acct.fromAddress },
    to: acct.groupAddress,
    replyTo: origAddr || undefined,
    subject,
    text,
    html: bodyHtml,
    attachments: attachments.length ? attachments : undefined,
    messageId: `<${crypto.randomUUID()}@${acct.msgIdDomain}>`,
    inReplyTo,
    references,
    headers: { 'X-KSCW-Group-Repost': '1' },
  })
  return composer.compile().build()
}

const stampReposted = (database, id) =>
  database('scheduling_emails').where({ id }).update({ group_reposted_at: new Date().toISOString() })

// Repost newly-arrived inbound correspondence to the account's Google Group.
// Called from the mailbox cron after INBOX sync. Best-effort; never throws.
async function repostInboundToGroup(database, log, acct) {
  if (!acct.groupAddress) return { reposted: 0, skipped: 0 }
  const since = new Date(Date.now() - GROUP_REPOST_WINDOW_DAYS * 86400000).toISOString()
  const rows = await database('scheduling_emails')
    .where({ account: acct.sport, direction: 'in' })
    .whereNull('group_reposted_at')
    .where('date_sent', '>=', since)
    .orderBy('date_sent', 'asc')
    .limit(15)
  let reposted = 0, skipped = 0
  for (const row of rows) {
    const reason = repostSkipReason(row, acct)
    if (reason) { await stampReposted(database, row.id); skipped++; continue }
    let parsed
    try {
      parsed = await fetchParsedSource(acct, row)
    } catch (err) {
      // Source gone/moved — stamp so we don't retry a dead pointer every run.
      await stampReposted(database, row.id)
      log.warn(`Group repost: source unavailable for ${row.message_id}: ${err.message}`)
      continue
    }
    if (isListOrGroupMail(parsed, acct)) { await stampReposted(database, row.id); skipped++; continue }
    try {
      const raw = await buildGroupRepostRaw(parsed, row, acct)
      if (GROUP_REPOST_COMMIT) {
        const transport = nodemailer.createTransport({
          host: process.env.EMAIL_SMTP_HOST,
          port: Number(process.env.EMAIL_SMTP_PORT || 587),
          secure: String(process.env.EMAIL_SMTP_SECURE) === 'true',
          auth: { user: process.env.EMAIL_SMTP_USER, pass: process.env.EMAIL_SMTP_PASSWORD },
        })
        await transport.sendMail({ envelope: { from: acct.fromAddress, to: [acct.groupAddress] }, raw })
        log.info(`Group repost: posted ${acct.sport} ${row.message_id} → ${acct.groupAddress}`)
        reposted++
      } else {
        log.info(`Group repost [dry-run]: would post ${acct.sport} ${row.message_id} (from ${row.from_address}) → ${acct.groupAddress}`)
      }
      await stampReposted(database, row.id)
    } catch (err) {
      // Transient send failure: leave unstamped so the next cron retries (bounded
      // by the window). A permanently-bad message ages out after the window.
      log.warn(`Group repost: send failed for ${row.message_id}: ${err.message}`)
    }
  }
  return { reposted, skipped }
}

// Per-account run guard so one stuck mailbox never blocks the other.
const syncRunningFor = new Set()

// In-flight guard for the club-admin GROUP SEND (POST /admin/mailbox/bulk),
// keyed by account + a hash of the audience and the message. A club-wide run
// spends more than a minute inside its per-recipient loop and nothing about the
// request is idempotent, so without this a retried or double-clicked Send mails
// every recipient a second time. Claimed before the first message goes out,
// released in the route's `finally`, and it dies with the process — so a
// crashed run can never wedge an audience out of a later send.
// Process-local by necessity: no unique constraint on `scheduling_emails` can
// arbitrate here (message_id is a fresh UUID per run, so ON CONFLICT can never
// see the duplicate) and this change adds no migration. Directus runs as ONE
// container, so a process-local set genuinely covers every actor pair — the
// retrying admin and a second admin alike. It would NOT survive scaling to
// multiple instances; that needs a claim row behind a partial unique index,
// the way finance.js does it for the dues send.
const bulkSendRunningFor = new Set()

// Sync the configured mailbox accounts (INBOX + Sent each). `onlySport` limits
// the run to one account (a UI "Check now" for the active toggle); omitted (the
// cron) syncs every configured account. One IMAP login per account, sequential.
export async function runMailboxSync(database, log, onlySport = null) {
  const accounts = Object.values(ACCOUNTS).filter(
    (a) => accountConfigured(a) && (!onlySport || a.sport === onlySport),
  )
  if (accounts.length === 0) return { configured: false, processed: 0, accounts: [] }
  const results = []
  for (const acct of accounts) {
    if (syncRunningFor.has(acct.sport)) { results.push({ account: acct.sport, skipped: 'already_running' }); continue }
    syncRunningFor.add(acct.sport)
    const client = imapClient(acct)
    try {
      await client.connect()
      const since = new Date(Date.now() - SYNC_DAYS * 86400000)
      const sentFolder = await findSentFolder(client)
      const inbox = await syncFolder(client, database, log, 'INBOX', 'in', since, acct)
      const sent = await syncFolder(client, database, log, sentFolder, 'out', since, acct)
      // Re-mail freshly-arrived correspondence to the Google Group (best-effort;
      // its own IMAP/SMTP, so a repost hiccup never fails the sync itself).
      let groupReposted = 0
      try {
        const r = await repostInboundToGroup(database, log, acct)
        groupReposted = r.reposted
      } catch (err) {
        log.warn(`Group repost (${acct.sport}) failed: ${err.message}`)
      }
      results.push({ account: acct.sport, processed: inbox + sent, groupReposted })
    } catch (err) {
      log.warn(`Mailbox sync (${acct.sport}) failed: ${err.message}`)
      results.push({ account: acct.sport, error: err.message })
    } finally {
      syncRunningFor.delete(acct.sport)
      await client.logout().catch(() => {})
    }
  }
  const processed = results.reduce((n, r) => n + (r.processed || 0), 0)
  return { configured: true, processed, accounts: results }
}

export function registerSchedulingMailbox(router, { database, logger }) {
  const log = logger.child({ endpoint: 'scheduling-mailbox' })

  // Per-sport gate. The mailbox is the club's shared scheduling identity (no
  // per-team scoping), but the two accounts are gated by sport:
  //   volleyball → Directus superadmin OR app admin/vb_admin OR is_spielplaner
  //                (preserves the original mailbox behaviour — is_spielplaner is
  //                the club-wide volleyball-scheduler grant)
  //   basketball → Directus superadmin OR app admin/bb_admin
  // So a vb_admin can't touch the basketball mailbox and vice-versa.
  //   admin      → Directus superadmin OR app admin/superuser ONLY (the
  //                admin/superuser early-return below is the whole grant).
  //                Deliberately NOT vorstand, is_spielplaner, vb_admin or
  //                bb_admin: the club inbox carries general correspondence, and
  //                a scheduler or a sport-scoped admin has no business in it.
  //                Board access was considered and explicitly rejected.
  //                ⚠ If you widen this, widen the frontend guard on
  //                /admin/mailbox in the same commit or people get a 403 from a
  //                nav item they can see.
  async function authForAccount(req, key) {
    if (req.accountability?.admin) return true
    const userId = req.accountability?.user
    if (!userId) return false
    const member = await database('members').where('user', userId).select('role', 'is_spielplaner').first()
    if (!member) return false
    const roles = member.role ? (typeof member.role === 'string' ? JSON.parse(member.role) : member.role) : []
    if (roles.includes('admin') || roles.includes('superuser')) return true
    if (key === 'volleyball') return roles.includes('vb_admin') || member.is_spielplaner === true
    if (key === 'basketball') return roles.includes('bb_admin')
    // Transfers are per-sport casework handled by the sport TK, which is exactly
    // the audience of /admin/transfers — so the sport admins get this box too.
    // Deliberately NOT is_spielplaner: scheduling a fixture is unrelated to a
    // player's international eligibility.
    if (key === 'vis_transfers') return roles.includes('vb_admin') || roles.includes('bb_admin')
    // No `admin` branch by design — admin/superuser already returned true above,
    // and nothing below that tier may read the club inbox.
    return false
  }

  /** members.id for the caller — the per-user read state keys on it. */
  async function callerMemberId(req) {
    const userId = req.accountability?.user
    if (!userId) return null
    const m = await database('members').where('user', userId).first('id')
    return m?.id ?? null
  }

  /**
   * Overlay per-user read state onto a list of rows. For per-user accounts the
   * shared scheduling_emails.read_at is meaningless, so it's replaced wholesale
   * by this member's own read row (or null). No-op for the Spielplanung accounts.
   */
  async function applyReadState(acct, memberId, rows) {
    if (!usesPerUserReads(acct) || rows.length === 0) return rows
    if (!memberId) { rows.forEach((r) => { r.read_at = null }); return rows }
    const reads = await database('scheduling_email_reads')
      .where('member', memberId)
      .whereIn('email', rows.map((r) => r.id))
      .select('email', 'read_at')
    const byId = new Map(reads.map((r) => [r.email, r.read_at]))
    rows.forEach((r) => { r.read_at = byId.get(r.id) ?? null })
    return rows
  }

  /** Unread inbound count for this account, honouring per-user reads. */
  async function unreadCount(acct, memberId) {
    if (usesPerUserReads(acct)) {
      // No linked members row — a bare Directus superadmin (an ops identity, not
      // a daily reader; every app admin/superuser has a member row by
      // construction, since the role lives on members.role). Per-user reads have
      // nothing to key on, and applyReadState already reports every row as
      // unread — so count them all rather than returning 0, which would
      // contradict the list in the same response. Such a caller can read but
      // can't persist a read (markRead no-ops), so the count simply stays put.
      if (!memberId) {
        const [{ count }] = await database('scheduling_emails')
          .where({ account: acct.sport, direction: 'in' })
          .count('id as count')
        return Number(count)
      }
      const [{ count }] = await database('scheduling_emails as e')
        .where({ 'e.account': acct.sport, 'e.direction': 'in' })
        .whereNotExists(function () {
          this.select(database.raw('1')).from('scheduling_email_reads as r')
            .whereRaw('r.email = e.id').where('r.member', memberId)
        })
        .count('e.id as count')
      return Number(count)
    }
    const [{ count }] = await database('scheduling_emails')
      .where({ account: acct.sport, direction: 'in' })
      .whereNull('read_at')
      .count('id as count')
    return Number(count)
  }

  /** Mark inbound `row` read for this caller. Returns the read timestamp. */
  async function markRead(acct, memberId, row) {
    const now = new Date().toISOString()
    if (usesPerUserReads(acct)) {
      if (!memberId) return null
      await database('scheduling_email_reads')
        .insert({ email: row.id, member: memberId, read_at: now })
        .onConflict(['email', 'member']).ignore()
      const existing = await database('scheduling_email_reads')
        .where({ email: row.id, member: memberId }).first('read_at')
      return existing?.read_at ?? now
    }
    await database('scheduling_emails').where('id', row.id).update({ read_at: now })
    return now
  }

  async function authForSport(req, sport) {
    return authForAccount(req, sport)
  }

  const fail = (res, route, err, req) => {
    log.error({ msg: `${route}: ${err.message}`, endpoint: route, userId: req.accountability?.user || null, method: req.method, stack: err.stack })
    res.status(500).json({ error: 'Internal error' })
  }

  // Every mailbox route below is registered TWICE: under
  // /admin/terminplanung/mailbox (Spielplanung — account from ?sport=) and under
  // /admin/mailbox (the club-admin account, pinned). The handlers are shared, so
  // the two families can't drift; only account resolution differs.
  const schedulingAccount = (req) => resolveAccount(req.query.sport)
  const pinnedAdmin = () => adminAccount()

  // GET /kscw/{admin/terminplanung/mailbox,admin/mailbox} — message list (no
  // bodies) + unread count + last sync heartbeat. Opponent matching happens in
  // the frontend.
  const listHandler = (getAcct) => async (req, res) => {
    const acct = getAcct(req)
    if (!acct) return res.status(400).json({ error: 'Unknown mailbox' })
    if (!(await authForAccount(req, acct.sport))) return res.status(403).json({ error: 'Admin only' })
    try {
      if (!accountConfigured(acct)) return res.json({ configured: false, unread: 0, messages: [], last_sync: null })
      const memberId = usesPerUserReads(acct) ? await callerMemberId(req) : null
      // Optional full-text search: subject + sender/recipient AND body_text.
      // ≥2 chars to avoid scanning the whole table on a single keystroke; LIKE
      // wildcards in the term are escaped so they're matched literally.
      const search = String(req.query.search || '').trim().slice(0, 100)
      let q = database('scheduling_emails')
        .where({ account: acct.sport })
        .select('id', 'direction', 'from_address', 'from_name', 'to_addresses', 'cc_addresses', 'subject', 'date_sent', 'read_at', 'has_attachments', 'in_reply_to', 'message_id', 'assigned_opponent',
          database.raw('left(coalesce(body_text, \'\'), 160) as snippet'))
      if (search.length >= 2) {
        const like = `%${search.replace(/[\\%_]/g, '\\$&')}%`
        q = q.where((b) => {
          b.whereRaw("coalesce(body_text, '') ilike ?", [like])
            .orWhereRaw("coalesce(subject, '') ilike ?", [like])
            .orWhereRaw("coalesce(from_name, '') ilike ?", [like])
            .orWhereRaw("coalesce(from_address, '') ilike ?", [like])
            .orWhereRaw("coalesce(to_addresses, '') ilike ?", [like])
        })
      }
      const rows = await q
        .orderBy([{ column: 'date_sent', order: 'desc', nulls: 'last' }])
        .limit(LIST_LIMIT)
      await applyReadState(acct, memberId, rows)
      const unread = await unreadCount(acct, memberId)
      const sync = await database('sync_runs').where({ source: 'mailbox_sync' }).first().catch(() => null)
      // The signature the server appends to every outgoing message from this
      // account. Returned here — on the call every panel already makes — so the
      // composer can SHOW it in all modes (reply included) without a second
      // request, and without paying for /groups, which resolves ~45 audiences.
      res.json({ configured: true, unread, messages: rows, last_sync: sync?.last_run_at || null, signature_html: acct.signatureHtml })
    } catch (err) { fail(res, 'mailbox/list', err, req) }
  }
  router.get('/admin/terminplanung/mailbox', listHandler(schedulingAccount))
  router.get('/admin/mailbox', listHandler(pinnedAdmin))

  // GET .../mailbox/message/:id — full body; opening an inbound message IS the
  // read action. For the Spielplanung accounts that stamps the shared read_at;
  // for the admin account it writes this caller's own read row instead, so one
  // admin reading doesn't mark it read for the rest of the board.
  const messageHandler = (getAcct) => async (req, res) => {
    const acct = getAcct(req)
    if (!acct) return res.status(400).json({ error: 'Unknown mailbox' })
    if (!(await authForAccount(req, acct.sport))) return res.status(403).json({ error: 'Admin only' })
    try {
      const row = await database('scheduling_emails').where({ id: Number(req.params.id), account: acct.sport }).first()
      if (!row) return res.status(404).json({ error: 'Message not found' })
      const memberId = usesPerUserReads(acct) ? await callerMemberId(req) : null
      if (usesPerUserReads(acct)) await applyReadState(acct, memberId, [row])
      if (row.direction === 'in' && !row.read_at) {
        row.read_at = await markRead(acct, memberId, row)
      }
      res.json({ message: row })
    } catch (err) { fail(res, 'mailbox/message', err, req) }
  }
  router.get('/admin/terminplanung/mailbox/message/:id', messageHandler(schedulingAccount))
  router.get('/admin/mailbox/message/:id', messageHandler(pinnedAdmin))

  // POST /kscw/admin/terminplanung/mailbox/assign — manual opponent override.
  // Body: { ids: number[], opponent_id: number|null }. Pins a whole email chain
  // to one opponent row (the frontend computes the thread's message ids); pass
  // opponent_id:null to clear back to auto-classification. Actor-logged per the
  // audit rule (raw-knex write bypasses the items-API audit hook).
  router.post('/admin/terminplanung/mailbox/assign', async (req, res) => {
    // Opponent assignment is volleyball-only — basketball has no opponent rows.
    const acct = resolveAccount(req.query.sport ?? (req.body && req.body.sport))
    if (!acct) return res.status(400).json({ error: 'Unknown sport' })
    if (acct.sport !== 'volleyball') return res.status(400).json({ error: 'Opponent assignment is volleyball-only' })
    if (!(await authForSport(req, acct.sport))) return res.status(403).json({ error: 'Admin only' })
    try {
      const body = req.body || {}
      const ids = Array.isArray(body.ids)
        ? [...new Set(body.ids.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 500)
        : []
      if (ids.length === 0) return res.status(400).json({ error: 'No message ids' })

      // null / 0 / '' → clear the override. Otherwise the opponent must exist
      // (soft reference, so we validate here instead of via an FK).
      let opponentId = null
      if (body.opponent_id != null && String(body.opponent_id) !== '') {
        opponentId = Number(body.opponent_id)
        if (!Number.isInteger(opponentId) || opponentId <= 0) return res.status(400).json({ error: 'Invalid opponent_id' })
        const opp = await database('game_scheduling_opponents').where('id', opponentId).first('id')
        if (!opp) return res.status(404).json({ error: 'Opponent not found' })
      }

      const updated = await database('scheduling_emails').where({ account: 'volleyball' }).whereIn('id', ids).update({ assigned_opponent: opponentId })
      await writeUserLog(database, log, {
        accountability: req.accountability,
        action: 'update',
        collection: 'scheduling_emails',
        recordId: ids.join(','),
        data: { kind: 'mailbox_assign', opponent: opponentId, count: updated },
      })
      res.json({ success: true, updated })
    } catch (err) { fail(res, 'admin/terminplanung/mailbox/assign', err, req) }
  })

  // POST /kscw/admin/terminplanung/mailbox/sync — pull now. The UI passes the
  // active toggle's `sport` → sync only that account (gated for that sport). The
  // cron passes no sport → must be a Directus admin (the cron service token is)
  // → sync every configured account.
  router.post('/admin/terminplanung/mailbox/sync', async (req, res) => {
    const sportRaw = req.query.sport ?? (req.body && req.body.sport)
    try {
      if (sportRaw != null && String(sportRaw) !== '') {
        const acct = resolveAccount(sportRaw)
        if (!acct) return res.status(400).json({ error: 'Unknown sport' })
        if (!(await authForSport(req, acct.sport))) return res.status(403).json({ error: 'Admin only' })
        return res.json(await runMailboxSync(database, log, acct.sport))
      }
      if (!req.accountability?.admin) return res.status(403).json({ error: 'Admin only' })
      res.json(await runMailboxSync(database, log))
    } catch (err) { fail(res, 'admin/terminplanung/mailbox/sync', err, req) }
  })

  // POST /kscw/admin/mailbox/sync — "Check now" for the club mailbox only. No
  // no-account branch here: the cron's sync-everything path stays on the
  // terminplanung route, which already syncs every configured account (incl.
  // this one, since runMailboxSync iterates ACCOUNTS).
  router.post('/admin/mailbox/sync', async (req, res) => {
    const acct = adminAccount()
    if (!(await authForAccount(req, acct.sport))) return res.status(403).json({ error: 'Admin only' })
    try {
      res.json(await runMailboxSync(database, log, acct.sport))
    } catch (err) { fail(res, 'admin/mailbox/sync', err, req) }
  })

  // POST /kscw/admin/terminplanung/mailbox/reply — compose + send (also handles
  // reply-all via `cc`, and forward via `forward_from_id`/`forward_attach_indices`,
  // which re-attaches the source message's files from IMAP). The active account
  // comes from `?sport=` (query, so auth runs before the multipart body is read;
  // defaults to volleyball for legacy callers). Raw MIME via MailComposer so we
  // own Message-ID + threading headers; sent over the container's SES SMTP
  // (DKIM-aligned for the account's own domain), then appended to Migadu Sent.
  const replyHandler = (getAcct) => async (req, res) => {
    const acct = getAcct(req)
    if (!acct) return res.status(400).json({ error: 'Unknown mailbox' })
    if (!(await authForAccount(req, acct.sport))) return res.status(403).json({ error: 'Admin only' })
    try {
      if (!accountConfigured(acct)) return res.status(409).json({ error: 'Mailbox not configured' })

      // The compose dialog now posts multipart/form-data (rich-text HTML body +
      // file attachments). A plain JSON body is still accepted for callers that
      // send a text-only reply.
      let body = req.body || {}
      let uploads = []
      if (String(req.headers['content-type'] || '').includes('multipart/form-data')) {
        try {
          const parsed = await parseMultipartReply(req)
          body = parsed.fields
          uploads = parsed.files
        } catch (err) {
          return res.status(413).json({ error: err.message || 'Attachment upload failed' })
        }
      }

      // Strip our own mailbox address out of To/Cc (reply-all would otherwise
      // mail the account back, doubling rows), and de-dupe a To↔Cc overlap.
      const self = acct.fromAddress.toLowerCase()
      const to = cleanAddresses(body.to).filter((a) => a.toLowerCase() !== self)
      const toSet = new Set(to.map((a) => a.toLowerCase()))
      const cc = cleanAddresses(body.cc).filter((a) => a.toLowerCase() !== self && !toSet.has(a.toLowerCase()))
      // One message, one envelope — so this path carries the transport's
      // per-message ceiling. Said plainly here, because the alternative is an
      // SES rejection whose text does not mention the group send that exists
      // precisely to mail more people than this.
      if (to.length + cc.length > SES_MAX_RECIPIENTS_PER_MESSAGE) {
        return res.status(400).json({
          error: `A single email cannot have more than ${SES_MAX_RECIPIENTS_PER_MESSAGE} recipients `
            + `(got ${to.length + cc.length}). Use "Email a group" — it sends one message per person.`,
        })
      }
      const subject = String(body.subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 300)

      // Body: rich-text HTML (TipTap) is primary; fall back to a plain-text body
      // (legacy/JSON callers) wrapped to HTML. Plain text is always derived for
      // the text/plain MIME part + storage/search.
      const rawHtml = String(body.html || '').slice(0, 200_000)
      const legacyText = String(body.text || '').slice(0, 50_000)
      let bodyContentHtml = ''
      let plainContent = ''
      if (rawHtml.trim()) {
        bodyContentHtml = sanitizeOutgoingHtml(rawHtml)
        plainContent = htmlToPlain(bodyContentHtml)
      } else if (legacyText.trim()) {
        bodyContentHtml = escHtml(legacyText).replace(/\n/g, '<br>')
        plainContent = legacyText
      }
      if (!to.length) return res.status(400).json({ error: 'No valid recipient' })
      if (!subject || !bodyContentHtml.trim()) return res.status(400).json({ error: 'subject and body required' })

      // Threading: chain References from the replied-to message (same account).
      // A forward (forward_from_id) starts a NEW thread, so it never sets these.
      let inReplyTo, references
      if (body.reply_to_id && !body.forward_from_id) {
        const parent = await database('scheduling_emails').where({ id: Number(body.reply_to_id), account: acct.sport }).first()
        if (parent?.message_id && !parent.message_id.endsWith('@sync.local')) {
          inReplyTo = `<${parent.message_id}>`
          references = [parent.references_ids, `<${parent.message_id}>`].filter(Boolean).join(' ')
        }
      }

      // Forward: re-attach the source message's files, fetched live from IMAP so
      // the user doesn't have to re-download + re-upload each one. Optional
      // forward_attach_indices (JSON array / comma list) selects a subset.
      let forwardedAtt = []
      if (body.forward_from_id) {
        const src = await database('scheduling_emails').where({ id: Number(body.forward_from_id), account: acct.sport }).first()
        if (!src) return res.status(404).json({ error: 'Forward source not found' })
        let picked = null
        if (body.forward_attach_indices != null && String(body.forward_attach_indices) !== '') {
          try { picked = JSON.parse(body.forward_attach_indices) } catch { picked = String(body.forward_attach_indices).split(',') }
          picked = new Set((Array.isArray(picked) ? picked : []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0))
        }
        try {
          const srcAtt = await fetchMessageAttachments(acct, src)
          forwardedAtt = srcAtt
            .map((a, i) => ({ a, i }))
            .filter(({ i }) => !picked || picked.has(i))
            .map(({ a, i }) => ({ filename: a.filename || `attachment-${i + 1}`, content: a.content, contentType: a.contentType || 'application/octet-stream' }))
        } catch (err) {
          return res.status(err.status || 502).json({ error: err.message || 'Could not load forwarded attachments' })
        }
      }

      // Append the account's Spielplanung signature: plain-text on the text part,
      // and a light HTML part (rich body → HTML + branded signature card).
      const textWithSig = `${plainContent}\n\n${acct.signatureText}`
      const htmlBody =
        `<div style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;font-size:14px;line-height:1.5">` +
        `${bodyContentHtml}` +
        `</div><br>` +
        acct.signatureHtml

      const attachments = [
        ...uploads.map((u) => ({ filename: u.filename, content: u.content, contentType: u.contentType })),
        ...forwardedAtt,
      ]
      // Enforce the outgoing caps across the COMBINED set (uploads + forwarded).
      if (attachments.length > ATTACH_MAX_FILES) return res.status(413).json({ error: 'Too many attachments' })
      let attachTotal = 0
      for (const a of attachments) {
        const sz = a.content?.length || 0
        if (sz > ATTACH_MAX_PER_FILE) return res.status(413).json({ error: 'Attachment too large' })
        attachTotal += sz
      }
      if (attachTotal > ATTACH_MAX_TOTAL) return res.status(413).json({ error: 'Attachments exceed total size limit' })

      const messageId = `<${crypto.randomUUID()}@${acct.msgIdDomain}>`
      const composer = new MailComposer({
        from: { name: acct.fromName, address: acct.fromAddress },
        to, cc: cc.length ? cc : undefined, subject, text: textWithSig, html: htmlBody,
        attachments: attachments.length ? attachments : undefined,
        messageId, inReplyTo, references,
      })
      const raw = await composer.compile().build()

      const transport = nodemailer.createTransport({
        host: process.env.EMAIL_SMTP_HOST,
        port: Number(process.env.EMAIL_SMTP_PORT || 587),
        secure: String(process.env.EMAIL_SMTP_SECURE) === 'true',
        auth: { user: process.env.EMAIL_SMTP_USER, pass: process.env.EMAIL_SMTP_PASSWORD },
      })
      await transport.sendMail({ envelope: { from: acct.fromAddress, to: [...to, ...cc] }, raw })

      // Best-effort: mirror into the account's Migadu Sent folder so webmail
      // stays the full record. UIDPLUS gives us folder/uid for attachment
      // streaming; failure here never fails the send (the row below still logs it).
      let folder = null
      let imapUid = null
      try {
        const client = imapClient(acct)
        await client.connect()
        try {
          const sentFolder = await findSentFolder(client)
          const appended = await client.append(sentFolder, raw, ['\\Seen'])
          folder = sentFolder
          imapUid = appended?.uid || null
        } finally {
          await client.logout().catch(() => {})
        }
      } catch (err) {
        log.warn(`Mailbox reply: sent OK but Sent-folder append failed: ${err.message}`)
      }

      const [inserted] = await database('scheduling_emails')
        .insert({
          account: acct.sport,
          message_id: stripBrackets(messageId),
          in_reply_to: stripBrackets(inReplyTo) || null,
          references_ids: references || null,
          direction: 'out',
          folder,
          imap_uid: imapUid,
          from_address: acct.fromAddress,
          from_name: acct.fromName,
          to_addresses: to.join(','),
          cc_addresses: cc.join(',') || null,
          subject,
          body_text: textWithSig,
          body_html: htmlBody,
          has_attachments: attachments.length > 0,
          attachments: attachments.length
            ? JSON.stringify(attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.content.length })))
            : null,
          date_sent: new Date().toISOString(),
          read_at: new Date().toISOString(),
        })
        .onConflict(['account', 'message_id'])
        .ignore()
        .returning('id')
      const sentId = inserted?.id ?? inserted ?? null
      // Actor trail: sending an email + appending to Sent is a state change. Log a
      // minimal summary only (never the body/attachment bytes).
      await writeUserLog(database, log, {
        accountability: req.accountability,
        action: 'send',
        collection: 'scheduling_emails',
        recordId: sentId,
        data: {
          kind: 'mailbox_reply',
          account: acct.sport,
          to: to.join(','),
          cc: cc.join(',') || null,
          subject,
          reply_to_id: body.reply_to_id ? Number(body.reply_to_id) : null,
          forward_from_id: body.forward_from_id ? Number(body.forward_from_id) : null,
          attachments: attachments.length,
        },
      })
      res.json({ success: true, id: sentId })
    } catch (err) { fail(res, 'mailbox/reply', err, req) }
  }
  router.post('/admin/terminplanung/mailbox/reply', replyHandler(schedulingAccount))
  router.post('/admin/mailbox/reply', replyHandler(pinnedAdmin))

  // ── Group send (club mailbox only) ──────────────────────────────────────
  //
  // Mailing a team or a subgroup, the way ClubDesk does it. Two properties make
  // this different from the reply handler above, and both are the point:
  //
  //  1. ONE MESSAGE PER RECIPIENT, never one message with N addresses in To.
  //     A 149-address header discloses every member's address to every other
  //     member, can't be personalised, and gives no per-recipient delivery
  //     signal. The cost is N sends, which a pooled transport absorbs.
  //  2. The audience comes from the SHARED resolver (audience.js) that the
  //     announcement fanout uses, so "all Schreiber" means the same set of
  //     people in both places.
  //
  // Deliberately registered on the /admin/mailbox family ONLY. The Spielplanung
  // gate grants is_spielplaner, which must never imply the ability to mail the
  // whole club.

  /** Resolve a group key (fixed group or `team:<id>`) to how it should be
   *  resolved: an audience spec against `members`, or the ClubDesk contact
   *  register. Unknown keys return null and the caller rejects the whole
   *  request — a typo must never silently shrink OR widen the audience. */
  function sourceForGroup(key) {
    const raw = String(key || '')
    if (raw.startsWith('team:')) {
      const id = Number(raw.slice(5))
      if (!Number.isFinite(id)) return null
      return { section: 'teams', spec: { audience_type: 'teams', audience_teams: [id] } }
    }
    const g = MAILBOX_GROUPS.find(x => x.key === raw)
    if (!g) return null
    // `section` rides along because it is what decides OR vs AND at resolve
    // time (combineClauseSets) — it is not merely a display grouping.
    const section = g.section ?? 'roles'
    return g.source === 'clubdesk'
      ? { section, clubdeskStatus: g.status }
      : { section, spec: g.spec }
  }

  /**
   * Members of `spec` who can actually receive mail, deduped by address.
   *
   * Three exclusions, each reported separately so the preview can explain the
   * gap between "audience size" and "emails sent" instead of silently showing a
   * smaller number:
   *   - no email on the member record
   *   - email_notify_announcements = false (the member's own opt-out; a group
   *     mail from the club is the same kind of message, so it is honoured here
   *     too rather than routing around it)
   *   - a duplicate address (shared family inboxes — 693 member addresses are
   *     only 671 distinct, so without this some households get N copies)
   *   - a suppressed address (SES told us it hard-bounced, or the recipient
   *     marked us as spam) — re-mailing those is what costs the SES identity
   *     its reputation, and that identity also carries password resets
   */
  /**
   * Resolve a recipient selection to mailable people.
   *
   * `clauses` is a list of clauses that are OR'd together — the shape the
   * composer's drill-down produces. WITHIN a clause the rule is OR inside a
   * section, AND across sections: "Sections ▸ Volleyball" + "Roles ▸ Coaches"
   * is the 20 volleyball coaches, while "Teams ▸ D1" + "Teams ▸ D2" is all 39
   * of them rather than the empty set of people on both rosters. Across clauses
   * everything unions ("…plus everyone on D1").
   *
   * The cross-section intersection is what makes a filter like "volleyball
   * coaches" expressible at all: no single chip means both, and adding a
   * sport-scoped chip per role would multiply the catalogue without ever
   * covering the next combination someone wants. See combineClauseSets for why
   * the within-section half is a union — and for the one query it costs.
   *
   * Dedupe happens ONCE over the fully combined set, never per clause — a coach
   * of D1 reached by both a role clause and a team clause is still mailed once.
   */
  async function resolveRecipients(clauses, label, explicit = null) {
    const memberIds = new Set()
    const clubdeskRows = []

    for (const clause of clauses) {
      const { srcs, season } = clause
      const entries = []
      for (const src of srcs) {
        if (src.clubdeskStatus) {
          // Former members are register contacts, not member rows, so they can
          // never intersect with a member audience — sourcesForClauses rejects
          // that mix rather than letting it resolve to a silent empty set.
          clubdeskRows.push(...await resolveClubdeskRecipients(database, src.clubdeskStatus))
        } else {
          entries.push({
            section: src.section,
            set: new Set(await resolveMemberAudience(database, log, src.spec, label, { season })),
          })
        }
      }
      if (entries.length === 0) continue
      const narrowed = combineClauseSets(entries)
      for (const id of narrowed) memberIds.add(id)
    }

    // Individually-picked recipients, from an audience the operator expanded
    // into chips. They join the same set as the group-resolved ones and go
    // through every filter below, so expanding an audience can never be a way
    // to reach someone who opted out or whose address is suppressed.
    if (explicit?.memberIds?.length) {
      for (const id of explicit.memberIds) memberIds.add(id)
    }
    if (explicit?.emails?.length) {
      clubdeskRows.push(...await resolveRegisterEmails(database, explicit.emails))
    }

    const memberRows = memberIds.size > 0
      ? await database('members').whereIn('id', [...memberIds])
        .select('id', 'email', 'first_name', 'last_name', 'email_notify_announcements')
      : []

    const skipped = { noEmail: 0, optedOut: 0, duplicate: 0, suppressed: 0 }
    const seen = new Set()
    const recipients = []

    const suppressedSet = await loadSuppressed(database, [
      ...memberRows.map(r => r.email),
      ...clubdeskRows.map(r => r.email),
    ])

    // Members first, so that when a person appears in BOTH a member group and
    // the ClubDesk one, the member row wins and their opt-out still applies.
    for (const r of memberRows) {
      const email = String(r.email || '').trim()
      if (!email) { skipped.noEmail++; continue }
      if (!r.email_notify_announcements) { skipped.optedOut++; continue }
      const kEmail = email.toLowerCase()
      if (suppressedSet.has(kEmail)) { skipped.suppressed++; continue }
      if (seen.has(kEmail)) { skipped.duplicate++; continue }
      seen.add(kEmail)
      recipients.push({ id: r.id, email, first_name: r.first_name || '', last_name: r.last_name || '' })
    }
    // ClubDesk contacts carry no opt-out column, so there is nothing to honour
    // beyond List-Unsubscribe — see resolveClubdeskRecipients.
    for (const r of clubdeskRows) {
      const kEmail = r.email.toLowerCase()
      if (suppressedSet.has(kEmail)) { skipped.suppressed++; continue }
      if (seen.has(kEmail)) { skipped.duplicate++; continue }
      seen.add(kEmail)
      recipients.push(r)
    }

    return { recipients, audienceSize: memberIds.size + clubdeskRows.length, skipped }
  }

  /** A resolved recipient as the composer's To-field chip.
   *
   *  `first_name`/`last_name` ride along beside the joined `name` because the
   *  composer sorts by surname, and splitting the joined string back apart
   *  client-side gets compound names wrong ("Berke-Wenger", "van der Berg").
   *  A contact with neither part is its own label: an address is what we know
   *  about them, so an address is what the chip shows. */
  function toRecipientChip(r) {
    const first = (r.first_name || '').trim()
    const last = (r.last_name || '').trim()
    return {
      id: r.id,
      kind: typeof r.id === 'string' && String(r.id).startsWith('cd:') ? 'clubdesk' : 'member',
      name: [first, last].filter(Boolean).join(' ') || r.email,
      first_name: first,
      last_name: last,
      email: r.email,
    }
  }

  /**
   * Attach the merge data that is not already on a resolved recipient.
   *
   * Runs as THREE queries for the whole run, never one per recipient. ClubDesk
   * contacts (`cd:` ids) are skipped: they have no member row, so they keep
   * name + email and resolve the rest to empty.
   *
   * ⚠ `fee_amount` is DERIVED (deriveMitgliederbeitrag), i.e. what wiedisync
   * would bill, not what ClubDesk actually invoiced — the two differ wherever a
   * treasurer typed an amount by hand. It is the right figure for an
   * announcement about the coming season and the wrong one for "here is your
   * invoice". An unknown category derives to '' and is never guessed.
   */
  async function enrichForMergeFields(recipients) {
    const ids = recipients.map((r) => Number(r.id)).filter((n) => Number.isInteger(n) && n > 0)
    if (ids.length === 0) return recipients
    const season = currentSeasonShort()

    const [rows, teamRows, guests] = await Promise.all([
      database('members').whereIn('id', ids).select(
        'id', 'beitragskategorie', 'birthdate',
        // The licence flags deriveMitgliederbeitrag reads for the
        // no-Schreiberlizenz surcharge. Passing the member row rather than null
        // is what makes the surcharge appear at all.
        'scorer_vb', 'otr1_bb', 'otr2_bb', 'otn1_bb', 'otn2_bb',
        // Per-member overrides (migration 299) — a member the treasurer
        // re-priced must not be mailed the category's amount.
        ...FEE_OVERRIDE_FIELDS,
      ),
      // {{teams}} merge field — gated on the team being active rather than on
      // member_teams.season, which blanked the team name for any recipient whose
      // stamp lagged the clock.
      database('member_teams')
        .join('teams', 'teams.id', 'member_teams.team')
        .whereIn('member_teams.member', ids)
        .andWhere('teams.active', true)
        .select('member_teams.member', 'teams.name')
        .orderBy('teams.name'),
      guestMemberIdSet(database, ids, season),
    ])

    const byId = new Map(rows.map((r) => [Number(r.id), r]))
    const teamsById = new Map()
    for (const t of teamRows) {
      const k = Number(t.member)
      if (!teamsById.has(k)) teamsById.set(k, [])
      if (t.name && !teamsById.get(k).includes(t.name)) teamsById.get(k).push(t.name)
    }

    return recipients.map((r) => {
      const id = Number(r.id)
      const m = byId.get(id)
      if (!m) return r
      const category = m.beitragskategorie || ''
      return {
        ...r,
        fee_category: category,
        fee_amount: category ? deriveMitgliederbeitrag(category, m, { isGuest: guests.has(id) }) : '',
        teams: (teamsById.get(id) || []).join(', '),
      }
    })
  }

  // GET /kscw/admin/mailbox/groups — the picker's catalogue, with live counts.
  router.get('/admin/mailbox/groups', async (req, res) => {
    const acct = pinnedAdmin()
    if (!(await authForAccount(req, acct.sport))) return res.status(403).json({ error: 'Admin only' })
    try {
      const [teams, ...counts] = await Promise.all([
        teamAudienceCounts(database),
        ...MAILBOX_GROUPS.map(g => (g.source === 'clubdesk'
          ? resolveClubdeskRecipients(database, g.status).then(rows => rows.length)
          : resolveMemberAudience(database, log, g.spec, `mailbox/${g.key}`).then(ids => ids.length))),
      ])
      // Season chips. Offered only when the club actually has more than one
      // season on file — a single-season club would just see a chip that
      // narrows nothing. Newest first; no count, because a season is a filter
      // on other audiences rather than an audience with a size of its own.
      const seasonRows = await database('teams')
        .whereNotNull('season')
        .distinct('season')
        .orderBy('season', 'desc')
      const seasons = seasonRows.length > 1
        ? seasonRows.map(r => ({ key: `season:${r.season}`, section: 'season', name: r.season, count: null }))
        : []

      res.json({
        groups: MAILBOX_GROUPS.map((g, i) => ({ key: g.key, section: g.section ?? 'roles', count: counts[i] })),
        teams: teams.map(t => ({ key: `team:${t.id}`, section: 'teams', name: t.name, sport: t.sport, gender: t.gender, count: t.count })),
        seasons,
        // The signature the server appends to every send. Returned so the
        // composer can SHOW it: it has always been added, but an operator
        // writing into an empty editor had no way to know that, and would
        // reasonably type their own sign-off underneath the one they cannot see.
        signature_html: acct.signatureHtml,
      })
    } catch (err) { fail(res, 'mailbox/groups', err, req) }
  })

  // Member-set index behind the live chip counts, keyed by season because
  // sport:/fn:/team: audiences mean different people in a different one.
  //
  // ⚠ Built by calling the CANONICAL resolveMemberAudience once per key, NOT by
  // a second and much faster set of GROUP BY passes. The fast version would be
  // ~5 queries instead of ~50, but it would be a SECOND definition of who is in
  // an audience, and the number painted on a chip would drift from the dry-run
  // preview that actually gates the send — an operator would confirm one figure
  // and mail another. audience.js was extracted precisely so announcements and
  // the mailbox could not disagree about this; do not reintroduce it here for
  // speed. The TTL cache is what makes the honest version affordable.
  const AUDIENCE_INDEX_TTL_MS = 60_000
  const audienceIndexCache = new Map()

  async function audienceIndex(season) {
    const cacheKey = season || '_'
    const hit = audienceIndexCache.get(cacheKey)
    if (hit && Date.now() - hit.at < AUDIENCE_INDEX_TTL_MS) return hit.sets

    const teams = await teamAudienceCounts(database)
    const specs = [
      // Former members are excluded: they are register contacts with no member
      // id, so they cannot take part in the set maths at all. The frontend
      // keeps showing their static count, which is the only true one for them.
      ...MAILBOX_GROUPS.filter(g => g.source !== 'clubdesk')
        .map(g => ({ key: g.key, section: g.section ?? 'roles', spec: g.spec })),
      ...teams.map(t => ({
        key: `team:${t.id}`,
        section: 'teams',
        spec: { audience_type: 'teams', audience_teams: [t.id] },
      })),
    ]
    const resolved = await Promise.all(specs.map(async s => [
      s.key,
      { section: s.section, set: new Set(await resolveMemberAudience(database, log, s.spec, `mailbox/counts/${s.key}`, { season })) },
    ]))
    const sets = new Map(resolved)
    audienceIndexCache.set(cacheKey, { at: Date.now(), sets })
    return sets
  }

  // POST /kscw/admin/mailbox/group-counts — for every chip, how big the audience
  // would BECOME if it were added to the current draft.
  //
  // Not "how many of the draft are also in this chip": under OR-within-a-section
  // a chip from a section already in the draft ENLARGES the audience, and the
  // number has to say so or it would read as a narrowing that isn't happening.
  // combineClauseSets is the same function the send uses, so the arithmetic on
  // the chip and the arithmetic in the preview cannot diverge.
  router.post('/admin/mailbox/group-counts', async (req, res) => {
    const acct = pinnedAdmin()
    if (!(await authForAccount(req, acct.sport))) return res.status(403).json({ error: 'Admin only' })
    try {
      const { season, keys } = splitSeason(parseList((req.body || {}).draft))
      const sets = await audienceIndex(season)

      // Unknown draft keys are ignored rather than rejected: this endpoint only
      // paints numbers on chips, and a stale key must not blank the whole row.
      // The send path still rejects unknown keys outright — that is where an
      // unrecognised chip has to be fatal.
      const draftEntries = keys.map(k => sets.get(k)).filter(Boolean)

      const counts = {}
      for (const [key, entry] of sets) counts[key] = combineClauseSets([...draftEntries, entry]).size
      res.json({ counts, season: season || null })
    } catch (err) { fail(res, 'mailbox/group-counts', err, req) }
  })

  /** Resolve clause key-lists to source descriptors, or an error string. */
  function sourcesForClauses(clauses) {
    const out = []
    for (const clauseKeys of clauses) {
      // A season is a MODIFIER on the rest of the clause, not a member of it.
      const { season, keys, seasonScopable } = splitSeason(clauseKeys)
      if (season && !seasonScopable) {
        // Nothing left in the clause varies by season (a section, a
        // qualification, all members, former members). Silently returning the
        // unscoped audience would hand back a different set than the chip says.
        return { error: `Season ${season} cannot be applied to this audience` }
      }
      if (season && keys.length === 0) {
        return { error: `Season ${season} needs an audience to filter` }
      }
      const srcs = []
      for (const k of keys) {
        const src = sourceForGroup(k)
        // Reject on the FIRST unknown key rather than resolving what we
        // recognise: silently ignoring a chip the client thinks it selected
        // would send to a different audience than the operator confirmed.
        if (!src) return { error: `Unknown group: ${k}` }
        srcs.push(src)
      }
      // A clause mixing former members with member audiences from ANOTHER
      // section would intersect a register-contact list against member ids and
      // quietly resolve to the member half only. Rejecting is the honest
      // answer; "former members who are also coaches" is not a thing the data
      // can express. Keyed on sections rather than on `srcs.length` because
      // same-section keys now union — a union of register contacts and members
      // would be well-defined, so only the cross-section case is impossible.
      // (Today `former` is alone in its section, so this rejects exactly what
      // the old length check did.)
      if (srcs.some(s => s.clubdeskStatus) && new Set(srcs.map(s => s.section || '_')).size > 1) {
        return { error: 'Former members cannot be combined with other audiences in one filter' }
      }
      out.push({ srcs, season })
    }
    return { sources: out }
  }

  // POST /kscw/admin/mailbox/expand — resolve audiences to the individual
  // people in them, so the composer can render them as removable chips.
  //
  // This deliberately returns addresses, unlike the dry-run preview (which
  // returns counts and first-name samples only). The difference is intent: the
  // preview answers "how many and roughly who" for a blast that stays a blast,
  // whereas expanding is the operator taking manual control of the recipient
  // list and needing to see exactly who is on it. Same admin-only gate either
  // way, and the club's admins can already read member addresses in the admin
  // area — this exposes nothing they could not already list.
  router.post('/admin/mailbox/expand', async (req, res) => {
    const acct = pinnedAdmin()
    if (!(await authForAccount(req, acct.sport))) return res.status(403).json({ error: 'Admin only' })
    try {
      const body = req.body || {}
      const clauses = parseClauses(body)
      if (clauses.length === 0) return res.status(400).json({ error: 'No group selected' })

      const resolved = sourcesForClauses(clauses)
      if (resolved.error) return res.status(400).json({ error: resolved.error })

      // Same resolver as the send, so the chips the operator sees are exactly
      // the people who would be mailed — anyone filtered out for a missing
      // address, an opt-out or a suppression never appears as a chip at all.
      const label = clauses.map(c => c.join(' + ')).join(', ')
      const { recipients, audienceSize, skipped } = await resolveRecipients(resolved.sources, `mailbox/expand/${label}`)

      res.json({
        groups: clauses.flat(),
        audience_size: audienceSize,
        skipped,
        recipients: recipients.map(r => toRecipientChip(r)),
      })
    } catch (err) { fail(res, 'mailbox/expand', err, req) }
  })

  // POST /kscw/admin/mailbox/lookup — pasted addresses → recipient chips.
  //
  // The catalogue answers "mail this audience"; this answers "mail these
  // people", which is the case no chip combination covers: a hand-curated list
  // out of a spreadsheet is not a team, a role or a season, and the only way to
  // reach it before this was to expand a broad audience and delete the rest.
  //
  // Deliberately resolved to MEMBER ROWS rather than sent as raw addresses:
  // that is what makes the pasted list behave like every other audience —
  // {{vorname}} resolves, `email_notify_announcements` is honoured, suppressed
  // addresses stay suppressed, and the send stays one message per person. An
  // address that is nobody in the club is reported back, never silently mailed
  // and never silently dropped.
  router.post('/admin/mailbox/lookup', async (req, res) => {
    const acct = pinnedAdmin()
    if (!(await authForAccount(req, acct.sport))) return res.status(403).json({ error: 'Admin only' })
    try {
      const raw = Array.isArray(req.body?.emails) ? req.body.emails : []
      // Bounded for the same reason the composer is: a paste is operator input,
      // and an unbounded IN-list is a query someone can make arbitrarily large.
      if (raw.length > LOOKUP_MAX_ADDRESSES) {
        return res.status(413).json({ error: `Too many addresses (max ${LOOKUP_MAX_ADDRESSES})` })
      }
      // Unwrap `Name <a@b.ch>` BEFORE cleanAddresses, which keeps only the bare
      // shape and would drop that form without a word — the same silent loss
      // the composer's chip field exists to prevent. The frontend already sends
      // bare addresses; this is for anything that does not.
      const unwrapped = raw.map((v) => {
        const m = /^\s*.*<([^<>]+)>\s*$/.exec(String(v ?? ''))
        return m ? m[1].trim() : v
      })
      const wanted = [...new Set(cleanAddresses(unwrapped).map((e) => e.toLowerCase()))]
      if (wanted.length === 0) return res.status(400).json({ error: 'No addresses' })

      const memberRows = await database('members')
        .whereIn(database.raw('LOWER(BTRIM(email))'), wanted)
        .select('id', 'email', 'first_name', 'last_name', 'email_notify_announcements')

      // Anything that is not a member may still be a register contact (a former
      // member has no member row at all) — the same fallback the send uses for
      // individually-picked addresses, so a chip made here is a chip the send
      // can resolve.
      const matchedMember = new Set(memberRows.map((r) => String(r.email).trim().toLowerCase()))
      const registerRows = await resolveRegisterEmails(
        database,
        wanted.filter((e) => !matchedMember.has(e)),
      )

      // Same three exclusions as resolveRecipients, reported the same way: a
      // chip that appears here is a person the send would actually reach.
      const suppressedSet = await loadSuppressed(database, [
        ...memberRows.map((r) => r.email),
        ...registerRows.map((r) => r.email),
      ])
      const skipped = { noEmail: 0, optedOut: 0, duplicate: 0, suppressed: 0 }
      const seen = new Set()
      const recipients = []
      const resolvedAddrs = new Set()

      for (const r of memberRows) {
        const email = String(r.email || '').trim()
        const key = email.toLowerCase()
        resolvedAddrs.add(key)
        if (!email) { skipped.noEmail++; continue }
        if (!r.email_notify_announcements) { skipped.optedOut++; continue }
        if (suppressedSet.has(key)) { skipped.suppressed++; continue }
        if (seen.has(key)) { skipped.duplicate++; continue }
        seen.add(key)
        recipients.push(toRecipientChip({ ...r, email }))
      }
      for (const r of registerRows) {
        const key = r.email.toLowerCase()
        resolvedAddrs.add(key)
        if (suppressedSet.has(key)) { skipped.suppressed++; continue }
        if (seen.has(key)) { skipped.duplicate++; continue }
        seen.add(key)
        recipients.push(toRecipientChip(r))
      }

      res.json({
        requested: wanted.length,
        recipients,
        skipped,
        // Named so the operator can fix the list rather than wonder about the
        // gap between "I pasted 117" and "115 chips".
        not_found: wanted.filter((e) => !resolvedAddrs.has(e)),
      })
    } catch (err) { fail(res, 'mailbox/lookup', err, req) }
  })

  // POST /kscw/admin/mailbox/bulk — preview or send to a group.
  //
  // `dry_run` is not an optional nicety: it is the only safe way to check who a
  // send would reach, and CLAUDE.md forbids test-mailing real members. Always
  // preview first; the frontend requires it before enabling Send.
  router.post('/admin/mailbox/bulk', async (req, res) => {
    const acct = pinnedAdmin()
    if (!(await authForAccount(req, acct.sport))) return res.status(403).json({ error: 'Admin only' })
    // Set once this run owns the in-flight claim; released in the `finally`.
    let sendKey = null
    // Hoisted for the catch below: everything inside the try is block-scoped, and a
    // throw mid-loop must still be able to close out the archive row it created.
    const archive = { id: null, sent: 0, total: 0 }
    try {
      if (!accountConfigured(acct)) return res.status(409).json({ error: 'Mailbox not configured' })

      let body = req.body || {}
      let uploads = []
      if (String(req.headers['content-type'] || '').includes('multipart/form-data')) {
        try {
          const parsed = await parseMultipartReply(req)
          body = parsed.fields
          uploads = parsed.files
        } catch (err) {
          return res.status(413).json({ error: err.message || 'Attachment upload failed' })
        }
      }

      // `clauses` is the drill-down's shape (AND within, OR across); flat
      // `groups`/`group` still work and become one-key clauses.
      const clauses = parseClauses(body)

      // Individually-picked recipients from an expanded audience. `members` are
      // member ids; `emails` are register contacts (former members have no
      // member row) and are validated back against the register server-side.
      const explicitMemberIds = [...new Set(
        parseList(body.members).map(v => Number(v)).filter(n => Number.isInteger(n) && n > 0),
      )]
      const explicitEmails = [...new Set(
        parseList(body.emails).map(v => String(v).trim()).filter(Boolean),
      )]
      const hasExplicit = explicitMemberIds.length > 0 || explicitEmails.length > 0

      if (clauses.length === 0 && !hasExplicit) return res.status(400).json({ error: 'No recipient selected' })

      const resolved = sourcesForClauses(clauses)
      if (resolved.error) return res.status(400).json({ error: resolved.error })
      const sources = resolved.sources
      // Human label for logs, the Sent-folder summary and the audit row. AND
      // within a clause reads as "+", OR across them as ", " — so a drilled
      // filter archives as "sektion:volleyball + fn:coach", not as two
      // independent audiences it was never equivalent to.
      const groupKey = clauses.map(c => c.join(' + ')).join(', ')
        || `${explicitMemberIds.length + explicitEmails.length} picked`

      // Cc/Bcc get exactly ONE copy, sent once after the personalised run —
      // they are NOT headers on each message. A group send is one message per
      // recipient, so a Cc carried on every one would deliver N copies to
      // whoever was cc'd (671 of them for "All members") and disclose nothing
      // useful in return. One copy is what "keep the president in the loop"
      // actually means, and it is the only reading that is safe by default.
      const ccOnce = cleanAddresses(body.cc)
      const bccOnce = cleanAddresses(body.bcc)
      // The Cc/Bcc copy is ONE message (that is the whole point of it), so
      // unlike the personalised run it is bound by the transport's per-message
      // recipient ceiling. Rejected here with a sentence the operator can act
      // on, rather than let SES refuse the whole thing after the real
      // recipients have already been mailed — that copy is sent last.
      if (ccOnce.length + bccOnce.length > SES_MAX_RECIPIENTS_PER_MESSAGE) {
        return res.status(400).json({
          error: `Cc + Bcc is one shared copy and cannot exceed ${SES_MAX_RECIPIENTS_PER_MESSAGE} addresses `
            + `(got ${ccOnce.length + bccOnce.length}). Add them as recipients instead — those are sent one message each.`,
        })
      }

      const dryRun = body.dry_run === true || String(body.dry_run) === 'true'
      const { recipients, audienceSize, skipped } = await resolveRecipients(
        sources,
        `mailbox/${groupKey}`,
        hasExplicit ? { memberIds: explicitMemberIds, emails: explicitEmails } : null,
      )

      // Read before the dry-run branch: the preview has to know which merge
      // fields the message uses in order to say anything useful about them.
      const subject = String(body.subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 300)
      const rawHtml = String(body.html || '').slice(0, 200_000)
      const usedFields = usedMergeFields(subject, rawHtml)
      // Merge data costs three queries, so it is fetched only when the message
      // actually references a field — most sends reference none.
      const merged = usedFields.length > 0 && recipients.length > 0
        ? await enrichForMergeFields(recipients)
        : recipients

      if (dryRun) {
        // Names, never addresses: the preview answers "how many and roughly
        // who", not "give me the club's mailing list".
        const previewHtml = rawHtml.trim() ? sanitizeOutgoingHtml(rawHtml) : ''
        return res.json({
          dry_run: true,
          group: groupKey,
          groups: clauses.flat(),
          clauses,
          audience_size: audienceSize,
          recipient_count: recipients.length,
          skipped,
          sample: recipients.slice(0, 5).map(r => [r.first_name, (r.last_name || '').slice(0, 1)].filter(Boolean).join(' ').trim()),
          // Echoed so the composer can state the one-copy rule against real
          // numbers ("+1 copy to 2 others") rather than as a hopeful footnote.
          cc_count: ccOnce.length,
          bcc_count: bccOnce.length,
          merge_fields: usedFields,
          // How many recipients would receive a BLANK for each field the
          // message uses. A fee category nobody priced renders empty rather
          // than guessing, and 117 people reading "your fee is CHF " is the
          // failure this number exists to prevent.
          merge_gaps: Object.fromEntries(
            usedFields.map((key) => [key, merged.filter((r) => !mergeValues(r)[key]).length]),
          ),
          // The message as three named recipients would actually receive it.
          // Rendered through the SAME builder as the send, so the preview
          // cannot drift from what goes out.
          merge_samples: merged.slice(0, 3).map((r) => ({
            name: [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || r.email,
            subject: applyMergeFields(subject, r, false),
            html: previewHtml ? applyMergeFields(previewHtml, r, true) : '',
          })),
        })
      }

      if (!subject || !rawHtml.trim()) return res.status(400).json({ error: 'subject and body required' })
      if (recipients.length === 0) return res.status(400).json({ error: 'No valid recipient' })

      const bodyContentHtml = sanitizeOutgoingHtml(rawHtml)
      const plainContent = htmlToPlain(bodyContentHtml)

      const attachments = uploads.map((u) => ({ filename: u.filename, content: u.content, contentType: u.contentType }))
      if (attachments.length > ATTACH_MAX_FILES) return res.status(413).json({ error: 'Too many attachments' })
      let attachTotal = 0
      for (const a of attachments) {
        const sz = a.content?.length || 0
        if (sz > ATTACH_MAX_PER_FILE) return res.status(413).json({ error: 'Attachment too large' })
        attachTotal += sz
      }
      if (attachTotal > ATTACH_MAX_TOTAL) return res.status(413).json({ error: 'Attachments exceed total size limit' })

      // Single-shot claim. Everything below actually mails people, and nothing
      // about the request is idempotent: the same audience posted twice mails
      // all 671 members twice. The check and the add are one synchronous step
      // (no await between them), so two overlapping requests cannot both pass.
      // See `bulkSendRunningFor` for why this is process-local, not DB-arbitrated.
      sendKey = `${acct.sport}:${crypto.createHash('sha256')
        .update(`${groupKey}\n${subject}\n${rawHtml}`).digest('hex')}`
      if (bulkSendRunningFor.has(sendKey)) {
        sendKey = null // someone else's claim — the `finally` must not release it
        return res.status(409).json({
          error: 'A send to this audience is already in progress. It appears in the mailbox history — wait for it to finish before sending again.',
        })
      }
      bulkSendRunningFor.add(sendKey)

      // Archive row FIRST, counts filled in by the UPDATE after the run. It
      // used to be written only once the whole run was over — more than a
      // minute for a club-wide send, during which the mailbox history stayed
      // empty. That reads as "nothing was sent" and is exactly what invites the
      // operator to press Send again, so the row goes in before the first
      // message does.
      const messageId = `<${crypto.randomUUID()}@${acct.msgIdDomain}>`
      const archiveHtml =
        `<div style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;font-size:14px;line-height:1.5">` +
        `${bodyContentHtml}</div><br>` + acct.signatureHtml
      const pendingSummary = `Group send: ${groupKey} (sending to ${recipients.length} recipients…)`
      // No .onConflict(...).ignore() here: message_id is a fresh UUID so the
      // clause could never fire, and knex's .ignore() DROPS RETURNING — which
      // would leave this row without the id the post-run UPDATE needs.
      const [inserted] = await database('scheduling_emails')
        .insert({
          account: acct.sport,
          message_id: stripBrackets(messageId),
          direction: 'out',
          folder: null,
          imap_uid: null,
          from_address: acct.fromAddress,
          from_name: acct.fromName,
          to_addresses: pendingSummary,
          cc_addresses: [...ccOnce, ...bccOnce].join(',') || null,
          subject,
          body_text: `${pendingSummary}\n\n${plainContent}`,
          body_html: archiveHtml,
          has_attachments: attachments.length > 0,
          attachments: attachments.length
            ? JSON.stringify(attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.content.length })))
            : null,
          date_sent: new Date().toISOString(),
          read_at: new Date().toISOString(),
        })
        .returning('id')
      const sentId = inserted?.id ?? inserted ?? null
      archive.id = sentId
      archive.total = recipients.length

      // One POOLED transport for the whole run, unlike the reply handler's
      // per-send transport: without pooling every message pays a fresh TCP+TLS
      // handshake, which is what turns a 700-recipient send into minutes.
      // rateLimit stays under SES's sending rate with headroom to spare.
      const transport = nodemailer.createTransport({
        host: process.env.EMAIL_SMTP_HOST,
        port: Number(process.env.EMAIL_SMTP_PORT || 587),
        secure: String(process.env.EMAIL_SMTP_SECURE) === 'true',
        auth: { user: process.env.EMAIL_SMTP_USER, pass: process.env.EMAIL_SMTP_PASSWORD },
        pool: true,
        maxConnections: 5,
        maxMessages: 100,
        rateDelta: 1000,
        rateLimit: 10,
      })

      // RFC 2369 mailto unsubscribe. No token infrastructure needed, and it
      // gives mailbox providers the signal that keeps recipients hitting
      // "unsubscribe" instead of "spam" — the complaint rate is what actually
      // costs a sender its reputation.
      const unsubscribe = `<mailto:${acct.fromAddress}?subject=Unsubscribe>`

      let sent = 0
      const errors = []
      // The enriched copy, so {{mitgliederbeitrag}} and friends resolve for
      // the real send exactly as they did in the preview.
      for (const r of merged) {
        try {
          const html =
            `<div style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;font-size:14px;line-height:1.5">` +
            `${applyMergeFields(bodyContentHtml, r, true)}` +
            `</div><br>` + acct.signatureHtml
          const text = `${applyMergeFields(plainContent, r, false)}\n\n${acct.signatureText}`
          await transport.sendMail({
            from: { name: acct.fromName, address: acct.fromAddress },
            to: r.email,
            subject: applyMergeFields(subject, r, false),
            text,
            html,
            attachments: attachments.length ? attachments : undefined,
            headers: { 'List-Unsubscribe': unsubscribe },
          })
          sent++
          archive.sent = sent
        } catch (err) {
          // One bad address must not abort the run — record and continue.
          errors.push({ email: r.email, error: String(err?.message || err).slice(0, 300) })
          log.warn(`Mailbox group send: ${r.email} failed: ${err?.message}`)
        }
      }

      // The single Cc/Bcc copy. Merge fields have no person to resolve against
      // here, so they are stripped rather than left as raw {{vorname}} in a
      // message a board member actually reads. Sent last so a failure here can
      // never cost the run its real recipients, and counted separately so the
      // reported "sent" stays the number of MEMBERS reached.
      let ccSent = 0
      if (ccOnce.length || bccOnce.length) {
        const blank = { first_name: '', last_name: '' }
        try {
          await transport.sendMail({
            from: { name: acct.fromName, address: acct.fromAddress },
            to: acct.fromAddress,
            cc: ccOnce.length ? ccOnce : undefined,
            bcc: bccOnce.length ? bccOnce : undefined,
            subject: applyMergeFields(subject, blank, false),
            text: `[Group send: ${groupKey} (${sent} recipients)]\n\n${applyMergeFields(plainContent, blank, false)}\n\n${acct.signatureText}`,
            html:
              `<div style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;font-size:14px;line-height:1.5">` +
              `${applyMergeFields(bodyContentHtml, blank, true)}` +
              `</div><br>` + acct.signatureHtml,
            attachments: attachments.length ? attachments : undefined,
            headers: { 'List-Unsubscribe': unsubscribe },
          })
          ccSent = ccOnce.length + bccOnce.length
        } catch (err) {
          errors.push({ email: 'cc/bcc', error: String(err?.message || err).slice(0, 300) })
          log.warn(`Mailbox group send: cc/bcc copy failed: ${err?.message}`)
        }
      }
      transport.close()

      // Archive ONE copy in Sent, then finish the scheduling_emails row that was
      // written before the run. Appending N copies would bury the mailbox under
      // its own outbound mail; the row records the group and the counts, which
      // is what an operator actually needs later.
      const toSummary = `Group send: ${groupKey} (${sent} recipients)`
      let folder = null
      let imapUid = null
      try {
        const raw = await new MailComposer({
          from: { name: acct.fromName, address: acct.fromAddress },
          to: acct.fromAddress,
          subject,
          text: `${toSummary}\n\n${plainContent}\n\n${acct.signatureText}`,
          html: archiveHtml,
          attachments: attachments.length ? attachments : undefined,
          messageId,
          headers: { 'X-KSCW-Group-Send': groupKey, 'X-KSCW-Group-Recipients': String(sent) },
        }).compile().build()
        const client = imapClient(acct)
        await client.connect()
        try {
          const sentFolder = await findSentFolder(client)
          const appended = await client.append(sentFolder, raw, ['\\Seen'])
          folder = sentFolder
          imapUid = appended?.uid || null
        } finally {
          await client.logout().catch(() => {})
        }
      } catch (err) {
        log.warn(`Mailbox group send: sent OK but Sent-folder append failed: ${err.message}`)
      }

      if (sentId) {
        await database('scheduling_emails').where({ id: sentId }).update({
          folder,
          imap_uid: imapUid,
          to_addresses: toSummary,
          body_text: `${toSummary}\n\n${plainContent}`,
        })
      }

      await writeUserLog(database, log, {
        accountability: req.accountability,
        action: 'send',
        collection: 'scheduling_emails',
        recordId: sentId,
        data: {
          kind: 'mailbox_group_send',
          account: acct.sport,
          group: groupKey,
          subject,
          audience_size: audienceSize,
          recipients: recipients.length,
          sent,
          failed: errors.length,
          attachments: attachments.length,
          // Individually-picked recipients and the one-copy Cc/Bcc are part of
          // "who did this reach", so the audit row has to carry them too.
          picked_members: explicitMemberIds.length,
          picked_emails: explicitEmails.length,
          cc: ccOnce.length,
          bcc: bccOnce.length,
        },
      })

      log.info(`Mailbox group send "${groupKey}": ${sent} sent, ${errors.length} failed (audience ${audienceSize}, cc/bcc ${ccSent})`)
      res.json({ success: true, id: sentId, group: groupKey, audience_size: audienceSize, recipient_count: recipients.length, sent, failed: errors.length, cc_sent: ccSent, skipped, errors: errors.slice(0, 20) })
    } catch (err) {
      // ⚠ The archive row is inserted BEFORE the send loop (so the history shows an
      // in-progress send and the operator is not misled into retrying). That means a
      // throw mid-loop would otherwise strand it reading "sending to N recipients…"
      // for ever — worse than the no-row-at-all it replaced, because the next retry
      // then leaves two rows for one send. Mark it failed with whatever went out.
      if (archive.id) {
        try {
          await database('scheduling_emails').where({ id: archive.id }).update({
            body_text: `Send failed after ${archive.sent} of ${archive.total} recipients.`,
          })
        } catch (e2) {
          log.warn(`Mailbox group send: could not mark archive row ${archive.id} as failed: ${e2.message}`)
        }
      }
      fail(res, 'mailbox/bulk', err, req)
    } finally {
      // Released whether the run finished, failed or threw: a crashed run must
      // never lock this audience out of a later send.
      if (sendKey) bulkSendRunningFor.delete(sendKey)
    }
  })

  // GET .../mailbox/attachment/:id/:index — stream one attachment live from IMAP
  // (content is never stored locally). 410 when the stored folder/uid no longer
  // resolves to the same message — a fresh sync re-points it.
  const attachmentHandler = (getAcct) => async (req, res) => {
    const acct = getAcct(req)
    if (!acct) return res.status(400).json({ error: 'Unknown mailbox' })
    if (!(await authForAccount(req, acct.sport))) return res.status(403).json({ error: 'Admin only' })
    try {
      if (!accountConfigured(acct)) return res.status(409).json({ error: 'Mailbox not configured' })
      const row = await database('scheduling_emails').where({ id: Number(req.params.id), account: acct.sport }).first()
      if (!row) return res.status(404).json({ error: 'Message not found' })
      const index = Number(req.params.index)
      let att
      try {
        att = (await fetchMessageAttachments(acct, row))[index]
      } catch (err) {
        return res.status(err.status || 410).json({ error: err.message || 'Message no longer at stored IMAP location' })
      }
      if (!att) return res.status(404).json({ error: 'Attachment not found' })
      const filename = (att.filename || `attachment-${index + 1}`).replace(/[\r\n"]/g, '')
      res.setHeader('Content-Type', att.contentType || 'application/octet-stream')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.send(att.content)
    } catch (err) { fail(res, 'mailbox/attachment', err, req) }
  }
  router.get('/admin/terminplanung/mailbox/attachment/:id/:index', attachmentHandler(schedulingAccount))
  router.get('/admin/mailbox/attachment/:id/:index', attachmentHandler(pinnedAdmin))
}
