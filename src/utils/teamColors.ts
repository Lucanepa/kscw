export const teamColors: Record<string, { bg: string; text: string; border: string }> = {
  H1: { bg: '#1d4ed8', text: '#ffffff', border: '#1e40af' },
  H2: { bg: '#2563eb', text: '#ffffff', border: '#1d4ed8' },
  H3: { bg: '#3b82f6', text: '#ffffff', border: '#2563eb' },
  D1: { bg: '#db2777', text: '#ffffff', border: '#be185d' },
  D2: { bg: '#ec4899', text: '#ffffff', border: '#db2777' },
  D3: { bg: '#f472b6', text: '#ffffff', border: '#ec4899' },
  D4: { bg: '#f9a8d4', text: '#1f2937', border: '#f472b6' },
  'HU23': { bg: '#059669', text: '#ffffff', border: '#047857' },
  'DU23': { bg: '#10b981', text: '#ffffff', border: '#059669' },
  Legends: { bg: '#d97706', text: '#ffffff', border: '#b45309' },
}

export const svTeamIds: Record<string, string> = {
  '12747': 'H3',
  '1394': 'D4',
  '14040': 'DU23-2',
  '7563': 'HU23-1',
  '1393': 'D2',
  '541': 'H2',
  '6023': 'Legends',
  '4689': 'D3',
  '2743': 'H1',
  '1395': 'D1',
  '2301': 'DU23-1',
}

export function getTeamColor(teamName: string) {
  const key = teamName.replace(/-\d+$/, '')
  return teamColors[key] ?? { bg: '#6b7280', text: '#ffffff', border: '#4b5563' }
}
