/**
 * KSCW Broadcast — Contact-All endpoints (Plan 01 / Phase B / Tasks B5+B6).
 *
 * Two routes, both gated by RBAC + per-activity rate limit, both audited
 * to the `broadcasts` table:
 *
 *   POST /kscw/activities/:type/:id/broadcast          (B5) — fan-out send
 *   POST /kscw/activities/:type/:id/broadcast/preview  (B6) — dry-run preview
 *
 * The B2 helpers (`broadcast-helpers.js`) carry all auth/lookup/permission/
 * audience/rate-limit/payload logic. The B4 email builder
 * (`buildBroadcastEmail` in `email-template.js`) renders per-recipient HTML.
 * Push delivery reuses the existing CF-Worker pipeline (`web-push.js`).
 *
 * Error semantics (per spec):
 *   - Pre-flight failures (auth, validation, lookup, permission, rate limit)
 *     abort with the proper status BEFORE any send.
 *   - Per-recipient failures during fan-out are captured in `delivery_results`
 *     and the endpoint still returns 200 — partial success is success.
 *   - If the audit-row insert fails AFTER sends were made, we log loudly but
 *     still return 200 with `auditFailed:true` so the caller knows.
 */

import {
  BroadcastError,
  sendBroadcastError,
  resolveSenderMember,
  loadActivity,
  checkBroadcastPermission,
  resolveAudience,
  checkRateLimit,
  validateBroadcastPayload,
  findOrCreateActivityConversation,
} from './broadcast-helpers.js'
import { buildBroadcastEmail, FRONTEND_URL } from './email-template.js'
import { sendPushToMembers } from './web-push.js'

// ─── Local helpers ───────────────────────────────────────────────────────────

/**
 * Activity URL on the canonical frontend — matches what the email CTA uses.
 * `events`, `games`, `trainings` (plural) per the existing route shapes.
 */
function buildActivityUrl(type, id) {
  const segment = type === 'game' ? 'games' : type === 'training' ? 'trainings' : 'events'
  return `${FRONTEND_URL}/${segment}/${id}`
}

/**
 * Map a sport key/teamSport string to the email template's `sport` enum.
 * Falls back to neutral when unknown.
 */
function activitySport(activity) {
  if (!activity) return null
  if (activity.type === 'event') return activity.primary_sport || null
  return activity.teamSport || null
}

/**
 * Format a sample name as "First L." for the preview endpoint. Falls back to
 * just first name (or "—") when last name is missing. The full last name is
 * never returned — admins shouldn't be able to enumerate the audience by name.
 */
function formatSampleName(first, last) {
  const f = (first || '').trim()
  const l = (last || '').trim()
  if (!f && !l) return '—'
  if (!l) return f || '—'
  return f ? `${f} ${l[0]}.` : `${l[0]}.`
}

/**
 * Lazily build a Directus MailService instance. Throws if the underlying
 * services aren't available (mis-wiring); the endpoint catches and reports
 * a per-recipient batch failure rather than crashing the whole send.
 */
function getMailService(services, schema, database) {
  const { MailService } = services || {}
  if (!MailService) {
    throw new BroadcastError(500, 'broadcast/mail_service_missing',
      'MailService not available from Directus services')
  }
  return new MailService({ schema, knex: database })
}

// ─── In-flight broadcast guard ───────────────────────────────────────────────

/**
 * Process-local guard against two overlapping sends on the SAME activity.
 *
 * `checkRateLimit` (step 5) reads the `broadcasts` table, but the audit row is
 * only written at step 10 — after the sequential per-recipient mail loop and
 * the push fan-out, which run for tens of seconds on a large audience. Until
 * that row lands the rate limit sees an empty window, so a second request that
 * starts inside it (the coach reloading the PWA and pressing send again on a
 * request the client abandoned but the server is still running; or a coach and
 * a team responsible both reacting to the same last-minute hall change) races
 * straight past the 3-per-hour cap AND the 20-minute spacing rule and re-runs
 * the whole fan-out — every recipient gets the email twice plus a second push
 * (the push `tag` carries `Date.now()`, so the two do not collapse on the
 * device).
 *
 * `broadcasts` is an append-only audit log with no unique constraint, and this
 * change ships without a migration, so there is nothing for Postgres to
 * arbitrate on the way `finance_email_jobs` does. Directus runs as a single
 * container here, so a module-level in-flight set genuinely covers both actor
 * pairs. It would NOT survive multi-instance scaling — a second replica needs a
 * DB-arbitrated claim (a claim row inserted before the fan-out, backed by a
 * partial unique index) to close this properly.
 *
 * The claim is taken before the rate-limit read and always released in the
 * route's `finally`, so a failed or crashed send cannot wedge an activity; the
 * set also dies with the process.
 */
const broadcastsInFlight = new Set()

// ─── Route registration ──────────────────────────────────────────────────────

export function registerBroadcastRoutes(router, ctx) {
  const { services, database, getSchema, logger } = ctx
  const log = logger.child({ extension: 'kscw-broadcast' })

  // ── POST /kscw/activities/:type/:id/broadcast ──────────────────────────
  router.post('/activities/:type/:id/broadcast', async (req, res) => {
    let sender = null
    let activity = null
    let audience = null
    let memberRecords = []
    let externals = []
    // Key held in `broadcastsInFlight`; non-null only once WE claimed it, so
    // the `finally` never releases another request's claim.
    let claimKey = null
    const channels = req.body?.channels ?? {}
    const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : null
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : ''

    try {
      // 1. auth → sender member row
      sender = await resolveSenderMember(database, req.accountability)

      // 2. payload shape (also gates inApp 501 + subject-when-emailing)
      validateBroadcastPayload(req.body)

      // 3. activity lookup
      const { type, id } = req.params
      const activityId = Number(id)
      if (!Number.isFinite(activityId)) {
        throw new BroadcastError(400, 'broadcast/invalid_id',
          'Activity id must be numeric', { id })
      }
      activity = await loadActivity(null, database, type, activityId)

      // 4. RBAC + scope
      await checkBroadcastPermission(database, sender, type, activity)

      // 4.5 Event-only gate for inApp channel
      if (channels.inApp === true && activity.type !== 'event') {
        throw new BroadcastError(400, 'broadcast/inapp_events_only',
          'In-app channel is only available for events',
          { activityType: activity.type })
      }

      // 4.6 in-flight claim — see `broadcastsInFlight` above. Taken BEFORE the
      //     rate-limit read (this check-and-add is synchronous, so it cannot
      //     interleave) so that check → fan-out → audit insert runs alone for
      //     this activity. Released in the `finally` at the end of the route.
      const inFlightKey = `${activity.type}:${activity.id}`
      if (broadcastsInFlight.has(inFlightKey)) {
        throw new BroadcastError(409, 'broadcast/already_in_flight',
          'A broadcast for this activity is already being sent — please wait',
          { activityType: activity.type, activityId: activity.id })
      }
      broadcastsInFlight.add(inFlightKey)
      claimKey = inFlightKey

      // 5. rate limit (per-activity soft limit + per-sender global limit)
      const rate = await checkRateLimit(database, type, activityId, sender?.id)
      if (!rate.allowed) {
        const err = new BroadcastError(429, 'broadcast/rate_limited',
          'Too many broadcasts for this activity — please wait',
          { retryAfterSec: rate.retryAfterSec })
        res.set('Retry-After', String(rate.retryAfterSec))
        throw err
      }

      // 6. audience resolution (members + externals)
      const audienceFilter = req.body.audience
      const resolved = await resolveAudience(database, type, activityId, audienceFilter)
      const memberIds = resolved.memberIds
      externals = resolved.externals
      audience = audienceFilter

      // 7. load member contact rows (filters wiedisync_active again as a
      //    belt-and-suspenders check — resolveAudience already enforces it
      //    via the join, but we re-select here for the email + first_name).
      memberRecords = memberIds.length > 0
        ? await database('members')
            .whereIn('id', memberIds)
            .where('wiedisync_active', true)
            .select('id', 'email', 'first_name', 'language')
        : []

      const includeExternals = audienceFilter?.includeExternals === true
      const externalsForSend = includeExternals ? externals : []

      // 8. EMAIL channel ───────────────────────────────────────────────
      const emailResult = { sent: 0, failed: 0, errors: [] }
      if (channels.email === true) {
        try {
          const schema = await getSchema()
          const mailService = getMailService(services, schema, database)
          const sport = activitySport(activity)
          const subjectLine = subject || activity.title || 'KSC Wiedikon'

          // Members
          for (const m of memberRecords) {
            if (!m.email) continue
            try {
              const html = buildBroadcastEmail({
                activity: { ...activity, sport },
                sender,
                subject: subjectLine,
                message,
                recipientFirstName: m.first_name || '',
                lang: m.language || 'de',
              })
              await mailService.send({
                to: m.email,
                subject: subjectLine,
                html,
              })
              emailResult.sent++
            } catch (perErr) {
              emailResult.failed++
              if (emailResult.errors.length < 20) {
                emailResult.errors.push({
                  kind: 'member', id: m.id, error: perErr?.message || String(perErr),
                })
              }
              log.warn({
                msg: `[broadcast] email to member ${m.id} (${m.email}) failed: ${perErr?.message}`,
              })
            }
          }

          // Externals (event-only, opt-in)
          for (const ext of externalsForSend) {
            if (!ext.email) continue
            try {
              const html = buildBroadcastEmail({
                activity: { ...activity, sport },
                sender,
                subject: subjectLine,
                message,
                recipientFirstName: (ext.name || '').split(/\s+/)[0] || '',
                lang: ext.language || 'de',
              })
              await mailService.send({
                to: ext.email,
                subject: subjectLine,
                html,
              })
              emailResult.sent++
            } catch (perErr) {
              emailResult.failed++
              if (emailResult.errors.length < 20) {
                emailResult.errors.push({
                  kind: 'external', id: ext.id, error: perErr?.message || String(perErr),
                })
              }
              log.warn({
                msg: `[broadcast] email to external ${ext.id} (${ext.email}) failed: ${perErr?.message}`,
              })
            }
          }
        } catch (mailBatchErr) {
          // MailService unavailable / schema fetch failed — record as a batch
          // failure so the audit row reflects it, but don't 500 the request.
          emailResult.failed += memberRecords.length + externalsForSend.length
          emailResult.errors.push({
            kind: 'batch', error: mailBatchErr?.message || String(mailBatchErr),
          })
          log.error({
            msg: `[broadcast] email batch failed: ${mailBatchErr?.message}`,
            stack: mailBatchErr?.stack,
          })
        }
      }

      // 9. PUSH channel ────────────────────────────────────────────────
      let pushResult = { sent: 0, failed: 0, expired: 0 }
      if (channels.push === true && memberIds.length > 0) {
        try {
          const url = buildActivityUrl(activity.type, activity.id)
          const tag = `broadcast-${activity.type}-${activity.id}-${Date.now()}`
          const pushTitle = subject || activity.title || 'KSC Wiedikon'
          const pushBody = (message || '').slice(0, 200)
          const result = await sendPushToMembers(
            database, memberIds, pushTitle, pushBody, url, tag, log,
          )
          pushResult = {
            sent: result.sent || 0,
            failed: result.failed || 0,
            expired: result.cleaned || 0,
          }
        } catch (pushErr) {
          pushResult.failed = memberIds.length
          log.error({
            msg: `[broadcast] push fan-out failed: ${pushErr?.message}`,
            stack: pushErr?.stack,
          })
        }
      }

      // 9.5 IN-APP channel ────────────────────────────────────────────
      let inAppResult = { sent: 0, failed: 0, conversation_id: null, message_id: null }
      if (channels.inApp === true) {
        try {
          const schema = await getSchema()
          const { ItemsService } = services
          const messagesService = new ItemsService('messages', { schema, knex: database })
          const conversationsService = new ItemsService('conversations', { schema, knex: database })

          // Find or create the event's activity_chat conversation.
          const conv = await findOrCreateActivityConversation(
            database, services, schema, activity, sender,
          )
          inAppResult.conversation_id = conv.id

          // Build target membership: audience (wiedisync_active already filtered
          // via memberRecords at step 7) + sender (force-unarchived so the coach
          // always sees the thread they just sent, regardless of their own
          // team_chat_enabled preference).
          const activeAudienceIds = memberRecords.map(m => m.id)
          const toJoin = Array.from(new Set([...activeAudienceIds, sender.id]))

          if (toJoin.length > 0) {
            // One query for all relevant flags.
            const flagRows = await database('members').whereIn('id', toJoin)
              .select('id', 'communications_banned', 'communications_team_chat_enabled')
            const bannedIds = new Set()
            const archivedByMember = new Map()
            for (const f of flagRows) {
              if (f.communications_banned === true) {
                bannedIds.add(String(f.id))
                continue
              }
              const forceUnarchive = String(f.id) === String(sender.id)
              const archived = forceUnarchive
                ? false
                : !(f.communications_team_chat_enabled === true)
              archivedByMember.set(String(f.id), archived)
            }

            const joinable = toJoin.filter(id => !bannedIds.has(String(id)))
            for (const mid of joinable) {
              const archived = archivedByMember.get(String(mid)) ?? false
              await database.raw(
                `INSERT INTO conversation_members (id, conversation, member, archived, role, joined_at)
                 VALUES (?, ?, ?, ?, 'member', NOW())
                 ON CONFLICT (conversation, member)
                 DO UPDATE SET archived = EXCLUDED.archived`,
                [crypto.randomUUID(), conv.id, mid, archived],
              )
            }
          }

          // Insert the broadcast as a text message via ItemsService so Directus
          // realtime emits. We deliberately do NOT go through
          // POST /messaging/messages — that route's firePushForMessage hook
          // would double-push on top of our channels.push fan-out.
          const nowIso = new Date().toISOString()
          const bodyText = subject ? `**${subject}**\n\n${message}` : message
          const messageId = crypto.randomUUID()
          await messagesService.createOne({
            id: messageId,
            conversation: conv.id,
            sender: sender.id,
            type: 'text',
            body: bodyText,
            created_at: nowIso,
          })

          // Denorm last-message fields for inbox list rendering.
          const preview = bodyText.length > 120 ? bodyText.slice(0, 117) + '...' : bodyText
          await conversationsService.updateOne(conv.id, {
            last_message_at: nowIso,
            last_message_preview: preview,
          })

          inAppResult.sent = 1
          inAppResult.message_id = messageId
        } catch (inAppErr) {
          inAppResult.failed = 1
          log.error({
            msg: `[broadcast] inApp channel failed: ${inAppErr?.message}`,
            stack: inAppErr?.stack,
            code: inAppErr?.code,
          })
        }
      }

      // 10. audit row ──────────────────────────────────────────────────
      let broadcastId = null
      let auditFailed = false
      try {
        const inserted = await database('broadcasts').insert({
          activity_type: activity.type,
          activity_id: activity.id,
          sender: sender.id,
          channels_sent: JSON.stringify({
            email: channels.email === true,
            push: channels.push === true,
            in_app: channels.inApp === true,
          }),
          audience_filter: JSON.stringify(audience || {}),
          recipient_count: memberIds.length + externalsForSend.length,
          recipient_ids: JSON.stringify({
            members: memberIds,
            externals: externalsForSend.map(e => e.id),
          }),
          subject: subject || null,
          message,
          delivery_results: JSON.stringify({
            email: emailResult,
            push: pushResult,
            in_app: inAppResult,
          }),
        }).returning('id')
        // knex returns either [id] or [{id}] depending on dialect/version
        const row = inserted?.[0]
        broadcastId = (row && typeof row === 'object') ? row.id : row
      } catch (auditErr) {
        auditFailed = true
        log.error({
          msg: `[broadcast] AUDIT INSERT FAILED — sends already went out: ${auditErr?.message}`,
          stack: auditErr?.stack,
          activityType: activity.type,
          activityId: activity.id,
          senderId: sender.id,
        })
      }

      // 11. response ───────────────────────────────────────────────────
      const recipientCount = memberIds.length + externalsForSend.length
      log.info(`[broadcast] ${activity.type}#${activity.id} by member ${sender.id} → ${recipientCount} recipients (email sent=${emailResult.sent} failed=${emailResult.failed}, push sent=${pushResult.sent} failed=${pushResult.failed}, inApp sent=${inAppResult.sent} failed=${inAppResult.failed})`)

      return res.json({
        broadcastId,
        recipientCount,
        breakdown: {
          members: memberIds.length,
          externals: externalsForSend.length,
        },
        delivery: {
          email: { sent: emailResult.sent, failed: emailResult.failed },
          push: { sent: pushResult.sent, failed: pushResult.failed, expired: pushResult.expired },
          in_app: {
            sent: inAppResult.sent,
            failed: inAppResult.failed,
            conversation_id: inAppResult.conversation_id,
            message_id: inAppResult.message_id,
          },
        },
        ...(auditFailed ? { auditFailed: true } : {}),
      })
    } catch (err) {
      // BroadcastError → typed JSON; everything else → 500 (helper handles both)
      return sendBroadcastError(res, log, err)
    } finally {
      // Always release — a failed send must not wedge the activity.
      if (claimKey !== null) broadcastsInFlight.delete(claimKey)
    }
  })

  // ── POST /kscw/activities/:type/:id/broadcast/preview ──────────────────
  router.post('/activities/:type/:id/broadcast/preview', async (req, res) => {
    try {
      // 1. auth
      const sender = await resolveSenderMember(database, req.accountability)

      // 2. activity lookup
      const { type, id } = req.params
      const activityId = Number(id)
      if (!Number.isFinite(activityId)) {
        throw new BroadcastError(400, 'broadcast/invalid_id',
          'Activity id must be numeric', { id })
      }
      const activity = await loadActivity(null, database, type, activityId)

      // 3. RBAC (same gate as the real send)
      await checkBroadcastPermission(database, sender, type, activity)

      // 4. audience — preview only requires the audience object, default-shaped
      //    to a permissive but valid filter when missing fields. We still call
      //    the validator so the caller gets a typed 400 for malformed input.
      const audience = (req.body && typeof req.body.audience === 'object') ? req.body.audience : null
      if (!audience) {
        throw new BroadcastError(400, 'broadcast/invalid_payload',
          'audience object required', { field: 'audience' })
      }
      const resolved = await resolveAudience(database, type, activityId, audience)
      const memberIds = resolved.memberIds
      const includeExternals = audience.includeExternals === true
      const externalsAll = resolved.externals
      const externals = includeExternals ? externalsAll : []

      // 5. sample names — first 3 members + first 2 externals (when both
      //    present). If only one kind has rows, fill the slot with up to 5
      //    of that kind so the preview is still useful.
      const sample = []
      const memberQuotaPrimary = (memberIds.length > 0 && externals.length > 0) ? 3 : 5
      const externalQuotaPrimary = (memberIds.length > 0 && externals.length > 0) ? 2 : 5

      if (memberIds.length > 0) {
        const sampleMemberIds = memberIds.slice(0, memberQuotaPrimary)
        const memberRows = await database('members')
          .whereIn('id', sampleMemberIds)
          .select('id', 'first_name', 'last_name')
        // Preserve sampleMemberIds order
        const byId = new Map(memberRows.map(r => [Number(r.id), r]))
        for (const mid of sampleMemberIds) {
          const r = byId.get(Number(mid))
          if (!r) continue
          sample.push({ name: formatSampleName(r.first_name, r.last_name), kind: 'member' })
        }
      }
      if (externals.length > 0) {
        const sampleExternals = externals.slice(0, externalQuotaPrimary)
        for (const ext of sampleExternals) {
          // event_signups.name is a single field — split on whitespace for a
          // best-effort first/last split. Falls back to just the first chunk.
          const parts = (ext.name || '').trim().split(/\s+/)
          const first = parts[0] || ''
          const last = parts.slice(1).join(' ')
          sample.push({ name: formatSampleName(first, last), kind: 'external' })
        }
      }

      return res.json({
        recipientCount: memberIds.length + externals.length,
        breakdown: {
          members: memberIds.length,
          externals: externals.length,
        },
        sample,
      })
    } catch (err) {
      return sendBroadcastError(res, log, err)
    }
  })

  log.info('[broadcast] routes registered: POST /activities/:type/:id/broadcast (+ /preview)')
}
