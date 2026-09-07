import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { AlertCircle, Clock, EyeOff, Lock, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Poll } from '../../types'
import { formatDateZurich } from '../../utils/dateHelpers'
import { usePollVotes, isDeadlinePassed } from './hooks/usePoll'
import { useConfirm } from '../../components/ConfirmProvider'

interface PollCardProps {
  poll: Poll
  canManage: boolean
  onClose: (pollId: string) => void
  onDelete: (pollId: string) => void
}

export default function PollCard({ poll, canManage, onClose, onDelete }: PollCardProps) {
  const { t } = useTranslation('polls')
  const confirm = useConfirm()
  // `isLoading` is this card's own poll_votes fetch — every card fires it cold
  // on mount and nothing upstream waits for it. Until it lands `myVote` is
  // undefined, which is indistinguishable from "hasn't voted yet", so the gates
  // below hold the vote/result UI back instead of guessing "no".
  // `resultsPending` / `resultsError` cover the OTHER half of the tally: the
  // identity-free aggregate from /kscw/polls/:id/results, which most viewers'
  // numbers actually come from and which nothing used to wait for.
  const {
    myVote, isLoading: votesLoading, resultsPending, resultsError,
    vote, getResults, canSeeResults,
  } = usePollVotes(poll, canManage)
  const [selected, setSelected] = useState<number[]>([])
  // Tracks the create/update mutation itself (not the votes fetch) so a slow
  // save disables the button and a second tap can't fire a duplicate vote.
  const [submitting, setSubmitting] = useState(false)
  // Editing = the voter already voted and tapped "Change vote" to revise their
  // answer. Voting stays possible until the deadline / the poll closes.
  const [editing, setEditing] = useState(false)

  const isOpen = poll.status === 'open'
  // ⚠ Only meaningful once `votesLoading` is false — before that it just means
  // "the vote rows haven't arrived", not "this member hasn't voted".
  const hasVoted = !!myVote
  const deadlinePassed = isDeadlinePassed(poll.deadline)
  // Voting is allowed while the poll is open and before the deadline. A voter
  // may change their answer up to that point (decision 2026-07-02) — vote()
  // already updates the existing row, we just re-expose the form on request.
  const votingOpen = isOpen && !deadlinePassed
  // Gated on the votes fetch as well: while it's in flight an already-voted
  // member used to get the untouched ballot with a live "Vote" button, and
  // vote() (which closes over myVote) then takes the create branch — poll_votes
  // has no (poll, member) unique index, so that duplicate row is counted
  // forever in every later tally.
  const canVote = votingOpen && !votesLoading && (!hasVoted || editing)
  // Managers (coach/TR/board) see the live tally at any time so they can monitor
  // replies before the deadline (decision 2026-06-28). Everyone else sees results
  // once they've voted, the poll closed, or the deadline passed — IF the poll
  // permits it (canSeeResults: results_visible polls + the creator; migration
  // 171). On manager-only polls voters get a plain confirmation instead —
  // previously the bars rendered from the voter's own single row (OWN_MEMBER
  // read), a misleading "100% / 1 vote" tally. A manager who hasn't voted yet
  // still gets the result bars — made tappable below via `canVote` so they can
  // cast a vote without losing sight of the running tally.
  const wantsResults = canManage || (canSeeResults && (hasVoted || !isOpen || deadlinePassed))
  // Entitled ≠ ready. Both halves of the tally have to be in before any bar is
  // drawn: this card's poll_votes fetch AND, for the viewers served by the
  // aggregate endpoint, its round trip. `canManage` alone used to paint the bars
  // on frame one from an empty tally — every bar at 0%, "0 vote(s)", which reads
  // as "nobody has answered"; gating on the votes fetch alone still left the
  // aggregate ungated, so a member who had just voted saw a tally built from
  // their own single row — their option at 100%, "1 vote".
  // `resultsError` is the escape hatch: a failed aggregate must not leave a
  // skeleton up for good, and must not fall back to that own-row tally either.
  const showResults = wantsResults && !resultsPending && !resultsError
  // Managers see per-member answers (who picked what) — but only on
  // non-anonymous polls. An anonymous poll stays totals-only even for managers.
  const showVoters = canManage && !poll.anonymous
  // Rows whose shape is known but whose numbers aren't: keep the shape, go
  // dimmed. Deliberately skipped while the viewer can still cast a vote — a
  // live ballot is honest and actionable, and stranding it behind the tally's
  // spinner would be the worse bug.
  const optionsPending = votesLoading || (wantsResults && resultsPending && !canVote)

  const { counts, voters, totalVotes } = getResults()

  // Find the max vote count for highlighting
  const maxCount = Math.max(0, ...Object.values(counts))

  const toggleOption = (idx: number) => {
    if (!canVote) return
    if (poll.mode === 'single') {
      setSelected([idx])
    } else {
      setSelected(prev =>
        prev.includes(idx) ? prev.filter(i => i !== idx) : [...prev, idx],
      )
    }
  }

  const handleVote = async () => {
    // votesLoading: myVote isn't known yet, so vote() would insert a second row.
    if (selected.length === 0 || submitting || votesLoading) return
    setSubmitting(true)
    try {
      await vote(selected)
      setSelected([])
      setEditing(false)
    } catch {
      // Keep the current selection so the member can retry without re-picking.
      toast.error(t('common:error'))
    } finally {
      setSubmitting(false)
    }
  }

  // Enter edit mode pre-filled with the current answer so tapping only adds the
  // change (important for multi-choice: their existing picks stay selected).
  const startEditing = () => {
    setSelected(myVote?.selected_options ?? [])
    setEditing(true)
  }

  const cancelEditing = () => {
    setSelected([])
    setEditing(false)
  }

  const handleClose = async () => {
    if (await confirm({ message: t('confirmClose') })) {
      onClose(poll.id)
    }
  }

  const handleDelete = async () => {
    if (await confirm({ message: t('confirmDelete'), danger: true })) {
      onDelete(poll.id)
    }
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
      {/* Header */}
      <div className="mb-3 flex items-start justify-between gap-2">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {poll.question}
        </h4>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
            isOpen
              ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300'
              : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
          }`}
        >
          {isOpen ? t('open') : t('closed')}
        </span>
      </div>

      {/* Deadline */}
      {poll.deadline && (
        <div className="mb-3 flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <Clock className="h-3.5 w-3.5" />
          {deadlinePassed ? (
            <span className="text-red-500 dark:text-red-400">{t('deadlinePassed')}</span>
          ) : (
            <span>
              {t('deadline')}: {formatDateZurich(poll.deadline)}
            </span>
          )}
        </div>
      )}

      {/* Anonymous hint — tells a manager why per-member answers aren't shown. */}
      {canManage && poll.anonymous && (
        <div className="mb-3 flex items-center gap-1.5 text-xs text-gray-400 dark:text-gray-500">
          <EyeOff className="h-3.5 w-3.5" />
          <span>{t('anonymousNote')}</span>
        </div>
      )}

      {/* Options */}
      <div className="space-y-2">
        {/* Tally in flight: the option text is prop data and correct on frame
            one, but whether it's selected, whether it's the member's answer, how
            many picked it and whether tapping it does anything are not — so the
            rows keep their shape and go dimmed + disabled instead of
            impersonating a ballot or a result. */}
        {optionsPending && poll.options.map((option, idx) => (
          <button
            key={idx}
            type="button"
            disabled
            className="w-full animate-pulse cursor-default rounded-md border border-gray-200 bg-gray-100 px-3 py-2 text-left text-sm text-gray-400 dark:border-gray-700 dark:bg-gray-700/40 dark:text-gray-500"
          >
            {option}
          </button>
        ))}
        {!optionsPending && poll.options.map((option, idx) => {
          const count = counts[idx] || 0
          const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0
          const isSelected = selected.includes(idx)
          const isMyVote = myVote?.selected_options?.includes(idx)
          const isTopOption = count === maxCount && maxCount > 0

          if (showResults) {
            // Result bar view. The fill + label are identical whether or not the
            // viewer can act; only the wrapper differs (tappable <button> when the
            // viewer can still vote, e.g. a manager who hasn't voted yet).
            const bar = (
              <>
                <div
                  className={`absolute inset-y-0 left-0 rounded-md transition-all ${
                    isTopOption
                      ? 'bg-blue-100 dark:bg-blue-900/40'
                      : 'bg-gray-100 dark:bg-gray-700/40'
                  }`}
                  style={{ width: `${pct}%` }}
                />
                <div className="relative flex items-center justify-between px-3 py-2">
                  <span className={`text-sm ${isMyVote ? 'font-semibold' : ''} text-gray-900 dark:text-gray-100`}>
                    {option}
                    {isMyVote && (
                      <span className="ml-1.5 text-xs text-blue-600 dark:text-blue-400">
                        ({t('voted')})
                      </span>
                    )}
                  </span>
                  <span className="ml-2 shrink-0 text-xs font-medium text-gray-600 dark:text-gray-400">
                    {pct}%
                  </span>
                </div>
              </>
            )

            const voterNames = showVoters ? (voters[idx] ?? []).map((v) => v.name).filter(Boolean) : []

            return (
              <div key={idx} className="space-y-1">
                {canVote ? (
                  <button
                    type="button"
                    onClick={() => toggleOption(idx)}
                    className={`relative block w-full overflow-hidden rounded-md text-left transition-opacity hover:opacity-90 ${
                      isSelected ? 'ring-2 ring-blue-500 dark:ring-blue-400' : ''
                    }`}
                  >
                    {bar}
                  </button>
                ) : (
                  <div className="relative overflow-hidden rounded-md">{bar}</div>
                )}
                {/* Per-member answers (managers, non-anonymous polls only). */}
                {voterNames.length > 0 && (
                  <p className="px-1 text-xs leading-snug text-gray-500 dark:text-gray-400">
                    <span className="text-gray-400 dark:text-gray-500">{t('votedBy')}: </span>
                    {voterNames.join(', ')}
                  </p>
                )}
              </div>
            )
          }

          // Results hidden and no vote to cast (already voted on a manager-only
          // poll, or it ended): inert rows, own pick marked — no fake tally.
          if (!canVote) {
            return (
              <div
                key={idx}
                className={`w-full rounded-md border px-3 py-2 text-left text-sm ${
                  isMyVote
                    ? 'border-blue-500 bg-blue-50 text-blue-900 dark:border-blue-400 dark:bg-blue-900/30 dark:text-blue-100'
                    : 'border-gray-200 bg-white text-gray-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-400'
                }`}
              >
                {option}
                {isMyVote && (
                  <span className="ml-1.5 text-xs text-blue-600 dark:text-blue-400">({t('voted')})</span>
                )}
              </div>
            )
          }

          // Voting view
          return (
            <button
              key={idx}
              type="button"
              onClick={() => toggleOption(idx)}
              className={`w-full rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                isSelected
                  ? 'border-blue-500 bg-blue-50 text-blue-900 dark:border-blue-400 dark:bg-blue-900/30 dark:text-blue-100'
                  : 'border-gray-200 bg-white text-gray-900 hover:border-gray-300 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:hover:border-gray-500 dark:hover:bg-gray-700'
              }`}
            >
              {option}
            </button>
          )
        })}
      </div>

      {/* The tally couldn't be loaded. Say so — the alternative was falling back
          to the viewer's own vote row, which reads as "100% / 1 vote". */}
      {wantsResults && resultsError && (
        <div className="mt-3 flex items-center gap-1.5 text-xs text-gray-400 dark:text-gray-500">
          <AlertCircle className="h-3.5 w-3.5" />
          <span>{t('common:error')}</span>
        </div>
      )}

      {/* Manager-only results: tell the voter why there's no tally. */}
      {!canSeeResults && hasVoted && (
        <div className="mt-3 flex items-center gap-1.5 text-xs text-gray-400 dark:text-gray-500">
          <EyeOff className="h-3.5 w-3.5" />
          <span>{t('resultsHiddenNote')}</span>
        </div>
      )}

      {/* Vote / change-vote controls */}
      {canVote && (
        <div className="mt-3 flex items-center gap-2">
          <Button
            size="sm"
            onClick={handleVote}
            disabled={selected.length === 0 || submitting}
          >
            {editing ? t('changeVote') : t('vote')}
          </Button>
          {editing && (
            <Button size="sm" variant="ghost" onClick={cancelEditing} disabled={submitting}>
              {t('cancelChange')}
            </Button>
          )}
        </div>
      )}

      {/* "Change vote" entry point — shown once the voter has an answer and
          voting is still open, so they can revise it before the deadline. */}
      {hasVoted && votingOpen && !editing && (
        <div className="mt-3">
          <Button size="sm" variant="outline" onClick={startEditing}>
            {t('changeVote')}
          </Button>
        </div>
      )}

      {/* Footer: vote count + manage actions. The count comes from the real
          aggregate only for viewers entitled to results — for the rest it would
          just be their own row (0 or 1), so show nothing. */}
      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {canSeeResults
            ? (resultsPending
                // Never "0 vote(s)" / "1 vote" from a tally that hasn't loaded —
                // and for most viewers that tally is the aggregate, not the
                // poll_votes fetch this used to wait on. A chip of the same
                // height, so the row doesn't jump when the number lands.
                ? <span className="inline-block h-3 w-16 animate-pulse rounded bg-gray-200 dark:bg-gray-700" aria-hidden="true" />
                : resultsError
                  // Failed: no number at all rather than an own-row count.
                  ? ''
                  : t('votes', { count: totalVotes }))
            : ''}
        </span>

        {canManage && (
          <div className="flex gap-1">
            {isOpen && (
              <Button variant="ghost" size="sm" onClick={handleClose} title={t('closePoll')}>
                <Lock className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={handleDelete} title={t('deletePoll')}>
              <Trash2 className="h-3.5 w-3.5 text-red-500" />
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
