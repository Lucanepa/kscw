#!/usr/bin/env node
/**
 * clubdesk-scrape-finance.mjs — Headless-browser automation of the ClubDesk
 * Finanz CSV exports (Rechnungen + Buchhaltung).
 *
 * Sibling of clubdesk-scrape-export.mjs (the member/Kontakte scraper). Same
 * approach: ClubDesk has NO public API, so we drive the web UI and trigger the
 * same "Alle Spalten" CSV export a human would, capturing the
 * GET /clubdesk/reportstore?reportId=… download.
 *
 * Usage:
 *   CLUBDESK_USER=… CLUBDESK_PASS=… \
 *     node directus/scripts/clubdesk-scrape-finance.mjs [invoices-out.csv] [bookings-out.csv]
 *
 *   Defaults: <tmpdir>/clubdesk-rechnungen.csv, <tmpdir>/clubdesk-buchhaltung.csv
 *   Both files are CP1252 / ';'-CSV — exactly what import-clubdesk-finance.mjs consumes.
 *
 * ⚠ ONE active session per ClubDesk account — this boots any human signed in on
 *   the SAME account. Use a DEDICATED service account for unattended runs.
 *
 * App internals (ClubDesk GXT/ExtGWT, tenant m_15650): the module launcher is a
 * row of 7 icon-only buttons (~40×50 px at the top-left, no text labels) — the
 * GXT classes are build-hashed, so we anchor on GEOMETRY + visible text, never
 * on class names. Finanzen is found by clicking launcher icons until a VISIBLE
 * "Rechnungen" tab appears (self-calibrating, survives icon reordering). Export
 * delivers via GET /clubdesk/reportstore?reportId=<uuid>.
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const USER = process.env.CLUBDESK_USER
const PASS = process.env.CLUBDESK_PASS
const OUT_INVOICES = process.argv[2] || join(tmpdir(), 'clubdesk-rechnungen.csv')
const OUT_BOOKINGS = process.argv[3] || join(tmpdir(), 'clubdesk-buchhaltung.csv')
const START = 'https://app.clubdesk.com/clubdesk/start'

if (!USER || !PASS) {
  console.error('Missing credentials. Set CLUBDESK_USER and CLUBDESK_PASS in the environment.')
  process.exit(1)
}

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
const log = (...a) => console.log(`[${stamp()}]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Center of the SMALLEST visible element whose trimmed innerText === `text`.
 *  Allows icon+text elements (GXT toolbar buttons render "<icon><text>"), so it
 *  matches both tab labels (zero-child spans) and toolbar buttons like "Export". */
const visibleLeafRect = (page, text) =>
  page.evaluate((t) => {
    let best = null, bestArea = Infinity
    for (const e of document.querySelectorAll('*')) {
      if ((e.innerText || '').trim() !== t) continue
      if (e.getClientRects().length === 0) continue
      const r = e.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) continue
      const area = r.width * r.height
      if (area < bestArea) { bestArea = area; best = r }
    }
    if (!best) return null
    return { x: best.left + best.width / 2, y: best.top + best.height / 2, right: best.right, bottom: best.bottom }
  }, text)

/** Poll visibleLeafRect until found or timeout. */
async function waitVisible(page, text, timeout = 20000) {
  const deadline = Date.now() + timeout
  for (;;) {
    const r = await visibleLeafRect(page, text)
    if (r) return r
    if (Date.now() > deadline) return null
    await sleep(400)
  }
}

async function clickVisible(page, text, timeout = 20000) {
  const r = await waitVisible(page, text, timeout)
  if (!r) throw new Error(`"${text}" never became visible.`)
  await page.mouse.click(r.x, r.y)
  return r
}

/** Centers of the launcher icon buttons (top-left icon row), left→right. */
const launcherIcons = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('div,button,a,td')]
      .map((e) => e.getBoundingClientRect())
      .filter((r) => r.top > 40 && r.top < 120 && r.left < 340 && r.width > 20 && r.width < 70 && r.height > 20 && r.height < 70)
      .map((r) => ({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }))
      .filter((b, i, a) => a.findIndex((x) => Math.abs(x.x - b.x) < 4 && Math.abs(x.y - b.y) < 4) === i)
      .sort((a, b) => a.x - b.x))

/** Ensure the Finanzen module is open (a visible "Rechnungen" tab is present). */
async function ensureFinanzenOpen(page) {
  if (await visibleLeafRect(page, 'Rechnungen')) return
  log('Finding the Finanzen launcher icon…')
  const icons = await launcherIcons(page)
  if (icons.length < 3) throw new Error(`Launcher icon row not found (got ${icons.length} icons).`)
  // Skip [0]=dashboard, [1]=Kontakte; click the rest until a finance tab appears.
  for (let i = 2; i < icons.length; i++) {
    await page.mouse.click(icons[i].x, icons[i].y)
    await sleep(1800)
    if (await visibleLeafRect(page, 'Rechnungen')) {
      log(`Finanzen opened (launcher icon #${i}).`)
      return
    }
  }
  throw new Error('Clicked every launcher icon but no visible "Rechnungen" tab appeared — Finanzen not reachable for this account?')
}

/**
 * Click Export, confirm whichever export dialog appears, return the download.
 * ClubDesk uses two different dialogs in Finanzen:
 *   • Rechnungen (table) → "Tabelle exportieren" — pick "Alle Spalten" first.
 *   • Buchhaltung (ledger) → "Export Buchungen" — fixed columns; defaults are
 *     already "Sämtliche Buchungen" + CSV, so just confirm with OK.
 */
async function exportCurrentTable(page, label) {
  log(`[${label}] Opening Export dialog…`)
  let kind = null
  for (let attempt = 0; attempt < 3 && !kind; attempt++) {
    await clickVisible(page, 'Export')
    const deadline = Date.now() + 7000
    while (Date.now() < deadline && !kind) {
      if (await visibleLeafRect(page, 'Tabelle exportieren')) kind = 'table'
      else if (await visibleLeafRect(page, 'Export Buchungen')) kind = 'buchungen'
      else await sleep(400)
    }
    if (!kind) await page.waitForTimeout(1000)
  }
  if (!kind) throw new Error(`[${label}] No export dialog ("Tabelle exportieren" / "Export Buchungen") opened.`)
  await page.waitForTimeout(600)

  if (kind === 'table') {
    // Open the "Spalten" combo (caret right of the "Spalten:" label) → "Alle Spalten".
    const sp = await visibleLeafRect(page, 'Spalten:')
    if (!sp) throw new Error(`[${label}] "Spalten:" row not found in export dialog.`)
    await page.mouse.click(sp.right + 120, sp.y)
    await page.waitForTimeout(800)
    await clickVisible(page, 'Alle Spalten', 8000)
    await page.waitForTimeout(500)
  }
  // 'buchungen' dialog: defaults are "Sämtliche Buchungen" + CSV — confirm as-is.

  log(`[${label}] Exporting (${kind})…`)
  const ok = await waitVisible(page, 'OK', 8000)
  if (!ok) throw new Error(`[${label}] OK button not found in export dialog.`)
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    page.mouse.click(ok.x, ok.y),
  ])
  return download
}

/** Navigate to a Finanzen sub-table and wait for its Export action. */
async function openFinanceTable(page, which, leftNavFilter) {
  log(`Navigating to Finanzen → ${which}…`)
  await ensureFinanzenOpen(page)
  await clickVisible(page, which)
  await page.waitForTimeout(2500) // let the tab's grid + toolbar fully render
  if (leftNavFilter) {
    // Pick a left-nav filter before exporting — e.g. "Alle" = ALL invoices
    // (drafts + issued + closed), not just the default "Entwürfe" (drafts) view.
    const f = await waitVisible(page, leftNavFilter, 8000)
    if (f) { await page.mouse.click(f.x, f.y); await page.waitForTimeout(2500); log(`Filter "${leftNavFilter}" selected.`) }
    else log(`⚠ Filter "${leftNavFilter}" not found — exporting the current view.`)
  }
  // Wait for the table toolbar (the Export action) to be ready.
  if (!(await waitVisible(page, 'Export', 20000))) {
    throw new Error(`Opened ${which} but no Export action appeared.`)
  }
  await page.waitForTimeout(800)
  log(`Finanzen → ${which} open.`)
}

/** Sanity-check a downloaded CSV has the expected header columns. */
function assertCsv(path, label, mustHave) {
  const header = new TextDecoder('windows-1252').decode(readFileSync(path)).split(/\r?\n/)[0] || ''
  for (const col of mustHave) {
    if (!header.includes(col)) {
      throw new Error(`[${label}] Export looks wrong — header missing "${col}". Got: ${header.slice(0, 160)}…`)
    }
  }
  log(`[${label}] ✓ ${path} — ${header.split(';').length} columns.`)
}

async function run() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  try {
    const ctx = await browser.newContext({
      locale: 'de-CH', timezoneId: 'Europe/Zurich',
      viewport: { width: 1500, height: 950 }, acceptDownloads: true,
    })
    const page = await ctx.newPage()
    page.setDefaultTimeout(45000)

    // ── Login (identical to clubdesk-scrape-export.mjs) ───────────────
    log('Opening ClubDesk login…')
    await page.goto(START, { waitUntil: 'networkidle' })
    await page.fill('#userId', USER)
    await page.fill('#password', PASS)
    await Promise.all([
      page.waitForLoadState('networkidle').catch(() => {}),
      page.click('#submit'),
    ])
    await page.waitForTimeout(3000)
    if (await page.locator('#password').count()) {
      throw new Error('Still on the login form after submit — wrong credentials, or login blocked (2FA/CAPTCHA?).')
    }
    log('Logged in.')

    // ── Rechnungen → export ───────────────────────────────────────────
    await openFinanceTable(page, 'Rechnungen', 'Alle') // "Alle" = all invoices, not just drafts
    const invDl = await exportCurrentTable(page, 'Rechnungen')
    await invDl.saveAs(OUT_INVOICES)
    log(`Downloaded Rechnungen via ${invDl.url()}`)
    assertCsv(OUT_INVOICES, 'Rechnungen', ['[Id]', 'Betrag', 'Rechnungsdatum'])

    // ── Buchhaltung → export ──────────────────────────────────────────
    await openFinanceTable(page, 'Buchhaltung')
    const bkDl = await exportCurrentTable(page, 'Buchhaltung')
    await bkDl.saveAs(OUT_BOOKINGS)
    log(`Downloaded Buchhaltung via ${bkDl.url()}`)
    assertCsv(OUT_BOOKINGS, 'Buchhaltung', ['Soll (Nummer)', 'Haben (Nummer)', 'Betrag (CHF)'])

    log(`✓ Done. Invoices → ${OUT_INVOICES}, Bookings → ${OUT_BOOKINGS}`)
    console.log(OUT_INVOICES)
    console.log(OUT_BOOKINGS)
  } finally {
    await browser.close()
  }
}

run().catch((e) => {
  console.error('✗', e.message || String(e))
  process.exit(1)
})
