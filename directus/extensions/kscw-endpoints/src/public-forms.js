/**
 * Public (external) forms for the kscw-website (Batch D / migration 089).
 *
 *   GET  /kscw/public/forms/:slug   — the public form definition (is_public + open)
 *   POST /kscw/public/form-submit    — Turnstile-protected anonymous submission
 *
 * Mirrors registration.js / contact-form.js: anonymous, Turnstile-verified, all
 * DB work via knex in the extension context (NO public Directus policy on
 * `forms` / `form_submissions`). Submissions store member=NULL. The BEFORE
 * INSERT guard (migration 086) still enforces open + deadline server-side.
 */

import { FRONTEND_URL } from './email-template.js'

const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || ''

async function verifyTurnstile(token) {
  if (!TURNSTILE_SECRET) {
    console.error('[public-forms] TURNSTILE_SECRET not configured — rejecting request')
    return false
  }
  const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: String(token) }).toString(),
  })
  return (await resp.json()).success === true
}

// Fields safe to expose publicly — never created_by / audience / internal state.
const PUBLIC_FORM_FIELDS = ['id', 'title', 'description', 'fields', 'success_message', 'slug', 'allow_multiple']

function answerIsEmpty(field, v) {
  if (v === null || v === undefined) return true
  if (field.type === 'multi_choice') return !(Array.isArray(v) && v.length > 0)
  if (field.type === 'file') return !(v && typeof v === 'object' && v.id)
  if (field.type === 'yes_no') return false
  if (typeof v === 'string') return v.trim() === ''
  return false
}

// Compact owner notification (the knex insert bypasses the kscw-hooks action
// that normally fires on form_submissions.create).
async function notifyOwner(db, form, log) {
  try {
    const recipients = new Set()
    if (form.created_by) recipients.add(form.created_by)
    if (form.audience === 'teams') {
      const teamRows = await db('forms_teams').where('forms_id', form.id).select('teams_id')
      const teamIds = [...new Set(teamRows.map(r => r.teams_id).filter(Boolean))]
      if (teamIds.length > 0) {
        const [coaches, trs] = await Promise.all([
          db('teams_coaches').whereIn('teams_id', teamIds).select('members_id'),
          db('teams_responsibles').whereIn('teams_id', teamIds).select('members_id'),
        ])
        for (const r of coaches) if (r.members_id) recipients.add(r.members_id)
        for (const r of trs) if (r.members_id) recipients.add(r.members_id)
      }
    }
    if (recipients.size === 0) return
    const active = await db('members').whereIn('id', [...recipients]).andWhere('wiedisync_active', true)
      .select('id', 'email_notify_form_submissions')
    const ids = active.map(r => r.id)
    if (ids.length === 0) return
    // In-app notification bell goes to every active recipient (unaffected by the
    // opt-out, mirroring how the email categories keep their in-app entry).
    await db('notifications').insert(ids.map(rid => ({
      member: rid, type: 'form_submission', title: 'form_submission',
      body: JSON.stringify({ title: form.title }), activity_type: 'form',
      activity_id: String(form.id), team: null, read: false,
    })))
    // Migration 156: forms send no email — the push is the only intrusive
    // channel, so the opt-out suppresses just the push.
    const pushIds = active.filter(r => r.email_notify_form_submissions !== false).map(r => r.id)
    if (pushIds.length > 0) {
      const { sendPushToMembers } = await import('./web-push.js')
      const { sendLocalizedPush } = await import('./push-i18n.js')
      await sendLocalizedPush(
        db, pushIds,
        (pids, title, body) => sendPushToMembers(db, pids, title, body, `${FRONTEND_URL}/forms`, `form-sub-${form.id}`, log),
        'formSubmission.title', 'formSubmission.body', { title: form.title },
      )
    }
  } catch (err) {
    log.warn(`public form owner-notify failed: ${err.message}`)
  }
}

export function registerPublicForms(router, { database, logger }, helpers) {
  const { ipRateLimit } = helpers
  const log = logger.child({ endpoint: 'public-forms' })
  const submitIp = new Map() // ip → { count, resetAt }

  router.get('/public/forms/:slug', async (req, res) => {
    try {
      const slug = String(req.params.slug || '').slice(0, 80)
      const form = await database('forms')
        .where({ slug, is_public: true, status: 'open' })
        // ⚠ `status` is only half the gate — `closes_at` is a second, independent
        // deadline, and the submit handler below already enforces it. Without the
        // same test HERE a form past its deadline rendered in full and rejected
        // only on submit, i.e. after the visitor had typed the whole thing. A
        // past-deadline form now 404s exactly like a closed or draft one, which
        // the page already renders as "This form is not available."
        .where((q) => q.whereNull('closes_at').orWhere('closes_at', '>', database.fn.now()))
        .select(PUBLIC_FORM_FIELDS).first()
      if (!form) return res.status(404).json({ error: 'Form not found' })
      res.set('Cache-Control', 'public, max-age=120')
      res.json({ data: form })
    } catch (err) {
      log.error({ msg: `public-forms get: ${err.message}`, endpoint: 'public-forms', stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  router.post('/public/form-submit', async (req, res) => {
    try {
      // Rate limit: 8 submissions per 10 min per IP (Turnstile is the real gate).
      if (!ipRateLimit(submitIp, req, 8, 10 * 60 * 1000)) {
        return res.status(429).json({ error: 'Too many requests' })
      }
      const { slug, answers, turnstile_token } = req.body || {}
      if (!slug || typeof answers !== 'object' || answers === null) {
        return res.status(400).json({ error: 'slug and answers required' })
      }
      if (!turnstile_token || !(await verifyTurnstile(turnstile_token))) {
        return res.status(400).json({ error: 'Captcha verification failed' })
      }

      const form = await database('forms')
        .where({ slug: String(slug).slice(0, 80), is_public: true, status: 'open' })
        .select('id', 'title', 'fields', 'closes_at', 'created_by', 'audience').first()
      if (!form) return res.status(404).json({ error: 'Form not found' })
      if (form.closes_at && new Date() > new Date(form.closes_at)) {
        return res.status(400).json({ error: 'This form is closed' })
      }

      // Server-side required-field validation + drop answers to known field ids.
      const fields = Array.isArray(form.fields) ? form.fields : []
      const allowed = {}
      for (const f of fields) {
        const v = answers[f.id]
        if (f.required && answerIsEmpty(f, v)) {
          return res.status(400).json({ error: `Missing required field: ${f.label || f.id}` })
        }
        if (v !== undefined) allowed[f.id] = v
      }

      await database('form_submissions').insert({ form: form.id, member: null, answers: allowed })
      await notifyOwner(database, form, log)

      res.json({ success: true })
    } catch (err) {
      const msg = err?.message || ''
      if (/not open|deadline/i.test(msg)) return res.status(400).json({ error: 'This form is closed' })
      log.error({ msg: `public-forms submit: ${msg}`, endpoint: 'public-forms', stack: err.stack })
      res.status(500).json({ error: 'Internal error' })
    }
  })
}
