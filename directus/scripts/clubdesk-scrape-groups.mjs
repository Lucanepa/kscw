#!/usr/bin/env node
/**
 * clubdesk-scrape-groups.mjs — Headless-browser automation of ClubDesk group
 * assignment (the "Kontakt zu Gruppe hinzufügen" flow). Counterpart to
 * clubdesk-scrape-import.mjs, for the one thing the CSV import can't do: ClubDesk
 * group membership (the `Gruppen` import column is a proven no-op).
 *
 * ClubDesk has NO API — group assignment is a GWT-RPC `update` that re-sends the
 * whole Contact bean with an added Allocation (verified from a HAR 2026-07-15).
 * Replaying that is unmaintainable (permutation-specific type hashes), so we drive
 * the real UI a human would: Kontakte → Filtern to the contact → select → Gruppen
 * ▼ → "Kontakt zu Gruppe hinzufügen" → pick Gruppe + Funktion → OK.
 *
 * Usage:
 *   CLUBDESK_USER=… CLUBDESK_PASS=… node clubdesk-scrape-groups.mjs <worklist.json> <preview|commit>
 *     worklist.json: [{ "name":"Fretz Finn", "group":"VB H2", "funktion":"Spieler*in", "clubdesk_id":"1000886" }, …]
 *       name     = ClubDesk display name "Nachname Vorname" (what Filtern matches)
 *       group    = ClubDesk group token (teams.clubdesk_group), e.g. "VB H2"
 *       funktion = "Spieler*in" | "Trainer*in" | "Guest" (guest_level > 0 players)
 *     mode:  preview → do every step up to the dialog, then Abbrechen (NO write);
 *            commit  → click OK (writes the assignment to the legal register).
 *
 * Output: one JSON line on stdout: {"mode":"preview","done":[…],"results":[{…per row}]}
 * Per-row status: assigned | previewed | skip_ambiguous | skip_no_contact |
 *                 skip_filter_failed | skip_no_selection | skip_ok_disabled |
 *                 skip_group_not_found | skip_funktion_not_found | error
 *
 * ⚠ ONE ClubDesk session per account — run under the shared .sync.lock.
 * ⚠ 'commit' writes to the club's legal member record — gate behind a human OK.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const USER = process.env.CLUBDESK_USER
const PASS = process.env.CLUBDESK_PASS
const WORKLIST = process.argv[2]
const MODE = process.argv[3] || 'preview'
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
if (!USER || !PASS) { log('Missing CLUBDESK_USER/PASS'); process.exit(1) }
if (!WORKLIST) { log('Usage: clubdesk-scrape-groups.mjs <worklist.json> <preview|commit>'); process.exit(1) }
if (!['preview', 'commit'].includes(MODE)) { log(`Bad mode "${MODE}"`); process.exit(1) }
const rows = JSON.parse(readFileSync(WORKLIST, 'utf8'))
if (!Array.isArray(rows) || !rows.length) { log('Empty worklist'); process.exit(1) }

const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/grp-${name}.png` }).catch(() => {}) }
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase()

// Click the element whose OWN text === exact (optionally within a y-band); lowest wins.
const clickExact = async (page, exact, ymin = 0, ymax = 99999) => {
  const pos = await page.evaluate(({ exact, ymin, ymax }) => {
    const ownText = (e) => { let t = ''; for (const n of e.childNodes) if (n.nodeType === 3) t += n.textContent; return t.trim() }
    const c = [...document.querySelectorAll('*')].filter((e) => ownText(e) === exact)
      .map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0 && r.top >= ymin && r.top <= ymax)
      .sort((a, b) => b.top - a.top)[0]
    return c ? { x: Math.round(c.left + c.width / 2), y: Math.round(c.top + c.height / 2) } : null
  }, { exact, ymin, ymax })
  if (!pos) return false
  await page.mouse.click(pos.x, pos.y); return true
}
// The ACTIVE contact-grid filtered count. Must be tied to the grid header
// ("Mitglieder (X von Y Einträgen)") — a bare /\(\d+ Eintr/ also matches hidden
// background modules like "Öffentlich (13 Einträge)" (website/docs), and DOM
// order then non-deterministically returns the wrong number (2026-07-15). We only
// ever read the count AFTER typing in Filtern, so the "X von Y" form is expected.
const gridCount = (page) => page.evaluate(() => {
  const ownText = (e) => { let t = ''; for (const n of e.childNodes) if (n.nodeType === 3) t += n.textContent; return t.trim() }
  for (const e of document.querySelectorAll('*')) {
    const m = ownText(e).match(/(?:Mitglieder|Alle Kontakte|Nicht-Mitglieder|Personen|Firmen)\s*\(\s*(\d+)\s+von\s+\d+\s+Eintr/i)
    if (m) return parseInt(m[1], 10)
  }
  return -1 // no filtered "X von Y" header found (filter not applied / unexpected view)
})
// Find the name-column cell whose text equals the contact's full name. Matches on
// textContent (the cell may split the name across child <span>s → ownText misses
// it) and is diacritic-insensitive (ClubDesk sometimes drops accents, e.g. wiedisync
// "Rachèle" vs ClubDesk "Rachele"). Returns a click point, {ambiguous:true} if two
// different rows carry the same full name (never guess), or null if not present.
const nameCell = (page, name) => page.evaluate((name) => {
  const strip = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
  const target = strip(name)
  const hits = []
  for (const e of document.querySelectorAll('*')) {
    const t = (e.textContent || '').trim()
    if (!t || t.length > 60 || strip(t) !== target) continue
    const r = e.getBoundingClientRect()
    if (r.width > 0 && r.height > 0 && r.top > 320 && r.top < 620 && r.left < 480) hits.push({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), area: r.width * r.height, top: Math.round(r.top) })
  }
  if (!hits.length) return null
  // Cluster hit tops into rows (grid rows are ~32px apart; a single row's nested
  // parent/child elements sit within ~15px). >1 cluster ⇒ the full name really
  // appears in two different rows (a genuine duplicate) → ambiguous, never guess.
  const tops = [...new Set(hits.map((h) => h.top))].sort((a, b) => a - b)
  let clusters = 1
  for (let i = 1; i < tops.length; i++) if (tops[i] - tops[i - 1] > 20) clusters++
  if (clusters > 1) return { ambiguous: true }
  const b = hits.sort((a, c) => a.area - c.area)[0]
  return { x: b.x, y: b.y }
}, name)

async function openKontakte(page) {
  await page.goto(START, { waitUntil: 'networkidle' })
  await page.fill('#userId', USER); await page.fill('#password', PASS)
  await Promise.all([page.waitForLoadState('networkidle').catch(() => {}), page.click('#submit')]); await sleep(3000)
  if (await page.locator('#password').count()) throw new Error('login failed — bad creds/blocked')
  const navBtn = await page.evaluate(() => {
    const b = [...document.querySelectorAll('div')].map((e) => ({ e, r: e.getBoundingClientRect() }))
      .filter(({ r }) => r.top > 40 && r.top < 120 && r.left < 320 && r.width > 20 && r.width < 70 && r.height > 20 && r.height < 70)
      .sort((a, c) => a.r.left - c.r.left)[1]
    return b ? { x: b.r.left + b.r.width / 2, y: b.r.top + b.r.height / 2 } : null
  })
  if (!navBtn) throw new Error('Kontakte toolbar button not found')
  await page.mouse.click(navBtn.x, navBtn.y)
  await page.getByText(/\(\d+\s*Eintr/).first().waitFor({ timeout: 20000 }); await sleep(1200)
  // Switch to "Alle Kontakte" so the grid spans members AND non-members —
  // ehemalige / Nicht-Mitglieder aren't in the default "Mitglieder" view but can
  // still be on a roster and need a group (2026-07-15).
  const ak = await page.evaluate(() => {
    const ownText = (e) => { let t = ''; for (const n of e.childNodes) if (n.nodeType === 3) t += n.textContent; return t.trim() }
    for (const e of document.querySelectorAll('*')) if (ownText(e) === 'Alle Kontakte') { const r = e.getBoundingClientRect(); if (r.left < 300 && r.width > 0) return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } }
    return null
  })
  if (ak) { await page.mouse.click(ak.x, ak.y); await sleep(1600) }
}

// Set the grid Filtern box reliably: focus the input via JS (coordinate clicks
// don't re-focus it after a dialog closes), clear it, type the name, then POLL
// for the filtered "Mitglieder (N von …)" header (renders async). Returns N, or
// -1 if the filtered header never appears. Selects the group's grouping so a
// name search spans all members.
// Filter by `filterStr` (the last name — robust: avoids first-name accent drift
// and multi-token order issues), then poll until the FULL name (`fullName`) appears
// as a unique row. Returns { cnt, nc } (nc = click point), { cnt, ambiguous } if the
// full name hits >1 row, or { cnt:-1 } on timeout.
async function setFilter(page, filterStr, fullName) {
  // Accent-strip the FILTER string: ClubDesk stores/filters some names without
  // diacritics (wiedisync "Krawczyński" vs ClubDesk "Krawczynski") so typing the
  // accented form matches nothing. nameCell already matches the full name
  // diacritic-insensitively.
  const orig = (filterStr || '').trim()
  const stripped = orig.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  const variants = orig === stripped ? [orig] : [orig, stripped]
  // Retry the whole clear+type up to 3×: right after a commit the grid can still be
  // saving/re-rendering, so the first attempt's type may not register → -1. A fresh
  // attempt (re-find box, re-type) after a settle recovers it (2026-07-15).
  for (let attempt = 0; attempt < 4; attempt++) {
    const box = await page.evaluate(() => {
      const i = [...document.querySelectorAll('input')].map((e) => ({ e, r: e.getBoundingClientRect() }))
        .filter(({ e, r }) => e.type !== 'hidden' && e.type !== 'password' && r.width > 60 && r.top > 230 && r.top < 320)
        .sort((a, b) => b.r.width - a.r.width)[0]
      return i ? { x: Math.round(i.r.left + i.r.width / 2), y: Math.round(i.r.top + i.r.height / 2) } : null
    })
    if (!box) { await sleep(700); continue }
    // Triple-click selects the box's existing text; Backspace clears it (a JS .focus
    // + Ctrl+A didn't reliably reset the GXT filter → stale reads, 2026-07-15).
    await page.mouse.click(box.x, box.y, { clickCount: 3 }); await sleep(180)
    await page.keyboard.press('Backspace'); await sleep(450)
    await page.keyboard.type(variants[attempt % variants.length], { delay: 40 })
    // Poll until the grid stabilises on the NEW filter and the full-name row appears
    // (not just any "von" count — the previous contact's count lingers a moment).
    for (let k = 0; k < 12; k++) {
      await sleep(300)
      const c = await gridCount(page)
      if (c >= 1) { const nc = await nameCell(page, fullName); if (nc) return nc.ambiguous ? { cnt: c, ambiguous: true } : { cnt: c, nc } }
    }
    await sleep(700) // grid not ready this attempt — settle, then retry the filter
  }
  return { cnt: -1 }
}

// Topmost data-row cell in the name column (leftmost). After a UNIQUE filter (uuid)
// the grid has one row; select it WITHOUT matching the name (which can drift, e.g.
// worklist "Berke" vs ClubDesk "Berke-Wenger").
const firstRowCell = (page) => page.evaluate(() => {
  const cells = []
  for (const e of document.querySelectorAll('*')) {
    const t = (e.textContent || '').trim(); if (!t || t.length > 50) continue
    const r = e.getBoundingClientRect()
    if (r.width > 20 && r.height > 6 && r.top > 320 && r.top < 400 && r.left > 275 && r.left < 465) cells.push({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), area: r.width * r.height, top: Math.round(r.top) })
  }
  if (!cells.length) return null
  const minTop = Math.min(...cells.map((c) => c.top))
  const row = cells.filter((c) => c.top - minTop < 15).sort((a, b) => a.area - b.area)[0]
  return { x: row.x, y: row.y }
})

// Identify a contact by its Wiedisync ID (uuid) — unique, drift/accent-proof, and
// resolves non-members in "Alle Kontakte" (the clubdesk [Id] is NOT filterable;
// the uuid custom field IS — verified 2026-07-15). Returns { cnt:1, cell } on a hit.
/**
 * What the Filtern box currently holds. Same predicate as the box finder below, so
 * it reads the same element.
 *
 * ⚠⚠ This is the check that makes the count trustworthy. ClubDesk filters the grid
 * INCREMENTALLY and asynchronously, so between the first keystroke and the last the
 * header legitimately reports large numbers — and its filter is a substring match
 * across every column, so a single leading digit matches almost the whole register.
 * Reading the count before the box holds the full uuid does not read a filtered
 * grid, it reads a differently-filtered one.
 */
const filterValue = (page) => page.evaluate(() => {
  const i = [...document.querySelectorAll('input')].map((e) => ({ e, r: e.getBoundingClientRect() }))
    .filter(({ e, r }) => e.type !== 'hidden' && e.type !== 'password' && r.width > 60 && r.top > 230 && r.top < 320)
    .sort((a, b) => b.r.width - a.r.width)[0]
  return i ? i.e.value : null
})

/**
 * Filter the grid to ONE contact by its wiedisync uuid and return the cell to click.
 *
 * ⚠⚠ A count is only believed once (a) the box holds the whole uuid and (b) two
 * consecutive reads agree. The old loop returned on the FIRST reading above 1 —
 * "uuid must be unique, >1 is a data problem, don't guess" — which is right about a
 * settled grid and wrong about a settling one. Live case 08.09.2026: adding
 * "VB HU20 · Trainer*in" to Luca Zbinden skipped with `uuid did not resolve
 * (cnt=1161)` against 1162 contacts, and his contact carries the Wiedisync ID
 * perfectly well. 1161 is what ClubDesk shows for the filter `3` — the first
 * character of `37e646b5-…`, matched as a substring against every column of every
 * contact. The scraper had read the grid one keystroke into a 36-character uuid and
 * reported a data problem.
 *
 * ⚠ A settled 0 now returns 0 rather than falling through to -1 after four attempts:
 * "the uuid is not in ClubDesk" and "the grid never showed a filtered header" are
 * different faults and the first is the one that means somebody has to link a
 * contact.
 */
/**
 * Why a uuid filter came back with something other than one row. The three answers
 * need three different fixes and used to read as one number: 0 means the contact
 * carries no Wiedisync ID (somebody must link it, or a push has not been read back
 * yet), >1 means two contacts carry the same one (a data fault to resolve by hand,
 * never to guess at), -1 means the grid never showed a filtered header at all.
 */
const uuidMiss = (cnt) => (
  cnt === 0 ? 'not found in ClubDesk — the contact carries no Wiedisync ID'
    : cnt > 1 ? `${cnt} contacts carry this Wiedisync ID — resolve the duplicate in ClubDesk`
      : 'the contact grid never filtered — ClubDesk may be slow or the view changed'
)

async function selectRow(page, uuid) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const box = await page.evaluate(() => {
      const i = [...document.querySelectorAll('input')].map((e) => ({ e, r: e.getBoundingClientRect() }))
        .filter(({ e, r }) => e.type !== 'hidden' && e.type !== 'password' && r.width > 60 && r.top > 230 && r.top < 320)
        .sort((a, b) => b.r.width - a.r.width)[0]
      return i ? { x: Math.round(i.r.left + i.r.width / 2), y: Math.round(i.r.top + i.r.height / 2) } : null
    })
    if (!box) { await sleep(700); continue }
    await page.mouse.click(box.x, box.y, { clickCount: 3 }); await sleep(180)
    await page.keyboard.press('Backspace'); await sleep(450)
    await page.keyboard.type(uuid, { delay: 25 })
    // The box must hold the whole uuid before any count means anything. A partial
    // value is a keystroke that did not land — retype rather than read.
    let typed = false
    for (let k = 0; k < 10 && !typed; k++) {
      if ((await filterValue(page)) === uuid) typed = true
      else await sleep(200)
    }
    if (!typed) { await sleep(400); continue }
    let prev = null
    for (let k = 0; k < 14; k++) {
      await sleep(300)
      const c = await gridCount(page)
      if (c === 1) { const cell = await firstRowCell(page); if (cell) return { cnt: 1, cell }; prev = c; continue }
      // Stable across two reads = the grid has finished filtering. >1 is then a real
      // duplicate (never guess which), 0 is a contact that does not carry the id.
      if (c >= 0 && c === prev) return { cnt: c }
      prev = c
    }
    await sleep(600)
  }
  return { cnt: -1 }
}

// Read the dialog's "Kontakt" combo — the contact the group would be added to.
// EMPTY ("Pflichtfeld") means the grid selection was silently dropped, so OK stays
// disabled and a commit is a no-op; a name that isn't ours means the dialog is
// showing a STALE selection and a commit would group the WRONG person.
// Anchored on the "Kontakt:" label (not a y-band) so a taller dialog can't shift it.
// Returns the value, '' when empty, or null when the label isn't found (unknown).
const kontaktValue = (page) => page.evaluate(() => {
  const ownText = (e) => { let t = ''; for (const n of e.childNodes) if (n.nodeType === 3) t += n.textContent; return t.trim() }
  let lab = null
  for (const e of document.querySelectorAll('*')) {
    if (ownText(e) !== 'Kontakt:') continue
    const r = e.getBoundingClientRect(); if (r.width > 0 && r.height > 0) { lab = r; break }
  }
  if (!lab) return null
  const i = [...document.querySelectorAll('input')].map((e) => ({ e, r: e.getBoundingClientRect() }))
    .filter(({ e, r }) => e.type !== 'hidden' && r.width > 40 && r.left >= lab.right - 5 && Math.abs(r.top - lab.top) < 22)
    .sort((a, b) => a.r.left - b.r.left)[0]
  return i ? (i.e.value || '').trim() : null
})
// Does the dialog's Kontakt ("Nachname Vorname") plausibly refer to this worklist row?
// Diacritic-insensitive, token-wise, and deliberately lenient (ONE token is enough) —
// ClubDesk name drift is normal ("Berke-Wenger" vs "Berke"), while a stale dialog
// shows a completely different person and shares no token.
const kontaktMatches = (kontakt, full) => {
  const strip = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  const k = strip(kontakt)
  return strip(full).split(/\s+/).filter((t) => t.length > 2).some((t) => k.includes(t))
}

// Fill a GXT combobox: open its trigger, type value, click the exact-text option.
async function pickCombo(page, triggerX, triggerY, value) {
  await page.mouse.click(triggerX, triggerY); await sleep(500)
  // clear any pre-filled text, then type to filter
  await page.keyboard.press('Control+A').catch(() => {})
  await page.keyboard.type(value, { delay: 45 }); await sleep(900)
  const ok = await clickExact(page, value, 430, 950)
  await sleep(500)
  return ok
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
      step(done++, rows.length, `Adding groups — ${done} of ${rows.length}: ${row.name}`)
      const r = { name: row.name, group: row.group, funktion: row.funktion, clubdesk_id: row.clubdesk_id, status: 'error' }
      try {
        // 1) Identify the contact. ALWAYS prefer the Wiedisync ID (uuid) — unique,
        //    drift/accent-proof, resolves non-members in "Alle Kontakte". Fall back
        //    to name only when a row carries no uuid.
        const resolveCell = async () => {
          if (row.uuid) {
            const f = await selectRow(page, row.uuid)
            if (f.cnt !== 1 || !f.cell) return { skip: 'skip_filter_failed', matched: f.cnt, msg: uuidMiss(f.cnt) }
            return { cell: f.cell }
          }
          const f = await setFilter(page, row.last || row.name.split(' ')[0], row.name)
          if (f.ambiguous) return { skip: 'skip_ambiguous', matched: f.cnt, msg: 'ambiguous (duplicate full name)' }
          if (f.cnt < 1 || !f.nc) return { skip: 'skip_filter_failed', msg: 'filter did not resolve' }
          return { cell: f.nc }
        }

        // 2+3) Select the row, then Gruppen ▼ → "Kontakt zu Gruppe hinzufügen",
        //      and RE-TRY the pair until the dialog names our contact.
        //      Why: on every row AFTER the first, the click that should select the
        //      grid row only restores focus to the grid (same class of bug as
        //      setFilter's re-focus note) — the dialog then opens with an EMPTY
        //      "Kontakt" ("Pflichtfeld") and a permanently disabled OK, i.e. the run
        //      silently assigned nothing beyond row 1 (2026-07-27). The stale-dialog
        //      variant is worse: it would file the group under the PREVIOUS contact,
        //      so the name is verified, not just the presence of a value.
        let dialogReady = false, hardSkip = false
        for (let att = 0; att < 3 && !dialogReady && !hardSkip; att++) {
          const rc = await resolveCell()
          if (rc.skip) { r.status = rc.skip; if (rc.matched !== undefined) r.matched = rc.matched; r.detail = rc.msg; hardSkip = true; break }
          await page.mouse.click(rc.cell.x, rc.cell.y); await sleep(700)
          const gr = await page.evaluate(() => {
            const ownText = (e) => { let t = ''; for (const n of e.childNodes) if (n.nodeType === 3) t += n.textContent; return t.trim() }
            for (const e of document.querySelectorAll('*')) if (ownText(e) === 'Gruppen') { const b = e.getBoundingClientRect(); if (b.top < 260 && b.width > 0) return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) } }
            return { x: 380, y: 221 }
          })
          await page.mouse.click(gr.x, gr.y); await sleep(700)
          if (!(await clickExact(page, 'Kontakt zu Gruppe hinzufügen'))) { r.detail = 'menu item not found'; await page.keyboard.press('Escape'); await sleep(600); continue }
          await sleep(1200)
          // dialog open? (OK + Abbrechen present)
          const hasDialog = await page.evaluate(() => {
            const ownText = (e) => { let t = ''; for (const n of e.childNodes) if (n.nodeType === 3) t += n.textContent; return t.trim() }
            let ok = false, ab = false
            for (const e of document.querySelectorAll('*')) { const t = ownText(e); if (t === 'OK') ok = true; if (t === 'Abbrechen') ab = true }
            return ok && ab
          })
          if (!hasDialog) { r.detail = 'dialog did not open'; await page.keyboard.press('Escape'); await sleep(600); continue }
          // Whose contact does the dialog think this is? null = label not found
          // (older/other layout) → can't verify, fall through to the okEnabled gate.
          const kontakt = await kontaktValue(page)
          if (kontakt !== null && (!kontakt || !kontaktMatches(kontakt, row.name))) {
            r.detail = kontakt ? `dialog showed "${kontakt}"` : 'row selection lost (Kontakt empty)'
            log(`· ${row.name}: ${r.detail} — reselecting (attempt ${att + 1}/3)`)
            await clickExact(page, 'Abbrechen'); await sleep(1200); continue
          }
          if (kontakt) r.kontakt = kontakt
          r.detail = undefined; dialogReady = true
        }
        if (!dialogReady) {
          if (!hardSkip) r.status = 'skip_no_selection'
          results.push(r); log(`· ${row.name}: ${r.detail || 'dialog not ready'}`); continue
        }

        // 4) Gruppe combo (trigger ~903,441), then Funktion combo (~903,472).
        const gotGroup = await pickCombo(page, 903, 441, row.group)
        if (!gotGroup) { r.status = 'skip_group_not_found'; results.push(r); log(`· ${row.name}: group "${row.group}" not found`); await clickExact(page, 'Abbrechen'); await sleep(600); continue }
        // Funktion is optional — official groups (Schreiber*innen/Schiedsrichter)
        // carry no funktion; only pick it when the worklist row specifies one.
        if (row.funktion) {
          const gotFunk = await pickCombo(page, 903, 472, row.funktion)
          if (!gotFunk) { r.status = 'skip_funktion_not_found'; results.push(r); log(`· ${row.name}: funktion "${row.funktion}" not found`); await clickExact(page, 'Abbrechen'); await sleep(600); continue }
        }
        // Is OK enabled? (an official group may or may not require a funktion —
        // record it so preview surfaces any group that can't commit without one.)
        r.okEnabled = await page.evaluate(() => {
          const ownText = (e) => { let t = ''; for (const n of e.childNodes) if (n.nodeType === 3) t += n.textContent; return t.trim() }
          for (const e of document.querySelectorAll('*')) {
            if (ownText(e) !== 'OK') continue
            let el = e
            for (let i = 0; i < 4 && el; i++) { const cs = getComputedStyle(el); if (el.getAttribute('aria-disabled') === 'true' || /disabl/i.test(el.className || '') || parseFloat(cs.opacity) < 0.6) return false; el = el.parentElement }
            return true
          }
          return false
        })
        await shot(page, `${(row.clubdesk_id || row.name).toString().replace(/\W+/g, '_')}`)

        // 5) preview → Abbrechen; commit → OK.
        if (MODE === 'commit') {
          // A disabled OK never commits (clicking it is a no-op that leaves the
          // dialog open → cascades). Happens when ClubDesk refuses the combo, e.g.
          // assigning a player 'Spieler*in' role to a "Kein Mitglied" contact — a
          // non-member can't be a team player. Skip, don't false-report "assigned".
          if (r.okEnabled === false) { r.status = 'skip_ok_disabled'; results.push(r); log(`· ${row.name}: OK disabled (non-member player role? make them a member in ClubDesk)`); await clickExact(page, 'Abbrechen'); await sleep(600); continue }
          if (!(await clickExact(page, 'OK', 500))) { r.status = 'error'; r.detail = 'OK not clickable'; results.push(r); await clickExact(page, 'Abbrechen'); continue }
          // Longer settle after a WRITE — ClubDesk saves + re-renders the grid; a
          // short wait left the next filter racing an unready grid (32% skips,
          // 2026-07-15). setFilter's retry loop is the backstop; this reduces how
          // often it's needed.
          await sleep(2600)
          await page.keyboard.press('Escape').catch(() => {}) // dismiss any post-commit toast/confirm
          await sleep(300)
          r.status = 'assigned'; log(`✓ ${row.name} → ${row.group} (${row.funktion})`)
        } else {
          await clickExact(page, 'Abbrechen'); await sleep(800)
          r.status = 'previewed'; log(`◦ ${row.name} → ${row.group} (${row.funktion}) [preview OK]`)
        }
        results.push(r)
      } catch (e) {
        r.status = 'error'; r.detail = e.message; results.push(r); log(`✗ ${row.name}:`, e.message)
        // try to recover to grid for the next row
        for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape').catch(() => {}); await sleep(300) }
      }
    }
  } catch (e) {
    log('✗ fatal:', e.message); process.exitCode = 1
  } finally { await browser.close() }
  const summary = { mode: MODE, count: rows.length, results }
  const tally = {}; for (const r of results) tally[r.status] = (tally[r.status] || 0) + 1
  summary.tally = tally
  process.stdout.write(JSON.stringify(summary) + '\n')
}
run()
