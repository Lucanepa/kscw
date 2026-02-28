/// <reference path="../node_modules/pocketbase/dist/pocketbase.d.ts" />

// Swiss Volley API → PocketBase sync hook
// Fetches games and rankings from api.volleyball.ch and upserts into
// the `games` and `sv_rankings` PocketBase collections.
//
// Schedule: daily at 06:00 via cronAdd
// Manual:   POST /api/sv-sync (superuser auth required)

// ── Configuration ───────────────────────────────────────────────────

const SV_API_BASE = "https://api.volleyball.ch"

// KSCW Swiss Volley team IDs → internal short name
const SV_TEAM_IDS = {
  "12747": "H3",
  "2743":  "H1",
  "541":   "H2",
  "1395":  "D1",
  "1393":  "D2",
  "4689":  "D3",
  "1394":  "D4",
  "7563":  "HU23-1",
  "2301":  "DU23-1",
  "14040": "DU23-2",
  "6023":  "Legends",
}

function getApiKey() {
  return $os.getenv("SV_API_KEY")
}

// ── Helpers ─────────────────────────────────────────────────────────

function isKscwTeamId(id) {
  return SV_TEAM_IDS.hasOwnProperty(String(id))
}

/**
 * Derive season string from a date: "YYYY/YY"
 * Season runs Sep–Aug. If month < September, season started previous year.
 */
function deriveSeason(dateStr) {
  var d = new Date(dateStr)
  var year = d.getFullYear()
  var month = d.getMonth() // 0-indexed
  if (month < 8) {
    // Jan-Aug → season started last year
    return (year - 1) + "/" + String(year).slice(2)
  }
  return year + "/" + String(year + 1).slice(2)
}

/**
 * Parse "YYYY-MM-DD HH:mm:ss" into { date: "YYYY-MM-DD", time: "HH:mm" }
 */
function parsePlayDate(playDate) {
  var parts = playDate.split(" ")
  return {
    date: parts[0] || "",
    time: parts[1] ? parts[1].slice(0, 5) : "",
  }
}

/**
 * Convert set results from API format (object keyed by set number)
 * to array format expected by the frontend: [{home, away}, ...]
 */
function mapSetResults(setResults) {
  if (!setResults || typeof setResults !== "object") return []
  var keys = Object.keys(setResults).sort()
  var result = []
  for (var i = 0; i < keys.length; i++) {
    var s = setResults[keys[i]]
    result.push({
      home: (s && s.home) || (s && s.Home) || 0,
      away: (s && s.away) || (s && s.Away) || 0,
    })
  }
  return result
}

/**
 * Determine game status from API data.
 */
function determineStatus(game) {
  var rs = game.resultSummary || game.ResultSummary
  if (rs) {
    var winner = rs.winner || rs.Winner || ""
    if (winner !== "") return "completed"
  }
  // If play date is in the past but no result, still mark as scheduled
  // (could be postponed, but we can't determine that from the API)
  return "scheduled"
}

/**
 * Build a team lookup cache: sv_team_id → PocketBase record ID
 */
function buildTeamLookup() {
  var lookup = {}
  var teams = $app.findRecordsByFilter("teams", "sv_team_id != ''", "", 0, 0)
  for (var i = 0; i < teams.length; i++) {
    var t = teams[i]
    lookup[t.get("sv_team_id")] = t.id
  }
  return lookup
}

// ── Games Sync ──────────────────────────────────────────────────────

function syncGames() {
  var apiKey = getApiKey()
  if (!apiKey) {
    console.log("[SV Sync] No API key found (SV_API_KEY env var). Skipping games sync.")
    return
  }

  console.log("[SV Sync] Fetching games from Swiss Volley API...")

  var res = $http.send({
    url: SV_API_BASE + "/indoor/games",
    method: "GET",
    headers: { "Authorization": apiKey },
  })

  if (res.statusCode !== 200) {
    console.log("[SV Sync] Games API returned status " + res.statusCode)
    return
  }

  var allGames = res.json
  if (!Array.isArray(allGames)) {
    console.log("[SV Sync] Unexpected games response format")
    return
  }

  // Filter to KSCW games
  var kscwGames = []
  for (var i = 0; i < allGames.length; i++) {
    var g = allGames[i]
    var teams = g.teams || g.Teams || {}
    var home = teams.home || teams.Home || {}
    var away = teams.away || teams.Away || {}
    var homeId = String(home.teamId || home.TeamId || "")
    var awayId = String(away.teamId || away.TeamId || "")

    if (isKscwTeamId(homeId) || isKscwTeamId(awayId)) {
      kscwGames.push(g)
    }
  }

  console.log("[SV Sync] Found " + kscwGames.length + " KSCW games out of " + allGames.length + " total")

  // Build team lookup for resolving kscw_team relations
  var teamLookup = buildTeamLookup()
  var gamesCol = $app.findCollectionByNameOrId("games")

  var created = 0
  var updated = 0
  var errors = 0

  for (var i = 0; i < kscwGames.length; i++) {
    try {
      var g = kscwGames[i]
      var gameId = String(g.gameId || g.GameId || "")
      var teams = g.teams || g.Teams || {}
      var home = teams.home || teams.Home || {}
      var away = teams.away || teams.Away || {}
      var homeId = String(home.teamId || home.TeamId || "")
      var awayId = String(away.teamId || away.TeamId || "")

      var playDate = g.playDate || g.PlayDate || ""
      var parsed = parsePlayDate(playDate)

      var league = g.league || g.League || {}
      var phase = g.phase || g.Phase || {}
      var group = g.group || g.Group || {}

      var leagueCaption = league.caption || league.Caption || ""
      var groupCaption = group.caption || group.Caption || ""

      var setResults = g.setResults || g.SetResults || {}
      var resultSummary = g.resultSummary || g.ResultSummary || {}

      // Determine which side is KSCW
      var isHome = isKscwTeamId(homeId)
      var kscwSvId = isHome ? homeId : awayId
      var kscwTeamPbId = teamLookup[kscwSvId] || ""

      var homeScore = resultSummary.wonSetsHomeTeam || resultSummary.WonSetsHomeTeam || 0
      var awayScore = resultSummary.wonSetsAwayTeam || resultSummary.WonSetsAwayTeam || 0
      var setsJson = mapSetResults(setResults)
      var status = determineStatus(g)

      // Try to find existing record for upsert
      var record
      try {
        record = $app.findFirstRecordByData("games", "sv_game_id", gameId)
        updated++
      } catch (e) {
        // Not found — create new
        record = new Record(gamesCol)
        created++
      }

      record.set("sv_game_id", gameId)
      record.set("home_team", home.caption || home.Caption || "")
      record.set("away_team", away.caption || away.Caption || "")
      record.set("kscw_team", kscwTeamPbId)
      record.set("date", parsed.date)
      record.set("time", parsed.time)
      record.set("league", leagueCaption)
      record.set("round", groupCaption)
      record.set("season", deriveSeason(playDate))
      record.set("type", isHome ? "home" : "away")
      record.set("status", status)
      record.set("home_score", homeScore)
      record.set("away_score", awayScore)
      record.set("sets_json", setsJson)
      record.set("source", "swiss_volley")

      $app.save(record)
    } catch (e) {
      errors++
      console.log("[SV Sync] Error processing game " + (g.gameId || g.GameId) + ": " + e)
    }
  }

  console.log("[SV Sync] Games sync complete: " + created + " created, " + updated + " updated, " + errors + " errors")
}

// ── Rankings Sync ───────────────────────────────────────────────────

function syncRankings() {
  var apiKey = getApiKey()
  if (!apiKey) {
    console.log("[SV Sync] No API key found (SV_API_KEY env var). Skipping rankings sync.")
    return
  }

  console.log("[SV Sync] Fetching rankings from Swiss Volley API...")

  var res = $http.send({
    url: SV_API_BASE + "/indoor/ranking",
    method: "GET",
    headers: { "Authorization": apiKey },
  })

  if (res.statusCode !== 200) {
    console.log("[SV Sync] Rankings API returned status " + res.statusCode)
    return
  }

  var allGroups = res.json
  if (!Array.isArray(allGroups)) {
    console.log("[SV Sync] Unexpected rankings response format")
    return
  }

  // Filter to groups containing at least one KSCW team
  var relevantGroups = []
  for (var i = 0; i < allGroups.length; i++) {
    var grp = allGroups[i]
    var ranking = grp.ranking || grp.Ranking || []
    var hasKscw = false
    for (var j = 0; j < ranking.length; j++) {
      var r = ranking[j]
      if (isKscwTeamId(String(r.teamId || r.TeamId || ""))) {
        hasKscw = true
        break
      }
    }
    if (hasKscw) {
      relevantGroups.push(grp)
    }
  }

  console.log("[SV Sync] Found " + relevantGroups.length + " relevant ranking groups out of " + allGroups.length + " total")

  var rankingsCol = $app.findCollectionByNameOrId("sv_rankings")
  var now = new Date().toISOString()

  var created = 0
  var updated = 0
  var errors = 0

  for (var i = 0; i < relevantGroups.length; i++) {
    var grp = relevantGroups[i]
    var leagueCaption = grp.leagueCaption || grp.league_caption || grp.LeagueCaption || ""
    var phaseCaption = grp.phaseCaption || grp.phase_caption || grp.PhaseCaption || ""
    var groupCaption = grp.groupCaption || grp.group_caption || grp.GroupCaption || ""

    // Build a readable league string
    var leagueStr = leagueCaption
    if (phaseCaption && phaseCaption !== leagueCaption) {
      leagueStr += " - " + phaseCaption
    }
    if (groupCaption) {
      leagueStr += " " + groupCaption
    }

    var ranking = grp.ranking || grp.Ranking || []

    // Derive season from the league caption or use current
    var season = ""
    if (grp.leagueSeason || grp.league_season) {
      season = grp.leagueSeason || grp.league_season
    } else {
      // Fall back to current season
      var nowDate = new Date()
      var yr = nowDate.getFullYear()
      var mo = nowDate.getMonth()
      if (mo < 8) {
        season = (yr - 1) + "/" + String(yr).slice(2)
      } else {
        season = yr + "/" + String(yr + 1).slice(2)
      }
    }

    for (var j = 0; j < ranking.length; j++) {
      try {
        var r = ranking[j]
        var teamId = String(r.teamId || r.TeamId || "")
        var teamCaption = r.teamCaption || r.TeamCaption || r.caption || ""

        // Upsert by sv_team_id + league composite
        var record
        try {
          record = $app.findFirstRecordByFilter(
            "sv_rankings",
            "sv_team_id = {:tid} && league = {:league}",
            { "tid": teamId, "league": leagueStr }
          )
          updated++
        } catch (e) {
          // Not found — create new
          record = new Record(rankingsCol)
          created++
        }

        record.set("sv_team_id", teamId)
        record.set("team_name", teamCaption)
        record.set("league", leagueStr)
        record.set("rank", r.rank || r.Rank || 0)
        record.set("played", r.games || r.Games || 0)
        record.set("won", r.wins || r.Wins || 0)
        record.set("lost", r.defeats || r.Defeats || 0)
        record.set("sets_won", r.setsWon || r.SetsWon || 0)
        record.set("sets_lost", r.setsLost || r.SetsLost || 0)
        record.set("points_won", r.ballsWon || r.BallsWon || 0)
        record.set("points_lost", r.ballsLost || r.BallsLost || 0)
        record.set("points", r.points || r.Points || 0)
        record.set("season", season)
        record.set("updated_at", now)

        $app.save(record)
      } catch (e) {
        errors++
        console.log("[SV Sync] Error processing ranking entry: " + e)
      }
    }
  }

  console.log("[SV Sync] Rankings sync complete: " + created + " created, " + updated + " updated, " + errors + " errors")
}

// ── Cron: daily at 06:00 ────────────────────────────────────────────

cronAdd("sv-sync", "0 6 * * *", function() {
  console.log("[SV Sync] Starting daily sync...")
  try {
    syncGames()
    syncRankings()
    console.log("[SV Sync] Daily sync completed successfully")
  } catch (e) {
    console.log("[SV Sync] Daily sync failed: " + e)
  }
})

// ── Manual trigger: POST /api/sv-sync (superuser only) ──────────────

routerAdd("POST", "/api/sv-sync", function(e) {
  console.log("[SV Sync] Manual sync triggered")
  try {
    syncGames()
    syncRankings()
    return e.json(200, {
      success: true,
      synced_at: new Date().toISOString(),
    })
  } catch (err) {
    return e.json(500, {
      success: false,
      error: String(err),
    })
  }
}, $apis.requireSuperuserAuth())
