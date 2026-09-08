/**
 * Manual "push now" for the Volleymanager Einsatzliste.
 *
 * The T-60 cron (kscw-hooks) does this automatically for games whose
 * auto_nomination_list flag resolves to true. This endpoint is the escape hatch:
 * a coach whose push failed, or who wants the list filed early, can trigger the
 * same worker on demand — including for a game whose flag is off.
 *
 * POST /kscw/games/:id/nomination-push   → { spawned: true }
 *
 * Fire-and-forget, exactly like the cron: the worker writes its outcome onto the
 * game (vm_nomination_status/_error) and the UI polls that, so a slow or failing
 * VM never hangs the request.
 *
 * ⚠ This writes into the real Swiss Volley production system — there is no VM
 * staging. Hence the tight authz: only a coach/TR of the playing team, or a sport
 * admin, may file a list on that team's behalf.
 *
 * ⚠ …and hence the lease: this endpoint and the cron BOTH claim the same
 * `games` row with the same predicate before spawning anything, so only one
 * worker per fixture can be in flight. See the claim below.
 */
import { writeUserLog } from './activity-log.js'

export function registerNominationPush(router, { database, logger }) {
  const log = logger || console

  router.post('/games/:id/nomination-push', async (req, res) => {
    const gameId = Number(req.params.id)
    if (!Number.isInteger(gameId)) return res.status(400).json({ error: 'Invalid game id' })

    if (!process.env.VM_USERNAME || !process.env.VM_PASSWORD) {
      return res.status(503).json({ error: 'Volleymanager is not configured', code: 'vm_unconfigured' })
    }

    const game = await database('games').where('id', gameId)
      .first('id', 'game_id', 'kscw_team', 'status',
        // Read as-found so a failed spawn can hand the claim straight back.
        'vm_nomination_status', 'vm_nomination_error', 'vm_nomination_claimed_at')
    if (!game) return res.status(404).json({ error: 'Game not found' })
    if (!String(game.game_id ?? '').startsWith('vb_')) {
      return res.status(422).json({ error: 'Only volleyball games have an Einsatzliste', code: 'not_volleyball' })
    }
    if (game.kscw_team == null) {
      return res.status(422).json({ error: 'Game has no KSCW team', code: 'no_team' })
    }

    // Authz: a sport admin, or a coach / team responsible of the playing team.
    const admin = !!req.accountability?.admin
    let allowed = admin
    if (!allowed && req.accountability?.user) {
      const me = await database('members').where({ user: req.accountability.user }).first('id')
      if (me) {
        const [coach, tr] = await Promise.all([
          database('teams_coaches').where({ teams_id: game.kscw_team, members_id: me.id }).first('id'),
          database('teams_responsibles').where({ teams_id: game.kscw_team, members_id: me.id }).first('id'),
        ])
        allowed = !!coach || !!tr
      }
    }
    if (!allowed) return res.status(403).json({ error: 'Not a coach of this team', code: 'forbidden' })

    // ── Claim the game, then spawn ────────────────────────────────────────────
    // The T-60 cron (kscw-hooks/src/index.js) retries exactly the states this
    // button is offered for, so cron-vs-coach — and coach-vs-team-responsible on
    // two phones — really do land seconds apart on one fixture. Two detached
    // workers on one game create two Einsatzlisten in the REAL Swiss Volley
    // system, or one reopens the list the other has just closed, and both then
    // race to stamp the journal (last writer wins, so the coach can be shown
    // 'failed' for a list that is filed).
    //
    // One conditional UPDATE is the whole guard: Postgres takes the row lock, so
    // two callers serialize and the loser matches 0 rows and gets a 409. The cron
    // takes the SAME claim on the SAME row with the SAME predicate and lease —
    // keep the two in sync, a guard only one of the two actors honours is none.
    // Keyed on the single game id, so pushes for different fixtures never wait.
    //
    // ⚠⚠ The lease MUST be able to expire. A worker killed mid-run (every
    // `ext:deploy` restarts this container) never writes its terminal status, so
    // a claim without an expiry would strand the row at 'pending' for ever — the
    // cron skips it and the coach's button, which only renders for 'failed',
    // cannot reach it, so the list could never be filed at all. That is what
    // `vm_nomination_claimed_at` (migration 354) is for: after 10 minutes the
    // claim is reclaimable. A worker that finishes releases implicitly — finish()
    // writes a terminal status, and anything not 'pending' is claimable again at
    // once. This also folds in the old post-spawn "clear the previous failure so
    // the UI shows in progress" write, which a fast worker could otherwise beat.
    const claimed = await database('games').where('id', gameId)
      .whereRaw(
        "(COALESCE(vm_nomination_status, '') <> 'pending'"
        + ' OR vm_nomination_claimed_at IS NULL'
        + " OR vm_nomination_claimed_at < now() - interval '10 minutes')",
      )
      .update({
        vm_nomination_status: 'pending',
        vm_nomination_error: null,
        vm_nomination_claimed_at: database.fn.now(),
      })
    if (!claimed) {
      log.info?.({ msg: '[nomination-push] rejected: a push is already in flight', game: gameId })
      return res.status(409).json({
        error: 'A push for this game is already running — give it a minute',
        code: 'push_in_flight',
      })
    }

    // Set the instant the child is away; the catch below must not release the
    // claim once a worker is running against the real Swiss Volley system.
    let spawned = false
    try {
      const { spawn } = await import('node:child_process')
      const { openSync } = await import('node:fs')
      let logOut
    try { logOut = openSync('/directus/logs/vm-nomination.log', 'a') } catch { logOut = 'ignore' }
      const child = spawn('node', ['/directus/scripts/vm-push-nomination.mjs'], {
        detached: true,
        stdio: ['ignore', logOut, logOut],
        env: {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          VM_USERNAME: process.env.VM_USERNAME,
          VM_PASSWORD: process.env.VM_PASSWORD,
          KSCW_SVRZ_CLUB_ID: process.env.KSCW_SVRZ_CLUB_ID || '',
          DIRECTUS_URL: 'http://127.0.0.1:8055',
          DIRECTUS_SYNC_EMAIL: process.env.DIRECTUS_SYNC_EMAIL,
          DIRECTUS_SYNC_PASSWORD: process.env.DIRECTUS_SYNC_PASSWORD,
          GAME_ID: String(gameId),
          // Lets the worker refuse to write from the dev DB — VM has no staging.
          DB_DATABASE: process.env.DB_DATABASE || '',
          VM_NOMINATION_ALLOW_DEV_WRITE: process.env.VM_NOMINATION_ALLOW_DEV_WRITE || '',
        },
      })
      child.unref()
      // ⚠ Past this point a worker IS running against the real Swiss Volley system.
      // The catch below must not release the claim, or the row returns to 'failed' —
      // which both re-renders the coach's button and makes it cron-claimable within
      // 5 minutes, i.e. a SECOND Einsatzliste filed while the first worker is still
      // going. Today the only await after this is writeUserLog, which swallows its
      // own errors, so the catch is unreachable by accident; this flag makes it
      // unreachable by construction.
      spawned = true

      // Raw spawn → no Directus revision trail. Filing an official document on the
      // club's behalf is exactly the kind of state change the audit log exists for.
      await writeUserLog(database, log, {
        accountability: req.accountability,
        action: 'update',
        collection: 'games',
        recordId: gameId,
        data: { what: 'nomination_push', team: game.kscw_team, manual: true },
      })

      return res.json({ spawned: true })
    } catch (err) {
      log.error?.({ msg: `[nomination-push] spawn failed: ${err.message}`, game: gameId })
      // Release ONLY when no worker got away — see the flag above. If one did, the
      // lease is what ends the claim, not this handler.
      if (spawned) return res.status(500).json({ error: 'Could not start the push' })
      // Nothing is running, so give the claim back now rather than making the game
      // wait out the lease — 'pending' hides the Push now button. Restores the
      // journal exactly as this request found it, so a failed spawn changes nothing.
      try {
        await database('games').where('id', gameId).update({
          vm_nomination_status: game.vm_nomination_status ?? null,
          vm_nomination_error: game.vm_nomination_error ?? null,
          vm_nomination_claimed_at: game.vm_nomination_claimed_at ?? null,
        })
      } catch (releaseErr) {
        log.warn?.({ msg: `[nomination-push] claim release failed: ${releaseErr.message}`, game: gameId })
      }
      return res.status(500).json({ error: 'Could not start the push' })
    }
  })
}
