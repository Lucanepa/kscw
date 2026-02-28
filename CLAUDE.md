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
- **2026-02-28** — Calendar: home/away color differentiation (brand/amber). Away hall sync now includes street number + plus_code for Google Maps links. "+N" overflow in month view opens day popup modal. Added mobile-first rule to CLAUDE.md.
- **2026-02-28** — Added `away_hall_json` (JSON field) to games collection for away venue data without DB records. Updated GameCard + GameDetailModal to show venue for both home/away games. Widened detail modal labels (`w-28`), increased team name font. Added PocketBase Admin API rules to CLAUDE.md. Replaced theme/language toggles with icon-based SwitchToggle (flags). Vite dev port → 1234.
