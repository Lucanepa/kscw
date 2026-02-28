/// <reference path="../node_modules/pocketbase/dist/pocketbase.d.ts" />

// Swiss Volley API → PocketBase sync hook
// Schedule: daily at 06:00 via cronAdd
// Manual:   POST /api/sv-sync (superuser auth required)

// ── Cron: daily at 06:00 ────────────────────────────────────────────

cronAdd("sv-sync", "0 6 * * *", function() {
  var lib = require(__hooks + "/sv_sync_lib.js")
  console.log("[SV Sync] Starting daily sync...")
  try {
    lib.syncGames()
    lib.syncRankings()
    console.log("[SV Sync] Daily sync completed successfully")
  } catch (e) {
    console.log("[SV Sync] Daily sync failed: " + e)
  }
})

// ── Manual trigger: POST /api/sv-sync (superuser only) ──────────────

routerAdd("POST", "/api/sv-sync", function(e) {
  var lib = require(__hooks + "/sv_sync_lib.js")
  console.log("[SV Sync] Manual sync triggered")
  try {
    lib.syncGames()
    lib.syncRankings()
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
