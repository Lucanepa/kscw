/**
 * Native invoices (Scope C write-path) — see migrations 128 + 129.
 *
 * ClubDesk stays the source of truth for accounting; these endpoints add the
 * member-facing layer ClubDesk can't do: ad-hoc invoices billed to a member OR
 * a team (e.g. a Swiss Volley fine), payable in-app via the existing QR-bill.
 *
 * Lifecycle (native rows, source='native', on the shared `status` column):
 *   open ──member taps "I've paid"──▶ pending_confirmation
 *        ──treasurer confirms / next ClubDesk sync matches──▶ paid
 *   (cancelled is terminal; set by the treasurer)
 *
 * A member never flips an invoice straight to paid — they self-report, and the
 * treasurer (here) or the sync (Phase 2, import-clubdesk-finance.mjs) confirms.
 *
 * Routes (all under /kscw):
 *   POST   /finance/invoices                 Vorstand — create native invoice
 *   GET    /finance/my-invoices              authed   — own + team-responsible invoices
 *   POST   /finance/invoices/:id/report-paid authed   — recipient self-reports payment
 *   POST   /finance/invoices/:id/confirm     Vorstand — confirm payment (manual)
 *   POST   /finance/invoices/:id/cancel      Vorstand — void a native invoice
 *   POST   /finance/invoices/:id/link-member Vorstand — link an orphaned ClubDesk invoice to a member
 *   DELETE /finance/invoices/:id/link-member Vorstand — remove that link
 *
 * Raw-knex writes → every mutation calls writeUserLog (CLAUDE.md actor-capture).
 */
import { writeUserLog } from './activity-log.js'
import { buildEmailLayout, buildInfoCard, buildAlertBox, FRONTEND_URL } from './email-template.js'
import { renderInvoiceQrBillPdf } from './finance-qrbill.js'
// A proper Swiss Rechnung (addressee, positions, total) rather than a bare
// payment slip — see finance-invoice-pdf.js.
import { renderInvoicePdf, INVOICE_PDF_COLUMNS } from './finance-invoice-pdf.js'
import { recomputeInvoice, deriveSettlement } from './finance-recompute.js'
import { autopostInvoiceSafe, autopostTeamEntrySafe, autopostDuesRunSafe, removeAutopostForPaymentSafe, removeAutopostForTeamEntrySafe, FISCAL_YEAR_LOCK_NS } from './finance-autopost.js'
// The club fee model, shared with the ClubDesk push so the two never disagree.
import { feeBreakdown, guestMemberIdSet, resolveFeeWaivers, FEE_OVERRIDE_FIELDS, NO_LICENCE_SURCHARGE } from './clubdesk-update.js'
// What a FREE member's membership would have cost — printed, never billed.
import { pickRate, isExemptCategory, referenceBase } from './finance-dues-reference.js'

const PAY_METHODS = ['twint', 'bank', 'cash', 'other']

/**
 * ISO-11649 Creditor Reference (SCOR) — "RF" + 2 check digits + body. Valid on a
 * REGULAR IBAN (no QR-IBAN needed), and carried in the QR-bill so a later
 * camt.054 import can match the payment back to this invoice. Body = numeric
 * invoice id. Check via ISO 7064 mod-97-10 (append "RF00", letters→A=10…Z=35).
 */
function scorReference(idNum) {
  const body = String(idNum)
  let rem = 0
  for (const ch of body + 'RF00') {
    const token = /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55) // A=10 … Z=35
    for (const d of token) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97
  }
  return `RF${String(98 - rem).padStart(2, '0')}${body}`
}

/**
 * "Is this invoice a membership-dues bill?" — the double-bill guards' only
 * reliable test. ClubDesk's mirror puts the contact's fee_category on every
 * invoice they receive, so a camp fee is indistinguishable from dues by category
 * alone; the subject is not. Verified on prod: 2365 dues invoices all match,
 * and the 216 that do not are camp fees, training weekends, sponsoring and
 * Freibrief costs. Native dues invoices use the same word (`Mitgliederbeitrag
 * {fy}`, the default subject_template seeded by migration 291).
 */
const DUES_SUBJECT_SQL = "subject ILIKE '%mitgliederbeitrag%'"

/** Invoice line wording for a waiver — resolveFeeWaivers' rule reasons, plus
 *  `gratis` for the members whose CATEGORY is the exemption.
 *  German like every other invoice line — the document goes to the member and
 *  into the club's books, neither of which follow the app's UI locale. */
const WAIVER_LABELS = {
  honorary: 'Erlass — Ehrenmitglied',
  vorstand: 'Erlass — Vorstand',
  coach: 'Erlass — Trainer*in',
  gratis: 'Erlass — Gratismitgliedschaft',
  default: 'Erlass',
}

/** Invoice wording for the federation licence position (migration 323). Keyed by
 *  sektion because the two federations are different organisations charging
 *  different tariffs, and "Verbandslizenz" on a volleyball bill tells the member
 *  less than the name of the body that issued their licence. */
const LICENCE_LABELS = {
  volleyball: 'Swiss Volley Lizenz',
  basketball: 'Swiss Basketball Lizenz',
  default: 'Verbandslizenz',
}
const licenceLabel = (sektion) => LICENCE_LABELS[String(sektion ?? '').trim().toLowerCase()] || LICENCE_LABELS.default

/** Reject after `ms` so one hung send can't stall a whole chunk. */
function withTimeout(promise, ms, label) {
  let t
  const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(label || 'timeout')), ms) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t))
}

/** Compose a dues-invoice notification email (German — the club's canonical
 *  language). In test mode a banner shows where it WOULD have gone. The body only
 *  promises a PDF when one is actually attached. */
function composeDuesEmail(inv, amount, runLabel, { testMode, realRecipient, hasAttachment }) {
  const amountStr = `CHF ${Number(amount).toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const rows = [
    { label: 'Rechnung', value: inv.number || '–', halfWidth: true },
    { label: 'Betrag', value: amountStr, halfWidth: true },
    { label: 'Betreff', value: inv.subject || '–' },
  ]
  if (inv.reference_type === 'SCOR' && inv.reference) rows.push({ label: 'Referenz', value: inv.reference })
  const payLine = hasAttachment
    ? 'Die QR-Rechnung ist als PDF angehängt. Du kannst sie auch direkt in der App mit QR-Rechnung oder TWINT bezahlen.'
    : 'Du kannst diese Rechnung direkt in der App mit QR-Rechnung oder TWINT bezahlen.'
  let body = buildInfoCard(rows)
    + `<div style="font-size:14px;color:#cbd5e1;margin-top:12px">${payLine}</div>`
  if (testMode) body = buildAlertBox('warning', 'Testmodus', `Diese E-Mail wäre an ${realRecipient || 'das Mitglied'} gegangen.`) + body
  const firstName = (inv.recipient_name || '').trim().split(/\s+/)[0]
  return buildEmailLayout(body, {
    title: 'Mitgliederbeitrag',
    subtitle: runLabel || '',
    greeting: firstName ? `Hallo ${firstName}` : 'Hallo',
    ctaUrl: `${FRONTEND_URL}/finance/dues`,
    ctaLabel: 'Rechnung ansehen',
  })
}

/** Compose a payment reminder (Mahnung) email. */
function composeDunningEmail(inv, total, level, fee, { testMode, realRecipient }) {
  const chf = (n) => `CHF ${Number(n).toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const rows = [
    { label: 'Rechnung', value: inv.number || '–', halfWidth: true },
    { label: 'Offener Betrag', value: chf(total), halfWidth: true },
  ]
  if (fee > 0) rows.push({ label: 'Mahngebühr', value: chf(fee) })
  if (inv.reference_type === 'SCOR' && inv.reference) rows.push({ label: 'Referenz', value: inv.reference })
  let body = buildAlertBox('warning', `${level}. Mahnung`, 'Diese Rechnung ist noch offen. Bitte begleiche den Betrag bald.')
    + buildInfoCard(rows)
    + '<div style="font-size:14px;color:#cbd5e1;margin-top:12px">Die QR-Rechnung ist als PDF angehängt. Falls bereits bezahlt, bitte diese Mahnung ignorieren.</div>'
  if (testMode) body = buildAlertBox('info', 'Testmodus', `Diese Mahnung wäre an ${realRecipient || 'das Mitglied'} gegangen.`) + body
  const firstName = (inv.recipient_name || '').trim().split(/\s+/)[0]
  return buildEmailLayout(body, {
    title: `${level}. Mahnung`, subtitle: inv.number || '',
    greeting: firstName ? `Hallo ${firstName}` : 'Hallo',
    ctaUrl: `${FRONTEND_URL}/finance/dues`, ctaLabel: 'Rechnung ansehen',
  })
}

export function registerFinance(router, { database, logger, services, getSchema }) {
  const log = logger.child({ extension: 'kscw-endpoints', module: 'finance' })

  function err(res, req, endpoint, e, code = 500) {
    log.error({ msg: `finance/${endpoint}: ${e.message}`, endpoint: `finance/${endpoint}`, userId: req.accountability?.user || null, method: req.method, stack: e.stack })
    return res.status(code).json({ error: 'Internal error' })
  }

  /**
   * Resolve the calling Directus user to a member row + parsed roles.
   *
   * A caller with NO members row still gets an identity (name/email from
   * directus_users) but `id: null` and `roles: []`. canManageFinance lets an
   * admin_access account through without a member row, so without this fallback
   * every invoice, dues run and payment an admin touches is stamped with a blank
   * created_by — a CHF 190k billing run with no recorded author. Surfaced by the
   * first native dues run (dev, 2026-08-06): user_logs.user NULL, created_by_name ''.
   *
   * ⚠ `id` stays null on purpose — it is the MEMBER id, and callers use it to
   * decide "is this invoice mine". Those sites test `mem?.id`, not `mem`.
   */
  async function actingMember(req) {
    const userId = req.accountability?.user
    if (!userId) return null
    const m = await database('members').where('user', userId).first('id', 'first_name', 'last_name', 'email', 'role')
    if (!m) {
      const u = await database('directus_users').where('id', userId).first('first_name', 'last_name', 'email')
      if (!u) return null
      return {
        id: null,
        name: [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.email || null,
        email: u.email || null,
        roles: [],
      }
    }
    const roles = Array.isArray(m.role) ? m.role : (m.role ? (() => { try { return JSON.parse(m.role) } catch { return [] } })() : [])
    return {
      id: m.id,
      name: [m.first_name, m.last_name].filter(Boolean).join(' ').trim() || null,
      email: m.email || null,
      roles,
    }
  }
  // Finance management = board (Vorstand/admin/superuser) OR the dedicated
  // 'finance' role (treasurer / finance team). All finance WRITE endpoints gate
  // on this; the orthogonal 'finance' role grants the same finance powers without
  // the rest of board-wide access. admin_access bypasses via accountability.admin.
  const canManageFinance = (req, mem) =>
    !!req.accountability?.admin || (!!mem && ['vorstand', 'admin', 'superuser', 'finance'].some((r) => mem.roles.includes(r)))

  /** Team ids the member leads (coach / captain / team-responsible). */
  async function ledTeamIds(memberId) {
    const [coach, tr, cap] = await Promise.all([
      database('teams_coaches').where('members_id', memberId).pluck('teams_id'),
      database('teams_responsibles').where('members_id', memberId).pluck('teams_id'),
      database('teams').where('captain', memberId).pluck('id'),
    ])
    return [...new Set([...coach, ...tr, ...cap].map(Number))]
  }

  const todayISO = () => new Date().toISOString().slice(0, 10)
  const round2 = (n) => Math.round(Number(n) * 100) / 100
  const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim())

  async function fiscalYearIdForDate(iso) {
    const fy = await database('finance_fiscal_years')
      .where('starts_on', '<=', iso).andWhere('ends_on', '>=', iso)
      .orderBy('id').first('id')
    return fy?.id ?? null
  }

  // #10 (2026-07-03 audit): migrations 151/164 lock finance_transactions for closed years,
  // but the invoice/payment SUB-ledger wasn't guarded — a payment/confirm/cancel in a closed
  // year mutates the sub-ledger while autopost silently skips the GL, diverging the books.
  // Guard every sub-ledger mutation on the invoice's fiscal-year status. `db` may be a trx.
  async function fiscalYearClosed(db, fiscalYearId) {
    if (!fiscalYearId) return false
    const fy = await db('finance_fiscal_years').where('id', fiscalYearId).first('status')
    return fy?.status === 'closed'
  }
  const FY_CLOSED_MSG = 'fiscal year is closed — post a correction in an open year'

  // ── POST /finance/invoices — create a native invoice ────────────────────
  router.post('/finance/invoices', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })

      const b = req.body || {}
      const recipientType = ['team', 'contact'].includes(b.recipient_type) ? b.recipient_type : 'member'
      // `amount` is the GROSS figure the treasurer typed; the discount comes off it.
      const gross = round2(b.amount)
      const subject = (b.subject || '').toString().trim()
      const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(b.due_date || '') ? b.due_date : null
      const feeCategory = (b.fee_category || '').toString().trim() || null
      if (!(gross > 0)) return res.status(400).json({ error: 'amount must be greater than 0' })
      if (!subject) return res.status(400).json({ error: 'subject is required' })

      // An on-demand discount, granted at issue rather than written off later:
      // the member's own invoice then shows the reduction as a line instead of
      // silently owing less than it says.
      const discountRaw = b.discount_amount == null ? 0 : round2(b.discount_amount)
      const discount = Number.isFinite(discountRaw) && discountRaw > 0 ? discountRaw : 0
      if (discount >= gross) return res.status(400).json({ error: 'discount must be smaller than the amount' })
      const discountReason = (b.discount_reason || '').toString().trim().slice(0, 120) || 'Rabatt'
      const amount = round2(gross - discount)
      // Positions only when there is something to itemise — a plain invoice keeps
      // rendering its single subject line (finance-invoice-pdf.js → invoiceLines).
      const lines = discount > 0
        ? JSON.stringify([{ label: subject, amount: gross }, { label: discountReason, amount: round2(-discount) }])
        : null

      let memberId = null, teamId = null, contactId = null, recipientName = null, recipientEmail = null
      let recipientAddress = null, recipientZip = null, recipientCity = null
      if (recipientType === 'member') {
        memberId = Number(b.member)
        const tgt = Number.isInteger(memberId) ? await database('members').where('id', memberId).first('id', 'first_name', 'last_name', 'email', 'adresse', 'plz', 'ort') : null
        if (!tgt) return res.status(400).json({ error: 'member not found' })
        recipientName = [tgt.first_name, tgt.last_name].filter(Boolean).join(' ').trim() || null
        recipientEmail = tgt.email || null
        // Same as the dues run: copied at issue time so the PDF has an addressee
        // and the QR bill can name the payer (migration 293).
        recipientAddress = tgt.adresse || null
        recipientZip = tgt.plz != null ? String(tgt.plz) : null
        recipientCity = tgt.ort || null
      } else if (recipientType === 'team') {
        teamId = Number(b.team)
        const tgt = Number.isInteger(teamId) ? await database('teams').where('id', teamId).first('id', 'name') : null
        if (!tgt) return res.status(400).json({ error: 'team not found' })
        recipientName = tgt.name || null
      } else {
        contactId = Number(b.contact)
        const tgt = Number.isInteger(contactId) ? await database('finance_billing_contacts').where('id', contactId).first('id', 'name', 'email') : null
        if (!tgt) return res.status(400).json({ error: 'contact not found' })
        recipientName = tgt.name || null
        recipientEmail = tgt.email || null
      }

      const invoiceDate = todayISO()
      const seqRow = await database.raw("SELECT nextval('finance_native_invoice_seq')::int AS n")
      const seq = (seqRow.rows ? seqRow.rows[0] : seqRow[0]).n
      const number = `N-${invoiceDate.slice(0, 4)}-${String(seq).padStart(4, '0')}`

      const [row] = await database('finance_invoices').insert({
        clubdesk_id: null,
        number,
        invoice_date: invoiceDate,
        subject,
        amount,
        status: 'open',
        due_date: dueDate,
        amount_paid: 0,
        open_amount: amount,
        fee_category: feeCategory,
        lines,
        recipient_name: recipientName,
        recipient_email: recipientEmail,
        recipient_address: recipientAddress,
        recipient_zip: recipientZip,
        recipient_city: recipientCity,
        member: memberId,
        team: teamId,
        contact: contactId,
        fiscal_year: await fiscalYearIdForDate(invoiceDate),
        source: 'native',
        created_by_name: mem?.name || null,
        created_by_email: mem?.email || null,
      }).returning('*')

      // Stamp a SCOR reference (id-derived) for camt reconciliation. Best-effort:
      // a generation hiccup must not fail invoice creation.
      let invoice = row
      try {
        const reference = scorReference(row.id)
        const [updated] = await database('finance_invoices').where('id', row.id)
          .update({ reference, reference_type: 'SCOR', date_updated: new Date() }).returning('*')
        if (updated) invoice = updated
      } catch (e) { log.warn?.({ msg: `scor reference gen failed: ${e.message}`, id: row.id }) }

      await writeUserLog(database, log, { accountability: req.accountability, action: 'create', collection: 'finance_invoices', recordId: invoice.id, data: { kind: 'native_invoice', recipient_type: recipientType, member: memberId, team: teamId, amount, number, ...(discount > 0 ? { gross, discount, discount_reason: discountReason } : {}) } })
      await autopostInvoiceSafe(database, log, invoice.id)
      return res.json({ invoice })
    } catch (e) { return err(res, req, 'create', e) }
  })

  // ── GET /finance/my-invoices — own + team-responsible invoices ──────────
  // Server-side union (system db access) — deliberately NOT a Directus policy
  // filter that walks teams_coaches/responsibles, which silently returns []
  // for non-admins (CLAUDE.md → "M2M deep filter + policy walk").
  router.get('/finance/my-invoices', async (req, res) => {
    try {
      const caller = await actingMember(req)
      // ── "View as member" ────────────────────────────────────────────────
      // Impersonation is CLIENT-SIDE ONLY: api.ts:220 — "the API calls still
      // carry the superadmin's own session". So this endpoint used to resolve
      // the SUPERADMIN's member row while the page claimed to be showing
      // Nadine, and reported "You have no invoices" over a member holding an
      // open CHF 440 bill. Silently showing the wrong person's finances is
      // worse than the feature not existing, so honour an explicit ?member=,
      // gated to exactly who may impersonate (impersonate.js): Directus admin,
      // or the 'superuser' member role. Read-only — no write path takes this.
      const asMember = Number(req.query.member)
      let mem = caller
      if (Number.isInteger(asMember) && asMember > 0 && asMember !== caller?.id) {
        const mayViewAs = req.accountability?.admin === true || (caller?.roles || []).includes('superuser')
        if (!mayViewAs) return res.status(403).json({ error: 'Forbidden' })
        const tgt = await database('members').where('id', asMember).first('id', 'first_name', 'last_name', 'email')
        if (!tgt) return res.status(404).json({ error: 'member not found' })
        mem = { id: tgt.id, name: [tgt.first_name, tgt.last_name].filter(Boolean).join(' ').trim() || null, email: tgt.email || null, roles: [] }
      }
      // `id`, not `mem` — an admin-only account resolves to an identity with a
      // null member id, and "my invoices" is meaningless without a member row.
      if (!mem?.id) return res.status(401).json({ error: 'Unauthenticated' })
      const teamIds = await ledTeamIds(mem.id)

      const rows = await database('finance_invoices as fi')
        .leftJoin('teams as t', 't.id', 'fi.team')
        .where((qb) => {
          qb.where('fi.member', mem.id)
          if (teamIds.length) qb.orWhereIn('fi.team', teamIds)
        })
        .select(
          'fi.id', 'fi.clubdesk_id', 'fi.number', 'fi.invoice_date', 'fi.subject', 'fi.amount',
          'fi.status', 'fi.dunning_status', 'fi.due_date', 'fi.amount_paid', 'fi.open_amount',
          'fi.overpaid_amount', 'fi.written_off_amount', 'fi.payment_method', 'fi.reference', 'fi.reference_type',
          // The positions ride along because a CHF 0 invoice's total says nothing
          // on its own: a free member's document is the entitlement plus the
          // Erlass line that cancels it, and those lines are the whole message
          // (they are never emailed — the page is the only place they land).
          'fi.lines',
          'fi.fee_category', 'fi.closed_on', 'fi.recipient_name', 'fi.member', 'fi.team',
          'fi.source', 'fi.reported_paid_at', 'fi.reported_paid_method', 'fi.reported_paid_by',
          'fi.confirmed_at', 'fi.confirmed_via', 'fi.cancelled_at', 't.name as team_name',
        )
        .orderBy([{ column: 'fi.invoice_date', order: 'desc' }, { column: 'fi.id', order: 'desc' }])
      // The member's fee category rides along so the page can tell "you owe
      // nothing" apart from "nothing has been billed yet". A Gratis member shown
      // a bare "You have no invoices." reads it as a fault and asks the
      // treasurer — which is exactly what happened.
      const cat = await database('members').where('id', mem.id).first('beitragskategorie')
      const feeCategory = (cat?.beitragskategorie || '').trim() || null
      return res.json({
        invoices: rows,
        member_id: mem.id,
        fee_category: feeCategory,
        // Categories that price at CHF 0 — the club never invoices these people.
        no_fee: ['gratis', 'kein beitrag'].includes((feeCategory || '').toLowerCase()),
      })
    } catch (e) { return err(res, req, 'my-invoices', e) }
  })

  /** Load an invoice the caller is the recipient of (member or team lead).
   *  `source` narrows it to one flavour; omit to accept native AND ClubDesk. */
  async function loadOwnInvoice(req, id, source) {
    const mem = await actingMember(req)
    // Recipient check needs a real member id (see actingMember's fallback).
    if (!mem?.id) return { code: 401 }
    const q = database('finance_invoices').where('id', id)
    if (source) q.andWhere('source', source)
    const inv = await q.first()
    if (!inv) return { code: 404 }
    let isRecipient = inv.member != null && Number(inv.member) === mem.id
    if (!isRecipient && inv.team != null) {
      const teamIds = await ledTeamIds(mem.id)
      isRecipient = teamIds.includes(Number(inv.team))
    }
    if (!isRecipient) return { code: 403 }
    return { mem, inv }
  }

  // ── POST /finance/invoices/:id/report-paid — recipient self-reports ─────
  // Works on BOTH invoice sources, by two different mechanisms:
  //   native   — the lifecycle lives on `status`: open → pending_confirmation.
  //   clubdesk — `status` is ClubDesk's own wording and the whole mirror row is
  //              rebuilt nightly, so the report is persisted in the side table
  //              finance_invoice_self_reports (migration 297) and mirrored onto
  //              reported_paid_* here; the importer re-applies it after each sync
  //              and drops it once ClubDesk reports the invoice settled.
  // Either way the member ends up in the same visible state — "pending
  // confirmation", out of their open balance — until finance confirms.
  router.post('/finance/invoices/:id/report-paid', async (req, res) => {
    try {
      const id = Number(req.params.id)
      const r = await loadOwnInvoice(req, id)
      if (r.code) return res.status(r.code).json({ error: r.code === 403 ? 'Forbidden' : r.code === 404 ? 'Not found' : 'Unauthenticated' })
      const method = PAY_METHODS.includes(req.body?.method) ? req.body.method : null
      const now = new Date()

      if (r.inv.source !== 'clubdesk') {
        if (r.inv.status !== 'open') return res.status(409).json({ error: `Invoice is ${r.inv.status}, not open` })
        const [row] = await database('finance_invoices').where('id', id).update({
          status: 'pending_confirmation',
          reported_paid_at: now,
          reported_paid_method: method,
          reported_paid_by: r.mem.id,
          date_updated: now,
        }).returning('*')
        await writeUserLog(database, log, { accountability: req.accountability, action: 'update', collection: 'finance_invoices', recordId: id, data: { kind: 'report_paid', method } })
        return res.json({ invoice: row })
      }

      // ── ClubDesk mirror row ──────────────────────────────────────────────
      const cdStatus = String(r.inv.status || '').trim().toLowerCase()
      if (cdStatus === 'bezahlt' || cdStatus.startsWith('storn') || round2(r.inv.open_amount ?? r.inv.amount) <= 0) {
        return res.status(409).json({ error: `Invoice is ${r.inv.status || 'settled'}, not open` })
      }
      // No clubdesk_id means the row can't be re-found after the next sync, so
      // the report would silently evaporate — refuse rather than pretend.
      const cdId = String(r.inv.clubdesk_id || '').trim()
      if (!cdId) return res.status(409).json({ error: 'Invoice cannot be self-reported (no ClubDesk id)' })

      await database('finance_invoice_self_reports')
        .insert({
          match_clubdesk_id: cdId,
          member: r.mem.id,
          reported_at: now,
          method,
          reported_by_name: r.mem.name || null,
          reported_by_email: r.mem.email || null,
          date_created: now,
          date_updated: now,
        })
        .onConflict('match_clubdesk_id')
        .merge(['member', 'reported_at', 'method', 'reported_by_name', 'reported_by_email', 'date_updated'])
      const [row] = await database('finance_invoices').where('id', id).update({
        reported_paid_at: now,
        reported_paid_method: method,
        reported_paid_by: r.mem.id,
        date_updated: now,
      }).returning('*')
      await writeUserLog(database, log, { accountability: req.accountability, action: 'update', collection: 'finance_invoices', recordId: id, data: { kind: 'report_paid', source: 'clubdesk', clubdesk_id: cdId, method } })
      return res.json({ invoice: row })
    } catch (e) { return err(res, req, 'report-paid', e) }
  })

  // ── POST /finance/invoices/:id/confirm — treasurer confirms payment ─────
  router.post('/finance/invoices/:id/confirm', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })
      const id = Number(req.params.id)
      // Confirm = record a payment for whatever cash is still owed (derived from the
      // ledger, clamped), then recompute — all in one transaction with a row lock so
      // a double-click / concurrent camt credit can't double-count.
      const out = await database.transaction(async (trx) => {
        const inv = await trx('finance_invoices').where('id', id).andWhere('source', 'native').forUpdate().first()
        if (!inv) return { code: 404, msg: 'Not found' }
        if (!['open', 'pending_confirmation', 'partial'].includes(inv.status)) return { code: 409, msg: `Invoice is ${inv.status}` }
        if (await fiscalYearClosed(trx, inv.fiscal_year)) return { code: 409, msg: FY_CLOSED_MSG }
        const entries = await trx('finance_payments').where('invoice', id).select('amount', 'entry_type')
        const remaining = round2(deriveSettlement(entries, inv.amount, inv.status).open_amount)
        if (remaining > 0.005) {
          await trx('finance_payments').insert({
            invoice: id, amount: remaining, entry_type: 'payment',
            method: inv.reported_paid_method || 'manual', payment_date: todayISO(),
            source: 'native', created_by_name: mem?.name || null, created_by_email: mem?.email || null,
          })
        }
        const row = await recomputeInvoice(trx, id, { actorName: mem?.name || null, actorEmail: mem?.email || null, via: 'manual' })
        return { row, remaining }
      })
      if (out.code) return res.status(out.code).json({ error: out.msg })
      await writeUserLog(database, log, { accountability: req.accountability, action: 'update', collection: 'finance_invoices', recordId: id, data: { kind: 'confirm_payment', via: 'manual', amount: out.remaining } })
      await autopostInvoiceSafe(database, log, id)
      return res.json({ invoice: out.row })
    } catch (e) { return err(res, req, 'confirm', e) }
  })

  // ── Settlement ledger entries — partial payments, cash, credit notes, refunds, write-offs ──
  const ENTRY_TYPES = ['payment', 'credit_note', 'refund', 'writeoff']

  // POST /finance/invoices/:id/payments — record one entry, then recompute settlement
  router.post('/finance/invoices/:id/payments', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })
      const id = Number(req.params.id)
      const b = req.body || {}
      const entryType = ENTRY_TYPES.includes(b.entry_type) ? b.entry_type : 'payment'
      const amount = round2(b.amount)
      if (!(amount > 0)) return res.status(400).json({ error: 'amount must be greater than 0' })
      const method = (entryType === 'payment' || entryType === 'refund') ? (PAY_METHODS.includes(b.method) ? b.method : 'other') : null
      const paymentDate = /^\d{4}-\d{2}-\d{2}$/.test(b.payment_date || '') ? b.payment_date : todayISO()
      const note = (b.note || '').toString().trim().slice(0, 255) || null

      const out = await database.transaction(async (trx) => {
        const inv = await trx('finance_invoices').where('id', id).andWhere('source', 'native').forUpdate().first()
        if (!inv) return { code: 404, msg: 'Not found (native invoice expected)' }
        if (inv.status === 'cancelled') return { code: 409, msg: 'Invoice is cancelled' }
        if (await fiscalYearClosed(trx, inv.fiscal_year)) return { code: 409, msg: FY_CLOSED_MSG }
        const ins = await trx('finance_payments').insert({
          invoice: id, amount, entry_type: entryType, method, payment_date: paymentDate, note,
          source: 'native', created_by_name: mem?.name || null, created_by_email: mem?.email || null,
        }).returning('id')
        const paymentId = ins[0]?.id ?? ins[0]
        const row = await recomputeInvoice(trx, id, { actorName: mem?.name || null, actorEmail: mem?.email || null, via: 'manual' })
        return { row, paymentId }
      })
      if (out.code) return res.status(out.code).json({ error: out.msg })
      await writeUserLog(database, log, { accountability: req.accountability, action: 'create', collection: 'finance_payments', recordId: out.paymentId, data: { kind: 'manual_payment', entry_type: entryType, invoice: id, amount } })
      await autopostInvoiceSafe(database, log, id)
      return res.json({ invoice: out.row, payment_id: out.paymentId })
    } catch (e) { return err(res, req, 'record-payment', e) }
  })

  // DELETE /finance/invoices/:id/payments/:pid — undo a manual entry (camt rows excluded)
  router.delete('/finance/invoices/:id/payments/:pid', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })
      const id = Number(req.params.id)
      const pid = Number(req.params.pid)
      const out = await database.transaction(async (trx) => {
        const invLock = await trx('finance_invoices').where('id', id).andWhere('source', 'native').forUpdate().first('id', 'fiscal_year') // lock
        if (invLock && await fiscalYearClosed(trx, invLock.fiscal_year)) return { code: 409, msg: FY_CLOSED_MSG }
        const p = await trx('finance_payments').where('id', pid).andWhere('invoice', id).first('id', 'method')
        if (!p) return { code: 404, msg: 'Not found' }
        if (p.method === 'camt') return { code: 409, msg: 'camt entries are not deletable here (re-import is idempotent)' }
        await trx('finance_payments').where('id', pid).del()
        const row = await recomputeInvoice(trx, id, { actorName: mem?.name || null, actorEmail: mem?.email || null, via: 'manual' })
        return { row }
      })
      if (out.code) return res.status(out.code).json({ error: out.msg })
      await writeUserLog(database, log, { accountability: req.accountability, action: 'delete', collection: 'finance_payments', recordId: pid, data: { kind: 'delete_payment', invoice: id } })
      await removeAutopostForPaymentSafe(database, log, pid)
      await autopostInvoiceSafe(database, log, id)
      return res.json({ invoice: out.row })
    } catch (e) { return err(res, req, 'delete-payment', e) }
  })

  // GET /finance/invoices/:id/payments — the settlement ledger for one invoice
  router.get('/finance/invoices/:id/payments', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })
      const id = Number(req.params.id)
      const rows = await database('finance_payments').where('invoice', id)
        .orderBy([{ column: 'payment_date', order: 'asc' }, { column: 'id', order: 'asc' }])
        .select('id', 'payment_date', 'amount', 'entry_type', 'method', 'note', 'created_by_name', 'camt_reference', 'source')
      return res.json({ payments: rows })
    } catch (e) { return err(res, req, 'list-payments', e) }
  })

  // ── POST /finance/invoices/:id/cancel — void a native invoice ───────────
  router.post('/finance/invoices/:id/cancel', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })
      const id = Number(req.params.id)
      const inv = await database('finance_invoices').where('id', id).andWhere('source', 'native').first()
      if (!inv) return res.status(404).json({ error: 'Not found' })
      if (inv.status === 'paid') return res.status(409).json({ error: 'Cannot cancel a paid invoice' })
      if (await fiscalYearClosed(database, inv.fiscal_year)) return res.status(409).json({ error: FY_CLOSED_MSG })
      // #8/#10: a partially-paid invoice still has real cash recorded in
      // finance_payments. Cancelling zeroes open_amount and (with autopost) the
      // reconcile deletes the settle legs for that cash — understating the GL
      // Bank while the payment rows remain, so the control account no longer
      // reconciles to the sub-ledger. Require the treasurer to refund / write
      // off the received cash first (net cash = payments − refunds).
      const payAgg = await database('finance_payments').where('invoice', id)
        .select(database.raw("COALESCE(SUM(CASE WHEN COALESCE(entry_type,'payment')='payment' THEN amount WHEN entry_type='refund' THEN -amount ELSE 0 END),0) AS net_cash"))
        .first()
      const netCash = Math.round((Number(payAgg?.net_cash) || 0) * 100) / 100
      if (netCash > 0.005) return res.status(409).json({ error: 'Cannot cancel an invoice with received payments — record a refund or write-off first', received: netCash })
      const [row] = await database('finance_invoices').where('id', id).update({
        status: 'cancelled', open_amount: 0, cancelled_at: new Date(), date_updated: new Date(),
      }).returning('*')
      await writeUserLog(database, log, { accountability: req.accountability, action: 'update', collection: 'finance_invoices', recordId: id, data: { kind: 'cancel_native_invoice' } })
      await autopostInvoiceSafe(database, log, id) // removes any standing ledger postings
      return res.json({ invoice: row })
    } catch (e) { return err(res, req, 'cancel', e) }
  })

  // ── POST /finance/invoices/:id/link-member — attach an orphan to a member ─
  // Writes a persistent override (survives the sync's delete+reinsert) AND
  // applies it to the current rows. Default scope = by recipient email (links
  // all that recipient's invoices); falls back to this one invoice if no email.
  router.post('/finance/invoices/:id/link-member', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })
      const id = Number(req.params.id)
      const inv = await database('finance_invoices').where('id', id).andWhere('source', 'clubdesk').first()
      if (!inv) return res.status(404).json({ error: 'Not found (ClubDesk invoice expected)' })
      const memberId = Number(req.body?.member)
      const target = Number.isInteger(memberId) ? await database('members').where('id', memberId).first('id') : null
      if (!target) return res.status(400).json({ error: 'member not found' })

      const email = (inv.recipient_email || '').trim().toLowerCase()
      const wantEmail = req.body?.scope !== 'invoice' && !!email
      const reason = (req.body?.reason || '').toString().trim() || null

      let affected
      if (wantEmail) {
        await database('finance_invoice_member_overrides').whereRaw('lower(match_email) = ?', [email]).del()
        await database('finance_invoice_member_overrides').insert({
          match_email: email, member: memberId, reason,
          created_by_name: mem?.name || null, created_by_email: mem?.email || null,
        })
        affected = await database('finance_invoices').where('source', 'clubdesk').whereRaw('lower(recipient_email) = ?', [email]).update({ member: memberId, date_updated: new Date() })
      } else {
        await database('finance_invoice_member_overrides').where('match_clubdesk_id', inv.clubdesk_id).del()
        await database('finance_invoice_member_overrides').insert({
          match_clubdesk_id: inv.clubdesk_id, member: memberId, reason,
          created_by_name: mem?.name || null, created_by_email: mem?.email || null,
        })
        affected = await database('finance_invoices').where('clubdesk_id', inv.clubdesk_id).update({ member: memberId, date_updated: new Date() })
      }
      await writeUserLog(database, log, { accountability: req.accountability, action: 'update', collection: 'finance_invoices', recordId: id, data: { kind: 'link_member', member: memberId, scope: wantEmail ? 'email' : 'invoice', affected } })
      return res.json({ ok: true, scope: wantEmail ? 'email' : 'invoice', affected })
    } catch (e) { return err(res, req, 'link-member', e) }
  })

  // ── DELETE /finance/invoices/:id/link-member — remove the override ──────
  router.delete('/finance/invoices/:id/link-member', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })
      const id = Number(req.params.id)
      const inv = await database('finance_invoices').where('id', id).andWhere('source', 'clubdesk').first()
      if (!inv) return res.status(404).json({ error: 'Not found' })
      const email = (inv.recipient_email || '').trim().toLowerCase()
      let removed = 0
      if (email) removed += await database('finance_invoice_member_overrides').whereRaw('lower(match_email) = ?', [email]).del()
      if (inv.clubdesk_id) removed += await database('finance_invoice_member_overrides').where('match_clubdesk_id', inv.clubdesk_id).del()
      // Also drop a contact-level pin (migration 288) — otherwise the next sync
      // re-applies it and the invoice silently re-links after an unlink.
      if (inv.cd_contact_id) removed += await database('finance_invoice_member_overrides').where('match_cd_contact_id', inv.cd_contact_id).del()
      // Clear the member link the override had pinned so the next sync leaves it orphaned.
      let cleared = 0
      if (email) cleared += await database('finance_invoices').where('source', 'clubdesk').whereRaw('lower(recipient_email) = ?', [email]).update({ member: null, date_updated: new Date() })
      else if (inv.clubdesk_id) cleared += await database('finance_invoices').where('clubdesk_id', inv.clubdesk_id).update({ member: null, date_updated: new Date() })
      await writeUserLog(database, log, { accountability: req.accountability, action: 'update', collection: 'finance_invoices', recordId: id, data: { kind: 'unlink_member', removed, cleared } })
      return res.json({ ok: true, removed, cleared })
    } catch (e) { return err(res, req, 'unlink-member', e) }
  })

  // ── Dues runs — recurring / batch membership-dues billing (migration 138) ─
  // Mints ordinary native invoices for a cohort from a per-category rate
  // schedule. Preview is a pure dry-run; issue is idempotent (skips members who
  // already hold a non-cancelled dues invoice this fiscal year).

  /** Resolve the cohort + per-member billing decision. Shared by preview + issue. */
  async function resolveDuesCohort(body) {
    const fiscalYear = Number(body.fiscal_year)
    const fy = Number.isInteger(fiscalYear)
      ? await database('finance_fiscal_years').where('id', fiscalYear).first('id', 'label') : null
    if (!fy) return { error: 'fiscal_year not found' }
    const categories = Array.isArray(body.categories) ? body.categories.map((c) => String(c)).filter(Boolean) : []
    if (!categories.length) return { error: 'categories[] required' }
    const sektion = (body.sektion || '').toString().trim() || null
    const onlyActive = body.only_active !== false // default true
    // Optional narrowing to named members. The cohort is otherwise category-wide,
    // which leaves no way to bill ONE person as a trial — and the first native
    // run in the club's history should not be 570 real invoices at once. Also
    // covers re-billing a member the treasurer had to fix up after a run.
    const memberIds = Array.isArray(body.member_ids)
      ? [...new Set(body.member_ids.map(Number).filter(Number.isInteger))] : []
    // Per-member discount, { "<memberId>": chf }. The club's existing practice is
    // to bill full and write the difference off afterwards — 47 invoices and
    // CHF 7'026 last season, most of them the CHF 100 no-Schreiberlizenz
    // surcharge being waived. A write-off is invisible to the member (their
    // invoice still says 540) and, on accrual, needs a bad-debt account the
    // chart does not have. Granting it up front puts it on the bill as a line.
    const discounts = new Map()
    if (body.discounts && typeof body.discounts === 'object') {
      for (const [k, v] of Object.entries(body.discounts)) {
        const id = Number(k), chf = round2(v)
        if (Number.isInteger(id) && Number.isFinite(chf) && chf > 0) discounts.set(id, chf)
      }
    }
    const discountReason = (body.discount_reason || '').toString().trim().slice(0, 120) || 'Rabatt'

    // `licence_chf` (migration 323) is the federation licence portion INSIDE
    // amount_chf. It splits the invoice's first position in two and changes no
    // total — omit it from this SELECT and the split silently disappears from
    // the document while every amount stays correct, which is the failure mode
    // that is hardest to notice.
    const rates = await database('finance_dues_rates').where('fiscal_year', fy.id)
      .select('id', 'category', 'sektion', 'amount_chf', 'licence_chf', 'subject_template', 'active')

    let mq = database('members').whereIn('beitragskategorie', categories)
      .select('id', 'first_name', 'last_name', 'email', 'beitragskategorie', 'sektion',
        // The inputs feeBreakdown needs for the CHF 100 no-Schreiberlizenz
        // surcharge: birthdate gates the youth categories at U16+, the licence
        // flags say whether the duty is already covered. Omit them and every
        // surcharged member is silently under-billed by CHF 100.
        'birthdate', 'scorer_vb', 'otr1_bb', 'otr2_bb', 'otn1_bb', 'otn2_bb',
        // Per-member fee overrides (migration 299). feeBreakdown reads them off
        // the row, so omitting them bills the derived amount to a member the
        // treasurer had explicitly re-priced — silently, and in a batch.
        ...FEE_OVERRIDE_FIELDS,
        // Copied onto the invoice at issue time so the document has an addressee
        // and the QR bill can pre-fill "Zahlbar durch" (migration 293).
        'adresse', 'plz', 'ort')
    if (onlyActive) mq = mq.where('kscw_membership_active', true)
    if (sektion) mq = mq.where('sektion', sektion)
    if (memberIds.length) mq = mq.whereIn('id', memberIds)
    const members = await mq.orderBy(['last_name', 'first_name'])

    // Pure guests (guest on a team, core on none) pay CHF 110 less. The season
    // key equals the fiscal-year label ('2026/27') — member_teams.season uses
    // the same spelling, so a run for a past year resolves that year's guests.
    const guests = await guestMemberIdSet(database, members.map((m) => m.id), fy.label)

    // Who owes nothing by RULE (Ehrenmitglied / Vorstand / coach) rather than by
    // category. They are NOT dropped from the run: the club wants a CHF 0
    // invoice on file for every one of them (user 2026-08-13, accounting/audit),
    // showing the rate they would have paid and the waiver that cancels it.
    // Same helper the Data Health fee check reports on — one rule, two readers.
    const waivers = await resolveFeeWaivers(database, members.map((m) => m.id))

    // Members already holding a non-cancelled dues invoice this fiscal year.
    // Not just dues-RUN invoices: a late joiner billed by hand through
    // InvoiceManager carries dues_run NULL, so a later top-up run would issue a
    // second membership invoice with its own SCOR reference and both would dun
    // independently. An ad-hoc invoice counts when it looks like membership dues
    // (same test as the ClubDesk guard below) — a fine or a camp fee must not
    // suppress the member's actual dues bill.
    const billed = new Set((await database('finance_invoices')
      .where('fiscal_year', fy.id).whereNotNull('member')
      .whereNot('status', 'cancelled')
      .where((qb) => qb.whereNotNull('dues_run').orWhere((q) => q
        .where('source', 'native').whereRaw(DUES_SUBJECT_SQL)))
      .pluck('member')).map(Number))

    // Members ClubDesk already billed this fiscal year. Mirror rows carry
    // dues_run NULL (migration 138), so the native guard above is blind to
    // them — without this a native run double-bills a cohort ClubDesk has
    // already invoiced (surfaced 2026-07-07 when the ClubDesk down-sync began
    // creating passive members, whose dues live in ClubDesk).
    //
    // ⚠ The test is the SUBJECT, not fee_category. The mirror stamps the
    // contact's category onto EVERY invoice they receive, so a camp fee carries
    // 'BB Minis Turnier' just like a membership bill does. On prod that is 216
    // invoices across 81 members — camp fees, training weekends, sponsoring,
    // Freibrief costs — and in FY 2026/27 it would have skipped Fonzini (CHF 210)
    // and Huwiler (CHF 310) from their membership bill because each holds a
    // CHF 160 'Kosten Trainingscamp BB' invoice. All 2365 genuine dues invoices
    // say 'Mitgliederbeitrag'; nothing else does.
    //
    // Mirror statuses are ClubDesk's German vocabulary — only 'Storniert'
    // (cancelled) unblocks; 'Entwurf' (draft, about to be sent) and
    // 'Abgeschrieben' (written off — the member WAS billed) still count as
    // ClubDesk-handled.
    const clubdeskBilled = new Set((await database('finance_invoices')
      .where('fiscal_year', fy.id).where('source', 'clubdesk').whereNotNull('member')
      .whereRaw(DUES_SUBJECT_SQL)
      .whereNot('status', 'Storniert').pluck('member')).map(Number))

    const rows = members.map((m) => {
      const rate = pickRate(rates, m.beitragskategorie, m.sektion)
      // A 'Gratis' member owes nothing by CATEGORY. They are invoiced anyway, at
      // 0, and since 2026-08-15 the document shows what the membership would have
      // cost plus the exemption that cancels it — see finance-dues-reference.js.
      // ⚠ A per-member `fee_base_override` above 0 outranks the category: the
      // treasurer pinned that number (usually the register's own, migration 308),
      // so those members keep being billed it instead of being handed a free
      // membership nobody granted them. On prod that is 2 of the 94 (CHF 40 each).
      // A pin of exactly 0 says the same thing the category does — free — so it
      // keeps the exemption line rather than falling back to a bare 0.00 that
      // reads as a mistake. (`numeric` arrives as a STRING through pg; NULL, ''
      // and a non-numeric all coerce to "not pinned", which is the safe side.)
      const pinnedBase = Number(m.fee_base_override) > 0
      const exempt = !!rate && isExemptCategory(m.beitragskategorie) && !pinnedBase
      const ref = exempt ? referenceBase(rates, m) : null
      const reference = exempt ? round2(ref.base) : 0
      const isGuest = guests.has(Number(m.id))
      // The schedule supplies the season's BASE; the surcharge/guest rules are
      // per-member and cannot live in a (category, sektion) rate row.
      const fee = !rate ? null
        // NOT feeBreakdown for an exempt member: the engine's answer for them is
        // 0 and stays 0. The reference is a figure for the DOCUMENT, so it must
        // not travel through the surcharge / guest / discount rules that price a
        // real bill — a 'Gratis' member is not surcharged and owes no guest
        // reduction, and either line on a CHF 0 invoice is noise.
        : exempt
        ? { category: m.beitragskategorie, base: reference, surcharge: 0, guest_discount: 0, discount: 0, amount: reference }
        : feeBreakdown(m.beitragskategorie, m, {
            baseOverride: rate.amount_chf,
            isGuest,
            // Capping lives in the fee model, where it is unit-tested.
            discount: discounts.get(Number(m.id)) || 0,
          })
      // The federation's cut, carved OUT of the base and never added to it
      // (migration 323) — the club's rates have always been licence-inclusive.
      // Zero in two cases: a per-member `fee_base_override`, because that number
      // is a person-specific amount whose composition nobody recorded; and a
      // pure guest, who holds no licence at all — the CHF 110 guest reduction IS
      // the licence coming off, and printing both would show it twice.
      const licence = !fee ? 0
        : exempt ? round2(Math.min(ref.licence, fee.base))
        : pinnedBase || isGuest ? 0
        : round2(Math.min(Number(rate.licence_chf) || 0, fee.base))
      return {
        member: m.id,
        name: [m.first_name, m.last_name].filter(Boolean).join(' ').trim() || null,
        email: m.email || null,
        category: m.beitragskategorie || null,
        sektion: m.sektion || null,
        adresse: m.adresse || null,
        plz: m.plz != null ? String(m.plz) : null,
        ort: m.ort || null,
        base_amount: fee ? round2(fee.base) : null,
        /** Federation licence contained IN base_amount — a split, not an addition. */
        licence,
        surcharge: fee ? round2(fee.surcharge) : 0,
        guest_discount: fee ? round2(fee.guest_discount) : 0,
        discount: fee ? round2(fee.discount) : 0,
        // Whose discount is this? A per-run one carries the run's wording; the
        // member's standing one (migration 299) carries their own reason, which
        // is the whole point of storing it next to the amount.
        discount_reason: !fee || fee.discount <= 0 ? null
          : discounts.has(Number(m.id)) ? discountReason
          : (m.fee_discount_reason || discountReason),
        // The waiver is the LAST adjustment: it cancels whatever is still owed
        // after base ± surcharge ± guest ± discount, so the invoice reads
        // "440.00 / Erlass -440.00 / 0.00" instead of hiding the entitlement.
        // Two ways to get one — a rule (Ehrenmitglied / Vorstand / Trainer*in)
        // or the 'Gratis' category itself — and the RULE names the line when
        // both apply: "Erlass — Trainer*in" says more than "Gratismitgliedschaft"
        // about why this membership is free.
        waiver: fee && (exempt || waivers.has(Number(m.id))) ? round2(Math.max(0, fee.amount)) : 0,
        waiver_reason: waivers.get(Number(m.id)) || (exempt ? 'gratis' : null),
        amount: fee ? round2(exempt || waivers.has(Number(m.id)) ? 0 : fee.amount) : null,
        // Print the exemption line even at 0.00 (no comparable rate for their
        // sektion): naming it IS the point — a bare 0.00 reads as a mistake.
        exempt,
        subject_template: rate?.subject_template || null,
        already_billed: billed.has(Number(m.id)),
        clubdesk_billed: clubdeskBilled.has(Number(m.id)),
        missing_rate: !fee,
        missing_email: !m.email,
      }
    })
    // Coverage: who is active but CANNOT be reached by this run. `rows` only
    // describes the categories that were selected, so without this the preview
    // is silent about the 10 active members with no fee category at all — 8 of
    // whom hold past Mitgliederbeitrag invoices, so they demonstrably owe. A
    // billing run that omits people must say so on the page.
    let uncovered = { no_category: 0, category_not_selected: 0, members: [] }
    if (!memberIds.length) {
      let uq = database('members').where('kscw_membership_active', true)
        .select('id', 'first_name', 'last_name', 'sektion', 'beitragskategorie')
      if (sektion) uq = uq.where('sektion', sektion)
      const all = await uq
      const selected = new Set(categories.map((c) => c.toLowerCase()))
      const missing = all.filter((m) => !selected.has(String(m.beitragskategorie ?? '').trim().toLowerCase()))
      uncovered = {
        no_category: missing.filter((m) => !String(m.beitragskategorie ?? '').trim()).length,
        category_not_selected: missing.filter((m) => String(m.beitragskategorie ?? '').trim()).length,
        // Named, not just counted — a count tells the treasurer a problem exists
        // but not who to fix. Capped so a mis-selected run cannot return the club.
        members: missing.slice(0, 50).map((m) => ({
          member: m.id,
          name: [m.first_name, m.last_name].filter(Boolean).join(' ').trim() || null,
          sektion: m.sektion || null,
          category: String(m.beitragskategorie ?? '').trim() || null,
        })),
      }
    }
    return { fy, sektion, onlyActive, categories, memberIds, discountReason, rows, uncovered }
  }

  const duesTotals = (rows) => {
    // Two different questions, and conflating them is what made the preview
    // promise ~90 more invoices than the run created (before 2026-08-13, when a
    // 0 CHF row was counted as billable but skipped at issue):
    //   billable — carries money. Drives every CHF figure below.
    //   issuable — gets a DOCUMENT. Since 2026-08-13 that includes the 0 CHF
    //              rows: a free member (rule waiver, or a 'Gratis'/'Kein
    //              Beitrag' category) is invoiced at 0 so accounting has a
    //              record for every member, not only the paying ones. Since
    //              2026-08-15 a 'Gratis' one carries the entitlement it was
    //              granted out of, so the document explains itself.
    // MUST match the issue endpoint's filter.
    const eligible = (x) => !x.missing_rate && !x.already_billed && !x.clubdesk_billed
    const billable = rows.filter((x) => eligible(x) && round2(x.amount) > 0)
    const issuable = rows.filter((x) => eligible(x) && round2(x.amount) >= 0)
    return {
      members: rows.length,
      billable: billable.length,
      issuable: issuable.length,
      billable_amount: round2(billable.reduce((s, x) => s + (x.amount || 0), 0)),
      // Broken out so the treasurer can reconcile the total against the plain
      // rate schedule — the difference is exactly these two adjustments.
      base_amount: round2(billable.reduce((s, x) => s + (x.base_amount || 0), 0)),
      // Of that base, what the club forwards to the federations. Carved out of
      // base_amount, so it must never be added to billable_amount — it is
      // already inside it. Lets the treasurer see the club's own income.
      licence_amount: round2(billable.reduce((s, x) => s + (x.licence || 0), 0)),
      licensed: billable.filter((x) => (x.licence || 0) > 0).length,
      surcharge_amount: round2(billable.reduce((s, x) => s + (x.surcharge || 0), 0)),
      surcharged: billable.filter((x) => (x.surcharge || 0) > 0).length,
      guest_discount_amount: round2(billable.reduce((s, x) => s + (x.guest_discount || 0), 0)),
      guests: billable.filter((x) => (x.guest_discount || 0) > 0).length,
      discount_amount: round2(rows.reduce((s, x) => s + (x.discount || 0), 0)),
      discounted: rows.filter((x) => (x.discount || 0) > 0).length,
      already_billed: rows.filter((x) => x.already_billed).length,
      clubdesk_billed: rows.filter((x) => !x.already_billed && x.clubdesk_billed).length,
      missing_rate: rows.filter((x) => x.missing_rate).length,
      zero_rate: rows.filter((x) => eligible(x) && round2(x.amount) <= 0).length,
      // What the waiver cancelled, so the treasurer can see the club's cost of
      // its own free memberships rather than only their count. Since 2026-08-15
      // that includes the 'Gratis' cohort's reference figures — notional money
      // (they were never going to pay), which is exactly what "cost of free
      // memberships" means.
      waived: rows.filter((x) => eligible(x) && (x.waiver || 0) > 0).length,
      waived_amount: round2(rows.filter((x) => eligible(x)).reduce((sm, x) => sm + (x.waiver || 0), 0)),
      // Only paying members are emailed (0 CHF invoices are filed, not sent),
      // so a missing address on a free member is not a problem to report.
      no_email: billable.filter((x) => x.missing_email).length,
    }
  }

  // GET /finance/dues-rates?fiscal_year= — rate schedule + real category/sektion values
  router.get('/finance/dues-rates', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })
      const fyId = Number(req.query.fiscal_year)
      const rates = Number.isInteger(fyId)
        ? await database('finance_dues_rates').where('fiscal_year', fyId).orderBy(['category', 'sektion'])
            .select('id', 'fiscal_year', 'category', 'sektion', 'amount_chf', 'licence_chf', 'subject_template', 'active')
        : []
      // Free-text columns synced from ClubDesk — offer only real live values.
      const categories = await database('members').whereNotNull('beitragskategorie')
        .where('kscw_membership_active', true).distinct('beitragskategorie').orderBy('beitragskategorie').pluck('beitragskategorie')
      const sektionen = await database('members').whereNotNull('sektion')
        .where('kscw_membership_active', true).distinct('sektion').orderBy('sektion').pluck('sektion')
      return res.json({ rates, categories, sektionen })
    } catch (e) { return err(res, req, 'dues-rates', e) }
  })

  // POST /finance/dues-rates — upsert a (fiscal_year, category, sektion) rate
  router.post('/finance/dues-rates', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })
      const b = req.body || {}
      const fiscalYear = Number(b.fiscal_year)
      const category = (b.category || '').toString().trim()
      const sektion = (b.sektion || '').toString().trim() || null
      const amount = round2(b.amount_chf)
      // The federation portion INSIDE the amount (migration 323). Absent means
      // "leave it alone" on an update — a client that predates the split must
      // not silently zero a licence the treasurer set.
      const licenceGiven = b.licence_chf !== undefined && b.licence_chf !== null && b.licence_chf !== ''
      const licence = licenceGiven ? round2(b.licence_chf) : null
      const subjectTemplate = (b.subject_template || '').toString().trim() || null
      const active = b.active !== false
      if (!Number.isInteger(fiscalYear)) return res.status(400).json({ error: 'fiscal_year required' })
      if (!category) return res.status(400).json({ error: 'category required' })
      if (!(amount >= 0)) return res.status(400).json({ error: 'amount_chf must be >= 0' })
      // Mirrors the DB CHECK, so the treasurer gets a sentence instead of a 500.
      if (licenceGiven && !(licence >= 0 && licence <= amount)) {
        return res.status(400).json({ error: 'licence_chf must be between 0 and amount_chf' })
      }

      const existing = await database('finance_dues_rates').where('fiscal_year', fiscalYear)
        .whereRaw('lower(category) = lower(?)', [category])
        .whereRaw("coalesce(sektion, '') = coalesce(?, '')", [sektion])
        .first('id')
      let row
      if (existing) {
        const upd = await database('finance_dues_rates').where('id', existing.id)
          .update({ category, sektion, amount_chf: amount, ...(licenceGiven ? { licence_chf: licence } : {}), subject_template: subjectTemplate, active, date_updated: new Date() }).returning('*')
        row = upd[0]
      } else {
        const ins = await database('finance_dues_rates').insert({
          fiscal_year: fiscalYear, category, sektion, amount_chf: amount, licence_chf: licence ?? 0,
          subject_template: subjectTemplate, active,
          created_by_name: mem?.name || null, created_by_email: mem?.email || null,
        }).returning('*')
        row = ins[0]
      }
      await writeUserLog(database, log, { accountability: req.accountability, action: existing ? 'update' : 'create', collection: 'finance_dues_rates', recordId: row.id, data: { fiscal_year: fiscalYear, category, sektion, amount, ...(licenceGiven ? { licence_chf: licence } : {}) } })
      return res.json({ rate: row })
    } catch (e) { return err(res, req, 'dues-rate-save', e) }
  })

  // DELETE /finance/dues-rates/:id
  router.delete('/finance/dues-rates/:id', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })
      const id = Number(req.params.id)
      const removed = await database('finance_dues_rates').where('id', id).del()
      await writeUserLog(database, log, { accountability: req.accountability, action: 'delete', collection: 'finance_dues_rates', recordId: id, data: { removed } })
      return res.json({ ok: true, removed })
    } catch (e) { return err(res, req, 'dues-rate-delete', e) }
  })

  // GET /finance/members/:id/fee — itemised Beitrag for ONE member
  //
  // The Data Explorer's "Beitrag amount" card. It exists so the fee model has
  // exactly ONE implementation: the card could add up base + surcharge −
  // discount client-side, but deciding WHICH base applies (this season's rate
  // row, or the codified category map), whether the member owes the CHF 100
  // no-Schreiberlizenz surcharge (adult category, or youth AND U16+, and no
  // licence), and whether they are a pure guest this season are rules — and a
  // second copy of them in TypeScript would drift from the one that bills.
  //
  // Returns BOTH sides: `derived` is what the rules alone produce (the
  // placeholder the override fields show), `effective` is what the member is
  // actually billed once their overrides apply.
  router.get('/finance/members/:id/fee', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })
      const id = Number(req.params.id)
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'id required' })

      const m = await database('members').where('id', id).first(
        'id', 'beitragskategorie', 'sektion', 'birthdate',
        'scorer_vb', 'otr1_bb', 'otr2_bb', 'otn1_bb', 'otn2_bb',
        ...FEE_OVERRIDE_FIELDS)
      if (!m) return res.status(404).json({ error: 'not found' })

      // This season's rate schedule, when the treasurer has entered one for the
      // current fiscal year. Without it the card falls back to the codified
      // category map — the same base the ClubDesk push bills from.
      const fyId = await fiscalYearIdForDate(todayISO())
      const fy = fyId ? await database('finance_fiscal_years').where('id', fyId).first('id', 'label') : null
      const rates = fy
        ? await database('finance_dues_rates').where('fiscal_year', fy.id)
            .select('id', 'category', 'sektion', 'amount_chf', 'licence_chf', 'active')
        : []
      const rate = pickRate(rates, m.beitragskategorie, m.sektion)

      // member_teams.season uses the fiscal-year label spelling ('2026/27').
      const isGuest = fy
        ? (await guestMemberIdSet(database, [id], fy.label)).has(Number(id))
        : false

      const opts = { baseOverride: rate?.amount_chf, isGuest }
      // Same engine, twice: once with the member's overrides stripped so the UI
      // can show what the rules WOULD say, once as it actually bills.
      const bare = { ...m }
      for (const f of FEE_OVERRIDE_FIELDS) bare[f] = null
      const derived = feeBreakdown(m.beitragskategorie, bare, opts)
      const effective = feeBreakdown(m.beitragskategorie, m, opts)

      return res.json({
        member: id,
        category: m.beitragskategorie || null,
        sektion: m.sektion || null,
        fiscal_year: fy ? { id: fy.id, label: fy.label } : null,
        is_guest: isGuest,
        // Where the base comes from when no per-member override is set — the
        // difference between "the treasurer set this season's rate" and "we are
        // falling back to the hardcoded map" is worth showing.
        base_source: rate ? 'schedule' : derived ? 'category_map' : null,
        // The CHF the surcharge boolean is worth. Served rather than hardcoded
        // client-side so the amount stays a server rule — the UI only ever
        // shows "on/off", never decides what "on" costs.
        surcharge_amount: NO_LICENCE_SURCHARGE,
        // The federation licence contained IN the base (migration 323), i.e. how
        // the invoice will itemise it. ⚠ Inside the base, never on top — adding
        // it to `amount` double-counts. Zero for a guest (no licence) and for a
        // per-member base override (composition unrecorded), exactly as the run.
        licence: effective && !isGuest && !(Number(m.fee_base_override) > 0)
          ? round2(Math.min(Number(rate?.licence_chf) || 0, effective.base)) : 0,
        derived: derived && {
          base: round2(derived.base),
          surcharge: round2(derived.surcharge),
          guest_discount: round2(derived.guest_discount),
          amount: round2(derived.amount),
        },
        effective: effective && {
          base: round2(effective.base),
          surcharge: round2(effective.surcharge),
          guest_discount: round2(effective.guest_discount),
          discount: round2(effective.discount),
          amount: round2(effective.amount),
        },
      })
    } catch (e) { return err(res, req, 'member-fee', e) }
  })

  // POST /finance/dues-runs/preview — dry-run, no writes
  router.post('/finance/dues-runs/preview', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })
      const r = await resolveDuesCohort(req.body || {})
      if (r.error) return res.status(400).json({ error: r.error })
      return res.json({ fiscal_year: r.fy, rows: r.rows, totals: duesTotals(r.rows), uncovered: r.uncovered })
    } catch (e) { return err(res, req, 'dues-preview', e) }
  })

  // POST /finance/dues-runs/issue — mint native invoices for the billable cohort
  router.post('/finance/dues-runs/issue', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })
      const body = req.body || {}
      const r = await resolveDuesCohort(body)
      if (r.error) return res.status(400).json({ error: r.error })
      // #21: never mint a 0-CHF invoice — a rate of 0 would create an "open"
      // invoice with open_amount 0 for the whole cohort. Skip amount ≤ 0.
      // `>= 0`, not `> 0`: a free member gets a CHF 0 invoice too (user
      // 2026-08-13). `missing_rate` still excludes anyone the schedule cannot
      // price — an unknown category is NOT the same as a known zero.
      const billable = r.rows.filter((x) => !x.missing_rate && !x.already_billed && !x.clubdesk_billed && round2(x.amount) >= 0)
      if (!billable.length) return res.status(409).json({ error: 'Nothing to bill (no members with a positive rate that are not already billed natively or via ClubDesk)' })

      const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(body.due_date || '') ? body.due_date : null
      const invoiceDate = todayISO()
      const fyLabel = r.fy.label
      const label = (body.label || '').toString().trim() || `Dues ${fyLabel}`
      // #7: advisory-lock namespace so concurrent dues issues serialize per FY.
      const DUES_ISSUE_LOCK_NS = 19283

      const result = await database.transaction(async (trx) => {
        // #7: serialize issuance per fiscal year — the UNIQUE(dues_run, member)
        // index is per-run and does NOT span runs, so two overlapping issue calls
        // would each mint a full cohort into distinct runs (double-billing). Take
        // a transaction advisory lock, then RE-CHECK who is already billed inside
        // the lock (the cohort's `already_billed` was computed before the txn).
        await trx.raw('SELECT pg_advisory_xact_lock(?, ?)', [DUES_ISSUE_LOCK_NS, r.fy.id])
        // Both guards must use the SAME predicates as resolveDuesCohort, or the
        // preview and the run disagree about who gets billed.
        const billedNow = new Set((await trx('finance_invoices')
          .where('fiscal_year', r.fy.id).whereNotNull('member')
          .whereNot('status', 'cancelled')
          .where((qb) => qb.whereNotNull('dues_run').orWhere((q) => q
            .where('source', 'native').whereRaw(DUES_SUBJECT_SQL)))
          .pluck('member')).map(Number))
        // Re-check the ClubDesk-mirror guard too: the nightly finance sync (or a
        // manual import) may have landed mirror invoices since the preview.
        const clubdeskNow = new Set((await trx('finance_invoices')
          .where('fiscal_year', r.fy.id).where('source', 'clubdesk').whereNotNull('member')
          .whereRaw(DUES_SUBJECT_SQL)
          .whereNot('status', 'Storniert').pluck('member')).map(Number))
        const toBill = billable.filter((x) => !billedNow.has(Number(x.member)) && !clubdeskNow.has(Number(x.member)))
        if (!toBill.length) return { runId: null, created: [], total: 0 }

        const runIns = await trx('finance_dues_runs').insert({
          fiscal_year: r.fy.id, label,
          filter_json: JSON.stringify({ categories: r.categories, sektion: r.sektion, only_active: r.onlyActive, due_date: dueDate, member_ids: r.memberIds.length ? r.memberIds : null,
            discounts: Object.fromEntries(r.rows.filter((x) => x.discount > 0).map((x) => [x.member, x.discount])),
            discount_reason: r.discountReason }),
          status: 'issued', created_by_name: mem?.name || null, created_by_email: mem?.email || null,
        }).returning('id')
        const runId = runIns[0]?.id ?? runIns[0]

        const created = []
        let total = 0
        for (const x of toBill) {
          const seqRow = await trx.raw("SELECT nextval('finance_native_invoice_seq')::int AS n")
          const seq = (seqRow.rows ? seqRow.rows[0] : seqRow[0]).n
          const number = `N-${invoiceDate.slice(0, 4)}-${String(seq).padStart(4, '0')}`
          const subject = (x.subject_template || `Mitgliederbeitrag ${fyLabel}`)
            .replace(/\{fy\}/g, fyLabel).replace(/\{category\}/g, x.category || '')
          const ins = await trx('finance_invoices').insert({
            clubdesk_id: null, number, invoice_date: invoiceDate, subject,
            amount: x.amount,
            // A CHF 0 invoice has nothing outstanding, so it must not sit in the
            // open ledger waiting for a payment that will never come (and must
            // not be dunned). 'paid' is this vocabulary's "nothing due" bucket;
            // the waiver line below is what records that no money was expected.
            // Nothing reaches the GL either — postAutoEntry skips zero amounts.
            status: round2(x.amount) > 0 ? 'open' : 'paid',
            due_date: dueDate,
            amount_paid: 0, open_amount: x.amount, fee_category: x.category,
            recipient_name: x.name, recipient_email: x.email,
            recipient_address: x.adresse, recipient_zip: x.plz, recipient_city: x.ort,
            // Positions, so the invoice answers "why 540 and not 440?" on the page
            // instead of in a mail to the treasurer. Stored, not recomputed at
            // render time: a licence granted in March must not silently restate
            // what January's invoice charged.
            lines: JSON.stringify([
              // ⚠ No "· Gratis" suffix on an exempt member's line: the base there
              // is what the membership WOULD have cost, and "Gratis  440.00"
              // contradicts itself on the page. The Erlass line below names it.
              //
              // The club's rate is licence-INCLUSIVE (migration 323), so the
              // first position is the club's own fee and the federation licence
              // stands beside it. The two always sum back to base_amount — this
              // is an itemisation, never a surcharge.
              { label: `${subject}${x.category && !x.exempt ? ` · ${x.category}` : ''}`, amount: round2(x.base_amount - (x.licence || 0)) },
              ...(x.licence > 0 ? [{ label: licenceLabel(x.sektion), amount: round2(x.licence) }] : []),
              ...(x.surcharge > 0 ? [{ label: 'Zuschlag ohne Schreiberlizenz', amount: round2(x.surcharge) }] : []),
              ...(x.guest_discount > 0 ? [{ label: 'Abzug Gastspieler*in', amount: round2(-x.guest_discount) }] : []),
              ...(x.discount > 0 ? [{ label: x.discount_reason || 'Rabatt', amount: round2(-x.discount) }] : []),
              // The waiver, last and named: an auditor reading this row sees the
              // full entitlement AND why it came to nothing. Without the label a
              // 0 CHF invoice is indistinguishable from a mistake — which is why
              // an exempt member gets the line even when the amount is 0.00.
              ...(x.waiver > 0 || x.exempt ? [{ label: WAIVER_LABELS[x.waiver_reason] || WAIVER_LABELS.default, amount: round2(-x.waiver) || 0 }] : []),
            ]),
            member: x.member, team: null, dues_run: runId, fiscal_year: r.fy.id,
            source: 'native', created_by_name: mem?.name || null, created_by_email: mem?.email || null,
          }).returning('id')
          const invId = ins[0]?.id ?? ins[0]
          try {
            await trx('finance_invoices').where('id', invId)
              .update({ reference: scorReference(invId), reference_type: 'SCOR', date_updated: new Date() })
          } catch (e) { log.warn?.({ msg: `dues scor gen failed: ${e.message}`, id: invId }) }
          created.push({ member: x.member, invoice: number, amount: x.amount })
          total = round2(total + x.amount)
        }
        await trx('finance_dues_runs').where('id', runId).update({ total_count: created.length, total_amount: total })
        return { runId, created, total }
      })

      // A concurrent run beat us to the whole cohort (advisory-lock re-check).
      if (!result.runId) return res.status(409).json({ error: 'Nothing to bill — the cohort was already billed by a concurrent run' })
      await writeUserLog(database, log, { accountability: req.accountability, action: 'create', collection: 'finance_dues_runs', recordId: result.runId, data: { kind: 'dues_run_issue', fiscal_year: r.fy.id, count: result.created.length, total: result.total } })
      await autopostDuesRunSafe(database, log, result.runId)
      return res.json({
        run: { id: result.runId, label, fiscal_year: r.fy.id, total_count: result.created.length, total_amount: result.total },
        summary: {
          created: result.created.length,
          skipped_already_billed: r.rows.filter((x) => x.already_billed).length,
          skipped_clubdesk_billed: r.rows.filter((x) => !x.already_billed && x.clubdesk_billed).length,
          skipped_no_rate: r.rows.filter((x) => x.missing_rate).length,
          skipped_zero_rate: r.rows.filter((x) => !x.missing_rate && round2(x.amount) <= 0).length,
        },
        details: result.created,
      })
    } catch (e) { return err(res, req, 'dues-issue', e) }
  })

  // POST /finance/dues-runs/:id/cancel — bulk-void a run's still-open invoices
  router.post('/finance/dues-runs/:id/cancel', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })
      const id = Number(req.params.id)
      const run = await database('finance_dues_runs').where('id', id).first()
      if (!run) return res.status(404).json({ error: 'Not found' })
      // #10 (2026-07-03 audit): a run's invoices all sit in its fiscal year — if that's
      // closed the sub-ledger is immutable; post a correction in an open year instead.
      if (await fiscalYearClosed(database, run.fiscal_year)) return res.status(409).json({ error: FY_CLOSED_MSG })
      // #6 (2026-07-03 audit): the single-invoice cancel guards received cash, but this bulk
      // path didn't — cancelling an invoice with real money recorded zeroes open_amount and
      // (with autopost) drops its settle legs, stranding that cash in the GL. Only cancel
      // invoices with net received cash (payments − refunds) ≤ 0; skip the rest and report.
      const candidates = await database('finance_invoices')
        .where('dues_run', id).whereNotIn('status', ['paid', 'cancelled']).pluck('id')
      const toCancel = []
      let skipped = 0
      if (candidates.length) {
        const cashRows = await database('finance_payments')
          .whereIn('invoice', candidates).groupBy('invoice').select('invoice')
          .select(database.raw("COALESCE(SUM(CASE WHEN COALESCE(entry_type,'payment')='payment' THEN amount WHEN entry_type='refund' THEN -amount ELSE 0 END),0) AS net_cash"))
        const netById = new Map(cashRows.map((r) => [Number(r.invoice), round2(Number(r.net_cash) || 0)]))
        for (const invId of candidates) {
          if ((netById.get(Number(invId)) || 0) > 0.005) skipped++
          else toCancel.push(invId)
        }
      }
      let cancelled = 0
      if (toCancel.length) {
        cancelled = await database('finance_invoices').whereIn('id', toCancel)
          .update({ status: 'cancelled', open_amount: 0, cancelled_at: new Date(), date_updated: new Date() })
      }
      // Only mark the whole run cancelled when nothing was left behind; otherwise it still
      // has live invoices with received cash the treasurer must refund/write off first.
      if (skipped === 0) await database('finance_dues_runs').where('id', id).update({ status: 'cancelled' })
      await writeUserLog(database, log, { accountability: req.accountability, action: 'update', collection: 'finance_dues_runs', recordId: id, data: { kind: 'dues_run_cancel', cancelled, skipped } })
      // Reconcile the run: cancelled invoices get their ledger postings removed; the skipped
      // (still-live) ones keep their correct legs. autopostDuesRunSafe is idempotent.
      await autopostDuesRunSafe(database, log, id)
      return res.json({ ok: true, cancelled, skipped })
    } catch (e) { return err(res, req, 'dues-cancel', e) }
  })

  // GET /finance/dues-runs?fiscal_year= — past runs for the console
  router.get('/finance/dues-runs', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })
      const fyId = Number(req.query.fiscal_year)
      let q = database('finance_dues_runs as r')
        .leftJoin('finance_fiscal_years as fy', 'fy.id', 'r.fiscal_year')
        .select('r.id', 'r.fiscal_year', 'fy.label as fiscal_year_label', 'r.label', 'r.status',
          'r.total_count', 'r.total_amount', 'r.created_by_name', 'r.date_created')
        .orderBy([{ column: 'r.date_created', order: 'desc' }, { column: 'r.id', order: 'desc' }])
      if (Number.isInteger(fyId)) q = q.where('r.fiscal_year', fyId)
      const runs = await q.limit(200)
      return res.json({ runs })
    } catch (e) { return err(res, req, 'dues-runs', e) }
  })

  // GET /finance/dues-runs/:id/invoices — a run's (non-cancelled) invoices, for the
  // bulk QR-bill PDF the treasurer prints/posts. Read-only.
  router.get('/finance/dues-runs/:id/invoices', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })
      const id = Number(req.params.id)
      const run = await database('finance_dues_runs').where('id', id).first('id', 'label')
      if (!run) return res.status(404).json({ error: 'Not found' })
      const invoices = await database('finance_invoices')
        .where('dues_run', id).whereNot('status', 'cancelled').orderBy('id')
        // Same columns as the send loop below, so what the reviewer checks in
        // the dues-run table is what the PDF will actually contain.
        .select('id', 'number', 'recipient_name', 'subject', 'amount', 'open_amount', 'status', 'reference', 'reference_type',
          'invoice_date', 'due_date', 'recipient_address', 'recipient_zip', 'recipient_city')
      return res.json({ run, invoices })
    } catch (e) { return err(res, req, 'dues-run-invoices', e) }
  })

  // ── Dues-run email send + the global TEST MODE switch (migration 140) ────
  // test_mode (default ON) redirects EVERY send to test_recipient, so no member
  // is ever emailed until an admin turns it off. Layered guards: dry_run preview
  // (default) → test-mode redirect → explicit confirm for a live send.

  const emailSettings = async () => {
    const s = await database('finance_email_settings').where('id', 1).first()
    return { test_mode: s ? s.test_mode !== false : true, test_recipient: s?.test_recipient || null }
  }

  // GET /finance/email-settings — current test-mode + recipient
  router.get('/finance/email-settings', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })
      return res.json(await emailSettings())
    } catch (e) { return err(res, req, 'email-settings', e) }
  })

  // PUT /finance/email-settings — flip test mode / set the test recipient (logged)
  router.patch('/finance/email-settings', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })
      const testMode = req.body?.test_mode !== false // default ON; only explicit false disables
      const testRecipient = (req.body?.test_recipient || '').toString().trim() || null
      if (testRecipient && !isEmail(testRecipient)) return res.status(400).json({ error: 'test_recipient must be a valid email address' })
      await database('finance_email_settings')
        .insert({ id: 1, test_mode: testMode, test_recipient: testRecipient, updated_by_name: mem?.name || null, updated_by_email: mem?.email || null, date_updated: new Date() })
        .onConflict('id').merge()
      await writeUserLog(database, log, { accountability: req.accountability, action: 'update', collection: 'finance_email_settings', recordId: 1, data: { kind: 'finance_email_test_mode', test_mode: testMode, test_recipient: testRecipient } })
      return res.json(await emailSettings())
    } catch (e) { return err(res, req, 'email-settings-save', e) }
  })

  // POST /finance/dues-runs/:id/send-emails — preview (default) or send.
  router.post('/finance/dues-runs/:id/send-emails', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })
      const id = Number(req.params.id)
      const run = await database('finance_dues_runs').where('id', id).first('id', 'label')
      if (!run) return res.status(404).json({ error: 'Not found' })
      const dryRun = req.body?.dry_run !== false // default true = preview, no send
      const confirm = req.body?.confirm === true
      const settings = await emailSettings()

      const invoices = await database('finance_invoices')
        .where('dues_run', id).whereNot('status', 'cancelled')
        // ⚠ This row is spread straight into renderInvoicePdf below, so a column
        // missing HERE silently disappears from the PDF the member receives —
        // no error, just a blank. Commit 8c02f4f8 swapped in the richer renderer
        // and left this SELECT at the old one's needs, which cost the first
        // native dues run its `lines` (the PDF collapsed a 440 + 100
        // Schreiberlizenz surcharge into one "— 540.00" line), its Rechnungsdatum
        // and Fällig-am rows (ddmmyyyy(undefined) → '' → both meta rows filtered
        // out, and the terms sentence lost its deadline), and the QR bill's
        // "Zahlbar durch" debtor block (debtorFrom returned null).
        // The data was on the row the whole time — the issue path writes all of
        // it (migration 293). Audit 2026-08-08, finding 17.
        .select(...INVOICE_PDF_COLUMNS, 'recipient_email', 'email_sent_at')
      // 0 CHF invoices are filed for accounting, never emailed (user
      // 2026-08-13) — nobody should receive a bill for nothing. They are still
      // in the run, on the member's finance page and in the ledger export.
      const emailable = invoices.filter((i) => (i.recipient_email || '').trim() && round2(i.amount) > 0)
      const noEmail = invoices.length - emailable.length
      // Live sends skip invoices already emailed (idempotent resume after a crash);
      // test mode re-sends all so it stays repeatable.
      const withEmail = settings.test_mode ? emailable : emailable.filter((i) => !i.email_sent_at)

      if (dryRun) {
        return res.json({
          mode: 'dry_run', test_mode: settings.test_mode, test_recipient: settings.test_recipient,
          would_send: withEmail.length, no_email: noEmail, total: invoices.length,
          recipients: withEmail.slice(0, 300).map((i) => ({ invoice: i.number, name: i.recipient_name, email: i.recipient_email })),
        })
      }
      if (!confirm) return res.status(400).json({ error: 'confirm required for a real send' })
      if (settings.test_mode && !settings.test_recipient) return res.status(400).json({ error: 'Set a test recipient first (test mode is on)' })
      if (!withEmail.length) return res.status(409).json({ error: 'No recipients with an email' })

      // At-most-one running send per run. Reap a stuck 'running' row (crashed
      // worker; its date_updated/created is older than the staleness window) so the
      // partial-unique index can't lock sending forever — then let the DB index
      // enforce atomicity (TOCTOU-proof, unlike a check-then-insert).
      const staleBefore = new Date(Date.now() - 15 * 60 * 1000)
      await database('finance_email_jobs').where('dues_run', id).where('status', 'running')
        .whereRaw('coalesce(date_updated, date_created) < ?', [staleBefore])
        .update({ status: 'failed', error: 'worker_lost', date_updated: new Date() })

      let jobId
      try {
        const jobIns = await database('finance_email_jobs').insert({
          dues_run: id, status: 'running', test_mode: settings.test_mode, total: withEmail.length,
          sent: 0, failed: 0, created_by_name: mem?.name || null, created_by_email: mem?.email || null,
        }).returning('id')
        jobId = jobIns[0]?.id ?? jobIns[0]
      } catch (e) {
        if (e?.code === '23505') return res.status(409).json({ error: 'A send is already running for this run' })
        throw e
      }
      await writeUserLog(database, log, { accountability: req.accountability, action: 'create', collection: 'finance_email_jobs', recordId: jobId, data: { kind: 'dues_email_send', run: id, test_mode: settings.test_mode, total: withEmail.length } })

      // Respond immediately; send in the background, chunked, updating job progress.
      res.status(202).json({ job_id: jobId, total: withEmail.length, test_mode: settings.test_mode, mode: settings.test_mode ? 'test' : 'live' })

      const CHUNK = 20
      void (async () => {
        const schema = await getSchema()
        const { MailService } = services
        const mail = new MailService({ schema, knex: database })
        let sent = 0, failed = 0, lastError = null
        for (let i = 0; i < withEmail.length; i += CHUNK) {
          for (const inv of withEmail.slice(i, i + CHUNK)) {
            const amount = Number(inv.open_amount) > 0 ? Number(inv.open_amount) : Number(inv.amount)
            const to = settings.test_mode ? settings.test_recipient : inv.recipient_email
            try {
              // Render the QR-bill first so the body only promises a PDF when one attaches.
              const attachments = []
              try {
                // The whole invoice, not just the payment part: the member needs a
                // document with a due date and the 440+100 breakdown, and the five
                // members with no email get this same page printed and posted.
                const pdf = await renderInvoicePdf({ ...inv, amount, title: inv.subject || 'Mitgliederbeitrag' })
                attachments.push({ filename: `${inv.number || 'Rechnung'}.pdf`, content: pdf, contentType: 'application/pdf' })
              } catch (pe) { log.warn?.({ msg: `dues qr-bill render failed: ${pe.message}`, invoice: inv.number }) }
              const html = composeDuesEmail(inv, amount, run.label, { testMode: settings.test_mode, realRecipient: inv.recipient_email, hasAttachment: attachments.length > 0 })
              await withTimeout(mail.send({ to, subject: `${settings.test_mode ? '[TEST] ' : ''}Mitgliederbeitrag${run.label ? ` ${run.label}` : ''} — ${inv.number}`, html, ...(attachments.length ? { attachments } : {}) }), 60000, 'mail.send timeout')
              // Mark LIVE sends so a resumed/retried run skips them (no double-email). Test sends don't mark.
              if (!settings.test_mode) { try { await database('finance_invoices').where('id', inv.id).update({ email_sent_at: new Date() }) } catch { /* noop */ } }
              sent++
            } catch (e) { failed++; lastError = e?.message || String(e); log.warn?.({ msg: `dues email failed: ${e?.message}`, invoice: inv.number }) }
          }
          await database('finance_email_jobs').where('id', jobId).update({ sent, failed, date_updated: new Date() })
        }
        // All-failed is a terminal failure the operator must see, not a green 'done'.
        const finalStatus = sent === 0 && failed > 0 ? 'failed' : 'done'
        const finalError = sent === 0 && failed > 0 ? `Alle ${failed} Sendungen fehlgeschlagen${lastError ? `: ${lastError}` : ''}`.slice(0, 500) : null
        await database('finance_email_jobs').where('id', jobId).update({ status: finalStatus, sent, failed, error: finalError, date_updated: new Date() })
      })().catch(async (e) => {
        log.error?.({ msg: `dues email job ${jobId} crashed: ${e.message}`, stack: e.stack })
        try { await database('finance_email_jobs').where('id', jobId).update({ status: 'failed', error: String(e.message || e).slice(0, 500), date_updated: new Date() }) } catch { /* noop */ }
      })
    } catch (e) { return err(res, req, 'dues-send-emails', e) }
  })

  // GET /finance/dues-runs/:id/email-job — latest send job for progress polling
  router.get('/finance/dues-runs/:id/email-job', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })
      const id = Number(req.params.id)
      const job = await database('finance_email_jobs').where('dues_run', id)
        .orderBy('id', 'desc').first('id', 'status', 'test_mode', 'total', 'sent', 'failed', 'error', 'date_created', 'date_updated')
      // A crashed worker can't update its own row; surface a long-idle 'running' job
      // as failed so the UI poller terminates instead of spinning forever.
      if (job && job.status === 'running') {
        const last = job.date_updated || job.date_created
        if (last && Date.now() - new Date(last).getTime() > 15 * 60 * 1000) { job.status = 'failed'; job.error = job.error || 'worker_lost' }
      }
      return res.json({ job: job || null })
    } catch (e) { return err(res, req, 'dues-email-job', e) }
  })

  // ── Per-team finance entries + summary (sponsoring + bills, migration 145) ──
  const TEAM_KINDS = ['sponsoring', 'income', 'expense']

  // GET /finance/team-entries?team=&fiscal_year=
  router.get('/finance/team-entries', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })
      const teamId = Number(req.query.team)
      const fyId = Number(req.query.fiscal_year)
      let q = database('finance_team_entries')
        .orderBy([{ column: 'entry_date', order: 'desc' }, { column: 'id', order: 'desc' }])
        .select('id', 'team', 'fiscal_year', 'kind', 'amount', 'label', 'sponsor', 'entry_date', 'note', 'created_by_name')
      if (Number.isInteger(teamId)) q = q.where('team', teamId)
      if (Number.isInteger(fyId)) q = q.where('fiscal_year', fyId)
      return res.json({ entries: await q.limit(500) })
    } catch (e) { return err(res, req, 'team-entries', e) }
  })

  // POST /finance/team-entries — record a sponsoring/income/expense entry
  router.post('/finance/team-entries', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })
      const b = req.body || {}
      const teamId = Number(b.team)
      const tgt = Number.isInteger(teamId) ? await database('teams').where('id', teamId).first('id') : null
      if (!tgt) return res.status(400).json({ error: 'team not found' })
      const kind = TEAM_KINDS.includes(b.kind) ? b.kind : 'sponsoring'
      const amount = round2(b.amount)
      if (!(amount >= 0)) return res.status(400).json({ error: 'amount must be >= 0' })
      const fyId = Number.isInteger(Number(b.fiscal_year)) ? Number(b.fiscal_year) : await fiscalYearIdForDate(todayISO())
      const entryDate = /^\d{4}-\d{2}-\d{2}$/.test(b.entry_date || '') ? b.entry_date : todayISO()
      // Team entries are sub-ledger too — same closed-year guard as the payment
      // paths, on BOTH the entry's year and the year entry_date lands in
      // (autopost derives the GL year from entry_date; a closed one would make
      // it silently skip and the teams summary diverge from the GL).
      if (await fiscalYearClosed(database, fyId)) return res.status(409).json({ error: FY_CLOSED_MSG })
      const dateFyId = await fiscalYearIdForDate(entryDate)
      if (dateFyId !== fyId && await fiscalYearClosed(database, dateFyId)) return res.status(409).json({ error: FY_CLOSED_MSG })
      // Check-then-insert was racy against a concurrent year-end close (the
      // invoice/payment paths already run inside a trx). Re-check under the
      // shared fiscal-year advisory lock so the close and this insert
      // serialize; the pre-checks above stay as the fast 409 path.
      let entryId
      try {
        entryId = await database.transaction(async (trx) => {
          for (const y of [...new Set([fyId, dateFyId])].sort((a, b) => a - b)) {
            await trx.raw('SELECT pg_advisory_xact_lock(?::int, ?::int)', [FISCAL_YEAR_LOCK_NS, y])
          }
          if (await fiscalYearClosed(trx, fyId)) throw Object.assign(new Error(FY_CLOSED_MSG), { fyClosed: true })
          if (dateFyId !== fyId && await fiscalYearClosed(trx, dateFyId)) throw Object.assign(new Error(FY_CLOSED_MSG), { fyClosed: true })
          const ins = await trx('finance_team_entries').insert({
            team: teamId, fiscal_year: fyId, kind, amount,
            label: (b.label || '').toString().trim().slice(0, 255) || null,
            sponsor: (b.sponsor || '').toString().trim().slice(0, 255) || null,
            entry_date: entryDate, note: (b.note || '').toString().trim().slice(0, 255) || null,
            created_by_name: mem?.name || null, created_by_email: mem?.email || null,
          }).returning('id')
          return ins[0]?.id ?? ins[0]
        })
      } catch (e) {
        if (e?.fyClosed) return res.status(409).json({ error: FY_CLOSED_MSG })
        throw e
      }
      await writeUserLog(database, log, { accountability: req.accountability, action: 'create', collection: 'finance_team_entries', recordId: entryId, data: { kind: 'team_entry', team: teamId, entry_kind: kind, amount } })
      await autopostTeamEntrySafe(database, log, entryId)
      return res.json({ id: entryId })
    } catch (e) { return err(res, req, 'team-entry-save', e) }
  })

  // DELETE /finance/team-entries/:id
  router.delete('/finance/team-entries/:id', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })
      const id = Number(req.params.id)
      const entry = await database('finance_team_entries').where('id', id).first('id', 'fiscal_year')
      if (!entry) return res.json({ ok: true, removed: 0 })
      // Same closed-year guard as the payment-delete path — and also refuse when
      // the entry's auto-posted GL row sits in a closed year (autopost derives
      // its year from entry_date, which can differ from the fiscal_year FK):
      // deleting the entry would strand a locked GL posting with no sub-ledger
      // row behind it (removeAutopostForTeamEntrySafe swallows the trigger's
      // exception, so nothing would surface the orphan).
      if (await fiscalYearClosed(database, entry.fiscal_year)) return res.status(409).json({ error: FY_CLOSED_MSG })
      const glPost = await database('finance_transactions as t')
        .where({ 't.ref_kind': 'team', 't.ref_id': id, 't.auto': true, 't.source': 'native' })
        .first('t.id', 't.fiscal_year')
      // Same close-race fix as the POST: delete under the shared fiscal-year
      // advisory lock (entry year + the GL posting's year, which entry_date
      // can put elsewhere) and re-check both closed-year guards inside.
      let removed
      try {
        removed = await database.transaction(async (trx) => {
          const years = [...new Set([entry.fiscal_year, glPost?.fiscal_year].filter((y) => Number.isInteger(y)))].sort((a, b) => a - b)
          for (const y of years) await trx.raw('SELECT pg_advisory_xact_lock(?::int, ?::int)', [FISCAL_YEAR_LOCK_NS, y])
          if (await fiscalYearClosed(trx, entry.fiscal_year)) throw Object.assign(new Error(FY_CLOSED_MSG), { fyClosed: true })
          const lockedPost = await trx('finance_transactions as t')
            .join('finance_fiscal_years as fy', 'fy.id', 't.fiscal_year')
            .where({ 't.ref_kind': 'team', 't.ref_id': id, 't.auto': true, 't.source': 'native' })
            .andWhere('fy.status', 'closed').first('t.id')
          if (lockedPost) throw Object.assign(new Error(FY_CLOSED_MSG), { fyClosed: true })
          return trx('finance_team_entries').where('id', id).del()
        })
      } catch (e) {
        if (e?.fyClosed) return res.status(409).json({ error: FY_CLOSED_MSG })
        throw e
      }
      // #9: also drop the entry's auto-posted GL journal entry, else it lingers
      // as phantom income/expense (the DELETE mirrors the payment-delete path).
      if (removed) await removeAutopostForTeamEntrySafe(database, log, id)
      await writeUserLog(database, log, { accountability: req.accountability, action: 'delete', collection: 'finance_team_entries', recordId: id, data: { removed } })
      return res.json({ ok: true, removed })
    } catch (e) { return err(res, req, 'team-entry-delete', e) }
  })

  // GET /finance/teams-summary?fiscal_year= — per-team income/expense/net + open bills
  router.get('/finance/teams-summary', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })
      const fyId = Number(req.query.fiscal_year)
      const hasFy = Number.isInteger(fyId)
      const entries = await database('finance_team_entries')
        .modify((qb) => { if (hasFy) qb.where('fiscal_year', fyId) }).select('team', 'kind', 'amount')
      const invs = await database('finance_invoices')
        .where('source', 'native').whereNotNull('team').whereNot('status', 'cancelled')
        .modify((qb) => { if (hasFy) qb.where('fiscal_year', fyId) }).select('team', 'amount', 'open_amount')
      const map = new Map()
      const bump = (tid) => { const k = Number(tid); if (!map.has(k)) map.set(k, { team: k, income: 0, expense: 0, invoice_total: 0, invoice_open: 0 }); return map.get(k) }
      for (const e of entries) { const m = bump(e.team); const a = Number(e.amount) || 0; if (e.kind === 'expense') m.expense += a; else m.income += a }
      for (const i of invs) { const m = bump(i.team); m.invoice_total += Number(i.amount) || 0; m.invoice_open += Number(i.open_amount) || 0 }
      const ids = [...map.keys()]
      const teams = ids.length ? await database('teams').whereIn('id', ids).select('id', 'name') : []
      const nameById = new Map(teams.map((t) => [Number(t.id), t.name]))
      const rows = [...map.values()].map((m) => ({
        team: m.team, team_name: nameById.get(m.team) || `#${m.team}`,
        income: round2(m.income), expense: round2(m.expense), net: round2(m.income - m.expense),
        invoice_total: round2(m.invoice_total), invoice_open: round2(m.invoice_open),
      })).sort((a, b) => a.team_name.localeCompare(b.team_name))
      return res.json({ teams: rows })
    } catch (e) { return err(res, req, 'teams-summary', e) }
  })

  // ── Budget lines — fills the dormant finance_budget_lines (budget vs actual) ──
  router.post('/finance/budget', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })
      const b = req.body || {}
      const fiscalYear = Number(b.fiscal_year)
      const account = Number(b.account)
      const amount = round2(b.amount_budgeted)
      if (!Number.isInteger(fiscalYear) || !Number.isInteger(account)) return res.status(400).json({ error: 'fiscal_year and account required' })
      const notes = (b.notes || '').toString().trim() || null
      const existing = await database('finance_budget_lines').where({ fiscal_year: fiscalYear, account }).first('id')
      let row
      if (existing) {
        const upd = await database('finance_budget_lines').where('id', existing.id).update({ amount_budgeted: amount, notes, source: 'native', date_updated: new Date() }).returning('*')
        row = upd[0]
      } else {
        const ins = await database('finance_budget_lines').insert({ fiscal_year: fiscalYear, account, amount_budgeted: amount, notes, source: 'native' }).returning('*')
        row = ins[0]
      }
      await writeUserLog(database, log, { accountability: req.accountability, action: existing ? 'update' : 'create', collection: 'finance_budget_lines', recordId: row.id, data: { fiscal_year: fiscalYear, account, amount } })
      return res.json({ budget: row })
    } catch (e) { return err(res, req, 'budget-save', e) }
  })

  router.delete('/finance/budget/:id', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })
      const id = Number(req.params.id)
      const removed = await database('finance_budget_lines').where('id', id).del()
      await writeUserLog(database, log, { accountability: req.accountability, action: 'delete', collection: 'finance_budget_lines', recordId: id, data: { removed } })
      return res.json({ ok: true, removed })
    } catch (e) { return err(res, req, 'budget-delete', e) }
  })

  // ── Dunning / Mahnwesen — reminders on overdue native invoices (migration 146) ──

  // GET /finance/dunning/candidates — overdue native invoices + never-dun + level
  router.get('/finance/dunning/candidates', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })
      const today = todayISO()
      const rows = await database('finance_invoices as fi')
        .leftJoin('members as m', 'm.id', 'fi.member')
        .where('fi.source', 'native').whereIn('fi.status', ['open', 'partial'])
        .whereNotNull('fi.due_date').where('fi.due_date', '<', today).where('fi.open_amount', '>', 0)
        .select('fi.id', 'fi.number', 'fi.recipient_name', 'fi.recipient_email', 'fi.amount', 'fi.open_amount',
          'fi.due_date', 'fi.dunning_level', 'fi.member', 'm.never_dun')
        .orderBy('fi.due_date', 'asc').limit(500)
      return res.json({ candidates: rows, today })
    } catch (e) { return err(res, req, 'dunning-candidates', e) }
  })

  // POST /finance/dunning/:id/escalate — record the next Mahnung (+ optional reminder email)
  router.post('/finance/dunning/:id/escalate', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })
      const id = Number(req.params.id)
      const inv = await database('finance_invoices').where('id', id).andWhere('source', 'native').first()
      if (!inv) return res.status(404).json({ error: 'Not found (native invoice expected)' })
      if (!['open', 'partial'].includes(inv.status)) return res.status(409).json({ error: `Invoice is ${inv.status}` })
      const level = Number(req.body?.level)
      if (![1, 2, 3].includes(level)) return res.status(400).json({ error: 'level must be 1, 2 or 3' })
      if (level !== (inv.dunning_level || 0) + 1) return res.status(409).json({ error: `Next level is ${(inv.dunning_level || 0) + 1}` })
      const fee = round2(req.body?.reminder_fee || 0)
      const sendEmail = req.body?.send_email === true

      let forcedNeverDun = false
      if (inv.member) {
        const m = await database('members').where('id', inv.member).first('never_dun')
        if (m?.never_dun) {
          if (req.body?.force !== true) return res.status(409).json({ error: 'Member is flagged never-dun', never_dun: true })
          forcedNeverDun = true // overriding the opt-out — record it for audit
        }
      }

      // ── Claim the level BEFORE the irreversible send ─────────────────────
      // finance_dunning_notices_invoice_level_uq UNIQUE (invoice, level) already decides
      // who owns level N — but it used to be consulted AFTER mail.send, so two treasurers
      // on the same overdue row (canManageFinance admits the whole board; the QR-bill
      // render + SES send is allowed 60s, and dunning_level was only bumped last) both
      // passed the level check above, both rendered the QR bill and both mailed the
      // Mahnung; the loser then hit 23505 and was answered "Level N already issued" —
      // after its letter had left. Stake the index FIRST, under a row lock on the invoice
      // and in one transaction, the way the dues bulk send stakes finance_email_jobs.
      // The claim is written as channel 'manual' / sent_at null — byte-for-byte the row
      // this handler already writes when a send fails — and is patched to 'email' below
      // once the send succeeds. So it is a record, never a lock: a crash between the
      // commit and the send leaves a legible "level recorded, not emailed" notice (the
      // state a failed send has always produced), nothing is stranded, and level N+1
      // stays available.
      let claim
      try {
        claim = await database.transaction(async (trx) => {
          const cur = await trx('finance_invoices').where('id', id).andWhere('source', 'native').forUpdate().first()
          if (!cur) return { code: 404, msg: 'Not found (native invoice expected)' }
          if (!['open', 'partial'].includes(cur.status)) return { code: 409, msg: `Invoice is ${cur.status}` }
          if (level !== (cur.dunning_level || 0) + 1) return { code: 409, msg: `Next level is ${(cur.dunning_level || 0) + 1}` }
          const ins = await trx('finance_dunning_notices').insert({
            invoice: id, level, reminder_fee: fee, channel: 'manual', recipient_email: inv.recipient_email || null,
            sent_at: null, created_by_name: mem?.name || null, created_by_email: mem?.email || null,
          }).returning('id')
          await trx('finance_invoices').where('id', id).update({ dunning_level: level, dunning_status: `Mahnung ${level}`, date_updated: new Date() })
          return { noticeId: ins[0]?.id ?? ins[0] }
        })
      } catch (e) {
        if (e?.code === '23505') return res.status(409).json({ error: `Level ${level} already issued` })
        throw e
      }
      if (claim.code) return res.status(claim.code).json({ error: claim.msg })
      const noticeId = claim.noticeId

      let channel = 'manual', sentAt = null, sendResult = 'not_sent'
      if (sendEmail && (inv.recipient_email || '').trim()) {
        const settings = await emailSettings()
        const to = settings.test_mode ? settings.test_recipient : inv.recipient_email
        if (settings.test_mode && !settings.test_recipient) { sendResult = 'no_test_recipient' }
        else if (to) {
          try {
            const schema = await getSchema()
            const { MailService } = services
            const mail = new MailService({ schema, knex: database })
            const open = Number(inv.open_amount) > 0 ? Number(inv.open_amount) : Number(inv.amount)
            const total = round2(open + fee)
            const html = composeDunningEmail(inv, total, level, fee, { testMode: settings.test_mode, realRecipient: inv.recipient_email })
            const attachments = []
            try {
              const message = [inv.number ? `Rechnungsnummer: ${inv.number}` : null, inv.subject].filter(Boolean).join('\n')
              const pdf = await renderInvoiceQrBillPdf({ amount: total, number: inv.number, recipientName: inv.recipient_name, subject: inv.subject, message, reference: inv.reference_type === 'SCOR' ? inv.reference : null })
              attachments.push({ filename: `${inv.number || 'Mahnung'}.pdf`, content: pdf, contentType: 'application/pdf' })
            } catch { /* send without attachment */ }
            await withTimeout(mail.send({ to, subject: `${settings.test_mode ? '[TEST] ' : ''}${level}. Mahnung — ${inv.number}`, html, ...(attachments.length ? { attachments } : {}) }), 60000, 'mahnung send timeout')
            channel = 'email'; sentAt = new Date(); sendResult = settings.test_mode ? 'test' : 'sent'
          } catch (e) { sendResult = 'send_failed'; log.warn?.({ msg: `mahnung email failed: ${e.message}`, invoice: inv.number }) }
        }
      }

      // Record the send outcome on the already-claimed notice. 'manual' / sent_at null
      // stands as written when nothing was sent or the send failed — unchanged behaviour.
      if (channel === 'email') {
        try { await database('finance_dunning_notices').where('id', noticeId).update({ channel, sent_at: sentAt }) }
        catch (e) { log.warn?.({ msg: `mahnung notice patch failed: ${e.message}`, invoice: inv.number }) }
      }
      await writeUserLog(database, log, { accountability: req.accountability, action: 'update', collection: 'finance_dunning_notices', recordId: id, data: { kind: 'dunning_escalate', invoice: id, level, fee, channel, send_result: sendResult, ...(forcedNeverDun ? { forced_never_dun: true, member: inv.member } : {}) } })
      return res.json({ ok: true, level, channel, send_result: sendResult })
    } catch (e) { return err(res, req, 'dunning-escalate', e) }
  })

  // GET /finance/dunning/:id/history — notices for one invoice
  router.get('/finance/dunning/:id/history', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })
      const id = Number(req.params.id)
      const notices = await database('finance_dunning_notices').where('invoice', id)
        .orderBy('level', 'asc').select('id', 'level', 'reminder_fee', 'channel', 'sent_at', 'created_by_name', 'date_created')
      return res.json({ notices })
    } catch (e) { return err(res, req, 'dunning-history', e) }
  })

  // POST /finance/members/:id/never-dun — toggle the per-member opt-out
  router.post('/finance/members/:id/never-dun', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })
      const id = Number(req.params.id)
      const value = req.body?.value === true
      const m = Number.isInteger(id) ? await database('members').where('id', id).first('id') : null
      if (!m) return res.status(404).json({ error: 'Not found' })
      await database('members').where('id', id).update({ never_dun: value })
      await writeUserLog(database, log, { accountability: req.accountability, action: 'update', collection: 'members', recordId: id, data: { kind: 'never_dun', value } })
      return res.json({ ok: true, never_dun: value })
    } catch (e) { return err(res, req, 'never-dun', e) }
  })

  // ── Billing contacts — invoice non-members (sponsors/parents/companies, mig 147) ──
  const CONTACT_KINDS = ['sponsor', 'parent', 'ex_member', 'company', 'other']

  router.get('/finance/contacts', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })
      const contacts = await database('finance_billing_contacts').where('active', true)
        .orderBy('name').select('id', 'kind', 'name', 'email', 'address', 'plz', 'ort', 'billing_iban', 'notes').limit(1000)
      return res.json({ contacts })
    } catch (e) { return err(res, req, 'contacts', e) }
  })

  router.post('/finance/contacts', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })
      const b = req.body || {}
      const name = (b.name || '').toString().trim()
      if (!name) return res.status(400).json({ error: 'name is required' })
      const cEmail = (b.email || '').toString().trim()
      if (cEmail && !isEmail(cEmail)) return res.status(400).json({ error: 'email must be a valid address' })
      const kind = CONTACT_KINDS.includes(b.kind) ? b.kind : 'sponsor'
      const ins = await database('finance_billing_contacts').insert({
        kind, name,
        email: (b.email || '').toString().trim() || null,
        address: (b.address || '').toString().trim() || null,
        plz: (b.plz || '').toString().trim() || null,
        ort: (b.ort || '').toString().trim() || null,
        billing_iban: (b.billing_iban || '').toString().replace(/\s+/g, '').toUpperCase() || null,
        notes: (b.notes || '').toString().trim().slice(0, 255) || null,
        source: 'native', created_by_name: mem?.name || null, created_by_email: mem?.email || null,
      }).returning('*')
      const row = ins[0]
      await writeUserLog(database, log, { accountability: req.accountability, action: 'create', collection: 'finance_billing_contacts', recordId: row.id, data: { kind, name } })
      return res.json({ contact: row })
    } catch (e) { return err(res, req, 'contact-save', e) }
  })

  // Soft-deactivate (keeps history on invoices that referenced the contact)
  router.delete('/finance/contacts/:id', async (req, res) => {
    try {
      const mem = await actingMember(req)
      if (!canManageFinance(req, mem)) return res.status(403).json({ error: 'Forbidden' })
      const id = Number(req.params.id)
      await database('finance_billing_contacts').where('id', id).update({ active: false, date_updated: new Date() })
      await writeUserLog(database, log, { accountability: req.accountability, action: 'update', collection: 'finance_billing_contacts', recordId: id, data: { kind: 'deactivate_contact' } })
      return res.json({ ok: true })
    } catch (e) { return err(res, req, 'contact-delete', e) }
  })
}
