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
- **2026-02-28** — Hallenplan virtual slots: games (home+away), trainings, and GCal hall events now appear as virtual slots in the Hallenplan grid. Dashed border + auto icon for visual differentiation. Away games show striped pattern. VirtualSlotDetailModal for read-only details. GCal "Halle HW" integration (hall_events collection, gcal_sync hooks, cyan filter chip). iCal subscribe/export modal with preset + team filters.
- **2026-02-28** — Calendar: home/away color differentiation (brand/amber). Away hall sync, "+N" overflow modal. `away_hall_json` for away venues. Icon-based toggles. Vite dev port → 1234.
