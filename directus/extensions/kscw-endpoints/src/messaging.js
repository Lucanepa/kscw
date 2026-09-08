/**
 * KSCW Messaging — endpoint implementations (Plan 02+).
 *
 * Plan 02: GET /messaging/conversations implemented.
 * Plans 03-06 fill in the remaining routes.
 */

import {
  MessagingError, loadConversationMembership, requireAuth,
  requireMember, requireTeamChatEnabled, requireDmEnabled,
  sendError, shapeConversationSummary,
  loadBlocks, shareTeam, findExistingDmConversation, checkDeclineCooldown,
  requireRequestRecipient,
  requireMessageOwner, requireTeamModerator, snapshotMessage, requireAdmin,
  resolveRecipientsForPush, buildPushPreview,
  checkExportRateLimit, markExportDone,
  searchMembersForDm,
} from './messaging-helpers.js'

const stub = (name) => (req, res) => res.status(501).json({
  code: 'messaging/not_implemented',
  message: `Route ${name} not implemented yet`,
  details: { route: name, method: req.method, path: req.path },
})

/**
 * Process-local per-pair mutex for DM creation.
 *
 * POST /messaging/conversations/dm is a check-then-act: it reads "is there
 * already a dm/dm_request between these two members?" and, several queries
 * later (decline cooldown, shared-team lookup, getSchema), creates one. Two
 * members tapping "Message" on each other within the same few milliseconds —
 * or one member with the app open on phone and laptop — both read null, both
 * fall past the 409 guard and both mint a conversation with its own two
 * conversation_members rows. The pair then has two threads: each inbox lists
 * the same person twice, later messages split across them, and in the
 * no-shared-team case the recipient gets two pending requests.
 *
 * Postgres cannot arbitrate this one: the member pair lives in
 * conversation_members, not in conversations, so there is no column a unique
 * index could cover (unlike uq_conversations_one_per_team and
 * uq_conversations_one_per_activity, which are exactly why the team-chat and
 * activity-chat find-or-create paths are race-safe). So the critical section
 * is serialized in-process, keyed by the ORDERED pair: two different pairs
 * never wait on each other, and A→B collides with B→A. The loser runs only
 * after the winner's writes are committed, finds the winner's conversation and
 * gets the very same 409 the endpoint already returns for an existing DM —
 * rejected visibly, with the conversation id, not silently.
 *
 * ⚠ Directus runs as a SINGLE container here, which is the only reason a
 * process-local guard is sufficient. It would NOT survive scaling to multiple
 * instances; that needs a normalized pair column on `conversations` plus a
 * partial unique index (and a dedup backfill before it can be created).
 *
 * Nothing is persisted and the entry is released whether the holder resolves
 * or throws, so no crash and no ext:deploy restart can strand a pair — the map
 * dies with the process.
 */
const dmPairLocks = new Map() // `${lo}:${hi}` → promise that settles when the current holder is done

function withDmPairLock(memberIdA, memberIdB, fn) {
  // Canonical (order-independent) key, so both directions take the same lock.
  const key = [String(memberIdA), String(memberIdB)].sort().join(':')
  const prev = dmPairLocks.get(key) ?? Promise.resolve()
  // Chain onto the predecessor whether it fulfilled or rejected — one caller's
  // failure must never strand the pair for the next caller.
  const result = prev.then(fn, fn)
  const tail = result.then(() => {}, () => {})
  dmPairLocks.set(key, tail)
  tail.then(() => { if (dmPairLocks.get(key) === tail) dmPairLocks.delete(key) })
  return result
}

export function registerMessaging(router, ctx) {
  const { database: db, logger, services, getSchema } = ctx
  const { ItemsService } = services
  const log = logger.child({ extension: 'kscw-messaging' })

  // Non-blocking push fan-out. Fire-and-forget — never awaited by the caller.
  // Groups recipients by push_preview_content flag and calls sendPushToMembers
  // once per group. Errors logged but don't propagate.
  async function firePushForMessage(conv, sender, body, opts = {}) {
    try {
      const recipientIds = await resolveRecipientsForPush(db, conv, sender.id)
      if (recipientIds.length === 0) return
      const recipients = await db('members')
        .whereIn('id', recipientIds)
        .select('id', 'push_preview_content', 'language')
      const senderName = [sender.first_name, sender.last_name].filter(Boolean).join(' ') || 'KSCW'

      const { sendPushToMembers } = await import('./web-push.js')
      const { memberLangToCode } = await import('./push-i18n.js')
      const url = process.env.FRONTEND_URL || 'https://wiedisync.kscw.ch'
      const pushUrl = `${url}/inbox/${conv.id}`
      const tag = `msg-${conv.id}`

      // Group by (preview-flag × locale) so the generic fallback string is
      // localized and the preview group still gets the sender's actual content.
      const groups = new Map() // key: `${preview ? 'p' : 'g'}-${code}` → { preview, code, ids[] }
      for (const r of recipients) {
        const code = memberLangToCode(r.language)
        const preview = r.push_preview_content === true
        const key = `${preview ? 'p' : 'g'}-${code}`
        if (!groups.has(key)) groups.set(key, { preview, code, ids: [] })
        groups.get(key).ids.push(r.id)
      }

      for (const { preview, code, ids } of groups.values()) {
        if (ids.length === 0) continue
        const bodyText = preview
          ? buildPushPreview({ push_preview_content: true }, senderName, opts.pollQuestion ? `📊 ${opts.pollQuestion}` : body, code)
          : buildPushPreview({ push_preview_content: false }, senderName, body, code)
        const title = preview ? senderName : 'KSC Wiedikon'
        await sendPushToMembers(db, ids, title, bodyText, pushUrl, tag, log)
      }
    } catch (err) {
      log.error({ err: err?.message ?? String(err) }, 'messaging push fan-out failed')
    }
  }

  // ── GET /messaging/conversations ─────────────────────────────────────
  router.get('/messaging/conversations', async (req, res) => {
    try {
      const userId = requireAuth(req)
      const member = await requireMember(db, userId)

      const rows = await db('conversation_members as cm')
        .join('conversations as c', 'c.id', 'cm.conversation')
        .where('cm.member', member.id)
        .andWhere('cm.archived', false)
        .select(
          'c.id as id', 'c.type', 'c.team', 'c.title',
          'c.last_message_at', 'c.last_message_preview',
          'c.activity_type', 'c.activity_id',
          'cm.muted', 'cm.last_read_at',
        )
        .orderByRaw('c.last_message_at DESC NULLS LAST')

      if (rows.length === 0) return res.json([])

      // Load blocks once (for DM invisibility)
      const { either: blockedEither } = await loadBlocks(db, member.id)

      // Batch "other member" lookup for all dm / dm_request conversations
      const dmLikeIds = rows
        .filter(r => r.type === 'dm' || r.type === 'dm_request')
        .map(r => r.id)
      const otherByConv = new Map()
      if (dmLikeIds.length > 0) {
        const otherRows = await db('conversation_members')
          .whereIn('conversation', dmLikeIds)
          .andWhere('member', '<>', member.id)
          .select('conversation', 'member')
        for (const r of otherRows) otherByConv.set(String(r.conversation), String(r.member))
      }

      // Batch message_requests rows for dm_request conversations
      const requestIds = rows.filter(r => r.type === 'dm_request').map(r => r.id)
      const reqByConv = new Map()
      if (requestIds.length > 0) {
        const reqRows = await db('message_requests')
          .whereIn('conversation', requestIds)
          .select('conversation', 'sender', 'recipient', 'status')
        for (const r of reqRows) reqByConv.set(String(r.conversation), r)
      }

      // Visibility filter
      const visible = rows.filter(r => {
        if (r.type === 'dm' || r.type === 'dm_request') {
          const other = otherByConv.get(String(r.id))
          if (!other) return false
          if (blockedEither.has(other)) return false
        }
        if (r.type === 'dm_request') {
          const rq = reqByConv.get(String(r.id))
          if (!rq) return false
          // Sender-silent on decline: don't surface declined requests to the sender
          if (rq.status === 'declined' && String(rq.sender) === String(member.id)) return false
        }
        return true
      })

      if (visible.length === 0) return res.json([])

      // Batch unread counts — scoped to visible ids (preserves Plan 02's pattern)
      const visibleIds = visible.map(r => r.id)
      const unreadRows = await db('messages')
        .whereIn('conversation', visibleIds)
        .andWhereRaw('sender <> ?', [member.id])
        .andWhereRaw('deleted_at IS NULL')
        .andWhere(function () {
          this.where(function () {
            for (const r of visible) {
              if (r.last_read_at) {
                this.orWhere(function () {
                  this.where('conversation', r.id).andWhere('created_at', '>', r.last_read_at)
                })
              } else {
                this.orWhere('conversation', r.id)
              }
            }
          })
        })
        .select('conversation')
        .count('* as n')
        .groupBy('conversation')
      const unreadByConv = new Map(unreadRows.map(r => [String(r.conversation), Number(r.n)]))

      const summaries = visible.map(r => {
        const rq = r.type === 'dm_request' ? reqByConv.get(String(r.id)) : null
        const summary = shapeConversationSummary({
          conv: {
            id: r.id, type: r.type, team: r.team, title: r.title,
            last_message_at: r.last_message_at, last_message_preview: r.last_message_preview,
            activity_type: r.activity_type, activity_id: r.activity_id,
          },
          membership: { muted: r.muted },
          unread_count: unreadByConv.get(String(r.id)) ?? 0,
        })
        if (rq) summary.request_status = rq.status
        if (r.type === 'dm' || r.type === 'dm_request') {
          summary.other_member = otherByConv.get(String(r.id)) ?? null
        }
        return summary
      })

      res.json(summaries)
    } catch (e) { sendError(res, log, e) }
  })

  // ── POST /messaging/messages ────────────────────────────────────────
  router.post('/messaging/messages', async (req, res) => {
    try {
      const userId = requireAuth(req)
      const member = await requireMember(db, userId)

      const b = req.body ?? {}
      const conversationId = typeof b.conversation === 'string' ? b.conversation : null
      const type = b.type === 'text' || b.type === 'poll' ? b.type : null
      const body = typeof b.body === 'string' ? b.body.trim() : ''

      if (!conversationId) {
        throw new MessagingError(400, 'messaging/invalid_body', 'conversation required')
      }
      if (type !== 'text') {
        // Plan 04 adds 'poll'. Reject everything else including unset.
        throw new MessagingError(400, 'messaging/invalid_body', 'type must be "text"')
      }
      if (body.length < 1 || body.length > 4000) {
        throw new MessagingError(400, 'messaging/invalid_body', 'body must be 1..4000 chars')
      }

      const { conv } = await loadConversationMembership(db, conversationId, member.id)

      if (conv.type === 'team') {
        requireTeamChatEnabled(member)
        // Block-check on team conversations: do NOT reject the send; blocks only
        // filter reads server-side (spec §7) so other non-blocked members still see it.
      } else if (conv.type === 'dm' || conv.type === 'dm_request') {
        requireDmEnabled(member)
        const others = await db('conversation_members')
          .where('conversation', conv.id)
          .andWhere('member', '<>', member.id)
          .select('member')
        const otherId = others[0]?.member
        if (otherId != null) {
          const { either } = await loadBlocks(db, member.id)
          if (either.has(String(otherId))) {
            throw new MessagingError(403, 'messaging/blocked',
              'Messaging is blocked between you and this member')
          }
        }
      } else if (conv.type === 'activity_chat') {
        // Activity chats are event-commitment-tied, not team-chat-opt-in-tied.
        // Membership was already validated by loadConversationMembership above;
        // communications_banned was enforced by requireMember. No block check:
        // activity chats aren't DMs.
      } else if (conv.type === 'group_dm') {
        // Group DMs: require dm_enabled (entry point into the group was gated
        // by it; keep the gate here too so opt-out mid-conversation stops sends).
        // Block check: we don't reject the send if some *other* member has a
        // block with the sender — block only filters reads (same rule as team
        // chats). This is different from 1-on-1 DM.
        requireDmEnabled(member)
      } else {
        throw new MessagingError(400, 'messaging/invalid_body',
          `Unsupported conversation type: ${conv.type}`)
      }

      // Write via ItemsService so Directus realtime broadcasts the create.
      // Raw-knex inserts bypass ItemsService's emit pipeline, so any subscriber
      // (the frontend useRealtime hook on the `messages` collection) would
      // never hear the new message. Admin-scoped service is safe here: policy
      // (membership, opt-in) has already been enforced above.
      const preview = body.length > 120 ? body.slice(0, 117) + '...' : body
      const nowIso = new Date().toISOString()
      const schema = await getSchema()

      const messagesService = new ItemsService('messages', { schema, knex: db })
      const conversationsService = new ItemsService('conversations', { schema, knex: db })

      const newId = crypto.randomUUID()
      await messagesService.createOne({
        id: newId,
        conversation: conversationId,
        sender: member.id,
        type: 'text',
        body,
        created_at: nowIso,
      })
      // Denorm — also via service so conversations.update emits for any future
      // subscriber (Plan 03 uses this for preview updates in the inbox list).
      await conversationsService.updateOne(conversationId, {
        last_message_at: nowIso,
        last_message_preview: preview,
      })

      const inserted = {
        id: newId,
        conversation: conversationId,
        sender: member.id,
        type: 'text',
        body,
        poll: null,
        created_at: nowIso,
        edited_at: null,
        deleted_at: null,
        sender_name: [member.first_name, member.last_name].filter(Boolean).join(' ') || null,
      }
      // Non-blocking push fan-out (spec §5). Fire-and-forget.
      ;(async () => { await firePushForMessage(conv, member, body) })()
      res.json(inserted)
    } catch (e) { sendError(res, log, e) }
  })

  // ── POST /messaging/conversations/:id/read ──────────────────────────
  router.post('/messaging/conversations/:id/read', async (req, res) => {
    try {
      const userId = requireAuth(req)
      const member = await requireMember(db, userId)
      const conversationId = req.params.id
      await loadConversationMembership(db, conversationId, member.id)

      const nowIso = new Date().toISOString()
      await db('conversation_members')
        .where({ conversation: conversationId, member: member.id })
        .update({ last_read_at: nowIso })

      res.json({ last_read_at: nowIso })
    } catch (e) { sendError(res, log, e) }
  })

  // ── POST /messaging/conversations/:id/mute ──────────────────────────
  router.post('/messaging/conversations/:id/mute', async (req, res) => {
    try {
      const userId = requireAuth(req)
      const member = await requireMember(db, userId)
      const conversationId = req.params.id
      const { membership } = await loadConversationMembership(db, conversationId, member.id)

      const newMuted = !(membership.muted === true)
      await db('conversation_members')
        .where({ conversation: conversationId, member: member.id })
        .update({ muted: newMuted })

      res.json({ muted: newMuted })
    } catch (e) { sendError(res, log, e) }
  })

  // ── GET /messaging/conversations/:id/messages ───────────────────────
  router.get('/messaging/conversations/:id/messages', async (req, res) => {
    try {
      const userId = requireAuth(req)
      const member = await requireMember(db, userId)
      const conversationId = req.params.id
      await loadConversationMembership(db, conversationId, member.id)

      const { either: blockedEither } = await loadBlocks(db, member.id)
      const blockedIds = [...blockedEither]

      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200)
      const before = typeof req.query.before === 'string' ? req.query.before : null

      let q = db('messages as m')
        .leftJoin('members as s', 's.id', 'm.sender')
        .where('m.conversation', conversationId)
        .andWhereRaw('m.deleted_at IS NULL')
        .orderBy('m.created_at', 'desc')
        .limit(limit + 1)  // +1 to detect has_more
        .select(
          'm.id', 'm.conversation', 'm.sender', 'm.type', 'm.body',
          'm.original_body', 'm.poll', 'm.created_at', 'm.edited_at', 'm.deleted_at',
          's.first_name as sender_first_name', 's.last_name as sender_last_name',
          's.photo as sender_photo',
        )
      if (blockedIds.length > 0) q = q.whereNotIn('m.sender', blockedIds)
      if (before) q = q.andWhere('m.created_at', '<', before)

      const rows = await q
      const has_more = rows.length > limit
      const slice = has_more ? rows.slice(0, limit) : rows

      // Return chronological order (oldest first) for easier rendering
      slice.reverse()
      const messages = slice.map(r => ({
        id: r.id, conversation: r.conversation, sender: r.sender,
        type: r.type, body: r.body, original_body: r.original_body ?? null,
        poll: r.poll,
        created_at: r.created_at, edited_at: r.edited_at, deleted_at: r.deleted_at,
        sender_name: [r.sender_first_name, r.sender_last_name].filter(Boolean).join(' ') || null,
        sender_photo: r.sender_photo ?? null,
      }))

      res.json({ messages, has_more })
    } catch (e) { sendError(res, log, e) }
  })

  // ── POST /messaging/conversations/dm ────────────────────────────────
  router.post('/messaging/conversations/dm', async (req, res) => {
    try {
      const userId = requireAuth(req)
      const me = await requireMember(db, userId)
      requireDmEnabled(me)

      const b = req.body ?? {}
      const recipientId = b.recipient != null ? String(b.recipient) : null
      if (!recipientId) throw new MessagingError(400, 'messaging/invalid_body', 'recipient required')
      if (recipientId === String(me.id))
        throw new MessagingError(400, 'messaging/invalid_body', 'cannot DM yourself')

      const other = await db('members').where('id', recipientId).first()
      if (!other) throw new MessagingError(400, 'messaging/invalid_body', 'recipient not found')
      if (other.communications_banned === true)
        throw new MessagingError(403, 'messaging/comms_disabled', 'Recipient cannot receive messages')
      if (other.communications_dm_enabled !== true)
        throw new MessagingError(403, 'messaging/comms_disabled',
          'Recipient has direct messages disabled')

      const { either } = await loadBlocks(db, me.id)
      if (either.has(String(recipientId)))
        throw new MessagingError(403, 'messaging/blocked', 'Messaging is blocked between you and this member')

      // The "already exists?" read and the writes that follow it are ONE
      // critical section per member pair — see withDmPairLock above. Without
      // it two simultaneous taps both read null and both create a thread.
      const outcome = await withDmPairLock(me.id, recipientId, async () => {
        const existing = await findExistingDmConversation(db, me.id, recipientId)
        if (existing) return { existing }

        await checkDeclineCooldown(db, me.id, recipientId)

        const sharesTeam = await shareTeam(db, me.id, recipientId)
        const convType = sharesTeam ? 'dm' : 'dm_request'

        const schema = await getSchema()
        const conversationsService = new ItemsService('conversations', { schema, knex: db })
        const convMembersService   = new ItemsService('conversation_members', { schema, knex: db })
        const requestsService      = new ItemsService('message_requests', { schema, knex: db })

        const convId = crypto.randomUUID()
        const nowIso = new Date().toISOString()

        await conversationsService.createOne({
          id: convId, type: convType, team: null, title: null,
          created_by: me.id, created_at: nowIso,
        })
        await convMembersService.createMany([
          { id: crypto.randomUUID(), conversation: convId, member: me.id,       archived: false, role: 'member', joined_at: nowIso },
          { id: crypto.randomUUID(), conversation: convId, member: recipientId, archived: false, role: 'member', joined_at: nowIso },
        ])

        let requestStatus = null
        if (convType === 'dm_request') {
          await requestsService.createOne({
            id: crypto.randomUUID(), conversation: convId,
            sender: me.id, recipient: recipientId,
            status: 'pending', created_at: nowIso,
          })
          requestStatus = 'pending'
        }

        return { convId, convType, requestStatus }
      })

      // Loser of a same-pair race lands here too: it saw the winner's row.
      if (outcome.existing) {
        const existing = outcome.existing
        const code = existing.type === 'dm' ? 'messaging/conversation_exists' : 'messaging/request_pending'
        return res.status(409).json({
          code,
          message: existing.type === 'dm' ? 'DM already exists' : 'DM request already pending',
          conversation_id: existing.id,
          type: existing.type,
        })
      }

      res.json({
        conversation_id: outcome.convId,
        created: true,
        type: outcome.convType,
        request_status: outcome.requestStatus,
      })
    } catch (e) { sendError(res, log, e) }
  })

  // ── POST /messaging/requests/:id/accept ─────────────────────────────
  router.post('/messaging/requests/:id/accept', async (req, res) => {
    try {
      const userId = requireAuth(req)
      const me = await requireMember(db, userId)
      requireDmEnabled(me)
      const { req: reqRow } = await requireRequestRecipient(db, req.params.id, me.id)

      const schema = await getSchema()
      const requestsService = new ItemsService('message_requests', { schema, knex: db })
      const conversationsService = new ItemsService('conversations', { schema, knex: db })
      const nowIso = new Date().toISOString()

      await requestsService.updateOne(reqRow.id, { status: 'accepted', resolved_at: nowIso })
      await conversationsService.updateOne(reqRow.conversation, { type: 'dm' })

      res.json({ conversation_id: reqRow.conversation, status: 'accepted' })
    } catch (e) { sendError(res, log, e) }
  })

  // ── POST /messaging/requests/:id/decline ────────────────────────────
  router.post('/messaging/requests/:id/decline', async (req, res) => {
    try {
      const userId = requireAuth(req)
      const me = await requireMember(db, userId)
      const { req: reqRow } = await requireRequestRecipient(db, req.params.id, me.id)

      const schema = await getSchema()
      const requestsService = new ItemsService('message_requests', { schema, knex: db })
      const nowIso = new Date().toISOString()

      await requestsService.updateOne(reqRow.id, { status: 'declined', resolved_at: nowIso })
      res.json({ conversation_id: reqRow.conversation, status: 'declined' })
    } catch (e) { sendError(res, log, e) }
  })

  // ── POST /messaging/blocks ──────────────────────────────────────────
  router.post('/messaging/blocks', async (req, res) => {
    try {
      const userId = requireAuth(req)
      const me = await requireMember(db, userId)
      const targetId = req.body?.member != null ? String(req.body.member) : null
      if (!targetId) throw new MessagingError(400, 'messaging/invalid_body', 'member required')
      if (targetId === String(me.id))
        throw new MessagingError(400, 'messaging/invalid_body', 'cannot block yourself')

      const other = await db('members').where('id', targetId).first()
      if (!other) throw new MessagingError(400, 'messaging/invalid_body', 'member not found')

      const existing = await db('blocks').where({ blocker: me.id, blocked: targetId }).first()
      if (existing) return res.json({ blocked: targetId, created: false })

      const schema = await getSchema()
      const blocksService = new ItemsService('blocks', { schema, knex: db })
      await blocksService.createOne({
        id: crypto.randomUUID(), blocker: me.id, blocked: targetId,
        created_at: new Date().toISOString(),
      })
      res.json({ blocked: targetId, created: true })
    } catch (e) { sendError(res, log, e) }
  })

  // ── DELETE /messaging/blocks/:member ────────────────────────────────
  router.delete('/messaging/blocks/:member', async (req, res) => {
    try {
      const userId = requireAuth(req)
      const me = await requireMember(db, userId)
      const targetId = String(req.params.member)

      const row = await db('blocks').where({ blocker: me.id, blocked: targetId }).first()
      if (!row) return res.json({ unblocked: targetId, removed: false })

      const schema = await getSchema()
      const blocksService = new ItemsService('blocks', { schema, knex: db })
      await blocksService.deleteOne(row.id)
      res.json({ unblocked: targetId, removed: true })
    } catch (e) { sendError(res, log, e) }
  })

  // ── PATCH /messaging/settings ───────────────────────────────────────
  router.patch('/messaging/settings', async (req, res) => {
    try {
      const userId = requireAuth(req)
      const me = await requireMember(db, userId)

      const b = req.body ?? {}
      const patch = {}
      if (typeof b.team_chat_enabled === 'boolean')    patch.communications_team_chat_enabled = b.team_chat_enabled
      if (typeof b.dm_enabled === 'boolean')           patch.communications_dm_enabled        = b.dm_enabled
      if (typeof b.push_preview_content === 'boolean') patch.push_preview_content             = b.push_preview_content
      if (Object.keys(patch).length === 0) {
        throw new MessagingError(400, 'messaging/invalid_body', 'no known settings keys in body')
      }

      // Respect admin-forced ban — user cannot flip it off themselves.
      if (me.communications_banned === true) {
        throw new MessagingError(403, 'messaging/banned', 'Your messaging access is disabled')
      }

      // Use ItemsService so Plan 01's trg_messaging_member_team_chat_enabled fires
      // (archives/un-archives conversation_members) and any Directus subscribers
      // get the update event.
      const schema = await getSchema()
      const membersService = new ItemsService('members', { schema, knex: db })
      await membersService.updateOne(me.id, patch)
      res.json({ updated: Object.keys(patch) })
    } catch (e) { sendError(res, log, e) }
  })

  // ── POST /messaging/messages/:id/reactions ──────────────────────────
  router.post('/messaging/messages/:id/reactions', async (req, res) => {
    try {
      const userId = requireAuth(req)
      const me = await requireMember(db, userId)

      const emoji = typeof req.body?.emoji === 'string' ? req.body.emoji : ''
      if (emoji.length < 1 || emoji.length > 8) {
        throw new MessagingError(400, 'messaging/invalid_body', 'emoji must be 1..8 chars')
      }

      const msg = await db('messages').where('id', req.params.id).first()
      if (!msg) throw new MessagingError(404, 'messaging/not_found', 'Message not found')
      // Caller must be in the conversation
      await loadConversationMembership(db, msg.conversation, me.id)
      // Block filter
      const { either } = await loadBlocks(db, me.id)
      if (either.has(String(msg.sender))) {
        throw new MessagingError(403, 'messaging/blocked', 'Cannot react on a blocked sender\u2019s message')
      }

      const existing = await db('message_reactions')
        .where({ message: msg.id, member: me.id, emoji }).first()

      const schema = await getSchema()
      const reactionsService = new ItemsService('message_reactions', { schema, knex: db })

      if (existing) {
        await reactionsService.deleteOne(existing.id)
        return res.json({ added: false, emoji })
      }
      await reactionsService.createOne({
        id: crypto.randomUUID(), message: msg.id, member: me.id,
        emoji, created_at: new Date().toISOString(),
      })
      res.json({ added: true, emoji })
    } catch (e) { sendError(res, log, e) }
  })

  // ── PATCH /messaging/messages/:id ───────────────────────────────────
  router.patch('/messaging/messages/:id', async (req, res) => {
    try {
      const userId = requireAuth(req)
      const me = await requireMember(db, userId)
      const msg = await requireMessageOwner(db, req.params.id, me.id)

      if (msg.deleted_at != null)
        throw new MessagingError(400, 'messaging/invalid_body', 'Cannot edit a deleted message')
      if (msg.type !== 'text')
        throw new MessagingError(400, 'messaging/invalid_body', 'Only text messages can be edited')

      const body = typeof req.body?.body === 'string' ? req.body.body.trim() : ''
      if (body.length < 1 || body.length > 4000)
        throw new MessagingError(400, 'messaging/invalid_body', 'body must be 1..4000 chars')

      const schema = await getSchema()
      const messagesService = new ItemsService('messages', { schema, knex: db })
      const nowIso = new Date().toISOString()
      // Snapshot the ORIGINAL body on first edit so readers can inspect it via "edited"
      // on the UI. Subsequent edits leave it untouched (keeps original, not last version).
      const patch = { body, edited_at: nowIso }
      if (msg.original_body == null) patch.original_body = msg.body
      await messagesService.updateOne(msg.id, patch)

      res.json({
        id: msg.id, body, edited_at: nowIso,
        original_body: patch.original_body ?? msg.original_body ?? null,
      })
    } catch (e) { sendError(res, log, e) }
  })

  // ── DELETE /messaging/messages/:id ──────────────────────────────────
  router.delete('/messaging/messages/:id', async (req, res) => {
    try {
      const userId = requireAuth(req)
      const me = await requireMember(db, userId)

      const msg = await db('messages').where('id', req.params.id).first()
      if (!msg) throw new MessagingError(404, 'messaging/not_found', 'Message not found')
      if (msg.deleted_at != null)
        throw new MessagingError(400, 'messaging/invalid_body', 'Already deleted')

      const isSelf = String(msg.sender) === String(me.id)
      if (!isSelf) {
        // Moderator path — only valid for team conversations
        await requireTeamModerator(db, msg.id, me.id)
      }

      const schema = await getSchema()
      const messagesService = new ItemsService('messages', { schema, knex: db })
      const reportsService  = new ItemsService('reports',  { schema, knex: db })
      const nowIso = new Date().toISOString()

      // Snapshot the body for moderator audit BEFORE we null it out, so the
      // report row still has the evidence the moderator saw.
      const preBody = msg.body ?? null
      const preOriginal = msg.original_body ?? null

      // Redact on soft-delete: clear `body` and `original_body` so a later
      // direct /items/messages read can't resurrect the content. The row
      // itself is kept (id, sender, conversation, created_at, deleted_at)
      // for thread continuity / audit.
      await messagesService.updateOne(msg.id, {
        deleted_at: nowIso,
        body: null,
        original_body: null,
      })

      if (!isSelf) {
        // Moderator audit — auto-close report row (snapshot pre-redaction body)
        await reportsService.createOne({
          id: crypto.randomUUID(),
          reporter: me.id,
          reported_member: msg.sender,
          message: msg.id,
          conversation: msg.conversation,
          reason: 'moderator_delete',
          note: preOriginal && preOriginal !== preBody
            ? `original: ${String(preOriginal).slice(0, 400)}`
            : null,
          message_snapshot: preBody,
          status: 'resolved',
          resolved_by: me.id,
          resolved_at: nowIso,
        })
      }

      res.json({ id: msg.id, deleted_at: nowIso, moderator_delete: !isSelf })
    } catch (e) { sendError(res, log, e) }
  })

  // ── POST /messaging/reports ─────────────────────────────────────────
  const ALLOWED_REPORT_REASONS = new Set(['harassment', 'spam', 'inappropriate', 'other'])

  router.post('/messaging/reports', async (req, res) => {
    try {
      const userId = requireAuth(req)
      const me = await requireMember(db, userId)

      const b = req.body ?? {}
      const reportedMember = b.reported_member != null ? Number(b.reported_member) : null
      const messageId = typeof b.message === 'string' ? b.message : null
      const conversationId = typeof b.conversation === 'string' ? b.conversation : null
      const reason = typeof b.reason === 'string' ? b.reason : null
      const note = typeof b.note === 'string' ? b.note.slice(0, 500) : null

      if (!reportedMember) throw new MessagingError(400, 'messaging/invalid_body', 'reported_member required')
      if (reportedMember === me.id) throw new MessagingError(400, 'messaging/invalid_body', 'cannot report yourself')
      if (!messageId && !conversationId) throw new MessagingError(400, 'messaging/invalid_body', 'message or conversation required')
      if (!reason || !ALLOWED_REPORT_REASONS.has(reason))
        throw new MessagingError(400, 'messaging/invalid_body', `reason must be one of ${[...ALLOWED_REPORT_REASONS].join(',')}`)

      // Rate limit: max 5 reports per member per hour. Prevents a single member
      // from flooding the admin inbox + reports table via the `reason` enum loop.
      const oneHourAgoIso = new Date(Date.now() - 60 * 60 * 1000).toISOString()
      const recent = await db('reports')
        .where('reporter', me.id)
        .andWhere('created_at', '>=', oneHourAgoIso)
        .count({ n: '*' }).first()
      if (Number(recent?.n ?? 0) >= 5) {
        throw new MessagingError(429, 'messaging/rate_limited',
          'Too many reports filed in the last hour — please wait before filing more')
      }

      const snapshot = messageId ? await snapshotMessage(db, messageId) : null

      const schema = await getSchema()
      const reportsService = new ItemsService('reports', { schema, knex: db })
      const id = crypto.randomUUID()
      await reportsService.createOne({
        id,
        reporter: me.id,
        reported_member: reportedMember,
        message: messageId, conversation: conversationId,
        reason, note,
        message_snapshot: snapshot,
        status: 'open',
      })

      // Admin in-app notifications — fan out to every member with role containing
      // 'admin' or 'superuser'. Fetch all members with a non-null role and filter
      // in JS to avoid knex-vs-Postgres `?|` operator bind-parameter conflicts.
      //
      // Notifications column shape: type/title/body/activity_type/activity_id/
      // read/member/team/date_created (DB default CURRENT_TIMESTAMP). Do NOT pass
      // created_at. Matches existing fan-out in src/index.js:1051.
      const allMembersWithRole = await db('members').whereNotNull('role').select('id', 'role')
      const admins = allMembersWithRole.filter(m => {
        const roles = Array.isArray(m.role) ? m.role : (typeof m.role === 'string' ? JSON.parse(m.role) : [])
        return roles.includes('admin') || roles.includes('superuser')
      })
      if (admins.length > 0) {
        const notifRows = admins.map(a => ({
          member: a.id,
          type: 'new_report',
          title: 'new_report',
          body: JSON.stringify({ reportId: id, reason }),
          activity_type: 'report',
          activity_id: id,
          read: false,
        }))
        await db('notifications').insert(notifRows)
      }

      res.json({ id })
    } catch (e) { sendError(res, log, e) }
  })

  // ── GET /messaging/reports ──────────────────────────────────────────
  router.get('/messaging/reports', async (req, res) => {
    try {
      const userId = requireAuth(req)
      // System admins (DIRECTUS_ADMIN_TOKEN) have no members row; try lookup but
      // allow null — requireAdmin will short-circuit via accountability.admin.
      const me = await db('members').where('user', userId)
        .select('id', 'role').first().then(r => r ?? null)
      await requireAdmin(db, me?.id ?? null, req.accountability)

      const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500)
      const statusFilter = typeof req.query.status === 'string' ? req.query.status : null

      let q = db('reports as r')
        .leftJoin('members as rep', 'rep.id', 'r.reporter')
        .leftJoin('members as rm',  'rm.id',  'r.reported_member')
        .orderBy('r.created_at', 'desc')
        .limit(limit)
        .select(
          'r.id', 'r.reporter', 'r.reported_member', 'r.message', 'r.conversation',
          'r.reason', 'r.note', 'r.message_snapshot', 'r.status',
          'r.resolved_by', 'r.resolved_at', 'r.created_at',
          'rep.first_name as reporter_first_name', 'rep.last_name as reporter_last_name',
          'rm.first_name as reported_first_name', 'rm.last_name as reported_last_name',
        )
      if (statusFilter) q = q.where('r.status', statusFilter)
      const rows = await q

      const reports = rows.map(r => ({
        id: r.id, reporter: r.reporter, reported_member: r.reported_member,
        message: r.message, conversation: r.conversation,
        reason: r.reason, note: r.note, message_snapshot: r.message_snapshot,
        status: r.status, resolved_by: r.resolved_by, resolved_at: r.resolved_at, created_at: r.created_at,
        reporter_name: [r.reporter_first_name, r.reporter_last_name].filter(Boolean).join(' ') || null,
        reported_name: [r.reported_first_name, r.reported_last_name].filter(Boolean).join(' ') || null,
      }))

      res.json({ reports })
    } catch (e) { sendError(res, log, e) }
  })

  // ── PATCH /messaging/reports/:id ────────────────────────────────────
  const ALLOWED_REPORT_STATUSES = new Set(['resolved', 'dismissed'])

  router.patch('/messaging/reports/:id', async (req, res) => {
    try {
      const userId = requireAuth(req)
      // System admins (DIRECTUS_ADMIN_TOKEN) have no members row; try lookup but
      // allow null — requireAdmin will short-circuit via accountability.admin.
      const me = await db('members').where('user', userId)
        .select('id', 'role').first().then(r => r ?? null)
      await requireAdmin(db, me?.id ?? null, req.accountability)

      const b = req.body ?? {}
      if (!ALLOWED_REPORT_STATUSES.has(b.status))
        throw new MessagingError(400, 'messaging/invalid_body', 'status must be resolved or dismissed')
      const deleteMessage = b.delete_message === true
      const ban = b.ban === true

      const report = await db('reports').where('id', req.params.id).first()
      if (!report) throw new MessagingError(404, 'messaging/not_found', 'Report not found')

      const schema = await getSchema()
      const reportsService = new ItemsService('reports', { schema, knex: db })
      const messagesService = new ItemsService('messages', { schema, knex: db })
      const membersService = new ItemsService('members', { schema, knex: db })
      const nowIso = new Date().toISOString()

      await reportsService.updateOne(report.id, {
        status: b.status, resolved_by: me?.id ?? null, resolved_at: nowIso,
      })

      if (deleteMessage && report.message) {
        const msg = await db('messages').where('id', report.message).first()
        if (msg && msg.deleted_at == null) {
          await messagesService.updateOne(msg.id, { deleted_at: nowIso })
        }
      }

      if (ban && report.reported_member) {
        await membersService.updateOne(report.reported_member, {
          communications_banned: true,
          communications_team_chat_enabled: false,
          communications_dm_enabled: false,
        })
      }

      res.json({ id: report.id, status: b.status, delete_message: deleteMessage, ban })
    } catch (e) { sendError(res, log, e) }
  })

  // ── POST /messaging/settings/consent ────────────────────────────────
  const CONSENT_DECISIONS = new Set(['accepted', 'declined', 'later'])

  router.post('/messaging/settings/consent', async (req, res) => {
    try {
      const userId = requireAuth(req)
      const me = await requireMember(db, userId)

      const decision = req.body?.decision
      if (!CONSENT_DECISIONS.has(decision))
        throw new MessagingError(400, 'messaging/invalid_body', 'decision must be accepted|declined|later')

      if (me.communications_banned === true)
        throw new MessagingError(403, 'messaging/banned', 'Your messaging access is disabled')

      const schema = await getSchema()
      const membersService = new ItemsService('members', { schema, knex: db })
      const nowIso = new Date().toISOString()
      const patch = { consent_prompted_at: nowIso }
      if (decision === 'accepted') {
        patch.consent_decision = 'accepted'
        patch.communications_team_chat_enabled = true
        patch.communications_dm_enabled = true
      } else if (decision === 'declined') {
        patch.consent_decision = 'declined'
      }
      // 'later' only bumps consent_prompted_at.
      await membersService.updateOne(me.id, patch)

      res.json({ decision, consent_prompted_at: nowIso })
    } catch (e) { sendError(res, log, e) }
  })

  // ── POST /messaging/polls ───────────────────────────────────────────
  router.post('/messaging/polls', async (req, res) => {
    try {
      const userId = requireAuth(req)
      const me = await requireMember(db, userId)

      const b = req.body ?? {}
      const conversationId = typeof b.conversation === 'string' ? b.conversation : null
      const question = typeof b.question === 'string' ? b.question.trim() : ''
      const options = Array.isArray(b.options) ? b.options.map(String).map(s => s.trim()).filter(Boolean) : []
      const mode = b.mode === 'multi' ? 'multi' : 'single'
      const anonymous = b.anonymous === true
      // Migration 171 — default ON for new polls (the form sends it explicitly;
      // absent = older client, keep the everyone-sees-totals default).
      const resultsVisible = b.results_visible !== false
      const deadline = typeof b.deadline === 'string' && b.deadline.length > 0 ? b.deadline : null

      if (!conversationId) throw new MessagingError(400, 'messaging/invalid_body', 'conversation required')
      if (question.length < 1 || question.length > 255)
        throw new MessagingError(400, 'messaging/invalid_body', 'question must be 1..255 chars')
      if (options.length < 2 || options.length > 10)
        throw new MessagingError(400, 'messaging/invalid_body', 'options must be 2..10 non-empty strings')

      const { conv } = await loadConversationMembership(db, conversationId, me.id)
      if (conv.type === 'team') requireTeamChatEnabled(me)
      else if (conv.type === 'dm' || conv.type === 'dm_request') requireDmEnabled(me)
      else throw new MessagingError(400, 'messaging/invalid_body', `Unsupported conversation type: ${conv.type}`)

      const schema = await getSchema()
      const pollsService = new ItemsService('polls', { schema, knex: db })
      const messagesService = new ItemsService('messages', { schema, knex: db })
      const conversationsService = new ItemsService('conversations', { schema, knex: db })
      const nowIso = new Date().toISOString()

      // polls.id is integer (serial). ItemsService.createOne returns the PK.
      const pollId = await pollsService.createOne({
        conversation: conversationId,
        team: null,
        question, options, mode, deadline, anonymous,
        results_visible: resultsVisible,
        created_by: me.id, status: 'open',
      })

      const messageId = crypto.randomUUID()
      await messagesService.createOne({
        id: messageId, conversation: conversationId, sender: me.id,
        type: 'poll', body: null, poll: pollId, created_at: nowIso,
      })

      const preview = `📊 ${question.length > 100 ? question.slice(0, 97) + '...' : question}`
      await conversationsService.updateOne(conversationId, {
        last_message_at: nowIso, last_message_preview: preview,
      })

      // Non-blocking push fan-out (poll variant — use question as preview)
      ;(async () => { await firePushForMessage(conv, me, null, { pollQuestion: question }) })()
      res.json({ poll_id: pollId, message_id: messageId })
    } catch (e) { sendError(res, log, e) }
  })

  // ── POST /messaging/conversations/:id/clear ─────────────────────────
  // 2026-05-12 audit #13: communications-banned members must not be able to
  // wipe their history before moderation can act; bulk operation also gets
  // a per-call row cap so a compromised account can't time out the DB by
  // soft-deleting tens of thousands of rows in one call.
  router.post('/messaging/conversations/:id/clear', async (req, res) => {
    try {
      const userId = requireAuth(req)
      const me = await requireMember(db, userId)
      if (me.communications_banned === true) {
        return sendError(res, log, new MessagingError('communications_banned',
          'Account suspended from messaging', 403))
      }
      await loadConversationMembership(db, req.params.id, me.id)

      const schema = await getSchema()
      const messagesService = new ItemsService('messages', { schema, knex: db })
      const nowIso = new Date().toISOString()

      const CLEAR_BATCH_CAP = 500
      const rows = await db('messages')
        .where('conversation', req.params.id)
        .andWhere('sender', me.id)
        .andWhereRaw('deleted_at IS NULL')
        .orderBy('created_at', 'asc')
        .limit(CLEAR_BATCH_CAP)
        .select('id')
      if (rows.length === 0) return res.json({ cleared: 0 })

      await messagesService.updateMany(rows.map(r => r.id), { deleted_at: nowIso })

      // `more` lets the client re-call until cleared. Without this, the
      // unaware caller would think their history is fully wiped.
      res.json({ cleared: rows.length, more: rows.length === CLEAR_BATCH_CAP })
    } catch (e) { sendError(res, log, e) }
  })

  // ── POST /messaging/export ──────────────────────────────────────────
  router.post('/messaging/export', async (req, res) => {
    try {
      const userId = requireAuth(req)
      const me = await requireMember(db, userId)

      const cachedAt = await checkExportRateLimit(db, me.id)
      if (cachedAt) {
        return res.status(200).json({
          cached: true, last_export_at: cachedAt,
          message: 'Rate-limited to 1 export per 24h. Re-request after 24h from last_export_at.',
        })
      }

      const myConvs = await db('conversation_members as cm')
        .join('conversations as c', 'c.id', 'cm.conversation')
        .where('cm.member', me.id)
        .select('c.id', 'c.type', 'c.team', 'c.title', 'c.created_at', 'c.last_message_at',
                'cm.joined_at', 'cm.last_read_at', 'cm.muted', 'cm.archived')

      const convIds = myConvs.map(c => c.id)

      // 2026-05-12 audit #10: soft-deleted messages must NOT appear in the
      // GDPR export. Self-clear (`POST /conversations/:id/clear`) and
      // moderator-redact both null `body`/`original_body`; including the
      // tombstone rows would re-expose timing metadata for redacted content.
      const messages = convIds.length > 0
        ? await db('messages').whereIn('conversation', convIds)
            .whereNull('deleted_at')
            .select('id', 'conversation', 'sender', 'type', 'body', 'poll',
                    'created_at', 'edited_at')
        : []

      const reactions = convIds.length > 0
        ? await db('message_reactions as mr')
            .join('messages as m', 'm.id', 'mr.message')
            .whereIn('m.conversation', convIds)
            .andWhere(function () {
              this.where('mr.member', me.id).orWhere('m.sender', me.id)
            })
            .select('mr.id', 'mr.message', 'mr.member', 'mr.emoji', 'mr.created_at')
        : []

      const blocks = await db('blocks').where('blocker', me.id)
        .select('id', 'blocker', 'blocked', 'created_at')

      const settingsRow = await db('members').where('id', me.id)
        .select('communications_team_chat_enabled', 'communications_dm_enabled',
                'communications_banned', 'push_preview_content',
                'consent_decision', 'consent_prompted_at', 'last_export_at')
        .first()

      // 2026-05-12 audit #10: `message_snapshot` is the pre-redaction body
      // of another member's message captured at report-time. The reporter
      // has no standing claim to that content — it's a moderation artifact,
      // not personal data belonging to them. Dropped from the export.
      const reportsFiled = await db('reports').where('reporter', me.id)
        .select('id', 'reported_member', 'message', 'conversation',
                'reason', 'note', 'status', 'created_at')

      const bundle = {
        generated_at: new Date().toISOString(),
        member_id: me.id,
        conversations: myConvs,
        messages,
        reactions,
        blocks,
        settings: settingsRow,
        reports_filed: reportsFiled,
      }

      await markExportDone(db, me.id)
      res.json(bundle)
    } catch (e) { sendError(res, log, e) }
  })

  // ── GET /messaging/searchable-members ───────────────────────────────
  // Returns members who are DM-reachable for the caller. Used by the
  // "Neue Nachricht" picker. Caller must have dm_enabled=true themselves
  // (if you're not reachable, you can't initiate either).
  router.get('/messaging/searchable-members', async (req, res) => {
    try {
      const userId = requireAuth(req)
      const me = await requireMember(db, userId)
      requireDmEnabled(me)
      const q = typeof req.query?.q === 'string' ? req.query.q : ''
      const limit = req.query?.limit != null ? Number(req.query.limit) : 20
      const rows = await searchMembersForDm(db, me.id, q, limit)
      res.json({ members: rows })
    } catch (e) { sendError(res, log, e) }
  })

  // ── POST /messaging/conversations/group-dm ──────────────────────────
  // Create a group DM. Body: { member_ids: number[], title?: string }.
  // Rules:
  //   • 2..∞ other members (3+ total counting sender).
  //   • Each target must have dm_enabled=true, be wiedisync_active, not banned.
  //   • No block between sender and any target.
  //   • Self is excluded automatically if present in member_ids.
  //   • Auto-accept for everyone: no request flow (consistent with spec).
  router.post('/messaging/conversations/group-dm', async (req, res) => {
    try {
      const userId = requireAuth(req)
      const me = await requireMember(db, userId)
      requireDmEnabled(me)

      const b = req.body ?? {}
      const rawIds = Array.isArray(b.member_ids) ? b.member_ids : []
      const memberIds = Array.from(new Set(
        rawIds.map(v => Number(v)).filter(n => Number.isFinite(n) && n !== me.id)
      ))
      const title = typeof b.title === 'string' ? b.title.trim().slice(0, 120) : null

      if (memberIds.length < 2) {
        throw new MessagingError(400, 'messaging/invalid_body',
          'member_ids must contain at least 2 other members')
      }

      const targets = await db('members').whereIn('id', memberIds)
        .select('id', 'communications_dm_enabled', 'communications_banned', 'wiedisync_active')
      if (targets.length !== memberIds.length) {
        throw new MessagingError(400, 'messaging/invalid_body', 'one or more member_ids not found')
      }
      for (const t of targets) {
        if (!t.wiedisync_active || !t.communications_dm_enabled || t.communications_banned) {
          throw new MessagingError(403, 'messaging/comms_disabled',
            `Member ${t.id} cannot be added to a group DM (opt-out or banned)`)
        }
      }

      // Block check — any block in either direction against any invitee = reject.
      const { either } = await loadBlocks(db, me.id)
      for (const id of memberIds) {
        if (either.has(String(id))) {
          throw new MessagingError(403, 'messaging/blocked',
            `Blocked relationship prevents this group DM (member ${id})`)
        }
      }

      const schema = await getSchema()
      const conversationsService = new ItemsService('conversations', { schema, knex: db })
      const convMembersService = new ItemsService('conversation_members', { schema, knex: db })

      const convId = crypto.randomUUID()
      const nowIso = new Date().toISOString()
      await conversationsService.createOne({
        id: convId, type: 'group_dm', team: null, title,
        created_by: me.id, created_at: nowIso,
      })
      const rows = [
        { id: crypto.randomUUID(), conversation: convId, member: me.id, archived: false, role: 'member', joined_at: nowIso },
        ...memberIds.map(mid => ({
          id: crypto.randomUUID(), conversation: convId, member: mid,
          archived: false, role: 'member', joined_at: nowIso,
        })),
      ]
      await convMembersService.createMany(rows)

      res.json({ conversation_id: convId, created: true, type: 'group_dm', member_count: rows.length })
    } catch (e) { sendError(res, log, e) }
  })

  // ── POST /messaging/conversations/:id/members ───────────────────────
  // Add a member to an existing group_dm. Any current member can invite.
  // Body: { member: number }. Respects dm_enabled + blocks per spec.
  router.post('/messaging/conversations/:id/members', async (req, res) => {
    try {
      const userId = requireAuth(req)
      const me = await requireMember(db, userId)
      requireDmEnabled(me)
      const { conv } = await loadConversationMembership(db, req.params.id, me.id)
      if (conv.type !== 'group_dm') {
        throw new MessagingError(400, 'messaging/invalid_body',
          'Only group_dm conversations accept members additions')
      }
      const newMemberId = Number(req.body?.member)
      if (!Number.isFinite(newMemberId) || newMemberId === me.id) {
        throw new MessagingError(400, 'messaging/invalid_body', 'member required')
      }
      const target = await db('members').where('id', newMemberId)
        .select('id', 'communications_dm_enabled', 'communications_banned', 'wiedisync_active').first()
      if (!target) throw new MessagingError(400, 'messaging/invalid_body', 'member not found')
      if (!target.wiedisync_active || !target.communications_dm_enabled || target.communications_banned) {
        throw new MessagingError(403, 'messaging/comms_disabled',
          'Target cannot be added (opt-out or banned)')
      }
      const { either } = await loadBlocks(db, me.id)
      if (either.has(String(newMemberId))) {
        throw new MessagingError(403, 'messaging/blocked',
          'Blocked relationship prevents adding this member')
      }
      const existing = await db('conversation_members')
        .where({ conversation: conv.id, member: newMemberId }).first()
      if (existing) {
        // Already a member — un-archive if archived, else no-op.
        if (existing.archived) {
          await db('conversation_members').where('id', existing.id).update({ archived: false })
        }
        return res.json({ added: false, unarchived: !!existing.archived, member: newMemberId })
      }
      const schema = await getSchema()
      const convMembersService = new ItemsService('conversation_members', { schema, knex: db })
      await convMembersService.createOne({
        id: crypto.randomUUID(), conversation: conv.id, member: newMemberId,
        archived: false, role: 'member', joined_at: new Date().toISOString(),
      })
      res.json({ added: true, member: newMemberId })
    } catch (e) { sendError(res, log, e) }
  })

  // ── GET /messaging/conversations/:id/members ────────────────────────
  // Return the full roster of a conversation (currently only used by
  // group_dm ThreadView, but works for any conv type the caller is in).
  router.get('/messaging/conversations/:id/members', async (req, res) => {
    try {
      const userId = requireAuth(req)
      const me = await requireMember(db, userId)
      await loadConversationMembership(db, req.params.id, me.id)
      const rows = await db('conversation_members as cm')
        .join('members as m', 'm.id', 'cm.member')
        .where('cm.conversation', req.params.id)
        .andWhere('cm.archived', false)
        .select('m.id', 'm.first_name', 'm.last_name', 'm.nickname', 'm.photo', 'cm.role', 'cm.joined_at')
        .orderBy('m.last_name')
        .orderBy('m.first_name')
      res.json({ members: rows })
    } catch (e) { sendError(res, log, e) }
  })

  // ── DELETE /messaging/conversations/:id/members/me ──────────────────
  // Self-leave a group_dm. Hard-deletes the caller's conversation_members
  // row. If no members remain, the conversation is deleted (cascades).
  router.delete('/messaging/conversations/:id/members/me', async (req, res) => {
    try {
      const userId = requireAuth(req)
      const me = await requireMember(db, userId)
      const { conv } = await loadConversationMembership(db, req.params.id, me.id)
      if (conv.type !== 'group_dm') {
        throw new MessagingError(400, 'messaging/invalid_body',
          'Self-leave is only valid on group_dm conversations')
      }
      await db('conversation_members')
        .where({ conversation: conv.id, member: me.id })
        .del()
      const remaining = await db('conversation_members')
        .where({ conversation: conv.id })
        .count('* as n').first()
      if (Number(remaining?.n ?? 0) === 0) {
        await db('conversations').where('id', conv.id).del()
        return res.json({ left: true, conversation_deleted: true })
      }
      res.json({ left: true, conversation_deleted: false })
    } catch (e) { sendError(res, log, e) }
  })
}
