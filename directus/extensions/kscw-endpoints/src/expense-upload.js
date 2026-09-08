/**
 * Expense reimbursement upload + OCR + in-app review queue.
 *
 * Members who paid for something out of pocket upload the receipt/invoice; the
 * OCR endpoint extracts amount/date/vendor/description (so they don't retype it);
 * the submit endpoint persists a finance_expenses row (migration 177) AND emails
 * the confirmed data + the file to finance (belt-and-braces side channel). The
 * member follows the status (pending → paid | rejected) on /finance/expense;
 * finance manages the queue on /admin/finance → Expenses.
 *
 * POST  /kscw/expenses/ocr          body { fileId }              → extracted fields
 * POST  /kscw/expenses/submit       body { fileId, amount, ... } → { success, id }
 * PATCH /kscw/expenses/:id          finance-only status/detail edit; status → paid
 *                                   auto-creates the linked finance_payouts row and
 *                                   notifies the member (in-app + email + push);
 *                                   status → rejected notifies too
 * GET   /kscw/expenses/:id/receipt  streams the receipt (owner or finance)
 *
 * All require an authenticated member (session cookie). OCR reuses the existing
 * ANTHROPIC_API_KEY + the raw-fetch pattern from sql-ai.js; the file bytes are
 * read via storage-read.js (AssetsService → the driver named in
 * directus_files.storage), NOT off the local disk — that's what lets the uploads
 * move to R2. Writes are raw knex → writeUserLog on every mutation (CLAUDE.md
 * actor-capture rule).
 */

import { readManagedFile, streamManagedFile } from './storage-read.js'
import { writeErrorLog } from './error-log.js'
import { writeUserLog } from './activity-log.js'
import { buildEmailLayout, buildInfoCard, escHtml, FRONTEND_URL } from './email-template.js'
import { sendPushToMembers } from './web-push.js'
import { sendLocalizedPush, memberLangToCode } from './push-i18n.js'

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || ''
const OCR_MODEL = process.env.EXPENSE_OCR_MODEL || 'claude-haiku-4-5'
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || ''
// Recipient for submitted reimbursements. Overridable per environment via env;
// the default is the club finance inbox so a missing env var never drops the mail.
const FINANCE_INBOX_EMAIL = process.env.FINANCE_INBOX_EMAIL || 'finance@mail.kscw.ch'
// finance@mail.kscw.ch is a Migadu address whose forward to the treasurer lands
// on ClubDesk (kscw.ch, DMARC p=quarantine), which quarantines the softfail
// forwarded copy — so mail to the inbox alone never reaches the treasurer. Send
// the notification DIRECTLY to their real inbox too (SES → Gmail authenticates
// cleanly, same path the registration-approval mails already use). Comma list;
// override per env (empty on dev to avoid mailing the treasurer during testing).
const FINANCE_NOTIFY_EMAILS = (process.env.FINANCE_NOTIFY_EMAILS ?? 'radomir.radovanovic.b@gmail.com')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
// Abuse / cost guard: each member may scan (OCR) and submit at most 5 receipts
// per rolling hour. In-memory sliding window keyed by Directus user id — fine
// for the single-container deployment (resets on container restart, which is rare).
const RATE_LIMIT_MAX = 5
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000
const rateBuckets = new Map()

/** Verify a Cloudflare Turnstile token (same flow as contact-form.js). */
async function verifyTurnstile(token) {
  if (!TURNSTILE_SECRET) {
    // Fail closed — a missing secret must not silently disable bot protection.
    return false
  }
  if (!token) return false
  try {
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${encodeURIComponent(TURNSTILE_SECRET)}&response=${encodeURIComponent(token)}`,
    })
    return (await resp.json()).success === true
  } catch {
    return false
  }
}

/** Sliding-window rate limit. Throws a 429 Error when the cap is exceeded. */
function enforceRateLimit(bucket, userId) {
  const key = `${bucket}:${userId}`
  const now = Date.now()
  const hits = (rateBuckets.get(key) || []).filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS)
  if (hits.length >= RATE_LIMIT_MAX) {
    const err = new Error(`Rate limit reached — max ${RATE_LIMIT_MAX} per hour. Please try again later.`)
    err.status = 429
    err.code = 'rate_limited'
    throw err
  }
  hits.push(now)
  rateBuckets.set(key, hits)
}
// 32MB request cap on the Anthropic side; keep our own limit well under that
// once base64-expanded (~1.37x). 8MB of source bytes is plenty for a receipt.
const MAX_FILE_BYTES = 8 * 1024 * 1024
const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])

const OCR_INSTRUCTIONS = `You are extracting structured data from a scanned expense receipt or invoice that a sports-club member paid out of pocket and wants reimbursed. Read the document and call the extract_expense tool with what you find.

Rules:
- amount: the TOTAL amount the member paid (the grand total / "Total" / "Betrag"), as a number. Use a dot decimal separator. Null if you genuinely cannot find it.
- currency: ISO 4217 code (CHF, EUR, …). Default to CHF for Swiss receipts.
- date: the document/purchase date as yyyy-mm-dd. Null if absent.
- vendor: the merchant / supplier / payee name.
- description: a short (max ~80 chars) human description of what was bought.
- reference: any invoice number / reference / QR-bill reference, else null.
- payee_iban: an IBAN printed on the document (e.g. on a QR-bill payment part), else null. This is the VENDOR's IBAN, not the member's.
- Do not invent values. Use null when a field is not present.`

const EXTRACT_TOOL = {
  name: 'extract_expense',
  // A tool description is a contract, and this one is read on every scan: the ambiguity of
  // a Swiss receipt (Zwischentotal above the Total, an MwSt line that looks like an amount,
  // an invoice date next to a due date) belongs HERE, in the parameter semantics, not in
  // the prose instruction. Measured on a synthetic receipt carrying all four traps.
  description: `Record the fields read off one expense receipt or invoice that a club member paid personally and is claiming back.
Call it once per document, after reading the whole page — a Swiss receipt puts the grand total below the VAT breakdown, so the last amount is usually the right one and the first rarely is.
Pass null for any field that is genuinely not printed; the form asks the member to fill the gaps, and a guessed value is worse than an empty one because it looks confirmed.
It records only what is on the paper: it does not validate the IBAN, convert currency, decide whether the expense is reimbursable, or store anything.`,
  // Keeps the schema-valid-arguments guarantee that tool_choice:'tool' used to give.
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      amount: { type: ['number', 'null'], description: 'Grand total actually paid, VAT included — the "Total" / "Betrag" line, not a subtotal, not the VAT amount, not a single line item. Dot decimal separator.' },
      currency: { type: 'string', description: 'ISO 4217 code of the amount above (CHF, EUR, …). CHF when the receipt shows no currency.' },
      date: { type: ['string', 'null'], description: 'Date the purchase was made, yyyy-mm-dd. On an invoice this is the invoice date, not the due date or a service period.' },
      vendor: { type: ['string', 'null'], description: 'Name of the merchant or supplier who was paid, as printed at the top of the document.' },
      description: { type: ['string', 'null'], description: 'What was bought, in a short phrase (~80 chars) a treasurer can scan — e.g. "Team dinner, 12 people" or "2 match balls".' },
      reference: { type: ['string', 'null'], description: 'Invoice number, receipt number or QR-bill reference, if one is printed.' },
      // ⚠ "Copy it exactly as printed" is load-bearing, not politeness: asked for a compacted
      // IBAN the model drops or duplicates a digit roughly a third of the time (measured
      // 2/5 and 2/6 across two prompt variants), and every corruption was in a re-typed,
      // space-stripped rendering. Verbatim: 6/6. cleanIban() strips the spaces for us.
      payee_iban: { type: ['string', 'null'], description: "IBAN to pay the vendor, typically from a QR-bill payment part. The VENDOR's account — never the member's, and never one written in by hand. Copy it exactly as printed, spaces and all — do not reformat or compact it." },
    },
    required: ['amount', 'currency', 'date', 'vendor', 'description', 'reference', 'payee_iban'],
    additionalProperties: false,
  },
}

function requireMember(req) {
  if (!req.accountability?.user) {
    const err = new Error('Authentication required')
    err.status = 401
    throw err
  }
}

/** ISO 13616 mod-97 IBAN check (server-side mirror of src/utils/iban.ts). */
function isValidIban(raw) {
  const iban = String(raw || '').replace(/\s+/g, '').toUpperCase()
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) return false
  const rearranged = iban.slice(4) + iban.slice(0, 4)
  let remainder = 0
  for (const ch of rearranged) {
    const val = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch
    for (const d of val) remainder = (remainder * 10 + Number(d)) % 97
  }
  return remainder === 1
}

const cleanIban = (s) => String(s || '').replace(/\s+/g, '').toUpperCase()
const isChLiIban = (i) => /^(CH|LI)/.test(i) && isValidIban(i)

/** ClubDesk Sektion → finance section code (matches finance_accounts.division).
 *  Routes an expense to the right section's TK (vb_admin / bb_admin). */
function sektionToSection(sektion) {
  const s = String(sektion || '').trim().toLowerCase()
  if (s === 'volleyball') return 'vb'
  if (s === 'basketball') return 'bb'
  return 'club'
}
// Which section a Sport Admin role is the TK for.
const SECTION_FOR_ROLE = { vb_admin: 'vb', bb_admin: 'bb' }

const fmtAmountFor = (amount, currency) =>
  `${currency} ${Number(amount).toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** Accept ONLY strict ISO yyyy-mm-dd (what <input type=date> emits); anything
 *  else → null. Guards the Postgres `date` column against silent MDY swaps and
 *  22007 insert-500s on locale-formatted text (e.g. "12.05.2026"). */
function toISODate(v) {
  if (v == null) return null
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  const s = String(v).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const d = new Date(`${s}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? null : s
}

/** yyyy-mm-dd | Date → Swiss dd.mm.yyyy (raw-knex `date` cols come back as Date
 *  objects in this stack — see ical-feed.js / broadcast-helpers.js). */
function fmtDateSwiss(v) {
  const iso = toISODate(v)
  if (!iso) return '—'
  const [y, m, d] = iso.split('-')
  return `${d}.${m}.${y}`
}

// Per-locale labels for the notification email's detail card (the card VALUES
// come from data; only these fixed labels need translating).
const CARD_LABELS = {
  de: { amount: 'Betrag', date: 'Datum', vendor: 'Händler', description: 'Beschreibung' },
  gsw: { amount: 'Betrag', date: 'Datum', vendor: 'Händler', description: 'Beschriibig' },
  en: { amount: 'Amount', date: 'Date', vendor: 'Vendor', description: 'Description' },
  fr: { amount: 'Montant', date: 'Date', vendor: 'Commerçant', description: 'Description' },
  it: { amount: 'Importo', date: 'Data', vendor: 'Fornitore', description: 'Descrizione' },
}

// Per-locale mapping of a machine payout-skip reason to member-facing prose is
// on the FRONTEND (expensePayoutSkipped_*). The endpoint returns only the CODE.
const PAYOUT_SKIP = {
  NON_CHF: 'NON_CHF',
  NO_IBAN: 'NO_IBAN',
  ADDRESS_INCOMPLETE: 'ADDRESS_INCOMPLETE',
  FAILED: 'FAILED',
}

// Per-locale member email strings for the status-change notification.
const STATUS_MAIL = {
  paid: {
    de: { subject: (a) => `WiediSync — Spesen bezahlt (${a})`, title: 'Spesen bezahlt', intro: (a) => `Deine Spesen über <strong>${a}</strong> wurden bezahlt.`, noteLabel: 'Notiz der Finanzabteilung', cta: 'Spesen ansehen' },
    gsw: { subject: (a) => `WiediSync — Spese zahlt (${a})`, title: 'Spese zahlt', intro: (a) => `Dini Spese über <strong>${a}</strong> sind zahlt worde.`, noteLabel: 'Notiz vo de Finanzabteilig', cta: 'Spese aaluege' },
    en: { subject: (a) => `WiediSync — Expense paid (${a})`, title: 'Expense paid', intro: (a) => `Your expense of <strong>${a}</strong> has been paid.`, noteLabel: 'Note from finance', cta: 'View expenses' },
    fr: { subject: (a) => `WiediSync — Note de frais payée (${a})`, title: 'Note de frais payée', intro: (a) => `Ta note de frais de <strong>${a}</strong> a été payée.`, noteLabel: 'Note du service financier', cta: 'Voir les notes de frais' },
    it: { subject: (a) => `WiediSync — Spesa pagata (${a})`, title: 'Spesa pagata', intro: (a) => `La tua spesa di <strong>${a}</strong> è stata pagata.`, noteLabel: 'Nota della finanza', cta: 'Vedi le spese' },
  },
  rejected: {
    de: { subject: (a) => `WiediSync — Spesen abgelehnt (${a})`, title: 'Spesen abgelehnt', intro: (a) => `Deine Spesen über <strong>${a}</strong> wurden abgelehnt.`, noteLabel: 'Begründung', cta: 'Spesen ansehen' },
    gsw: { subject: (a) => `WiediSync — Spese abglehnt (${a})`, title: 'Spese abglehnt', intro: (a) => `Dini Spese über <strong>${a}</strong> sind abglehnt worde.`, noteLabel: 'Begründig', cta: 'Spese aaluege' },
    en: { subject: (a) => `WiediSync — Expense rejected (${a})`, title: 'Expense rejected', intro: (a) => `Your expense of <strong>${a}</strong> was rejected.`, noteLabel: 'Reason', cta: 'View expenses' },
    fr: { subject: (a) => `WiediSync — Note de frais refusée (${a})`, title: 'Note de frais refusée', intro: (a) => `Ta note de frais de <strong>${a}</strong> a été refusée.`, noteLabel: 'Motif', cta: 'Voir les notes de frais' },
    it: { subject: (a) => `WiediSync — Spesa respinta (${a})`, title: 'Spesa respinta', intro: (a) => `La tua spesa di <strong>${a}</strong> è stata respinta.`, noteLabel: 'Motivo', cta: 'Vedi le spese' },
  },
}

/** Load a directus_files row + its raw bytes.
 *  Scoped to the caller (uploaded_by = ownerId) so a member can't OCR/exfiltrate
 *  another user's file by id — incl. the private invoice PDFs. 404 (not 403) on a
 *  mismatch avoids an existence oracle.
 *
 *  Bytes come through the storage abstraction (resolves the driver from
 *  directus_files.storage per row), not off the local disk — so this survives the
 *  move to R2. The old path.resolve()/readFile() traversal guard is gone with it:
 *  filename_disk is never joined onto a filesystem path any more. */
async function loadFile(database, fileId, ownerId, deps) {
  const row = await database('directus_files')
    .where({ id: fileId, uploaded_by: ownerId })
    .first('id', 'filename_disk', 'filename_download', 'type', 'filesize')
  if (!row || !row.filename_disk) {
    const err = new Error('File not found')
    err.status = 404
    throw err
  }
  if (!ALLOWED_MIME.has(row.type)) {
    const err = new Error('Unsupported file type — upload a PDF or image (JPG/PNG)')
    err.status = 400
    throw err
  }
  // readManagedFile throws 413 itself once the stream passes maxBytes, so an
  // oversized file is aborted mid-read instead of being buffered in full.
  const { bytes } = await readManagedFile(fileId, deps, { maxBytes: MAX_FILE_BYTES })
  return { row, bytes }
}

export function registerExpenseUpload(router, { database, logger, services, getSchema }) {
  const log = logger.child({ endpoint: 'expense-upload' })

  // ── OCR: extract structured fields from an uploaded receipt/invoice ─────────
  router.post('/expenses/ocr', async (req, res) => {
    const started = Date.now()
    let userId = null
    try {
      requireMember(req)
      userId = req.accountability.user

      if (!ANTHROPIC_API_KEY) {
        const err = new Error('OCR is not configured on the backend')
        err.status = 503
        throw err
      }
      // Bot protection (Cloudflare Turnstile) — gates the costly vision call.
      if (!(await verifyTurnstile(req.body?.turnstile_token))) {
        const err = new Error('Security check failed — please try again')
        err.status = 400
        err.code = 'turnstile'
        throw err
      }
      // Cost guard: max 5 OCR scans per member per hour.
      enforceRateLimit('ocr', userId)

      const fileId = String(req.body?.fileId ?? '').trim()
      if (!fileId) return res.status(400).json({ error: 'fileId required' })

      const { row, bytes } = await loadFile(database, fileId, userId, { services, getSchema, database })
      const b64 = bytes.toString('base64')
      const isPdf = row.type === 'application/pdf'
      const fileBlock = isPdf
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
        : { type: 'image', source: { type: 'base64', media_type: row.type, data: b64 } }

      const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: OCR_MODEL,
          max_tokens: 1024,
          tools: [EXTRACT_TOOL],
          tool_choice: { type: 'auto' },
          messages: [{
            role: 'user',
            content: [fileBlock, { type: 'text', text: OCR_INSTRUCTIONS }],
          }],
        }),
      })

      const data = await anthropicResp.json()
      if (!anthropicResp.ok || data.error) {
        const errMsg = data?.error?.message || `Anthropic API ${anthropicResp.status}`
        const err = new Error(errMsg)
        err.status = 502
        err.code = 'anthropic_error'
        throw err
      }

      const toolUse = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'extract_expense')
      const raw = toolUse?.input || {}
      // Defensive coercion — the model is forced to call the tool but we never
      // trust the shape blindly.
      const amountNum = typeof raw.amount === 'number' ? raw.amount
        : (raw.amount != null && !Number.isNaN(Number(raw.amount)) ? Number(raw.amount) : null)
      const extracted = {
        amount: amountNum,
        currency: typeof raw.currency === 'string' && raw.currency.trim() ? raw.currency.trim().toUpperCase().slice(0, 3) : 'CHF',
        date: typeof raw.date === 'string' ? raw.date.slice(0, 10) : null,
        vendor: typeof raw.vendor === 'string' ? raw.vendor.slice(0, 200) : null,
        description: typeof raw.description === 'string' ? raw.description.slice(0, 300) : null,
        reference: typeof raw.reference === 'string' ? raw.reference.slice(0, 140) : null,
        payee_iban: (() => {
          if (typeof raw.payee_iban !== 'string') return null
          const iban = cleanIban(raw.payee_iban).slice(0, 34)
          return isValidIban(iban) ? iban : null
        })(),
      }

      const usage = data.usage || {}
      writeErrorLog({
        level: 'info', source: 'backend', project: 'wiedisync', event: 'expense_ocr',
        endpoint: '/expenses/ocr', userId, action: 'ocr', status: 200,
        durationMs: Date.now() - started, model: OCR_MODEL,
        tokensIn: usage.input_tokens ?? null, tokensOut: usage.output_tokens ?? null,
      })
      res.json({ extracted })
    } catch (err) {
      writeErrorLog({
        level: 'error', source: 'backend', project: 'wiedisync', event: 'expense_ocr',
        endpoint: '/expenses/ocr', userId, action: 'ocr', status: err.status || 500,
        durationMs: Date.now() - started, error: err.message?.slice(0, 1000) ?? null,
      })
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal error' })
    }
  })

  // ── Submit: email the confirmed reimbursement + the file to finance ─────────
  router.post('/expenses/submit', async (req, res) => {
    try {
      requireMember(req)
      const userId = req.accountability.user
      // Cost/spam guard: max 5 reimbursement submissions per member per hour.
      enforceRateLimit('submit', userId)

      const fileId = String(req.body?.fileId ?? '').trim()
      if (!fileId) return res.status(400).json({ error: 'fileId required' })

      const amount = req.body?.amount
      if (amount == null || Number.isNaN(Number(amount)) || Number(amount) <= 0) {
        return res.status(400).json({ error: 'A positive amount is required' })
      }
      const currency = String(req.body?.currency || 'CHF').trim().toUpperCase().slice(0, 3)
      // Strict ISO or null — never feed locale-formatted text to the date column.
      const date = toISODate(req.body?.date)
      const vendor = String(req.body?.vendor || '').replace(/[\r\n]/g, ' ').slice(0, 200)
      const description = String(req.body?.description || '').replace(/[\r\n]/g, ' ').slice(0, 300)
      const reference = String(req.body?.reference || '').replace(/[\r\n]/g, ' ').slice(0, 140)
      const note = String(req.body?.note || '').slice(0, 1000)
      const payToIban = String(req.body?.payToIban || '').replace(/\s+/g, '').toUpperCase().slice(0, 34)
      const memberAlreadyPaid = req.body?.memberAlreadyPaid === true || req.body?.memberAlreadyPaid === 'true'

      // A reimbursement always needs an account to pay it to — reject rather than
      // persist a row finance can never pay out (frontend enforces this too).
      if (!payToIban || !isValidIban(payToIban)) {
        return res.status(400).json({ error: 'A valid IBAN is required for the reimbursement', code: 'iban_required' })
      }

      // Submitter identity for the finance email + the persisted row.
      const member = await database('members')
        .where({ user: userId })
        .first('id', 'first_name', 'last_name', 'email', 'sektion')
      const submitterName = member ? `${member.first_name || ''} ${member.last_name || ''}`.trim() : 'Unknown member'
      const submitterEmail = member?.email || null

      const { row, bytes } = await loadFile(database, fileId, userId, { services, getSchema, database })

      // Persist the submission (migration 177) so the member can follow the
      // status and finance has an in-app queue. Degrades to email-only if the
      // member row is missing OR the table doesn't exist yet (ext deployed ahead
      // of its migration — the 2026-06-19 failure mode), so submit never fully
      // regresses to a 500.
      let expenseId = null
      // Set when this submit lost the race for the receipt file and resolved to
      // the claim an earlier request had already created (see the 23505 branch).
      let duplicateOfExisting = false
      if (member) {
        try {
          const [inserted] = await database('finance_expenses')
            .insert({
              member: member.id,
              file: fileId,
              amount: Number(amount),
              currency,
              expense_date: date,
              vendor: vendor || null,
              description: description || null,
              reference: reference || null,
              pay_to_iban: payToIban || null,
              member_note: note || null,
              member_already_paid: memberAlreadyPaid,
              section: sektionToSection(member.sektion),
              status: 'pending',
              user_created: userId,
            })
            .returning('id')
          expenseId = typeof inserted === 'object' ? inserted.id : inserted
        } catch (insErr) {
          // One receipt file backs exactly one claim — enforced by the partial
          // UNIQUE finance_expenses_file_uq (migration 354). The submit is not
          // idempotent on its own: the row commits BEFORE the SES round-trip, so
          // a response lost in that window (phone flipping wifi → cellular, a
          // tunnel hiccup) shows the member a generic error over an
          // already-persisted claim, and pressing Submit again used to mint a
          // second identical pending row — a receipt the treasurer can pay twice,
          // plus a second copy of the PDF mailed to finance.
          //
          // The index arbitrates, not a SELECT-then-INSERT (which has the very
          // race it would be guarding). Deliberately NOT
          // `.onConflict('file').ignore()`: that form drops RETURNING, so the
          // insert reports zero rows and a swallowed duplicate is indistinguishable
          // from a genuine failure.
          if (insErr?.code === '23505') {
            // Scoped to the member too: a claim on someone else's receipt is not
            // ours to hand back (unreachable today — loadFile only resolves files
            // the caller uploaded — so treat a miss as the fallback below).
            const existing = await database('finance_expenses')
              .where({ file: fileId, member: member.id })
              .first('id')
            if (existing) {
              // The claim exists either way, so the retry gets the same answer the
              // first request got — same id, no second row, no second finance mail.
              expenseId = existing.id
              duplicateOfExisting = true
              log.warn(`expense submit: duplicate submit for file ${fileId} — returning existing claim ${expenseId}, no second row and no second finance mail`)
            } else {
              log.error(`expense submit: file ${fileId} is already claimed by another expense — email-only fallback`)
            }
          } else {
            log.error(`expense submit: persist failed (${insErr.message}) — email-only fallback`)
          }
        }
      } else {
        log.warn(`expense submit: no members row for user ${userId} — email-only fallback`)
      }

      const fmtAmount = `${currency} ${Number(amount).toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      const rows = [
        { label: 'Member', value: submitterName },
        ...(submitterEmail ? [{ label: 'Email', value: submitterEmail }] : []),
        { label: 'Amount', value: fmtAmount, halfWidth: true },
        { label: 'Date', value: fmtDateSwiss(date), halfWidth: true },
        { label: 'Vendor', value: vendor || '—' },
        { label: 'Description', value: description || '—' },
        ...(reference ? [{ label: 'Reference', value: reference }] : []),
        { label: 'Pay to IBAN', value: payToIban || '—' },
      ]
      let bodyHtml = buildInfoCard(rows)
      if (note) {
        bodyHtml += `<div style="margin-top:14px;font-size:14px;color:#e2e8f0"><div style="font-size:11px;text-transform:uppercase;color:#64748b;letter-spacing:0.5px;margin-bottom:4px">Note</div>${escHtml(note)}</div>`
      }
      const html = buildEmailLayout(bodyHtml, {
        title: 'Expense reimbursement',
        subtitle: submitterName,
        greeting: 'A member submitted an expense for reimbursement. The original document is attached.',
      })

      // The persisted row is now the source of truth; the finance email is a
      // belt-and-braces side channel. So a mail failure must NOT 500 the request
      // once the row is saved — that's what made a retry create a duplicate row.
      // Email-only fallback (no row) keeps the mail failure fatal so the member
      // isn't told "sent" when nothing was delivered.
      // A submit that resolved to an existing claim must not mail the treasurer a
      // second copy of the same receipt PDF (and cc the member again) — that
      // duplicate delivery is the certain harm of the double submit, and the first
      // request already sent it.
      if (duplicateOfExisting) {
        log.info(`expense submit: finance email skipped — duplicate of claim ${expenseId}, already mailed`)
      } else {
        try {
          const schema = await getSchema()
          const { MailService } = services
          const mail = new MailService({ schema, knex: database })
          // Inbox stays as archive; the treasurer's real address(es) ride as direct
          // recipients so the reimbursement actually lands (see FINANCE_NOTIFY_EMAILS).
          const financeTo = [...new Set([
            FINANCE_INBOX_EMAIL.toLowerCase(),
            ...FINANCE_NOTIFY_EMAILS,
          ])].join(', ')
          await mail.send({
            to: financeTo,
            ...(submitterEmail ? { cc: submitterEmail } : {}),
            subject: `Spesen / expense — ${submitterName} — ${fmtAmount}`,
            html,
            attachments: [{
              filename: row.filename_download || 'receipt',
              content: bytes,
              contentType: row.type,
            }],
          })
        } catch (mailErr) {
          if (!expenseId) throw mailErr
          log.error(`expense submit: finance email failed (${mailErr.message}) — row ${expenseId} persisted, continuing`)
        }
      }

      // Actor capture: this is a "send" mutation (CLAUDE.md audit rule).
      await writeUserLog(database, log, {
        accountability: req.accountability,
        action: 'submit_expense',
        collection: expenseId ? 'finance_expenses' : 'directus_files',
        recordId: expenseId ?? fileId,
        data: { amount: Number(amount), currency, date, vendor, ...(duplicateOfExisting ? { duplicate_of_existing: true } : {}) },
      })

      log.info(`Expense submitted by member ${member?.id ?? '?'} (${fmtAmount})`)
      res.json({ success: true, id: expenseId, ...(duplicateOfExisting ? { duplicate: true } : {}) })
    } catch (err) {
      log.error({ msg: `expense submit: ${err.message}`, stack: err.stack })
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal error' })
    }
  })

  // ── Shared: resolve caller → member row + finance capability ───────────────
  async function actingMember(req) {
    const userId = req.accountability?.user
    if (!userId) return null
    const m = await database('members').where('user', userId).first('id', 'first_name', 'last_name', 'email', 'role')
    if (!m) return null
    const roles = Array.isArray(m.role) ? m.role : (m.role ? (() => { try { return JSON.parse(m.role) } catch { return [] } })() : [])
    return {
      id: m.id,
      name: [m.first_name, m.last_name].filter(Boolean).join(' ').trim() || null,
      email: m.email || null,
      roles,
    }
  }
  // Same gate as finance.js: board or the orthogonal 'finance' role.
  const canManageFinance = (req, mem) =>
    !!req.accountability?.admin || (!!mem && ['vorstand', 'admin', 'superuser', 'finance'].some((r) => mem.roles.includes(r)))

  /** Sections the caller may act as TK for. Board / finance see every section
   *  (incl. rows with no section); a Sport Admin sees only their own. Empty = not
   *  a TK for anything → 403. */
  function tkSections(req, mem) {
    if (canManageFinance(req, mem)) return ['vb', 'bb', 'club']
    const out = new Set()
    if (mem) for (const r of mem.roles) if (SECTION_FOR_ROLE[r]) out.add(SECTION_FOR_ROLE[r])
    return [...out]
  }
  const seesAllSections = (sections) => sections.length >= 3

  /** Reshape a raw joined expense row into the { member: {…} } shape the app's
   *  FinanceExpense type expects (mirrors the items-API expand). */
  function shapeExpenseRow(r) {
    const { member_first_name, member_last_name, ...rest } = r
    return { ...rest, member: { id: r.member, first_name: member_first_name, last_name: member_last_name } }
  }

  // ── Receipt: stream the uploaded file (owner or finance) ────────────────────
  router.get('/expenses/:id/receipt', async (req, res) => {
    try {
      requireMember(req)
      const expenseId = Number(req.params.id)
      if (!Number.isInteger(expenseId) || expenseId <= 0) return res.status(400).json({ error: 'Invalid id' })

      const expense = await database('finance_expenses').where({ id: expenseId }).first('id', 'member', 'file')
      if (!expense || !expense.file) return res.status(404).json({ error: 'Not found' })

      const mem = await actingMember(req)
      const isOwner = !!mem && mem.id === expense.member
      if (!isOwner && !canManageFinance(req, mem)) return res.status(404).json({ error: 'Not found' })

      // No owner scoping here — finance may fetch a file another user uploaded.
      const row = await database('directus_files')
        .where({ id: expense.file })
        .first('id', 'filename_disk', 'filename_download', 'type', 'filesize')
      if (!row || !row.filename_disk) return res.status(404).json({ error: 'Not found' })

      // Streamed through the storage abstraction (driver resolved per row from
      // directus_files.storage), so this keeps working once uploads live in R2.
      await streamManagedFile(
        row.id,
        { services, getSchema, database },
        res,
        { filename: row.filename_download || 'receipt', type: row.type },
      )
    } catch (err) {
      log.error({ msg: `expense receipt: ${err.message}` })
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal error' })
    }
  })

  // ── Update (finance-only): details, note, status lifecycle ──────────────────
  router.patch('/expenses/:id', async (req, res) => {
    try {
      requireMember(req)
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })

      const expenseId = Number(req.params.id)
      if (!Number.isInteger(expenseId) || expenseId <= 0) return res.status(400).json({ error: 'Invalid id' })

      const b = req.body || {}
      const patch = {}
      if (b.amount !== undefined) {
        if (b.amount == null || Number.isNaN(Number(b.amount)) || Number(b.amount) <= 0) {
          return res.status(400).json({ error: 'A positive amount is required' })
        }
        patch.amount = Number(b.amount)
      }
      if (b.currency !== undefined) patch.currency = String(b.currency || 'CHF').trim().toUpperCase().slice(0, 3)
      if (b.expense_date !== undefined) patch.expense_date = toISODate(b.expense_date)
      if (b.vendor !== undefined) patch.vendor = String(b.vendor || '').replace(/[\r\n]/g, ' ').slice(0, 200) || null
      if (b.description !== undefined) patch.description = String(b.description || '').replace(/[\r\n]/g, ' ').slice(0, 300) || null
      if (b.reference !== undefined) patch.reference = String(b.reference || '').replace(/[\r\n]/g, ' ').slice(0, 140) || null
      if (b.pay_to_iban !== undefined) {
        const iban = cleanIban(b.pay_to_iban).slice(0, 34)
        if (iban && !isValidIban(iban)) return res.status(400).json({ error: 'Invalid IBAN' })
        patch.pay_to_iban = iban || null
      }
      if (b.finance_note !== undefined) patch.finance_note = String(b.finance_note || '').slice(0, 1000) || null
      // Shared back-office note (finance / TK / admin) — never shown to the member.
      if (b.internal_note !== undefined) patch.internal_note = String(b.internal_note || '').replace(/\r/g, '').slice(0, 1000) || null
      if (b.status !== undefined && !['pending', 'paid', 'rejected'].includes(String(b.status))) {
        return res.status(400).json({ error: 'Invalid status' })
      }
      if (b.status !== undefined) patch.status = String(b.status)
      if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to update' })

      // Serialize concurrent PATCHes on this row inside a transaction with a row
      // lock — a double-fired "paid" click or two treasurers acting at once would
      // otherwise both pass the !expense.payout check and mint two payouts (double
      // reimbursement). The lock also makes the leave-paid / edit-snapshot / mint
      // branches mutually exclusive. Email + push run AFTER commit (below), never
      // holding the lock across a network call.
      const txResult = await database.transaction(async (trx) => {
        const expense = await trx('finance_expenses').where({ id: expenseId }).forUpdate().first()
        if (!expense) { const e = new Error('Not found'); e.status = 404; throw e }

        const prevStatus = expense.status
        const nextStatus = patch.status !== undefined ? patch.status : prevStatus
        const statusChanged = patch.status !== undefined && nextStatus !== prevStatus
        if (statusChanged) {
          patch.status_changed_by_name = mem?.name || (req.accountability?.admin ? 'Admin' : null)
          patch.status_changed_by_email = mem?.email || null
          patch.status_changed_at = new Date()
        }

        await trx('finance_expenses').where({ id: expenseId }).update(patch)
        const updated = { ...expense, ...patch }

        let payoutCreated = false
        let payoutSkipped = null
        let payoutCancelled = false
        // Load the payee once — needed for both the payout snapshot and the notify.
        let payee = null
        if (statusChanged && (nextStatus === 'paid' || nextStatus === 'rejected')) {
          payee = await trx('members')
            .where({ id: expense.member })
            .first('id', 'first_name', 'last_name', 'email', 'language', 'iban',
              'adresse', 'plz', 'ort', 'billing_different', 'billing_iban',
              'billing_name', 'billing_address', 'billing_plz', 'billing_ort')
        }

        // (a) Leaving 'paid' (mis-click correction) → cancel the auto-payout so the
        // member's My-finances no longer shows a payable QR-bill for money that
        // isn't owed, and finance's ledger isn't left with a phantom paid row.
        if (prevStatus === 'paid' && nextStatus !== 'paid' && expense.payout) {
          await trx('finance_payouts').where({ id: expense.payout }).update({ status: 'cancelled' })
          await trx('finance_expenses').where({ id: expenseId }).update({ payout: null })
          updated.payout = null
          payoutCancelled = true
        }

        // (b) Editing a still-paid expense's money fields → keep the linked payout
        // snapshot (amount / IBAN / message) in sync so the treasurer never pays
        // a stale amount from the payout list.
        if (nextStatus === 'paid' && !statusChanged && expense.payout) {
          const pu = {}
          if (patch.amount !== undefined) pu.amount = Number(updated.amount)
          if (patch.pay_to_iban !== undefined && isChLiIban(cleanIban(updated.pay_to_iban))) {
            pu.iban = cleanIban(updated.pay_to_iban)
          }
          if (patch.vendor !== undefined || patch.description !== undefined) {
            pu.message = `Spesen — ${[updated.vendor, updated.description].filter(Boolean).join(', ')}`.slice(0, 140)
          }
          if (Object.keys(pu).length) await trx('finance_payouts').where({ id: expense.payout }).update(pu)
        }

        // (c) Entering 'paid' fresh → auto-create the linked finance_payouts row.
        if (nextStatus === 'paid' && prevStatus !== 'paid' && !expense.payout && payee) {
          if (String(updated.currency || 'CHF') !== 'CHF') {
            payoutSkipped = PAYOUT_SKIP.NON_CHF
          } else {
            const memberName = [payee.first_name, payee.last_name].filter(Boolean).join(' ').trim()
            const useBilling = !!payee.billing_different && isChLiIban(cleanIban(payee.billing_iban))
            // The IBAN the member asked to be paid on wins; then billing; then profile.
            let iban = null; let name = memberName; let street = payee.adresse; let zip = payee.plz; let city = payee.ort
            if (isChLiIban(cleanIban(updated.pay_to_iban))) {
              iban = cleanIban(updated.pay_to_iban)
            } else if (useBilling) {
              iban = cleanIban(payee.billing_iban)
              name = (payee.billing_name || '').trim() || memberName
              street = payee.billing_address; zip = payee.billing_plz; city = payee.billing_ort
            } else if (isChLiIban(cleanIban(payee.iban))) {
              iban = cleanIban(payee.iban)
            }
            if (!iban) {
              payoutSkipped = PAYOUT_SKIP.NO_IBAN
            } else if (!name || !zip || !city) {
              payoutSkipped = PAYOUT_SKIP.ADDRESS_INCOMPLETE
            } else {
              try {
                const message = `Spesen — ${[updated.vendor, updated.description].filter(Boolean).join(', ')}`.slice(0, 140)
                const [payoutIns] = await trx('finance_payouts')
                  .insert({
                    member: expense.member,
                    amount: Number(updated.amount),
                    currency: 'CHF',
                    message,
                    iban,
                    payee_name: name,
                    payee_address: street || null,
                    payee_zip: zip || null,
                    payee_ort: city || null,
                    status: 'paid',
                    created_by_name: mem?.name || null,
                    created_by_email: mem?.email || null,
                    user_created: req.accountability.user,
                  })
                  .returning('id')
                const payoutId = typeof payoutIns === 'object' ? payoutIns.id : payoutIns
                await trx('finance_expenses').where({ id: expenseId }).update({ payout: payoutId })
                updated.payout = payoutId
                payoutCreated = true
              } catch (e) {
                log.error(`expense auto-payout: ${e.message}`)
                payoutSkipped = PAYOUT_SKIP.FAILED
              }
            }
          }
        }

        return { expense, updated, prevStatus, nextStatus, statusChanged, payoutCreated, payoutSkipped, payoutCancelled, payee }
      })

      const { expense, updated, prevStatus, nextStatus, statusChanged, payoutCreated, payoutSkipped, payoutCancelled, payee } = txResult

      // ── Notify the member (email/push are slow → outside the transaction) ──────
      if (statusChanged && (nextStatus === 'paid' || nextStatus === 'rejected')) {
        if (payee) {
          const fmtAmount = fmtAmountFor(updated.amount, updated.currency || 'CHF')
          try {
            await database('notifications').insert({
              member: payee.id,
              type: 'expense_status',
              title: nextStatus === 'paid' ? 'expense_paid' : 'expense_rejected',
              body: JSON.stringify({ amount: fmtAmount, vendor: updated.vendor || '' }),
              activity_type: 'expense',
              activity_id: String(expenseId),
              read: false,
            })
          } catch (e) {
            log.error(`expense notify (in-app): ${e.message}`)
          }
          if (payee.email) {
            try {
              const code = memberLangToCode(payee.language)
              const tt = STATUS_MAIL[nextStatus][code] || STATUS_MAIL[nextStatus].de
              const cl = CARD_LABELS[code] || CARD_LABELS.de
              const rows = [
                { label: cl.amount, value: fmtAmount, halfWidth: true },
                { label: cl.date, value: fmtDateSwiss(updated.expense_date), halfWidth: true },
                ...(updated.vendor ? [{ label: cl.vendor, value: updated.vendor }] : []),
                ...(updated.description ? [{ label: cl.description, value: updated.description }] : []),
              ]
              let bodyHtml = `<div style="font-size:14px;color:#e2e8f0;margin-bottom:16px">${tt.intro(escHtml(fmtAmount))}</div>` + buildInfoCard(rows)
              if (updated.finance_note) {
                bodyHtml += `<div style="margin-top:14px;font-size:14px;color:#e2e8f0"><div style="font-size:11px;text-transform:uppercase;color:#64748b;letter-spacing:0.5px;margin-bottom:4px">${tt.noteLabel}</div>${escHtml(updated.finance_note)}</div>`
              }
              const html = buildEmailLayout(bodyHtml, {
                title: tt.title,
                subtitle: 'WiediSync',
                ctaUrl: `${FRONTEND_URL}/finance/expense`,
                ctaLabel: tt.cta,
              })
              const schema = await getSchema()
              const { MailService } = services
              const mail = new MailService({ schema, knex: database })
              await mail.send({ to: payee.email, subject: tt.subject(fmtAmount), html })
            } catch (e) {
              log.error(`expense notify (email): ${e.message}`)
            }
          }
          sendLocalizedPush(
            database, [payee.id],
            (ids, title, body) => sendPushToMembers(database, ids, title, body, `${FRONTEND_URL}/finance/expense`, `expense-${expenseId}`, log),
            `expense.${nextStatus}.title`, `expense.${nextStatus}.body`,
            { amount: fmtAmount },
          ).catch((e) => log.error(`expense notify (push): ${e.message}`))
        }
      }

      // Actor capture (raw-knex mutation, CLAUDE.md audit rule).
      await writeUserLog(database, log, {
        accountability: req.accountability,
        action: nextStatus !== prevStatus ? `expense_status_${nextStatus}` : 'update_expense',
        collection: 'finance_expenses',
        recordId: expenseId,
        data: { ...patch, ...(payoutCreated ? { payout: updated.payout } : {}) },
      })

      res.json({ success: true, expense: updated, payoutCreated, payoutCancelled, ...(payoutSkipped ? { payoutSkipped } : {}) })
    } catch (err) {
      log.error({ msg: `expense update: ${err.message}`, stack: err.stack })
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal error' })
    }
  })

  // ── TK queue: expenses the caller (Sport Admin / finance) may confirm ────────
  router.get('/expenses/tk-queue', async (req, res) => {
    try {
      requireMember(req)
      const mem = await actingMember(req)
      const sections = tkSections(req, mem)
      if (!sections.length) return res.status(403).json({ error: 'Forbidden' })

      let q = database('finance_expenses as e')
        .leftJoin('members as m', 'm.id', 'e.member')
        .select(
          'e.*',
          'm.first_name as member_first_name',
          'm.last_name as member_last_name',
        )
        .orderBy('e.date_created', 'desc')
      // A section TK sees only their section; board/finance see all (incl. NULL).
      if (!seesAllSections(sections)) q = q.whereIn('e.section', sections)
      const rows = await q
      res.json({ expenses: rows.map(shapeExpenseRow), sections })
    } catch (err) {
      log.error({ msg: `expense tk-queue: ${err.message}` })
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal error' })
    }
  })

  // ── TK confirm: section admin confirms budget + tells finance if already paid ─
  // Informational only — never touches status / payouts / the ClubDesk mirror.
  router.post('/expenses/:id/tk-confirm', async (req, res) => {
    try {
      requireMember(req)
      const mem = await actingMember(req)
      const sections = tkSections(req, mem)
      if (!sections.length) return res.status(403).json({ error: 'Forbidden' })

      const expenseId = Number(req.params.id)
      if (!Number.isInteger(expenseId) || expenseId <= 0) return res.status(400).json({ error: 'Invalid id' })
      const expense = await database('finance_expenses').where({ id: expenseId }).first()
      if (!expense) return res.status(404).json({ error: 'Not found' })

      const section = expense.section || 'club'
      if (!seesAllSections(sections) && !sections.includes(section)) {
        return res.status(403).json({ error: 'Forbidden' })
      }

      const b = req.body || {}
      const confirmed = b.confirmed !== false // the "Confirm" button; false = un-confirm
      const patch = {
        tk_already_paid: b.already_paid === true || b.already_paid === 'true',
        tk_note: String(b.note || '').replace(/\r/g, '').slice(0, 1000) || null,
      }
      // Shared back-office note (finance / TK / admin). Only touch it when the
      // caller sent it, so a TK confirm without the field never blanks finance's.
      if (b.internal_note !== undefined) {
        patch.internal_note = String(b.internal_note || '').replace(/\r/g, '').slice(0, 1000) || null
      }
      if (confirmed && !expense.tk_confirmed_at) {
        // Stamp the confirmation once (keep the original actor/time on later edits).
        patch.tk_confirmed_at = new Date()
        patch.tk_confirmed_by_name = mem?.name || (req.accountability?.admin ? 'Admin' : null)
        patch.tk_confirmed_by_email = mem?.email || null
      } else if (!confirmed) {
        patch.tk_confirmed_at = null
        patch.tk_confirmed_by_name = null
        patch.tk_confirmed_by_email = null
      }

      await database('finance_expenses').where({ id: expenseId }).update(patch)

      await writeUserLog(database, log, {
        accountability: req.accountability,
        action: confirmed ? 'expense_tk_confirm' : 'expense_tk_unconfirm',
        collection: 'finance_expenses',
        recordId: expenseId,
        data: patch,
      })

      res.json({ success: true, expense: { ...expense, ...patch } })
    } catch (err) {
      log.error({ msg: `expense tk-confirm: ${err.message}`, stack: err.stack })
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal error' })
    }
  })

  log.info('[expense-upload] routes registered')
}
