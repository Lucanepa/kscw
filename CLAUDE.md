# KSCW Project

## Infrastructure
All infrastructure details (IPs, URLs, ports, credentials, deploy commands) are in **INFRA.md**. Always consult it before making infrastructure-related changes or when you need connection details.

## Tech Stack
- Frontend: React 19 + TypeScript + Vite + TailwindCSS
- Backend: PocketBase (SQLite, REST API, Realtime, Auth)
- Hosting: Cloudflare Pages (frontend), Synology NAS + Cloudflare Tunnel (backend)
- Language: German UI (Swiss German context), code in English

## Key Patterns
- **Mobile-first**: All UI must be designed mobile-first — responsive layout, touch-friendly targets (min 44px), and tested on small screens before desktop
- **Hallenplan virtual slots**: Games, trainings, and GCal hall events are converted to `HallSlot`-shaped objects at display time (via `_virtual` metadata field) and merged with real `hall_slots`. They're never stored in the DB. See `INFRA.md → Hallenplan Virtual Slots` for the full mapping table.
- PocketBase hooks use isolated scopes — shared code must use `require(__hooks + "/file.js")` with `module.exports`
- `pb_hooks/` is gitignored (contains API keys) — deployed separately via SSH/rsync
- `.env` is gitignored — Cloudflare Pages env vars handle production config

## PocketBase Admin API

- **Adding columns/fields and creating records**: Can be done automatically via the API (no confirmation needed)
- **Deleting columns, collections, or records**: Must be confirmed with the user first, but can be executed by the agent

## Branches
- `main` → production (`kscw.lucanepa.com`)
- `dev` → preview (`dev-kscw.lucanepa.com`)

## Session Workflow

1. **Start of every chat**: Read `CLAUDE.md` and `INFRA.md` to get full project context before doing anything.
2. **End of every chat**: After finishing changes, append a few context lines to the **Changelog** section below summarizing what was done (date, short description). If entries get stale or redundant, overwrite with newer comments — keep it concise.

## Changelog
<!-- Newest entries on top. Overwrite old entries when they become redundant. -->
- **2026-02-28** — Role system simplification: moved team leadership roles (coach, assistant, captain, team_responsible) from `member_teams.role` to multi-relation fields on `teams`. Renamed `members.role` default from `player` to `user`. Removed `role` field from `member_teams` (now pure membership junction). Rewrote `useAuth.tsx` coach detection to query `teams` fields. Updated RosterEditor with chip-based leadership assignment UI. Updated MemberRow, TrainingForm, StatusBadge, SignUpPage.
- **2026-02-28** — Schreibereinsätze integration: added `scorer_licence` to members, 6 relation fields to games (`scorer_member`, `taefeler_member`, `scorer_taefeler_member`, `*_duty_team`), `scorer_edit_log` collection. Migrated 34 member licences + 77 game assignments from standalone app. Rewrote scorer module: relation-based AssignmentEditor, combined mode (Schreiber/Schiri), team overview tab, past games section, iCal export, audit logging. Updated GameDetailModal.
- **2026-02-28** — Members/Teams schema expansion: added `birthdate`, `yob` to members; `team_picture`, `social_url`, `sponsors`, `sponsors_logos` to teams. Migrated 39 players (H3+D2) from Supabase `wiedikon_data` with photos. Updated TeamDetail (banner, social link, sponsors section), PlayerProfile (age display), TeamCard (background image). MinIO S3 storage setup documented in INFRA.md.
- **2026-02-28** — HomePage: new public landing page at `/` with club logo, upcoming events (left), next 5 games + latest 5 results (right). CalendarPage moved to `/calendar`. Nav updated with Home + Calendar as separate entries in sidebar and bottom tab bar.
- **2026-02-28** — DB relations cleanup: added `hall` relation (multi) to `hall_events`, `hall` to `events`, `team` to `sv_rankings`. Deleted unused `users` collection. Updated GCal sync hook to auto-resolve hall IDs from title/location. Backfilled all 123 existing hall_events. Updated INFRA.md with full schema diagram.
- **2026-02-28** — Hallenplan virtual slots: games (home+away), trainings, and GCal hall events as virtual slots. VirtualSlotDetailModal, iCal modal. GCal sync hooks.
- **2026-02-28** — Member signup & approval system: two-branch signup (email check → claim existing account via password reset OR new registration with team selection + approval). `approved` + `requested_team` fields on members. PendingPage, AuthRoute gates on approval, coach/admin approval UI in TeamDetail. PB hook `signup_check.pb.js` for email existence check.
- **2026-02-28** — Calendar: home/away colors, away hall sync, `away_hall_json`, icon toggles, Vite dev port 1234.
