import PocketBase from 'pocketbase'

const PB_URL = process.env.PB_URL ?? 'https://kscw-api-dev.lucanepa.com'
const PB_EMAIL = process.env.PB_EMAIL ?? 'admin@kscw.ch'
const PB_PASSWORD = process.env.PB_PASSWORD ?? 'thamykscw_1972'

const pb = new PocketBase(PB_URL)
await pb.collection('_superusers').authWithPassword(PB_EMAIL, PB_PASSWORD)

interface HallSeed {
  name: string
  address: string
  city: string
  courts: number
  notes: string
  homologation: boolean
}

const halls: HallSeed[] = [
  {
    name: 'KWI A',
    address: 'Küngenmattstrasse 19',
    city: '8055 Zürich',
    courts: 1,
    notes: 'Küngenmatt',
    homologation: true,
  },
  {
    name: 'KWI B',
    address: 'Küngenmattstrasse 19',
    city: '8055 Zürich',
    courts: 1,
    notes: 'Küngenmatt',
    homologation: true,
  },
  {
    name: 'KWI C',
    address: 'Küngenmattstrasse 19',
    city: '8055 Zürich',
    courts: 1,
    notes: 'Küngenmatt',
    homologation: true,
  },
  {
    name: 'Döltschi',
    address: 'Döltschiweg 184',
    city: '8055 Zürich',
    courts: 2,
    notes: 'Schul- und Sportanlage Döltschi — Doppelhalle',
    homologation: true,
  },
  {
    name: 'Rebhügel',
    address: 'Haldenstrasse 70',
    city: '8045 Zürich',
    courts: 1,
    notes: 'Schulhaus Rebhügel',
    homologation: false,
  },
  {
    name: 'Manegg',
    address: 'Tannenrauchstrasse 10',
    city: '8038 Zürich',
    courts: 1,
    notes: 'Schulhaus Manegg',
    homologation: false,
  },
  {
    name: 'Borrweg 1',
    address: 'Borrweg 81',
    city: '8055 Zürich',
    courts: 1,
    notes: 'Schul- und Sportanlage Borrweg',
    homologation: false,
  },
  {
    name: 'Borrweg 2',
    address: 'Borrweg 81',
    city: '8055 Zürich',
    courts: 1,
    notes: 'Schul- und Sportanlage Borrweg',
    homologation: false,
  },
  {
    name: 'Entlisberg',
    address: 'Balberstrasse 71',
    city: '8038 Zürich',
    courts: 1,
    notes: 'Schulhaus Entlisberg',
    homologation: false,
  },
  {
    name: 'Zurlinden',
    address: 'Zentralstrasse 105',
    city: '8003 Zürich',
    courts: 1,
    notes: 'Kindergartenhaus Wiedikon',
    homologation: false,
  },
  {
    name: 'Fronwald',
    address: 'Fronwaldstrasse 115',
    city: '8046 Zürich',
    courts: 3,
    notes: 'Sportzentrum Fronwald — Dreifachhalle',
    homologation: false,
  },
]

console.log(`Seeding ${halls.length} halls into ${PB_URL}...`)

for (const hall of halls) {
  try {
    const record = await pb.collection('halls').create(hall)
    console.log(`  ✓ ${hall.name} (${record.id})`)
  } catch (err) {
    console.error(`  ✗ ${hall.name}:`, err)
  }
}

console.log('Done.')
