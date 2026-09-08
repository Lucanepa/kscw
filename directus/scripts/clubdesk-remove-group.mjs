#!/usr/bin/env node
/**
 * clubdesk-remove-group.mjs — Remove a contact from a ClubDesk group, via the
 * contact-DETAIL view (the "Gruppen:" field renders each allocation as a chip with
 * an × button). The "Gruppen ▼ → Kontakt aus Gruppe entfernen" toolbar path is
 * greyed out in "Alle Kontakte" (only works inside a specific group's view), so we
 * use the detail chips instead — precise, per-allocation, no left-nav hunting.
 *
 * Flow: Alle Kontakte → Filtern by uuid → select → double-click (open detail) →
 *       click the × on the chip whose label === the target group → Speichern & Schließen.
 *
 * Usage: CLUBDESK_USER=… CLUBDESK_PASS=… node clubdesk-remove-group.mjs <worklist.json> <preview|commit>
 *   worklist.json: [{ "name":"Meinen Lasse", "uuid":"3b22233f-…", "group_label":"VB H2 (Spieler*in)" }, …]
 *     group_label = the EXACT chip text as shown in the detail Gruppen field
 *   preview → locate the × and screenshot, then close WITHOUT saving (no write)
 *   commit  → click ×, then Speichern & Schließen (persists the removal)
 *
 * ⚠ ONE ClubDesk session per account — run under the shared .sync.lock.
 * ⚠ 'commit' edits the club's legal member record.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const require = createRequire(import.meta.url)
const { chromium } = require('playwright')
const USER = process.env.CLUBDESK_USER, PASS = process.env.CLUBDESK_PASS
const WORKLIST = process.argv[2], MODE = process.argv[3] || 'preview'
const SHOTS = process.env.CLUBDESK_GROUP_SHOTS || ''
const START = 'https://app.clubdesk.com/clubdesk/start'
const log = (...a) => console.error(`[${new Date().toISOString().slice(11, 19)}]`, ...a)
/**
 * Progress marker for the in-app bar (see clubdesk-progress.sh).
 *
 * `@@STEP <pct> <sentence>` on stderr — stdout is the JSON summary and the
 * dispatcher reads it with `tail -1`, so a progress line there would be parsed as
 * the result. The percentage is ABSOLUTE for the whole group-fix run, which this
 * tool cannot know on its own: the dispatcher passes its slice in CDP_BASE /
 * CDP_SPAN. Run from a terminal without them it simply spans 0-100.
 */
const CDP_BASE = Number(process.env.CDP_BASE || 0)
const CDP_SPAN = Number(process.env.CDP_SPAN || 100)
const step = (i, n, msg) =>
  console.error(`@@STEP ${Math.round(CDP_BASE + CDP_SPAN * (n ? i / n : 1))} ${msg}`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (p, n) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/rmg-${n}.png` }).catch(() => {}) }
if (!USER || !PASS) { log('Missing CLUBDESK_USER/PASS'); process.exit(1) }
if (!WORKLIST) { log('Usage: clubdesk-remove-group.mjs <worklist.json> <preview|commit>'); process.exit(1) }
if (!['preview', 'commit'].includes(MODE)) { log(`Bad mode "${MODE}"`); process.exit(1) }
const rows = JSON.parse(readFileSync(WORKLIST, 'utf8'))
if (!Array.isArray(rows) || !rows.length) { log('Empty worklist'); process.exit(1) }

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

// In the open detail view, locate the × control for the chip whose label === target.
// Returns { x, y } click point for the ×, { notfound:true, chips:[…] } if no such
// chip. The chip label is a DIV whose OWN text (immediate text node — NOT descendant
// textContent, which for a container concatenates every chip) === target. Its close
// button is a small (~16px) <a> icon whose center sits in the RIGHT ~2/3 of the label
// box (verified from the DOM 2026-07-16: VB H2 label [943,1080] → × <a> at cx=1067,
// i.e. INSIDE the label's right edge, so a "just past L.right" offset misses it).
const findChipRemove = (page, target) => page.evaluate((target) => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
  const chips = new Set()
  let L = null
  for (const e of document.querySelectorAll('div')) {
    let own = ''; for (const n of e.childNodes) if (n.nodeType === 3) own += n.textContent; own = norm(own)
    if (!own || own.length > 40) continue
    const r = e.getBoundingClientRect()
    if (r.left < 900 || r.width <= 0 || r.height <= 0 || r.top < 460 || r.top > 600) continue
    if (/^(VB|BB)\b|Trainer|Spieler|Schreib|Schiedsr|Offiziell/i.test(own)) chips.add(own)
    if (own === target) { const c = { left: r.left, right: r.right, top: r.top, bottom: r.bottom, cy: r.top + r.height / 2, w: r.width, area: r.width * r.height }; if (!L || c.area < L.area) L = c }
  }
  if (!L) return { notfound: true, chips: [...chips] }
  let best = null
  for (const a of document.querySelectorAll('a')) {
    const r = a.getBoundingClientRect()
    if (r.width < 8 || r.width > 20 || r.height < 8 || r.height > 20) continue
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2
    if (Math.abs(cy - L.cy) > 10) continue                       // same chip row
    if (cx < L.left + L.w * 0.3 || cx > L.right + 12) continue   // right portion of this chip
    if (!best || cx > best.cx) best = { cx, x: Math.round(cx), y: Math.round(cy) } // rightmost = the × (text is left of it)
  }
  if (best) return { x: best.x, y: best.y, via: 'a-icon' }
  return { x: Math.round(L.right - 8), y: Math.round(L.cy), via: 'right-inset' }
}, target)

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

// True while a contact-detail tab is open (its "Gruppen:" form label is present).
const detailOpen = (page) => page.evaluate(() => [...document.querySelectorAll('*')].some((e) => { let t = ''; for (const n of e.childNodes) if (n.nodeType === 3) t += n.textContent; return t.trim() === 'Gruppen:' }))

// The uuid shown in the OPEN detail's "Wiedisync ID" field. MUST read the detail form
// field (bottom of the form, top>600 left>850), NOT the grid Filtern box — that box
// still holds the uuid we typed, so matching it would always "confirm" and defeat the
// whole guard. Returns lowercased uuid or null.
const detailUuid = (page) => page.evaluate(() => {
  for (const i of document.querySelectorAll('input')) {
    const v = (i.value || '').trim()
    if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v)) continue
    const r = i.getBoundingClientRect()
    if (r.top > 600 && r.left > 850) return v.toLowerCase()
  }
  return null
})

// Close the contact-detail tab and confirm we're back on the grid.
async function closeDetail(page) {
  for (let i = 0; i < 3; i++) {
    if (!(await detailOpen(page))) return true
    await clickExact(page, 'Schließen', 120, 200); await sleep(700)
    if (!(await detailOpen(page))) return true
    await page.keyboard.press('Escape').catch(() => {}); await sleep(500)
  }
  return !(await detailOpen(page))
}

// Open contact <uuid>'s detail and CONFIRM the detail shows that uuid before returning
// true. Guards the multi-contact stale-detail lag: a dblclick that no-ops on a not-yet-
// ready grid leaves the PREVIOUS contact's detail on screen → without this we'd edit
// the WRONG person (proven in the 2026-07-16 dry-run: 28/49 read a neighbour's detail).
// Re-selects + re-opens on mismatch; returns false if it can't confirm the right detail.
async function openDetailConfirmed(page, uuid, cell) {
  const want = uuid.toLowerCase()
  let c = cell
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.mouse.dblclick(c.x, c.y); await sleep(2500)
    for (let k = 0; k < 14; k++) {
      if (await detailOpen(page)) { const du = await detailUuid(page); if (du === want) return true; if (du && du !== want) break }
      await sleep(400)
    }
    await closeDetail(page)                       // wrong/missing detail → reset and retry
    const f = await selectRow(page, uuid)
    if (f.cnt === 1 && f.cell) c = f.cell; else await sleep(600)
  }
  return false
}

async function run() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const results = []
  try {
    const ctx = await browser.newContext({ locale: 'de-CH', timezoneId: 'Europe/Zurich', viewport: { width: 1500, height: 950 } })
    const page = await ctx.newPage(); page.setDefaultTimeout(45000)
    log('Login…'); await openKontakte(page); log('Kontakte open.')
    let done = 0
    for (const row of rows) {
      step(done++, rows.length, `Removing groups — ${done} of ${rows.length}: ${row.name}`)
      const r = { name: row.name, uuid: row.uuid, group_label: row.group_label, status: 'error' }
      try {
        const f = await selectRow(page, row.uuid)
        if (f.cnt !== 1 || !f.cell) { r.status = 'skip_filter_failed'; r.matched = f.cnt; results.push(r); log(`· ${row.name}: uuid → cnt=${f.cnt}`); continue }
        // Open the detail AND confirm it's the target uuid (never edit an unconfirmed
        // detail — the stale-detail lag would otherwise strip the wrong contact's group).
        if (!(await openDetailConfirmed(page, row.uuid, f.cell))) { r.status = 'skip_identity_unconfirmed'; results.push(r); log(`· ${row.name}: could not confirm detail == uuid`); await closeDetail(page); continue }
        await shot(page, `${row.uuid.slice(0, 8)}-01-detail`)
        const chip = await findChipRemove(page, row.group_label)
        if (chip.notfound) { r.status = 'skip_not_in_group'; r.chips = chip.chips; results.push(r); log(`· ${row.name}: chip "${row.group_label}" not present. chips=${JSON.stringify(chip.chips)}`); await closeDetail(page); continue }
        r.clickVia = chip.via
        if (MODE === 'commit') {
          // Re-assert identity immediately before mutating (belt-and-suspenders vs any drift).
          if ((await detailUuid(page)) !== row.uuid.toLowerCase()) { r.status = 'error'; r.detail = 'identity drift before ×'; results.push(r); log(`✗ ${row.name}: identity drift`); await closeDetail(page); continue }
          await page.mouse.click(chip.x, chip.y); await sleep(700)
          await shot(page, `${row.uuid.slice(0, 8)}-02-xclicked`)
          // verify the chip is gone AND we're still on the right contact before saving
          const still = await findChipRemove(page, row.group_label)
          if (!still.notfound || (await detailUuid(page)) !== row.uuid.toLowerCase()) { r.status = 'error'; r.detail = 'chip still present / identity drift after × click'; results.push(r); log(`✗ ${row.name}: × did not remove chip (or drifted)`); await closeDetail(page); continue }
          if (!(await clickExact(page, 'Speichern & Schließen', 120, 200))) { r.status = 'error'; r.detail = 'save button not found'; results.push(r); await closeDetail(page); continue }
          await sleep(2800); await closeDetail(page)
          r.status = 'removed'; log(`✓ ${row.name} ✂ ${row.group_label}`)
        } else {
          r.status = 'previewed'; log(`◦ ${row.name} → would remove "${row.group_label}" (× via ${chip.via} @ ${chip.x},${chip.y})`)
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
