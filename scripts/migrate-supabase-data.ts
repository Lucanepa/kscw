/**
 * Migrate player data + photos from Supabase (h3_kscw, d2_kscw) into PocketBase members.
 *
 * Usage:
 *   DRY_RUN=1 npx tsx scripts/migrate-supabase-data.ts   # preview only
 *   npx tsx scripts/migrate-supabase-data.ts              # write to PocketBase
 */

import PocketBase from 'pocketbase'
import { createClient } from '@supabase/supabase-js'

// ── Config ───────────────────────────────────────────────────────────

const DRY_RUN = !!process.env.DRY_RUN

const PB_URL = process.env.PB_URL ?? 'https://kscw-api.lucanepa.com'
const PB_EMAIL = process.env.PB_EMAIL ?? 'admin@kscw.ch'
const PB_PASSWORD = process.env.PB_PASSWORD ?? 'thamykscw_1972'

const SUPABASE_URL = 'https://wilrrlwqgvzjdhmnwmte.supabase.co'
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndpbHJybHdxZ3Z6amRobW53bXRlIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1MzYwNTY3NywiZXhwIjoyMDY5MTgxNjc3fQ.YHuL5lucY4DKYv3mdDSJCGy88z2Q1UI_si4D2bkIgWA'

const SEASON = '2024/25'

// ── Clients ──────────────────────────────────────────────────────────

const pb = new PocketBase(PB_URL)
await pb.collection('_superusers').authWithPassword(PB_EMAIL, PB_PASSWORD)
console.log(`PocketBase: authenticated to ${PB_URL}`)

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
console.log('Supabase: connected')

if (DRY_RUN) console.log('\n*** DRY RUN — no writes ***\n')

// ── Helpers ──────────────────────────────────────────────────────────

const POSITION_MAP: Record<string, string> = {
  S: 'setter',
  OH: 'outside',
  MB: 'middle',
  DH: 'opposite',
  L: 'libero',
  C: 'coach',
  AC: 'coach',
}

function mapPosition(pos: string | null): string {
  if (!pos) return 'other'
  return POSITION_MAP[pos.toUpperCase()] ?? 'other'
}

function mapRole(fn: string | null): 'player' | 'coach' | 'captain' | 'assistant' {
  if (!fn) return 'player'
  const lower = fn.toLowerCase()
  if (lower === 'coach' || lower === 'trainer') return 'coach'
  if (lower.includes('assistant') || lower === 'ac') return 'assistant'
  if (lower === 'captain') return 'captain'
  return 'player'
}

function mapMemberRole(fn: string | null): 'player' | 'coach' {
  if (!fn) return 'player'
  const lower = fn.toLowerCase()
  if (lower === 'coach' || lower === 'trainer' || lower === 'ac' || lower.includes('assistant')) return 'coach'
  return 'player'
}

interface SupabaseRow {
  fname: string
  lname: string
  yob: number | null
  position: string | null
  jersey_number: number | null
  birthdate: string | null
  function: string | null
  picture_path: string | null
  phone_n: string | null
  email: string | null
}

interface PBMember {
  id: string
  email: string
  first_name: string
  last_name: string
  name: string
  phone: string
  number: number
  position: string
  photo: string
  role: string
  active: boolean
  birthdate: string
  yob: number
}

// ── Fetch Supabase data ──────────────────────────────────────────────

console.log('\n=== Fetching Supabase data ===')

const { data: h3Rows, error: h3Err } = await supabase.from('h3_kscw').select('*')
if (h3Err) throw new Error(`h3_kscw fetch error: ${h3Err.message}`)
console.log(`  h3_kscw: ${h3Rows!.length} rows`)

const { data: d2Rows, error: d2Err } = await supabase.from('d2_kscw').select('*')
if (d2Err) throw new Error(`d2_kscw fetch error: ${d2Err.message}`)
console.log(`  d2_kscw: ${d2Rows!.length} rows`)

// ── Fetch PocketBase members + teams ─────────────────────────────────

console.log('\n=== Fetching PocketBase data ===')

const pbMembers = await pb.collection('members').getFullList<PBMember>({ sort: 'last_name' })
console.log(`  PB members: ${pbMembers.length}`)

const pbTeams = await pb.collection('teams').getFullList({ sort: 'name' })
const h3Team = pbTeams.find((t) => t.name === 'H3')
const d2Team = pbTeams.find((t) => t.name === 'D2')

if (!h3Team) throw new Error('H3 team not found in PocketBase')
if (!d2Team) throw new Error('D2 team not found in PocketBase')
console.log(`  H3 team: ${h3Team.id} (${h3Team.full_name})`)
console.log(`  D2 team: ${d2Team.id} (${d2Team.full_name})`)

// Existing member_teams for dedup
const existingMTs = await pb.collection('member_teams').getFullList({
  filter: `season="${SEASON}"`,
})

// ── Match + migrate ──────────────────────────────────────────────────

function findMember(
  fname: string,
  lname: string,
  email: string | null,
): PBMember | undefined {
  if (email) {
    const byEmail = pbMembers.find(
      (m) => m.email?.toLowerCase() === email.toLowerCase(),
    )
    if (byEmail) return byEmail
  }
  // Match by name — return first match only
  return pbMembers.find(
    (m) =>
      m.first_name?.toLowerCase() === fname.toLowerCase() &&
      m.last_name?.toLowerCase() === lname.toLowerCase(),
  )
}

// Track emails we've already created (to handle duplicates like Luca Canepa appearing as both coach + player)
const createdEmails = new Set<string>()

function randomPassword(): string {
  return `Tmp_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
}

async function downloadPhoto(picturePathOrBucket: string, bucket: string): Promise<{ blob: Blob; filename: string } | null> {
  // Extract filename from the picture_path URL or use as-is
  let filePath: string
  try {
    const url = new URL(picturePathOrBucket)
    // Signed URL path: /storage/v1/object/sign/<bucket>/<filename>?token=...
    const pathParts = url.pathname.split('/')
    const bucketIdx = pathParts.indexOf(bucket)
    if (bucketIdx >= 0) {
      filePath = pathParts.slice(bucketIdx + 1).join('/')
    } else {
      filePath = pathParts[pathParts.length - 1]
    }
  } catch {
    filePath = picturePathOrBucket
  }

  // Generate fresh signed URL
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(filePath, 3600)

  if (error || !data?.signedUrl) {
    console.warn(`    Could not sign URL for ${bucket}/${filePath}: ${error?.message}`)
    return null
  }

  const resp = await fetch(data.signedUrl)
  if (!resp.ok) {
    console.warn(`    Download failed for ${bucket}/${filePath}: ${resp.status}`)
    return null
  }

  const blob = await resp.blob()
  const ext = filePath.split('.').pop() || 'jpg'
  const filename = filePath.replace(/\//g, '_').replace(/\s/g, '_') || `photo.${ext}`
  return { blob, filename }
}

async function migrateRows(rows: SupabaseRow[], teamId: string, teamName: string, bucket: string) {
  console.log(`\n=== Migrating ${teamName} (${rows.length} rows) ===`)

  let matched = 0
  let created = 0
  let skipped = 0

  for (const row of rows) {
    const fname = row.fname?.trim()
    const lname = row.lname?.trim()
    if (!fname || !lname) {
      console.log(`  SKIP: empty name`)
      skipped++
      continue
    }

    const existing = findMember(fname, lname, row.email)

    if (existing) {
      console.log(`  MATCH: ${fname} ${lname} → ${existing.id} (${existing.email})`)
      matched++

      // Build update payload (only set fields that have data from Supabase)
      const updates: Record<string, unknown> = {}
      if (row.birthdate && !existing.birthdate) updates.birthdate = row.birthdate
      if (row.yob && !existing.yob) updates.yob = row.yob
      if (row.jersey_number && !existing.number) updates.number = row.jersey_number
      if (row.position && existing.position === 'other') updates.position = mapPosition(row.position)
      if (row.phone_n && !existing.phone) updates.phone = row.phone_n

      if (!DRY_RUN && Object.keys(updates).length > 0) {
        await pb.collection('members').update(existing.id, updates)
        console.log(`    Updated: ${Object.keys(updates).join(', ')}`)
      } else if (Object.keys(updates).length > 0) {
        console.log(`    Would update: ${Object.keys(updates).join(', ')}`)
      }

      // Photo migration
      if (row.picture_path && !existing.photo) {
        const photo = await downloadPhoto(row.picture_path, bucket)
        if (photo && !DRY_RUN) {
          const formData = new FormData()
          formData.append('photo', new File([photo.blob], photo.filename, { type: photo.blob.type }))
          await pb.collection('members').update(existing.id, formData)
          console.log(`    Photo uploaded: ${photo.filename}`)
        } else if (photo) {
          console.log(`    Would upload photo: ${photo.filename} (${(photo.blob.size / 1024).toFixed(0)} KB)`)
        }
      }

      // Create member_team if not exists
      const hasMT = existingMTs.some(
        (mt) => mt.member === existing.id && mt.team === teamId,
      )
      if (!hasMT) {
        if (!DRY_RUN) {
          const mt = await pb.collection('member_teams').create({
            member: existing.id,
            team: teamId,
            season: SEASON,
            role: mapRole(row.function),
          })
          existingMTs.push(mt)
          console.log(`    Created member_team: ${mapRole(row.function)}`)
        } else {
          console.log(`    Would create member_team: ${mapRole(row.function)}`)
        }
      }
    } else {
      // Create new member
      console.log(`  NEW: ${fname} ${lname} (${row.email ?? 'no email'})`)
      created++

      if (!DRY_RUN) {
        const password = randomPassword()
        const newMember = await pb.collection('members').create({
          email: row.email || `${fname.toLowerCase()}.${lname.toLowerCase()}@placeholder.kscw.ch`,
          password,
          passwordConfirm: password,
          first_name: fname,
          last_name: lname,
          name: `${fname} ${lname}`,
          phone: row.phone_n || '',
          number: row.jersey_number || 0,
          position: mapPosition(row.position),
          role: [mapMemberRole(row.function)],
          active: true,
          birthdate: row.birthdate || '',
          yob: row.yob || 0,
        })
        console.log(`    Created member: ${newMember.id}`)
        pbMembers.push(newMember as unknown as PBMember)

        // Photo
        if (row.picture_path) {
          const photo = await downloadPhoto(row.picture_path, bucket)
          if (photo) {
            const formData = new FormData()
            formData.append('photo', new File([photo.blob], photo.filename, { type: photo.blob.type }))
            await pb.collection('members').update(newMember.id, formData)
            console.log(`    Photo uploaded: ${photo.filename}`)
          }
        }

        // member_team
        const mt = await pb.collection('member_teams').create({
          member: newMember.id,
          team: teamId,
          season: SEASON,
          role: mapRole(row.function),
        })
        existingMTs.push(mt)
        console.log(`    Created member_team: ${mapRole(row.function)}`)
      } else {
        console.log(`    Would create member + member_team`)
      }
    }
  }

  console.log(`\n  ${teamName} summary: ${matched} matched, ${created} created, ${skipped} skipped`)
}

// ── Run migrations ───────────────────────────────────────────────────

await migrateRows(h3Rows as SupabaseRow[], h3Team.id, 'H3', 'photosh3')

// D2 has fname/lname columns swapped — fix before migrating
const d2Fixed = (d2Rows as SupabaseRow[]).map((row) => ({
  ...row,
  fname: row.lname, // lname actually contains first name in d2
  lname: row.fname, // fname actually contains last name in d2
}))
await migrateRows(d2Fixed, d2Team.id, 'D2', 'photosh3')

console.log('\nMigration complete!')
