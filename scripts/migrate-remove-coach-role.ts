/**
 * Remove 'coach' from members.role arrays.
 *
 * Coach permissions now come from member_teams.role, not members.role.
 * This script strips the legacy 'coach' value from all members.
 *
 * Usage:
 *   DRY_RUN=1 npx tsx scripts/migrate-remove-coach-role.ts   # preview
 *   npx tsx scripts/migrate-remove-coach-role.ts              # write
 */

import PocketBase from 'pocketbase'

const DRY_RUN = !!process.env.DRY_RUN

const PB_URL = process.env.PB_URL ?? 'https://kscw-api.lucanepa.com'
const PB_EMAIL = process.env.PB_EMAIL ?? 'admin@kscw.ch'
const PB_PASSWORD = process.env.PB_PASSWORD ?? 'thamykscw_1972'

const pb = new PocketBase(PB_URL)
await pb.collection('_superusers').authWithPassword(PB_EMAIL, PB_PASSWORD)
console.log(`Authenticated to ${PB_URL}`)

if (DRY_RUN) console.log('\n*** DRY RUN — no writes ***\n')

interface PBMember {
  id: string
  name: string
  email: string
  role: string[]
}

const members = await pb.collection('members').getFullList<PBMember>({ sort: 'name' })
console.log(`Total members: ${members.length}`)

const withCoach = members.filter((m) => m.role.includes('coach'))
console.log(`Members with 'coach' in role: ${withCoach.length}`)

// Verify they have member_teams with coach/assistant role
const coachMTs = await pb.collection('member_teams').getFullList({
  filter: 'role="coach" || role="assistant"',
})
const coachMemberIds = new Set(coachMTs.map((mt) => mt.member))

let updated = 0
let warnings = 0

for (const m of withCoach) {
  const newRole = m.role.filter((r) => r !== 'coach')
  const hasTeamCoachRole = coachMemberIds.has(m.id)

  if (!hasTeamCoachRole) {
    console.log(`  WARNING: ${m.name} (${m.email}) has members.role='coach' but NO member_teams coach/assistant entry`)
    warnings++
  }

  console.log(`  ${m.name}: [${m.role.join(', ')}] → [${newRole.join(', ')}]${hasTeamCoachRole ? '' : ' ⚠️'}`)

  if (!DRY_RUN) {
    await pb.collection('members').update(m.id, { role: newRole })
  }
  updated++
}

console.log(`\nDone: ${updated} members updated, ${warnings} warnings`)
if (warnings > 0) {
  console.log('⚠️  Members with warnings have no team-scoped coach role — they will lose coach permissions.')
}
