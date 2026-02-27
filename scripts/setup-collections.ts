import PocketBase from 'pocketbase'

const PB_URL = process.env.PB_URL ?? 'https://kscw-api-dev.lucanepa.com'
const PB_EMAIL = process.env.PB_EMAIL ?? 'admin@kscw.ch'
const PB_PASSWORD = process.env.PB_PASSWORD ?? '@Bocconi13'

const pb = new PocketBase(PB_URL)
await pb.collection('_superusers').authWithPassword(PB_EMAIL, PB_PASSWORD)
console.log(`Authenticated to ${PB_URL}`)

// ── helpers ──────────────────────────────────────────────────────────

function text(name: string, opts: Record<string, unknown> = {}) {
  return { name, type: 'text', ...opts }
}
function number(name: string, opts: Record<string, unknown> = {}) {
  return { name, type: 'number', ...opts }
}
function bool(name: string, opts: Record<string, unknown> = {}) {
  return { name, type: 'bool', ...opts }
}
function email(name: string, opts: Record<string, unknown> = {}) {
  return { name, type: 'email', ...opts }
}
function url(name: string, opts: Record<string, unknown> = {}) {
  return { name, type: 'url', ...opts }
}
function date(name: string, opts: Record<string, unknown> = {}) {
  return { name, type: 'date', ...opts }
}
function json(name: string, opts: Record<string, unknown> = {}) {
  return { name, type: 'json', ...opts }
}
function file(name: string, opts: Record<string, unknown> = {}) {
  return { name, type: 'file', maxSelect: 1, ...opts }
}
function select(name: string, values: string[], opts: Record<string, unknown> = {}) {
  return { name, type: 'select', values, maxSelect: 1, ...opts }
}
function relation(name: string, collectionId: string, opts: Record<string, unknown> = {}) {
  return { name, type: 'relation', collectionId, maxSelect: 1, ...opts }
}
function autodate(name: string, opts: Record<string, unknown> = {}) {
  return { name, type: 'autodate', onCreate: true, onUpdate: true, ...opts }
}

// ── collection definitions (order matters for relations) ─────────────

interface CollectionDef {
  name: string
  type: 'base' | 'auth'
  fields: Record<string, unknown>[]
}

const collections: CollectionDef[] = [
  // 1. halls (no relations)
  {
    name: 'halls',
    type: 'base',
    fields: [
      text('name', { required: true }),
      text('address'),
      text('city'),
      number('courts'),
      text('notes'),
      url('maps_url'),
      bool('homologation'),
    ],
  },

  // 2. teams (coach relation → members, created later — use text for now, will be patched)
  {
    name: 'teams',
    type: 'base',
    fields: [
      text('name', { required: true }),
      text('full_name'),
      text('sv_team_id'),
      select('sport', ['volleyball', 'basketball']),
      text('league'),
      text('season'),
      text('color'),
      text('coach_id'), // placeholder — patched to relation after members exists
      bool('active'),
    ],
  },

  // 3. members (auth collection)
  {
    name: 'members',
    type: 'auth',
    fields: [
      text('first_name'),
      text('last_name'),
      text('phone'),
      text('license_nr'),
      number('number'),
      select('position', ['setter', 'outside', 'middle', 'opposite', 'libero', 'coach', 'other']),
      file('photo', { maxSize: 5242880, mimeTypes: ['image/jpeg', 'image/png', 'image/webp'] }),
      select('role', ['player', 'coach', 'vorstand', 'admin']),
      bool('active'),
    ],
  },

  // 4–12 depend on the above three
]

// We'll create the first three, then grab their IDs for relations

async function createCollection(def: CollectionDef) {
  try {
    const record = await pb.collections.create({
      name: def.name,
      type: def.type,
      fields: def.fields,
    })
    console.log(`  ✓ ${def.name} (${record.id})`)
    return record
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : JSON.stringify(err)
    console.error(`  ✗ ${def.name}: ${msg}`)
    throw err
  }
}

async function getCollectionId(name: string): Promise<string> {
  const col = await pb.collections.getOne(name)
  return col.id
}

// ── main ─────────────────────────────────────────────────────────────

console.log('\n=== Phase 1: Create base collections ===')
for (const def of collections) {
  await createCollection(def)
}

// Grab IDs
const hallsId = await getCollectionId('halls')
const teamsId = await getCollectionId('teams')
const membersId = await getCollectionId('members')

// Patch teams.coach_id → relation to members
console.log('\n=== Patching teams.coach → relation to members ===')
const teamsCol = await pb.collections.getOne('teams')
const patchedFields = teamsCol.fields
  .filter((f: { name: string }) => f.name !== 'coach_id')
  .concat([relation('coach', membersId)])
await pb.collections.update(teamsCol.id, { fields: patchedFields })
console.log('  ✓ teams.coach patched')

// Phase 2: collections that depend on the above
console.log('\n=== Phase 2: Create dependent collections ===')

const dependentCollections: CollectionDef[] = [
  // member_teams
  {
    name: 'member_teams',
    type: 'base',
    fields: [
      relation('member', membersId, { required: true }),
      relation('team', teamsId, { required: true }),
      text('season'),
      select('role', ['player', 'coach', 'captain', 'assistant']),
    ],
  },

  // hall_slots
  {
    name: 'hall_slots',
    type: 'base',
    fields: [
      relation('hall', hallsId, { required: true }),
      relation('team', teamsId),
      number('day_of_week'),
      text('start_time'),
      text('end_time'),
      select('slot_type', ['training', 'game', 'event', 'other']),
      bool('recurring'),
      date('valid_from'),
      date('valid_until'),
      text('label'),
      text('notes'),
    ],
  },

  // hall_closures
  {
    name: 'hall_closures',
    type: 'base',
    fields: [
      relation('hall', hallsId, { required: true }),
      date('start_date'),
      date('end_date'),
      text('reason'),
      select('source', ['hauswart', 'admin', 'auto']),
    ],
  },

  // games
  {
    name: 'games',
    type: 'base',
    fields: [
      text('sv_game_id'),
      text('home_team'),
      text('away_team'),
      relation('kscw_team', teamsId),
      relation('hall', hallsId),
      date('date'),
      text('time'),
      text('league'),
      text('round'),
      text('season'),
      select('type', ['home', 'away']),
      select('status', ['scheduled', 'live', 'completed', 'postponed']),
      number('home_score'),
      number('away_score'),
      json('sets_json'),
      text('scorer_team'),
      text('scorer_person'),
      text('taefeler_team'),
      text('taefeler_person'),
      bool('duty_confirmed'),
      select('source', ['swiss_volley', 'manual']),
    ],
  },

  // sv_rankings
  {
    name: 'sv_rankings',
    type: 'base',
    fields: [
      text('sv_team_id'),
      text('league'),
      number('rank'),
      number('played'),
      number('won'),
      number('lost'),
      number('sets_won'),
      number('sets_lost'),
      number('points_won'),
      number('points_lost'),
      number('points'),
      text('season'),
      date('updated_at'),
    ],
  },

  // absences (needed before training_attendance)
  {
    name: 'absences',
    type: 'base',
    fields: [
      relation('member', membersId, { required: true }),
      date('start_date'),
      date('end_date'),
      select('reason', ['injury', 'vacation', 'work', 'personal', 'other']),
      text('reason_detail'),
      json('affects'),
      bool('approved'),
    ],
  },

  // events
  {
    name: 'events',
    type: 'base',
    fields: [
      text('title', { required: true }),
      text('description'),
      select('event_type', ['verein', 'social', 'meeting', 'tournament', 'other']),
      date('start_date'),
      date('end_date'),
      bool('all_day'),
      text('location'),
      relation('teams', teamsId, { maxSelect: 99 }),
      relation('created_by', membersId),
    ],
  },

  // participations (RSVP for trainings, games, events)
  {
    name: 'participations',
    type: 'base',
    fields: [
      relation('member', membersId, { required: true }),
      select('activity_type', ['training', 'game', 'event'], { required: true }),
      text('activity_id', { required: true }),
      select('status', ['confirmed', 'declined', 'tentative'], { required: true }),
      text('note'),
    ],
  },
]

for (const def of dependentCollections) {
  await createCollection(def)
}

// Add unique index to participations
console.log('\n=== Adding participations unique index ===')
const participationsCol = await pb.collections.getOne('participations')
await pb.collections.update(participationsCol.id, {
  indexes: [
    'CREATE UNIQUE INDEX idx_participation_unique ON participations (member, activity_type, activity_id)',
  ],
})
console.log('  ✓ participations unique index added')

// Phase 3: collections that depend on phase 2
console.log('\n=== Phase 3: Create collections with phase-2 dependencies ===')

const hallSlotsId = await getCollectionId('hall_slots')
const absencesId = await getCollectionId('absences')

const phase3Collections: CollectionDef[] = [
  // trainings
  {
    name: 'trainings',
    type: 'base',
    fields: [
      relation('team', teamsId, { required: true }),
      relation('hall_slot', hallSlotsId),
      date('date'),
      text('start_time'),
      text('end_time'),
      relation('hall', hallsId),
      relation('coach', membersId),
      text('notes'),
      bool('cancelled'),
      text('cancel_reason'),
    ],
  },
]

for (const def of phase3Collections) {
  await createCollection(def)
}

const trainingsId = await getCollectionId('trainings')

// training_attendance (depends on trainings + absences)
const trainingAttendance: CollectionDef = {
  name: 'training_attendance',
  type: 'base',
  fields: [
    relation('training', trainingsId, { required: true }),
    relation('member', membersId, { required: true }),
    select('status', ['present', 'absent', 'late', 'excused']),
    relation('absence', absencesId),
    relation('noted_by', membersId),
  ],
}

await createCollection(trainingAttendance)

console.log('\n=== All collections created successfully! ===')
