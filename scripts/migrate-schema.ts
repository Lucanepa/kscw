import PocketBase from 'pocketbase'

const PB_URL = process.env.PB_URL ?? 'https://kscw-api.lucanepa.com'
const PB_EMAIL = process.env.PB_EMAIL ?? 'admin@kscw.ch'
const PB_PASSWORD = process.env.PB_PASSWORD ?? '@Bocconi13'

const pb = new PocketBase(PB_URL)
await pb.collection('_superusers').authWithPassword(PB_EMAIL, PB_PASSWORD)
console.log(`Authenticated to ${PB_URL}`)

// ── Members: add birthdate + yob ──────────────────────────────────────

console.log('\n=== Updating members collection ===')
const membersCol = await pb.collections.getOne('members')
const existingMemberFields = membersCol.fields.map((f: { name: string }) => f.name)

const newMemberFields = []
if (!existingMemberFields.includes('birthdate')) {
  newMemberFields.push({ name: 'birthdate', type: 'date' })
}
if (!existingMemberFields.includes('yob')) {
  newMemberFields.push({ name: 'yob', type: 'number' })
}

if (newMemberFields.length > 0) {
  await pb.collections.update(membersCol.id, {
    fields: [...membersCol.fields, ...newMemberFields],
  })
  console.log(`  + Added to members: ${newMemberFields.map((f) => f.name).join(', ')}`)
} else {
  console.log('  Members already has birthdate + yob')
}

// ── Teams: add team_picture, social_url, sponsors, sponsors_logos ─────

console.log('\n=== Updating teams collection ===')
const teamsCol = await pb.collections.getOne('teams')
const existingTeamFields = teamsCol.fields.map((f: { name: string }) => f.name)

const newTeamFields = []
if (!existingTeamFields.includes('team_picture')) {
  newTeamFields.push({
    name: 'team_picture',
    type: 'file',
    maxSelect: 1,
    maxSize: 10485760,
    mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  })
}
if (!existingTeamFields.includes('social_url')) {
  newTeamFields.push({ name: 'social_url', type: 'url' })
}
if (!existingTeamFields.includes('sponsors')) {
  newTeamFields.push({ name: 'sponsors', type: 'json' })
}
if (!existingTeamFields.includes('sponsors_logos')) {
  newTeamFields.push({
    name: 'sponsors_logos',
    type: 'file',
    maxSelect: 20,
    maxSize: 5242880,
    mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'],
  })
}

if (newTeamFields.length > 0) {
  await pb.collections.update(teamsCol.id, {
    fields: [...teamsCol.fields, ...newTeamFields],
  })
  console.log(`  + Added to teams: ${newTeamFields.map((f) => f.name).join(', ')}`)
} else {
  console.log('  Teams already has all new fields')
}

console.log('\nSchema migration complete!')
