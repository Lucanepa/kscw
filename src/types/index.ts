import type { RecordModel } from 'pocketbase'

export interface Team extends RecordModel {
  name: string
  full_name: string
  sv_team_id: string
  sport: 'volleyball' | 'basketball'
  league: string
  season: string
  color: string
  coach: string
  active: boolean
}

export interface Member extends RecordModel {
  email: string
  name: string
  first_name: string
  last_name: string
  phone: string
  license_nr: string
  number: number
  position: 'setter' | 'outside' | 'middle' | 'opposite' | 'libero' | 'coach' | 'other'
  photo: string
  role: 'player' | 'coach' | 'vorstand' | 'admin'
  active: boolean
}

export interface MemberTeam extends RecordModel {
  member: string
  team: string
  season: string
  role: 'player' | 'coach' | 'captain' | 'assistant'
}

export interface Hall extends RecordModel {
  name: string
  address: string
  city: string
  courts: number
  notes: string
  maps_url: string
  homologation: boolean
}

export interface HallSlot extends RecordModel {
  hall: string
  team: string
  day_of_week: number
  start_time: string
  end_time: string
  slot_type: 'training' | 'game' | 'event' | 'other'
  recurring: boolean
  valid_from: string
  valid_until: string
  label: string
  notes: string
}

export interface HallClosure extends RecordModel {
  hall: string
  start_date: string
  end_date: string
  reason: string
  source: 'hauswart' | 'admin' | 'auto'
}

export interface Game extends RecordModel {
  sv_game_id: string
  home_team: string
  away_team: string
  kscw_team: string
  hall: string
  date: string
  time: string
  league: string
  round: string
  season: string
  type: 'home' | 'away'
  status: 'scheduled' | 'live' | 'completed' | 'postponed'
  home_score: number
  away_score: number
  sets_json: unknown
  scorer_team: string
  scorer_person: string
  taefeler_team: string
  taefeler_person: string
  duty_confirmed: boolean
  source: 'swiss_volley' | 'manual'
}

export interface SvRanking extends RecordModel {
  sv_team_id: string
  league: string
  rank: number
  played: number
  won: number
  lost: number
  sets_won: number
  sets_lost: number
  points_won: number
  points_lost: number
  points: number
  season: string
  updated_at: string
}

export interface Training extends RecordModel {
  team: string
  hall_slot: string
  date: string
  start_time: string
  end_time: string
  hall: string
  coach: string
  notes: string
  cancelled: boolean
  cancel_reason: string
}

export interface TrainingAttendance extends RecordModel {
  training: string
  member: string
  status: 'present' | 'absent' | 'late' | 'excused'
  absence: string
  noted_by: string
}

export interface Absence extends RecordModel {
  member: string
  start_date: string
  end_date: string
  reason: 'injury' | 'vacation' | 'work' | 'personal' | 'other'
  reason_detail: string
  affects: string[]
  approved: boolean
}

export interface Event extends RecordModel {
  title: string
  description: string
  event_type: 'verein' | 'social' | 'meeting' | 'tournament' | 'other'
  start_date: string
  end_date: string
  all_day: boolean
  location: string
  teams: string[]
  created_by: string
}
