import type { RecordModel } from 'pocketbase'

export interface Team extends RecordModel {
  name: string
  full_name: string
  sv_team_id: string
  sport: 'volleyball' | 'basketball'
  league: string
  season: string
  color: string
  coach: string[]
  captain: string[]
  team_responsible: string[]
  active: boolean
  team_picture: string
  social_url: string
  sponsors: string[]
  sponsors_logos: string[]
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
  role: ('user' | 'vorstand' | 'admin' | 'superuser')[]
  active: boolean
  birthdate: string
  yob: number
  scorer_licence: boolean
  approved: boolean
  requested_team: string
  language: 'english' | 'german' | ''
}

export interface MemberTeam extends RecordModel {
  member: string
  team: string
  season: string
}

export interface Hall extends RecordModel {
  name: string
  address: string
  city: string
  courts: number
  notes: string
  maps_url: string
  homologation: boolean
  sv_hall_id: string
}

export interface SlotClaim extends RecordModel {
  hall_slot: string
  hall: string
  date: string
  start_time: string
  end_time: string
  claimed_by_team: string
  claimed_by_member: string
  freed_reason: 'cancelled_training' | 'away_game'
  freed_source_id: string
  notes: string
  status: 'active' | 'revoked'
}

export interface VirtualSlotMeta {
  source: 'game' | 'training' | 'hall_event'
  sourceId: string
  sourceRecord: Game | Training | HallEvent
  isAway?: boolean
  isCancelled?: boolean
  isFreed?: boolean
  isClaimed?: boolean
  claimRecord?: SlotClaim
}

export interface HallSlot extends RecordModel {
  hall: string
  team: string
  day_of_week: number
  start_time: string
  end_time: string
  slot_type: 'training' | 'game' | 'event' | 'away' | 'other'
  recurring: boolean
  valid_from: string
  valid_until: string
  label: string
  notes: string
  _virtual?: VirtualSlotMeta
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
  away_hall_json: { name: string; address: string; city: string; plus_code?: string } | null
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
  scorer_member: string
  taefeler_member: string
  scorer_taefeler_member: string
  scorer_duty_team: string
  taefeler_duty_team: string
  scorer_taefeler_duty_team: string
  duty_confirmed: boolean
  referees_json: Array<{ name: string; id?: number }>
  source: 'swiss_volley' | 'manual'
}

export interface ScorerEditLog extends RecordModel {
  action: string
  game: string
  field_name: string
  old_value: string
  new_value: string
  changed_by: string
}

export interface SvRanking extends RecordModel {
  sv_team_id: string
  team: string
  team_name: string
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
  hall: string
  teams: string[]
  created_by: string
}

export interface HallEvent extends RecordModel {
  uid: string
  title: string
  date: string
  start_time: string
  end_time: string
  location: string
  hall: string[]
  all_day: boolean
  source: string
}

export interface Participation extends RecordModel {
  member: string
  activity_type: 'training' | 'game' | 'event'
  activity_id: string
  status: 'confirmed' | 'declined' | 'tentative'
  note: string
}
