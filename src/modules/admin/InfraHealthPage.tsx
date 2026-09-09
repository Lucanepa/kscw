import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useInfraHealth } from '../../hooks/useInfraHealth'
import { API_URL, fetchItems, countItems } from '../../lib/api'
import { currentLocale } from '../../utils/dateHelpers'
import { useReportPageLoading } from '../../hooks/usePageReady'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'

const PROD_URL = API_URL
const DEV_URL = 'https://directus-dev.kscw.ch'
const PUSH_WORKER_URL = 'https://kscw-push.lucanepa.workers.dev'

type Status = 'healthy' | 'down' | 'stale' | 'checking' | 'unknown'

interface HealthCheck {
  name: string
  status: Status
  detail: string
  responseTime?: number | null
  value?: string | number | null
  /** When set, the card renders a "Run now" button that triggers this scraper. */
  onRefresh?: () => void
  refreshing?: boolean
}

// Manually-triggerable data sources → their /kscw/admin/<endpoint> route.
// SV / BP / GCal run in-process (fast); VM / SVRZ spawn a child and return 202.
const DAY = 24 * 3600000

/**
 * ⚠ `staleHours` is per source because these jobs do NOT share a cadence, and one
 * threshold for all of them turns a healthy job amber for most of its cycle.
 * Volleymanager syncs WEEKLY (`0 4 * * 1` in kscw-hooks — deliberately, the
 * account is shared with svrz_rc and a backoff exists so an outage cannot hammer
 * volleyball.ch all week), so against the old flat 48h it read "Stale" from every
 * Wednesday morning until the following Monday. Pressing "Run now" turned it green
 * and it drifted back two days later, every week (09.09.2026).
 */
const SYNC_SOURCES: { key: string; labelKey: string; endpoint: string; staleMs: number }[] = [
  { key: 'sv_sync', labelKey: 'infraSvSync', endpoint: 'sv-sync', staleMs: 2 * DAY },      // daily 06:00
  { key: 'bp_sync', labelKey: 'infraBpSync', endpoint: 'bp-sync', staleMs: 2 * DAY },      // daily 06:05
  { key: 'vm_sync', labelKey: 'infraVmSync', endpoint: 'vm-sync', staleMs: 8 * DAY },      // WEEKLY, Mondays 04:00
  { key: 'svrz_sync', labelKey: 'infraSvrzSync', endpoint: 'svrz-sync', staleMs: 2 * DAY },// daily 04:30
  { key: 'gcal_sync', labelKey: 'infraGcalSync', endpoint: 'gcal-sync', staleMs: 2 * DAY },// daily 04:00
]

function statusColor(s: Status) {
  switch (s) {
    case 'healthy': return { dot: 'bg-green-500', badge: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400', glow: 'shadow-green-500/40' }
    case 'down': return { dot: 'bg-red-500', badge: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400', glow: 'shadow-red-500/40' }
    case 'stale': return { dot: 'bg-amber-500', badge: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400', glow: 'shadow-amber-500/40' }
    case 'checking': return { dot: 'bg-gray-400 animate-pulse', badge: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400', glow: '' }
    default: return { dot: 'bg-gray-400', badge: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400', glow: '' }
  }
}

function timeAgo(dateStr: string, t: (k: string) => string): string {
  if (!dateStr) return t('infraNever')
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return `< 1 ${t('infraMin')} ${t('infraAgo')}`
  if (mins < 60) return `${mins} ${t('infraMin')} ${t('infraAgo')}`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ${t('infraAgo')}`
  const days = Math.floor(hrs / 24)
  return `${days}d ${t('infraAgo')}`
}

async function checkEndpoint(url: string, noCorsOk = false): Promise<{ ok: boolean; ms: number; status: number; cors: boolean }> {
  const start = Date.now()
  try {
    const res = await fetch(url, { method: 'GET', mode: 'cors' })
    return { ok: res.ok, ms: Date.now() - start, status: res.status, cors: false }
  } catch {
    if (noCorsOk) {
      // Retry with no-cors — opaque response means server is reachable
      try {
        const res = await fetch(url, { method: 'GET', mode: 'no-cors' })
        return { ok: res.type === 'opaque', ms: Date.now() - start, status: 0, cors: false }
      } catch {
        return { ok: false, ms: Date.now() - start, status: 0, cors: true }
      }
    }
    return { ok: false, ms: Date.now() - start, status: 0, cors: true }
  }
}

function Card({ check }: { check: HealthCheck }) {
  const { t } = useTranslation('admin')
  const c = statusColor(check.status)
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800/50">
      <div className="mb-2 flex items-center gap-2.5">
        <span className={`h-2.5 w-2.5 rounded-full ${c.dot} ${c.glow ? `shadow-[0_0_6px]` : ''} ${c.glow}`} />
        <span className="text-sm font-semibold text-gray-900 dark:text-white">{check.name}</span>
      </div>
      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${c.badge}`}>
        {t(`infra_${check.status}`)}
      </span>
      {check.detail && (
        <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">{check.detail}</p>
      )}
      {check.value != null && (
        <p className="mt-1 text-lg font-bold text-gray-900 dark:text-white">{check.value}</p>
      )}
      {check.responseTime != null && (
        <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">
          {t('infraResponseTime')}: {check.responseTime}ms
        </p>
      )}
      {check.onRefresh && (
        <button
          onClick={check.onRefresh}
          disabled={check.refreshing}
          className="mt-2.5 inline-flex items-center gap-1.5 rounded-md bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
        >
          {check.refreshing ? (
            <>
              <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              {t('infraChecking')}
            </>
          ) : t('infraRunNow')}
        </button>
      )}
    </div>
  )
}

function Section({ title, checks }: { title: string; checks: HealthCheck[] }) {
  if (!checks.length) return null
  return (
    <div className="mb-6">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {title}
      </h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {checks.map((c) => <Card key={c.name} check={c} />)}
      </div>
    </div>
  )
}

export default function InfraHealthPage() {
  const { t } = useTranslation('admin')
  const infraHealth = useInfraHealth()
  // Latest-value ref for the async trigger/poll callbacks below (they only read
  // it after an await, i.e. long after this effect has flushed).
  const infraRef = useRef(infraHealth)
  useEffect(() => { infraRef.current = infraHealth })

  const [services, setServices] = useState<HealthCheck[]>([])
  const [crons, setCrons] = useState<HealthCheck[]>([])
  const [stats, setStats] = useState<HealthCheck[]>([])
  const [vps, setVps] = useState<HealthCheck[]>([])
  const [slowQueries, setSlowQueries] = useState<{ avg_ms: number; max_ms: number; calls: number; total_ms: number; rows: number; query: string }[]>([])
  const [lastCheck, setLastCheck] = useState<string>('')
  // Starts true: runChecks() runs on mount (see the effect below) and used to
  // flip this itself one render later — which briefly reported the page as ready
  // to the boot gate.
  const [loading, setLoading] = useState(true)
  const [triggering, setTriggering] = useState<Record<string, boolean>>({})

  // Trigger a scraper, then poll sync_runs until its heartbeat advances past
  // the click (capped). VM / SVRZ are long-running (return 202 immediately);
  // the poll cap just stops the spinner — the heartbeat reflects completion
  // on the next manual refresh regardless.
  const triggerSync = useCallback(async (source: string, endpoint: string) => {
    setTriggering(prev => ({ ...prev, [source]: true }))
    const clickedAt = Date.now()
    let async202 = false
    try {
      const res = await fetch(`${PROD_URL}/kscw/admin/${endpoint}`, { method: 'POST', credentials: 'include' })
      async202 = res.status === 202 // VM / SVRZ run as background children
    } catch { /* poll / refresh reflects the outcome */ }

    // Synchronous syncs (SV / BP / GCal) have already finished when the POST
    // resolves — refresh and stop the spinner immediately, no polling.
    if (!async202) {
      setTriggering(prev => ({ ...prev, [source]: false }))
      infraRef.current.refresh()
      return
    }

    let polls = 0
    const MAX_POLLS = 12 // ~100s
    const poll = async () => {
      polls++
      let advanced = false
      try {
        const r = await fetch(`${PROD_URL}/kscw/admin/sync-status`, { credentials: 'include' })
        if (r.ok) {
          const { runs } = await r.json()
          const run = (runs || []).find((x: { source: string }) => x.source === source) as { last_run_at?: string } | undefined
          advanced = !!run?.last_run_at && new Date(run.last_run_at).getTime() > clickedAt - 5000
        }
      } catch { /* keep polling */ }
      if (advanced || polls >= MAX_POLLS) {
        setTriggering(prev => ({ ...prev, [source]: false }))
        infraRef.current.refresh()
      } else {
        setTimeout(poll, 8000)
      }
    }
    setTimeout(poll, 8000)
  }, [])

  // Map sync_runs heartbeats → one triggerable card per scraper. Pure derivation
  // from the hook's runs + the trigger flags, so it's computed during render
  // instead of copied into state by an effect.
  const syncs = useMemo<HealthCheck[]>(() => {
    const byKey = new Map(infraHealth.runs.map(r => [r.source, r]))
    return SYNC_SOURCES.map(src => {
      const run = byKey.get(src.key)
      const ranAt = run?.last_run_at && new Date(run.last_run_at).getTime() > new Date('2000-01-01').getTime()
        ? run.last_run_at : null
      let status: Status = 'unknown'
      let detail = t('infraNoData')
      if (ranAt) {
        const ageMs = (run!.age_seconds ?? 0) * 1000
        status = run!.status === 'error' ? 'down' : ageMs > src.staleMs ? 'stale' : 'healthy'
        detail = run!.status === 'error'
          ? (run!.error_message?.slice(0, 60) || timeAgo(ranAt, t))
          : timeAgo(ranAt, t)
      }
      return {
        name: t(src.labelKey),
        status,
        detail,
        onRefresh: () => triggerSync(src.key, src.endpoint),
        refreshing: !!triggering[src.key],
      }
    })
  }, [infraHealth.runs, triggering, t, triggerSync])

  // The check pass itself, without the `loading = true` flip — `loading` already
  // starts true, so the on-mount run below needs no flip; only the manual
  // Refresh button (runChecks) does.
  const runChecksInto = useCallback(async () => {

    // ── Services ── The probes are independent, so fire them concurrently
    // instead of an 8-request serial chain that stalls the boot gate. Cards
    // are then assembled in the original display order.
    const [prodHealth, devHealth, push, hooks, db, errorLog, cfWiedisync] = await Promise.all([
      // API Prod (no-cors fallback — same treatment as Dev; avoids racing the
      // shared hook's useEffect, which populated undefined on first render and
      // made the Prod card flash "Down" even when reachable). /server/ping, not
      // /server/health — Directus 12.1 made /server/health auth-only.
      checkEndpoint(`${PROD_URL}/server/ping`, true),
      // API Dev (no-cors fallback — dev server may not whitelist this origin)
      checkEndpoint(`${DEV_URL}/server/ping`, true),
      // Push Worker (no CORS headers — no-cors fallback, opaque = reachable)
      checkEndpoint(`${PUSH_WORKER_URL}/health`, true),
      // Directus extensions deployed (check a known KSCW endpoint)
      checkEndpoint(`${PROD_URL}/kscw/web-push/vapid-public-key`),
      // Postgres DB (via Directus — if an items query works, DB is alive)
      (async (): Promise<{ ok: boolean; ms: number }> => {
        const start = Date.now()
        try {
          await fetchItems('teams', { limit: 1, fields: ['id'] })
          return { ok: true, ms: Date.now() - start }
        } catch {
          return { ok: false, ms: 0 }
        }
      })(),
      // Error Log — today's error count. 'skip' (non-ok response) yields no
      // card, matching the original `if (res.ok)` guard.
      (async (): Promise<{ kind: 'ok'; total: number } | { kind: 'skip' } | { kind: 'error' }> => {
        try {
          const res = await fetch(`${PROD_URL}/kscw/admin/error-logs?limit=1`, { credentials: 'include' })
          if (!res.ok) return { kind: 'skip' }
          const data = await res.json()
          return { kind: 'ok', total: data.total ?? 0 }
        } catch {
          return { kind: 'error' }
        }
      })(),
      // CF Pages — wiedisync (check if frontend is reachable)
      checkEndpoint('https://wiedisync.kscw.ch/', true),
      // (No kscw-website card: its prod alias 302-redirects cross-origin to
      // kscw.ch/ClubDesk, so the browser can never read the response — the card
      // could only ever show grey "Unknown", pure noise. Dropped 2026-07-07.)
    ])

    const apiProdOk = prodHealth.ok
    const svcResults: HealthCheck[] = [
      {
        name: t('infraPbProd'),
        status: apiProdOk ? 'healthy' : prodHealth.cors ? 'unknown' : 'down',
        detail: apiProdOk
          ? PROD_URL.replace('https://', '')
          : prodHealth.cors ? t('infraCors') : t('infraUnreachable'),
        responseTime: apiProdOk ? prodHealth.ms : null,
      },
      {
        name: t('infraPbDev'),
        status: devHealth.ok ? 'healthy' : devHealth.cors ? 'unknown' : 'down',
        detail: devHealth.ok ? DEV_URL.replace('https://', '') : devHealth.cors ? t('infraCors') : `HTTP ${devHealth.status}`,
        responseTime: devHealth.ok ? devHealth.ms : null,
      },
      // Cloudflare Tunnel (implied by API Prod reachability)
      {
        name: t('infraCfTunnel'),
        status: apiProdOk ? 'healthy' : 'down',
        detail: apiProdOk ? 'kscw-vps tunnel active' : 'Tunnel unreachable',
      },
      {
        name: t('infraPushWorker'),
        status: push.ok ? 'healthy' : 'down',
        detail: push.ok ? PUSH_WORKER_URL.replace('https://', '') : t('infraUnreachable'),
        responseTime: push.ok ? push.ms : null,
      },
      {
        name: t('infraHooksDeployed'),
        status: hooks.ok ? 'healthy' : 'down',
        detail: hooks.ok ? 'KSCW extensions active' : 'Extensions not responding',
        responseTime: hooks.ms,
      },
      db.ok
        ? { name: t('infraPostgres'), status: 'healthy', detail: 'coolify-db', responseTime: db.ms }
        : { name: t('infraPostgres'), status: 'down', detail: 'Query failed' },
      ...(errorLog.kind === 'ok'
        ? [{
            name: t('infraErrorLog'),
            status: (errorLog.total === 0 ? 'healthy' : errorLog.total <= 10 ? 'healthy' : errorLog.total <= 50 ? 'stale' : 'down') as Status,
            detail: errorLog.total === 0 ? t('infraNoErrors') : `${errorLog.total} ${t('infraErrorsToday')}`,
            value: errorLog.total,
          }]
        : errorLog.kind === 'error'
          ? [{ name: t('infraErrorLog'), status: 'unknown' as Status, detail: '' }]
          : []),
      {
        name: 'CF Pages (WiediSync)',
        status: cfWiedisync.ok ? 'healthy' : 'down',
        detail: cfWiedisync.ok ? 'wiedisync.kscw.ch' : t('infraUnreachable'),
        responseTime: cfWiedisync.ok ? cfWiedisync.ms : null,
      },
    ]

    setServices(svcResults)

    // Trigger shared hook refresh (updates syncs via useEffect above)
    infraRef.current.refresh()

    // ── Cron Jobs ── Independent heartbeat probes — run concurrently, then
    // assemble the cards in their original order.
    const CRON_STALE = 48 * 3600000 // 48h

    // Notification-heartbeat card for a given notification type (or all).
    // ⚠ `staleMs` per card, for the same reason SYNC_SOURCES carries one: these
    // are heartbeats over notifications that are EVENT-DRIVEN, not periodic. A
    // deadline reminder only exists when an RSVP deadline is actually approaching,
    // so a quiet Monday and Tuesday leaves the newest row two days old with the
    // cron running perfectly (09.09.2026: 27 sent in the preceding week, newest on
    // the Sunday, card amber). Judge each on how often its kind of thing happens.
    const notifCard = async (labelKey: string, type?: string, emptyOk = false,
      staleMs: number = CRON_STALE): Promise<HealthCheck> => {
      try {
        const rows = await fetchItems<{ date_created: string }>('notifications', {
          limit: 1,
          sort: ['-date_created'],
          ...(type ? { filter: { type: { _eq: type } } } : {}),
          fields: ['date_created'],
        })
        if (rows.length) {
          const last = rows[0].date_created
          const diff = Date.now() - new Date(last).getTime()
          return { name: t(labelKey), status: diff > staleMs ? 'stale' : 'healthy', detail: timeAgo(last, t) }
        }
        // No matching notifications. For reminder crons this is a normal idle
        // state (nothing currently due — e.g. off-season), not a fault: show it
        // green as "Nothing due" instead of a misleading grey "No data".
        return emptyOk
          ? { name: t(labelKey), status: 'healthy', detail: t('infraNothingDue') }
          : { name: t(labelKey), status: 'unknown', detail: t('infraNoData') }
      } catch {
        return { name: t(labelKey), status: 'unknown', detail: '' }
      }
    }

    const cronResults = await Promise.all<HealthCheck>([
      // Notifications (created by Postgres triggers on game/training/event CRUD)
      notifCard('infraNotifCron'),
      // Participation Reminders (deadline_reminder notifications from 07:00 UTC cron).
      // 7 days: the cron runs daily but only emits when a deadline is approaching — a week
      // with no deadlines due is a quiet week, not a broken cron.
      notifCard('infraParticipationCron', 'deadline_reminder', true, 7 * DAY),
      // Upcoming Activity Reminders (06:30 UTC cron)
      notifCard('infraUpcomingCron', 'upcoming_activity', true),
      // Shell Expiry (02:00 UTC — check if any expired shells remain active)
      (async (): Promise<HealthCheck> => {
        try {
          const expired = await countItems('members', {
            shell: { _eq: true },
            kscw_membership_active: { _eq: true },
            shell_expires: { _lt: new Date().toISOString() },
          })
          return {
            name: t('infraShellExpiry'),
            status: expired === 0 ? 'healthy' : 'stale',
            detail: expired === 0 ? t('infraAllCleaned') : `${expired} ${t('infraExpiredRemain')}`,
          }
        } catch {
          return { name: t('infraShellExpiry'), status: 'unknown', detail: '' }
        }
      })(),
      // Push Delivery (check last push subscription activity)
      (async (): Promise<HealthCheck> => {
        try {
          const subs = await countItems('push_subscriptions')
          return { name: t('infraPushDelivery'), status: subs > 0 ? 'healthy' : 'stale', detail: `${subs} ${t('infraActiveSubs')}`, value: subs }
        } catch {
          return { name: t('infraPushDelivery'), status: 'unknown', detail: '' }
        }
      })(),
    ])

    setCrons(cronResults)

    // ── Stats ──
    const statResults: HealthCheck[] = []

    try {
      const [members, teams, games] = await Promise.all([
        countItems('members', { kscw_membership_active: { _eq: true } }),
        countItems('teams', { active: { _eq: true } }),
        countItems('games'),
      ])
      statResults.push(
        { name: t('infraActiveMembers'), status: 'healthy', detail: '', value: members },
        { name: t('infraActiveTeams'), status: 'healthy', detail: '', value: teams },
        { name: t('infraTotalGames'), status: 'healthy', detail: '', value: games },
      )
    } catch { /* skip stats on error */ }

    // Migration tracker — applied vs pending. Pending > 0 means dev/prod
    // are out of sync; the deploy hasn't been run yet.
    try {
      const r = await fetch(`${PROD_URL}/kscw/admin/migrations-status`, {
        credentials: 'include',
      })
      if (r.ok) {
        const m = await r.json()
        const pendingCount = Array.isArray(m.pending) ? m.pending.length : 0
        statResults.push({
          name: t('infraMigrationsApplied'),
          status: pendingCount === 0 ? 'healthy' : 'stale',
          detail: pendingCount === 0
            ? `Latest: ${m.latest ?? '—'}`
            : `${pendingCount} pending: ${(m.pending ?? []).slice(0, 3).join(', ')}${pendingCount > 3 ? '…' : ''}`,
          value: m.applied,
        })
      }
    } catch { /* skip migration check on error */ }

    setStats(statResults)

    // ── VPS Metrics ──
    const vpsResults: HealthCheck[] = []
    try {
      const vpsRes = await fetch(`${PROD_URL}/kscw/admin/vps-metrics`, {
        credentials: 'include',
      })
      if (vpsRes.ok) {
        const v = await vpsRes.json()
        // loadavg is "1min / 5min / 15min". Judge health on the 5-minute
        // average, not the 1-minute: a single cron tick momentarily pushes a
        // 4-core box past 80% and flagged the card amber for transient load.
        const loadParts = String(v.loadavg).split('/').map((s: string) => parseFloat(s.trim()))
        const load5 = Number.isFinite(loadParts[1]) ? loadParts[1] : parseFloat(v.loadavg)
        vpsResults.push(
          { name: t('infraUptime'), status: 'healthy', detail: v.uptime, value: null },
          { name: t('infraCpuLoad'), status: load5 > v.cpu_count * 0.8 ? 'stale' : 'healthy', detail: `${v.loadavg} (${v.cpu_count} cores)`, value: null },
          { name: t('infraMemory'), status: v.memory.percent > 90 ? 'down' : v.memory.percent > 75 ? 'stale' : 'healthy', detail: `${v.memory.used} / ${v.memory.total}`, value: `${v.memory.percent}%` },
          { name: t('infraDisk'), status: v.disk.percent > 90 ? 'down' : v.disk.percent > 75 ? 'stale' : 'healthy', detail: `${v.disk.used} / ${v.disk.total}`, value: `${v.disk.percent}%` },
        )
      }
    } catch { /* skip VPS metrics on error */ }
    setVps(vpsResults)

    // ── Slow Queries ──
    try {
      const sqRes = await fetch(`${PROD_URL}/kscw/admin/slow-queries?limit=10`, {
        credentials: 'include',
      })
      if (sqRes.ok) {
        const sqData = await sqRes.json()
        setSlowQueries((sqData.data || []).map((q: Record<string, string>) => ({
          avg_ms: parseFloat(q.avg_ms),
          max_ms: parseFloat(q.max_ms),
          calls: parseInt(q.calls),
          total_ms: parseFloat(q.total_ms),
          rows: parseInt(q.rows),
          query: q.query,
        })))
      }
    } catch { /* skip slow queries on error */ }

    setLastCheck(new Date().toLocaleTimeString('de-CH', { hour12: false }))
    setLoading(false)
  }, [t])

  const runChecks = useCallback(async () => {
    setLoading(true)
    await runChecksInto()
  }, [runChecksInto])

  // Run once on mount — no deps to avoid re-trigger loop
  useEffect(() => { void (async () => { await runChecksInto() })() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Report to the app boot gate — see usePageReady.tsx. Gate on the initial
  // check pass: `loading` is true from the on-mount runChecks() until every
  // section has resolved, then the page's content reveals together.
  useReportPageLoading(loading)

  return (
    <div className="mx-auto max-w-3xl px-4 py-4">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            {t('infraTitle')}
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('infraDescription')}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {lastCheck && (
            <span className="text-xs text-gray-400 dark:text-gray-500">
              {lastCheck}
            </span>
          )}
          <button
            onClick={runChecks}
            disabled={loading}
            className="rounded-lg bg-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-300 disabled:opacity-50 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
          >
            {loading ? (
              <span className="flex items-center gap-1.5">
                <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                {t('infraChecking')}
              </span>
            ) : t('infraRefresh')}
          </button>
        </div>
      </div>

      {vps.length > 0 && <Section title={t('infraVpsResources')} checks={vps} />}
      <Section title={t('infraServices')} checks={services} />
      <Section title={t('infraDataSyncs')} checks={syncs} />
      <Section title={t('infraCronJobs')} checks={crons} />
      {stats.length > 0 && <Section title={t('infraStats')} checks={stats} />}

      {slowQueries.length > 0 && (
        <div className="mb-6">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {t('infraSlowQueries')}
          </h3>
          <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800/50">
            <Table className="text-xs">
              <TableHeader>
                <TableRow className="border-b border-gray-200 dark:border-gray-700">
                  <TableHead className="px-3 py-2 font-semibold text-gray-500 dark:text-gray-400">{t('infraQueryAvg')}</TableHead>
                  <TableHead className="px-3 py-2 font-semibold text-gray-500 dark:text-gray-400">{t('infraQueryMax')}</TableHead>
                  <TableHead className="px-3 py-2 font-semibold text-gray-500 dark:text-gray-400">{t('infraQueryCalls')}</TableHead>
                  <TableHead className="px-3 py-2 font-semibold text-gray-500 dark:text-gray-400">{t('infraQueryTotal')}</TableHead>
                  <TableHead className="px-3 py-2 font-semibold text-gray-500 dark:text-gray-400">{t('infraQueryCol')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {slowQueries.map((q, i) => (
                  <TableRow key={i} className="border-b border-gray-100 last:border-0 dark:border-gray-700/50">
                    <TableCell className={`px-3 py-2 font-mono tabular-nums ${q.avg_ms > 100 ? 'font-bold text-red-600 dark:text-red-400' : q.avg_ms > 20 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-700 dark:text-gray-300'}`}>
                      {q.avg_ms}ms
                    </TableCell>
                    <TableCell className="px-3 py-2 font-mono tabular-nums text-gray-600 dark:text-gray-400">{q.max_ms}ms</TableCell>
                    <TableCell className="px-3 py-2 font-mono tabular-nums text-gray-600 dark:text-gray-400">{q.calls.toLocaleString(currentLocale())}</TableCell>
                    <TableCell className="px-3 py-2 font-mono tabular-nums text-gray-600 dark:text-gray-400">{q.total_ms > 1000 ? `${(q.total_ms / 1000).toFixed(1)}s` : `${q.total_ms}ms`}</TableCell>
                    <TableCell className="max-w-xs truncate px-3 py-2 font-mono text-gray-500 dark:text-gray-400" title={q.query}>
                      {q.query}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  )
}
