import PocketBase from 'pocketbase'

const pb = new PocketBase('https://kscw-api.lucanepa.com')
await pb.collection('_superusers').authWithPassword('admin@kscw.ch', '@Bocconi13')

// Add 'superadmin' to role select values
const col = await pb.collections.getOne('members')
const fields = col.fields.map((f: any) => {
  if (f.name === 'role') {
    const values = f.values ?? ['player', 'coach', 'vorstand', 'admin']
    if (!values.includes('superadmin')) {
      return { ...f, values: [...values, 'superadmin'] }
    }
  }
  return f
})
await pb.collections.update(col.id, { fields })
console.log('Added superadmin to role select values')

// Assign superadmin to Luca Canepa
const members = await pb.collection('members').getFullList({
  filter: 'email="luca.canepa@gmail.com"',
})
for (const m of members) {
  const currentRole = Array.isArray(m.role) ? m.role : [m.role]
  if (!currentRole.includes('superadmin')) {
    await pb.collection('members').update(m.id, { role: [...currentRole, 'superadmin'] })
    console.log(`Updated ${m.first_name} ${m.last_name}: role = ${[...currentRole, 'superadmin'].join(', ')}`)
  }
}
