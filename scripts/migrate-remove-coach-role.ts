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

const DRY_RUN = !!process.env.DRY_RUN

const PB_URL = process.env.PB_URL ?? 'https://kscw-api.lucanepa.com'
const PB_EMAIL = process.env.PB_EMAIL ?? 'admin@kscw.ch'
const PB_PASSWORD = process.env.PB_PASSWORD ?? 'thamykscw_1972'

const HEADERS = { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' }

// Authenticate
const authRes = await fetch(`${PB_URL}/api/collections/_superusers/auth-with-password`, {
  method: 'POST',
  headers: HEADERS,
  body: JSON.stringify({ identity: PB_EMAIL, password: PB_PASSWORD }),
})
const authData = await authRes.json() as { token: string }
const TOKEN = authData.token
console.log(`Authenticated to ${PB_URL}`)

if (DRY_RUN) console.log('\n*** DRY RUN — no writes ***\n')

const authHeaders: Record<string, string> = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
  'Authorization': `Bearer ${TOKEN}`,
}

interface PBMember {
  id: string
  name: string
  first_name: string
  last_name: string
  email: string
  role: string[]
}

// Fetch all members
const members: PBMember[] = []
let page = 1
while (true) {
  const res = await fetch(`${PB_URL}/api/collections/members/records?page=${page}&perPage=200&sort=last_name`, {
    headers: authHeaders,
  })
  const data = await res.json() as { items: PBMember[]; totalItems: number }
  if (!data.items) { console.log('Unexpected response:', JSON.stringify(data).slice(0, 200)); process.exit(1) }
  members.push(...data.items)
  if (page * 200 >= data.totalItems) break
  page++
}
console.log(`Total members: ${members.length}`)

const withCoach = members.filter((m) => m.role.includes('coach'))
console.log(`Members with 'coach' in role: ${withCoach.length}`)

// Fetch member_teams with coach/assistant role
const mtRes = await fetch(`${PB_URL}/api/collections/member_teams/records?page=1&perPage=500&filter=${encodeURIComponent('role="coach" || role="assistant"')}`, {
  headers: authHeaders,
})
const mtData = await mtRes.json() as { items: { member: string }[] }
const coachMemberIds = new Set(mtData.items.map((mt) => mt.member))

let updated = 0
let warnings = 0

for (const m of withCoach) {
  const newRole = m.role.filter((r: string) => r !== 'coach')
  const hasTeamCoachRole = coachMemberIds.has(m.id)

  if (!hasTeamCoachRole) {
    console.log(`  WARNING: ${m.name || m.first_name + ' ' + m.last_name} (${m.email}) has members.role='coach' but NO member_teams coach/assistant entry`)
    warnings++
  }

  const displayName = m.name || `${m.first_name} ${m.last_name}`
  console.log(`  ${displayName}: [${m.role.join(', ')}] → [${newRole.join(', ')}]${hasTeamCoachRole ? '' : ' ⚠️'}`)

  if (!DRY_RUN) {
    await fetch(`${PB_URL}/api/collections/members/records/${m.id}`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ role: newRole }),
    })
  }
  updated++
}

console.log(`\nDone: ${updated} members updated, ${warnings} warnings`)
if (warnings > 0) {
  console.log('⚠️  Members with warnings have no team-scoped coach role — they will lose coach permissions.')
}
