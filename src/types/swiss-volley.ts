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
  playDateUtc: string // "YYYY-MM-DDTHH:mm:ssZ"
  gender: 'm' | 'w'
  status: number
  teams: {
    home: SvApiTeam
    away: SvApiTeam
  }
  league: SvApiLeague
  phase: SvApiPhase
  group: SvApiGroup
  hall: SvApiHall
  referees: Record<string, SvApiReferee>
  setResults: SvApiSetResult[] // array of per-set scores
  goldenSetResult: unknown[]
  resultSummary: SvApiResultSummary
  isPartOfBestOfSeries: boolean
  bestOfSeriesResult: unknown | null
}

export interface SvApiTeam {
  teamId: number
  seasonalTeamId: number
  caption: string
  clubId: string
  clubCaption: string
  logo: string
  rank: number | null
}

export interface SvApiLeague {
  leagueId: number
  season: number
  leagueCategoryId: number
  caption: string
  translations: {
    d: string
    shortD: string
    f: string
    shortF: string
  }
}

export interface SvApiPhase {
  phaseId: number
  caption: string
  translations: {
    d: string
    shortD: string
    f: string
    shortF: string
  }
}

export interface SvApiGroup {
  groupId: number
  caption: string
  translations: {
    d: string
    shortD: string
    f: string
    shortF: string
  }
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
  refereeId: number
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
  winner: string // "team_home" | "team_away" | ""
}

// ── GET /indoor/ranking ────────────────────────────────────────────

/** Ranking groups only contain IDs — captions must be resolved from games data */
export interface SvApiGroupRankings {
  leagueId: number
  phaseId: number
  groupId: number
  ranking: SvApiTeamRanking[]
}

export interface SvApiTeamRanking {
  rank: number
  teamId: number
  teamCaption: string
  isTalentOrganisationTeam: boolean
  isTalentDevelopmentTeam: boolean
  games: number
  points: number
  wins: number
  winsClear: number
  winsNarrow: number
  defeats: number
  defeatsClear: number
  defeatsNarrow: number
  setsWon: number
  setsLost: number
  ballsWon: number
  ballsLost: number
}
