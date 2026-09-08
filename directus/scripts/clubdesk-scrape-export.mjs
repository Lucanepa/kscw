#!/usr/bin/env node
/**
 * clubdesk-scrape-export.mjs — Headless-browser automation of the ClubDesk
 * member CSV export.
 *
 * ClubDesk has NO public API (a 10-year-pending feature request), so the only
 * way to pull member data programmatically is to drive the web UI and trigger
 * the same CSV export a human would. This script logs in, opens Kontakte, and
 * exports the full "Alle Spalten" table as a CP1252 / semicolon CSV — exactly
 * the 58-column shape `import-clubdesk-csv.mjs` consumes. Pipe the two together
 * (see `npm run db:clubdesk:sync:dev`) to fully automate the import.
 *
 * Usage:
 *   CLUBDESK_USER=... CLUBDESK_PASS=... \
 *     node directus/scripts/clubdesk-scrape-export.mjs [out-csv]
 *
 *   [out-csv]  output path. Default: <tmpdir>/clubdesk-export.csv
 *              The file contains member PII (incl. IBAN/AHV) — keep it out of
 *              the repo and delete it after import.
 *
 * ⚠ ClubDesk enforces ONE active session per account. Logging in here will
 *   boot any human currently signed in WITH THE SAME ACCOUNT (and vice-versa).
 *   Use a DEDICATED ClubDesk service account for unattended runs.
 *
 * App internals (ClubDesk v4.5.x, Sencha GXT / ExtGWT, tenant m_15650):
 *   - login is a plain form POST (#userId / #password / #submit); no 2FA/CAPTCHA
 *   - the main toolbar is 7 icon buttons; Kontakte is the 2nd
 *   - export delivers via GET /clubdesk/reportstore?reportId=<uuid>
 *   GXT CSS classes are build-hashed, so we anchor on geometry + visible text,
 *   never on class names, and assert after every step.
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const USER = process.env.CLUBDESK_USER
const PASS = process.env.CLUBDESK_PASS
const OUT = process.argv[2] || join(tmpdir(), 'clubdesk-export.csv')
const START = 'https://app.clubdesk.com/clubdesk/start'

if (!USER || !PASS) {
  console.error('Missing credentials. Set CLUBDESK_USER and CLUBDESK_PASS in the environment.')
  console.error('  e.g. CLUBDESK_USER=bot@kscw.ch CLUBDESK_PASS=… npm run db:clubdesk:export')
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
/**
 * A progress marker for the in-app bar.
 *
 * `@@STEP <pct> <sentence>` is read off this process's stdout by
 * clubdesk-member-dispatch.sh (via clubdesk-progress.sh) and written to
 * clubdesk_member_sync, so a superadmin watching the sync sees the scrape's own
 * sub-steps instead of an indeterminate bar. The percentages are this scraper's
 * slice of the whole sync-down (4→58); the transform and load own the rest.
 *
 * ⚠ Sentence case and no ClubDesk jargon: this string is USER-FACING, it is not a
 * log line. ⚠ Never printed after the final OUT path — the last stdout line is the
 * file path, for shell chaining.
 */
const step = (pct, msg) => { console.log(`@@STEP ${pct} ${msg}`); log(msg) }
const fail = (msg) => { console.error('✗', msg); process.exitCode = 1 }

/** Rect (viewport coords) of the first zero-child element whose trimmed text equals `text`. */
const leafRect = (page, text) =>
  page.evaluate((t) => {
    const el = [...document.querySelectorAll('*')]
      .find((e) => e.childElementCount === 0 && (e.innerText || '').trim() === t)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, right: r.right, bottom: r.bottom }
  }, text)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function run() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  try {
    const ctx = await browser.newContext({
      locale: 'de-CH',
      timezoneId: 'Europe/Zurich',
      viewport: { width: 1500, height: 950 },
      acceptDownloads: true,
    })
    const page = await ctx.newPage()
    page.setDefaultTimeout(45000)

    // ── 1. Login ──────────────────────────────────────────────────────
    step(6, 'Opening the ClubDesk login…')
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
    const me = (await page.locator('body').innerText().catch(() => '')).match(/Benutzer:\s*([^\n]+)/)
    step(16, `Logged in${me ? ` as ${me[1].trim()}` : ''}.`)

    // ── 2. Open Kontakte (2nd toolbar button) ─────────────────────────
    step(24, 'Opening the contact list…')
    const navBtn = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('div')]
        .map((e) => ({ e, r: e.getBoundingClientRect() }))
        .filter(({ r }) => r.top > 40 && r.top < 120 && r.left < 320 &&
          r.width > 20 && r.width < 70 && r.height > 20 && r.height < 70)
        .sort((a, b) => a.r.left - b.r.left)
      const b = btns[1] // [0]=dashboard, [1]=Kontakte
      if (!b) return null
      return { x: b.r.left + b.r.width / 2, y: b.r.top + b.r.height / 2 }
    })
    if (!navBtn) throw new Error('Could not locate the Kontakte toolbar button.')
    await page.mouse.click(navBtn.x, navBtn.y)
    // Assert the contact list loaded via its "(NNN Einträge)" count header
    // (plain "Mitglieder" also appears in hidden help links on the dashboard).
    await page.getByText(/\(\d+\s*Eintr/).first().waitFor({ timeout: 20000 })
    await page.waitForTimeout(1500)
    const count = (await page.locator('body').innerText()).match(/Mitglieder\s*\((\d+)\s*Eintr/)
    step(30, `Contact list open${count ? ` — ${count[1]} members in the default group` : ''}.`)

    // ── 2b. Switch to the "Alle Kontakte" group ───────────────────────
    // Kontakte opens on the "Mitglieder" group (active members only), which
    // OMITS non-members and EXITED members (Austritt / "Kein Mitglied"). That
    // means anyone who leaves the club silently disappears from the sync — they
    // can never be matched/linked, and wiedisync never learns they left. Select
    // "Alle Kontakte" (the full contact set) so the export carries everyone with
    // their membership status, enabling exit detection downstream.
    step(34, 'Switching to all contacts…')
    const alleKontakte = page.getByText('Alle Kontakte', { exact: true }).first()
    if (!(await alleKontakte.count())) throw new Error('"Alle Kontakte" sidebar entry not found.')
    await alleKontakte.click()
    await page.waitForTimeout(2500)
    // Assert the list header now reflects the full contact set (fail-safe: if the
    // click missed, the header still says "Mitglieder (…)" and this throws).
    await page.getByText(/Alle Kontakte\s*\(\d+\s*Eintr/).first().waitFor({ timeout: 20000 })
    const allCount = (await page.locator('body').innerText()).match(/Alle Kontakte\s*\((\d+)\s*Eintr/)
    step(40, `All contacts selected${allCount ? ` — ${allCount[1]} contacts` : ''}.`)

    // ── 3. Export dialog ──────────────────────────────────────────────
    step(44, 'Opening the export dialog…')
    await page.getByText('Export', { exact: true }).first().click()
    await page.getByText('Tabelle exportieren', { exact: true }).waitFor({ timeout: 20000 })
    await page.waitForTimeout(800)

    // Open the "Spalten" combo (caret is right of the "Spalten:" label) and
    // pick "Alle Spalten" so we get all 58 columns, not just the visible ones.
    const sp = await leafRect(page, 'Spalten:')
    if (!sp) throw new Error('Export dialog opened but "Spalten:" row not found.')
    await page.mouse.click(sp.right + 120, sp.y)
    await page.waitForTimeout(800)
    const alle = page.getByText('Alle Spalten', { exact: true }).first()
    if (!(await alle.count())) throw new Error('"Alle Spalten" option not found in the Spalten combo.')
    await alle.click()
    await page.waitForTimeout(500)
    step(48, 'All columns selected (CSV).')

    // ── 4. Trigger download (OK) ──────────────────────────────────────
    const ok = await leafRect(page, 'OK')
    if (!ok) throw new Error('OK button not found in export dialog.')
    step(52, 'Waiting for ClubDesk to build the export…')
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      page.mouse.click(ok.x, ok.y),
    ])
    await download.saveAs(OUT)
    step(56, 'Export downloaded.')
    log(`Downloaded via ${download.url()}`)

    // ── 5. Sanity-check the file ──────────────────────────────────────
    const buf = readFileSync(OUT)
    const lines = new TextDecoder('windows-1252').decode(buf).split(/\r?\n/)
    const header = lines[0] || ''
    const cols = header ? header.split(';').length : 0
    // Raw line count is approximate (some Bemerkungen fields contain embedded
    // newlines); the importer's CSV parser resolves them to the true row count.
    const rawLines = lines.slice(1).filter((l) => l.trim()).length
    if (cols < 50 || !/E-Mail/.test(header) || !/\[Id\]/.test(header)) {
      throw new Error(`Export looks wrong (${cols} cols; expected ≥50 incl. E-Mail and [Id]). ` +
        `Did "Alle Spalten" apply? Header: ${header.slice(0, 120)}…`)
    }
    step(58, `Export checked — ${rawLines} contacts, ${cols} columns.`)
    log(`✓ Wrote ${OUT} — ~${rawLines} data lines, ${cols} columns (${buf.length} bytes).`)
    console.log(OUT) // last line = path, for shell chaining
  } finally {
    await browser.close()
  }
}

run().catch((e) => {
  fail(e.message || String(e))
  process.exit(1)
})
