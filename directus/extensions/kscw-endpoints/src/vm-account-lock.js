/**
 * One holder for the SHARED Volleymanager account.
 *
 * wiedisync and svrz_rc share ONE Volleymanager login, and the active role is a
 * property of the ACCOUNT, not of the session — it persists. So two operations
 * overlapping on that account can act under the wrong role, which is why every
 * VM-touching job has to be serialised against every other one, not just against
 * other copies of itself.
 *
 * Before this there were three separate guards and they did not see each other:
 *   - `vmAccountHolder`      in kscw-hooks (the 04:30 SVRZ cron vs the VM watchdog)
 *   - `childSyncRunning`     in kscw-endpoints, keyed PER SOURCE, so the two admin
 *                            "Sync now" buttons ran concurrently with each other
 *   - `svrzManualSyncRunning` in game-scheduling, a third flag for the same script
 * so the likeliest collision of all — an admin pressing "Sync now" while a cron is
 * mid-run — was wide open.
 *
 * State lives on `globalThis` on purpose: kscw-hooks and kscw-endpoints are separate
 * extension bundles that cannot import from one another, but Directus loads both into
 * the SAME Node process, so a module-level variable in either is invisible to the
 * other. kscw-hooks keeps an inline copy of this contract — the KEY and the shape of
 * the record are the interface; keep them in step.
 *
 * ⚠ Process-local by construction: it serialises everything inside this container and
 * would not survive running two Directus instances. A cross-instance guard needs a
 * Postgres advisory lock held on a dedicated connection, which is a bigger change than
 * the race warrants today.
 *
 * The claim is LEASED. A crashed or restarted run must not hold the account for ever —
 * that is the failure mode the nomination-push guard was reverted for.
 */

/** Shared with the inline copy in kscw-hooks/src/index.js. Do not rename. */
export const VM_ACCOUNT_KEY = '__kscw_vm_account_holder'

/** Long enough for a full scrape, short enough that a lost run frees the account. */
export const VM_LEASE_MS = 20 * 60 * 1000

/**
 * Try to take the account. Returns a release function, or null when someone else
 * holds a live claim — callers should report that as "already running", never as
 * an error (a cron caller turns a non-2xx into a logged failure and a red card).
 */
export function claimVmAccount(who) {
  const held = globalThis[VM_ACCOUNT_KEY]
  if (held && Date.now() - held.at < VM_LEASE_MS) return null

  // A unique token, so a run that overran its lease cannot release the claim of
  // whoever legitimately took the account after it.
  const token = `${who}:${Date.now()}:${Math.round(Math.random() * 1e9)}`
  globalThis[VM_ACCOUNT_KEY] = { who, at: Date.now(), token }

  let released = false
  return () => {
    if (released) return
    released = true
    if (globalThis[VM_ACCOUNT_KEY]?.token === token) globalThis[VM_ACCOUNT_KEY] = null
  }
}

/** Who holds it right now, for log lines and 409 bodies. Null when free. */
export function vmAccountHeldBy() {
  const held = globalThis[VM_ACCOUNT_KEY]
  if (!held) return null
  return Date.now() - held.at < VM_LEASE_MS ? held.who : null
}
