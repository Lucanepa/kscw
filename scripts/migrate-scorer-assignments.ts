/**
 * Migrate scorer/täfeler assignments from Supabase scorer_matches → PocketBase games.
 *
 * Phase 1: Create missing members from scorer_scorers (with scorer_licence + member_teams)
 * Phase 2: Assign scorer/täfeler/combined people + duty teams to PB games
 *
 * Matches by:  Supabase `gamen` → PocketBase `sv_game_id`
 * People by:   Supabase scorer_scorers email/name → PocketBase members email/name
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
const SEASON = '2024/25'

const PB_URL = process.env.PB_URL ?? 'https://kscw-api.lucanepa.com'
const PB_EMAIL = process.env.PB_EMAIL ?? 'admin@kscw.ch'
const PB_PASSWORD = process.env.PB_PASSWORD ?? 'thamykscw_1972'

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

interface PBMember {
  id: string; first_name: string; last_name: string; email: string; scorer_licence: boolean
}

const pbMembers = await pb.collection('members').getFullList<PBMember>({ sort: 'last_name' })
console.log(`  Members: ${pbMembers.length}`)

const pbTeams = await pb.collection('teams').getFullList<{ id: string; name: string }>({ sort: 'name' })
console.log(`  Teams: ${pbTeams.length}`)

const pbGames = await pb.collection('games').getFullList<{
  id: string; sv_game_id: string;
  scorer_member: string; taefeler_member: string; scorer_taefeler_member: string;
  scorer_duty_team: string; taefeler_duty_team: string; scorer_taefeler_duty_team: string;
}>({ sort: 'date' })
console.log(`  Games: ${pbGames.length}`)

const existingMTs = await pb.collection('member_teams').getFullList({ filter: `season="${SEASON}"` })
console.log(`  Member_teams (${SEASON}): ${existingMTs.length}`)

// ── Build lookup maps ────────────────────────────────────────────────

// sv_game_id → PB game record
const gameByGamen = new Map<string, typeof pbGames[0]>()
for (const g of pbGames) {
  if (g.sv_game_id) gameByGamen.set(g.sv_game_id, g)
}

// Supabase team short name → PB team ID
const TEAM_MAP: Record<string, string> = {}
for (const t of pbTeams) {
  TEAM_MAP[t.name] = t.id
}
TEAM_MAP['HU23'] = TEAM_MAP['HU23-1'] ?? ''
TEAM_MAP['HL'] = TEAM_MAP['Legends'] ?? ''
// HU20 has no PB equivalent — skip

function resolveTeam(shortName: string | null): string {
  if (!shortName) return ''
  return TEAM_MAP[shortName] ?? ''
}

// email (lowercase) → PB member
const memberByEmail = new Map<string, PBMember>()
for (const m of pbMembers) {
  if (m.email) memberByEmail.set(m.email.toLowerCase().trim(), m)
}

// "first last" (lowercase) → PB member
const memberByName = new Map<string, PBMember>()
for (const m of pbMembers) {
  const key = `${m.first_name} ${m.last_name}`.toLowerCase().trim()
  memberByName.set(key, m)
}

function findMember(fname: string | null, lname: string | null, email: string | null): PBMember | undefined {
  if (!fname && !lname && !email) return undefined

  if (email) {
    const byEmail = memberByEmail.get(email.toLowerCase().trim())
    if (byEmail) return byEmail
  }

  if (fname && lname) {
    const key = `${fname.trim()} ${lname.trim()}`.toLowerCase()
    const byName = memberByName.get(key)
    if (byName) return byName
  }

  return undefined
}

function randomPassword(): string {
  return `Tmp_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
}

// ── Phase 1: Fetch all unique scorer people & create missing members ──

console.log('\n=== Phase 1: Creating missing members ===')

// Get all unique people who appear in scorer_matches assignments
const { data: assignedPeople, error: apErr } = await supabase.rpc('', {}).then(() => null as any).catch(() => null)
  ?? { data: null, error: null }

// Fetch people directly: all scorer_scorers referenced in matches
const { data: allScorerPeople, error: spErr } = await supabase
  .from('scorer_scorers')
  .select('id, fname, lname, email, scorer_licence, teams')
  .order('lname')

if (spErr) throw new Error(`scorer_scorers fetch: ${spErr.message}`)
console.log(`  Supabase scorer_scorers: ${allScorerPeople!.length} total`)

// Also fetch which scorer_scorers IDs are actually used in matches
const { data: matchRefs, error: mrErr } = await supabase
  .from('scorer_matches')
  .select('scorer_id, taefeler_id, scorer_taefeler_id')

if (mrErr) throw new Error(`match refs fetch: ${mrErr.message}`)

const usedIds = new Set<string>()
for (const m of matchRefs!) {
  if (m.scorer_id) usedIds.add(m.scorer_id)
  if (m.taefeler_id) usedIds.add(m.taefeler_id)
  if (m.scorer_taefeler_id) usedIds.add(m.scorer_taefeler_id)
}

// Filter to only people actually assigned to games
const scorerPeople = allScorerPeople!.filter((p: any) => usedIds.has(p.id))
console.log(`  People actually assigned to games: ${scorerPeople.length}`)

let membersCreated = 0
let membersExisting = 0
let memberTeamsCreated = 0

for (const sp of scorerPeople) {
  const fname = (sp.fname as string)?.trim()
  const lname = (sp.lname as string)?.trim()
  const email = (sp.email as string)?.trim()
  const hasLicence = sp.scorer_licence as boolean
  const teams = (sp.teams as string[]) ?? []

  if (!fname || !lname) continue

  let member = findMember(fname, lname, email)

  if (member) {
    membersExisting++

    // Update scorer_licence if needed
    if (hasLicence && !member.scorer_licence) {
      if (!DRY_RUN) {
        await pb.collection('members').update(member.id, { scorer_licence: true })
      }
      console.log(`  UPDATE scorer_licence: ${fname} ${lname} (${member.id})`)
    }
  } else {
    // Create new member
    membersCreated++
    console.log(`  CREATE: ${fname} ${lname} (${email})`)

    if (!DRY_RUN) {
      const password = randomPassword()
      const newMember = await pb.collection('members').create({
        email: email || `${fname.toLowerCase().replace(/\s/g, '')}.${lname.toLowerCase().replace(/\s/g, '')}@placeholder.kscw.ch`,
        password,
        passwordConfirm: password,
        first_name: fname,
        last_name: lname,
        name: `${fname} ${lname}`,
        role: ['player'],
        active: true,
        scorer_licence: hasLicence,
      })
      member = newMember as unknown as PBMember

      // Add to lookup maps
      pbMembers.push(member)
      if (member.email) memberByEmail.set(member.email.toLowerCase().trim(), member)
      memberByName.set(`${fname} ${lname}`.toLowerCase(), member)

      console.log(`    → Created: ${member.id}`)
    } else {
      // In dry run, create a fake member for counting purposes
      const fakeMember = { id: `DRY_${fname}_${lname}`, first_name: fname, last_name: lname, email: email || '', scorer_licence: hasLicence }
      pbMembers.push(fakeMember as PBMember)
      if (email) memberByEmail.set(email.toLowerCase().trim(), fakeMember as PBMember)
      memberByName.set(`${fname} ${lname}`.toLowerCase(), fakeMember as PBMember)
      member = fakeMember as PBMember
    }
  }

  // Create member_teams for each team (if not exists)
  if (member) {
    for (const teamShort of teams) {
      const teamId = resolveTeam(teamShort)
      if (!teamId) continue

      const hasMT = existingMTs.some(
        (mt) => mt.member === member!.id && mt.team === teamId,
      )
      if (!hasMT) {
        memberTeamsCreated++
        if (!DRY_RUN) {
          const mt = await pb.collection('member_teams').create({
            member: member.id,
            team: teamId,
            season: SEASON,
            role: 'player',
          })
          existingMTs.push(mt)
        }
        console.log(`    member_team: ${fname} ${lname} → ${teamShort}`)
      }
    }
  }
}

console.log(`\n  Phase 1 summary:`)
console.log(`    Members existing: ${membersExisting}`)
console.log(`    Members created: ${membersCreated}`)
console.log(`    Member_teams created: ${memberTeamsCreated}`)

// ── Phase 2: Assign scorer/täfeler to games ──────────────────────────

console.log('\n=== Phase 2: Assigning scorer duties to games ===')

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

let gamesUpdated = 0
let gamesAlreadySet = 0
let gamesNoMatch = 0

for (const sm of scorerMatches!) {
  const gamen = String(sm.gamen)
  const pbGame = gameByGamen.get(gamen)

  if (!pbGame) {
    gamesNoMatch++
    continue
  }

  const scorer = sm.scorer as any
  const taefeler = sm.taefeler as any
  const combined = sm.combined as any

  const scorerMember = findMember(scorer?.fname, scorer?.lname, scorer?.email)
  const taefelerMember = findMember(taefeler?.fname, taefeler?.lname, taefeler?.email)
  const combinedMember = findMember(combined?.fname, combined?.lname, combined?.email)

  const scorerTeamId = resolveTeam(sm.scorer_team)
  const taefelerTeamId = resolveTeam(sm.taefeler_team)
  const combinedTeamId = resolveTeam(sm.scorer_taefeler_team)

  const updates: Record<string, string> = {}

  if (scorerMember?.id && pbGame.scorer_member !== scorerMember.id)
    updates.scorer_member = scorerMember.id
  if (taefelerMember?.id && pbGame.taefeler_member !== taefelerMember.id)
    updates.taefeler_member = taefelerMember.id
  if (combinedMember?.id && pbGame.scorer_taefeler_member !== combinedMember.id)
    updates.scorer_taefeler_member = combinedMember.id

  if (scorerTeamId && pbGame.scorer_duty_team !== scorerTeamId)
    updates.scorer_duty_team = scorerTeamId
  if (taefelerTeamId && pbGame.taefeler_duty_team !== taefelerTeamId)
    updates.taefeler_duty_team = taefelerTeamId
  if (combinedTeamId && pbGame.scorer_taefeler_duty_team !== combinedTeamId)
    updates.scorer_taefeler_duty_team = combinedTeamId

  if (Object.keys(updates).length === 0) {
    gamesAlreadySet++
    continue
  }

  const fields = Object.keys(updates).join(', ')
  console.log(`  Game ${gamen} (${pbGame.id}): ${fields}`)

  if (!DRY_RUN) {
    await pb.collection('games').update(pbGame.id, updates)
  }
  gamesUpdated++
}

console.log(`\n=== Final Summary ===`)
console.log(`  Phase 1 — Members:`)
console.log(`    Existing: ${membersExisting}`)
console.log(`    Created: ${membersCreated}`)
console.log(`    Member_teams created: ${memberTeamsCreated}`)
console.log(`  Phase 2 — Games:`)
console.log(`    Updated: ${gamesUpdated}`)
console.log(`    Already set: ${gamesAlreadySet}`)
console.log(`    No matching PB game: ${gamesNoMatch}`)
console.log(`\nDone!`)
