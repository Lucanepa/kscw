/**
 * Migrate scorer/täfeler assignments from Supabase scorer_matches → PocketBase games.
 *
 * Matches by:  Supabase `gamen` → PocketBase `sv_game_id`
 * People by:   Supabase scorer_scorers name/email → PocketBase members name/email
 * Teams by:    Supabase short name (H1, D2, HL…) → PocketBase team ID
 *
 * Usage:
 *   DRY_RUN=1 npx tsx scripts/migrate-scorer-assignments.ts   # preview
 *   npx tsx scripts/migrate-scorer-assignments.ts              # write
 */

import PocketBase from 'pocketbase'
import { createClient } from '@supabase/supabase-js'

// ── Config ───────────────────────────────────────────────────────────

const DRY_RUN = !!process.env.DRY_RUN

const PB_URL = process.env.PB_URL ?? 'https://kscw-api.lucanepa.com'
const PB_EMAIL = process.env.PB_EMAIL ?? 'admin@kscw.ch'
const PB_PASSWORD = process.env.PB_PASSWORD ?? '@Bocconi13'

const SUPABASE_URL = 'https://wilrrlwqgvzjdhmnwmte.supabase.co'
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndpbHJybHdxZ3Z6amRobW53bXRlIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1MzYwNTY3NywiZXhwIjoyMDY5MTgxNjc3fQ.YHuL5lucY4DKYv3mdDSJCGy88z2Q1UI_si4D2bkIgWA'

// ── Clients ──────────────────────────────────────────────────────────

const pb = new PocketBase(PB_URL)
await pb.collection('_superusers').authWithPassword(PB_EMAIL, PB_PASSWORD)
console.log(`PocketBase: authenticated to ${PB_URL}`)

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
console.log('Supabase: connected')

if (DRY_RUN) console.log('\n*** DRY RUN — no writes ***\n')

// ── Fetch PocketBase data ────────────────────────────────────────────

console.log('\n=== Fetching PocketBase data ===')

const pbMembers = await pb.collection('members').getFullList<{
  id: string; first_name: string; last_name: string; email: string
}>({ sort: 'last_name' })
console.log(`  Members: ${pbMembers.length}`)

const pbTeams = await pb.collection('teams').getFullList<{
  id: string; name: string
}>({ sort: 'name' })
console.log(`  Teams: ${pbTeams.length}`)

const pbGames = await pb.collection('games').getFullList<{
  id: string; sv_game_id: string;
  scorer_member: string; taefeler_member: string; scorer_taefeler_member: string;
  scorer_duty_team: string; taefeler_duty_team: string; scorer_taefeler_duty_team: string;
}>({ sort: 'date' })
console.log(`  Games: ${pbGames.length}`)

// ── Build lookup maps ────────────────────────────────────────────────

// sv_game_id → PB game record
const gameByGamen = new Map<string, typeof pbGames[0]>()
for (const g of pbGames) {
  if (g.sv_game_id) gameByGamen.set(g.sv_game_id, g)
}

// Supabase team short name → PB team ID
// PB teams: H1, H2, H3, D1, D2, D3, D4, HU23-1, DU23-1, DU23-2, Legends
const TEAM_MAP: Record<string, string> = {}
for (const t of pbTeams) {
  TEAM_MAP[t.name] = t.id
}
// Supabase uses different short names for some teams
TEAM_MAP['HU23'] = TEAM_MAP['HU23-1'] ?? ''
TEAM_MAP['HL'] = TEAM_MAP['Legends'] ?? ''
// HU20 has no PB equivalent — will be skipped for team assignment

function resolveTeam(shortName: string | null): string {
  if (!shortName) return ''
  const id = TEAM_MAP[shortName]
  if (!id) {
    console.warn(`    ⚠ No PB team for "${shortName}"`)
    return ''
  }
  return id
}

// email (lowercase) → PB member
const memberByEmail = new Map<string, typeof pbMembers[0]>()
for (const m of pbMembers) {
  if (m.email) memberByEmail.set(m.email.toLowerCase(), m)
}

// "first last" (lowercase) → PB member
const memberByName = new Map<string, typeof pbMembers[0]>()
for (const m of pbMembers) {
  const key = `${m.first_name} ${m.last_name}`.toLowerCase().trim()
  memberByName.set(key, m)
}

function resolveMember(
  fname: string | null, lname: string | null, email: string | null,
): string {
  if (!fname && !lname && !email) return ''

  // Try email first
  if (email) {
    const byEmail = memberByEmail.get(email.toLowerCase().trim())
    if (byEmail) return byEmail.id
  }

  // Try name match
  if (fname && lname) {
    const key = `${fname.trim()} ${lname.trim()}`.toLowerCase()
    const byName = memberByName.get(key)
    if (byName) return byName.id

    // Try partial: first name only match with last name
    for (const m of pbMembers) {
      if (
        m.last_name?.toLowerCase().trim() === lname.trim().toLowerCase() &&
        m.first_name?.toLowerCase().trim().startsWith(fname.trim().toLowerCase().split(' ')[0])
      ) {
        return m.id
      }
    }
  }

  if (fname || lname) {
    console.warn(`    ⚠ No PB member for "${fname} ${lname}" (${email})`)
  }
  return ''
}

// ── Fetch Supabase scorer_matches with joined people ─────────────────

console.log('\n=== Fetching Supabase scorer_matches ===')

const { data: matches, error: matchErr } = await supabase.rpc('', {}).then(() => null as any).catch(() => null as any)
  ?? { data: null, error: null }

// Use raw SQL query via joined select
const { data: scorerMatches, error: smErr } = await supabase
  .from('scorer_matches')
  .select(`
    match_id, gamen,
    scorer_team, taefeler_team, scorer_taefeler_team,
    scorer:scorer_scorers!fk_scorer_matches_scorer_id(fname, lname, email),
    taefeler:scorer_scorers!fk_scorer_matches_taefeler_id(fname, lname, email),
    combined:scorer_scorers!scorer_matches_scorer_taefeler_id_fkey(fname, lname, email)
  `)
  .order('match_id')

if (smErr) throw new Error(`scorer_matches fetch: ${smErr.message}`)
console.log(`  scorer_matches: ${scorerMatches!.length} rows`)

// ── Migrate ──────────────────────────────────────────────────────────

console.log('\n=== Migrating scorer assignments ===')

let updated = 0
let skipped = 0
let noGame = 0
let alreadySet = 0

for (const sm of scorerMatches!) {
  const gamen = String(sm.gamen)
  const pbGame = gameByGamen.get(gamen)

  if (!pbGame) {
    noGame++
    continue
  }

  // Resolve people
  const scorer = sm.scorer as any
  const taefeler = sm.taefeler as any
  const combined = sm.combined as any

  const scorerMemberId = resolveMember(
    scorer?.fname, scorer?.lname, scorer?.email
  )
  const taefelerMemberId = resolveMember(
    taefeler?.fname, taefeler?.lname, taefeler?.email
  )
  const combinedMemberId = resolveMember(
    combined?.fname, combined?.lname, combined?.email
  )

  // Resolve teams
  const scorerTeamId = resolveTeam(sm.scorer_team)
  const taefelerTeamId = resolveTeam(sm.taefeler_team)
  const combinedTeamId = resolveTeam(sm.scorer_taefeler_team)

  // Build update payload — only set fields that have values and differ from current
  const updates: Record<string, string> = {}

  if (scorerMemberId && pbGame.scorer_member !== scorerMemberId)
    updates.scorer_member = scorerMemberId
  if (taefelerMemberId && pbGame.taefeler_member !== taefelerMemberId)
    updates.taefeler_member = taefelerMemberId
  if (combinedMemberId && pbGame.scorer_taefeler_member !== combinedMemberId)
    updates.scorer_taefeler_member = combinedMemberId

  if (scorerTeamId && pbGame.scorer_duty_team !== scorerTeamId)
    updates.scorer_duty_team = scorerTeamId
  if (taefelerTeamId && pbGame.taefeler_duty_team !== taefelerTeamId)
    updates.taefeler_duty_team = taefelerTeamId
  if (combinedTeamId && pbGame.scorer_taefeler_duty_team !== combinedTeamId)
    updates.scorer_taefeler_duty_team = combinedTeamId

  if (Object.keys(updates).length === 0) {
    alreadySet++
    continue
  }

  console.log(`  Game ${gamen} (${pbGame.id}): ${JSON.stringify(updates)}`)

  if (!DRY_RUN) {
    await pb.collection('games').update(pbGame.id, updates)
    updated++
  } else {
    updated++
  }
}

console.log(`\n=== Summary ===`)
console.log(`  Updated: ${updated}`)
console.log(`  Already set: ${alreadySet}`)
console.log(`  No matching PB game: ${noGame}`)
console.log(`  Skipped (no data): ${skipped}`)
console.log(`\nDone!`)
