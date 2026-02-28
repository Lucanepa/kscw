/**
 * TypeScript interfaces documenting the Swiss Volley API response shape.
 *
 * API base: https://api.volleyball.ch
 * Docs:     https://swissvolley.docs.apiary.io/#reference/indoor
 *
 * These types are a development reference — the actual sync runs server-side
 * in pb_hooks/sv_sync.pb.js via the PocketBase JSVM.
 */

// ── GET /indoor/games ──────────────────────────────────────────────

export interface SvApiGame {
  gameId: number
  playDate: string // "YYYY-MM-DD HH:mm:ss"
  teams: {
    home: SvApiTeam
    away: SvApiTeam
  }
  league: SvApiLeague
  phase: SvApiPhase
  group: SvApiGroup
  hall: SvApiHall
  referees: Record<string, SvApiReferee>
  setResults: Record<string, SvApiSetResult>
  resultSummary: SvApiResultSummary
}

export interface SvApiTeam {
  teamId: number
  caption: string
  clubId: number
  clubCaption: string
}

export interface SvApiLeague {
  leagueId: number
  caption: string
  captionShort: string
  season: string
}

export interface SvApiPhase {
  phaseId: number
  caption: string
}

export interface SvApiGroup {
  groupId: number
  caption: string
}

export interface SvApiHall {
  hallId: number
  caption: string
  street: string
  number: string
  zip: string
  city: string
  latitude: number
  longitude: number
  plusCode: string
}

export interface SvApiReferee {
  firstName: string
  lastName: string
}

export interface SvApiSetResult {
  home: number
  away: number
}

export interface SvApiResultSummary {
  wonSetsHomeTeam: number
  wonSetsAwayTeam: number
  winner: string // team caption or empty string
}

// ── GET /indoor/ranking ────────────────────────────────────────────

export interface SvApiGroupRankings {
  leagueId: number
  leagueCaption: string
  phaseId: number
  phaseCaption: string
  groupId: number
  groupCaption: string
  ranking: SvApiTeamRanking[]
}

export interface SvApiTeamRanking {
  rank: number
  teamId: number
  teamCaption: string
  clubCaption: string
  games: number
  wins: number
  defeats: number
  setsWon: number
  setsLost: number
  ballsWon: number
  ballsLost: number
  points: number
}
