import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useIdentityKeys } from '../../hooks/useIdentityKeys'
import { kscwApi } from '../../lib/api'
import { captureApiError } from '../../lib/sentry'
import { unwrapContentKey, wrapContentKeyFor, type Envelope } from '../../lib/e2ee'

interface MissingRecipient {
  member: number
  first_name: string
  last_name: string
  public_key: string
}

interface GapDoc {
  document: number
  member: number
  first_name: string
  last_name: string
  envelope: Envelope
  missing: MissingRecipient[]
}

/**
 * Restore identity-document access for staff who joined after the uploads happened.
 *
 * WHY THIS EXISTS AT ALL: the content key is wrapped once per reader, at upload time. A coach
 * who creates their identity key later was never wrapped to — `recipientsFor()` skips anyone
 * with no public key — so they are entitled on paper and hold nothing in practice. The server
 * cannot fix that; it has never held a content key. Only a device that already holds an
 * envelope can pass the key along.
 *
 * WHY IT IS TEAM-WIDE AND NOT PER-MEMBER: the alternative is every affected player noticing
 * the banner on their own profile and acting. Realistically that is never, and the failure
 * only surfaces when a coach opens Show-IDs in front of a referee. One colleague who already
 * holds the envelopes repairs the whole team in one press.
 *
 * ⚠ This does NOT widen access. The server recomputes `recipientsFor()` on the write and
 * drops any envelope for someone who is not currently the member's own coach/TR — so the
 * caller can only hand keys to people the server already lists as entitled, and only for
 * documents they can already open themselves.
 *
 * ⚠ Someone with no identity key at all never appears here and cannot be repaired. There is
 * nothing to wrap to until they create one. That is a different fix ("set up your key"), and
 * showing it as a repairable gap would produce a button that silently does nothing.
 */
export default function TeamIdentityRepair({ teamId, enabled }: { teamId: string | undefined; enabled: boolean }) {
  const { t } = useTranslation('teams')
  const { state, privateKey } = useIdentityKeys()
  // Stamped with the team it answers for, and DERIVED below — clearing it synchronously in
  // the effect body cascades a render, and the previous team's gaps are not this team's.
  const [loaded, setLoaded] = useState<{ team: string; docs: GapDoc[] } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!teamId) return
    try {
      const res = await kscwApi<{ data: { documents: GapDoc[] } }>(`/identity/gaps/team/${teamId}`)
      setLoaded({ team: teamId, docs: res.data?.documents ?? [] })
    } catch {
      // A refusal means "not staff here" — silence is right, not an error banner.
      setLoaded({ team: teamId, docs: [] })
    }
  }, [teamId])

  useEffect(() => {
    if (!enabled || !teamId) return
    let cancelled = false
    kscwApi<{ data: { documents: GapDoc[] } }>(`/identity/gaps/team/${teamId}`)
      .then((res) => { if (!cancelled) setLoaded({ team: teamId, docs: res.data?.documents ?? [] }) })
      .catch(() => { if (!cancelled) setLoaded({ team: teamId, docs: [] }) })
    return () => { cancelled = true }
  }, [teamId, enabled])

  const docs = loaded && loaded.team === teamId && enabled ? loaded.docs : []

  const handleRepair = async () => {
    if (!privateKey || !docs.length) return
    setBusy(true)
    let repaired = 0
    let failed = 0
    try {
      for (const d of docs) {
        try {
          // Unwrap with MY envelope, re-wrap per missing reader. The ciphertext is never
          // fetched — re-granting needs the content key, viewing needs the key and the bytes.
          const key = await unwrapContentKey(d.envelope, privateKey)
          const envelopes = await Promise.all(
            d.missing.map(async (r) => ({
              recipient: r.member,
              ...(await wrapContentKeyFor(key, r.public_key)),
            })),
          )
          await kscwApi('/identity/envelopes', {
            method: 'POST',
            body: { member: d.member, envelopes },
          })
          repaired += 1
        } catch (err) {
          // One unreadable document must not abort the other nineteen.
          failed += 1
          captureApiError(err, {
            operation: 'identityTeamRepair',
            endpoint: '/identity/envelopes',
            method: 'POST',
            payload: { member: d.member, missing: d.missing.length },
          })
        }
      }
      if (repaired) toast.success(t('identityRepairDone', { count: repaired }))
      if (failed) toast.error(t('identityRepairPartial', { count: failed }))
      await load()
    } finally {
      setBusy(false)
    }
  }

  if (!enabled || !docs.length) return null

  // Who is locked out, across the whole team — the actionable fact, deduplicated. The list of
  // affected PLAYERS is not shown: it is longer, and it is not what the reader needs to decide.
  const lockedOut = [...new Map(
    docs.flatMap((d) => d.missing.map((r) => [r.member, r] as const)),
  ).values()]

  return (
    <div className="mt-6 space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/40">
      <div className="flex items-start gap-3">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden="true" />
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
            {t('identityRepairTitle', {
              names: lockedOut.map((r) => `${r.first_name} ${r.last_name}`).join(', '),
              count: docs.length,
            })}
          </p>
          <p className="text-xs leading-relaxed text-amber-800 dark:text-amber-300">
            {t('identityRepairHint')}
          </p>
        </div>
      </div>
      {/*
        Three-way, not two: `state` starts at 'loading' until GET /identity/keys AND the
        IndexedDB read in useIdentityKeys() both return, and that races the gaps fetch above
        that decides whether this banner shows at all. Folding 'loading' into the else-branch
        told a coach who IS unlocked here to go unlock their key on another page — a definitive
        instruction, pointing away from the only control that repairs this. 'loading' now owns
        its own frame, and 'error' still falls through to the link so no state is stranded.
      */}
      {state === 'loading' ? (
        <Button type="button" size="sm" disabled loading>
          {t('identityRepairAction')}
        </Button>
      ) : state === 'unlocked' ? (
        <Button type="button" size="sm" onClick={() => void handleRepair()} loading={busy}>
          {t('identityRepairAction')}
        </Button>
      ) : (
        <p className="text-xs text-amber-800 dark:text-amber-300">
          <Link to="/profile/edit" className="font-medium underline">{t('identityRepairUnlock')}</Link>
        </p>
      )}
    </div>
  )
}
