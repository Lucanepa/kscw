import { useCallback, useEffect, useMemo, useState } from 'react'
import { useCollection } from '../../../lib/query'
import { useMutation } from '../../../hooks/useMutation'
import { useAuth } from '../../../hooks/useAuth'
import { useRealtime } from '../../../hooks/useRealtime'
import { kscwApi } from '../../../lib/api'
import type { Poll, PollVote } from '../../../types'
import { relId, memberDisplayName } from '../../../utils/relations'
import { toZurichDateString } from '../../../utils/dateHelpers'

/**
 * A poll `deadline` is a date-only string ("YYYY-MM-DD"). `new Date(deadline)`
 * parses it as UTC midnight, so in Europe/Zurich (UTC+1/+2) a naive
 * `new Date(deadline) < new Date()` marks the poll as expired 1–2 hours before
 * local midnight of its deadline day. Compare calendar days in Zurich instead:
 * the deadline only counts as passed once the current Zurich date is strictly
 * after the deadline day (the whole deadline day stays votable).
 */
export function isDeadlinePassed(deadline: string | null | undefined): boolean {
  if (!deadline) return false
  const deadlineDay = toZurichDateString(deadline)
  if (!deadlineDay) return false
  return toZurichDateString(new Date()) > deadlineDay
}

// Shared close/delete mutation scaffolding for the poll-list hooks
// (usePolls / useActivePolls) so the "update status → refetch" and
// "remove → refetch" wiring lives in one place instead of being copy-pasted.
function usePollActions(refetch: () => void) {
  const { update: updatePoll, remove: removePoll } = useMutation<Poll>('polls')

  const closePoll = useCallback(async (pollId: string) => {
    await updatePoll(pollId, { status: 'closed' })
    refetch()
  }, [updatePoll, refetch])

  const deletePoll = useCallback(async (pollId: string) => {
    await removePoll(pollId)
    refetch()
  }, [removePoll, refetch])

  return { closePoll, deletePoll }
}

export function usePolls(teamId: string) {
  const { user } = useAuth()

  const { data: pollsRaw, refetch: refetchPolls, isLoading } = useCollection<Poll>('polls', {
    filter: teamId ? { team: { _eq: teamId } } : { id: { _eq: -1 } },
    sort: ['-date_created'],
    all: true,
    enabled: !!teamId,
  })
  const polls = pollsRaw ?? []

  const { create: createPoll } = useMutation<Poll>('polls')
  const { closePoll, deletePoll } = usePollActions(refetchPolls)

  useRealtime<Poll>('polls', (e) => {
    if (e.record.team === teamId) refetchPolls()
  })

  const addPoll = useCallback(async (data: {
    question: string
    options: string[]
    mode: 'single' | 'multi'
    deadline?: string
    anonymous?: boolean
    results_visible?: boolean
  }) => {
    if (!user) return
    await createPoll({
      team: teamId,
      question: data.question,
      options: data.options,
      mode: data.mode,
      // NULL, not '' — polls.deadline is timestamptz and Postgres rejects an
      // empty string outright (500 on every no-deadline create, seen live
      // 2026-07-04 /teams/D4).
      deadline: data.deadline || null,
      anonymous: data.anonymous || false,
      // Default ON for new polls (the form sends it explicitly; migration 171
      // defaults existing rows to false so old polls stay manager-only).
      results_visible: data.results_visible ?? true,
      created_by: user.id,
      status: 'open',
    })
    refetchPolls()
  }, [user, teamId, createPoll, refetchPolls])

  return { polls, isLoading, addPoll, closePoll, deletePoll }
}

// Open, still-actionable polls across several teams — used by the home-screen
// surveys widget so polls (which otherwise live only on the team page) are easy
// to find. Returns close/delete mutations so managers can act inline.
export function useActivePolls(teamIds: string[]) {
  const { data: pollsRaw, refetch, isLoading } = useCollection<Poll>('polls', {
    filter: teamIds.length > 0
      ? { _and: [{ team: { _in: teamIds } }, { status: { _eq: 'open' } }] }
      : { id: { _eq: -1 } },
    sort: ['-date_created'],
    all: true,
    enabled: teamIds.length > 0,
  })
  // The deadline doesn't auto-close a poll (status stays 'open'), so drop polls
  // whose deadline has passed — they're no longer actionable on the home screen.
  const polls = (pollsRaw ?? []).filter(p => !isDeadlinePassed(p.deadline))

  const { closePoll, deletePoll } = usePollActions(refetch)

  useRealtime<Poll>('polls', (e) => {
    if (e.record.team != null && teamIds.includes(String(e.record.team))) refetch()
  })

  return { polls, isLoading, closePoll, deletePoll, refetch }
}

export function usePollVotes(poll: Poll, canManage = false) {
  const pollId = poll.id
  const anonymous = !!poll.anonymous
  const resultsVisible = !!poll.results_visible
  const { user } = useAuth()
  // The creator always sees the totals (matters for chat polls, where the
  // creator is usually a regular member rendered with canManage=false).
  const isCreator = user != null && poll.created_by != null && String(poll.created_by) === String(user.id)
  // Whether this viewer may see the real aggregate at all. WHEN they see it is
  // PollCard's timing gate (managers live, everyone else after voting/close).
  const canSeeResults = canManage || resultsVisible || isCreator

  const { data: votesRaw, refetch, isLoading, isError } = useCollection<PollVote>('poll_votes', {
    filter: pollId ? { poll: { _eq: pollId } } : { id: { _eq: -1 } },
    // Expand the voter so managers can see per-member answers (non-anonymous
    // polls). Non-managers only ever receive their own vote row (poll_votes
    // read is OWN_MEMBER for them), so this leaks nothing. As of the 2026-07-02
    // audit (#5/#14) the manager reads are ALSO scoped to non-anonymous polls,
    // so for an anonymous poll this returns just the caller's own row.
    fields: ['id', 'poll', 'member', 'selected_options', 'member.id', 'member.first_name', 'member.last_name', 'member.nickname'],
    all: true,
    enabled: !!pollId,
  })
  const votes = votesRaw ?? []

  const { create, update } = useMutation<PollVote>('poll_votes')

  // Some viewers can't compute the tally from raw poll_votes rows and need the
  // identity-free aggregate from GET /kscw/polls/:id/results instead:
  //   - managers on ANONYMOUS polls (raw rows withheld at the data layer since
  //     the 2026-07-02 audit — anonymity is no longer a UI-only toggle);
  //   - non-managers who may see results (migration 171) — their poll_votes
  //     read is OWN_MEMBER, so raw rows only ever contain their own vote.
  // `tick` bumps on realtime vote events (and own votes) so the tally stays
  // live without exposing identities.
  const needsAggregate = canManage ? anonymous : canSeeResults
  const [tick, setTick] = useState(0)
  // Stamped with the poll it belongs to and with an explicit settled status.
  // A bare `null` used to mean BOTH "still in flight" and "the request failed"
  // (the catch reset it), so callers could not tell a pending aggregate from a
  // dead one — and the tally below quietly fell back to the raw rows.
  const [agg, setAgg] = useState<
    { pollId: string; status: 'ready' | 'error'; counts: Record<number, number>; totalVotes: number } | null
  >(null)
  // Derived during render, never written from the effect body: a result stamped
  // with a different poll's id counts as "not loaded", so a poll switch can't
  // carry the previous poll's counts over, and the effect stays free of
  // cascading renders.
  const aggForPoll = agg && String(agg.pollId) === String(pollId) ? agg : null
  useEffect(() => {
    // When the aggregate doesn't apply we simply leave `agg` untouched — the
    // memo below gates on `needsAggregate` so a stale value is never read.
    // A `tick` re-fetch also leaves the previous ready value in place, so a
    // realtime vote refreshes the numbers without flashing the skeleton.
    if (!pollId || !needsAggregate) return
    let cancelled = false
    kscwApi<{ counts: Record<number, number>; totalVotes: number }>(`/polls/${pollId}/results`)
      .then((r) => {
        if (!cancelled) setAgg({ pollId, status: 'ready', counts: r.counts ?? {}, totalVotes: r.totalVotes ?? 0 })
      })
      // 'error', not null: null is "still loading", which would hold the results
      // skeleton up for good after a 403/500/network blip.
      .catch(() => { if (!cancelled) setAgg({ pollId, status: 'error', counts: {}, totalVotes: 0 }) })
    return () => { cancelled = true }
  }, [pollId, needsAggregate, tick])

  // Is the tally `getResults()` returns trustworthy yet, and did it fail?
  // Both sources are covered: the raw poll_votes fetch and — for viewers served
  // by the identity-free endpoint — the /kscw/polls/:id/results round trip.
  // Neither gate can stick: TanStack drops `isLoading` on failure, and the
  // aggregate always settles to 'ready' or 'error'.
  const resultsPending = isLoading || (needsAggregate && !!pollId && aggForPoll == null)
  const resultsError = needsAggregate ? aggForPoll?.status === 'error' : isError

  useRealtime<PollVote>('poll_votes', (e) => {
    if (e.record.poll === pollId) { refetch(); setTick((t) => t + 1) }
  })

  // `member` may arrive expanded (object) now, so compare via relId.
  const myVote = votes.find(v => relId(v.member) === user?.id)

  const vote = useCallback(async (selectedOptions: number[]) => {
    if (!user) return
    if (myVote) {
      await update(myVote.id, { selected_options: selectedOptions })
    } else {
      await create({
        poll: pollId,
        member: user.id,
        selected_options: selectedOptions,
      })
    }
    refetch()
    // Non-managers don't receive realtime events for other members' vote rows
    // (own-row read permission), so re-pull the aggregate explicitly — their
    // fresh vote must show up in the totals they're about to see.
    setTick((t) => t + 1)
  }, [user, pollId, myVote, create, update, refetch])

  // Compute results: count votes per option index, and (when the voter is
  // expanded) collect who picked each option so managers can see per-member
  // answers. For multi-choice a voter appears under every option they selected.
  // Memoized so PollCard re-renders don't recompute the tally unless the inputs
  // actually changed.
  const results = useMemo(() => {
    // Aggregate path (anonymous-poll managers, visible-results non-managers):
    // return the identity-free endpoint counts. No `voters` — either anonymity
    // demands it, or the viewer isn't entitled to names in the first place.
    //
    // NEVER fall through to the raw `votes` tally on this path. These viewers
    // only ever receive their OWN vote row (poll_votes read is OWN_MEMBER), so
    // the fallback painted a fabricated result: their option at 100% with
    // "1 vote" once they had voted, or every bar at 0% with "0 votes" if they
    // hadn't — and the failed-aggregate case left that on screen for good.
    // Zeroes here are inert placeholders; callers gate on `resultsPending` /
    // `resultsError` instead of drawing them.
    if (needsAggregate) {
      if (aggForPoll?.status === 'ready') {
        return { counts: aggForPoll.counts, voters: {} as Record<number, Array<{ id: string; name: string }>>, totalVotes: aggForPoll.totalVotes }
      }
      return { counts: {} as Record<number, number>, voters: {} as Record<number, Array<{ id: string; name: string }>>, totalVotes: 0 }
    }
    const counts: Record<number, number> = {}
    const voters: Record<number, Array<{ id: string; name: string }>> = {}
    votes.forEach(v => {
      const m = v.member as unknown as string | { id: string | number; first_name?: string; last_name?: string; nickname?: string | null }
      const id = relId(m)
      const name = (typeof m === 'object' && m ? memberDisplayName(m) : '') || id
      const selected = (v.selected_options as number[]) ?? []
      selected.forEach(idx => {
        counts[idx] = (counts[idx] || 0) + 1
        if (!voters[idx]) voters[idx] = []
        voters[idx].push({ id, name })
      })
    })
    return { counts, voters, totalVotes: votes.length }
  }, [needsAggregate, aggForPoll, votes])

  const getResults = useCallback(() => results, [results])

  return { votes, myVote, isLoading, resultsPending, resultsError, vote, getResults, canSeeResults }
}
