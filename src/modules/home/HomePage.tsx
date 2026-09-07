import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../../hooks/useAuth'
import { useTeamPermissions } from '../../hooks/useTeamPermissions'
import { useCollection } from '../../lib/query'
import { fetchSeasons } from '../../lib/api'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useNotificationsContext } from '../../hooks/NotificationsContext'
import { useSportPreference } from '../../hooks/useSportPreference'
import { formatDate, formatDateCompact, formatTime, formatWeekday, getCurrentSeason, formatSeasonLong, todayLocal, toZurichDateString, formatDateTimeCompactZurich } from '../../utils/dateHelpers'
import { asObj, relId, teamCoachIds } from '../../utils/relations'
import TeamChip from '../../components/TeamChip'
import StatusBadge from '../../components/StatusBadge'
import { stripHtml } from '../../utils/stripHtml'
import VolleyballIcon from '../../components/VolleyballIcon'
import BasketballIcon from '../../components/BasketballIcon'
import NotificationPanel from '../../components/NotificationPanel'
import { TourPageButton } from '../guide/TourPageButton'
import GameDetailModal from '../games/components/GameDetailModal'
import TrainingDetailModal from '../trainings/TrainingDetailModal'
import EventDetailModal from '../events/EventDetailModal'
import { asTeams, getEventDateBadgeParts } from '../events/eventHelpers'
import DutyEventCard from '../events/DutyEventCard'
import AnnouncementRow from './components/AnnouncementRow'
import AnnouncementDetailModal from './components/AnnouncementDetailModal'
import DuesNewsRow from './components/DuesNewsRow'
import { useDuesNews } from '../../hooks/useFinance'
import { useAnnouncements } from '../../hooks/useAnnouncements'
import { useUserVisibleEventIds } from '../../hooks/useUserVisibleEventIds'
import { useUserVisibleGameIds } from '../../hooks/useUserVisibleGameIds'
import ParticipationSummary from '../../components/ParticipationSummary'
import { useBulkParticipationStatuses, useBulkParticipations } from '../../hooks/useBulkParticipationStatuses'
import { useEffectiveSeason } from '../../hooks/useEffectiveSeason'
import { useNow } from '../../hooks/useNow'
import type { Game, Event, Team, Training, Hall, Member, MemberTeam, Notification, Announcement, Participation, Ranking, BaseRecord } from '../../types'
import { ClipboardList, Clock, AlertTriangle, Trophy, Medal, Bell, CalendarDays, LayoutGrid, List, ScrollText } from 'lucide-react'
import WhistleIcon from '../../components/WhistleIcon'
import { detectCupMatch } from '../spielplanung/gameChipUtils'
import { useReportPageLoading } from '../../hooks/usePageReady'
import RankingsTable from '../games/components/RankingsTable'
import InstallBanner from '../guide/install/InstallBanner'
import FormFillModal from '../forms/FormFillModal'
import { useFillableForms, type FillableForm } from '../../hooks/useFillableForms'
import YourDuesCard from '../finance/YourDuesCard'
import YourFinesCard from '../fines/YourFinesCard'
import HomePollsCard from '../polls/HomePollsCard'
import UpcomingTicker from './components/UpcomingTicker'
import { eventTypeLabelKey } from '../calendar/eventTypeLabel'
import HomeDelegationCard from './components/HomeDelegationCard'
import MyDutyBanner from './components/MyDutyBanner'
import { useMyDuties, DUTY_ROLE_LABEL_KEYS, type MyDuty } from '../../hooks/useMyDuties'

type ExpandedGame = Game & {
  kscw_team?: Team & BaseRecord | string
  hall?: BaseRecord | string
}

type EventExpanded = Event & { teams?: Team[] | string[] }

type TrainingExpanded = Training & {
  team?: Team | string
  hall?: Hall | string
  coach?: Member | string
}

type MemberTeamExpanded = MemberTeam & { team?: Team | string }

// Cut-off for the Spielplanung absences reminder banner (volleyball players).
const ABSENCES_ALERT_DEADLINE = new Date('2026-06-01T23:59:59+02:00').getTime()


export default function HomePage() {
  const { t } = useTranslation('home')
  const { t: tn } = useTranslation('notifications')
  const { t: tf } = useTranslation('forms')
  const { t: tg } = useTranslation('games')

  const { user, isApproved, primarySport, coachTeamIds } = useAuth()
  const { canManageTeam } = useTeamPermissions()
  const { items: fillableForms, refetch: refetchForms } = useFillableForms()
  const [fillItem, setFillItem] = useState<FillableForm | null>(null)
  // IBAN nudge — finance needs every member's up-to-date IBAN. Show a dismissible
  // banner to members who haven't set one; the CTA opens the profile editor.
  // ⚠ Keyed per MEMBER, not per device (migration 348). A household guardian
  // switches between her children on one phone; a device-global key meant
  // dismissing this for one daughter silently hid a real financial prompt for
  // the other two, and the club would never learn their IBAN.
  const ibanNudgeKey = `wiedisync_iban_nudge:${user?.id ?? 'anon'}`
  // Derived from the key, not held in state: a useState initialiser runs once,
  // so switching child would carry the previous one's dismissal, and resyncing
  // from an effect is a cascading render. `bump` re-reads after a dismiss.
  const [ibanNudgeBump, setIbanNudgeBump] = useState(0)
  const ibanNudgeDismissed = useMemo(() => {
    try { return localStorage.getItem(ibanNudgeKey) === '1' } catch { return false }
    // `ibanNudgeBump` is not "unnecessary": localStorage is an external store the
    // linter cannot see, and without it this never re-reads after a dismiss.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ibanNudgeKey, ibanNudgeBump])
  const dismissIbanNudge = () => {
    try { localStorage.setItem(ibanNudgeKey, '1') } catch { /* ignore */ }
    setIbanNudgeBump((n) => n + 1)
  }
  const { sport, setSport } = useSportPreference()
  // Hide sport toggle for users who play only one sport
  const showSportToggle = primarySport === 'both'
  const [selectedGame, setSelectedGame] = useState<ExpandedGame | null>(null)
  const [selectedTraining, setSelectedTraining] = useState<TrainingExpanded | null>(null)
  const [selectedEvent, setSelectedEvent] = useState<EventExpanded | null>(null)
  const [showAllGames, setShowAllGames] = useState(false)
  const [showAllResults, setShowAllResults] = useState(false)
  const [showCategorized, setShowCategorized] = useState(false)
  const [notifPanelOpen, setNotifPanelOpen] = useState(false)
  const [selectedAnnouncement, setSelectedAnnouncement] = useState<Announcement | null>(null)
  // Evaluated once per mount (lazy initializer) instead of on every render —
  // `Date.now()` is impure during render. The banner is a one-way cut-off, so a
  // per-mount read is equivalent to a per-render one.
  const [beforeAbsencesDeadline] = useState(() => Date.now() < ABSENCES_ALERT_DEADLINE)
  const { notifications: allNotifs, unreadCount, markAsRead, markAllAsRead, deleteNotification, clearAllRead } = useNotificationsContext()
  const { announcements } = useAnnouncements({ limit: 10 })
  // An open bill leads the news feed. It is derived from the member's invoices
  // (not a stored notification), so it clears itself once they pay or mark the
  // bill paid — see DuesNewsRow.
  const duesNews = useDuesNews()

  // Unified news feed: pinned announcements first, then notifications + remaining
  // announcements interleaved by timestamp (desc). Cap at 3 for the homepage card.
  type FeedItem =
    | { kind: 'announcement'; id: string; ts: number; pinned: boolean; record: Announcement }
    | { kind: 'notification'; id: string; ts: number; pinned: false; record: Notification }
  const feedItems = useMemo<FeedItem[]>(() => {
    const annItems: FeedItem[] = announcements.map((a) => ({
      kind: 'announcement',
      id: `a:${a.id}`,
      ts: new Date(a.published_at ?? a.date_created ?? 0).getTime(),
      pinned: !!a.pinned,
      record: a,
    }))
    // Announcement bell notifications are excluded — the announcement itself is
    // already in the feed via useAnnouncements (they'd show twice otherwise).
    const notifItems: FeedItem[] = allNotifs
      .filter((n) => n.type !== 'announcement')
      .map((n) => ({
        kind: 'notification' as const,
        id: `n:${n.id}`,
        ts: new Date(n.date_created ?? n.created ?? 0).getTime(),
        pinned: false as const,
        record: n,
      }))
    const merged = [...annItems, ...notifItems]
    merged.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return b.ts - a.ts
    })
    return merged.slice(0, 3)
  }, [announcements, allNotifs])

  const today = useMemo(() => todayLocal(), [])

  // Sport filter for Directus queries (filter via kscw_team relation)
  const sportFilter = useMemo((): Record<string, unknown> | null => {
    if (sport === 'vb') return { kscw_team: { sport: { _eq: 'volleyball' } } }
    if (sport === 'bb') return { kscw_team: { sport: { _eq: 'basketball' } } }
    return null
  }, [sport])

  // Fetch user's team memberships (only when logged in)
  const { data: memberTeamsRaw, isLoading: memberTeamsLoading } = useCollection<MemberTeamExpanded>('member_teams', {
    // Gate on the TEAM being active (mirrors useAuth) — not on
    // member_teams.season, which is a create-time stamp uncoupled from the
    // manually-run rollover and so empties `hasTeams` for every plain player
    // between the Jun-1 cutover and the rollover.
    filter: user ? { _and: [{ member: { _eq: user.id } }, { team: { active: { _eq: true } } }] } : { id: { _eq: -1 } },
    fields: ['*', 'team.*'],
    limit: 20,
    enabled: !!user,
  })
  const memberTeams = memberTeamsRaw ?? []

  const userTeamIds = useMemo(() => [...new Set([
    ...memberTeams.map((mt) => relId(mt.team)),
    ...coachTeamIds,
  ].filter(Boolean))], [memberTeams, coachTeamIds])
  const hasTeams = userTeamIds.length > 0

  // The upcoming-ticker scope: everyone's own teams, admins included. It used to
  // widen to every team an admin could see, which turned a "what's coming up for
  // me" strip into a club-wide firehose — five other teams' trainings scrolling
  // past before your own. The club-wide view already exists, in the calendar.
  //
  // The ticker can't query anything until this resolves, so an empty
  // `tickerTeamIds` means either "no teams" or "not known yet" — the ticker needs
  // to tell those apart to decide between rendering nothing and holding its
  // space. That wait is now exactly `memberTeamsLoading`, which the call site
  // below passes as `scopeLoading`.
  const tickerTeamIds = userTeamIds

  // Games this member was invited to as a guest (migration 271) — filed under
  // another team, so the team filter below would drop them.
  const { guestGameIds } = useUserVisibleGameIds(user?.id)

  // Build team filter for games. A guest invitation makes the fixture "mine" for
  // every purpose this page serves, so it is OR-ed in rather than kept in a
  // separate block — the borrowed player sees it in their next-games list exactly
  // where their own team's games are.
  const teamGameFilter = useMemo((): Record<string, unknown> | null => {
    const parts: Record<string, unknown>[] = []
    if (hasTeams) parts.push({ kscw_team: { _in: userTeamIds } })
    if (guestGameIds.length > 0) parts.push({ id: { _in: guestGameIds } })
    if (parts.length === 0) return null
    return parts.length === 1 ? parts[0] : { _or: parts }
  }, [userTeamIds, hasTeams, guestGameIds])

  // "Do I have games of my own?" — the games/results blocks key off this instead of
  // `hasTeams`, so a member with no roster at all (a borrowed junior, a returning
  // player between teams) still gets their invited fixture rather than the club-wide
  // fallback list. Trainings, rankings and team blocks stay on `hasTeams`: an
  // invitation to one game is not a team.
  const hasOwnGames = hasTeams || guestGameIds.length > 0

  // Season-scoped so games/results flip to the new season once its data lands
  // (falls back to the latest season with data in the gap before then).
  const effGameSeason = useEffectiveSeason('games')
  const effRankSeason = useEffectiveSeason('rankings')

  // Rankings season selector (mirrors the Games tab): defaults to the latest
  // season with data; the dropdown also offers the current season as a "coming
  // soon" placeholder until Swiss Volley publishes it. homeRankSeason !== null
  // means the user has actively picked a season — only then does the widget
  // stay visible for an empty season (to show the placeholder).
  const { data: homeRankSeasonsRaw } = useQuery<string[]>({
    queryKey: ['effective-season', 'rankings'],
    queryFn: () => fetchSeasons('rankings'),
    staleTime: 60_000,
  })
  const [homeRankSeason, setHomeRankSeason] = useState<string | null>(null)
  const selectedHomeSeason = homeRankSeason ?? effRankSeason
  const homeRankSeasonOptions = useMemo(() => {
    const set = new Set<string>(homeRankSeasonsRaw ?? [])
    set.add(getCurrentSeason())
    set.add(selectedHomeSeason)
    return [...set].sort().reverse()
  }, [homeRankSeasonsRaw, selectedHomeSeason])

  // Next 5 upcoming games (all) — only fetch when user toggled "show all" or has no teams
  const allGamesFilter = useMemo((): Record<string, unknown> => {
    const conditions: Record<string, unknown>[] = [{ status: { _eq: 'scheduled' } }, { date: { _gte: today } }, { away_team: { _nnull: true } }, { season: { _eq: effGameSeason } }]
    if (sportFilter) conditions.push(sportFilter)
    return { _and: conditions }
  }, [today, sportFilter, effGameSeason])
  const { data: allNextGamesRaw, isLoading: gamesLoading } = useCollection<ExpandedGame>('games', {
    filter: allGamesFilter,
    fields: ['*', 'kscw_team.*', 'kscw_team.coach.members_id', 'kscw_team.team_responsible.members_id', 'hall.*'],
    sort: ['date', 'time'],
    limit: 5,
    enabled: showAllGames || !hasOwnGames,
  })
  const allNextGames = allNextGamesRaw ?? []

  // Next 5 upcoming games (my teams only)
  const myGamesFilter = useMemo((): Record<string, unknown> => {
    const conditions: Record<string, unknown>[] = [{ status: { _eq: 'scheduled' } }, { date: { _gte: today } }, { away_team: { _nnull: true } }, { season: { _eq: effGameSeason } }]
    if (teamGameFilter) conditions.push(teamGameFilter)
    if (sportFilter) conditions.push(sportFilter)
    return { _and: conditions }
  }, [today, teamGameFilter, sportFilter, effGameSeason])
  const { data: myNextGamesRaw } = useCollection<ExpandedGame>('games', {
    filter: myGamesFilter,
    fields: ['*', 'kscw_team.*', 'kscw_team.coach.members_id', 'kscw_team.team_responsible.members_id', 'hall.*'],
    sort: ['date', 'time'],
    limit: 5,
    enabled: hasOwnGames && !showAllGames,
  })
  const myNextGames = myNextGamesRaw ?? []

  // Latest 5 results (all) — only fetch when user toggled "show all" or has no teams
  const allResultsFilter = useMemo((): Record<string, unknown> => {
    const conditions: Record<string, unknown>[] = [{ status: { _eq: 'completed' } }, { date: { _nnull: true } }, { away_team: { _nnull: true } }, { season: { _eq: effGameSeason } }]
    if (sportFilter) conditions.push(sportFilter)
    return { _and: conditions }
  }, [sportFilter, effGameSeason])
  const { data: allLatestResultsRaw, isLoading: resultsLoading } = useCollection<ExpandedGame>('games', {
    filter: allResultsFilter,
    fields: ['*', 'kscw_team.*', 'kscw_team.coach.members_id', 'kscw_team.team_responsible.members_id', 'hall.*'],
    sort: ['-date', '-time'],
    limit: 5,
    enabled: showAllResults || !hasOwnGames,
  })
  const allLatestResults = allLatestResultsRaw ?? []

  // Latest 5 results (my teams only)
  const myResultsFilter = useMemo((): Record<string, unknown> => {
    const conditions: Record<string, unknown>[] = [{ status: { _eq: 'completed' } }, { date: { _nnull: true } }, { away_team: { _nnull: true } }, { season: { _eq: effGameSeason } }]
    if (teamGameFilter) conditions.push(teamGameFilter)
    if (sportFilter) conditions.push(sportFilter)
    return { _and: conditions }
  }, [teamGameFilter, sportFilter, effGameSeason])
  const { data: myLatestResultsRaw } = useCollection<ExpandedGame>('games', {
    filter: myResultsFilter,
    fields: ['*', 'kscw_team.*', 'kscw_team.coach.members_id', 'kscw_team.team_responsible.members_id', 'hall.*'],
    sort: ['-date', '-time'],
    limit: 5,
    enabled: hasOwnGames && !showAllResults,
  })
  const myLatestResults = myLatestResultsRaw ?? []

  // Next trainings for user's teams
  const trainingFilter = useMemo((): Record<string, unknown> | string => {
    if (!hasTeams) return ''
    const conditions: Record<string, unknown>[] = [
      { team: { _in: userTeamIds } },
      { date: { _gte: today } },
      { cancelled: { _eq: false } },
    ]
    if (sport === 'vb') conditions.push({ team: { sport: { _eq: 'volleyball' } } })
    else if (sport === 'bb') conditions.push({ team: { sport: { _eq: 'basketball' } } })
    return { _and: conditions }
  }, [userTeamIds, hasTeams, today, sport])

  const { data: nextTrainingsRaw, isLoading: trainingsLoading } = useCollection<TrainingExpanded>('trainings', {
    filter: trainingFilter as Record<string, unknown> | undefined,
    fields: ['*', 'team.*', 'team.coach.members_id', 'team.team_responsible.members_id', 'hall.*', 'coach.*'],
    sort: ['date', 'start_time'],
    limit: 10,
    enabled: hasTeams,
  })
  const nextTrainings = nextTrainingsRaw ?? []

  // Decide which games/results to show
  const nextGames = hasOwnGames && !showAllGames ? myNextGames : allNextGames
  const latestResults = hasOwnGames && !showAllResults ? myLatestResults : allLatestResults

  // Upcoming events — scope to user's teams + club-wide events.
  // Resolve event IDs via the events_teams junction (single-level filter) rather
  // than walking `events.teams.teams_id` — that path conflicts with the policy's
  // own walk through the same alias and silently returns [] for non-admins.
  // See [feedback_directus_m2m_double_walk] in CLAUDE.md.
  const { teamEventIds, isLoading: eventIdsLoading } = useUserVisibleEventIds(
    userTeamIds,
    undefined,
    hasTeams,
  )
  const eventFilter = useMemo((): Record<string, unknown> => {
    const conditions: Record<string, unknown>[] = [{ end_date: { _gte: today } }]
    if (hasTeams) {
      conditions.push({
        _or: [
          { teams: { _null: true } },
          { id: { _in: teamEventIds.length > 0 ? teamEventIds : [-1] } },
        ],
      })
    } else {
      // User has no teams yet — show only club-wide events
      conditions.push({ teams: { _null: true } })
    }
    return { _and: conditions }
  }, [today, hasTeams, teamEventIds])

  const { data: eventsRaw, isLoading: eventsLoading } = useCollection<EventExpanded>('events', {
    filter: eventFilter,
    fields: ['*', 'teams.teams_id.*', 'teams.teams_id.coach.members_id', 'teams.teams_id.team_responsible.members_id'],
    sort: ['start_date'],
    limit: 10,
    enabled: !eventIdsLoading,
  })
  const events = eventsRaw ?? []

  // Duty games the member is assigned to — surfaced as virtual "duty" appointments
  // (and the yellow banner). NOT sport-filtered: a duty is a personal obligation,
  // so it always shows regardless of the sport toggle.
  const { duties: dutyAppointments } = useMyDuties()

  // Rankings for user's teams — fetch team details for SV/BB IDs, then rankings
  const { data: userTeamDetailsRaw } = useCollection<Team>('teams', {
    filter: hasTeams ? { id: { _in: userTeamIds } } : undefined,
    fields: ['id', 'team_id'],
    enabled: hasTeams,
  })
  const userSvTeamIds = useMemo(() => {
    return (userTeamDetailsRaw ?? []).map(t => t.team_id).filter(Boolean)
  }, [userTeamDetailsRaw])

  // Step 1: fetch only the user's own ranking rows to discover their league names
  const { data: userRankingRowsRaw } = useCollection<Ranking>('rankings', {
    filter: hasTeams && userSvTeamIds.length > 0
      ? { _and: [{ team_id: { _in: userSvTeamIds } }, { season: { _eq: selectedHomeSeason } }] }
      : undefined,
    fields: ['id', 'league', 'team_id'],
    enabled: hasTeams && userSvTeamIds.length > 0,
    all: true,
  })
  const userLeagueNames = useMemo(() => {
    const names = new Set<string>()
    for (const r of userRankingRowsRaw ?? []) {
      if (!/^Group \d+$|Cup|Turnier|Pokal|Final|Runde \d|Spiel \d|Tour \d/i.test(r.league)) {
        names.add(r.league)
      }
    }
    return [...names]
  }, [userRankingRowsRaw])

  // Step 2: fetch full league tables only for the user's leagues
  const { data: leagueRankingsRaw } = useCollection<Ranking>('rankings', {
    filter: userLeagueNames.length > 0
      ? { _and: [{ league: { _in: userLeagueNames } }, { season: { _eq: selectedHomeSeason } }] }
      : undefined,
    sort: ['league', 'rank'],
    fields: ['id', 'league', 'rank', 'team_id', 'team_name', 'points', 'won', 'lost', 'wins_clear', 'wins_narrow', 'defeats_clear', 'defeats_narrow', 'sets_won', 'sets_lost', 'points_won', 'points_lost', 'played', 'season'],
    enabled: userLeagueNames.length > 0,
    all: true,
  })

  const userLeagueGroups = useMemo(() => {
    const grouped = new Map<string, Ranking[]>()
    for (const r of leagueRankingsRaw ?? []) {
      const existing = grouped.get(r.league) ?? []
      existing.push(r)
      grouped.set(r.league, existing)
    }
    return grouped
  }, [leagueRankingsRaw])

  // Bulk-fetch participation statuses for all displayed activities (2 queries total
  // instead of 2 per row) so banners appear together with everything else.
  // Gate on all sub-queries being done so the participation fetch fires once with
  // the complete activity list — prevents partial results overwriting full results.
  const allDataLoaded = !gamesLoading && !resultsLoading && !eventsLoading && !(hasTeams && trainingsLoading)
  const allActivities = useMemo(() => {
    if (!allDataLoaded) return []
    const items: Array<{ id: string; type: 'game' | 'training' | 'event'; date: string }> = []
    for (const g of nextGames) items.push({ id: g.id, type: 'game', date: g.date })
    for (const g of latestResults) items.push({ id: g.id, type: 'game', date: g.date })
    for (const tr of nextTrainings) items.push({ id: tr.id, type: 'training', date: tr.date })
    for (const ev of events) items.push({ id: ev.id, type: 'event', date: toZurichDateString(ev.start_date) })
    return items
  }, [allDataLoaded, nextGames, latestResults, nextTrainings, events])

  const { getStatus: getParticipationStatus, isLoading: bulkPartLoading } = useBulkParticipationStatuses(allActivities)

  // All members' RSVP rows for the visible activities in one query, so the
  // counter bricks paint together with the rest of the page instead of
  // popping in one-by-one after reveal.
  const { getParticipations, isLoading: bulkRsvpLoading } = useBulkParticipations(allActivities)

  // Combined loading: wait for all primary data + participation statuses + RSVP counters
  // For logged-in users, we need member_teams + all dependent queries + participation statuses
  // For guests, just the public queries (games, results, events)
  //
  // ⚠ `eventIdsLoading` is load-bearing and easy to leave out: the events query
  // is gated `enabled: !eventIdsLoading`, so while the visible-event IDs are
  // still resolving the events query has not STARTED and `eventsLoading` is
  // false. Omitting it let the whole page reveal with the events section still
  // empty, which then popped in a moment later — the gate has to cover the
  // query that gates the query.
  //
  // `memberTeamsLoading` also feeds the ticker's team scope, so revealing before
  // it lands showed a ticker that then re-scoped itself.
  const isInitialLoading = memberTeamsLoading || gamesLoading
    || resultsLoading || eventIdsLoading || eventsLoading || (hasTeams && trainingsLoading)
    || bulkPartLoading || bulkRsvpLoading

  // Report loading to the app-level boot gate (Layout) instead of rendering our
  // own spinner. While true, Layout's single fullscreen spinner masks the chrome
  // + this content, so everything reveals together. See usePageReady.tsx.
  useReportPageLoading(isInitialLoading)

  return (
    <div className="min-w-0">
      <InstallBanner />
      {isInitialLoading ? null : (<>

      {/* Hero with sport icons flanking logo */}
      <div className="flex flex-col items-center pb-6 pt-2 text-center">
        <div className="flex items-center gap-4">
          {showSportToggle && (
            <button
              onClick={() => setSport('vb')}
              className={`rounded-full p-2 transition-all ${
                sport === 'vb' || sport === 'all'
                  ? 'scale-110'
                  : 'opacity-30 hover:opacity-50'
              }`}
              aria-label="Volleyball"
            >
              <VolleyballIcon className="h-9 w-9 sm:h-10 sm:w-10" filled />
            </button>
          )}
          {showSportToggle ? (
            <button
              onClick={() => setSport('all')}
              className={`rounded-xl p-1 transition-opacity ${sport === 'all' ? '' : 'opacity-60 hover:opacity-80'}`}
              aria-label="Show all sports"
            >
              <img
                src="/wiedisync_logo.svg"
                alt="KSC Wiedikon"
                className="h-20 w-auto sm:h-24"
              />
            </button>
          ) : (
            <img
              src="/wiedisync_logo.svg"
              alt="KSC Wiedikon"
              className="h-20 w-auto sm:h-24"
            />
          )}
          {showSportToggle && (
            <button
              onClick={() => setSport('bb')}
              className={`rounded-full p-2 transition-all ${
                sport === 'bb' || sport === 'all'
                  ? 'scale-110'
                  : 'opacity-30 hover:opacity-50'
              }`}
              aria-label="Basketball"
            >
              <BasketballIcon className="h-9 w-9 sm:h-10 sm:w-10" filled />
            </button>
          )}
        </div>
        <div className="relative mt-3 flex items-center justify-center gap-2">
          <h1 className="text-2xl font-bold text-gray-900 sm:text-3xl dark:text-gray-100">
            KSC Wiedikon
          </h1>
          {/* The getting-started tour declares `route: '/'` (guide/tours/getting-started.ts)
              but this was the one page with no TourPageButton, so the tour a first-time
              user is meant to be offered could never match a page and never appeared.
              It has been written and translated the whole time. */}
          <TourPageButton />
        </div>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {t('subtitle')}
        </p>
      </div>

      {/* Upcoming ticker — next 7 days across the user's own teams, admins
          included: games, trainings, events, closures, duties, birthdays. */}
      {user && isApproved && (tickerTeamIds.length > 0 || memberTeamsLoading) && (
        <UpcomingTicker teamIds={tickerTeamIds} scopeLoading={memberTeamsLoading} />
      )}

      {/* Pending duty-delegation requests — accept/decline without leaving home.
          Renders null when the user has no incoming requests. */}
      {user && isApproved && <HomeDelegationCard />}

      {/* Upcoming duty reminder (1 week → game end) + 60' emergency button.
          Renders null when the member has no upcoming duties. */}
      {user && isApproved && <MyDutyBanner />}

      {/* Spielplanung absences reminder — volleyball players, until 2026-06-01 */}
      {user && isApproved && (primarySport === 'volleyball' || primarySport === 'both') && beforeAbsencesDeadline && (
        <div className="mb-6 lg:flex lg:flex-col lg:items-center">
          <div className="w-full rounded-xl border border-amber-300 bg-amber-50 p-4 lg:max-w-2xl dark:border-amber-700/60 dark:bg-amber-900/20">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-100">
                  {t('absencesAlertTitle')}
                </h3>
                <p className="mt-1 text-sm text-amber-800 dark:text-amber-200/90">
                  {t('absencesAlertBody')}
                </p>
                <Link
                  to="/absences"
                  className="mt-2 inline-flex min-h-[36px] items-center rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 dark:bg-amber-500 dark:hover:bg-amber-400 dark:text-amber-950"
                >
                  {t('absencesAlertCta')}
                </Link>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* IBAN nudge — finance needs everyone's up-to-date IBAN for reimbursements */}
      {user && isApproved && (!user.iban || user.iban_confirmed === false) && !ibanNudgeDismissed && (
        <div className="mb-6 lg:flex lg:flex-col lg:items-center">
          <div className="w-full rounded-xl border border-amber-300 bg-amber-50 p-4 lg:max-w-2xl dark:border-amber-700/60 dark:bg-amber-900/20">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-100">
                  {user.iban ? t('ibanConfirmNudgeTitle') : t('ibanNudgeTitle')}
                </h3>
                <p className="mt-1 text-sm text-amber-800 dark:text-amber-200/90">
                  {user.iban ? t('ibanConfirmNudgeBody') : t('ibanNudgeBody')}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Link
                    to="/finance/dues"
                    className="inline-flex min-h-[36px] items-center rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 dark:bg-amber-500 dark:hover:bg-amber-400 dark:text-amber-950"
                  >
                    {user.iban ? t('ibanConfirmNudgeCta') : t('ibanNudgeCta')}
                  </Link>
                  <button
                    type="button"
                    onClick={dismissIbanNudge}
                    className="inline-flex min-h-[36px] items-center rounded-md px-3 py-1.5 text-sm font-medium text-amber-700 hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-900/40"
                  >
                    {t('ibanNudgeDismiss')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* News section — unified feed: open bill + announcements + notifications */}
      {user && isApproved && (feedItems.length > 0 || duesNews) && (
        <div className="mb-6 lg:flex lg:flex-col lg:items-center">
          <SectionHeader
            title={tn('news')}
            linkTo="/news"
            linkLabel={tn('showAll')}
          />
          <div className="w-full overflow-hidden rounded-xl border border-gray-200 bg-white lg:max-w-2xl dark:border-gray-700 dark:bg-gray-800">
            {duesNews && <DuesNewsRow news={duesNews} />}
            {feedItems.map((item) =>
              item.kind === 'announcement' ? (
                <AnnouncementRow
                  key={item.id}
                  announcement={item.record}
                  onClick={() => setSelectedAnnouncement(item.record)}
                />
              ) : (
                <NewsRow key={item.id} notification={item.record} onMarkAsRead={markAsRead} />
              ),
            )}
          </div>
        </div>
      )}

      {selectedAnnouncement && (
        <AnnouncementDetailModal
          announcement={selectedAnnouncement}
          onClose={() => setSelectedAnnouncement(null)}
        />
      )}

      {/* Active surveys — placed right under the news feed so polls (which
          otherwise live only on the team page) are easy to find. Renders null
          when the user's teams have no open polls. */}
      {user && isApproved && hasTeams && (
        <HomePollsCard teamIds={userTeamIds} canManage={canManageTeam} />
      )}

      {/* Forms to fill — surfaced here because the /forms nav item is author-only. */}
      {user && isApproved && fillableForms.length > 0 && (
        <div className="mb-6 lg:flex lg:flex-col lg:items-center">
          <div className="w-full overflow-hidden rounded-xl border border-blue-200 bg-blue-50/60 lg:max-w-2xl dark:border-blue-800/50 dark:bg-blue-900/20">
            <div className="flex items-center gap-2 border-b border-blue-200 px-4 py-2.5 dark:border-blue-800/50">
              <ScrollText className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
              <h2 className="text-sm font-semibold text-blue-900 dark:text-blue-100">{tf('formsToFill')}</h2>
            </div>
            <ul className="divide-y divide-blue-100 dark:divide-blue-800/40">
              {fillableForms.map((item) => (
                <li key={item.form.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{item.form.title}</p>
                    {item.form.closes_at && (
                      <p className="text-xs text-gray-500 dark:text-gray-400">{tf('closesAt')}: {formatDateTimeCompactZurich(item.form.closes_at)}</p>
                    )}
                  </div>
                  <button
                    onClick={() => setFillItem(item)}
                    className="min-h-[36px] shrink-0 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-400 dark:text-blue-950"
                  >
                    {item.submission ? tf('edit') : tf('fill')}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {fillItem && (
        <FormFillModal
          open={!!fillItem}
          form={fillItem.form}
          existing={fillItem.submission}
          onSubmitted={() => { setFillItem(null); refetchForms() }}
          onCancel={() => setFillItem(null)}
        />
      )}

      {/* Your dues — member's open invoices (renders null when nothing is open) */}
      {user && isApproved && <YourDuesCard />}

      {/* Open fines — own + the team fines the Teamkasse owes (null when clean) */}
      {user && isApproved && <YourFinesCard />}

      {/* View toggle: unified appointments vs categorized sections */}
      {user && isApproved && (
        <div className="mb-4 flex justify-end lg:justify-center">
          <button
            onClick={() => setShowCategorized((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-gray-600 transition-colors hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
          >
            {showCategorized ? (
              <><List className="h-4 w-4" />{t('showAppointments')}</>
            ) : (
              <><LayoutGrid className="h-4 w-4" />{t('showCategories')}</>
            )}
          </button>
        </div>
      )}

      {/* Unified "My next appointments" view (default for logged-in users) */}
      {user && isApproved && !showCategorized && (
        <div className="lg:flex lg:items-start lg:justify-center lg:gap-8">
          <div data-tour="dashboard-appointments">
            <NextAppointments
              games={nextGames}
              trainings={nextTrainings}
              events={events}
              duties={dutyAppointments}
              onGameClick={setSelectedGame}
              onTrainingClick={setSelectedTraining}
              onEventClick={setSelectedEvent}
              getParticipationStatus={getParticipationStatus}
              getParticipations={getParticipations}
            />
          </div>
          {hasTeams && userSvTeamIds.length > 0 && (userLeagueGroups.size > 0 || homeRankSeason !== null) && (
            <div className="hidden min-w-0 lg:block">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('rankings')}</h2>
                <Select value={selectedHomeSeason} onValueChange={setHomeRankSeason}>
                  <SelectTrigger className="h-9 w-[140px]" aria-label={tg('season')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {homeRankSeasonOptions.map((s) => (
                      <SelectItem key={s} value={s}>{formatSeasonLong(s)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {userLeagueGroups.size > 0 ? (
                <div className="space-y-4">
                  {[...userLeagueGroups.entries()].map(([league, rows]) => (
                    <RankingsTable key={league} league={league} rankings={rows} compact />
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-gray-300 px-6 py-10 text-center dark:border-gray-700">
                  <Trophy className="mx-auto mb-3 h-8 w-8 text-gray-300 dark:text-gray-600" />
                  <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{formatSeasonLong(selectedHomeSeason)}</p>
                  <p className="mx-auto mt-1 max-w-xs text-sm text-gray-500 dark:text-gray-400">{tg('rankingsUpcoming')}</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Categorized view: trainings, events, games in columns */}
      {/* Default for guests, toggle for logged-in users */}
      {showCategorized && (
        <HomeSections
          trainingsSection={hasTeams && nextTrainings.length > 0 ? (
            <div className="min-w-0">
              <SectionHeader title={t('nextTrainings')} linkTo="/trainings" linkLabel={t('allTrainings')} />
              <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
                {nextTrainings.map((tr) => (
                  <CompactTrainingRow key={tr.id} training={tr} onClick={() => setSelectedTraining(tr)} participationStatus={getParticipationStatus('training', tr.id)} participations={getParticipations('training', tr.id)} />
                ))}
              </div>
            </div>
          ) : null}
          trainingsDate={nextTrainings[0]?.date}
          eventsSection={(events.length > 0 || dutyAppointments.length > 0) ? (
            <div className="min-w-0">
              <SectionHeader title={t('events')} linkTo="/events" linkLabel={t('allEvents')} />
              <div className="space-y-3">
                {dutyAppointments.map((d) => (
                  <DutyEventCard key={`duty-${d.game.id}-${d.role}`} duty={d} />
                ))}
                {events.map((event) => (
                  <EventRow key={event.id} event={event} onClick={() => setSelectedEvent(event)} participationStatus={getParticipationStatus('event', event.id)} participations={getParticipations('event', event.id)} />
                ))}
              </div>
            </div>
          ) : null}
          eventsDate={events[0]?.start_date?.split(' ')[0] ?? dutyAppointments[0]?.game.date}
          gamesSection={
            <div className="min-w-0 space-y-6">
              {latestResults.length > 0 && (
                <div>
                  <SectionHeader
                    title={t('latestResults')}
                    linkTo="/games"
                    linkLabel={t('allResults')}
                    filterToggle={hasOwnGames ? {
                      active: !showAllResults,
                      label: t('myTeams'),
                      onToggle: () => setShowAllResults((v) => !v),
                    } : undefined}
                  />
                  <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
                    {latestResults.map((g) => (
                      <CompactGameRow key={g.id} game={g} showScore onClick={() => setSelectedGame(g)} participationStatus={getParticipationStatus('game', g.id)} participations={getParticipations('game', g.id)} />
                    ))}
                  </div>
                </div>
              )}
              {/* When trainings column is present, keep next games stacked here */}
              {hasOwnGames && nextGames.length > 0 && (
                <div>
                  <SectionHeader
                    title={t('nextGames')}
                    linkTo="/games"
                    linkLabel={t('allGames')}
                    filterToggle={{
                      active: !showAllGames,
                      label: t('myTeams'),
                      onToggle: () => setShowAllGames((v) => !v),
                    }}
                  />
                  <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
                    {nextGames.map((g) => (
                      <CompactGameRow key={g.id} game={g} showScore={false} onClick={() => setSelectedGame(g)} participationStatus={getParticipationStatus('game', g.id)} participations={getParticipations('game', g.id)} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          }
          gamesDate={latestResults[0]?.date ?? nextGames[0]?.date}
          nextGamesSection={!hasOwnGames && nextGames.length > 0 ? (
            <div className="min-w-0">
              <SectionHeader title={t('nextGames')} linkTo="/games" linkLabel={t('allGames')} />
              <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
                {nextGames.map((g) => (
                  <CompactGameRow key={g.id} game={g} showScore={false} onClick={() => setSelectedGame(g)} participationStatus={getParticipationStatus('game', g.id)} participations={getParticipations('game', g.id)} />
                ))}
              </div>
            </div>
          ) : undefined}
          nextGamesDate={!hasOwnGames ? nextGames[0]?.date : undefined}
        />
      )}

      <GameDetailModal
        game={selectedGame}
        onClose={() => setSelectedGame(null)}
        participations={selectedGame ? getParticipations('game', selectedGame.id) : undefined}
      />
      <TrainingDetailModal training={selectedTraining} onClose={() => setSelectedTraining(null)} />
      <EventDetailModal event={selectedEvent} onClose={() => setSelectedEvent(null)} />

      {notifPanelOpen && (
        <NotificationPanel
          notifications={allNotifs}
          unreadCount={unreadCount}
          onMarkAsRead={markAsRead}
          onMarkAllAsRead={markAllAsRead}
          onDelete={deleteNotification}
          onClearRead={clearAllRead}
          onClose={() => setNotifPanelOpen(false)}
        />
      )}
      </>)}
    </div>
  )
}

/* ---------- Sub-components ---------- */

function SectionHeader({
  title,
  linkTo,
  linkLabel,
  filterToggle,
  onLinkClick,
}: {
  title: string
  linkTo: string
  linkLabel: string
  filterToggle?: { active: boolean; label: string; onToggle: () => void }
  onLinkClick?: (e: React.MouseEvent) => void
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <h2 className="truncate text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
        {filterToggle && (
          <button
            onClick={filterToggle.onToggle}
            className={`min-h-[36px] rounded-full px-2.5 py-1.5 text-xs font-medium transition-colors ${
              filterToggle.active
                ? 'bg-brand-100 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300'
                : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
            }`}
          >
            {filterToggle.active ? filterToggle.label : filterToggle.label}
          </button>
        )}
      </div>
      <Link
        to={linkTo}
        onClick={onLinkClick}
        className="shrink-0 whitespace-nowrap text-sm font-medium text-brand-600 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300"
      >
        {linkLabel} →
      </Link>
    </div>
  )
}

const newsTypeIcons: Record<string, React.ReactNode> = {
  activity_change: <ClipboardList className="h-4 w-4" />,
  upcoming_activity: <Clock className="h-4 w-4" />,
  deadline_reminder: <AlertTriangle className="h-4 w-4" />,
  result_available: <Trophy className="h-4 w-4" />,
}

function getNotificationPath(n: Notification): string {
  if (n.type === 'duty_delegation_request' || n.activity_type === 'scorer_duty') return '/scorer'
  switch (n.activity_type) {
    case 'game': return '/games'
    case 'training': return '/trainings'
    case 'event': return '/events'
    default: return '/'
  }
}

function NewsRow({ notification, onMarkAsRead }: { notification: Notification; onMarkAsRead: (id: string) => void }) {
  const { t } = useTranslation('notifications')
  const navigate = useNavigate()
  const message = (() => {
    try {
      const data = notification.body ? JSON.parse(notification.body) : {}
      const raw = String(t(notification.title, data))
      // Strip trailing " @ " when hall is empty, and strip :SS seconds from legacy times
      return raw.replace(/\s*@\s*$/, '').replace(/(\d{2}:\d{2}):\d{2}/g, '$1')
    } catch {
      // Legacy notifications with plain text body
      return notification.title.replace(/(\d{2}:\d{2}):\d{2}/g, '$1')
    }
  })()

  // Ticking clock (1 min) instead of a render-time Date.now(): the label now
  // ages on its own ("Just now" → "2 minutes ago") rather than only when the
  // feed happens to re-render for some other reason.
  const now = useNow()
  const timeAgo = (() => {
    const diff = now - new Date(notification.created ?? notification.date_created ?? '').getTime()
    const minutes = Math.floor(diff / 60000)
    if (minutes < 1) return String(t('justNow'))
    if (minutes < 60) return String(t('minutesAgo', { count: minutes }))
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return String(t('hoursAgo', { count: hours }))
    const days = Math.floor(hours / 24)
    return String(t('daysAgo', { count: days }))
  })()

  return (
    <div
      className="flex cursor-pointer items-center gap-3 border-b border-gray-100 px-4 py-2.5 last:border-b-0 hover:bg-gray-50 active:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-700/50 dark:active:bg-gray-700"
      onClick={() => {
        if (!notification.read) onMarkAsRead(notification.id)
        navigate(getNotificationPath(notification))
      }}
    >
      <span className="shrink-0 text-gray-500 dark:text-gray-400">{newsTypeIcons[notification.type] ?? <Bell className="h-4 w-4" />}</span>
      <p className="min-w-0 flex-1 truncate text-sm text-gray-900 dark:text-gray-100">{message}</p>
      <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">{timeAgo}</span>
    </div>
  )
}

function CompactGameRow({ game, showScore, onClick, participationStatus, participations }: { game: ExpandedGame; showScore: boolean; onClick?: () => void; participationStatus?: string; participations?: Participation[] }) {
  const { user } = useAuth()
  const dateStr = game.date ? formatDateCompact(game.date) : ''
  const homeWon = Number(game.home_score) > Number(game.away_score)
  const awayWon = Number(game.away_score) > Number(game.home_score)
  const kscwWon = game.type === 'home' ? homeWon : awayWon
  const kscwLost = game.type === 'home' ? awayWon : homeWon

  const effectiveStatus = participationStatus

  const statusBorderColor: Record<string, string> = {
    confirmed: 'bg-green-500 dark:bg-green-400',
    tentative: 'bg-yellow-500 dark:bg-yellow-400',
    declined: 'bg-red-500 dark:bg-red-400',
    waitlisted: 'bg-orange-500 dark:bg-orange-400',
    absent: 'bg-gray-400 dark:bg-gray-500',
  }

  return (
    <div
      className="flex cursor-pointer items-stretch border-b border-gray-100 last:border-b-0 hover:bg-gray-50 active:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-700/50 dark:active:bg-gray-700"
      onClick={onClick}
    >
      {/* Participation status vertical banner — always render to avoid React removeChild errors */}
      {user && effectiveStatus ? (
        <div className={`w-1 shrink-0 ${statusBorderColor[effectiveStatus] ?? ''}`} />
      ) : (
        <div className="w-1 shrink-0" />
      )}

      <div className="min-w-0 flex-1 px-4 py-2">
        <div className="flex items-center gap-3">
          {/* Date & time */}
          <div className="w-14 shrink-0 text-xs text-gray-500 dark:text-gray-400">
            <div>{dateStr}</div>
            {game.time && <div>{formatTime(game.time)}</div>}
          </div>

          {/* Sport icon */}
          {asObj<Team & BaseRecord>(game.kscw_team)?.sport === 'basketball' || game.source === 'basketplan'
            ? <BasketballIcon className="h-5 w-5 shrink-0" filled />
            : <VolleyballIcon className="h-5 w-5 shrink-0" filled />}

          {/* Team names — stacked, Wiedikon team bold, wrap on small screens */}
          <div className="min-w-0 flex-1">
            <p className={`break-words text-sm leading-tight text-gray-900 dark:text-gray-100 ${game.type === 'home' ? 'font-bold' : ''}`}>
              {game.home_team}
            </p>
            <p className={`break-words text-sm leading-tight text-gray-900 dark:text-gray-100 ${game.type === 'away' ? 'font-bold' : ''}`}>
              {game.away_team}
            </p>
          </div>

          {/* Vertical score: KSCW line colored, opponent neutral */}
          {showScore && game.status === 'completed' && (
            <div className="shrink-0 text-right font-mono text-sm leading-snug">
              <div className={`${game.type === 'home' ? (kscwWon ? 'text-green-600 dark:text-green-400' : kscwLost ? 'text-red-500' : 'text-gray-500') : 'text-gray-500 dark:text-gray-400'} ${game.type === 'home' ? 'font-bold' : 'font-medium'}`}>
                {game.home_score}
              </div>
              <div className={`${game.type === 'away' ? (kscwWon ? 'text-green-600 dark:text-green-400' : kscwLost ? 'text-red-500' : 'text-gray-500') : 'text-gray-500 dark:text-gray-400'} ${game.type === 'away' ? 'font-bold' : 'font-medium'}`}>
                {game.away_score}
              </div>
            </div>
          )}
        </div>

        {/* Participation bars — own row beneath info */}
        {game.status === 'scheduled' && (
          <div className="mt-1.5 pl-[calc(3.5rem+0.75rem)]">
            <ParticipationSummary activityType="game" activityId={game.id} bars coachMemberIds={teamCoachIds(asObj<Team>(game.kscw_team))} participations={participations} />
          </div>
        )}
      </div>
    </div>
  )
}

function CompactTrainingRow({ training, onClick, participationStatus, participations }: { training: TrainingExpanded; onClick?: () => void; participationStatus?: string; participations?: Participation[] }) {
  const { user } = useAuth()
  const team = asObj<Team>(training.team)
  const hall = asObj<Hall>(training.hall)
  const dateStr = training.date ? formatDate(training.date) : ''
  const weekday = training.date ? formatWeekday(training.date) : ''

  const effectiveStatus = participationStatus

  const statusBorderColor: Record<string, string> = {
    confirmed: 'bg-green-500 dark:bg-green-400',
    tentative: 'bg-yellow-500 dark:bg-yellow-400',
    declined: 'bg-red-500 dark:bg-red-400',
    waitlisted: 'bg-orange-500 dark:bg-orange-400',
    absent: 'bg-gray-400 dark:bg-gray-500',
  }

  return (
    <div
      className="flex cursor-pointer items-stretch border-b border-gray-100 last:border-b-0 hover:bg-gray-50 active:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-700/50 dark:active:bg-gray-700"
      onClick={onClick}
    >
      {/* Participation status vertical banner — always render to avoid React removeChild errors */}
      {user && effectiveStatus ? (
        <div className={`w-1 shrink-0 ${statusBorderColor[effectiveStatus] ?? ''}`} />
      ) : (
        <div className="w-1 shrink-0" />
      )}

      <div className="min-w-0 flex-1 px-4 py-3">
        <div className="flex items-center gap-3">
          {/* Date & time */}
          <div className="w-24 shrink-0 text-xs text-gray-500 dark:text-gray-400">
            <div>{weekday}, {dateStr}</div>
            <div>{formatTime(training.start_time)} – {formatTime(training.end_time)}</div>
          </div>

          {/* Info */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {team && <TeamChip team={team.name} size="sm" />}
              {hall && <span className="text-sm text-gray-700 dark:text-gray-300">{hall.name}</span>}
            </div>
          </div>
        </div>

        {/* Participation bars — own row beneath info */}
        <div className="mt-1.5 pl-[calc(6rem+0.75rem)]">
          <ParticipationSummary activityType="training" activityId={training.id} bars coachMemberIds={teamCoachIds(team)} participations={participations} />
        </div>
      </div>
    </div>
  )
}


/** Inline cone SVG for training icon */
function TrainingConeIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M16.05 10.966a5 2.5 0 0 1-8.1 0" />
      <path d="m16.923 14.049 4.48 2.04a1 1 0 0 1 .001 1.831l-8.574 3.9a2 2 0 0 1-1.66 0l-8.574-3.91a1 1 0 0 1 0-1.83l4.484-2.04" />
      <path d="M16.949 14.14a5 2.5 0 1 1-9.9 0L10.063 3.5a2 2 0 0 1 3.874 0z" />
      <path d="M9.194 6.57a5 2.5 0 0 0 5.61 0" />
    </svg>
  )
}

/** Game icon: whistle for league play, cup for cup competitions
 *  (gold → trophy, silver → medal), matching the GameChip semantics. */
function gameIcon(game: ExpandedGame, className: string) {
  const cup = detectCupMatch(game.league)
  if (cup === 'gold') return <Trophy className={className} />
  if (cup === 'silver') return <Medal className={className} />
  return <WhistleIcon className={className} />
}

/** Single appointment row with participation banner */
function AppointmentRow({ appointment, onClick, participationStatus, participations }: {
  appointment: { type: 'game' | 'training' | 'event' | 'duty'; date: string; data: ExpandedGame | TrainingExpanded | EventExpanded; label?: string }
  onClick?: () => void
  participationStatus?: string
  participations?: Participation[]
}) {
  const { user } = useAuth()
  const { t: tCal } = useTranslation('calendar')

  const effectiveStatus = participationStatus

  const statusBorderColor: Record<string, string> = {
    confirmed: 'bg-green-500 dark:bg-green-400',
    tentative: 'bg-yellow-500 dark:bg-yellow-400',
    declined: 'bg-red-500 dark:bg-red-400',
    waitlisted: 'bg-orange-500 dark:bg-orange-400',
    absent: 'bg-gray-400 dark:bg-gray-500',
  }

  const bigTypeIcon = {
    game: gameIcon(appointment.data as ExpandedGame, 'h-6 w-6 shrink-0'),
    training: <TrainingConeIcon className="h-6 w-6 shrink-0" />,
    event: <CalendarDays className="h-6 w-6 shrink-0" />,
    duty: <ClipboardList className="h-6 w-6 shrink-0" />,
  }

  const dateStr = formatDateCompact(appointment.date)
  const weekday = formatWeekday(appointment.date)

  let label: string
  let timeStr = ''
  let coachIds: string[] | undefined
  if (appointment.type === 'game') {
    const g = appointment.data as ExpandedGame
    label = `${g.home_team} vs ${g.away_team}`
    if (g.time) timeStr = formatTime(g.time)
    coachIds = teamCoachIds(asObj<Team>(g.kscw_team))
  } else if (appointment.type === 'training') {
    const tr = appointment.data as TrainingExpanded
    const team = asObj<Team>(tr.team)
    const hall = asObj<Hall>(tr.hall)
    label = [team?.name, hall?.name].filter(Boolean).join(' · ')
    if (tr.start_time) timeStr = formatTime(tr.start_time)
    coachIds = teamCoachIds(team)
  } else if (appointment.type === 'duty') {
    const g = appointment.data as ExpandedGame
    label = appointment.label ?? `${g.home_team} vs ${g.away_team}`
    if (g.time) timeStr = formatTime(g.time)
  } else {
    const ev = appointment.data as EventExpanded
    // An event title is free text and says nothing about what KIND of thing it
    // is — a friendly entered as "VBC Limmattal - D4" reads as a league fixture
    // next to the real ones. Lead with the translated type; the cards elsewhere
    // carry it as a StatusBadge, this row has no room for one.
    const typeKey = eventTypeLabelKey(ev.event_type)
    label = typeKey ? `${tCal(typeKey)} · ${ev.title}` : ev.title
    if (!ev.all_day && ev.start_date) timeStr = formatTime(ev.start_date)
  }

  return (
    <div
      className={`cursor-pointer border-b border-gray-100 last:border-b-0 dark:border-gray-700 ${
        appointment.type === 'duty'
          ? 'bg-orange-50 hover:bg-orange-100 dark:bg-orange-500/10 dark:hover:bg-orange-500/20'
          : 'hover:bg-gray-50 active:bg-gray-100 dark:hover:bg-gray-700/50 dark:active:bg-gray-700'
      }`}
      onClick={onClick}
    >
      <div className="flex items-stretch">
        {/* Participation status vertical banner — spans full height including counter row */}
        {user && effectiveStatus ? (
          <div className={`w-1 shrink-0 ${statusBorderColor[effectiveStatus] ?? ''}`} />
        ) : (
          <div className="w-1 shrink-0" />
        )}

        <div className="min-w-0 flex-1">
          {/* Two-row grid: [Date | Label] over [Icon | ParticipationSummary],
              aligned so the right-hand content has a clear gap from the date
              column and icon. */}
          <div
            className="grid items-center"
            style={{ gridTemplateColumns: '4.5rem 1fr', columnGap: '1rem' }}
          >
            <div className="py-2.5 pl-3 text-xs text-gray-500 dark:text-gray-400">
              <div>{weekday}</div>
              <div>{dateStr}</div>
              {timeStr && <div>{timeStr}</div>}
            </div>
            <p className="min-w-0 truncate pr-3 text-sm text-gray-900 dark:text-gray-100">{label}</p>

            <div className="pb-2 pl-3">
              <span className="text-gray-500 dark:text-gray-400">{bigTypeIcon[appointment.type]}</span>
            </div>
            <div className="pb-2 pr-3">
              {appointment.type !== 'duty' && (
                <ParticipationSummary activityType={appointment.type} activityId={appointment.data.id} bars coachMemberIds={coachIds} participations={participations} />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Desktop table row for aligned columns */
function AppointmentTableRow({ appointment, onClick, participationStatus, participations }: {
  appointment: { type: 'game' | 'training' | 'event' | 'duty'; date: string; data: ExpandedGame | TrainingExpanded | EventExpanded; label?: string }
  onClick?: () => void
  participationStatus?: string
  participations?: Participation[]
}) {
  const { user } = useAuth()
  const { t: tCal } = useTranslation('calendar')
  const effectiveStatus = participationStatus

  const statusBorderBg: Record<string, string> = {
    confirmed: 'bg-green-500 dark:bg-green-400',
    tentative: 'bg-yellow-500 dark:bg-yellow-400',
    declined: 'bg-red-500 dark:bg-red-400',
    waitlisted: 'bg-orange-500 dark:bg-orange-400',
    absent: 'bg-gray-400 dark:bg-gray-500',
  }

  const typeIcon = {
    game: gameIcon(appointment.data as ExpandedGame, 'h-4 w-4'),
    training: <TrainingConeIcon className="h-4 w-4" />,
    event: <CalendarDays className="h-4 w-4" />,
    duty: <ClipboardList className="h-4 w-4" />,
  }

  const dateStr = formatDateCompact(appointment.date)
  const weekday = formatWeekday(appointment.date)

  let label: string
  let timeStr = ''
  let coachIds: string[] | undefined
  if (appointment.type === 'game') {
    const g = appointment.data as ExpandedGame
    label = `${g.home_team} vs ${g.away_team}`
    if (g.time) timeStr = formatTime(g.time)
    coachIds = teamCoachIds(asObj<Team>(g.kscw_team))
  } else if (appointment.type === 'training') {
    const tr = appointment.data as TrainingExpanded
    const team = asObj<Team>(tr.team)
    const hall = asObj<Hall>(tr.hall)
    label = [team?.name, hall?.name].filter(Boolean).join(' · ')
    if (tr.start_time) timeStr = formatTime(tr.start_time)
    coachIds = teamCoachIds(team)
  } else if (appointment.type === 'duty') {
    const g = appointment.data as ExpandedGame
    label = appointment.label ?? `${g.home_team} vs ${g.away_team}`
    if (g.time) timeStr = formatTime(g.time)
  } else {
    const ev = appointment.data as EventExpanded
    // An event title is free text and says nothing about what KIND of thing it
    // is — a friendly entered as "VBC Limmattal - D4" reads as a league fixture
    // next to the real ones. Lead with the translated type; the cards elsewhere
    // carry it as a StatusBadge, this row has no room for one.
    const typeKey = eventTypeLabelKey(ev.event_type)
    label = typeKey ? `${tCal(typeKey)} · ${ev.title}` : ev.title
    if (!ev.all_day && ev.start_date) timeStr = formatTime(ev.start_date)
  }

  return (
    <tr
      className={`cursor-pointer border-b border-gray-100 last:border-b-0 dark:border-gray-700 ${
        appointment.type === 'duty'
          ? 'bg-orange-50 hover:bg-orange-100 dark:bg-orange-500/10 dark:hover:bg-orange-500/20'
          : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'
      }`}
      onClick={onClick}
    >
      <td className={`w-1 p-0 ${user && effectiveStatus ? statusBorderBg[effectiveStatus] ?? '' : ''}`} />
      <td className="whitespace-nowrap py-3.5 pl-4 pr-5 text-sm text-gray-500 dark:text-gray-400">
        {weekday}
      </td>
      <td className="whitespace-nowrap py-3.5 pr-5 text-sm text-gray-500 dark:text-gray-400">
        {dateStr}
      </td>
      <td className="whitespace-nowrap py-3.5 pr-5 text-sm text-gray-500 dark:text-gray-400">
        {timeStr || ''}
      </td>
      <td className="py-3.5 pr-2 text-gray-500 dark:text-gray-400">
        {typeIcon[appointment.type]}
      </td>
      <td className="whitespace-nowrap py-3.5 pr-4 text-sm text-gray-900 dark:text-gray-100">
        {label}
      </td>
      <td className="py-3.5 pr-3">
        {appointment.type !== 'duty' && (
          <ParticipationSummary activityType={appointment.type} activityId={appointment.data.id} bars coachMemberIds={coachIds} participations={participations} />
        )}
      </td>
    </tr>
  )
}

/** Unified "My next appointments" — merges games, trainings, events sorted by date, shows next 5 */
function NextAppointments({
  games,
  trainings,
  events,
  duties,
  onGameClick,
  onTrainingClick,
  onEventClick,
  getParticipationStatus,
  getParticipations,
}: {
  games: ExpandedGame[]
  trainings: TrainingExpanded[]
  events: EventExpanded[]
  duties: MyDuty[]
  onGameClick: (g: ExpandedGame) => void
  onTrainingClick: (t: TrainingExpanded) => void
  onEventClick: (e: EventExpanded) => void
  getParticipationStatus: (type: 'game' | 'training' | 'event', id: string) => string | undefined
  getParticipations: (type: 'game' | 'training' | 'event', id: string) => Participation[]
}) {
  const { t } = useTranslation('home')
  const { t: tScorer } = useTranslation('scorer')
  const [visibleCount, setVisibleCount] = useState(10)

  type Appointment = { type: 'game'; date: string; data: ExpandedGame }
    | { type: 'training'; date: string; data: TrainingExpanded }
    | { type: 'event'; date: string; data: EventExpanded }
    | { type: 'duty'; date: string; data: ExpandedGame; label: string }

  const allAppointments = useMemo(() => {
    const items: Appointment[] = []
    for (const g of games) {
      if (g.date) items.push({ type: 'game', date: g.date, data: g })
    }
    for (const tr of trainings) {
      if (tr.date) items.push({ type: 'training', date: tr.date, data: tr })
    }
    for (const ev of events) {
      if (ev.start_date) items.push({ type: 'event', date: toZurichDateString(ev.start_date), data: ev })
    }
    for (const d of duties) {
      const g = d.game as ExpandedGame
      if (g.date) items.push({
        type: 'duty',
        date: g.date,
        data: g,
        label: `${tScorer(DUTY_ROLE_LABEL_KEYS[d.role] ?? 'scorer')} · ${g.home_team} – ${g.away_team}`,
      })
    }
    items.sort((a, b) => a.date.localeCompare(b.date))
    return items
  }, [games, trainings, events, duties, tScorer])

  // Show the first N date-sorted appointments. A duty is date-sorted inline like
  // everything else, but if it falls beyond the cap (further out than every
  // visible game/training/event) it's appended at the bottom so it's never
  // hidden. "Show more" still reveals the remaining non-duty items.
  const visible = allAppointments.slice(0, visibleCount)
  const overflow = allAppointments.slice(visibleCount)
  const overflowDuties = overflow.filter((a) => a.type === 'duty')
  const appointments = [...visible, ...overflowDuties]
  const hasMore = overflow.some((a) => a.type !== 'duty')

  if (appointments.length === 0) return null

  const renderOnClick = (apt: Appointment) => {
    if (apt.type === 'game' || apt.type === 'duty') return () => onGameClick(apt.data as ExpandedGame)
    if (apt.type === 'training') return () => onTrainingClick(apt.data as TrainingExpanded)
    return () => onEventClick(apt.data as EventExpanded)
  }

  return (
    <div className="mb-6 lg:flex lg:flex-col lg:items-center">
      <h2 className="mb-3 text-lg font-semibold text-gray-900 dark:text-gray-100">{t('myNextAppointments')}</h2>

      {/* Desktop: centered table layout with aligned columns */}
      <div className="hidden lg:block">
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
          <table>
            <tbody>
              {appointments.map((apt) => (
                <AppointmentTableRow
                  key={`${apt.type}-${apt.data.id}`}
                  appointment={apt}
                  onClick={renderOnClick(apt)}
                  participationStatus={apt.type === 'duty' ? undefined : getParticipationStatus(apt.type, apt.data.id)}
                  participations={apt.type === 'duty' ? undefined : getParticipations(apt.type, apt.data.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile: list layout */}
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white lg:hidden dark:border-gray-700 dark:bg-gray-800">
        {appointments.map((apt) => (
          <AppointmentRow
            key={`${apt.type}-${apt.data.id}`}
            appointment={apt}
            onClick={renderOnClick(apt)}
            participationStatus={apt.type === 'duty' ? undefined : getParticipationStatus(apt.type, apt.data.id)}
            participations={apt.type === 'duty' ? undefined : getParticipations(apt.type, apt.data.id)}
          />
        ))}
      </div>

      {hasMore && (
        <button
          onClick={() => setVisibleCount((v) => v + 10)}
          className="mt-2 rounded-lg px-6 py-2 text-sm text-gray-500 transition-colors hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
        >
          {t('showMore')}
        </button>
      )}
    </div>
  )
}

/** Renders 3 sections in 1/3 columns on desktop, ordered by closest date on mobile */
function HomeSections({
  trainingsSection,
  trainingsDate,
  eventsSection,
  eventsDate,
  gamesSection,
  gamesDate,
  nextGamesSection,
  nextGamesDate,
}: {
  trainingsSection: React.ReactNode
  trainingsDate?: string
  eventsSection: React.ReactNode
  eventsDate?: string
  gamesSection: React.ReactNode
  gamesDate?: string
  nextGamesSection?: React.ReactNode
  nextGamesDate?: string
}) {
  // Build sections with their earliest date for mobile ordering
  const sections = useMemo(() => {
    const items: { key: string; date: string; node: React.ReactNode }[] = []
    if (trainingsSection) items.push({ key: 'trainings', date: trainingsDate ?? '9999', node: trainingsSection })
    if (eventsSection) items.push({ key: 'events', date: eventsDate ?? '9999', node: eventsSection })
    if (gamesSection) items.push({ key: 'games', date: gamesDate ?? '9999', node: gamesSection })
    if (nextGamesSection) items.push({ key: 'nextGames', date: nextGamesDate ?? '9999', node: nextGamesSection })
    // Sort by closest date for mobile
    items.sort((a, b) => a.date.localeCompare(b.date))
    return items
  }, [trainingsSection, trainingsDate, eventsSection, eventsDate, gamesSection, gamesDate, nextGamesSection, nextGamesDate])

  if (sections.length === 0) return null

  return (
    <>
      {/* Desktop: always 1/3 columns in fixed order */}
      <div className="hidden gap-6 lg:grid lg:grid-cols-3">
        {trainingsSection && <div className="min-w-0">{trainingsSection}</div>}
        {eventsSection && <div className="min-w-0">{eventsSection}</div>}
        {gamesSection && <div className="min-w-0">{gamesSection}</div>}
        {/* When no trainings column, promote next games to fill the empty column */}
        {!trainingsSection && nextGamesSection && <div className="min-w-0">{nextGamesSection}</div>}
      </div>
      {/* Mobile: stacked, ordered by closest upcoming date */}
      <div className="space-y-6 lg:hidden">
        {sections.map((s) => (
          <div key={s.key}>{s.node}</div>
        ))}
      </div>
    </>
  )
}

function EventRow({ event, onClick, participationStatus, participations }: { event: EventExpanded; onClick: () => void; participationStatus?: string; participations?: Participation[] }) {
  const effectiveStatus = participationStatus
  const teams = asTeams(event.teams)

  const statusBorderColor: Record<string, string> = {
    confirmed: 'bg-green-500 dark:bg-green-400',
    tentative: 'bg-yellow-500 dark:bg-yellow-400',
    declined: 'bg-red-500 dark:bg-red-400',
    waitlisted: 'bg-orange-500 dark:bg-orange-400',
  }

  return (
    <button onClick={onClick} className="flex w-full items-stretch overflow-hidden rounded-xl border border-gray-200 bg-white text-left shadow-card transition-shadow hover:shadow-card-hover dark:border-gray-700 dark:bg-gray-800">
      {effectiveStatus ? (
        <div className={`w-1 shrink-0 ${statusBorderColor[effectiveStatus] ?? ''}`} />
      ) : (
        <div className="w-1 shrink-0" />
      )}
      <div className="min-w-0 flex-1 p-3">
        {/* Top row: event type badge */}
        <div className="mb-2 flex items-center justify-between gap-2">
          <StatusBadge status={event.event_type} />
          {effectiveStatus && (
            <ParticipationSummary activityType="event" activityId={event.id} bars hideExtras participations={participations} />
          )}
        </div>

        {/* Content row: date badge + details */}
        <div className="flex items-start gap-2.5">
          {(() => {
            const { isMultiDay, startDay, startMonth, endDay, endMonth } = getEventDateBadgeParts(event.start_date, event.end_date)
            if (!isMultiDay) {
              return (
                <div className="flex h-9 w-9 shrink-0 flex-col items-center justify-center rounded-lg bg-brand-50 dark:bg-brand-900/40">
                  <span className="text-sm font-bold leading-none text-brand-600 dark:text-brand-400">{startDay}</span>
                  <span className="text-[9px] font-medium uppercase text-brand-500 dark:text-brand-400">{startMonth}</span>
                </div>
              )
            }
            return (
              <div className="flex h-9 shrink-0 items-center gap-1 rounded-lg bg-brand-50 px-1.5 dark:bg-brand-900/40">
                <div className="flex flex-col items-center justify-center leading-none">
                  <span className="text-sm font-bold text-brand-600 dark:text-brand-400">{startDay}</span>
                  <span className="text-[9px] font-medium uppercase text-brand-500 dark:text-brand-400">{startMonth}</span>
                </div>
                <span className="text-xs font-medium text-brand-500 dark:text-brand-400">–</span>
                <div className="flex flex-col items-center justify-center leading-none">
                  <span className="text-sm font-bold text-brand-600 dark:text-brand-400">{endDay}</span>
                  <span className="text-[9px] font-medium uppercase text-brand-500 dark:text-brand-400">{endMonth}</span>
                </div>
              </div>
            )
          })()}

          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium leading-snug text-gray-900 dark:text-gray-100">
              {event.title}
            </p>
            {event.location && (
              <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{event.location}</p>
            )}
            {event.description && (
              <p className="mt-1 line-clamp-2 text-xs text-gray-500 dark:text-gray-400">
                {stripHtml(event.description)}
              </p>
            )}
            {teams.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {teams.map((team) => (
                  <TeamChip key={team.id} team={team.name} size="sm" />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </button>
  )
}
