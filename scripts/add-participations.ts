import PocketBase from 'pocketbase'

const PB_URL = process.env.PB_URL ?? 'https://kscw-api-dev.lucanepa.com'
const PB_EMAIL = process.env.PB_EMAIL ?? 'admin@kscw.ch'
const PB_PASSWORD = process.env.PB_PASSWORD!

const pb = new PocketBase(PB_URL)
await pb.collection('_superusers').authWithPassword(PB_EMAIL, PB_PASSWORD)
console.log(`Authenticated to ${PB_URL}`)

// Get members collection ID for relation
const membersCol = await pb.collections.getOne('members')
const membersId = membersCol.id

console.log('\n=== Creating participations collection ===')

try {
  await pb.collections.create({
    name: 'participations',
    type: 'base',
    fields: [
      { name: 'member', type: 'relation', collectionId: membersId, required: true, maxSelect: 1 },
      { name: 'activity_type', type: 'select', values: ['training', 'game', 'event'], required: true, maxSelect: 1 },
      { name: 'activity_id', type: 'text', required: true },
      { name: 'status', type: 'select', values: ['confirmed', 'declined', 'tentative'], required: true, maxSelect: 1 },
      { name: 'note', type: 'text' },
    ],
    indexes: [
      'CREATE UNIQUE INDEX idx_participation_unique ON participations (member, activity_type, activity_id)',
    ],
  })
  console.log('  ✓ participations collection created')
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : JSON.stringify(err)
  console.error(`  ✗ participations: ${msg}`)
}

console.log('\n=== Done! ===')
