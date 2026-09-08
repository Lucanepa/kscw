#!/usr/bin/env node
/**
 * clubdesk-clear-field.mjs — CLEAR a field on a ClubDesk contact, via the
 * contact-DETAIL form.
 *
 * Why a browser and not the import wizard: the CSV import can only FILL and
 * UPDATE — an empty mapped cell is a proven no-op (spike 2026-07-08), so there
 * is NO CSV path to blank a field. Built 2026-07-30 to clear stale `Austritt`
 * dates off contacts who never actually left (they sit on a current-season
 * roster or staff a team, so the departure date is register drift).
 *
 * Flow: Alle Kontakte → Filtern by Wiedisync ID → select → double-click (open
 *       detail) → locate the labelled input → clear → read back → Speichern &
 *       Schließen.
 *
 * Usage: CLUBDESK_USER=… CLUBDESK_PASS=… node clubdesk-clear-field.mjs <worklist.json> <preview|commit>
 *   worklist.json: [{ "name":"Lilian Bartels", "uuid":"00305fbf-…",
 *                     "field":"Austritt", "expect":"16.05.2022" }, …]
 *     field   the form label WITHOUT the trailing colon (matched as "<field>:")
 *     expect  OPTIONAL but recommended — the value the field must currently hold.
 *             Mismatch → the contact is SKIPPED, not written. Guards against
 *             concurrent hand-edits in ClubDesk (someone clearing it first, or a
 *             different date having been entered since the worklist was built).
 *   preview → locate + read the current value, screenshot, close WITHOUT saving
 *   commit  → clear, verify empty, save
 *
 * ⚠ ONE ClubDesk session per account — run under the shared .sync.lock.
 * ⚠ 'commit' edits the club's legal member record. Gate it behind a human OK.
 *
 * Matching is by Wiedisync ID (members.uuid) — never by name. It is unique and
 * immune to the name drift ClubDesk carries (see CLAUDE.md → ClubDesk contact
 * matching). The clubdesk_id/[Id] is NOT Filtern-searchable.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const require = createRequire(import.meta.url)
const { chromium } = require('playwright')
const USER = process.env.CLUBDESK_USER, PASS = process.env.CLUBDESK_PASS
const WORKLIST = process.argv[2], MODE = process.argv[3] || 'preview'
const SHOTS = process.env.CLUBDESK_CLEAR_SHOTS || ''
const START = 'https://app.clubdesk.com/clubdesk/start'
// Log stamp: Swiss date AND time, in Europe/Zurich. It used to be
// `toISOString().slice(11,19)` — a bare UTC clock, so a line read `[15:05:03]`
// while the operator's screen said 17:05 and nothing said which DAY, on a log the
// admin page now shows in full (08.09.2026). de-CH + hour12:false is the app-wide
// rule; the comma de-CH puts between date and time is dropped so the stamp is one
// token.
const stamp = () => new Intl.DateTimeFormat('de-CH', {
  timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(new Date()).replace(', ', ' ')
const log = (...a) => console.error(`[${stamp()}]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (p, n) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/clr-${n}.png` }).catch(() => {}) }
if (!USER || !PASS) { log('Missing CLUBDESK_USER/PASS'); process.exit(1) }
if (!WORKLIST) { log('Usage: clubdesk-clear-field.mjs <worklist.json> <preview|commit>'); process.exit(1) }
if (!['preview', 'commit'].includes(MODE)) { log(`Bad mode "${MODE}"`); process.exit(1) }
const rows = JSON.parse(readFileSync(WORKLIST, 'utf8'))
if (!Array.isArray(rows) || !rows.length) { log('Empty worklist'); process.exit(1) }

// ── Grid helpers (identical to clubdesk-remove-group.mjs — same grid, same DOM) ──
const gridCount = (page) => page.evaluate(() => { const o = (e) => { let t = ''; for (const n of e.childNodes) if (n.nodeType === 3) t += n.textContent; return t.trim() }; for (const e of document.querySelectorAll('*')) { const m = o(e).match(/(?:Mitglieder|Alle Kontakte|Nicht-Mitglieder|Personen|Firmen)\s*\(\s*(\d+)\s+von\s+\d+\s+Eintr/i); if (m) return parseInt(m[1], 10) } return -1 })
const firstRowCell = (page) => page.evaluate(() => { const cells = []; for (const e of document.querySelectorAll('*')) { const t = (e.textContent || '').trim(); if (!t || t.length > 50) continue; const r = e.getBoundingClientRect(); if (r.width > 20 && r.height > 6 && r.top > 320 && r.top < 400 && r.left > 275 && r.left < 465) cells.push({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), area: r.width * r.height, top: Math.round(r.top) }) } if (!cells.length) return null; const mt = Math.min(...cells.map((c) => c.top)); const row = cells.filter((c) => c.top - mt < 15).sort((a, b) => a.area - b.area)[0]; return { x: row.x, y: row.y } })
const clickExact = async (page, exact, ymin = 0, ymax = 99999) => { const pos = await page.evaluate(({ exact, ymin, ymax }) => { const o = (e) => { let t = ''; for (const n of e.childNodes) if (n.nodeType === 3) t += n.textContent; return t.trim() }; const c = [...document.querySelectorAll('*')].filter((e) => o(e) === exact).map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0 && r.top >= ymin && r.top <= ymax).sort((a, b) => b.top - a.top)[0]; return c ? { x: Math.round(c.left + c.width / 2), y: Math.round(c.top + c.height / 2) } : null }, { exact, ymin, ymax }); if (!pos) return false; await page.mouse.click(pos.x, pos.y); return true }

async function selectRow(page, uuid) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const box = await page.evaluate(() => { const i = [...document.querySelectorAll('input')].map((e) => ({ e, r: e.getBoundingClientRect() })).filter(({ e, r }) => e.type !== 'hidden' && e.type !== 'password' && r.width > 60 && r.top > 230 && r.top < 320).sort((a, b) => b.r.width - a.r.width)[0]; return i ? { x: Math.round(i.r.left + i.r.width / 2), y: Math.round(i.r.top + i.r.height / 2) } : null })
    if (!box) { await sleep(700); continue }
    await page.mouse.click(box.x, box.y, { clickCount: 3 }); await sleep(180); await page.keyboard.press('Backspace'); await sleep(450); await page.keyboard.type(uuid, { delay: 25 })
    for (let k = 0; k < 14; k++) { await sleep(300); const c = await gridCount(page); if (c === 1) { const cell = await firstRowCell(page); if (cell) return { cnt: 1, cell } } if (c > 1) return { cnt: c } }
    await sleep(600)
  }
  return { cnt: -1 }
}

async function openKontakte(page) {
  await page.goto(START, { waitUntil: 'networkidle' })
  await page.fill('#userId', USER); await page.fill('#password', PASS)
  await Promise.all([page.waitForLoadState('networkidle').catch(() => {}), page.click('#submit')]); await sleep(3000)
  if (await page.locator('#password').count()) throw new Error('login failed')
  const navBtn = await page.evaluate(() => { const b = [...document.querySelectorAll('div')].map((e) => ({ e, r: e.getBoundingClientRect() })).filter(({ r }) => r.top > 40 && r.top < 120 && r.left < 320 && r.width > 20 && r.width < 70 && r.height > 20 && r.height < 70).sort((a, c) => a.r.left - c.r.left)[1]; return b ? { x: b.r.left + b.r.width / 2, y: b.r.top + b.r.height / 2 } : null })
  await page.mouse.click(navBtn.x, navBtn.y); await page.getByText(/\(\d+\s*Eintr/).first().waitFor({ timeout: 20000 }); await sleep(1200)
  const ak = await page.evaluate(() => { const o = (e) => { let t = ''; for (const n of e.childNodes) if (n.nodeType === 3) t += n.textContent; return t.trim() }; for (const e of document.querySelectorAll('*')) if (o(e) === 'Alle Kontakte') { const r = e.getBoundingClientRect(); if (r.left < 300 && r.width > 0) return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } } return null })
  if (ak) { await page.mouse.click(ak.x, ak.y); await sleep(1600) }
}

const detailOpen = (page) => page.evaluate(() => [...document.querySelectorAll('*')].some((e) => { let t = ''; for (const n of e.childNodes) if (n.nodeType === 3) t += n.textContent; return t.trim() === 'Gruppen:' }))

// The uuid shown in the OPEN detail's "Wiedisync ID" field — read from the detail
// FORM (top>600 left>850), never the grid Filtern box (which still holds what we
// typed and would always "confirm").
const detailUuid = (page) => page.evaluate(() => {
  for (const i of document.querySelectorAll('input')) {
    const v = (i.value || '').trim()
    if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v)) continue
    const r = i.getBoundingClientRect()
    if (r.top > 600 && r.left > 850) return v.toLowerCase()
  }
  return null
})

async function closeDetail(page) {
  for (let i = 0; i < 3; i++) {
    if (!(await detailOpen(page))) return true
    await clickExact(page, 'Schließen', 120, 200); await sleep(700)
    if (!(await detailOpen(page))) return true
    await page.keyboard.press('Escape').catch(() => {}); await sleep(500)
  }
  return !(await detailOpen(page))
}

async function openDetailConfirmed(page, uuid, cell) {
  const want = uuid.toLowerCase()
  let c = cell
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.mouse.dblclick(c.x, c.y); await sleep(2500)
    for (let k = 0; k < 14; k++) {
      if (await detailOpen(page)) { const du = await detailUuid(page); if (du === want) return true; if (du && du !== want) break }
      await sleep(400)
    }
    await closeDetail(page)
    const f = await selectRow(page, uuid)
    if (f.cnt === 1 && f.cell) c = f.cell; else await sleep(600)
  }
  return false
}

// ── Field location ───────────────────────────────────────────────────────────
// Find the control that belongs to `field` in the open detail form.
//
// ⚠ ClubDesk's detail form packs SEVERAL fields under ONE label: the Austritt
// date lives under "Eintritt, Austritt, Status:" (proven by the 2026-07-30
// dry-run, which correctly refused to guess). So "nearest input to the right of
// the label" is WRONG — on that row it resolves to Eintritt, and clearing it
// would wipe the join date instead of the departure date.
//
// Rule: split the label on commas; the field's ORDINAL among those parts is its
// ordinal among the row's controls, left-to-right. <select> counts as a control
// (Status is a select) so the positions stay aligned. Labels are matched on OWN
// text — a container's concatenated textContent can never match — and the
// SMALLEST matching box wins (the label, not a wrapping cell); same discipline as
// findChipRemove in clubdesk-remove-group.mjs.
const findFieldInput = (page, field) => page.evaluate((field) => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
  const labels = []
  let L = null
  for (const e of document.querySelectorAll('*')) {
    let own = ''; for (const n of e.childNodes) if (n.nodeType === 3) own += n.textContent
    own = norm(own)
    if (!own || own.length > 60 || !own.endsWith(':')) continue
    const r = e.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    labels.push(own)
    const parts = own.replace(/:$/, '').split(',').map((s) => s.trim())
    const idx = parts.indexOf(field)
    if (idx < 0) continue
    const c = { text: own, idx, parts: parts.length, left: r.left, right: r.right, cy: r.top + r.height / 2, area: r.width * r.height }
    if (!L || c.area < L.area) L = c
  }
  if (!L) return { notfound: true, labels: [...new Set(labels)].slice(0, 60) }
  const ctrls = []
  for (const i of document.querySelectorAll('input, select')) {
    if (i.tagName === 'INPUT' && ['hidden', 'password', 'checkbox', 'radio'].includes(i.type)) continue
    const r = i.getBoundingClientRect()
    if (r.width < 20 || r.height <= 0) continue
    if (Math.abs(r.top + r.height / 2 - L.cy) > 12) continue   // same form row
    if (r.left < L.right - 4) continue                          // to the right of the label
    ctrls.push({ left: r.left, tag: i.tagName, x: Math.round(r.left + Math.min(r.width, 120) / 2), y: Math.round(r.top + r.height / 2), value: (i.value || '').trim() })
  }
  ctrls.sort((a, b) => a.left - b.left)
  if (ctrls.length !== L.parts) return { notfound: true, reason: `label "${L.text}" names ${L.parts} field(s) but the row has ${ctrls.length} control(s) — refusing to guess`, labels: [] }
  const t = ctrls[L.idx]
  return { x: t.x, y: t.y, value: t.value, label: L.text, ordinal: L.idx, tag: t.tag }
}, field)

const readField = async (page, field) => { const f = await findFieldInput(page, field); return f.notfound ? null : f.value }

// Clear the located input: select-all inside it, delete, then blur by clicking the
// label (NOT Escape — Escape closes the whole detail tab). Any date-picker popup a
// focused date field opens is dismissed by that same blur click.
async function clearField(page, field, pos) {
  await page.mouse.click(pos.x, pos.y, { clickCount: 3 }); await sleep(200)
  await page.keyboard.press('Control+A').catch(() => {}); await sleep(100)
  await page.keyboard.press('Delete'); await sleep(150)
  await page.keyboard.press('Backspace'); await sleep(250)
  await clickExact(page, pos.label, 0, 99999); await sleep(500)   // blur on the label + dismiss any date picker
  return readField(page, field)
}

async function run() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const results = []
  try {
    const ctx = await browser.newContext({ locale: 'de-CH', timezoneId: 'Europe/Zurich', viewport: { width: 1500, height: 950 } })
    const page = await ctx.newPage(); page.setDefaultTimeout(45000)
    log('Login…'); await openKontakte(page); log('Kontakte open.')
    for (const row of rows) {
      const field = row.field || 'Austritt'
      const r = { name: row.name, uuid: row.uuid, field, status: 'error' }
      try {
        const f = await selectRow(page, row.uuid)
        if (f.cnt !== 1 || !f.cell) { r.status = 'skip_filter_failed'; r.matched = f.cnt; results.push(r); log(`· ${row.name}: uuid → cnt=${f.cnt}`); continue }
        if (!(await openDetailConfirmed(page, row.uuid, f.cell))) { r.status = 'skip_identity_unconfirmed'; results.push(r); log(`· ${row.name}: could not confirm detail == uuid`); await closeDetail(page); continue }
        await shot(page, `${row.uuid.slice(0, 8)}-01-detail`)

        const loc = await findFieldInput(page, field)
        if (loc.notfound) { r.status = 'skip_field_not_found'; r.labels = loc.labels; results.push(r); log(`· ${row.name}: no "${field}:" input. labels=${JSON.stringify((loc.labels || []).slice(0, 20))}`); await closeDetail(page); continue }
        r.before = loc.value
        if (!loc.value) { r.status = 'skip_already_empty'; results.push(r); log(`· ${row.name}: ${field} already empty — nothing to do`); await closeDetail(page); continue }
        // Concurrent-edit guard: refuse to touch a value that isn't the one the
        // worklist was built from (someone may have corrected it in the meantime).
        if (row.expect != null && loc.value !== row.expect) { r.status = 'skip_value_mismatch'; r.expected = row.expect; results.push(r); log(`· ${row.name}: ${field}="${loc.value}" ≠ expected "${row.expect}" — skipped`); await closeDetail(page); continue }

        if (MODE === 'commit') {
          if ((await detailUuid(page)) !== row.uuid.toLowerCase()) { r.status = 'error'; r.detail = 'identity drift before clear'; results.push(r); log(`✗ ${row.name}: identity drift`); await closeDetail(page); continue }
          const after = await clearField(page, field, loc)
          await shot(page, `${row.uuid.slice(0, 8)}-02-cleared`)
          if (after) { r.status = 'error'; r.detail = `field still "${after}" after clear`; results.push(r); log(`✗ ${row.name}: clear did not take (still "${after}")`); await closeDetail(page); continue }
          if ((await detailUuid(page)) !== row.uuid.toLowerCase()) { r.status = 'error'; r.detail = 'identity drift after clear'; results.push(r); log(`✗ ${row.name}: identity drift after clear`); await closeDetail(page); continue }
          if (!(await clickExact(page, 'Speichern & Schließen', 120, 200))) { r.status = 'error'; r.detail = 'save button not found'; results.push(r); await closeDetail(page); continue }
          await sleep(2800); await closeDetail(page)
          r.status = 'cleared'; log(`✓ ${row.name}: ${field} "${r.before}" → (leer)`)
        } else {
          r.status = 'previewed'; log(`◦ ${row.name}: would clear ${field} = "${loc.value}" (input @ ${loc.x},${loc.y})`)
          await shot(page, `${row.uuid.slice(0, 8)}-preview`)
          await closeDetail(page)
        }
        results.push(r)
      } catch (e) { r.status = 'error'; r.detail = e.message; results.push(r); log(`✗ ${row.name}:`, e.message); await closeDetail(page).catch(() => {}); for (let i = 0; i < 2; i++) { await page.keyboard.press('Escape').catch(() => {}); await sleep(300) } }
    }
  } catch (e) { log('✗ fatal:', e.message); process.exitCode = 1 } finally { await browser.close() }
  const tally = {}; for (const x of results) tally[x.status] = (tally[x.status] || 0) + 1
  process.stdout.write(JSON.stringify({ mode: MODE, count: rows.length, tally, results }) + '\n')
}
run()
