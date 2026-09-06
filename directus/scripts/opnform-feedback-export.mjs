#!/usr/bin/env node
/**
 * Merge the EN and DE scorer-course feedback forms into ONE table / CSV.
 *
 * WHY THIS EXISTS
 * ---------------
 * A form can only be in one language, so bilingual feedback means two OpnForm
 * forms — and OpnForm has no cross-form view or export. Read separately, the two
 * halves are two small unrepresentative samples; read together they are one
 * dataset. This is the "together" half.
 *
 * WHAT MAKES THE MERGE SOUND
 * --------------------------
 * The DE form was created as a translated copy that REUSES the EN form's field
 * UUIDs, so a submission from either side is the same record shape under the same
 * keys. That is a real invariant and this script refuses to run if it ever
 * breaks (`assertSameShape`) rather than silently emitting a misaligned CSV —
 * a column that quietly holds two different questions is worse than no export.
 *
 * ⚠ Answers still differ by language even when the keys match: an OpnForm select
 * stores the option NAME, so the same click is "Yes" on one form and "Ja" on the
 * other. Those are folded back to the EN wording via the option `id`, which the
 * translation left untouched — never by a hardcoded word list, so it keeps
 * working when someone rewords an option in the builder.
 *
 * Headers are the EN form's labels, in the EN form's field order. Per the
 * repo-wide convention every export is English regardless of who runs it.
 *
 * Usage:
 *   OPNFORM_PAT=… node directus/scripts/opnform-feedback-export.mjs [out.csv]
 *                        [--forms en-slug,de-slug] [--json]
 *
 * Credentials: the PAT is not in the vault — it lives only on the Directus
 * containers, so the usual invocation is
 *   OPNFORM_PAT=$(ssh hetzner "sudo docker exec directus-kscw printenv OPNFORM_PAT") \
 *     node directus/scripts/opnform-feedback-export.mjs feedback.csv
 */
import { writeFileSync } from 'node:fs'

const BASE = (process.env.OPNFORM_BASE_URL || 'https://forms.kscw.ch').replace(/\/$/, '')

// The EN form is listed first: it is the canonical column order and labels.
const DEFAULT_FORMS = ['feedback-course-en', 'feedback-course-de']

// nf-text is a layout block — it renders copy and collects no answer.
const NON_ANSWER_TYPES = new Set(['nf-text', 'nf-page-break', 'nf-divider', 'nf-image', 'nf-code'])

export function parseArgs(argv) {
  const out = { file: null, json: false, forms: DEFAULT_FORMS }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') out.json = true
    else if (a === '--forms') out.forms = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean)
    else if (!a.startsWith('--')) out.file = a
  }
  if (out.forms.length < 2) throw new Error('--forms needs at least two slugs (canonical first)')
  return out
}

async function opnform(path, token) {
  const res = await fetch(`${BASE}/api/open${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  const text = await res.text()
  if (!res.ok) {
    // ⚠ A PAT hitting a route that is not in OpnForm's config/sanctum-routes.php
    // allowlist gets a 404 with an EMPTY message — not a 403, and not a missing
    // form. Say so, or this reads as "the form is gone".
    const hint = res.status === 404 && /"message"\s*:\s*""/.test(text)
      ? ' (empty-message 404 — route not in OpnForm\'s Sanctum allowlist, not a missing form)'
      : ''
    throw new Error(`OpnForm ${res.status} on ${path}${hint} :: ${text.slice(0, 200)}`)
  }
  const j = text ? JSON.parse(text) : {}
  return j.data ?? j
}

/**
 * The merge invariant. Same answer fields, same ids, same order, same types —
 * anything else means the two forms have drifted apart in the builder and their
 * rows can no longer share a table.
 */
export function assertSameShape(forms) {
  const [canonical, ...rest] = forms
  const shape = (f) => f.fields.map((p) => `${p.id}:${p.type}`).join('|')
  for (const other of rest) {
    if (shape(other) === shape(canonical)) continue
    const a = new Set(canonical.fields.map((p) => p.id))
    const b = new Set(other.fields.map((p) => p.id))
    const missing = canonical.fields.filter((p) => !b.has(p.id)).map((p) => p.name)
    const extra = other.fields.filter((p) => !a.has(p.id)).map((p) => p.name)
    throw new Error(
      `"${other.slug}" no longer matches "${canonical.slug}", so they cannot share one table.\n` +
      (missing.length ? `  missing there: ${missing.join(', ')}\n` : '') +
      (extra.length ? `  only there:    ${extra.join(', ')}\n` : '') +
      (!missing.length && !extra.length ? '  same fields, but the type or order differs\n' : '') +
      '  Fix the forms in OpnForm (or re-run the translation) before exporting.',
    )
  }
}

/**
 * Map every localised option name back to the canonical form's wording, keyed by
 * field id → option name. Built by pairing options on their `id`, which the
 * translation does not touch.
 */
export function buildValueMap(forms) {
  const [canonical, ...rest] = forms
  const map = {}
  for (const field of canonical.fields) {
    const canonOpts = field.options
    if (!canonOpts?.length) continue
    const byId = new Map(canonOpts.map((o) => [o.id, o.name]))
    for (const other of rest) {
      const opts = other.fields.find((p) => p.id === field.id)?.options ?? []
      for (const o of opts) {
        const canonName = byId.get(o.id)
        if (canonName && canonName !== o.name) (map[field.id] ??= {})[o.name] = canonName
      }
    }
  }
  return map
}

export function normalizeValue(value, fieldId, valueMap) {
  const m = valueMap[fieldId]
  const one = (v) => (m && typeof v === 'string' && m[v] !== undefined ? m[v] : v)
  if (Array.isArray(value)) return value.map(one).join(', ')
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(one(value))
}

/** Swiss format everywhere, per the repo convention: dd.mm.yyyy HH:MM, 24h. */
export function formatZurich(iso) {
  if (!iso) return ''
  const d = new Date(iso.includes('T') || iso.includes('Z') ? iso : iso.replace(' ', 'T') + 'Z')
  if (Number.isNaN(d.getTime())) return String(iso)
  const p = new Intl.DateTimeFormat('de-CH', {
    timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce((o, x) => (o[x.type] = x.value, o), {})
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`
}

export function toCsv(headers, rows) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'
}

async function loadForm(slug, token) {
  const form = await opnform(`/forms/${encodeURIComponent(slug)}`, token)
  const fields = (form.properties || [])
    .filter((p) => !NON_ANSWER_TYPES.has(p.type))
    .map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      options: p.select?.options ?? p.multi_select?.options ?? null,
    }))

  const rows = []
  for (let page = 1; ; page++) {
    const res = await opnform(`/forms/${encodeURIComponent(slug)}/submissions?per_page=100&page=${page}`, token)
    const batch = Array.isArray(res) ? res : (res.data ?? [])
    rows.push(...batch)
    const last = Number(res?.meta?.last_page ?? 1)
    if (Array.isArray(res) || page >= last || batch.length === 0) break
  }
  return { slug, id: form.id, language: (form.language || '').toUpperCase() || slug, fields, rows }
}

export async function buildExport(slugs, token) {
  const forms = []
  for (const slug of slugs) forms.push(await loadForm(slug, token))
  assertSameShape(forms)
  const valueMap = buildValueMap(forms)
  const [canonical] = forms

  const headers = ['Submitted at', 'Language', 'Form', 'Submission ID', ...canonical.fields.map((f) => f.name)]
  const rows = []
  for (const form of forms) {
    for (const sub of form.rows) {
      const data = sub.data ?? sub
      rows.push([
        formatZurich(sub.created_at ?? data.created_at),
        form.language,
        form.slug,
        sub.id ?? sub.public_id ?? '',
        ...canonical.fields.map((f) => normalizeValue(data[f.id], f.id, valueMap)),
      ])
    }
  }
  // One chronological table, not two forms stapled together.
  rows.sort((a, b) => {
    const key = (s) => String(s).replace(/(\d\d)\.(\d\d)\.(\d{4})/, '$3-$2-$1')
    return key(a[0]).localeCompare(key(b[0]))
  })
  return { headers, rows, forms: forms.map((f) => ({ slug: f.slug, language: f.language, count: f.rows.length })) }
}

async function main() {
  const token = process.env.OPNFORM_PAT
  if (!token) {
    console.error('OPNFORM_PAT is not set. It lives on the Directus containers, not in the vault:\n' +
      '  OPNFORM_PAT=$(ssh hetzner "sudo docker exec directus-kscw printenv OPNFORM_PAT") \\\n' +
      '    node directus/scripts/opnform-feedback-export.mjs feedback.csv')
    process.exit(1)
  }
  const { file, json, forms } = parseArgs(process.argv.slice(2))
  const result = await buildExport(forms, token)

  for (const f of result.forms) console.error(`  ${f.slug.padEnd(28)} ${f.language}  ${f.count} submission(s)`)
  console.error(`  → ${result.rows.length} row(s), ${result.headers.length} column(s)`)

  const out = json
    ? JSON.stringify(result.rows.map((r) => Object.fromEntries(r.map((v, i) => [result.headers[i], v]))), null, 2)
    : toCsv(result.headers, result.rows)
  if (file) { writeFileSync(file, out, 'utf8'); console.error(`  written to ${file}`) } else { process.stdout.write(out) }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
}
