/**
 * KSCW Directus 11 Hybrid Permission Setup
 *
 * SOURCE OF TRUTH (read this before editing):
 *   THIS FILE is the single source of truth for permissions on dev and prod.
 *   It is declarative and idempotent — `clearPolicyPermissions` then recreate —
 *   and `npm run db:setup-perms:dev|prod` reconciles the live instance to it on
 *   every deploy. A permission that is not in this file does not survive.
 *
 *   The numbered SQL migrations in `directus/scripts/0NN-*.sql` are SCHEMA-ONLY:
 *   DDL, triggers, RLS, grants, FKs, backfills. Never write a permission row in
 *   one — the next deploy reverts it, silently.
 *
 *   When you change permissions, in ONE commit:
 *     1. Edit this file.
 *     2. Update the matching row in PERMISSIONS.md.
 *     3. Append to SECURITY.md when it closes or accepts a risk.
 *   Then run `db:setup-perms` on dev and prod.
 *
 * ⚠ This header used to say the exact opposite — that migrations were
 * authoritative and this file was a fresh-install snapshot to be updated
 * afterwards. That block was ADDED by the very commit that abolished the model
 * (19804429), and its "reflects state through migration 043 (2026-05-06)"
 * anchor was 255 migrations stale by the time it was corrected on 2026-08-10
 * (audit 2026-08-08, finding 31). A reader following it would have written a
 * permission migration that the next deploy reverted — a gotcha SECURITY.md
 * records as having actually bitten. Audit history:
 *   023 messaging RBAC scoping        024 PII fields off cross-member read
 *   025 feedback status lock          026 coach team-scoped writes
 *   027 sport admin delete lock       028 auto-action markers
 *   029 messaging self-read fields    030 members.read field gaps
 *   031 spielplaner_assignments       032 trainings team-scoping
 *   033 member-read team-scoping      034 spielplaner_assignments.read
 *   035 second-pass audit             036 third-pass audit
 *   037 junction cascade pass 2       038-039 absence override
 *   040 excluded_guest_levels         041 team-dashboard prefs
 *   042 blocks + spielplaner perms    043 security hardening pass
 *
 * Directus 11 model: Roles → Policies → Permissions
 *   1. Ensure roles exist (rename old names if needed)
 *   2. Create/find access policies (one per role tier)
 *   3. Attach policies to roles — AND prune every role-level attachment this
 *      file does not declare (§3b reconcile, see DECLARED_ROLE_POLICIES)
 *   4. Create permissions on each policy
 *
 * Roles: Administrator, Superuser (admin_access), Sport Admin, Vorstand, Team Responsible, Member, Public
 *
 * Usage:
 *   DIRECTUS_URL=https://directus-dev.kscw.ch ADMIN_EMAIL=admin@kscw.ch ADMIN_PASSWORD=<password> node directus/scripts/setup-permissions.mjs
 *   # Or with static token:
 *   DIRECTUS_URL=https://directus-dev.kscw.ch DIRECTUS_TOKEN=<token> node directus/scripts/setup-permissions.mjs
 *   # Report what the §3b reconcile WOULD delete, and delete nothing:
 *   DIRECTUS_URL=… node directus/scripts/setup-permissions.mjs --reconcile-dry-run
 */

// Auto-load .env.local (gitignored) so callers can keep dev/prod tokens
// out of the npm script string. Resolution order for the token:
//   1. DIRECTUS_TOKEN (explicit override)
//   2. DIRECTUS_DEV_TOKEN  (used when DIRECTUS_URL points at dev)
//   3. DIRECTUS_PROD_TOKEN (used when DIRECTUS_URL points at prod)
//   4. ADMIN_EMAIL + ADMIN_PASSWORD (fallback — login to obtain a token)
import { readFileSync as _readFileSync } from 'node:fs'
import { fileURLToPath as _fileURLToPath } from 'node:url'
import { dirname as _dirname, join as _join } from 'node:path'
const _here = _dirname(_fileURLToPath(import.meta.url))
try {
  const envText = _readFileSync(_join(_here, '../../.env.local'), 'utf-8')
  for (const line of envText.split('\n')) {
    // Accept optional `export ` prefix + whitespace around `=` so shell-style
    // .env files (`export DIRECTUS_DEV_TOKEN=…`) load correctly, not just bare KEY=value.
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/)
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '')
  }
} catch { /* file missing — fine */ }

const DIRECTUS_URL = process.env.DIRECTUS_URL || 'http://localhost:8055'
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@kscw.ch'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''
const ADMIN_PASSWORD_CLEAN = ADMIN_PASSWORD.replace(/\\!/g, '!')
const STATIC_TOKEN = process.env.DIRECTUS_TOKEN
  || (DIRECTUS_URL.includes('directus-dev') ? process.env.DIRECTUS_DEV_TOKEN : '')
  || (DIRECTUS_URL.includes('directus.kscw.ch') ? process.env.DIRECTUS_PROD_TOKEN : '')
  || ''
if (!STATIC_TOKEN && !ADMIN_PASSWORD) {
  console.error('Need DIRECTUS_TOKEN, DIRECTUS_DEV_TOKEN, DIRECTUS_PROD_TOKEN, or ADMIN_PASSWORD to authenticate')
  process.exit(1)
}

// ── §3b reconcile knobs ─────────────────────────────────────────────────────
// The reconcile DELETES live permission grants, so it gets a report-only mode
// (`--dry-run` is the convention of the other scripts in this directory) and a
// blast-radius cap. Neither affects any other section of the script.
const RECONCILE_DRY_RUN = process.argv.includes('--reconcile-dry-run')
  || process.env.RECONCILE_DRY_RUN === '1'
// Max UNDECLARED role→policy rows §3b will revoke in one run. Duplicate rows of
// a DECLARED pair are exempt (a dedup always keeps one row, so it can never
// revoke anything). A run that wants to revoke more than this is a policy
// rename or a bug, not a hardening — it reports and skips instead.
const RECONCILE_MAX_DELETES = Number(process.env.RECONCILE_MAX_DELETES || 25)

let token = null
let stats = { ok: 0, err: 0 }

async function auth() {
  if (STATIC_TOKEN) {
    token = STATIC_TOKEN
    // Verify token works
    const res = await fetch(`${DIRECTUS_URL}/server/info`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) return
    console.log('  Static token invalid, falling back to password auth...')
  }
  const res = await fetch(`${DIRECTUS_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD_CLEAN }),
  })
  if (!res.ok) {
    throw new Error(`Auth failed: ${res.status} — check ADMIN_EMAIL and ADMIN_PASSWORD`)
  }
  const { data } = await res.json()
  token = data.access_token
}

async function api(method, path, body) {
  const res = await fetch(`${DIRECTUS_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  if (!res.ok) {
    if (text.includes('already exists') || text.includes('RECORD_NOT_UNIQUE')) return null
    throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`)
  }
  return text ? JSON.parse(text).data : null
}

// ── Role Definitions ───��─────────────────────────────────────────

const ROLE_DEFS = [
  { name: 'Administrator', icon: 'shield', description: 'Built-in Directus admin' },
  { name: 'Superuser', icon: 'security', description: 'Full system access (superuser + admin members)' },
  { name: 'Sport Admin', icon: 'sports', description: 'Sport-scoped admin (vb_admin / bb_admin)' },
  { name: 'Vorstand', icon: 'groups', description: 'Board member — read-all access' },
  { name: 'Team Responsible', icon: 'supervisor_account', description: 'Coach or team responsible' },
  { name: 'Member', icon: 'person', description: 'Default authenticated member' },
]

// Old role names → new names
const RENAME_MAP = { Coach: 'Team Responsible', 'Team Responsible': 'Team Responsible', Admin: 'Sport Admin' }

async function ensureRoles() {
  const existing = await api('GET', '/roles?limit=-1')

  for (const def of ROLE_DEFS) {
    const match = existing.find(r => r.name === def.name)
    if (match) {
      await api('PATCH', `/roles/${match.id}`, { icon: def.icon, description: def.description })
      console.log(`  ✓ "${def.name}" exists (${match.id})`)
    } else {
      const oldName = Object.entries(RENAME_MAP).find(([, v]) => v === def.name)?.[0]
      const oldMatch = oldName ? existing.find(r => r.name === oldName) : null
      if (oldMatch) {
        await api('PATCH', `/roles/${oldMatch.id}`, def)
        console.log(`  ✓ "${oldName}" → "${def.name}" (${oldMatch.id})`)
      } else {
        const created = await api('POST', '/roles', def)
        console.log(`  ��� "${def.name}" created (${created.id})`)
      }
    }
  }

  // Return fresh role map
  const roles = await api('GET', '/roles?limit=-1')
  return Object.fromEntries(roles.map(r => [r.name, r.id]))
}

// ── Policy Helpers ──────────���────────────────────────────────────

async function findOrCreatePolicy(name, opts = {}) {
  const existing = await api('GET', '/policies?limit=-1')
  const found = existing.find(p => p.name === name)
  if (found) return found.id

  const policy = await api('POST', '/policies', {
    name,
    icon: opts.icon || 'shield',
    admin_access: opts.admin_access || false,
    app_access: opts.app_access !== false,
  })
  return policy.id
}

async function attachPolicyToRole(roleId, policyId) {
  try {
    // Idempotent: directus_access has no unique (role,policy) constraint, so a
    // bare POST every run accreted duplicate role-access rows. Skip if present.
    const existing = await api('GET', `/access?filter[role][_eq]=${roleId}&filter[policy][_eq]=${policyId}&filter[user][_null]=true&fields=id&limit=1`)
    if (existing && existing.length > 0) return
    await api('POST', '/access', { role: roleId, policy: policyId })
  } catch (e) {
    if (!e.message.includes('RECORD_NOT_UNIQUE')) {
      console.warn(`  ⚠ attach policy: ${e.message.slice(0, 80)}`)
    }
  }
}

/**
 * Roles this reconcile must NEVER prune. Directus attaches the built-in
 * `Administrator` policy to the Administrator role; deleting that row locks
 * every root user out of their own instance, and no amount of re-running this
 * script can put it back (it needs an admin token to write).
 */
const PROTECTED_ROLES = new Set(['Administrator'])

/**
 * §3b — reconcile ROLE-level policy attachments against the declared set.
 *
 * `attachPolicyToRole` only ever ADDS, so nothing ever pruned an attachment
 * made by hand in the Directus UI. Prod consequently carried a
 * `Sport Admin → KSCW Admin` row (admin_access = true, created 2026-03-29) that
 * silently made every vb_admin / bb_admin a full Directus superadmin, plus ~49
 * duplicate rows per (role, policy) accreted by pre-2026-06 runs of this script
 * (the dedup guard inside `attachPolicyToRole` came later and only stops NEW
 * duplicates). This pass makes section 3 declarative in BOTH directions:
 * `DECLARED_ROLE_POLICIES` is the whole truth, and anything else at role level
 * is deleted.
 *
 * Safety rails, in order of importance:
 *   1. USER-level rows are never touched (the query pins `user IS NULL`). Those
 *      are the orthogonal per-user policies — LEADER §10, TERMINPLANUNG §12,
 *      FINANCE §13, SPIELPLANER §14 — each of which already runs its own
 *      attach + stale-revoke reconcile. This pass would happily delete them all.
 *   2. The PUBLIC row is never touched. It has role IS NULL *and* user IS NULL,
 *      so a `user IS NULL` filter ALONE would delete the public policy
 *      attachment and take every anonymous read (website, iCal) down with it —
 *      hence `role _nnull` as well.
 *   3. PROTECTED_ROLES (Administrator) are skipped entirely — see above.
 *   4. Roles this script does not declare at all (e.g. the custom "Website
 *      Admin") are left alone and merely REPORTED. Pruning a role we don't
 *      model would be guessing.
 *   5. Undeclared revocations are capped at RECONCILE_MAX_DELETES.
 *   6. `--reconcile-dry-run` reports and deletes nothing.
 *
 * Logging: every revoked row is logged individually (role name → policy name +
 * access id); duplicate deletions are logged per (role, policy) pair with the
 * kept/deleted counts, because a full run drops ~430 of them.
 *
 * ⚠ Position: this runs INSIDE section 3, i.e. BEFORE the permission rebuild.
 * So the two Sport Admin users lose the admin_access bypass at this point in
 * the run and briefly share the same cleared-then-recreated policy window as
 * everyone else (see the §4 comment). Sub-second, and the script is idempotent
 * — if a later section throws, fix it and re-run.
 */
async function reconcileRoleAccess(declared, roleMap) {
  const roleNameById = Object.fromEntries(Object.entries(roleMap).map(([name, id]) => [id, name]))
  const policies = await api('GET', '/policies?limit=-1')
  const policyById = Object.fromEntries((policies || []).map(p => [p.id, p]))

  // Refuse to prune against an incomplete declaration — a missing role id here
  // would silently reclassify that role's legitimate rows as "undeclared".
  if (declared.length === 0 || declared.some(d => !d.roleId || !d.policyId)) {
    console.warn('  ⚠ Reconcile SKIPPED — the declared role→policy set is empty or has unresolved ids.')
    return
  }

  const declaredKeys = new Set(declared.map(d => `${d.roleId}|${d.policyId}`))
  const managedRoleIds = new Set(declared.map(d => d.roleId))
  const protectedRoleIds = new Set(
    Object.entries(roleMap).filter(([name]) => PROTECTED_ROLES.has(name)).map(([, id]) => id),
  )

  const rows = await api(
    'GET',
    '/access?filter[role][_nnull]=true&filter[user][_null]=true&fields=id,role,policy&limit=-1',
  ) || []

  // Group the role-level rows by (role, policy) so duplicates collapse.
  const groups = new Map()
  for (const r of rows) {
    const roleId = r.role && typeof r.role === 'object' ? r.role.id : r.role
    const policyId = r.policy && typeof r.policy === 'object' ? r.policy.id : r.policy
    if (!roleId || !policyId) continue
    const key = `${roleId}|${policyId}`
    const g = groups.get(key) || { roleId, policyId, ids: [] }
    g.ids.push(r.id)
    groups.set(key, g)
  }

  const label = (g) => {
    const admin = policyById[g.policyId]?.admin_access ? ' [admin_access]' : ''
    return `${roleNameById[g.roleId] || g.roleId} → ${policyById[g.policyId]?.name || g.policyId}${admin}`
  }

  const undeclared = []   // whole groups to revoke
  const dupeGroups = []   // declared/untouched pairs carrying repeat rows
  const untouched = []    // reported only

  for (const g of groups.values()) {
    const isDeclared = declaredKeys.has(`${g.roleId}|${g.policyId}`)
    const isProtected = protectedRoleIds.has(g.roleId)
    const isManaged = managedRoleIds.has(g.roleId)

    if (!isDeclared && !isProtected && isManaged) {
      undeclared.push(g)
      continue
    }
    if (!isDeclared) {
      untouched.push(`${label(g)} — ${isProtected ? 'protected role' : 'role not declared by this script'}, left as-is`)
    }
    // Keep the first row (sorted for determinism), drop the repeats.
    if (g.ids.length > 1) {
      const sorted = [...g.ids].sort()
      dupeGroups.push({ label: label(g), keep: sorted[0], drop: sorted.slice(1) })
    }
  }

  for (const line of untouched) console.log(`  · ${line}`)

  const undeclaredRows = undeclared.reduce((n, g) => n + g.ids.length, 0)
  if (undeclaredRows > RECONCILE_MAX_DELETES) {
    console.warn(`  ⚠ Reconcile: ${undeclaredRows} undeclared role→policy row(s) exceed RECONCILE_MAX_DELETES=${RECONCILE_MAX_DELETES} — NOTHING revoked.`)
    console.warn('    Review with --reconcile-dry-run, then raise the cap deliberately if the list is correct:')
    for (const g of undeclared) console.warn(`      would revoke: ${label(g)} (${g.ids.length} row(s))`)
  } else {
    for (const g of undeclared) {
      for (const id of g.ids) {
        if (RECONCILE_DRY_RUN) {
          console.log(`  [dry-run] would REVOKE ${label(g)} (access ${id})`)
          continue
        }
        try {
          await api('DELETE', `/access/${id}`)
          console.log(`  ✓ REVOKED undeclared role policy: ${label(g)} (access ${id})`)
        } catch (e) {
          console.warn(`  ⚠ revoke ${label(g)}: ${e.message.slice(0, 120)}`)
        }
      }
    }
  }

  let deduped = 0
  for (const g of dupeGroups) {
    if (RECONCILE_DRY_RUN) {
      console.log(`  [dry-run] would dedup ${g.label}: keep 1, delete ${g.drop.length} duplicate row(s)`)
      continue
    }
    let dropped = 0
    for (const id of g.drop) {
      try {
        await api('DELETE', `/access/${id}`)
        dropped++
      } catch (e) {
        console.warn(`  ⚠ dedup ${g.label}: ${e.message.slice(0, 120)}`)
      }
    }
    if (dropped > 0) console.log(`  ✓ Deduped ${g.label}: kept 1, deleted ${dropped} duplicate row(s)`)
    deduped += dropped
  }

  if (!RECONCILE_DRY_RUN && undeclaredRows === 0 && deduped === 0) {
    console.log('  ✓ Role→policy attachments already match the declared set')
  }
  if (RECONCILE_DRY_RUN) console.log('  (dry run — nothing was deleted)')
}

/**
 * Service accounts expected on the built-in `Administrator` role. These have no
 * `members` row, so the app-role check below cannot vouch for them.
 */
const SYSTEM_ADMIN_EMAILS = new Set(['admin@kscw.ch', 'cron-service@kscw.ch'])

/**
 * §3c — audit membership of the built-in `Administrator` role.
 *
 * §3b closed the role→POLICY blind spot. This closes the adjacent one:
 * `directus_users.role` itself. The only writer of that column in the tree is
 * `syncMemberRole` → `resolveDirectusRole` (kscw-hooks/src/index.js), which can
 * return at most Superuser | Sport Admin | Vorstand | Team Responsible | Member
 * — `Administrator` is unreachable by code. So every Administrator holder was
 * set by hand in the Directus UI, and nothing in `db:deploy`, `db:smoke` or any
 * PERMISSIONS.md verification query has ever looked at them. Prod carried an
 * ordinary member (`members.role = ["user"]`) on that role for months as a
 * result (audit 2026-08-08, finding 2).
 *
 * REPORT-ONLY, deliberately. This pass never writes:
 *   - Demoting an Administrator is a plausible lockout (the account doing the
 *     demoting may be the only other root), and unlike a policy row it cannot be
 *     restored by re-running this script.
 *   - The legitimate remedy is to set the person's `members.role` so
 *     `resolveDirectusRole` grants them `Superuser` declaratively, then drop the
 *     hand-set Administrator — a two-step a human should drive.
 * A holder is reported as EXPECTED when it is a known service account, or when
 * its linked member carries `superuser`/`admin` in `members.role` (i.e. the app
 * model already says this person is a root). Anything else is UNDECLARED and
 * printed loudly.
 */
async function auditAdministratorRole(roleMap) {
  const adminRoleId = roleMap['Administrator']
  if (!adminRoleId) {
    console.warn('  ⚠ No "Administrator" role found — skipping audit')
    return
  }

  const users = await api('GET', `/users?filter[role][_eq]=${adminRoleId}&fields=id,email,status,last_access&limit=-1`) || []
  if (users.length === 0) {
    console.warn('  ⚠ Administrator role has NO members — that is almost certainly wrong')
    return
  }

  // `_in` takes a bare comma-separated list. Passing a JSON array (`["a","b"]`)
  // makes Directus hand the whole literal to Postgres as ONE uuid and 500 —
  // which, before this pass was made non-fatal, halted the entire permission
  // deploy at §3c. Encode each id: they are uuids, but the encode is what makes
  // that an assumption the URL does not depend on.
  const ids = users.map(u => encodeURIComponent(u.id)).join(',')
  const members = await api('GET', `/items/members?filter[user][_in]=${ids}&fields=id,user,role&limit=-1`) || []
  const memberByUser = Object.fromEntries(members.map(m => [m.user, m]))

  const undeclared = []
  for (const u of users) {
    const m = memberByUser[u.id]
    const appRoles = Array.isArray(m?.role) ? m.role : []
    const isSystem = SYSTEM_ADMIN_EMAILS.has(String(u.email || '').toLowerCase())
    const isAppRoot = appRoles.includes('superuser') || appRoles.includes('admin')
    const who = m ? `member ${m.id}` : 'no member row'
    const seen = u.last_access ? String(u.last_access).slice(0, 10) : 'never'

    if (isSystem) {
      console.log(`  · ${u.email} — service account (last access ${seen})`)
    } else if (isAppRoot) {
      console.log(`  · ${u.email} — ${who}, app role [${appRoles.join(', ')}] (last access ${seen})`)
    } else {
      undeclared.push({ u, m, appRoles, who, seen })
    }
  }

  if (undeclared.length === 0) {
    console.log(`  ✓ All ${users.length} Administrator holder(s) accounted for`)
    return
  }

  console.warn(`  ⚠ ${undeclared.length} UNDECLARED Administrator holder(s) — full Directus root that no code path grants:`)
  for (const { u, appRoles, who, seen } of undeclared) {
    const app = appRoles.length ? `[${appRoles.join(', ')}]` : '[] (none)'
    console.warn(`      ${u.email} — ${who}, app role ${app}, status ${u.status}, last access ${seen}`)
  }
  console.warn('    Either raise their members.role so resolveDirectusRole grants Superuser')
  console.warn('    declaratively, or move them to the role their app tier implies. This pass')
  console.warn('    never demotes automatically — see the note above auditAdministratorRole().')
}

/**
 * Fully remove a legacy/orphan policy by name: detach it from every role/user
 * (directus_access), delete its permission rows, then delete the policy.
 * Idempotent — a no-op once the policy is gone. Used to retire the old
 * "KSCW Coach" policy after folding its unique grants into Team Responsible.
 */
async function deleteLegacyPolicy(name) {
  const policies = await api('GET', '/policies?limit=-1')
  const matches = (policies || []).filter(p => p.name === name)
  if (matches.length === 0) {
    console.log(`  (legacy policy "${name}" already absent — nothing to delete)`)
    return
  }
  for (const p of matches) {
    const access = await api('GET', `/access?filter[policy][_eq]=${p.id}&fields=id&limit=-1`)
    for (const a of (access || [])) await api('DELETE', `/access/${a.id}`)
    const perms = await api('GET', `/permissions?filter[policy][_eq]=${p.id}&fields=id&limit=-1`)
    for (const perm of (perms || [])) await api('DELETE', `/permissions/${perm.id}`)
    await api('DELETE', `/policies/${p.id}`)
    console.log(`  ✓ Deleted legacy policy "${name}" (${p.id}): ${(access || []).length} access row(s) + ${(perms || []).length} permission(s)`)
  }
}

// ── Permission Helpers ────────────��──────────────────────────────

async function setPerm(policyId, collection, action, filter = null, fields = null, validation = null) {
  const body = {
    policy: policyId,
    collection,
    action,
    fields: fields || ['*'],
  }
  if (filter) body.permissions = filter
  if (validation) body.validation = validation
  // NOTE: Directus enforces neither `permissions` nor a relational `validation`
  // filter usefully on CREATE — `permissions` has no existing row to match, and
  // a relational `validation` (e.g. member.user == $CURRENT_USER) can't be
  // resolved against the payload, so it rejects ALL creates (verified on dev
  // 2026-05-31). Self-scoped CREATE ownership is therefore enforced in the
  // kscw-hooks `*.items.create` filter guard, not here. The `permissions`
  // filter above still scopes READ/UPDATE/DELETE for these collections.
  // A SCALAR `validation` (e.g. source == manual) IS enforced against the
  // CREATE payload — pass it via the `validation` param (used by §9d).

  try {
    await api('POST', '/permissions', body)
    stats.ok++
  } catch (e) {
    if (e.message.includes('RECORD_NOT_UNIQUE')) {
      stats.ok++
    } else {
      console.error(`    ✗ ${collection}.${action}: ${e.message.slice(0, 120)}`)
      stats.err++
    }
  }
}

async function setPermRead(policyId, collection, filter = null, fields = null) {
  return setPerm(policyId, collection, 'read', filter, fields)
}

async function setPermCRUD(policyId, collection, filter = null) {
  await setPerm(policyId, collection, 'create', filter)
  await setPerm(policyId, collection, 'read', filter)
  await setPerm(policyId, collection, 'update', filter)
  await setPerm(policyId, collection, 'delete', filter)
}

/**
 * Delete all existing permissions for a policy (for idempotent re-runs)
 */
async function clearPolicyPermissions(policyId, policyName) {
  const perms = await api('GET', `/permissions?filter[policy][_eq]=${policyId}&limit=-1`)
  if (!perms || perms.length === 0) return
  for (const p of perms) {
    await api('DELETE', `/permissions/${p.id}`)
  }
  console.log(`  Cleared ${perms.length} old permissions from "${policyName}"`)
}

// ── Filter Shorthands ──────��─────────────────────────────────────

/** member.user = $CURRENT_USER */
const OWN_MEMBER = { member: { user: { _eq: '$CURRENT_USER' } } }

/** user = $CURRENT_USER (members table) */
const OWN_USER = { user: { _eq: '$CURRENT_USER' } }

/**
 * Announcements a non-admin may read: published, not expired, and addressed to
 * them. Shared verbatim by MEMBER_POLICY and LEADER_POLICY.
 *
 * The audience arm (migration 219) is the part worth understanding. `all` and
 * `sport` match on the row itself — the client narrows sport by primarySport,
 * and both audience_type and audience_sport are in the readable field list.
 * `teams` and `roles` cannot work that way: their targeting arrays are
 * deliberately NOT readable (see ANNOUNCEMENT_READ_FIELDS), so the client has
 * nothing to match itself against. They're gated instead on a materialized
 * announcement_recipients row written by the publish fanout in kscw-hooks.
 *
 * This does NOT hit the M2M-deep-filter trap in CLAUDE.md: that fires when a
 * frontend filter walks the same alias a policy filter walks. useAnnouncements
 * never walks `recipients` — it filters on published_at/expires_at/audience_type
 * only, so the junction is traversed exactly once, here.
 */
const ANNOUNCEMENT_VISIBLE = {
  _and: [
    { published_at: { _nnull: true } },
    { published_at: { _lte: '$NOW' } },
    { _or: [
      { expires_at: { _null: true } },
      { expires_at: { _gt: '$NOW' } },
    ] },
    { _or: [
      { audience_type: { _in: ['all', 'sport'] } },
      { recipients: OWN_MEMBER },
    ] },
  ],
}

/**
 * Readable announcement fields for non-admins. Intentionally excludes
 * audience_teams / audience_roles — exposing those arrays would reveal targeting
 * intent for posts that weren't meant to be widely visible. That exclusion is
 * exactly why ANNOUNCEMENT_VISIBLE has to gate teams/roles on the recipients
 * junction rather than on the row. Also excludes internal admin state
 * (notify_push, notify_email, fanout_sent_at, reply_to, email_layout).
 */
const ANNOUNCEMENT_READ_FIELDS = [
  'id', 'image', 'link', 'pinned',
  'published_at', 'expires_at',
  'audience_type', 'audience_sport',
  'translations', 'created_by',
  'date_created', 'date_updated',
]

/**
 * user_logs.user is an INTEGER FK to members.id, NOT a UUID FK to
 * directus_users. The naive `{ user: { _eq: '$CURRENT_USER' } }` filter
 * tries to compare an int to the caller's UUID and Postgres throws
 * "Invalid numeric value" (see CHANGELOG v4.4.8). The correct path
 * traverses one more level: user_logs → members → directus_users.
 */
const OWN_DU = { user: { user: { _eq: '$CURRENT_USER' } } }

/** from_member or to_member is current user */
const OWN_DELEGATION = {
  _or: [
    { from_member: { user: { _eq: '$CURRENT_USER' } } },
    { to_member: { user: { _eq: '$CURRENT_USER' } } },
  ],
}

/**
 * from_member is current user — used to scope scorer_delegations CREATE so a
 * member can only delegate their own duty (not fabricate a delegation FROM a
 * teammate). 2026-05-31 security audit.
 */
const OWN_DELEGATION_FROM = { from_member: { user: { _eq: '$CURRENT_USER' } } }

/**
 * Fields visible to regular members when reading OTHER members.
 * Migration 024 explicitly removed `email` + `phone` from this set — they
 * leak across the whole club. Self-read covers them via MEMBER_OWN_READABLE.
 * Migration 030 added `kscw_membership_active`, `shell`, `shell_expires`.
 */
const MEMBER_VISIBLE_FIELDS = [
  'id', 'first_name', 'last_name', 'nickname', 'photo', 'number',
  'position', 'user',
  // Per-flag licence booleans (migration 067; legacy `licences` json dropped in 119).
  'scorer_vb', 'referee_vb', 'otr1_bb', 'otr2_bb', 'otn1_bb', 'otn2_bb', 'referee_bb',
  // Coaching education (migration 274) — same tier as the licence booleans
  // above: a sporting credential, not PII. Club-wide readable so a coach's
  // qualification can show on their profile card and on team views.
  'trainer_licences',
  'coach_approved_team', 'role', 'language',
  'requested_team', 'birthdate_visibility', 'hide_phone', 'hide_email',
  'license_nr', 'sex', 'licence_category', 'licence_activated', 'licence_validated',
  'kscw_membership_active', 'shell', 'shell_expires',
  // 2026-07-13: `wiedisync_active` must be READABLE club-wide, not just by
  // finance. MemberMultiSelect (the event-invite picker in EventForm) queries
  // members *unfiltered* with `filter: { wiedisync_active: { _eq: true } }`, and
  // Directus rejects a filter on a field the caller cannot read. Because the
  // query is club-wide it resolves against MEMBER_POLICY (this list), not the
  // team-scoped LEADER read — so without it every coach/TR opening the event form
  // got a 403 and a silently EMPTY invite list. It is a plain activation boolean,
  // no PII. (Symptom: prod errors-*.jsonl "no permission to access field
  // wiedisync_active", /events, from 2026-07-12.)
  'wiedisync_active',
  // 2026-05-12: needed by /teams/* coach-approval queries (sort/filter on
  // date_created) and /absences (member_teams o2m used to scope absences).
  'date_created', 'member_teams',
]

/** Fields a member can update on their own profile */
const MEMBER_EDITABLE_FIELDS = [
  'first_name', 'last_name', 'nickname', 'phone', 'birthdate', 'email',
  'birthdate_visibility', 'hide_phone', 'hide_email', 'photo', 'language',
  'position', 'number', 'website_visible', 'website_name_private',
  // Per-flag licence booleans (migration 067; legacy `licences` json dropped in 119).
  'scorer_vb', 'referee_vb', 'otr1_bb', 'otr2_bb', 'otn1_bb', 'otn2_bb', 'referee_bb',
  // 2026-08-03 migration 274: coaching education (Trainerausbildung), an
  // ordered comma-separated subset of JS/C/B/A. Self-asserted like the licence
  // booleans — the club has no machine source for it (ClubDesk has no such
  // column; its "JS ID" is the J+S person number and maps to members.js_id).
  'trainer_licences',
  'requested_team',
  // ClubDesk personal data fields.
  // 2026-07-25 migrations 223/224: nationality became CODED. `nationalitaet_codes`
  // (ordered ISO alpha-2 list, first code primary) and `federation_of_origin`
  // (alpha-2 | 'NONE' | null) are the member-writable columns; the legacy
  // free-text `nationalitaet` is now DERIVED by a DB trigger for the ClubDesk
  // picklist, so it is deliberately NOT here — a member write would be silently
  // overwritten and drift the two apart in the meantime. It stays own-readable
  // via MEMBER_DERIVED_READ_FIELDS below.
  'anrede', 'adresse', 'plz', 'ort', 'nationalitaet_codes', 'federation_of_origin',
  'sex', 'ahv_nummer',
  // 2026-08-13 migration 315: which Zurich Kantonsschule the member attends.
  // Self-asserted BY DESIGN and self-service on purpose — ~681 of ~711 members
  // are blank because they joined before the signup form asked, and the only
  // realistic way to fill that in is the member answering for themselves.
  // ⚠ NOT a ClubDesk column (the register has no field for it), so unlike
  // `ahv_nummer` / `iban` above there is no push contract to reason about: this
  // one is wiedisync's outright. It rides MEMBER_EDITABLE_FIELDS into
  // MEMBER_OWN_READABLE, so the member can also SEE their own answer — without
  // that read grant Directus silently strips it from their own record and the
  // profile field renders permanently empty ([[useauth-member-field-perms]]).
  // Deliberately absent from MEMBER_VISIBLE_FIELDS + LEADER_TEAM_MEMBER_FIELDS:
  // which school somebody attends is not shown to other members or to coaches.
  'kantonsschule',
  // 2026-06-19 migration 117: member IBAN for reimbursements. Sensitive PII —
  // own-member editable/readable + admin only, like ahv_nummer. Deliberately
  // NOT in MEMBER_VISIBLE_FIELDS or LEADER_TEAM_MEMBER_FIELDS (which excludes
  // ahv_nummer too) — other members and coaches must never see it.
  'iban',
  // 2026-06-24 migration 136: member confirms their own (ClubDesk-backfilled) IBAN.
  'iban_confirmed',
  // 2026-06-01 migration 077: per-member auto-confirm RSVP opt-in (profile toggles)
  'auto_confirm_trainings', 'auto_confirm_games', 'auto_confirm_events',
  // 2026-06-26 migration 156: per-member notification opt-out (profile toggles).
  // Default-on flags; opt-out suppresses the email (or the form push) only —
  // enforced in the send paths, never the in-app notification bell.
  'email_notify_registrations', 'email_notify_join_requests',
  'email_notify_form_submissions', 'email_notify_announcements', 'email_notify_events',
  // 2026-08-01 migration 270: the member's own "I checked, my data is correct"
  // stamp for the annual pre-licence data check. Self-asserted BY DESIGN — the
  // fact being recorded is "this person looked at their record and said yes",
  // which only they can assert. Without the write grant Directus silently drops
  // the field from their save and the gate reappears on every login.
  'profile_verified_at',
]

/**
 * Trigger-derived member columns: READABLE on the same rows as the editable
 * set, but never WRITABLE. Kept as its own list so removing a column from
 * MEMBER_EDITABLE_FIELDS (because the DB now owns it) does not silently drop it
 * from own-read / leader-read as well.
 *
 * `nationalitaet` (migration 223) — the German ClubDesk display name mirrored
 * from the first entry of `nationalitaet_codes`. Deliberately NOT added to
 * MEMBER_VISIBLE_FIELDS: that list is what EVERY member reads about EVERY other
 * member, and nationality sits in the same PII tier as `adresse` / `birthdate`,
 * which are excluded from it by design (migration 024). It was never club-wide
 * readable and must not become so as a side effect of losing its write grant.
 */
const MEMBER_DERIVED_READ_FIELDS = [
  'nationalitaet',
  // Own-READ only. Migration 030 once hand-patched this onto the Member row; a
  // later clearPolicyPermissions wiped it and the declarative script never
  // re-added it, so 209 of 211 active members with a login have a fee category
  // and not one of them could see it — their profile rendered "—" while
  // migration 270's verification campaign asked them to CONFIRM that value
  // ("Greyed-out fields such as your fee category … can only be changed by the
  // club"). Audit 2026-08-08, finding 39.
  //
  // ⚠ Here and NOT in MEMBER_VISIBLE_FIELDS: that list is club-wide readable,
  // and one member's fee category is not another member's business. It is also
  // deliberately not in MEMBER_EDITABLE_FIELDS — the member is the subject of
  // this fact, not its author.
  'beitragskategorie',
  // Club register status + the dates that bracket it (migration 302). Own-READ
  // for the same reason as the fee category above: a member is entitled to know
  // whether the club still counts them as a member and since when, and the
  // profile shows it — but they are the subject of that fact, not its author,
  // so it is deliberately NOT in MEMBER_EDITABLE_FIELDS.
  //
  // ⚠ Here and NOT in MEMBER_VISIBLE_FIELDS: club-wide readable would publish
  // who is an Ehrenmitglied, who resigned and when, to all 700 members.
  'register_status', 'eintritt', 'austritt',
]

/**
 * Licence status (migration 301) — READ on your own row, WRITE never.
 *
 * This is the club's licence-ordering workflow: where a member's licence has
 * got to between "needs one" and "the federation confirmed it". The member is
 * the subject of the fact, not its author — exactly the split
 * MEMBER_STAFF_ONLY_FIELDS documents for the transfer workflow — so it is
 * own-READABLE (they are entitled to know where their own licence stands, and
 * the profile card shows it) but stays out of MEMBER_EDITABLE_FIELDS. A member
 * who could set their own status to `licenced` would be asserting the one fact
 * the club needs to be able to trust, and a coach fielding them on the strength
 * of it is how an unlicensed player reaches a match sheet.
 *
 * Its own list, not folded into MEMBER_DERIVED_READ_FIELDS: those are columns a
 * DB trigger owns. These are written by admins and by the sync, which is a
 * different reason to be read-only and would be lost if they shared a comment.
 *
 * NOT in MEMBER_VISIBLE_FIELDS and NOT unioned into LEADER_TEAM_MEMBER_FIELDS:
 * the three surfaces that were asked for are the Data Explorer, /admin/anmeldungen
 * (both AdminRoute-gated, and Sport Admin already holds `members` fields = '*')
 * and the member's own profile. Coaches and team responsibles are a defensible
 * FOURTH audience — a coach picking a squad has a real need to know who is not
 * licensed yet, and they already read `licence_activated` / `licence_validated`
 * club-wide — but adding them is a widening nobody requested, so it is left as a
 * one-line change (union this list into LEADER_TEAM_MEMBER_FIELDS) rather than
 * done by default.
 */
const MEMBER_LICENCE_STATUS_READ_FIELDS = [
  'licence_status', 'licence_status_season',
  'licence_status_updated_at', 'licence_status_by_name',
]

/**
 * STAFF-ONLY member columns — the international-transfer workflow (migrations
 * 234/235), written from `/admin/transfers`.
 *
 * These hold a staff judgement ABOUT a member, not the member's own data, so
 * they must NEVER join `MEMBER_VISIBLE_FIELDS` (what every member reads about
 * every OTHER member) or `MEMBER_EDITABLE_FIELDS` (own-profile write). The
 * second one matters most: an own-profile write would let a member mark their
 * own transfer done, which is precisely the fact the club needs to be able to
 * trust — and it is not a fact about them, it is a record of what an
 * administrator did. Note `MEMBER_OWN_READABLE` and `LEADER_TEAM_MEMBER_FIELDS`
 * are both DERIVED from those two lists, so staying out of them also keeps the
 * columns away from own-read and from coaches / team responsibles.
 *
 * No new grant is required for the page's audience: `/admin/transfers` is
 * AdminRoute-gated (admin | superuser | vb_admin | bb_admin) and **KSCW Sport
 * Admin already holds `members` read + update with fields = '*'** (section 9),
 * while full admins bypass policies entirely — so the gate and the grant line up
 * exactly and nobody can reach the page with toggles that would 403. Vorstand
 * reads `members` unfiltered (a board member can SEE these) but deliberately
 * carries no `members.update` row at all; the board is not on this page's gate
 * and gains no write here.
 *
 * The list exists so that invariant is CHECKED on every deploy rather than
 * merely asserted in a comment — see the guard immediately below.
 */
const MEMBER_STAFF_ONLY_FIELDS = [
  'transfer_status', 'transfer_done_at', 'transfer_done_by_name', 'transfer_note',
  // VIS presence (migration 240). Staff workflow data, not something a member
  // should see about themselves: `in_vis = false` mostly means our seeded guess
  // at their federation of origin was wrong, which reads as an accusation if
  // shown without that context.
  'in_vis', 'in_vis_checked_at', 'vis_player_no',
  // The hand-set link and the sweep's confirmation of it (migration 312). The
  // WRITE is the one that matters: a member who could set their own
  // `vis_player_no_manual` could assert their own presence in the FIVB index —
  // the exact fact the club exists to verify, and the gate on whether a
  // transfer can be requested for them at all.
  'vis_player_no_manual', 'vis_manual_vis_name',
]

// Fail the deploy loudly rather than silently widening a staff-only column into
// the club-wide read or the own-profile write. Cheap, and it turns "must not go
// in that list" from tribal knowledge into an enforced rule.
for (const field of MEMBER_STAFF_ONLY_FIELDS) {
  if (
    MEMBER_VISIBLE_FIELDS.includes(field) ||
    MEMBER_EDITABLE_FIELDS.includes(field) ||
    MEMBER_DERIVED_READ_FIELDS.includes(field)
  ) {
    throw new Error(
      `setup-permissions: members."${field}" is STAFF-ONLY (transfer workflow) and must not appear in ` +
      'MEMBER_VISIBLE_FIELDS / MEMBER_EDITABLE_FIELDS / MEMBER_DERIVED_READ_FIELDS.',
    )
  }
}

// Same shape of guard for the licence-status columns, and the one that matters
// is the WRITE: a member who could set their own `licence_status` to `licenced`
// would be self-asserting the fact the club exists to verify.
for (const field of MEMBER_LICENCE_STATUS_READ_FIELDS) {
  if (MEMBER_EDITABLE_FIELDS.includes(field) || MEMBER_VISIBLE_FIELDS.includes(field)) {
    throw new Error(
      `setup-permissions: members."${field}" is staff-written (licence workflow, migration 301). It is ` +
      'own-READABLE only and must not appear in MEMBER_EDITABLE_FIELDS or MEMBER_VISIBLE_FIELDS.',
    )
  }
}

/** Public fields for teams */
const PUBLIC_TEAM_FIELDS = [
  'id', 'name', 'full_name', 'sport', 'league', 'season', 'team_picture',
  'team_picture_pos', 'active', 'social_url', 'color', 'coach', 'captain',
  'team_responsible', 'sponsors',
  // Exposed so the kscw-website contact form can filter the team dropdown to
  // recruiting teams only. Boolean flag, no PII.
  'open_for_players',
  // Positions the team is recruiting for — shown next to the "Get in touch"
  // CTA on the public team page. Array of position keys, no PII.
  'recruiting_positions',
  // Full-team waiting list — a public Google-Form link (waitlist_url) + button
  // label. Non-PII. Lets the kscw-website contact form and the basketball youth
  // page detect a "full" team and route to its waiting list instead of emailing
  // the coach/youth coordinator. The /kscw/contact endpoint also gates on this.
  'waitlist_url', 'waitlist_label',
  // Mixed (MU) youth teams recruit girls and boys separately (migration 298).
  // The basketball youth page splits those cards on these two: the gender being
  // taken gets the contact form, the other the waiting list. Booleans, no PII.
  'open_for_girls', 'open_for_boys',
]

/** Coach Dashboard prefs — readable by Coach/Team Responsible/Admin via an explicit read row. NOT added to PUBLIC_TEAM_FIELDS. */
const LEADER_TEAM_DASHBOARD_FIELDS = [
  'dashboard_range_from',
  'dashboard_range_to',
  'dashboard_league_only',
]

/**
 * Public fields for games.
 *
 * Internal ops columns stay OUT on purpose: duty assignments, the RSVP/auto-confirm
 * toggles (`auto_confirm_rsvp`), and — since migration 206 — the Volleymanager
 * Einsatzliste toggle + push journal (`auto_nomination_list`, `vm_nomination_*`).
 * Do NOT add them here: anon has no business knowing who we nominated, or that a
 * push failed. Authenticated members read them via the Member policy below.
 */
const PUBLIC_GAME_FIELDS = [
  'id', 'date', 'time', 'home_team', 'away_team', 'home_score', 'away_score',
  'sets_json', 'league', 'round', 'season', 'kscw_team', 'status', 'source',
  'game_id', 'hall', 'type',
  // Referee assignment as published by Swiss Volley — the officials' names on a
  // public fixture list, no contact details or member ids. The kscw-website
  // calendar's game-detail popup lists them (migration 311); because Directus
  // 403s the whole request over one ungranted field, leaving this out did not
  // hide the referee rows, it emptied the calendar's games for every month.
  'referees_json',
]

/**
 * Every `games` column a Coach/TR (§7) or Spielplaner (§9d) may WRITE — i.e. the
 * full column set MINUS the five `vm_nomination_*` push-journal columns that
 * migration 206 added.
 *
 * WHY THIS LIST EXISTS AT ALL. Directus field permissions are allow-lists; there
 * is no deny-list, and `setPerm(..., fields = null)` defaults to `['*']`. Both the
 * LEADER and Spielplaner `games` write grants used to take that default, so they
 * carried write access to every column — including, once 206 lands, the journal the
 * VM-nomination cron owns:
 *
 *   vm_nomination_status, vm_nomination_list_id, vm_nomination_count,
 *   vm_nomination_pushed_at, vm_nomination_error
 *
 * Those are written ONLY by the backend cron (admin credentials — bypasses policies
 * entirely, so it needs no grant here). They must be read-only to everyone else: the
 * cron re-attempts anything whose status is not `closed`/`skipped`, so a coach who
 * could PATCH `vm_nomination_status = 'closed'` would silently suppress their own
 * team's Einsatzliste push — and a forged `vm_nomination_error` would send whoever
 * reads the game modal chasing a failure that never happened. Read-only journal =
 * the cron's idempotency key can't be tampered with from the app.
 *
 * The per-game OPT-IN toggle `auto_nomination_list` is NOT part of the journal — it
 * is the coach's control, exactly like its sibling `auto_confirm_rsvp`, and is
 * therefore listed below as writable.
 *
 * WHY IT IS THE WHOLE COLUMN SET, NOT A HAND-PICKED SHORT LIST. Every write flow
 * these two policies drive today (`GameDetailModal`, `GameDetailDrawer`,
 * `ScorerPage`/`ScorerAssignPage`, `buildManualGamePayload`, `ImportPanel`,
 * `ExcelImportPanel`) sends a flat payload of real columns — no relational aliases.
 * Enumerating all of them minus the journal makes this a strict superset of what
 * those flows write, so replacing the `['*']` default changes NO existing behaviour;
 * it only subtracts the five backend-owned columns. (A Directus field allow-list is
 * hard-fail: a payload key outside it 403s the WHOLE request, so a hand-picked list
 * would be a coach-facing regression waiting to happen.) `id` / `date_created` /
 * `date_updated` are kept for the same superset reason — they were writable under
 * `['*']`; narrowing them is a separate hardening question, not this change's job.
 *
 * ⚠ MAINTENANCE: a NEW `games` column that a coach/TR or spielplaner must write MUST
 * be added here, or their PATCH 403s with "You don't have permission to access field".
 * A new BACKEND-OWNED column (another push journal, a sync marker) must deliberately
 * stay OUT.
 */
const GAME_WRITE_FIELDS = [
  'id', 'game_id', 'home_team', 'away_team', 'away_hall_json',
  'date', 'time', 'league', 'round', 'season', 'type', 'status',
  'home_score', 'away_score', 'sets_json',
  'duty_confirmed', 'referees_json', 'source', 'respond_by', 'min_participants',
  'kscw_team', 'hall', 'additional_halls',
  // Duty assignments (VB + BB) + the confirmed-by actor pairs.
  'scorer_member', 'scoreboard_member', 'scorer_scoreboard_member',
  'scorer_duty_team', 'scoreboard_duty_team', 'scorer_scoreboard_duty_team',
  'bb_scorer_member', 'bb_timekeeper_member', 'bb_24s_official',
  'bb_duty_team', 'bb_scorer_duty_team', 'bb_timekeeper_duty_team', 'bb_24s_duty_team',
  'referee_duty_team', 'referee_member',
  'scorer_confirmed_by_name', 'scorer_confirmed_at',
  'scoreboard_confirmed_by_name', 'scoreboard_confirmed_at',
  'scorer_scoreboard_confirmed_by_name', 'scorer_scoreboard_confirmed_at',
  'bb_scorer_confirmed_by_name', 'bb_scorer_confirmed_at',
  'bb_timekeeper_confirmed_by_name', 'bb_timekeeper_confirmed_at',
  'bb_24s_confirmed_by_name', 'bb_24s_confirmed_at',
  'referee_confirmed_by_name', 'referee_confirmed_at',
  'send_email_invite', 'svrz_push_status',
  'date_created', 'date_updated',
  // Per-activity RSVP auto-confirm override (migration 048): null = inherit the
  // team default. Coach-owned toggle.
  'auto_confirm_rsvp',
  // Per-game Volleymanager Einsatzliste opt-in (migration 206): null = inherit
  // teams.features_enabled.auto_nomination_list. Coach-owned toggle — same trust
  // model as auto_confirm_rsvp above. The vm_nomination_* journal it drives is
  // deliberately absent from this list (see the header).
  'auto_nomination_list',
  // Besammlung offset (migration 340). Coach-owned: the whole point is that
  // the team's own coach sets when the team meets. Omitted here it would be
  // silently read-only to every non-admin — field perms are an allow-list.
  'meeting_offset_minutes',

  // ── Deliberately NOT in this list: backend-owned columns ────────────────────
  // Directus field permissions are an allow-list, so anything omitted here is
  // read-only to coaches/spielplaner. That is intentional for every column whose
  // only writer is a custom endpoint (raw knex, which bypasses the items API and
  // these permissions entirely):
  //
  //   vm_nomination_status / _list_id / _count / _pushed_at / _error  (migration 206)
  //       → vm-push-nomination.mjs + nomination-push.js. A coach who could PATCH
  //         vm_nomination_status = 'closed' would silently suppress their own team's
  //         push, since the cron skips anything already closed/skipped.
  //   duty_late_json          (migration 202) → duty-late.js
  //   duty_leader_alert_json  (migration 203) → duty-leader-contact.js
  //
  // ⚠ Verify additions against the LIVE database, not SCHEMA.sql — the baseline is
  // regenerated on demand and lags the migration journal (it was missing 202/203/205
  // when this list was written). A `games` column that a coach must write and that is
  // missing here 403s their ENTIRE PATCH, not just that field.
]

/**
 * Public fields for events — the kscw-website homepage + /weiteres/kalender
 * read these unauthenticated. Only the event record itself (non-PII).
 * The RSVP data (participations / events_teams) stays NON-public — migration
 * 035 locked those down for privacy and they remain removed below.
 */
const PUBLIC_EVENT_FIELDS = [
  'id', 'title', 'event_type', 'start_date', 'end_date', 'all_day',
  'location', 'description', 'signup_url', 'cancelled',
]

/** Public fields for news — kscw-website homepage + /news read these. */
const PUBLIC_NEWS_FIELDS = [
  'id', 'title', 'title_en', 'slug', 'excerpt', 'body', 'category',
  'author', 'published_at', 'image', 'date_created',
]

/**
 * Fields a member sees on their OWN finance invoices (dues) — migration 114.
 * Dues-relevant columns only; excludes the mirror plumbing (source,
 * import_batch, cd_* timestamps, fiscal_year, recipient_*) a member needn't see.
 */
const MEMBER_INVOICE_FIELDS = [
  'id', 'number', 'invoice_date', 'subject', 'amount', 'status',
  'dunning_status', 'due_date', 'amount_paid', 'open_amount',
  'overpaid_amount', 'written_off_amount', 'payment_method', 'reference',
  'fee_category', 'closed_on', 'member',
]

/**
 * Member fields the FINANCE role reads (migrations 132/133). A treasurer needs
 * the full billing picture per member — contact + address + IBAN + membership
 * category + the alternate billing contact. UNION-ed with MEMBER_VISIBLE_FIELDS
 * at read time (additive policies), so this only WIDENS what finance sees on top
 * of the club-public member fields. Granted unfiltered (club-wide), like Vorstand
 * reads members — but field-scoped to the finance-relevant columns, not '*'.
 */
const FINANCE_MEMBER_FIELDS = [
  'id', 'first_name', 'last_name', 'nickname', 'email', 'phone', 'number',
  'anrede', 'adresse', 'plz', 'ort', 'nationalitaet', 'sex', 'birthdate',
  // Coded nationality + federation of origin (migrations 223/224) — kept in
  // parity with the derived `nationalitaet` finance already reads.
  'nationalitaet_codes', 'federation_of_origin',
  'iban', 'ahv_nummer', 'beitragskategorie', 'sektion', 'kscw_membership_active', 'wiedisync_active',
  // Club register status + entry/exit dates (migration 302). Read-only for
  // finance: whether somebody is a member, and for how much of the season, is
  // the first input to whether they owe a Mitgliederbeitrag at all.
  'register_status', 'eintritt', 'austritt',
  'language', 'role', 'member_teams', 'date_created', 'iban_confirmed',
  // Alternate billing contact (migrations 133/136).
  'billing_different', 'billing_name', 'billing_email', 'billing_address', 'billing_plz', 'billing_ort', 'billing_phone', 'billing_iban',
  // Per-member fee overrides (migrations 299/300) — the treasurer's own numbers.
  'fee_base_override', 'fee_surcharge_override', 'fee_discount', 'fee_discount_pct', 'fee_discount_reason',
]

/**
 * Member fields the FINANCE role may UPDATE on any member: the alternate
 * billing contact (migrations 133/136) and the per-member fee overrides
 * (migration 299).
 *
 * The fee columns are deliberately WRITABLE by finance and by nobody else below
 * admin. They decide what a member is invoiced — the treasurer is exactly who
 * should set them, and a coach or sport admin is exactly who should not.
 */
const FINANCE_MEMBER_BILLING_FIELDS = [
  'billing_different', 'billing_name', 'billing_email', 'billing_address', 'billing_plz', 'billing_ort', 'billing_phone', 'billing_iban',
  'fee_base_override', 'fee_surcharge_override', 'fee_discount', 'fee_discount_pct', 'fee_discount_reason',
]

/** Private folder for invoice PDFs (migration 134). Members can't read this folder
 *  (their directus_files read is folder-less-only); finance + board get a scoped read. */
const FINANCE_INVOICE_FOLDER = 'f1a0d0c5-0000-4000-8000-000000000001'
/** Private folder for feedback screenshots (migration 074). Can contain a member's
 *  authenticated screen / PII — must NOT be member-readable (audit PERM-1, 2026-06-25);
 *  only Vorstand / Sport Admin review them via a folder-scoped read below. */
const FEEDBACK_FOLDER = 'feedbac0-0000-4000-8000-000000000001'
/** Private folder for registration documents — government-ID scans + Swiss Basketball
 *  licence/declaration docs (migration 169; quarantine hook + /registration/upload).
 *  Must NOT be member-readable (2026-07-04 review): Sport Admin reads via its full
 *  directus_files CRUD, Vorstand via the scoped read below. */
const REGISTRATION_FILES_FOLDER = 'a0000167-0000-4000-8000-000000000001'
/** Private folder for END-TO-END-ENCRYPTED identity documents (migration 212). The bytes are
 *  ciphertext the club holds no key to, so leaking them would reveal nothing — but the
 *  Member file-read filter below is a DENY-list, so a folder that is not named here is
 *  readable by every member by default. A permissions hole is not something to leave
 *  standing because the crypto happens to cover it. Served ONLY via /kscw/identity/*, which
 *  checks the caller holds an envelope; never via /assets. Not granted to Vorstand or
 *  Finance either — there is nothing there for them to read. */
const IDENTITY_DOCS_FOLDER = 'd0c00001-0000-4000-8000-000000000001'

/** Private folder for scorer-exam material (`kscw-endpoints/src/scorer-exam.js`
 *  exports the same UUID). Holds candidates' submitted match sheets and the
 *  graded corrections — the filenames themselves name the candidate. It shipped
 *  without ever being added to the deny-list below, so for its whole life every
 *  one of ~499 members could list it via
 *  `GET /items/directus_files?filter[folder][_eq]=…` and download all 8 files
 *  from /assets, even though the parent `scorer_course_attendance` collection is
 *  correctly not member-readable (audit 2026-08-08, finding 9). This is exactly
 *  the failure mode the IDENTITY_DOCS comment above predicted in writing: a
 *  deny-list silently grants anything nobody remembered to name.
 *  `assertAllPrivateFoldersDenied` now fails the deploy instead of trusting memory. */
const SCORER_EXAM_FOLDER = 'd0c00002-0000-4000-8000-000000000001'

/** Every folder that must never be readable by the Member tier. Adding a folder
 *  constant above without adding it here is the bug this list exists to make
 *  impossible — see the assertion below. */
const PRIVATE_FOLDERS = [
  FINANCE_INVOICE_FOLDER,
  FEEDBACK_FOLDER,
  REGISTRATION_FILES_FOLDER,
  IDENTITY_DOCS_FOLDER,
  SCORER_EXAM_FOLDER,
]

/**
 * Fail the deploy if a private folder defined in the endpoint code is missing
 * from PRIVATE_FOLDERS. The deny-list is only as good as the author's memory
 * otherwise, and that has already failed once (finding 9).
 *
 * Kept as a literal map rather than an import because `directus/extensions` is a
 * separate deploy unit this script must not reach across (CLAUDE.md §4) — so the
 * check is that the two lists AGREE, and each key names the file to reconcile
 * against when it fires.
 */
const ENDPOINT_PRIVATE_FOLDERS = {
  'registration.js → REGISTRATION_FILES_FOLDER': REGISTRATION_FILES_FOLDER,
  'identity-document.js → IDENTITY_FOLDER': IDENTITY_DOCS_FOLDER,
  'scorer-exam.js → SCORER_EXAM_FOLDER': SCORER_EXAM_FOLDER,
}

function assertAllPrivateFoldersDenied() {
  const missing = Object.entries(ENDPOINT_PRIVATE_FOLDERS)
    .filter(([, uuid]) => !PRIVATE_FOLDERS.includes(uuid))
    .map(([where, uuid]) => `${where} (${uuid})`)
  if (missing.length) {
    console.error('\n💥 Private folder(s) missing from the Member deny-list — every member could read them:')
    for (const m of missing) console.error(`   - ${m}`)
    console.error('   Add them to PRIVATE_FOLDERS in setup-permissions.mjs.\n')
    process.exit(1)
  }
}

// ── Main ──────────────────────────────────��──────────────────────

async function main() {
  console.log(`\n🔐 KSCW Directus 11 Hybrid Permission Setup → ${DIRECTUS_URL}\n`)
  assertAllPrivateFoldersDenied()
  await auth()

  // ── 1. Ensure roles ────────────────────────────────────────────

  console.log('1. Ensuring roles...')
  const roleMap = await ensureRoles()
  console.log('   Roles:', JSON.stringify(roleMap, null, 2))

  // ── 2. Create policies ───────���─────────────────────────────────

  console.log('\n2. Creating policies...')

  // Find built-in public policy
  const allPolicies = await api('GET', '/policies?limit=-1')
  const publicPolicy = allPolicies.find(p => p.name === '$t:public_label')
  const PUBLIC_POLICY = publicPolicy?.id
  console.log(`  Public policy: ${PUBLIC_POLICY || 'NOT FOUND — will create'}`)

  const MEMBER_POLICY = await findOrCreatePolicy('KSCW Member', { icon: 'person', app_access: true })
  const LEADER_POLICY = await findOrCreatePolicy('KSCW Team Responsible', { icon: 'supervisor_account', app_access: true })
  const VORSTAND_POLICY = await findOrCreatePolicy('KSCW Vorstand', { icon: 'groups', app_access: true })
  const SPORT_ADMIN_POLICY = await findOrCreatePolicy('KSCW Sport Admin', { icon: 'sports', app_access: true })
  const ADMIN_POLICY = await findOrCreatePolicy('KSCW Admin', { icon: 'admin_panel_settings', admin_access: true, app_access: true })
  // Terminplanung (opponent game-scheduling) admin access for club-wide
  // Spielplaner members. Distinct from the per-user "KSCW Spielplaner" policy
  // below (manual-game create/update/delete in the Spielplanung planner): this
  // one is attached only to the directus users of members with
  // is_spielplaner=true (backfilled in section 12), so the unfiltered
  // game_scheduling perms below are gated purely by who holds the policy.
  const TERMINPLANUNG_POLICY = await findOrCreatePolicy('KSCW Terminplanung', { icon: 'event_available', app_access: true })
  // Spielplaner manual-game writes (create/update/delete on `games`) for the
  // Spielplanung planner (ManualGameModal / SpielplanungPage via the items
  // API). Attached per-user (§14) to the directus users of members with
  // is_spielplaner=true OR at least one spielplaner_assignments row — NOT to
  // a Directus role. Every grant is scoped to source='manual' rows (VM-synced
  // league games stay Sport-Admin-only); per-team row/team scope is enforced
  // server-side by the kscw-hooks Spielplaner scope guard on
  // games.items.create/update/delete (see §9d).
  const SPIELPLANER_POLICY = await findOrCreatePolicy('KSCW Spielplaner', { icon: 'edit_calendar', app_access: true })
  // Finance (orthogonal capability, migrations 132/133). Attached per-user to
  // members with 'finance' in their role array (§13) + by the role-sync hook —
  // NOT to a Directus role. Grants club-wide finance reads + member billing-field
  // read/update on top of the member's base policy. Native-invoice WRITES still
  // go through the /kscw/finance/* endpoints (gated in code via canManageFinance).
  const FINANCE_POLICY = await findOrCreatePolicy('KSCW Finance', { icon: 'account_balance', app_access: true })

  // LedBox scoreboard publisher (migration 272). Held by ONE service user via a
  // static token, never attached to a role — the hall's LED board authenticates
  // with it to PATCH its own `live_scores` row. Scoped to that collection alone
  // (create/read/update, no delete) and no app access: a leaked board token can
  // rewrite the scoreboard and nothing else.
  const LEDBOX_POLICY = await findOrCreatePolicy('KSCW LedBox Publisher', { icon: 'scoreboard', app_access: false })

  /**
   * `Website_admin` — the one role that was created by hand in the admin UI and
   * never modelled here. Until 2026-08-10 §3b left it alone ("roles this script
   * does not declare are REPORTED, never pruned"), so its rows were whatever
   * someone clicked in 2026: unfiltered read + update on `directus_files`,
   * unfiltered read on `directus_users` and `directus_roles`.
   *
   * That was a live PII leak, not a theoretical one (audit 2026-08-08,
   * finding 3). Directus UNIONs permission rows per collection+action, so a
   * filterless `directus_files` read OVERRIDES the Member deny-list — its four
   * holders (ordinary members, `members.role = ["user"]`, none with TFA) could
   * list and download the registration folder's government-ID scans. Worse,
   * unfiltered UPDATE with `fields '*'` meant one
   * `PATCH /items/directus_files/<id> {"folder": null}` moved a minor's passport
   * scan into the folder the PUBLIC policy reads — the quarantine hooks only
   * inspect files on CREATE.
   *
   * Now declarative and scoped to what a website editor actually does: manage
   * the public (folder-less) image library. Private folders are unreachable in
   * both directions — read cannot see them, and update cannot pull a file out of
   * one, because the row filter is evaluated against the EXISTING row.
   */
  // `app_access: false` mirrors the live policy — app access reaches these users
  // through the `Website Admin → KSCW Member` attachment declared below, not
  // through this policy. (findOrCreatePolicy never updates an existing policy,
  // so this only governs a fresh install; getting it wrong would have made a
  // rebuilt instance diverge from prod silently.)
  const WEBSITE_ADMIN_POLICY = await findOrCreatePolicy('Website_admin', { icon: 'language', app_access: false })

  console.log(`  Member policy: ${MEMBER_POLICY}`)
  console.log(`  Team Responsible policy: ${LEADER_POLICY}`)
  console.log(`  Vorstand policy: ${VORSTAND_POLICY}`)
  console.log(`  Sport Admin policy: ${SPORT_ADMIN_POLICY}`)
  console.log(`  Admin policy: ${ADMIN_POLICY}`)

  // ���─ 3. Attach policies to roles ──────���─────────────────────────

  console.log('\n3. Attaching policies to roles...')

  /**
   * THE declared set of ROLE-level policy attachments. This list is the whole
   * truth: §3b below deletes every role-level `directus_access` row that is not
   * in it (see reconcileRoleAccess). Adding a line here grants a tier; removing
   * a line REVOKES it on the next deploy.
   *
   * ⚠ Only ROLE-level rows belong here. The orthogonal policies (Terminplanung,
   * Finance, Spielplaner, and the LEADER backfill) are attached to USERS, not
   * roles, and are reconciled by §10 / §12 / §13 / §14. §3b never touches
   * user-level rows.
   *
   * ⚠ `Administrator` is deliberately absent — Directus owns that role's
   * built-in policy and §3b treats the role as protected (PROTECTED_ROLES).
   *
   * ⚠ `Sport Admin` is deliberately NOT given `KSCW Admin`. Prod carried
   * exactly that row (hand-made 2026-03-29, admin_access = true), which turned
   * every vb_admin / bb_admin into a full Directus superadmin — the escalation
   * §3b now removes and keeps removed. Sport Admin's ceiling is the
   * `KSCW Sport Admin` policy (§9): no members/teams delete, no schema access.
   */
  const DECLARED_ROLE_POLICIES = [
    // Member role → member policy
    { role: 'Member', policy: MEMBER_POLICY },
    // Team Responsible → leader + member (inherits member permissions)
    { role: 'Team Responsible', policy: LEADER_POLICY },
    { role: 'Team Responsible', policy: MEMBER_POLICY },
    // Vorstand → vorstand + member
    { role: 'Vorstand', policy: VORSTAND_POLICY },
    { role: 'Vorstand', policy: MEMBER_POLICY },
    // Sport Admin → sport admin + leader + member (full chain, NO admin policy)
    { role: 'Sport Admin', policy: SPORT_ADMIN_POLICY },
    { role: 'Sport Admin', policy: LEADER_POLICY },
    { role: 'Sport Admin', policy: MEMBER_POLICY },
    // Superuser → admin policy only. admin_access = true bypasses every
    // permission check, so the lower tiers add nothing; prod carried four
    // redundant ones (Member / Team Responsible / Vorstand / Sport Admin) plus
    // a stray `Website_admin`, all of which §3b now prunes. No effective
    // change for a superuser — they already bypass all of it.
    { role: 'Superuser', policy: ADMIN_POLICY },
    // Website Admin → its own policy + member. Declared since 2026-08-10 so §3b
    // reconciles it like every other role instead of leaving it as whatever was
    // last clicked in the admin UI (audit 2026-08-08, finding 3).
    { role: 'Website Admin', policy: WEBSITE_ADMIN_POLICY },
    { role: 'Website Admin', policy: MEMBER_POLICY },
  ].map(d => ({ role: d.role, roleId: roleMap[d.role], policyId: d.policy }))

  for (const d of DECLARED_ROLE_POLICIES) {
    if (!d.roleId) {
      console.warn(`  ⚠ role "${d.role}" not found — skipping its policy attachment`)
      continue
    }
    await attachPolicyToRole(d.roleId, d.policyId)
  }

  // Administrator → already has admin_access=true built-in
  console.log('  ✓ Done')

  // ── 3b. Reconcile role-level attachments against the declared set ──

  console.log(`\n3b. Reconciling role→policy attachments${RECONCILE_DRY_RUN ? ' (DRY RUN)' : ''}...`)
  await reconcileRoleAccess(DECLARED_ROLE_POLICIES, roleMap)

  // ── 3c. Audit Administrator-role membership ────────────────────

  console.log('\n3c. Auditing Administrator role membership...')
  // §3c REPORTS; it must never be able to stop a permission deploy. It shipped
  // with a malformed `_in` filter and the resulting 500 halted the whole run
  // before section 4 — the permission rebuild never happened (2026-08-10).
  // A read-only audit failing is worth a warning, never an outage.
  try {
    await auditAdministratorRole(roleMap)
  } catch (e) {
    console.warn(`  ⚠ Administrator audit failed (non-fatal): ${String(e.message).slice(0, 200)}`)
  }

  // ── 4. Clear old permissions for idempotent re-run ─────────────

  console.log('\n4. Clearing old permissions...')
  // Member + Team Responsible are cleared at the START of their own recreate
  // sections (§6, §7 below), NOT here. Those are the policies every
  // authenticated user holds, so clearing them up-front leaves them empty for
  // the WHOLE run — during which a concurrent /users/me resolves the degraded
  // role ['user'] and 403s across every collection (the 2026-06-19 permission
  // "wall" the error-log audit traced to a deploy-window reconcile). The API
  // model can't wrap clear+recreate in one transaction, so interleaving is the
  // mitigation: each window shrinks to that policy's own (sub-second) section,
  // and a Member is never empty while an unrelated policy is being rebuilt.
  if (PUBLIC_POLICY) await clearPolicyPermissions(PUBLIC_POLICY, 'Public')
  await clearPolicyPermissions(VORSTAND_POLICY, 'Vorstand')
  await clearPolicyPermissions(SPORT_ADMIN_POLICY, 'Sport Admin')
  await clearPolicyPermissions(ADMIN_POLICY, 'Admin')
  await clearPolicyPermissions(TERMINPLANUNG_POLICY, 'Terminplanung')
  // Finance is held only by finance members (not every authenticated user), so
  // clearing it here doesn't risk the universally-held-policy "permission wall".
  await clearPolicyPermissions(FINANCE_POLICY, 'Finance')
  // Spielplaner is likewise held only by spielplaner users (§14) — no "wall" risk.
  await clearPolicyPermissions(SPIELPLANER_POLICY, 'Spielplaner')
  // LedBox publisher holds exactly one collection — safe to clear and recreate.
  await clearPolicyPermissions(LEDBOX_POLICY, 'LedBox Publisher')
  await clearPolicyPermissions(WEBSITE_ADMIN_POLICY, 'Website_admin')

  // ── 5. Public permissions ──────────────────────────────────────

  if (PUBLIC_POLICY) {
    console.log('\n5. Public (unauthenticated) permissions...')

    await setPermRead(PUBLIC_POLICY, 'teams', { active: { _eq: true } }, PUBLIC_TEAM_FIELDS)
    await setPermRead(PUBLIC_POLICY, 'games', null, PUBLIC_GAME_FIELDS)
    await setPermRead(PUBLIC_POLICY, 'rankings')
    await setPermRead(PUBLIC_POLICY, 'sponsors', { active: { _eq: true } })
    await setPermRead(PUBLIC_POLICY, 'scorer_courses', { active: { _eq: true } })

    // public_stats — the two aggregate counters (`member_count`, `team_count`)
    // that kscw.ch/club/ueber-uns animates via `islands/live-stats.ts`. The
    // grant existed once as a hand-patch and a later clearPolicyPermissions
    // wiped it; because it was never declared here it could not come back, so
    // the About page had been 403-ing since at least 13.08.2026 and silently
    // fell back to the build-time hardcoded member figure. Three columns
    // (`id`, `value`, `date_updated`), no PII — full read is safe.
    await setPermRead(PUBLIC_POLICY, 'public_stats')

    // Events + news — kscw-website homepage and /weiteres/kalender read these.
    // Migration 035 wrongly assumed the website didn't consume `events` and
    // dropped the public read, which silently emptied the homepage events and
    // calendar; `news` was never granted at all (homepage News showed
    // "no news"). Re-added field-scoped, non-PII only. RSVP junctions
    // (participations / events_teams) stay NON-public — see calendar note below.
    // News is limited to published posts (published_at set, not future-dated).
    //
    // ROW-SCOPE (2026-06-10 audit): the public read was field-restricted but NOT
    // row-restricted (filter was `null`), so anon could read EVERY event's title
    // — including team-internal events (a tournament scoped to one team) — by
    // hitting /items/events directly. The /kscw/public/events endpoint already
    // excludes team-/member-scoped events server-side, but the raw collection
    // read had no such guard. Scope to the club-wide event types, mirroring the
    // Member EVENTS_VISIBLE club-wide branch (`event_type ∈ {verein, tournament}`).
    // (Note: a club-wide-TYPE event that is ALSO team-scoped via events_teams is
    // still filtered out by the /public/events endpoint, which the website uses;
    // this row filter closes the direct-collection-read leak for the type axis.)
    await setPermRead(PUBLIC_POLICY, 'events', { event_type: { _in: ['verein', 'tournament'] } }, PUBLIC_EVENT_FIELDS)
    await setPermRead(
      PUBLIC_POLICY, 'news',
      { _and: [{ published_at: { _nnull: true } }, { published_at: { _lte: '$NOW' } }] },
      PUBLIC_NEWS_FIELDS,
    )

    // Junction tables for deep queries (website needs coach names, sponsor logos)
    await setPermRead(PUBLIC_POLICY, 'teams_sponsors')
    await setPermRead(PUBLIC_POLICY, 'teams_coaches')  // coach junction
    // 2026-05-31 security audit: public members read was unfiltered, exposing
    // every member's name + photo regardless of their `website_visible` opt-out
    // (the privacy flag was only honoured by the kscw-website frontend, not at
    // the permission layer — the whole roster was anonymously enumerable). Scope
    // the public read to opt-in members only and keep the minimal field set.
    //
    // 2026-06-20 minor-protection: belt-and-suspenders so an under-18 can NEVER
    // be returned here even if `website_visible` is set true by mistake. Only
    // members we can prove are adults pass (birthdate at least 18 years ago);
    // a NULL birthdate fails the `_lte` comparison and is therefore excluded —
    // same "prove adult or hide" rule the /kscw/public/team/:id endpoint uses.
    await setPermRead(
      PUBLIC_POLICY,
      'members',
      { _and: [{ website_visible: { _eq: true } }, { birthdate: { _lte: '$NOW(-18 years)' } }] },
      ['id', 'first_name', 'last_name', 'photo'],
    )

    // Calendar: hall slots, closures, hall events, halls.
    // Migration 035 removed `slot_claims` from Public — internal hall booking
    // strategy isn't public. It also removed `events_teams` / `participations`
    // (every RSVP across the club was anonymously readable) — those stay
    // removed; only the event record itself is public (granted above).
    // Migration 032 removed `trainings` (per-team schedule, members-only).
    await setPermRead(PUBLIC_POLICY, 'hall_slots')
    await setPermRead(PUBLIC_POLICY, 'hall_slots_teams')  // M2M junction
    await setPermRead(PUBLIC_POLICY, 'hall_closures')
    await setPermRead(PUBLIC_POLICY, 'hall_events')
    await setPermRead(PUBLIC_POLICY, 'halls')

    // Feedback — public create (kscw-website form, validated by Turnstile hook).
    // `screenshots` (migration 166) must be whitelisted too, else an anon multi-file
    // submit 403s AFTER the files upload → lost feedback + orphaned public files.
    await setPerm(PUBLIC_POLICY, 'feedback', 'create', null,
      ['type', 'title', 'description', 'source', 'source_url', 'status', 'name', 'email', 'screenshot', 'screenshots'])

    // Mixed tournament signups — public create (kscw-website form, validated by Turnstile hook)
    await setPerm(PUBLIC_POLICY, 'mixed_tournament_signups', 'create', null,
      ['name', 'email', 'sex', 'position_1', 'position_2', 'position_3', 'teams', 'notes', 'is_member', 'member_id'])

    // Files. 2026-05-31 security audit: anon could fetch ANY uploaded asset via
    // GET /assets/:id (e.g. feedback screenshots, which can contain a member's
    // authenticated screen / PII). /assets applies the file's row-level read
    // filter, so scope the public read to FOLDER-LESS files only: the public
    // site's team/member/sponsor/news images live at the root (no folder), while
    // sensitive uploads (feedback screenshots) are relocated into a private
    // folder by migration 074 + the kscw-hooks feedback hook. A folder
    // assignment therefore === private, and new private folders are excluded by
    // default (fail-safe). NB: anon /items/directus_files LISTING is denied
    // regardless (system-collection listing isn't granted to Public) — this
    // scopes the /assets read path, which is what actually leaked.
    await setPermRead(PUBLIC_POLICY, 'directus_files', { folder: { _null: true } })
    await setPerm(PUBLIC_POLICY, 'directus_files', 'create')

    // Live scoreboard (migration 272) — the /live page is a PUBLIC spectator view
    // and most viewers in the hall are not logged in. The row holds nothing but a
    // match score, two team names and their colours, so it is public in full.
    await setPermRead(PUBLIC_POLICY, 'live_scores')

    // Recent finished matches (migration 273) — same audience and same content
    // class as the live board above: scores and team names, nothing personal.
    await setPermRead(PUBLIC_POLICY, 'live_history')

    console.log(`  ✓ Public permissions set`)
  } else {
    console.log('\n5. ⚠ No public policy found — skipping public permissions')
  }

  // ── 5b. LedBox scoreboard publisher ────────────────────────────
  // The board's write path. create (self-heals a missing row) + read (a PATCH
  // response reads the row back) + update (every score change). NO delete, and
  // nothing outside `live_scores`.

  console.log('\n5b. LedBox publisher permissions...')
  await setPerm(LEDBOX_POLICY, 'live_scores', 'create')
  await setPerm(LEDBOX_POLICY, 'live_scores', 'read')
  await setPerm(LEDBOX_POLICY, 'live_scores', 'update')
  // History is APPEND-ONLY for the board: create, and deliberately NO update or
  // delete. A device in a hall may add a finished match; correcting or removing one
  // is an admin action.
  // (No read grant here either — but note the token can still READ it, because the
  // Public grant above applies to authenticated requests too and Directus policies
  // are additive with no deny rule. Harmless: the collection is public anyway.
  // Append-only is enforced by the absence of update/delete, which IS effective.)
  await setPerm(LEDBOX_POLICY, 'live_history', 'create')
  console.log('  ✓ LedBox publisher permissions set')

  // ── 5c. Website Admin permissions ──────────────────────────────
  // The public image library, and nothing else. See the WEBSITE_ADMIN_POLICY
  // comment above for what this replaced and why it mattered.
  //
  // PUBLIC_FILES is `folder _null` — the same predicate the Public policy reads,
  // so "what a website admin can touch" and "what the website can serve" are one
  // definition. Applying it to UPDATE is the load-bearing half: Directus
  // evaluates a row filter against the EXISTING row, so a file sitting in the
  // registration folder cannot be selected for update at all, and therefore
  // cannot be pulled out of it by setting `folder: null`.
  const PUBLIC_FILES = { folder: { _null: true } }
  await setPerm(WEBSITE_ADMIN_POLICY, 'directus_files', 'create')
  await setPermRead(WEBSITE_ADMIN_POLICY, 'directus_files', PUBLIC_FILES)
  await setPerm(WEBSITE_ADMIN_POLICY, 'directus_files', 'update', PUBLIC_FILES)
  // `teams` read — public information, and the website renders it. Unchanged.
  await setPermRead(WEBSITE_ADMIN_POLICY, 'teams')
  // Self only. The previous unfiltered `directus_users` read was the whole user
  // table — every member's email and status — to four ordinary members. The app
  // shell needs the signed-in user to render; it does not need anyone else's.
  await setPermRead(WEBSITE_ADMIN_POLICY, 'directus_users', { id: { _eq: '$CURRENT_USER' } })
  // `directus_roles` read is NOT re-granted. It carried no PII, but nothing in
  // the website workflow reads it — it was admin-UI incidental. If the Directus
  // app shell turns out to need it, re-add it here rather than by hand in the UI,
  // or §3b/§4 will delete it again on the next deploy — which is the point.
  console.log('  ✓ Website Admin permissions set')

  // ── 6. Member permissions ──────────────────────────────────────

  console.log('\n6. Member permissions...')

  // Cleared here (immediately before recreate), not in the up-front §4 block —
  // see the note there. Keeps the Member empty-window to this section only.
  await clearPolicyPermissions(MEMBER_POLICY, 'Member')

  // ── Unfiltered cross-club reads ─────────────────────────────
  // Truly directory-level info: club-public schedules and venue data.
  // Per migration 036, the M2M junctions (teams_coaches/teams_responsibles/
  // teams_sponsors / member_teams) stay open so the whole-club app can show
  // cross-team rosters. Member-level fields they expose are bounded by the
  // members.read field whitelist below.
  const MEMBER_READ_ALL = [
    'teams', 'games', 'rankings', 'sponsors',
    'event_sessions',
    'hall_slots', 'hall_closures', 'hall_events', 'halls', 'hall_slots_teams',
    'news', 'app_settings',
    // ⚠ `polls` was here until 2026-08-10 — see the scoped grant beside `messages`
    // below. `referee_expenses` stays: amount + notes, no PII.
    'referee_expenses',
    // Junctions
    'teams_coaches', 'teams_responsibles', 'teams_sponsors', 'events_teams', 'events_members',
  ]
  for (const col of MEMBER_READ_ALL) {
    await setPermRead(MEMBER_POLICY, col)
  }
  // Files: folder-less files PLUS any foldered file that is NOT in a private
  // folder. Two folders are private: finance-invoice (migration 134) holds a
  // member's billing PDFs, and feedback (migration 074) holds feedback
  // screenshots that can contain a member's authenticated screen / PII. Neither
  // may be member-readable via /assets (audit PERM-1, 2026-06-25 — previously
  // only the finance folder was excluded, so any member could enumerate +
  // download every feedback screenshot). Null-folder files don't match a bare
  // _nin, hence the _or. Finance + board re-add their folder below.
  await setPermRead(MEMBER_POLICY, 'directus_files', {
    _or: [
      { folder: { _null: true } },
      { folder: { _nin: PRIVATE_FOLDERS } },
    ],
  })

  // ── Team-scoped reads (migration 032 / 033) ─────────────────
  // trainings: only my teams. events: own + club-wide + my-teams + invited.
  // participations + absences: own + same-team. `referee_expenses` stays
  // cross-club above — amount + notes, no PII.
  // ⚠ The old wording here also covered `polls` with "team-scoped by app
  // navigation". That justification predated chat polls and was never true of
  // them: `POST /kscw/messaging/polls` creates rows with `team: null,
  // conversation: <uuid>`, so "app navigation" scoped nothing and the realtime
  // subscription pushed every poll in the club to every connected member.
  // `active: true` — the roster row on an archived team is never deleted, so
  // without it an ex-player keeps read of that team's trainings for good. Same
  // rule as the LEADER scopes below; the season string is never the guard.
  const MY_TEAMS_FILTER = {
    team: { active: { _eq: true }, members: { member: { user: { _eq: '$CURRENT_USER' } } } },
  }
  await setPermRead(MEMBER_POLICY, 'trainings', MY_TEAMS_FILTER)

  const EVENTS_VISIBLE = {
    _or: [
      { created_by: { user: { _eq: '$CURRENT_USER' } } },
      { event_type: { _in: ['verein', 'tournament'] } },
      // active: true for the same reason as MY_TEAMS_FILTER — an archived team's
      // roster row would otherwise keep granting event reads indefinitely. The
      // invited-members branch is per-event and needs no team gate.
      { teams: { teams_id: { active: { _eq: true }, members: { member: { user: { _eq: '$CURRENT_USER' } } } } } },
      { invited_members: { members_id: { user: { _eq: '$CURRENT_USER' } } } },
    ],
  }
  await setPermRead(MEMBER_POLICY, 'events', EVENTS_VISIBLE)

  // ⚠ `active: true` on the intermediate team is load-bearing, not decoration.
  // member_teams rows are never deleted on rollover — the roster is CLONED onto
  // the new team id and the old row is left pointing at the archived team. So
  // without this gate "same team as me" silently means "shared any team in any
  // season, forever": 407 members retained read of former teammates' CURRENT
  // absences (incl. the free-text `reason` in MEMBER_ABSENCE_FIELDS) and RSVPs.
  // Gate on teams.active, never on member_teams.season — the season column is a
  // create-time stamp uncoupled from the manually-run rollover (see AuthProvider).
  const SAME_TEAM_AS_ME = {
    _or: [
      { member: { user: { _eq: '$CURRENT_USER' } } },
      {
        member: {
          member_teams: {
            team: { active: { _eq: true }, members: { member: { user: { _eq: '$CURRENT_USER' } } } },
          },
        },
      },
    ],
  }

  // Game guests (migration 271). A game opened to another team / to individuals puts
  // people in the same roster who share no `member_teams` row, so SAME_TEAM_AS_ME
  // alone leaves holes in it from BOTH sides: the home team cannot read the guest's
  // RSVP, and the guest cannot read the home team's. Two extra branches close it,
  // each `_and`-ed with activity_type = 'game' so an invitation to one Saturday never
  // widens into that person's trainings and events.
  //
  // Breadth is deliberately the same shape as SAME_TEAM_AS_ME itself — that rule
  // already grants every participation row of anyone you share a team with, rather
  // than row-correlating per activity, because a Directus filter cannot join
  // `participations.activity_id` (a varchar, not an FK) back to `games`.
  const SAME_GAME_AS_ME = [
    // Their member is a guest on a game of a team I am on → I read their game RSVPs.
    {
      _and: [
        { activity_type: { _eq: 'game' } },
        { member: { game_guests: { game: { kscw_team: { members: { member: { user: { _eq: '$CURRENT_USER' } } } } } } } },
      ],
    },
    // Their member is on a team whose game I am a guest of → I read their game RSVPs.
    {
      _and: [
        { activity_type: { _eq: 'game' } },
        { member: { member_teams: { team: { games: { guests: { member: { user: { _eq: '$CURRENT_USER' } } } } } } } },
      ],
    },
  ]
  // Events (migration 333). The member-side trick above does not scale to them:
  // a game has one team, an event has a SET of teams + roles + individuals, and
  // "do we share a team?" is simply the wrong question to ask of a 12-team club
  // tournament. On event 27 (Photoday mixed tournament — 214 invited, 32
  // confirmed) it meant a DU20 player read 0 of the 32 confirmations and an H3
  // player 6; nobody but an admin saw more than 9. The roster still listed all
  // 214 names because `members` read is unfiltered — only the RSVP column was
  // missing, so the page said "hardly anyone answered" rather than "you may not
  // see this". Coaches were cut identically by COACH_OR_TR_OF_PARTICIPATION.
  //
  // Migration 333 stops working around the missing join and adds it:
  // `participations.event`, a real m2o kept in sync with activity_id by trigger.
  // The rule is then one sentence — YOU CAN READ THE RSVPS OF ANY EVENT YOU CAN
  // SEE — expressed by handing the *same object* to both permissions, so event
  // visibility and roster visibility can never drift apart.
  //
  // ⚠ TWO conditions, and the second one is the point. "Can I see the event?"
  // alone is too loose: EVENTS_VISIBLE opens every verein/tournament event to
  // the whole club so it lands in everyone's calendar, but plenty of those are
  // one team's day out — "Rämi Turnier" is H3 only. Being LISTED club-wide and
  // being ROSTERED club-wide are different questions. So the roster also has to
  // be genuinely cross-team: `events.open_roster` (migration 334) is true when
  // the event spans more than one team (teams <> 1 — zero means club-wide, the
  // broadest audience of all — or invited_roles is non-empty).
  //
  // A single-team event needs nothing from this branch anyway: everyone in its
  // audience shares that team, so SAME_TEAM_AS_ME above already shows them the
  // whole roster. This widens exactly the case that was broken and no other.
  //
  // ⚠ Free-text `note` rides along with `status` — a Directus policy has no
  // per-branch field split.
  const EVENT_ROSTER_VISIBLE = {
    _and: [
      { activity_type: { _eq: 'event' } },
      { event: { _and: [{ open_roster: { _eq: true } }, EVENTS_VISIBLE] } },
    ],
  }
  // ⚠⚠ NARROWED 2026-08-26 — PERFORMANCE STOPGAP, NOT A SECURITY DECISION.
  //
  // The full rule below (`SAME_TEAM_AS_ME` + `SAME_GAME_AS_ME` + `EVENT_ROSTER_VISIBLE`)
  // is CORRECT and stays here for restoration. It is parked because Directus does not
  // compile a policy `_or` into subqueries — it emits one flat LEFT JOIN per relation
  // hop, as siblings, and then re-evaluates the whole predicate inside a
  // `COUNT(CASE WHEN … )` aggregate ONCE PER READABLE FIELD (22 of them here).
  // Sibling LEFT JOINs cross-multiply, so the branches do not add — they MULTIPLY:
  //
  //   302 participation rows  →  46 LEFT JOINs  →  148,915,476 intermediate rows
  //   measured factors: teammates 41× · my-team-games→guests 36×
  //                     event-roster 29× · I-am-guest 11× · coaches/TRs 3.6×
  //
  // Prod cost, measured 26.08.2026: 7s uncontended, 80s+ under concurrency, and
  // 1m50s–2m05s during the morning login peak — members watched the logo spin until
  // the browser gave up. It is NOT data volume (12,309 participations, 713 members)
  // and NOT a missing index: each branch hand-written as a subquery returns in 2–6ms.
  // `work_mem` does not help (tested 4/64/256MB — 64MB was *slower*). Nor does
  // `join_collapse_limit`: no join order fixes a genuine 149M-row cross-product, and
  // raising it to 16 costs ~600ms of extra PLANNING on every such query.
  //
  // Measured on the dev clone (identical data), intermediate rows / time:
  //   all 5 branches (full rule)            148,915,476   60s
  //   without EVENT_ROSTER_VISIBLE            5,625,450   2.9s
  //   without SAME_GAME_AS_ME                   622,853   0.19s
  //   SAME_TEAM_AS_ME only (this stopgap)        22,175   0.012s   ← ~6,700× cheaper
  //
  // Dropping branches only ever NARROWS visibility — it cannot leak. What regresses:
  //   · migration 271 — called-up guests can no longer read each other's game RSVPs
  //   · migration 333 — multi-team event rosters go back to the pre-Photoday gap
  // Both must come back. The fix is to stop expressing "whose RSVP may I see?" as
  // repeated deep relation walks and precompute it — the same move migration 334
  // already made with the trigger-derived `events.open_roster`. See DEVLOG 26.08.2026.
  // ── STAGE 1 (26.08.2026, later the same day) ───────────────────────────────
  // `EVENT_ROSTER_VISIBLE` is restored; `SAME_GAME_AS_ME` stays parked.
  //
  // The two parked branches are NOT equally expensive, and the difference decides
  // the whole plan. Measured separately on the dev clone, same 302 driving rows:
  //   full rule (both branches)          148,915,476   6,700×
  //   minus EVENT_ROSTER_VISIBLE (271)     5,625,450     254×   ← game-guest is the pig
  //   minus SAME_GAME_AS_ME (333)            622,853      28×   ← event roster is cheap
  //   team-scope only (the stopgap)           22,175       1×
  // The factors MULTIPLY (28 × 254 ≈ 7,100 ≈ the observed 6,700×). So migration 333 —
  // the change everyone including this file's own morning DEVLOG entry assumed was the
  // culprit — is the cheaper of the two by an order of magnitude, and can come back on
  // its own for ~28× of a very small number (≈30ms extrapolated from the 7s baseline).
  //
  // What this un-hides: Photoday Day 2 (16.09.2026, club-wide, 56 RSVPs) and
  // Trainingsweekend (03.10.2026, 2 teams, 84 RSVPs) were showing their rosters as
  // unanswered to most of their audience — invisibly, because `members` read is
  // unfiltered so all the names still rendered.
  //
  // ⚠ This is STILL a 2-branch policy and it STILL multiplies. It is acceptable
  // because 28× of a small number is a small number, NOT because the shape is safe.
  // Do NOT add a third to-many branch on top of it.
  //
  // ⚠⚠ `SAME_GAME_AS_ME` must never come back as a filter. 254× on top of this is
  // ~7,600× and reinstates the outage. It has to stop being a relation walk —
  // see `.planning/2026-08-26-participation-visibility-design.md` (stage 2:
  // `participation_visibility(participation, viewer_user)`, one branch, one hop,
  // built verifier-first because a missed trigger source is a SILENT LEAK).
  // ── STAGE 2 (migration 341) ────────────────────────────────────────────────
  // `SAME_GAME_AS_ME` is GONE as a filter and is not coming back. The same truth is
  // now materialised in `participation_visibility` (participation, viewer_user),
  // reconciled by trigger from `game_guests` + the host roster + coaches/TRs.
  //
  // This branch is ONE hop, and `viewer_user` is a LOCAL column on the junction, so
  // there is no second-level walk for the other branches to multiply against. The
  // fanout is data-dependent: a participation on a game with no guests joins to
  // nothing. Measured on the dev clone, same 302 driving rows:
  //
  //   team + event branches (stage 1)                622,853 rows   127 ms
  //   + this junction branch                         641,739 rows   251 ms   (+3%)
  //   the same feature expressed as a FILTER     148,915,476 rows  17.9 s    (+23,800%)
  //
  // ⚠⚠ The club has 22 guest rows on exactly ONE game (572, H1, 17.09.2026). That
  // single fixture is what the 254× amplification was being paid for, permanently,
  // on every read. Materialised it is 429 rows.
  //
  // ⚠ The junction is NARROWER than the old filter, deliberately. The filter granted
  // "every game RSVP of anyone in a guest relationship with you" because Directus
  // cannot join `activity_id` (varchar) back to `games` — breadth was a limitation,
  // not an intent. This is row-correlated per fixture: lending a player for one
  // Saturday shows you that Saturday, nothing else. Narrowing cannot leak.
  //
  // ⚠ ONE branch serves BOTH policies — the junction's audience already includes the
  // host team's coaches and TRs, so LEADER walks the identical alias below.
  const GUEST_ROSTER_VISIBLE = { visible_to: { viewer_user: { _eq: '$CURRENT_USER' } } }
  const PARTICIPATION_VISIBLE = {
    _or: [...SAME_TEAM_AS_ME._or, EVENT_ROSTER_VISIBLE, GUEST_ROSTER_VISIBLE],
  }
  // 2026-05-12 audit #12: participations.last_*_edited_by are directus_users
  // UUIDs (migrations 046/047) which let Members enumerate Directus user
  // UUIDs by cross-referencing. Members get the timestamps but not the
  // UUIDs; LEADER keeps full read so coach UI can resolve editor names.
  // Absences gained `last_edited_by/at` in migration 051 — same pattern.
  const MEMBER_PARTICIPATION_FIELDS = [
    'id', 'member', 'activity_type', 'activity_id', 'status', 'note',
    // `event` (migration 333) is the m2o the EVENT_ROSTER_VISIBLE branch walks.
    // Listed so Directus accepts it as a filter target and the app can read it.
    'event',
    'guest_count', 'is_staff',
    'session_id', 'waitlisted_at',
    'auto_declined_by', 'auto_declined_by_game', 'auto_cancelled_by_closure',
    // migration 352 — the roster needs it to tell a missed deadline apart from
    // a real decline, and members read their own rows through this policy.
    'auto_declined_deadline',
    'last_status_edited_at', 'last_note_edited_at', 'last_edited_at',
    'date_created', 'date_updated',
  ]
  const MEMBER_ABSENCE_FIELDS = [
    'id', 'member', 'type', 'start_date', 'end_date', 'indefinite', 'blocking',
    'reason', 'reason_detail', 'affects', 'days_of_week',
    'last_edited_at', 'date_created', 'date_updated',
  ]
  await setPermRead(MEMBER_POLICY, 'participations', PARTICIPATION_VISIBLE, MEMBER_PARTICIPATION_FIELDS)
  // Absences stay on the narrower rule: a guest invitation is not a reason to read
  // someone's absence reasons, and the roster only needs their RSVP.
  await setPermRead(MEMBER_POLICY, 'absences', SAME_TEAM_AS_ME, MEMBER_ABSENCE_FIELDS)

  // ── Game guest invitations (migration 271) ──────────────────────
  // Read-only for members; the coach-side writes are on LEADER (§7). Visible to the
  // three parties with a stake in the invitation: the invitee, the game's own roster,
  // and the other guests (they appear in one merged roster, so they must resolve each
  // other). `game_guests` is also what `useUserVisibleGameIds` reads to decide whether
  // a game belongs on your home page — without member read there, nothing shows up.
  const GAME_GUEST_VISIBLE = {
    _or: [
      { member: { user: { _eq: '$CURRENT_USER' } } },
      { game: { kscw_team: { members: { member: { user: { _eq: '$CURRENT_USER' } } } } } },
      { game: { guests: { member: { user: { _eq: '$CURRENT_USER' } } } } },
    ],
  }
  await setPermRead(MEMBER_POLICY, 'game_guests', GAME_GUEST_VISIBLE)

  const GAME_GUEST_TEAM_VISIBLE = {
    _or: [
      { team: { members: { member: { user: { _eq: '$CURRENT_USER' } } } } },
      { game: { kscw_team: { members: { member: { user: { _eq: '$CURRENT_USER' } } } } } },
      { game: { guests: { member: { user: { _eq: '$CURRENT_USER' } } } } },
    ],
  }
  await setPermRead(MEMBER_POLICY, 'game_guest_teams', GAME_GUEST_TEAM_VISIBLE)

  // ── slot_claims — keep open for now (calendar UI relies on it),
  // public read removed in 035; member read still permissive per audit decision.
  await setPermRead(MEMBER_POLICY, 'slot_claims')

  // sv_vm_check — direct read REVOKED for KSCW Member (closes the audit's
  // last open Critical finding from 2026-05-06).
  //
  // Members access their own licence data through `GET /kscw/sv-licence/me`
  // which joins by license_nr → association_id and returns ONLY the 11
  // safe fields. Direct collection read would either leak every member's
  // licence row (no filter) or trigger Directus 11's `CASE WHEN 1` SQL bug
  // (with row filter). Custom endpoint side-steps both.
  //
  // No setPermRead call here — the absence is the point. Sport Admin and
  // higher tiers retain full CRUD via SPORT_ADMIN_FULL_CRUD below.

  // Members — limited fields for other members. PII (email/phone) excluded
  // (migration 024). Self-read row is added below with editable fields.
  await setPermRead(MEMBER_POLICY, 'members', null, MEMBER_VISIBLE_FIELDS)

  // Members — read own profile with expanded fields (editable fields must be readable).
  // `is_spielplaner` is read-only here (NOT in MEMBER_EDITABLE_FIELDS) so members
  // can see their own scheduling flag — the frontend nav gates the Spielplanung /
  // Terminplanung links on it (useAuth) — but cannot self-grant it.
  // Messaging consent + enablement state: own-row READ only. Written solely by
  // the /messaging/settings/* endpoints (admin ItemsService), so NOT member-
  // editable; and private, so NOT in MEMBER_VISIBLE_FIELDS (other members must
  // not see them). Without these on own-read, useAuth's `*` fetch got them
  // stripped → the ConsentModal ("Enable messaging?") read undefined and never
  // dismissed, and MessagingSettings / team-chat + DM gates read as disabled
  // even after opt-in (prod hotfix 2026-07-09).
  const MEMBER_OWN_MESSAGING_FIELDS = [
    'consent_decision', 'consent_prompted_at',
    'communications_team_chat_enabled', 'communications_dm_enabled', 'communications_banned',
  ]
  const MEMBER_OWN_READABLE = [...new Set([
    ...MEMBER_VISIBLE_FIELDS, ...MEMBER_EDITABLE_FIELDS, 'is_spielplaner',
    ...MEMBER_OWN_MESSAGING_FIELDS,
    // Trigger-derived, not member-writable (see MEMBER_DERIVED_READ_FIELDS).
    ...MEMBER_DERIVED_READ_FIELDS,
    // Licence workflow (migration 301) — the member reads where their own
    // licence stands; only staff and the sync write it.
    ...MEMBER_LICENCE_STATUS_READ_FIELDS,
  ])]
  await setPermRead(MEMBER_POLICY, 'members', OWN_USER, MEMBER_OWN_READABLE)

  // Members — update own profile (limited fields)
  await setPerm(MEMBER_POLICY, 'members', 'update', OWN_USER, MEMBER_EDITABLE_FIELDS)

  // Participations: read scope set above (SAME_TEAM_AS_ME); CRU below.
  // 2026-05-31 security audit: create was unfiltered, so any member could
  // POST a participation with `member` set to another member's id (mark a
  // teammate absent, vote/confirm as them, etc.). Self-scope create with
  // OWN_MEMBER so Directus validates `member` resolves to the caller.
  await setPerm(MEMBER_POLICY, 'participations', 'create', OWN_MEMBER)
  await setPerm(MEMBER_POLICY, 'participations', 'update', OWN_MEMBER)

  // Absences: read scope set above (SAME_TEAM_AS_ME); CUD below.
  // 2026-05-31 security audit: create was unfiltered — an unfiltered create
  // let any member POST a weekly/indefinite absence for a teammate, which
  // (via migration 038's auto-decline cascade) silently flipped all the
  // victim's confirmed RSVPs to declined. Self-scope create with OWN_MEMBER.
  await setPerm(MEMBER_POLICY, 'absences', 'create', OWN_MEMBER)
  await setPerm(MEMBER_POLICY, 'absences', 'update', OWN_MEMBER)
  await setPerm(MEMBER_POLICY, 'absences', 'delete', OWN_MEMBER)

  // Notifications — read/update/delete own
  await setPermRead(MEMBER_POLICY, 'notifications', OWN_MEMBER)
  await setPerm(MEMBER_POLICY, 'notifications', 'update', OWN_MEMBER)
  await setPerm(MEMBER_POLICY, 'notifications', 'delete', OWN_MEMBER)

  // ── Forms (migrations 086/087) ──────────────────────────────
  // Members see non-draft forms scoped to them (club-wide ∪ their teams) and
  // create/read their OWN submissions. Anonymous forms allow member = NULL.
  // The frontend resolves visibility via the two-step junction fetch
  // (useUserVisibleFormIds) — it must NOT deep-filter forms.teams while this
  // policy also walks it (the M2M-deep-filter + policy-walk silent-[] landmine).
  const FORMS_VISIBLE = {
    _and: [
      { status: { _in: ['open', 'closed'] } },
      {
        _or: [
          { audience: { _eq: 'club_wide' } },
          { teams: { teams_id: { members: { member: { user: { _eq: '$CURRENT_USER' } } } } } },
        ],
      },
    ],
  }
  await setPermRead(MEMBER_POLICY, 'forms', FORMS_VISIBLE)
  await setPermRead(MEMBER_POLICY, 'forms_teams')
  // Submissions: read own; create own OR anonymous (member = NULL). The _or
  // self-scope blocks posting a submission AS another member while still
  // allowing anonymous forms.
  const FORM_SUBMISSION_OWN = { member: { user: { _eq: '$CURRENT_USER' } } }
  await setPermRead(MEMBER_POLICY, 'form_submissions', FORM_SUBMISSION_OWN)
  await setPerm(MEMBER_POLICY, 'form_submissions', 'create', {
    _or: [{ member: { _null: true } }, { member: { user: { _eq: '$CURRENT_USER' } } }],
  })
  // Editable submissions (migration 088): a member may revise their own answers
  // while the form is open. Restricted to the `answers` field so they cannot
  // reassign a submission to another member or another form; the BEFORE UPDATE
  // guard additionally blocks edits once the form is closed / past deadline.
  await setPerm(MEMBER_POLICY, 'form_submissions', 'update', FORM_SUBMISSION_OWN, ['answers'])

  // Announcements (Vereinsnews) — published, non-expired, addressed to me.
  // Sport narrowing is additionally applied client-side in useAnnouncements;
  // teams/roles targeting is enforced here via the recipients junction.
  await setPermRead(MEMBER_POLICY, 'announcements', ANNOUNCEMENT_VISIBLE, ANNOUNCEMENT_READ_FIELDS)

  // Announcement recipients — read own rows only. This is what ANNOUNCEMENT_VISIBLE
  // walks; without a read row the relational filter matches nothing and a targeted
  // post stays invisible to the very member it was addressed to. Fields are limited
  // to the join keys: the delivery-log columns (email_error &c.) are admin-only.
  await setPermRead(MEMBER_POLICY, 'announcement_recipients', OWN_MEMBER, ['id', 'announcement', 'member'])

  // Push subscriptions — CRUD own. 2026-05-31 security audit: self-scope
  // create with OWN_MEMBER so a member can't register a push subscription
  // attributed to another member.
  await setPermRead(MEMBER_POLICY, 'push_subscriptions', OWN_MEMBER)
  await setPerm(MEMBER_POLICY, 'push_subscriptions', 'create', OWN_MEMBER)
  await setPerm(MEMBER_POLICY, 'push_subscriptions', 'update', OWN_MEMBER)
  await setPerm(MEMBER_POLICY, 'push_subscriptions', 'delete', OWN_MEMBER)

  // Member teams — directory-level cross-club read kept (migration 036).
  // `guest_level` stays readable: the FE's getGuestLevel() needs it on the
  // user's own rows, and cross-team visibility of guest_level is acceptable
  // (it's already implicit in roster cards). The 2026-05-06 audit raised it
  // as Low; we explicitly accept that read scope and document in SECURITY.md.
  await setPermRead(MEMBER_POLICY, 'member_teams')
  // Members may leave a team they're on (self-scoped delete of own row).
  // Joining still requires coach approval via team_requests; leaving is
  // self-service. Same op coaches already perform via RosterEditor.
  await setPerm(MEMBER_POLICY, 'member_teams', 'delete', OWN_MEMBER)

  // Blocks — see only my own outgoing blocks (incoming blocks stay opaque)
  // (migration 042).
  await setPermRead(MEMBER_POLICY, 'blocks', { blocker: { user: { _eq: '$CURRENT_USER' } } })

  // Message requests — read own (recipient or sender). Added 2026-05-19:
  // never granted when messaging went GA (v4.0.0), so every member's inbox
  // useMessageRequests() fetchAllItems + realtime sub 403'd silently
  // ("no permission to access collection message_requests"). Like `blocks`
  // this is the rare messaging collection read DIRECTLY by the FE (the rest
  // route through server-side /messaging/* endpoints). sender/recipient are
  // members FKs → walk `.user` to $CURRENT_USER, same shape as blocks.
  // accept/decline go via kscw endpoints, so read-only is sufficient.
  await setPermRead(MEMBER_POLICY, 'message_requests', {
    _or: [
      { recipient: { user: { _eq: '$CURRENT_USER' } } },
      { sender: { user: { _eq: '$CURRENT_USER' } } },
    ],
  }, ['id', 'conversation', 'sender', 'recipient', 'status', 'created_at', 'resolved_at'])

  // Messages + reactions — READ ONLY, and ONLY to make realtime deliver.
  //
  // This is the same bug as `message_requests` above, one collection over. Directus
  // does not push the raw mutation row to a subscriber: on a change it RE-READS the row
  // through ItemsService with the SUBSCRIBER's accountability (websocket/utils/items.ts
  // → getItemsPayload → service.readMany). With no read grant, that read returns nothing
  // and the socket delivers nothing — the subscription is established and permanently
  // silent. So live chat cannot work without a read row here, no matter what the
  // frontend does. Confirmed against the live dev socket 2026-07-13.
  //
  // Filters are migration 023's, unchanged: walk the parent conversation's members
  // junction to $CURRENT_USER. A member sees exactly the messages in conversations they
  // belong to — the same rows /kscw/messaging/* already returns them, so this grants no
  // new data, only a new delivery path.
  //
  // ⚠ Do NOT add a frontend items-API filter that also walks `conversation.members`.
  // Directus cannot AND two filter expressions through the same M2M junction and will
  // silently return [] for non-admins (CLAUDE.md → "M2M deep filter + policy walk").
  // Today nothing does: every messaging read goes through the /kscw endpoints (raw knex),
  // and realtime sends no filter of its own. Keep it that way.
  //
  // Writes stay endpoint-only (send/edit/delete/report all run through /kscw/messaging/*,
  // which enforce membership, blocks, and rate limits). Read-only here is sufficient and
  // is the smallest grant that restores live chat.
  //
  // NB: this does NOT grant /items/conversations — SECURITY.md:143 keeps that off
  // deliberately, and the smoke test probes /kscw/messaging/conversations instead.
  // Conversation-list updates piggyback on the `messages` subscription.
  // `archived: false` is NOT cosmetic — it mirrors the endpoint. loadConversationMembership()
  // (messaging-helpers.js:78) throws 403 messaging/not_a_member when the caller's
  // conversation_members row is archived, so an archived conversation is fully inaccessible
  // through /kscw/messaging/*. Without this clause the items API would be MORE permissive
  // than the endpoint it mirrors, which is how read grants quietly become leaks. And it is
  // not an edge case: 1336 of 1439 membership rows on prod are archived.
  const MY_ACTIVE_MEMBERSHIP = {
    member: { user: { _eq: '$CURRENT_USER' } },
    archived: { _eq: false },
  }
  await setPermRead(MEMBER_POLICY, 'messages', {
    conversation: { members: MY_ACTIVE_MEMBERSHIP },
  }, ['id', 'conversation', 'sender', 'type', 'body', 'poll', 'created_at', 'edited_at', 'deleted_at'])

  // original_body is deliberately NOT in the field list above: it is the pre-edit text,
  // kept for moderation, and no member-facing view renders it.
  await setPermRead(MEMBER_POLICY, 'message_reactions', {
    message: { conversation: { members: MY_ACTIVE_MEMBERSHIP } },
  }, ['id', 'message', 'member', 'emoji', 'created_at'])

  // Polls have TWO parents — the DB codifies both in `chk_polls_team_or_conversation`
  // — so a single-parent filter would silently hide one half. Until 2026-08-10
  // this was an UNFILTERED read (audit 2026-08-08, finding 8): any member could
  // `GET /items/polls?filter[conversation][_nnull]=true` and read the question,
  // options, deadline and author of every DM and group-chat poll in the club.
  //
  // That defeated the boundary built 300 lines above: `messages` and
  // `message_reactions` are scoped to `conversation.members` with a field
  // allow-list, so the poll MESSAGE was unreadable while the poll CONTENT it
  // points at was not. Voter identity was never exposed (`poll_votes` is
  // OWN_MEMBER-scoped and /poll-results checks membership) — only the question.
  //
  // Reuses MY_ACTIVE_MEMBERSHIP so a chat poll follows exactly the same
  // archived-aware rule as the message carrying it.
  await setPermRead(MEMBER_POLICY, 'polls', {
    _or: [
      { team: { members: { member: { user: { _eq: '$CURRENT_USER' } } } } },
      { conversation: { members: MY_ACTIVE_MEMBERSHIP } },
    ],
  })

  // Spielplaner assignments — self-scoped (migrations 034, 042).
  await setPermRead(MEMBER_POLICY, 'spielplaner_assignments', OWN_MEMBER)

  // Scorer delegations — read/create/update own. 2026-05-31 security audit:
  // create was unfiltered, letting a member fabricate a delegation FROM a
  // teammate. Self-scope create on `from_member` (the delegating side).
  // 2026-07-02 audit (#3, HIGH): the update grant was `fields:['*']`, so a
  // member who is a party to a delegation could PATCH `from_member`/`to_member`/
  // `game`/`role` (identity of the transfer) and flip `status='accepted'`,
  // driving the delegation-transfer hook to reassign someone else's LEADER-only
  // scorer/timekeeper duty (migration 148 only forces status on INSERT). The
  // ONLY legitimate item-API update is the recipient's accept, so the update is
  // now restricted to `status`; migration 163 makes the identity columns
  // immutable at the DB layer as a backstop.
  await setPermRead(MEMBER_POLICY, 'scorer_delegations', OWN_DELEGATION)
  await setPerm(MEMBER_POLICY, 'scorer_delegations', 'create', OWN_DELEGATION_FROM)
  await setPerm(MEMBER_POLICY, 'scorer_delegations', 'update', OWN_DELEGATION, ['status'])

  // Team invites — read own
  await setPermRead(MEMBER_POLICY, 'team_invites', { member: { user: { _eq: '$CURRENT_USER' } } })

  // User logs — create + read own
  await setPerm(MEMBER_POLICY, 'user_logs', 'create')
  await setPermRead(MEMBER_POLICY, 'user_logs', OWN_DU)

  // `households` / `household_members` / `member_guardians` (migration 348) —
  // NO Member grant at all, and that absence is deliberate, not an oversight.
  // The account switcher reads GET /kscw/household/me, a custom endpoint, so
  // the Member policy needs zero rows here. That is the point: dev has been
  // keyless since 2026-07-15, so a filtered permission added here could be
  // neither written nor evaluated before it reached prod. Revoking one's own
  // guardian link goes through DELETE /kscw/household/:id/members/:hmId, which
  // authorises the member herself server-side.
  // ⚠ If a future change is tempted to expose these via /items, note that a
  // read filter walking household_members → members would be a deep-M2M policy
  // walk of exactly the shape that returns a silent [] for non-admins.

  // Feedback — create + read own (migration 043 scoped read by submitter email).
  await setPerm(MEMBER_POLICY, 'feedback', 'create')
  await setPermRead(MEMBER_POLICY, 'feedback', { email: { _eq: '$CURRENT_USER.email' } })

  // Tasks — read scope mirrors update (migration 043).
  // Tasks + carpools retired 2026-07-27 (migration 257) — never used in a full
  // season; tables dropped, all grants removed.

  // Polls — vote. 2026-05-31 security audit: create was unfiltered, letting a
  // member cast a vote attributed to another member. Self-scope with OWN_MEMBER.
  await setPermRead(MEMBER_POLICY, 'poll_votes', OWN_MEMBER)
  await setPerm(MEMBER_POLICY, 'poll_votes', 'create', OWN_MEMBER)
  await setPerm(MEMBER_POLICY, 'poll_votes', 'update', OWN_MEMBER)

  // Team requests — create, read own. 2026-05-31 security audit: create was
  // unfiltered, letting a member file a join request on behalf of another
  // member. Self-scope create on `member` so only own requests can be created.
  await setPerm(MEMBER_POLICY, 'team_requests', 'create', { member: { user: { _eq: '$CURRENT_USER' } } })
  await setPermRead(MEMBER_POLICY, 'team_requests', { member: { user: { _eq: '$CURRENT_USER' } } })

  // Fines (migration 069) — members see their own fines (across all teams) and
  // the fine rules of teams they're on (so they can see the upcoming amount
  // before getting fined). Read-only — only leaders may create/waive/mark-paid.
  // Filter walks: fines.member.user (own fines) — different alias from any
  // frontend filter (FE uses `{ member: { _eq: myId } }`) so the M2M
  // double-walk trap doesn't apply.
  //
  // Second branch = TEAM-level fines (`member IS NULL`, migration 350). 350 left
  // them leader-only, which meant a team owing CHF 50 out of the Teamkasse was
  // invisible to the team: no bell, no push (both actions bail on a member-less
  // row), no row on /fines. The team pays it, so the team must be able to see
  // it. Scoped to teams the reader is ON — same `team.members.member.user` walk
  // `fine_rules` below already uses (`members` is the o2m junction alias on
  // teams). Personal balances are untouched: the row still has no `member`, so
  // it never lands in anybody's own total — the frontend sums the two branches
  // separately (YourFinesCard).
  await setPermRead(MEMBER_POLICY, 'fines', {
    _or: [
      { member: { user: { _eq: '$CURRENT_USER' } } },
      {
        _and: [
          { member: { _null: true } },
          { team: { members: { member: { user: { _eq: '$CURRENT_USER' } } } } },
        ],
      },
    ],
  })
  await setPermRead(MEMBER_POLICY, 'fine_rules', {
    // `members` is the o2m alias on teams (each row is a member_teams junction);
    // `teams.member_teams` is NOT a relational field → "Invalid query" that
    // broke fine_rules reads on the home page + roster editor for everyone.
    team: { members: { member: { user: { _eq: '$CURRENT_USER' } } } },
  })

  // Scheduling blocks (migration 085) — team blackout dates. Read-only for
  // members so the team absence calendar can render them as overlays. UNFILTERED
  // on purpose: the frontend filters by `{ team: { _in: [...] } }`, and a member
  // read filter that ALSO walked `team.members` would hit the M2M double-walk
  // trap (silent empty for non-admin). Blackout dates aren't sensitive (no PII),
  // so club-wide read is acceptable. Create/update/delete stay coach/TR-only.
  await setPermRead(MEMBER_POLICY, 'scheduling_blocks')

  // Team links (migration 218) — club-wide READ so scheduling-calendar link warnings
  // render for every viewer (spielplaner + members), not just admins. Not sensitive
  // (just team↔team relationships, no PII). Create/update/delete stay Sport-Admin-only
  // via SPORT_ADMIN_FULL_CRUD.
  await setPermRead(MEMBER_POLICY, 'team_links')

  // Finance (migration 114) — members see ONLY their own invoices/dues
  // (mirrored from ClubDesk), read-only, field-scoped to the dues columns.
  // Filter walks finance_invoices.member.user → $CURRENT_USER (same shape as
  // fines; the FE filters by `{ member: { _eq: myId } }`, a different alias, so
  // the M2M double-walk trap doesn't apply). The ledger / accounts / all-invoices
  // / budget stay board-only (Vorstand read-all below). No write perms — the
  // ClubDesk import writes via the system connection, not the items API.
  await setPermRead(MEMBER_POLICY, 'finance_invoices', { member: { user: { _eq: '$CURRENT_USER' } } }, MEMBER_INVOICE_FIELDS)
  // Pay-outs / reimbursements the club owes this member (migration 137) — own only.
  await setPermRead(MEMBER_POLICY, 'finance_payouts', OWN_MEMBER)
  // Expense submissions (migration 177) — own only, read-only; the member writes
  // via POST /kscw/expenses/submit, status changes via PATCH /kscw/expenses/:id
  // (finance-gated), never the items API. Field-scoped like finance_invoices so
  // the internal actor columns (status_changed_by_name/email, user_created) stay
  // endpoint-only and aren't readable via /items/finance_expenses.
  await setPermRead(MEMBER_POLICY, 'finance_expenses', OWN_MEMBER, [
    'id', 'member', 'file', 'amount', 'currency', 'expense_date', 'vendor',
    'description', 'reference', 'pay_to_iban', 'member_note', 'status',
    'finance_note', 'payout', 'status_changed_at', 'date_created',
  ])

  // Files — create (upload profile pics)
  await setPerm(MEMBER_POLICY, 'directus_files', 'create')

  console.log(`  ✓ Member permissions set`)

  // ── 7. Team Responsible permissions (additive to Member) ────────────

  console.log('\n7. Team Responsible permissions...')

  // Cleared here (immediately before recreate), not in the up-front §4 block —
  // see the note there. A TR user keeps their Member-policy perms (rebuilt in
  // §6) intact while only the additive TR layer is briefly empty.
  await clearPolicyPermissions(LEADER_POLICY, 'Team Responsible')

  // ── LEADER scope shapes ────────────────────────────────────────
  // Defined here, at the top of the section, because `const` is not hoisted:
  // these are referenced by grants further down and a definition placed beside
  // its *last* use would throw a ReferenceError from the temporal dead zone on
  // the first one. Keep new shapes in this block.
  const COACH_OF_TEAM_FK = { team: { coach: { members_id: { user: { _eq: '$CURRENT_USER' } } } } }
  const COACH_OF_SLOT_CLAIM = { claimed_by_team: { coach: { members_id: { user: { _eq: '$CURRENT_USER' } } } } }
  /** A team FK (not a junction) pointing at a team I coach or am TR for. */
  const TEAM_FK_I_LEAD = {
    team: {
      _or: [
        { coach: { members_id: { user: { _eq: '$CURRENT_USER' } } } },
        { team_responsible: { members_id: { user: { _eq: '$CURRENT_USER' } } } },
      ],
    },
  }
  const INVITE_OF_TEAM_I_LEAD = TEAM_FK_I_LEAD
  /** Team polls only — `_nnull` keeps chat polls (team null) out entirely. */
  const POLL_OF_TEAM_I_LEAD = { _and: [{ team: { _nnull: true } }, TEAM_FK_I_LEAD] }
  /** `hall_slots` has no team column; teams hang off the `teams` M2M alias. */
  const SLOT_OF_TEAM_I_LEAD = {
    teams: {
      teams_id: {
        _or: [
          { coach: { members_id: { user: { _eq: '$CURRENT_USER' } } } },
          { team_responsible: { members_id: { user: { _eq: '$CURRENT_USER' } } } },
        ],
      },
    },
  }
  /** Everything except the bearer token. */
  const TEAM_INVITE_LEADER_FIELDS = [
    'id', 'guest_level', 'status', 'expires_at', 'team',
    'invited_by', 'claimed_by', 'date_created', 'date_updated',
  ]

  const JUNCTION_OF_TEAM_I_LEAD = {
    teams_id: {
      _or: [
        { coach: { members_id: { user: { _eq: '$CURRENT_USER' } } } },
        { team_responsible: { members_id: { user: { _eq: '$CURRENT_USER' } } } },
      ],
    },
  }



  // Members — scoped full-field read for members on teams I coach or TR.
  // 2026-05-12 audit: replaced unfiltered `setPermRead(LEADER_POLICY, 'members')`
  // which exposed every member's `ahv_nummer`, `adresse`, `birthdate`, etc. to
  // every historical coach across the entire club. With the v4.8.1 per-user
  // policy backfill this was effectively a club-wide PII dump.
  //
  // Out-of-team members remain visible via the MEMBER policy's
  // `MEMBER_VISIBLE_FIELDS` whitelist (no email/phone/PII). In-team members
  // are visible via this LEADER row with the contact fields coaches need
  // (email/phone/address/birthdate) but explicitly NOT `ahv_nummer` (Swiss
  // social security) or `iban` (bank account) — sensitive financial PII coaches
  // have no operational need for.
  // ⚠ `active: true` — the coach/TR junctions are CLONED (not moved) on rollover
  // and the member's own roster row is left on the archived team, so an unguarded
  // walk means "every player I ever coached, forever". That leaked live email +
  // phone + adresse (LEADER_TEAM_MEMBER_FIELDS) and granted PATCH of position /
  // number / coach_approved_team over 161 stale (member, archived-team) pairs —
  // 39 of those members are on no active team at all. Unlike teams/trainings,
  // where reads stay unscoped so a coach can browse an archived team's HISTORY,
  // these rows are the person's LIVE record: reading an ex-player's current
  // phone number is not history. Reads are gated too, deliberately.
  const COACH_TEAM_MEMBERS = {
    member_teams: {
      team: {
        active: { _eq: true },
        _or: [
          { coach: { members_id: { user: { _eq: '$CURRENT_USER' } } } },
          { team_responsible: { members_id: { user: { _eq: '$CURRENT_USER' } } } },
        ],
      },
    },
  }
  // ⚠ This list ALSO spreads MEMBER_DERIVED_READ_FIELDS, so anything added there
  // for own-read reaches every coach/TR for their team's members unless excluded
  // here. `beitragskategorie` is own-read only (finding 39): what a player pays
  // is between them and the club, not something their coach needs — the same
  // reasoning that already strips ahv_nummer and iban from this list.
  const LEADER_TEAM_MEMBER_FIELDS = [
    ...new Set([...MEMBER_VISIBLE_FIELDS, ...MEMBER_EDITABLE_FIELDS, ...MEMBER_DERIVED_READ_FIELDS]),
  // ⚠ This list is DERIVED — anything added to MEMBER_EDITABLE_FIELDS becomes
  // coach/TR-readable for their own team members BY DEFAULT. That is usually
  // right (a coach reads their players' phone, address, birthdate) but it is a
  // widening that happens without anybody writing a line here, so a new column
  // whose audience should stop at the member and the office has to be named in
  // this filter. `kantonsschule` (migration 315) is such a column: which school
  // somebody attends was not asked for on a coach's behalf, and ~40 coaches is
  // a real widening. One line to reverse if the club decides otherwise.
  ].filter(f => !['ahv_nummer', 'iban', 'beitragskategorie', 'kantonsschule'].includes(f))
  await setPermRead(LEADER_POLICY, 'members', COACH_TEAM_MEMBERS, LEADER_TEAM_MEMBER_FIELDS)
  // Members — update position + number (migration 036 scoped to my-team members).
  // `coach_approved_team` added 2026-05-19: migration 036 narrowed this list to
  // ['position','number'] and silently broke coach/TR join-request approval
  // (TeamDetail.handleApprove writes { coach_approved_team: true }). Row scope
  // (COACH_TEAM_MEMBERS) + the member_teams-must-exist-first PG trigger keep
  // this safe — a coach can only flip the flag for their own team's members.
  await setPerm(LEADER_POLICY, 'members', 'update', COACH_TEAM_MEMBERS, ['position', 'number', 'coach_approved_team'])

  // Reject a pending signup (TeamDetail.handleReject) writes
  // { kscw_membership_active:false, wiedisync_active:false, requested_team:null }
  // on a member who has NOT been approved yet — so they have no member_teams
  // row and COACH_TEAM_MEMBERS above can't match. Scope this second update row
  // by the signup's `requested_team` instead: a coach/TR may reject only
  // members who requested a team they lead. Directus unions update rows, so a
  // pending signup matches THIS row's fields while real roster members match
  // the COACH_TEAM_MEMBERS row's fields. (requested_team is M2O members→teams.)
  const COACH_REQUESTED_TEAM = {
    requested_team: {
      _or: [
        { coach: { members_id: { user: { _eq: '$CURRENT_USER' } } } },
        { team_responsible: { members_id: { user: { _eq: '$CURRENT_USER' } } } },
      ],
    },
  }
  await setPerm(LEADER_POLICY, 'members', 'update', COACH_REQUESTED_TEAM, ['kscw_membership_active', 'wiedisync_active', 'requested_team'])

  // Third update row: STAFF-ONLY people on a team I lead. A coach/TR who has no
  // `member_teams` row for the team they coach (38 people across 25 active teams
  // on 2026-08-20) is invisible to COACH_TEAM_MEMBERS above, yet TeamDetail's
  // Staff section renders them from a separate fetch (`extraCoaches`) with the
  // same editable number + position cells as any roster row. Every such edit
  // 403'd and MemberRow.saveField swallowed it, so the value silently snapped
  // back — reported as "I can't change my players" by D2's (volleyball) coach.
  // Walks the member SIDE of each staff junction, named by migration 331
  // (`members.coach_of` / `members.team_responsible_of`); before that migration
  // there was no path from a member to the teams they are staff of.
  // Fields stay ['position','number'] — the only two MemberRow.saveField writes.
  // Deliberately NOT `coach_approved_team`: approval is a roster act and
  // TeamDetail.handleApprove creates the member_teams row first, which puts the
  // target inside COACH_TEAM_MEMBERS anyway.
  const COACH_TEAM_STAFF_SCOPE = {
    teams_id: {
      active: { _eq: true },
      _or: [
        { coach: { members_id: { user: { _eq: '$CURRENT_USER' } } } },
        { team_responsible: { members_id: { user: { _eq: '$CURRENT_USER' } } } },
      ],
    },
  }
  const COACH_TEAM_STAFF = {
    _or: [
      { coach_of: COACH_TEAM_STAFF_SCOPE },
      { team_responsible_of: COACH_TEAM_STAFF_SCOPE },
    ],
  }
  await setPerm(LEADER_POLICY, 'members', 'update', COACH_TEAM_STAFF, ['position', 'number'])

  // Coach Dashboard prefs — explicit read for Leader (Coach/TR).
  // PUBLIC_TEAM_FIELDS doesn't include these, so KSCW Member never sees them.
  await setPermRead(LEADER_POLICY, 'teams', null, LEADER_TEAM_DASHBOARD_FIELDS)

  // Teams — update scoped (migration 043). Coach ↔ team via teams.coach M2M;
  // Team Responsible ↔ team via teams.team_responsible M2M.
  // active=true: a coach/TR keeps READ access to an archived team (history) but
  // cannot mutate it. Coach/TR junctions are cloned (not moved) on rollover, so
  // without this gate a coach retains write access to every past season's team.
  await setPerm(LEADER_POLICY, 'teams', 'update', {
    active: { _eq: true },
    _or: [
      { coach: { members_id: { user: { _eq: '$CURRENT_USER' } } } },
      { team_responsible: { members_id: { user: { _eq: '$CURRENT_USER' } } } },
    ],
  })

  // Games — update scoped to coach/TR of the game's `kscw_team`.
  // 2026-05-12 audit: previously unfiltered — every coach in the club could
  // PATCH any game (scores, duty assignments, `auto_confirm_rsvp`) including
  // for teams they had no relationship to.
  //
  // 2026-07-13 (migration 206): FIELD-scoped as well as row-scoped. The grant used
  // to take the `fields = ['*']` default, which would hand coaches write access to
  // the `vm_nomination_*` Einsatzliste push journal the backend cron owns — letting
  // a coach mark their own game `closed` and silently suppress its VM push.
  // GAME_WRITE_FIELDS is every games column EXCEPT that journal, so a coach keeps
  // every write they had (scores, duties, `auto_confirm_rsvp`) and gains the new
  // per-game opt-in `auto_nomination_list`, while the journal is read-only to them.
  // READ of all six new columns needs no grant here — the Member policy already
  // reads `games` club-wide with fields `*` (§6 MEMBER_READ_ALL), and coaches hold
  // the Member policy too. See the GAME_WRITE_FIELDS header for the full rationale.
  await setPerm(LEADER_POLICY, 'games', 'update', {
    kscw_team: {
      active: { _eq: true },
      _or: [
        { coach: { members_id: { user: { _eq: '$CURRENT_USER' } } } },
        { team_responsible: { members_id: { user: { _eq: '$CURRENT_USER' } } } },
      ],
    },
  }, GAME_WRITE_FIELDS)

  // Trainings — coach can read/CRU/delete trainings of teams they coach or TR.
  // Read scope is required because the Member fallback policy only grants
  // trainings.read to users present in `member_teams` of the team — a coach
  // who is not also a player on their own team (common: Vorstand coaches,
  // retired/parent coaches) would otherwise see no trainings at all.
  const COACH_OR_TR_OF_TEAM = {
    _or: [
      { team: { coach: { members_id: { user: { _eq: '$CURRENT_USER' } } } } },
      { team: { team_responsible: { members_id: { user: { _eq: '$CURRENT_USER' } } } } },
    ],
  }
  // Writes additionally require the team to be active. Reads stay unscoped so a
  // coach can still see an archived team's past trainings as history, but can't
  // mutate them (their coach/TR junction lingers on the archived team post-rollover).
  const COACH_OR_TR_OF_ACTIVE_TEAM = {
    _or: [
      { team: { active: { _eq: true }, coach: { members_id: { user: { _eq: '$CURRENT_USER' } } } } },
      { team: { active: { _eq: true }, team_responsible: { members_id: { user: { _eq: '$CURRENT_USER' } } } } },
    ],
  }
  await setPermRead(LEADER_POLICY, 'trainings', COACH_OR_TR_OF_TEAM)
  await setPerm(LEADER_POLICY, 'trainings', 'create')
  // 2026-05-12 audit: update was unfiltered; scope to coach/TR of the
  // training's team like read/delete already are. 2026-06-09: active-gated.
  await setPerm(LEADER_POLICY, 'trainings', 'update', COACH_OR_TR_OF_ACTIVE_TEAM)
  await setPerm(LEADER_POLICY, 'trainings', 'delete', COACH_OR_TR_OF_ACTIVE_TEAM)

  // Events — coach can read/CRU/delete events of teams they coach or TR,
  // plus club-wide events, plus events they created, plus events they were
  // personally invited to. Mirrors the Member read policy (migration 033)
  // but adds the coach/TR M2M traversal.
  // Hoisted to a const because `participations` read reuses it verbatim below
  // (migration 333) — a leader reads the RSVPs of any event they can see, and
  // the two rules must not drift apart.
  const LEADER_EVENTS_VISIBLE = {
    _or: [
      { created_by: { user: { _eq: '$CURRENT_USER' } } },
      { event_type: { _in: ['verein', 'tournament'] } },
      { teams: { teams_id: { coach: { members_id: { user: { _eq: '$CURRENT_USER' } } } } } },
      { teams: { teams_id: { team_responsible: { members_id: { user: { _eq: '$CURRENT_USER' } } } } } },
      // Player branch: same active gate as the Member policy's copy above.
      { teams: { teams_id: { active: { _eq: true }, members: { member: { user: { _eq: '$CURRENT_USER' } } } } } },
      { invited_members: { members_id: { user: { _eq: '$CURRENT_USER' } } } },
    ],
  }
  await setPermRead(LEADER_POLICY, 'events', LEADER_EVENTS_VISIBLE)
  await setPerm(LEADER_POLICY, 'events', 'create')
  // 2026-05-12 audit: update was unfiltered; scope to creator OR coach/TR of
  // an invited team (mirrors the delete filter below).
  await setPerm(LEADER_POLICY, 'events', 'update', {
    _or: [
      { created_by: { user: { _eq: '$CURRENT_USER' } } },
      { teams: { teams_id: { coach: { members_id: { user: { _eq: '$CURRENT_USER' } } } } } },
      { teams: { teams_id: { team_responsible: { members_id: { user: { _eq: '$CURRENT_USER' } } } } } },
    ],
  })
  await setPerm(LEADER_POLICY, 'events', 'delete', {
    _or: [
      { created_by: { user: { _eq: '$CURRENT_USER' } } },
      { teams: { teams_id: { coach: { members_id: { user: { _eq: '$CURRENT_USER' } } } } } },
      { teams: { teams_id: { team_responsible: { members_id: { user: { _eq: '$CURRENT_USER' } } } } } },
    ],
  })
  await setPerm(LEADER_POLICY, 'event_sessions', 'create')
  await setPerm(LEADER_POLICY, 'event_sessions', 'update')
  // events_teams — create unfiltered (no row yet, gated by the create hook);
  // update/delete scoped so a leader cannot re-target another team's event.
  await setPerm(LEADER_POLICY, 'events_teams', 'create')
  await setPerm(LEADER_POLICY, 'events_teams', 'update', JUNCTION_OF_TEAM_I_LEAD)
  await setPerm(LEADER_POLICY, 'events_teams', 'delete', JUNCTION_OF_TEAM_I_LEAD)

  // Forms (migrations 086/087) — coach/TR author forms for teams they coach/TR,
  // plus read club-wide forms + forms they created. Mirrors the events block
  // above with the coach/TR M2M traversal. update/delete scoped to creator or
  // coach/TR of an attached team. They read submissions of forms in their scope.
  const FORMS_LEADER_SCOPE = {
    _or: [
      { created_by: { user: { _eq: '$CURRENT_USER' } } },
      { teams: { teams_id: { coach: { members_id: { user: { _eq: '$CURRENT_USER' } } } } } },
      { teams: { teams_id: { team_responsible: { members_id: { user: { _eq: '$CURRENT_USER' } } } } } },
    ],
  }
  await setPermRead(LEADER_POLICY, 'forms', {
    _or: [{ audience: { _eq: 'club_wide' } }, ...FORMS_LEADER_SCOPE._or],
  })
  await setPerm(LEADER_POLICY, 'forms', 'create')
  await setPerm(LEADER_POLICY, 'forms', 'update', FORMS_LEADER_SCOPE)
  await setPerm(LEADER_POLICY, 'forms', 'delete', FORMS_LEADER_SCOPE)
  await setPermRead(LEADER_POLICY, 'forms_teams')
  await setPerm(LEADER_POLICY, 'forms_teams', 'create')
  await setPerm(LEADER_POLICY, 'forms_teams', 'update')
  await setPerm(LEADER_POLICY, 'forms_teams', 'delete')
  await setPermRead(LEADER_POLICY, 'form_submissions', { form: FORMS_LEADER_SCOPE })

  // Sponsors — coach/TR manage sponsors of teams they coach/TR (the sponsor
  // editor lives inside the roster editor, gated by isCoachOf). update/delete
  // scoped via the teams_sponsors M2M; create is unfiltered (Directus can't
  // enforce a relational filter on CREATE — see the setPerm note — and the UI
  // attaches the team). READ stays UNFILTERED on purpose: the editor's
  // fetchSponsors already filters by `teams.teams_id`, and a policy read filter
  // walking the same M2M would AND two expressions through one junction →
  // silent empty for non-admins (the M2M-deep-filter gotcha). Sponsors are
  // club-readable anyway (MEMBER_READ_ALL).
  const SPONSORS_LEADER_SCOPE = {
    _or: [
      { teams: { teams_id: { coach: { members_id: { user: { _eq: '$CURRENT_USER' } } } } } },
      { teams: { teams_id: { team_responsible: { members_id: { user: { _eq: '$CURRENT_USER' } } } } } },
    ],
  }
  await setPermRead(LEADER_POLICY, 'sponsors')
  await setPerm(LEADER_POLICY, 'sponsors', 'create')
  await setPerm(LEADER_POLICY, 'sponsors', 'update', SPONSORS_LEADER_SCOPE)
  await setPerm(LEADER_POLICY, 'sponsors', 'delete', SPONSORS_LEADER_SCOPE)
  await setPermRead(LEADER_POLICY, 'teams_sponsors')
  await setPerm(LEADER_POLICY, 'teams_sponsors', 'create')
  await setPerm(LEADER_POLICY, 'teams_sponsors', 'update')
  await setPerm(LEADER_POLICY, 'teams_sponsors', 'delete')

  // Participations — read + update scoped to members on teams I coach/TR
  // (plus own row). 2026-05-12 audit: was unfiltered full-club RSVP dump.
  // Filter walks: participation.member → member.member_teams.team.{coach|TR}.
  const COACH_OR_TR_OF_PARTICIPATION = {
    _or: [
      { member: { user: { _eq: '$CURRENT_USER' } } },
      // ⚠ active: true — without it this keys on the MEMBER, so a lingering
      // roster row on an archived team handed an ex-coach read, update AND
      // delete over that member's CURRENT-season RSVPs, unbounded in time.
      { member: { member_teams: { team: { active: { _eq: true }, coach: { members_id: { user: { _eq: '$CURRENT_USER' } } } } } } },
      { member: { member_teams: { team: { active: { _eq: true }, team_responsible: { members_id: { user: { _eq: '$CURRENT_USER' } } } } } } },
      // Guests of a game I lead (migration 271). They are on no team of mine, so the
      // member_teams branches above miss them and the coach — the one person who has
      // to pick the squad — would read a roster with the borrowed players blank.
      // Narrowed to game RSVPs: lending me a player for one Saturday does not open
      // their trainings and events to me.
      {
        _and: [
          { activity_type: { _eq: 'game' } },
          {
            member: {
              game_guests: {
                game: {
                  kscw_team: {
                    _or: [
                      { coach: { members_id: { user: { _eq: '$CURRENT_USER' } } } },
                      { team_responsible: { members_id: { user: { _eq: '$CURRENT_USER' } } } },
                    ],
                  },
                },
              },
            },
          },
        ],
      },
    ],
  }
  // READ is wider than update/delete (migration 333): a leader sees the whole
  // roster of any event they can see — same one-sentence rule as the Member
  // policy — but may still only EDIT the RSVPs of their own people. Sharing a
  // club tournament with H3 is not a mandate over H3's answers, so the write
  // rules below stay on COACH_OR_TR_OF_PARTICIPATION.
  const COACH_OR_TR_PARTICIPATION_READ = {
    _or: [
      ...COACH_OR_TR_OF_PARTICIPATION._or,
      { _and: [{ activity_type: { _eq: 'event' } }, { event: { _and: [{ open_roster: { _eq: true } }, LEADER_EVENTS_VISIBLE] } }] },
    ],
  }
  // ⚠⚠ NARROWED 2026-08-26 alongside the Member rule — same stopgap, same reason.
  // The captured prod SQL carried BOTH policies' predicates OR-ed together, so
  // narrowing only the Member side would have left the cross-product intact for
  // anyone holding LEADER. Drops the two relation-walking branches from READ:
  // the event-roster branch (migration 333) and the game-guest branch
  // (migration 271, `member.game_guests.game.kscw_team.{coach,team_responsible}`).
  // ⚠ update/delete deliberately keep the FULL `COACH_OR_TR_OF_PARTICIPATION`
  // below — a write filter is evaluated against one target row, so it costs
  // nothing, and narrowing writes would silently strip coaches of RSVP edits.
  // That does mean a leader can currently update a guest's game RSVP they can no
  // longer read; restoring the parked rule closes that gap again.
  // STAGE 1 (26.08.2026): the event-roster branch is restored here too, mirroring the
  // Member rule — the captured prod SQL carried BOTH policies' predicates OR-ed
  // together, so a leader on the narrowed rule would still not see a club tournament's
  // roster even though every player could. The game-guest branch stays parked.
  // The event branch hands `LEADER_EVENTS_VISIBLE` to the SAME object the `events` read
  // rule uses, so event visibility and roster visibility cannot drift apart (mig 333).
  const COACH_OR_TR_PARTICIPATION_READ_NARROWED = {
    _or: [
      { member: { user: { _eq: '$CURRENT_USER' } } },
      { member: { member_teams: { team: { active: { _eq: true }, coach: { members_id: { user: { _eq: '$CURRENT_USER' } } } } } } },
      { member: { member_teams: { team: { active: { _eq: true }, team_responsible: { members_id: { user: { _eq: '$CURRENT_USER' } } } } } } },
      { _and: [{ activity_type: { _eq: 'event' } }, { event: { _and: [{ open_roster: { _eq: true } }, LEADER_EVENTS_VISIBLE] } }] },
      // STAGE 2 (migration 341): the guest branch, materialised. The junction's
      // audience already includes the host team's coaches and TRs, so this is the
      // SAME alias the Member rule walks — one definition, no drift between policies.
      // Replaces `member.game_guests.game.kscw_team.{coach,team_responsible}`, which
      // cost 254× as a filter and +3% as this.
      GUEST_ROSTER_VISIBLE,
    ],
  }
  await setPermRead(LEADER_POLICY, 'participations', COACH_OR_TR_PARTICIPATION_READ_NARROWED)
  // ⚠ update/delete still carry the FULL COACH_OR_TR_OF_PARTICIPATION, whose guest
  // branch is broader than this read branch (whole-person vs per-fixture). A write
  // filter matches one row so it costs nothing, but it does mean a coach can still
  // edit a guest RSVP on a fixture whose roster they cannot read. Narrow it to match
  // only after confirming no coach workflow depends on the wider write scope.
  await setPerm(LEADER_POLICY, 'participations', 'update', COACH_OR_TR_OF_PARTICIPATION)

  // ── Game guest invitations (migration 271) ──────────────────────
  // Opening a game to another team / to individual players is the coach's or TR's
  // call on the game's OWN team — the side that has to field the squad. The invited
  // team's coach deliberately gets no write here: two parties editing one opening
  // makes "who invited this player" unanswerable, and the game_guests actor columns
  // exist precisely to answer it.
  //
  // CREATE is unfiltered for the reason documented on setPerm: Directus cannot
  // resolve a relational validation against a create payload and would reject every
  // insert. The real scope gate is the BLOCKING kscw-hooks guard on
  // game_guests.items.create / game_guest_teams.items.create — same arrangement as
  // member_teams below.
  const COACH_OR_TR_OF_GUEST_GAME = {
    game: {
      kscw_team: {
        _or: [
          { coach: { members_id: { user: { _eq: '$CURRENT_USER' } } } },
          { team_responsible: { members_id: { user: { _eq: '$CURRENT_USER' } } } },
        ],
      },
    },
  }
  for (const coll of ['game_guests', 'game_guest_teams']) {
    await setPermRead(LEADER_POLICY, coll)
    await setPerm(LEADER_POLICY, coll, 'create')
    await setPerm(LEADER_POLICY, coll, 'update', COACH_OR_TR_OF_GUEST_GAME)
    await setPerm(LEADER_POLICY, coll, 'delete', COACH_OR_TR_OF_GUEST_GAME)
  }

  // Member teams — read all + CRUD. create/update/delete are TEAM-SCOPED by
  // BLOCKING kscw-hooks filters (actorLeadsTeam for create/update — 2026-07-05
  // audit MED #3; the pre-existing member_teams.items.delete guard for delete):
  // a coach may only edit rosters for teams they lead. The grants stay unfiltered
  // here because Directus can't row-filter a CREATE and the delete filter keys on
  // the junction id, not the team — the hooks are the real scope gate.
  await setPermRead(LEADER_POLICY, 'member_teams')
  await setPerm(LEADER_POLICY, 'member_teams', 'create')
  await setPerm(LEADER_POLICY, 'member_teams', 'update')
  await setPerm(LEADER_POLICY, 'member_teams', 'delete')

  // Hall slots — CU
  // hall_slots CREATE stays unfiltered — Directus cannot filter a row that does
  // not exist yet — and is gated by the BLOCKING `hall_slots.items.create` hook
  // below, the same arrangement teams_coaches uses.
  await setPerm(LEADER_POLICY, 'hall_slots', 'create')
  // UPDATE was unfiltered until 2026-08-10 (audit 2026-08-08, finding 7), which
  // was the sharpest grant in this policy: `hall_slots` and `hall_slots_teams`
  // are PUBLIC reads, so slot ids are trivially enumerable, and the action hook
  // on update runs `cascadeSlotUpdate` — so any coach of any one team could
  // PATCH another team's slot to a new weekday/time and have the cascade
  // regenerate or cancel that team's `trainings` rows and fire notifications at
  // their members. `hall_slots` has no team FK; teams hang off the `teams` M2M
  // alias, so the scope walks it.
  await setPerm(LEADER_POLICY, 'hall_slots', 'update', SLOT_OF_TEAM_I_LEAD)
  await setPerm(LEADER_POLICY, 'slot_claims', 'update', COACH_OF_SLOT_CLAIM)

  // Team invites — read all + CRUD
  // team_invites — the sharpest of the eight, because an invite is a bearer
  // credential redeemed by an UNAUTHENTICATED endpoint. `POST /kscw/team-invites/claim`
  // inserts `members` + `member_teams` in a raw-knex transaction, so it never
  // reaches the `member_teams.items.create` guard whose own comment reads
  // "Self-add to an unrelated team IS the escalation". An unfiltered create+read
  // therefore let any coach mint an invite for ANY team and hand every live
  // token in the club to themselves. Read is scoped AND field-scoped: `token` is
  // withheld, because the create endpoint already returns it to its issuer and
  // nothing else needs to read it back.
  await setPermRead(LEADER_POLICY, 'team_invites', INVITE_OF_TEAM_I_LEAD, TEAM_INVITE_LEADER_FIELDS)
  await setPerm(LEADER_POLICY, 'team_invites', 'create')
  await setPerm(LEADER_POLICY, 'team_invites', 'update', INVITE_OF_TEAM_I_LEAD)
  await setPerm(LEADER_POLICY, 'team_invites', 'delete', INVITE_OF_TEAM_I_LEAD)

  // Scorer delegations — read all
  await setPermRead(LEADER_POLICY, 'scorer_delegations')

  // Referee expenses — CRU
  await setPerm(LEADER_POLICY, 'referee_expenses', 'create')
  // update was unfiltered while delete was already scoped — an internal
  // inconsistency, and the weaker of the two is the one that mattered (amount
  // and notes are editable).
  await setPerm(LEADER_POLICY, 'referee_expenses', 'update', COACH_OF_TEAM_FK)

  // Polls — CRUD
  // polls — create unfiltered (no row yet); update/delete scoped to polls
  // belonging to a team the caller leads. `team: { _nnull: true }` is
  // load-bearing: a chat poll has `team: null` and a `conversation`, and without
  // it the relational branch on a null FK is not a reliable refusal.
  await setPerm(LEADER_POLICY, 'polls', 'create')
  await setPerm(LEADER_POLICY, 'polls', 'update', POLL_OF_TEAM_I_LEAD)
  await setPerm(LEADER_POLICY, 'polls', 'delete', POLL_OF_TEAM_I_LEAD)

  // Poll votes — read every vote on polls for teams I coach / am responsible for,
  // so the poll creator/manager can see per-member answers before the deadline
  // (decision 2026-06-28). Members still read only their own vote (member policy);
  // this unions on top via the leader policy.
  // 2026-07-02 audit (#5/#14): anonymous poll votes still persist `member`, so
  // this grant de-anonymized anonymous polls for the coach (anonymity was a
  // UI-only toggle). Scoped to NON-anonymous polls; managers get anonymous-poll
  // results as identity-free counts via GET /kscw/polls/:id/results.
  await setPermRead(LEADER_POLICY, 'poll_votes', {
    poll: {
      anonymous: { _eq: false },
      team: {
        _or: [
          { coach: { members_id: { user: { _eq: '$CURRENT_USER' } } } },
          { team_responsible: { members_id: { user: { _eq: '$CURRENT_USER' } } } },
        ],
      },
    },
  })

  // Team requests — read + update
  await setPermRead(LEADER_POLICY, 'team_requests')
  await setPerm(LEADER_POLICY, 'team_requests', 'update')

  // Absences — read + CUD scoped to members on teams I coach/TR.
  // 2026-05-12 audit: read was unfiltered → full-club absence dump including
  // notes (potentially health-related). Now uses the same coach/TR scope as
  // the CUD rows already had.
  // COACH_TEAM_ABSENCE_SCOPE inherits the `active` gate from COACH_TEAM_MEMBERS;
  // the read filter below is written out longhand, so it needs its own copy.
  // ⚠ Most sensitive of the three collections — MEMBER_ABSENCE_FIELDS includes
  // `reason` / `reason_detail`, flagged above as potentially health-related, and
  // the unguarded walk let an ex-coach read AND delete them indefinitely.
  const COACH_TEAM_ABSENCE_SCOPE = { member: COACH_TEAM_MEMBERS }
  // ⚠ SCALE NOTE (audit 26.08.2026) — this rule has the SAME SHAPE as the one that
  // took the app down: three sibling `_or` branches, each walking
  // `member → member_teams → team → {coach,team_responsible}`. Directus emits those as
  // flat sibling LEFT JOINs that CROSS-MULTIPLY, and re-evaluates the predicate once
  // per selected field. It is safe here ONLY because `absences` is small — 260 rows
  // against `participations`' 12,309 — so the intermediate product is ~10⁴ instead of
  // 1.5×10⁸. Nothing about the shape is safe; the row count is.
  // Before adding a branch here, or before this table grows an order of magnitude,
  // measure it: `SELECT count(*) FROM absences <the joins>` — see the parked
  // PARTICIPATION_VISIBLE rule above for the method and the numbers.
  await setPermRead(LEADER_POLICY, 'absences', {
    _or: [
      { member: { user: { _eq: '$CURRENT_USER' } } },
      { member: { member_teams: { team: { active: { _eq: true }, coach: { members_id: { user: { _eq: '$CURRENT_USER' } } } } } } },
      { member: { member_teams: { team: { active: { _eq: true }, team_responsible: { members_id: { user: { _eq: '$CURRENT_USER' } } } } } } },
    ],
  })
  await setPerm(LEADER_POLICY, 'absences', 'create')
  await setPerm(LEADER_POLICY, 'absences', 'update', COACH_TEAM_ABSENCE_SCOPE)
  await setPerm(LEADER_POLICY, 'absences', 'delete', COACH_TEAM_ABSENCE_SCOPE)

  // Notifications — create (coaches send notifications)
  await setPerm(LEADER_POLICY, 'notifications', 'create')

  // Announcements — restricted to same filter as members (no draft access).
  // F6 audit fix: coaches don't need to see admin's pre-publication drafts.
  // Vorstand keeps unrestricted access for their pipeline-visibility role.
  await setPermRead(LEADER_POLICY, 'announcements', ANNOUNCEMENT_VISIBLE, ANNOUNCEMENT_READ_FIELDS)
  await setPermRead(LEADER_POLICY, 'announcement_recipients', OWN_MEMBER, ['id', 'announcement', 'member'])

  // User logs — REMOVED for LEADER (2026-05-12 audit). The audit log endpoint
  // at /kscw/admin/audit is the only sanctioned access path and is admin-only.
  // Direct `/items/user_logs` read previously exposed every member's action
  // payloads (incl. profile-update diffs with PII) to every coach.

  // Game scheduling — read
  await setPermRead(LEADER_POLICY, 'game_scheduling_seasons')
  await setPermRead(LEADER_POLICY, 'game_scheduling_slots')
  await setPermRead(LEADER_POLICY, 'game_scheduling_opponents')
  await setPermRead(LEADER_POLICY, 'game_scheduling_bookings')
  await setPermRead(LEADER_POLICY, 'game_scheduling_club_portals')

  // Fines + fine_rules (migration 069) — full CRUD scoped to teams the user
  // coaches or is TR for. Row filter walks `team.coach.members_id.user` etc;
  // the frontend must filter by `{ team: { _eq: id } }` only, never by
  // `{ team: { coach: ... } }` (M2M double-walk trap — see CLAUDE.md).
  // Waive happens via UPDATE (status=waived, waived_by/_at/_reason filled);
  // the kscw-hooks `fines.items.update` filter blocks edits to
  // amount/category/reason so the "waive + reissue" audit model is enforced.
  const COACH_OR_TR_OF_FINE = {
    team: {
      _or: [
        { coach: { members_id: { user: { _eq: '$CURRENT_USER' } } } },
        { team_responsible: { members_id: { user: { _eq: '$CURRENT_USER' } } } },
      ],
    },
  }
  // Active-gated variant for writes — keep reads on the full (history) scope.
  const COACH_OR_TR_OF_ACTIVE_FINE = {
    team: {
      active: { _eq: true },
      _or: [
        { coach: { members_id: { user: { _eq: '$CURRENT_USER' } } } },
        { team_responsible: { members_id: { user: { _eq: '$CURRENT_USER' } } } },
      ],
    },
  }
  await setPermRead(LEADER_POLICY, 'fines', COACH_OR_TR_OF_FINE)
  await setPerm(LEADER_POLICY, 'fines', 'create')
  await setPerm(LEADER_POLICY, 'fines', 'update', COACH_OR_TR_OF_ACTIVE_FINE)
  await setPerm(LEADER_POLICY, 'fines', 'delete', COACH_OR_TR_OF_ACTIVE_FINE)
  await setPermRead(LEADER_POLICY, 'fine_rules', COACH_OR_TR_OF_FINE)
  await setPerm(LEADER_POLICY, 'fine_rules', 'create')
  await setPerm(LEADER_POLICY, 'fine_rules', 'update', COACH_OR_TR_OF_ACTIVE_FINE)
  await setPerm(LEADER_POLICY, 'fine_rules', 'delete', COACH_OR_TR_OF_ACTIVE_FINE)

  // Scheduling blocks (migration 085) — team-level game-scheduling blackouts.
  // Same team-scoping shape as fines (direct `team` FK → coach/TR walk). Create
  // is unfiltered at the policy layer (Directus can't validate a relational
  // filter on a not-yet-existing row) and enforced in the kscw-hooks
  // `scheduling_blocks.items.create` filter, which stamps created_by and rejects
  // teams the caller doesn't coach / isn't TR for (mirrors games.items.create).
  const COACH_OR_TR_OF_BLOCK = {
    team: {
      _or: [
        { coach: { members_id: { user: { _eq: '$CURRENT_USER' } } } },
        { team_responsible: { members_id: { user: { _eq: '$CURRENT_USER' } } } },
      ],
    },
  }
  // Active-gated variant for writes — reads stay on the full scope.
  const COACH_OR_TR_OF_ACTIVE_BLOCK = {
    team: {
      active: { _eq: true },
      _or: [
        { coach: { members_id: { user: { _eq: '$CURRENT_USER' } } } },
        { team_responsible: { members_id: { user: { _eq: '$CURRENT_USER' } } } },
      ],
    },
  }
  await setPermRead(LEADER_POLICY, 'scheduling_blocks', COACH_OR_TR_OF_BLOCK)
  await setPerm(LEADER_POLICY, 'scheduling_blocks', 'create')
  await setPerm(LEADER_POLICY, 'scheduling_blocks', 'update', COACH_OR_TR_OF_ACTIVE_BLOCK)
  await setPerm(LEADER_POLICY, 'scheduling_blocks', 'delete', COACH_OR_TR_OF_ACTIVE_BLOCK)

  // ── Consolidation 2026-06-09: folded the legacy "KSCW Coach" policy in here ──
  // The old un-managed "KSCW Coach" policy (from SQL migrations 026/034/036/042,
  // before permissions moved into this script) stayed attached to the Team
  // Responsible role and ADDITIVELY shadowed every scoped rule above — silently
  // re-granting the un-gated/looser writes this policy tightens. These are the
  // grants it held that the Member policy (which coaches also hold) does NOT
  // already cover, ported here so the legacy policy can be deleted
  // (deleteLegacyPolicy('KSCW Coach') below). Filters are preserved verbatim
  // except participations.delete, which was fully open and is now scoped like
  // participations.update. The overlapping looser rules (teams/games/trainings/
  // fines updates) are simply dropped with the legacy policy, so this policy's
  // active-gated versions finally take effect.
  const EVENT_SESSIONS_LEADER_SCOPE = {
    _or: [
      { event: { created_by: { user: { _eq: '$CURRENT_USER' } } } },
      { event: { teams: { teams_id: { coach: { members_id: { user: { _eq: '$CURRENT_USER' } } } } } } },
    ],
  }
  const EVENTS_MEMBERS_LEADER_SCOPE = {
    _or: [
      { events_id: { created_by: { user: { _eq: '$CURRENT_USER' } } } },
      { events_id: { teams: { teams_id: { coach: { members_id: { user: { _eq: '$CURRENT_USER' } } } } } } },
    ],
  }
  await setPerm(LEADER_POLICY, 'event_sessions', 'delete', EVENT_SESSIONS_LEADER_SCOPE)
  await setPerm(LEADER_POLICY, 'events_members', 'create', EVENTS_MEMBERS_LEADER_SCOPE)
  await setPerm(LEADER_POLICY, 'events_members', 'update', EVENTS_MEMBERS_LEADER_SCOPE)
  await setPerm(LEADER_POLICY, 'events_members', 'delete', EVENTS_MEMBERS_LEADER_SCOPE)
  await setPerm(LEADER_POLICY, 'participations', 'delete', COACH_OR_TR_OF_PARTICIPATION)
  await setPerm(LEADER_POLICY, 'referee_expenses', 'delete', COACH_OF_TEAM_FK)
  await setPerm(LEADER_POLICY, 'scorer_delegations', 'delete', OWN_DELEGATION_FROM)
  await setPerm(LEADER_POLICY, 'slot_claims', 'create', COACH_OF_SLOT_CLAIM)
  await setPerm(LEADER_POLICY, 'slot_claims', 'delete', COACH_OF_SLOT_CLAIM)
  // hall_slots_teams — the comment here used to claim "the hallenplan editor +
  // kscw-hooks gate them". The editor half is a UI control, and the kscw-hooks
  // half was simply untrue: no such guard existed (audit 2026-08-08, finding 7).
  // `DELETE` of another team's junction row plus a fresh `POST` was a takeover of
  // the club's most contested resource. Directus CAN filter update/delete here —
  // the row exists and carries `teams_id` — so only create needs the hook.
  await setPerm(LEADER_POLICY, 'hall_slots_teams', 'create')
  await setPerm(LEADER_POLICY, 'hall_slots_teams', 'update', JUNCTION_OF_TEAM_I_LEAD)
  await setPerm(LEADER_POLICY, 'hall_slots_teams', 'delete', JUNCTION_OF_TEAM_I_LEAD)
  // teams_coaches / teams_responsibles — the legacy policy granted these fully
  // open (any leader could edit any team's coach/TR list). Tightened: update +
  // delete scoped to junctions whose team the caller coaches / is TR for; create
  // stays unfiltered here because Directus can't relationally filter a
  // not-yet-existing row. CREATE is enforced instead by the BLOCKING
  // `teams_coaches/teams_responsibles.items.create` filter hooks in kscw-hooks
  // (actorLeadsTeam — 2026-07-05 audit HIGH #1/#2): a coach may only add staff to
  // a team they already lead. The POST-insert role-sync ACTION hook only GRANTS
  // the LEADER policy — it does NOT authorize the write, so the create filter hook
  // is the actual gate. Do not remove it thinking this comment's "gate" is enough.
  await setPerm(LEADER_POLICY, 'teams_coaches', 'create')
  await setPerm(LEADER_POLICY, 'teams_coaches', 'update', JUNCTION_OF_TEAM_I_LEAD)
  await setPerm(LEADER_POLICY, 'teams_coaches', 'delete', JUNCTION_OF_TEAM_I_LEAD)
  await setPerm(LEADER_POLICY, 'teams_responsibles', 'create')
  await setPerm(LEADER_POLICY, 'teams_responsibles', 'update', JUNCTION_OF_TEAM_I_LEAD)
  await setPerm(LEADER_POLICY, 'teams_responsibles', 'delete', JUNCTION_OF_TEAM_I_LEAD)
  // Files — create (upload team photos)
  await setPerm(LEADER_POLICY, 'directus_files', 'create')

  console.log(`  ✓ Team Responsible permissions set`)

  // ��─ 8. Vorstand permissions (read-all + member write) ──────────

  console.log('\n8. Vorstand permissions...')

  // Vorstand gets read-all on everything (overrides member's filtered reads)
  const VORSTAND_READ_ALL = [
    'members', 'member_teams', 'participations', 'absences',
    'game_guests', 'game_guest_teams',
    'notifications', 'scorer_delegations', 'team_invites',
    'user_logs', 'feedback',
    'team_requests', 'push_subscriptions',
    // NB: `poll_votes` intentionally NOT here — granted below scoped to
    // non-anonymous polls only (2026-07-02 audit #5/#14). Board reads anonymous
    // results as identity-free counts via GET /kscw/polls/:id/results.
    'game_scheduling_seasons', 'game_scheduling_slots',
    'game_scheduling_opponents', 'game_scheduling_bookings',
    'game_scheduling_club_portals',
    'announcements',
    // Per-recipient announcement delivery log (migration 219) — read-only for
    // oversight ("did the blast reach everyone?"). Rows are written by the
    // kscw-hooks fanout in system context, so no policy needs write access;
    // granting it would only let an admin fabricate a delivery record.
    'announcement_recipients',
    // Fines (migration 069) — Vorstand sees club-wide for oversight.
    'fines', 'fine_rules',
    // Scheduling blocks (migration 085) — club-wide read for oversight.
    'scheduling_blocks',
    // Finance (migration 114) — board gets the full finance dashboard:
    // Kontenplan, ledger, invoices, budget, payments + import history. Read-only
    // here; native-invoice writes (create/confirm/cancel) + member-link overrides
    // (migrations 128/129) go through the /kscw/finance/* endpoints (system
    // connection, Vorstand-gated in code), NOT the items API — so the board can
    // never edit ClubDesk-mirror rows directly. The override table is read-only
    // for admin visibility/audit.
    'finance_accounts', 'finance_fiscal_years', 'finance_budget_lines',
    'finance_transactions', 'finance_invoices', 'finance_payments', 'finance_imports',
    'finance_invoice_member_overrides',
    // Member "I've paid" self-reports on ClubDesk-mirror invoices (migration
    // 297) — read-only oversight ("who says they paid, and when?"). Written by
    // /kscw/finance/invoices/:id/report-paid in system context; the importer
    // clears a row once ClubDesk confirms the invoice settled.
    'finance_invoice_self_reports',
    // Invoice PDF attachment links (migration 134) — board read for oversight.
    'finance_invoice_documents',
    // Member pay-outs / reimbursements (migration 137) — board read.
    'finance_payouts',
    // Dues-rate schedule + issued batches (migration 138) — board read; the run
    // writes go through /kscw/finance/dues-* (canManageFinance), not the items API.
    'finance_dues_rates', 'finance_dues_runs',
    // Expense submissions (migration 177) — board read; writes via /kscw/expenses/*.
    'finance_expenses',
    // Households (migration 348) — board READ for oversight of who may act for
    // whom. Creation stays admin/superuser only (see the Sport Admin block);
    // `member_guardians` is granted to nobody, being trigger-derived.
    'households', 'household_members',
  ]
  for (const col of VORSTAND_READ_ALL) {
    await setPermRead(VORSTAND_POLICY, col)
  }
  // poll_votes — non-anonymous only (2026-07-02 audit #5/#14). Anonymous-poll
  // results come from the counts endpoint, not raw vote rows.
  await setPermRead(VORSTAND_POLICY, 'poll_votes', { poll: { anonymous: { _eq: false } } })
  // Read the private invoice-PDF folder so the board can open attachments via
  // /assets (members can't — their directus_files read is folder-less-only).
  await setPermRead(VORSTAND_POLICY, 'directus_files', { folder: { _eq: FINANCE_INVOICE_FOLDER } })
  // Registration documents (ID scans, licence/declaration docs) — board reviews
  // Anmeldungen, so it needs the private registration folder via /assets too.
  await setPermRead(VORSTAND_POLICY, 'directus_files', { folder: { _eq: REGISTRATION_FILES_FOLDER } })
  // Narrow ClubDesk register read — same field-scoped grant as Sport Admin, so
  // the board's read-only explorer grid shows the passive/honorary/former and
  // officials-licence columns.
  await setPermRead(VORSTAND_POLICY, 'clubdesk_export', null, ['id', 'clubdesk_id', 'gruppen_bracketed', 'offiziellen_lizenz'])

  // Forms (migrations 086/087) — Vorstand has FULL management (decision
  // 2026-06-05): create/edit/delete any form club-wide + read all submissions,
  // exactly like a global admin. (Sport Admins are sport-scoped in the FormsPage
  // UI; their policy keeps club-wide CRUD, matching every other collection.)
  for (const col of ['forms', 'forms_teams', 'form_submissions']) {
    await setPermCRUD(VORSTAND_POLICY, col)
  }

  // Transactional email copy (migration 287) — the board writes to parents in the
  // club's name, so it owns this wording too. The archive stays read-only for the
  // same reason it is read-only for Sport Admin.
  await setPermCRUD(VORSTAND_POLICY, 'email_templates')
  await setPermRead(VORSTAND_POLICY, 'email_sends')

  console.log(`  ✓ Vorstand permissions set`)

  // ���─ 9. Sport Admin permissions ───��─────────────────────────────

  console.log('\n9. Sport Admin permissions...')

  // Sport Admin tier: club-wide CRU on operational collections, but NOT
  // members.delete or teams.delete (migration 027 — full admin only,
  // club-wide blast radius).
  const SPORT_ADMIN_FULL_CRUD = [
    'games', 'trainings', 'events', 'event_sessions', 'events_teams',
    'member_teams', 'participations', 'absences',
    // Guest invitations (migration 271) — club-wide, so a sport admin can open or
    // close a game for a coach who is away.
    'game_guests', 'game_guest_teams',
    'rankings', 'sponsors', 'teams_sponsors',
    'hall_slots', 'hall_closures', 'hall_events', 'halls', 'hall_slots_teams',
    'slot_claims', 'notifications', 'feedback', 'scorer_delegations', 'referee_expenses',
    'team_invites', 'news', 'app_settings',
    'push_subscriptions',
    // ⚠ `email_verifications` and `user_logs` are NOT here — see the two
    // explicit grants below the loop. Do not re-add them.
    'teams_coaches', 'teams_responsibles', 'events_members',
    'volley_feedback',
    // NB: `poll_votes` NOT here — granted below with a non-anonymous read scope
    // (2026-07-02 audit #5/#14) while keeping create/update/delete for oversight.
    'polls', 'team_requests', 'registrations',
    // Editable transactional email copy (migration 287). A sport admin owns the
    // wording of the emails their own registrants receive. Read+write is safe
    // because the compiled-in copy is the per-field fallback, the write hook
    // rejects unknown/missing placeholders, and every edit stamps updated_by_*.
    // ⚠ `email_sends` is NOT here — it is granted read-only just below, because
    // the archive is evidence of what went out and must not be editable.
    'email_templates',
    'game_scheduling_seasons', 'game_scheduling_slots',
    'game_scheduling_opponents', 'game_scheduling_bookings',
    'game_scheduling_club_portals',
    // Basketball prep (migrations 214/216) — club-wide CRUD; the Basketball prep page
    // is UI-scoped to basketball admins (full admins bypass). No opponent/token/booking
    // flow: ProBasket owns the schedule. slot_plan = games placed into KWI hall slots.
    // team_links (migration 218, was basketball_team_links) is sport-agnostic — both the
    // basketball prep + volleyball Terminplanung settings write it; UI-scoped per sport.
    'basketball_hall_availability', 'basketball_slot_plan', 'team_links',
    // basketball_team_rules (migration 278) — the per-team constraint matrix on
    // /admin/terminplanung/basketball/settings. It shipped into the Terminplanung
    // policy only (§9b), which rides on `is_spielplaner`; a bb_admin holds no such
    // flag, so the settings page 403'd on load for exactly the people it is built
    // for (observed 2026-08-07). Same tier as the three collections above it.
    'basketball_team_rules',
    'sv_vm_check',
    // VIS mirrors (migrations 237/240/241) behind /admin/transfers, which is gated
    // to admin | superuser | vb_admin | bb_admin. The first two bypass policies,
    // the sport admins do NOT — so without a grant here the federation directory
    // reads back empty for exactly the people the page is built for, and every row
    // silently degrades to "no contact on file". Both tables are read-only mirrors
    // written by cron, never by the UI, but they live here rather than as a
    // read-only row because Sport Admin already holds this shape for sv_vm_check.
    // vis_players (migration 313) joins them: the staged FIVB player index the
    // transfers work is matched against. Read-only mirror like its two siblings,
    // fully replaced by each vis-player-check run.
    'vis_transfers', 'vis_federations', 'vis_players',
    'announcements',
    // Fines (migration 069) — Sport Admin full CRUD (override coach-only scope
    // for cross-team rule edits + correction of bad fines).
    'fines', 'fine_rules',
    // Scheduling blocks (migration 085) — club-wide CRUD for any team's blackouts.
    'scheduling_blocks',
    // Forms (migrations 086/087) — club-wide CRUD at the policy layer; per-sport
    // scoping is enforced in the FormsPage UI (consistent with every other Sport
    // Admin collection, which are likewise club-wide CRUD + UI-scoped).
    'forms', 'form_submissions', 'forms_teams',
    // VB referee → team duty map (migration 200) — club-wide CRUD; the
    // /admin/vb-referees page is UI-scoped to VB admins (full admins bypass).
    'vb_referee_duty',
    'directus_files',
  ]
  for (const col of SPORT_ADMIN_FULL_CRUD) {
    await setPermCRUD(SPORT_ADMIN_POLICY, col)
  }
  // `email_verifications` — NO grant at all (audit 2026-08-08, finding 1).
  // This is not operational data: it is the credential store backing the
  // unauthenticated `POST /kscw/set-password` Mode 3, which treats any row with
  // `verified = true` and a live `expires_at` as proof that the caller owns that
  // address. Unfiltered CRU here (granted until 2026-08-08) therefore let a
  // vb_admin/bb_admin forge the proof for ANY address — PATCH the email of a row
  // they had legitimately verified, then claim the matching account, including a
  // Superuser's. Every legitimate consumer (`/request-otp`, `/verify-email`,
  // `/set-password`, `/register`, the delete-member cleanup) writes this table
  // with raw knex on the system connection and needs no policy row.
  // If a staff-facing read is ever wanted, scope it to id/email/date_created —
  // never `code`, `verified` or `expires_at`.

  // `user_logs` — CREATE + READ only, no update/delete (audit 2026-08-08,
  // finding 1). This is the audit trail the superadmin page reads; unfiltered
  // update/delete let the tier being audited rewrite or erase its own entries.
  // The matching kscw-hooks refusal on update/delete is belt and braces.
  await setPerm(SPORT_ADMIN_POLICY, 'user_logs', 'create')
  await setPermRead(SPORT_ADMIN_POLICY, 'user_logs')

  // Announcement delivery log (migration 219) — READ only, deliberately not in
  // SPORT_ADMIN_FULL_CRUD. The fanout writes these rows in system context, so
  // write access would buy nothing and would let a delivery record be forged.
  await setPermRead(SPORT_ADMIN_POLICY, 'announcement_recipients')
  // Sent-email archive (migration 287) — READ only, same reasoning: the endpoint
  // writes it at send time and it is the record of what a family was actually
  // told. Editable evidence is not evidence. The kscw-hooks filter refuses
  // update/delete as well, so this is belt and braces.
  // ⚠ Rows contain the recipient's name + address inside body_html — never grant
  // this to MEMBER_POLICY.
  await setPermRead(SPORT_ADMIN_POLICY, 'email_sends')
  // Households (migration 348) — READ only, deliberately NOT in
  // SPORT_ADMIN_FULL_CRUD. A household link is privilege-bearing: it hands one
  // login write access to another member's record via the acting-member swap.
  // Granting create here would let any Sport Admin put herself in a household
  // with any member and become them — a larger privilege than the admin_access
  // incident in SECURITY.md. Creation is admin/superuser only and goes through
  // POST /kscw/household, which gates on the 'superuser' member role.
  // `member_guardians` is trigger-derived and granted to NOBODY, not even for
  // read: a hand-written row there is an acting grant with no household behind
  // it. It is registered hidden + readonly in migration 348.
  await setPermRead(SPORT_ADMIN_POLICY, 'households')
  await setPermRead(SPORT_ADMIN_POLICY, 'household_members')
  // poll_votes — read non-anonymous polls only (2026-07-02 audit #5/#14); keep
  // create/update/delete for oversight/correction. Anonymous results via the
  // counts endpoint. (Full Directus admins still bypass all filters by design.)
  await setPermRead(SPORT_ADMIN_POLICY, 'poll_votes', { poll: { anonymous: { _eq: false } } })
  await setPerm(SPORT_ADMIN_POLICY, 'poll_votes', 'create')
  await setPerm(SPORT_ADMIN_POLICY, 'poll_votes', 'update')
  await setPerm(SPORT_ADMIN_POLICY, 'poll_votes', 'delete')
  // basketplan_clubs (migration 279) — READ + UPDATE, no create/delete: the
  // registry is populated by the Basketplan scrape, but the contact block on it
  // is hand-maintained from the club-portals panel on the basketball settings
  // page (`saveClubContact`). A Spielplaner deliberately gets read-only there
  // (§9b); a sport admin is the tier above and already holds exactly this shape
  // on `game_scheduling_opponents`, which carries the same class of third-party
  // contact PII. Without the read the portals panel renders an empty club list.
  await setPermRead(SPORT_ADMIN_POLICY, 'basketplan_clubs')
  await setPerm(SPORT_ADMIN_POLICY, 'basketplan_clubs', 'update')
  // Restricted: read/create/update on members + teams.
  // fields = '*' on both, which is what already covers the staff-only
  // `transfer_*` columns (migrations 234/235) that `/admin/transfers` writes —
  // see MEMBER_STAFF_ONLY_FIELDS above. Anything added to `members` becomes
  // Sport-Admin readable AND writable here by default; if a future column must
  // NOT be, this loop is where it has to be field-scoped.
  for (const col of ['members', 'teams']) {
    await setPerm(SPORT_ADMIN_POLICY, col, 'create')
    await setPermRead(SPORT_ADMIN_POLICY, col)
    await setPerm(SPORT_ADMIN_POLICY, col, 'update')
  }
  // members.delete — deliberately NOT granted (withheld since migration 027,
  // and it stays withheld). The Data Explorer's danger zone (/admin/explore →
  // member detail) deletes members through `POST /kscw/admin/delete-member`,
  // which gates on role, on SPORT SCOPE (a vb_admin cannot delete a basketball
  // member) and on RANK (nobody deletes themselves; only a full admin deletes a
  // board member or another admin), then runs ItemsService with the caller's
  // identity and escalated permissions.
  //
  // ⚠ Do not "fix" this by adding `setPerm(SPORT_ADMIN_POLICY, 'members',
  // 'delete')`. A permission row here cannot express any of those three checks
  // — one policy is shared by vb_admin and bb_admin, so no filter can tell the
  // two sections apart — and an unfiltered row would hand every sport admin a
  // plain `DELETE /items/members/:id` that skips the impact preview, the typed
  // DELETE gate and all three server checks in one call.
  //
  // teams.delete is withheld for the same generation of reasons (migration
  // 027). A team carries seasons of roster, training and game history behind
  // cascading junctions; its blast radius is club-wide and it is deliberately
  // out of scope for that flow.

  // Narrow ClubDesk register read for the explorer grid's derived member
  // columns (passive/honorary/former from gruppen_bracketed + the ClubDesk
  // officials licence). Field-scoped on purpose — IBAN / AHV / Bemerkungen and
  // the rest of the register stay full-admin-only.
  const CLUBDESK_GRID_FIELDS = ['id', 'clubdesk_id', 'gruppen_bracketed', 'offiziellen_lizenz']
  await setPermRead(SPORT_ADMIN_POLICY, 'clubdesk_export', null, CLUBDESK_GRID_FIELDS)

  console.log(`  ✓ Sport Admin permissions set`)

  // ── 9b. Terminplanung permissions ──────────────────────────────
  //
  // Club-wide Spielplaner members run the opponent game-scheduling flow. The
  // admin UI reads/writes these collections via the Directus items API
  // (useGameSchedulingSeason + useAdminBookings), so they need real policy
  // permissions — the custom /admin/terminplanung/* action endpoints (slot
  // generation, confirm, invites, SVRZ sync) run on the system DB connection and
  // are gated separately in the kscw-endpoints extension.
  //
  // No row-level filter: the policy is attached only to is_spielplaner users
  // (section 12), so holding it IS the gate. Season create/update is allowed
  // (open/close + config); structural ops (archive/rollover/restore) stay
  // admin-only at the endpoint layer.

  console.log('\n9b. Terminplanung permissions...')

  await setPerm(TERMINPLANUNG_POLICY, 'game_scheduling_seasons', 'create')
  await setPermRead(TERMINPLANUNG_POLICY, 'game_scheduling_seasons')
  await setPerm(TERMINPLANUNG_POLICY, 'game_scheduling_seasons', 'update')
  await setPermRead(TERMINPLANUNG_POLICY, 'game_scheduling_slots')
  await setPermRead(TERMINPLANUNG_POLICY, 'game_scheduling_opponents')
  await setPermRead(TERMINPLANUNG_POLICY, 'game_scheduling_bookings')
  await setPermRead(TERMINPLANUNG_POLICY, 'game_scheduling_club_portals')
  // Scheduling blocks (migration 085) — club-wide Spielplaner can manage team
  // blackouts for any team (no row filter; holding the policy IS the gate, like
  // the season collections above). The create hook still stamps created_by.
  await setPermRead(TERMINPLANUNG_POLICY, 'scheduling_blocks')
  await setPerm(TERMINPLANUNG_POLICY, 'scheduling_blocks', 'create')
  await setPerm(TERMINPLANUNG_POLICY, 'scheduling_blocks', 'update')
  await setPerm(TERMINPLANUNG_POLICY, 'scheduling_blocks', 'delete')

  // ── Basketball prep (migrations 214/216/218) ──────────────────────────────
  //
  // 2026-08-05: the basketball scheduling routes now gate on
  // `is_spielplaner` OR a sport admin, exactly like the volleyball ones. That
  // flag is precisely what §12 (and the kscw-hooks `is_spielplaner` action
  // hook) attaches THIS policy for, so the frontend gate and this grant are the
  // same set of people by construction. Until now these three collections were
  // Sport-Admin-only (§9), so a Spielplaner reaching /basketball/prep loaded an
  // EMPTY grid (planQ/availQ 403) and 403'd on every placement.
  //
  // Scope = exactly what the pages read/write, no more:
  //   • basketball_slot_plan       — useBasketballPlan.placeGame (create+update
  //     upsert on the (date,time,hall) key) and removeGame (delete) → full CRUD.
  //   • basketball_hall_availability — setDateUnavailable upserts create+update
  //     only; the "available again" path flips `unavailable` back to false
  //     rather than deleting the row, so NO delete grant.
  //   • team_links (sport-agnostic) — TeamLinksEditor add/update/remove →
  //     create+update+delete. Read is already club-wide via KSCW Member, but is
  //     repeated here on purpose so this policy stands on its own: a future
  //     narrowing of the Member read must not silently empty the links editor.
  //     Zero added exposure — identical scope to the grant that already exists.
  //
  // Everything else those pages touch is already readable and is NOT re-granted:
  //   game_scheduling_seasons + game_scheduling_slots → §9b above;
  //   teams, halls, hall_closures → MEMBER_READ_ALL (unfiltered, fields '*');
  //   club-wide blocked dates → GET /terminplanung/admin/club-blocked-dates,
  //   an endpoint gated in kscw-endpoints, not an items-API read.
  await setPermCRUD(TERMINPLANUNG_POLICY, 'basketball_slot_plan')
  await setPermRead(TERMINPLANUNG_POLICY, 'basketball_hall_availability')
  await setPerm(TERMINPLANUNG_POLICY, 'basketball_hall_availability', 'create')
  await setPerm(TERMINPLANUNG_POLICY, 'basketball_hall_availability', 'update')
  await setPermRead(TERMINPLANUNG_POLICY, 'team_links')
  await setPerm(TERMINPLANUNG_POLICY, 'team_links', 'create')
  await setPerm(TERMINPLANUNG_POLICY, 'team_links', 'update')
  await setPerm(TERMINPLANUNG_POLICY, 'team_links', 'delete')

  // ── Basketball slot rules + club registry (migrations 278/279) ──────────
  //   • basketball_team_rules — the per-team constraint matrix behind slot
  //     generation. useBasketballTeamRules reads via useCollection and writes
  //     with createRecord/updateRecord/deleteRecord → full CRUD.
  await setPermCRUD(TERMINPLANUNG_POLICY, 'basketball_team_rules')
  //   • basketplan_clubs — READ ONLY on purpose. The list is served by the gated
  //     endpoint (GET /kscw/admin/terminplanung/bb/clubs) rather than the items
  //     API because it carries third-party contact PII; read is still needed
  //     because Directus returns the patched row on the one items-API write.
  //     Consequence: editing a club's contact email is full-admin-only — a
  //     Spielplaner gets a 403, surfaced in the dialog's error state. Widen with
  //     `setPerm(TERMINPLANUNG_POLICY, 'basketplan_clubs', 'update')` only if
  //     Spielplaner are meant to edit other clubs' contact details.
  await setPermRead(TERMINPLANUNG_POLICY, 'basketplan_clubs')
  // NOT granted, deliberately: basketball_slots and game_scheduling_club_portals
  // are endpoint-only (never touched via the items API); migration 280's new
  // basketball_slot_plan columns ride the existing CRUD grant (fields '*'); and
  // game_scheduling_seasons.bb_slot_config rides the §9b update grant.

  console.log(`  ✓ Terminplanung permissions set`)

  // ── 9c. Finance permissions ────────────────────────────────────
  //
  // The 'finance' role (treasurer / finance team) = member permissions + the
  // full club finance picture. Attached per-user to is-finance members (§13), so
  // holding the policy IS the gate (no row filter on the finance reads — same
  // model as Terminplanung). Read-only at the items layer; native-invoice writes
  // (create/confirm/cancel/link/camt) go through /kscw/finance/* (canManageFinance).
  //
  // The ONE write here is members.update scoped to the billing-contact fields
  // (migration 133) so finance can record a minor's/guardian's billing address
  // in the member explorer. members READ is field-scoped + club-wide (additive
  // with the member policy → widens finance's view to email/phone/IBAN/billing).

  console.log('\n9c. Finance permissions...')

  await setPermRead(FINANCE_POLICY, 'members', null, FINANCE_MEMBER_FIELDS)
  await setPerm(FINANCE_POLICY, 'members', 'update', null, FINANCE_MEMBER_BILLING_FIELDS)
  await setPermRead(FINANCE_POLICY, 'member_teams')

  // Full club finance read (mirror VORSTAND_READ_ALL's finance subset).
  const FINANCE_READ_ALL = [
    'finance_accounts', 'finance_fiscal_years', 'finance_budget_lines',
    'finance_transactions', 'finance_invoices', 'finance_payments', 'finance_imports',
    'finance_invoice_member_overrides',
    // Self-reported payments on ClubDesk-mirror invoices (migration 297) — the
    // treasurer's "these members say they paid" list. Read-only; see above.
    'finance_invoice_self_reports',
    // Dues-rate schedule + issued batches (migration 138) — read; writes via endpoints.
    'finance_dues_rates', 'finance_dues_runs',
    // Expense submissions (migration 177) — read; writes via PATCH /kscw/expenses/:id.
    'finance_expenses',
  ]
  for (const col of FINANCE_READ_ALL) {
    await setPermRead(FINANCE_POLICY, col)
  }

  // Invoice PDF attachments (migration 134). Finance uploads PDFs into the private
  // folder + manages the link rows; the file is served via /assets (folder-scoped
  // read below). finance_invoice_documents is the link table (clubdesk_id / native).
  await setPermCRUD(FINANCE_POLICY, 'finance_invoice_documents')
  await setPerm(FINANCE_POLICY, 'directus_files', 'create')
  await setPermRead(FINANCE_POLICY, 'directus_files', { folder: { _eq: FINANCE_INVOICE_FOLDER } })
  // Member pay-outs / reimbursements (migration 137) — finance creates/deletes.
  await setPermCRUD(FINANCE_POLICY, 'finance_payouts')

  console.log(`  ✓ Finance permissions set`)

  // ── 9d. Spielplaner permissions ────────────────────────────────
  //
  // Manual games in the Spielplanung planner (ManualGameModal / SpielplanungPage)
  // write `games` rows via the plain items API (useMutation('games')). Before
  // this policy the only games create/delete rows lived on KSCW Sport Admin, so
  // every non-admin spielplaner 403'd on a flow the UI offers.
  //
  // Two-layer gate (create/update are field-scoped to GAME_WRITE_FIELDS; delete
  // takes no payload, so its fields are irrelevant and stay '*'):
  //   1. SOURCE scope at the policy layer — every grant is limited to
  //      source='manual' rows: UPDATE/DELETE via the `permissions` row filter,
  //      CREATE via a scalar `validation` on the payload (Directus doesn't
  //      enforce `permissions` on CREATE — no row exists yet — but a scalar
  //      validation IS enforced; see the setPerm note). VM-synced league games
  //      (source != 'manual') stay Sport-Admin-only even via the raw API.
  //   2. TEAM scope at the hook layer — the policy is attached only to
  //      spielplaner users (section 14): club-wide (is_spielplaner=true) or
  //      per-team (spielplaner_assignments), so holding it is the items-layer
  //      gate (same "holding the policy IS the gate" model as Terminplanung
  //      §9b). Per-team row/team scope can't be a policy filter (unenforceable
  //      on CREATE + a kscw_team filter would lock out club-wide
  //      spielplaners); it's enforced by the kscw-hooks Spielplaner scope
  //      guard on games.items.create/update/delete
  //      (directus/extensions/kscw-hooks/src/index.js — "Spielplaner scope
  //      guard"), which checks kscw_team ∈ caller's spielplaner_assignments
  //      and lets is_spielplaner=true members through club-wide.
  // (games READ is already club-wide via the Member policy — not repeated here.)

  console.log('\n9d. Spielplaner permissions...')

  // FIELD scope (2026-07-13, migration 206): create/update are limited to
  // GAME_WRITE_FIELDS — every games column except the `vm_nomination_*` push
  // journal the VM-nomination cron owns. This is not just belt-and-braces on top of
  // the LEADER field scope: Directus UNIONs the permission rows of every policy a
  // user holds for the same collection+action, so leaving `['*']` here would hand
  // the journal straight back to any coach/TR who is also a spielplaner (on their
  // manual games) and undo §7's field scope. The planner writes no journal column —
  // `buildManualGamePayload` emits flat game columns incl. the coach-owned
  // `auto_nomination_list` toggle, which IS in the list — so this is behaviour-neutral.
  const MANUAL_GAME = { source: { _eq: 'manual' } }
  await setPerm(SPIELPLANER_POLICY, 'games', 'create', MANUAL_GAME, GAME_WRITE_FIELDS, MANUAL_GAME)
  await setPerm(SPIELPLANER_POLICY, 'games', 'update', MANUAL_GAME, GAME_WRITE_FIELDS)
  await setPerm(SPIELPLANER_POLICY, 'games', 'delete', MANUAL_GAME)

  console.log(`  ✓ Spielplaner permissions set`)

  // ── 10. Backfill user-level LEADER access for every coach/TR ───
  //
  // Permission gating must not depend on Directus role assignment. The
  // role-sync hook only fires on data-change events; users whose
  // coach/TR junction predates the hook (or whose role got manually
  // changed to a custom tier like "Website Admin") end up with a stale
  // role that lacks LEADER policy → 403 on teams.update etc.
  //
  // Fix: attach LEADER_POLICY directly to the user via directus_access
  // for everyone present in teams_coaches or teams_responsibles. The
  // LEADER policy is already self-scoped on every write (teams.update,
  // members.update, member_teams.* via M2M filters) so attaching it
  // broadly is safe — non-coaches simply won't match the filters.
  //
  // Idempotent: skips users that already have the row.

  console.log('\n10. Backfilling user-level LEADER access for coaches/TRs...')

  const leaderUserIds = new Set()
  const coachJunctions = await api('GET', '/items/teams_coaches?fields=members_id.user&limit=-1')
  const trJunctions = await api('GET', '/items/teams_responsibles?fields=members_id.user&limit=-1')
  for (const j of [...coachJunctions, ...trJunctions]) {
    const uid = j?.members_id?.user
    if (uid) leaderUserIds.add(uid)
  }

  const existingAccess = await api('GET', `/access?filter[policy][_eq]=${LEADER_POLICY}&filter[user][_nnull]=true&fields=user&limit=-1`)
  const haveLeader = new Set(existingAccess.map(a => a.user).filter(Boolean))

  let attached = 0
  let skipped = 0
  for (const userId of leaderUserIds) {
    if (haveLeader.has(userId)) { skipped++; continue }
    try {
      await api('POST', '/access', { user: userId, policy: LEADER_POLICY })
      attached++
    } catch (e) {
      if (!e.message.includes('RECORD_NOT_UNIQUE')) {
        console.warn(`  ⚠ attach LEADER to ${userId}: ${e.message.slice(0, 100)}`)
      } else {
        skipped++
      }
    }
  }
  console.log(`  ✓ Attached LEADER policy to ${attached} user(s) (${skipped} already had it, ${leaderUserIds.size} total coaches/TRs)`)

  // Clean up stale user-level LEADER access for users no longer coach/TR.
  // Re-fetch with id so we can DELETE; the earlier query only requested `user`.
  const accessWithIds = await api('GET', `/access?filter[policy][_eq]=${LEADER_POLICY}&filter[user][_nnull]=true&fields=id,user&limit=-1`)
  const stale = accessWithIds.filter(a => a.user && !leaderUserIds.has(a.user))
  for (const row of stale) {
    try {
      await api('DELETE', `/access/${row.id}`)
    } catch (e) {
      console.warn(`  ⚠ revoke LEADER from ${row.user}: ${e.message.slice(0, 100)}`)
    }
  }
  if (stale.length > 0) console.log(`  ✓ Revoked LEADER policy from ${stale.length} ex-coach/TR user(s)`)

  // ── 10b. Retire the legacy "KSCW Coach" policy ────────────────
  // Its unique grants were folded into Team Responsible above; the LEADER
  // backfill (10) guarantees every coach/TR now holds the TR policy directly,
  // so removing the legacy one loses no access — it only removes the
  // additive shadow + its fully-open writes. Idempotent.
  console.log('\n10b. Retiring legacy "KSCW Coach" policy...')
  await deleteLegacyPolicy('KSCW Coach')

  // ── 12. Backfill user-level TERMINPLANUNG access for is_spielplaner ───
  //
  // Attach the Terminplanung policy directly to the directus user of every
  // member with is_spielplaner=true (club-wide schedulers). Same idempotent
  // sync + stale-cleanup pattern as the LEADER backfill above. A newly-flagged
  // member gets access on the next perms deploy.

  console.log('\n12. Backfilling user-level TERMINPLANUNG access for is_spielplaner members...')

  const spielplanerMembers = await api('GET', '/items/members?filter[is_spielplaner][_eq]=true&fields=user&limit=-1')
  const spielplanerUserIds = new Set(spielplanerMembers.map(m => m.user).filter(Boolean))

  const existingTp = await api('GET', `/access?filter[policy][_eq]=${TERMINPLANUNG_POLICY}&filter[user][_nnull]=true&fields=user&limit=-1`)
  const haveTp = new Set(existingTp.map(a => a.user).filter(Boolean))

  let tpAttached = 0
  let tpSkipped = 0
  for (const userId of spielplanerUserIds) {
    if (haveTp.has(userId)) { tpSkipped++; continue }
    try {
      await api('POST', '/access', { user: userId, policy: TERMINPLANUNG_POLICY })
      tpAttached++
    } catch (e) {
      if (!e.message.includes('RECORD_NOT_UNIQUE')) {
        console.warn(`  ⚠ attach TERMINPLANUNG to ${userId}: ${e.message.slice(0, 100)}`)
      } else {
        tpSkipped++
      }
    }
  }
  console.log(`  ✓ Attached TERMINPLANUNG policy to ${tpAttached} user(s) (${tpSkipped} already had it, ${spielplanerUserIds.size} total is_spielplaner)`)

  const tpAccessWithIds = await api('GET', `/access?filter[policy][_eq]=${TERMINPLANUNG_POLICY}&filter[user][_nnull]=true&fields=id,user&limit=-1`)
  const tpStale = tpAccessWithIds.filter(a => a.user && !spielplanerUserIds.has(a.user))
  for (const row of tpStale) {
    try {
      await api('DELETE', `/access/${row.id}`)
    } catch (e) {
      console.warn(`  ⚠ revoke TERMINPLANUNG from ${row.user}: ${e.message.slice(0, 100)}`)
    }
  }
  if (tpStale.length > 0) console.log(`  ✓ Revoked TERMINPLANUNG policy from ${tpStale.length} ex-is_spielplaner user(s)`)

  // ── 13. Backfill user-level FINANCE access for 'finance' members ───
  //
  // Attach the Finance policy directly to the directus user of every member with
  // 'finance' in their role array. Same idempotent sync + stale-cleanup as the
  // LEADER (§10) and TERMINPLANUNG (§12) backfills. The role-sync hook does the
  // same attach/revoke the moment members.role changes, so this is the
  // deploy-time reconcile (catches manual SQL edits / pre-hook grants).

  console.log('\n13. Backfilling user-level FINANCE access for finance members...')

  const allMembersForFinance = await api('GET', '/items/members?fields=user,role&limit=-1')
  const financeUserIds = new Set(
    (allMembersForFinance || [])
      .filter(m => m.user && Array.isArray(m.role) && m.role.includes('finance'))
      .map(m => m.user),
  )

  const existingFin = await api('GET', `/access?filter[policy][_eq]=${FINANCE_POLICY}&filter[user][_nnull]=true&fields=user&limit=-1`)
  const haveFin = new Set((existingFin || []).map(a => a.user).filter(Boolean))

  let finAttached = 0
  let finSkipped = 0
  for (const userId of financeUserIds) {
    if (haveFin.has(userId)) { finSkipped++; continue }
    try {
      await api('POST', '/access', { user: userId, policy: FINANCE_POLICY })
      finAttached++
    } catch (e) {
      if (!e.message.includes('RECORD_NOT_UNIQUE')) {
        console.warn(`  ⚠ attach FINANCE to ${userId}: ${e.message.slice(0, 100)}`)
      } else {
        finSkipped++
      }
    }
  }
  console.log(`  ✓ Attached FINANCE policy to ${finAttached} user(s) (${finSkipped} already had it, ${financeUserIds.size} total finance)`)

  const finAccessWithIds = await api('GET', `/access?filter[policy][_eq]=${FINANCE_POLICY}&filter[user][_nnull]=true&fields=id,user&limit=-1`)
  const finStale = (finAccessWithIds || []).filter(a => a.user && !financeUserIds.has(a.user))
  for (const row of finStale) {
    try {
      await api('DELETE', `/access/${row.id}`)
    } catch (e) {
      console.warn(`  ⚠ revoke FINANCE from ${row.user}: ${e.message.slice(0, 100)}`)
    }
  }
  if (finStale.length > 0) console.log(`  ✓ Revoked FINANCE policy from ${finStale.length} ex-finance user(s)`)

  // ── 14. Backfill user-level SPIELPLANER access for spielplaner members ───
  //
  // Attach the Spielplaner policy directly to the directus user of every
  // member who is a spielplaner — club-wide (is_spielplaner=true) OR per-team
  // (at least one spielplaner_assignments row; assignment.member → members.user).
  // Same idempotent sync + stale-cleanup pattern as LEADER (§10) /
  // TERMINPLANUNG (§12) / FINANCE (§13). Holding the policy is the items-layer
  // gate for manual-game create/update/delete (§9d); per-team row scope is the
  // kscw-hooks games scope guard. A newly-flagged/assigned member gets access
  // on the next perms deploy.

  console.log('\n14. Backfilling user-level SPIELPLANER access for spielplaner members...')

  const spWideMembers = await api('GET', '/items/members?filter[is_spielplaner][_eq]=true&fields=user&limit=-1')
  const spAssignRows = await api('GET', '/items/spielplaner_assignments?fields=member.user&limit=-1')
  const spielplanerPolicyUserIds = new Set([
    ...(spWideMembers || []).map(m => m.user),
    ...(spAssignRows || []).map(a => a?.member?.user),
  ].filter(Boolean))

  const existingSp = await api('GET', `/access?filter[policy][_eq]=${SPIELPLANER_POLICY}&filter[user][_nnull]=true&fields=user&limit=-1`)
  const haveSp = new Set((existingSp || []).map(a => a.user).filter(Boolean))

  let spAttached = 0
  let spSkipped = 0
  for (const userId of spielplanerPolicyUserIds) {
    if (haveSp.has(userId)) { spSkipped++; continue }
    try {
      await api('POST', '/access', { user: userId, policy: SPIELPLANER_POLICY })
      spAttached++
    } catch (e) {
      if (!e.message.includes('RECORD_NOT_UNIQUE')) {
        console.warn(`  ⚠ attach SPIELPLANER to ${userId}: ${e.message.slice(0, 100)}`)
      } else {
        spSkipped++
      }
    }
  }
  console.log(`  ✓ Attached SPIELPLANER policy to ${spAttached} user(s) (${spSkipped} already had it, ${spielplanerPolicyUserIds.size} total spielplaner)`)

  const spAccessWithIds = await api('GET', `/access?filter[policy][_eq]=${SPIELPLANER_POLICY}&filter[user][_nnull]=true&fields=id,user&limit=-1`)
  const spStale = (spAccessWithIds || []).filter(a => a.user && !spielplanerPolicyUserIds.has(a.user))
  for (const row of spStale) {
    try {
      await api('DELETE', `/access/${row.id}`)
    } catch (e) {
      console.warn(`  ⚠ revoke SPIELPLANER from ${row.user}: ${e.message.slice(0, 100)}`)
    }
  }
  if (spStale.length > 0) console.log(`  ✓ Revoked SPIELPLANER policy from ${spStale.length} ex-spielplaner user(s)`)

  // ── 11. Admin policy (admin_access=true — bypasses all) ────────

  console.log('\n11. Admin/Superuser — admin_access=true, bypasses all permissions')

  // ── Summary ──────���─────────────────────────────────────────────

  console.log(`\n${'═'.repeat(50)}`)
  console.log(`✅ Permission setup complete!`)
  console.log(`   ${stats.ok} permissions granted`)
  console.log(`   ${stats.err} errors`)
  console.log(`${'═'.repeat(50)}`)
  console.log(`\nRoles: ${Object.keys(roleMap).join(', ')}`)
  console.log(`Admin/Superuser: admin_access=true → bypass all permissions`)
  console.log(`Public: permissions on null-role policy "$t:public_label"\n`)
}

main().catch(err => {
  console.error('💥 Fatal error:', err)
  process.exit(1)
})
