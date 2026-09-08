# KSCW Project

## Infrastructure
All infra details (IPs, URLs, ports, credentials, deploy commands) live in **INFRA.md**. Consult it before infra-related changes.

## Tech Stack
- Frontend: React 19 + TypeScript + Vite + TailwindCSS v4 + shadcn/ui
- UI: shadcn primitives in `src/components/ui/` (lowercase), KSCW wrappers in `src/components/` (PascalCase)
- Backend: Directus 11 (Postgres, REST, Realtime, Auth) on Hetzner VPS — plain Docker, not Coolify
- Hosting: Cloudflare Pages (frontend), Hetzner + CF Tunnel (backend)
- Language: **English-first**, multilingual UI (DE / EN / FR / GSW / IT). Locale defaults to browser language; unrecognised browsers fall back to English. Write new i18n strings in English first, then translate to DE at minimum. Code identifiers in English.

## Data Format: TOON
Use `encode()` from `@toon-format/toon` when passing uniform object arrays to LLM prompts (~40% token savings vs JSON). Not for deeply nested/non-uniform data — use JSON-compact there. Syntax: `key: value`, `tags[3]: a,b,c`, `users[2]{id,name}:\n  1,Alice\n  2,Bob`. YAML-style indentation, quote strings with commas/spaces.

## Work Style
- **Parallel subagents**: Dispatch independent work (edits, research, checks) as parallel subagents, not sequentially.
- **NEVER commit plans/specs**: Plan + spec docs often contain credentials/tokens/internal URLs. Write to `.planning/` (gitignored) or keep in conversation. `docs/superpowers/plans/` + `docs/superpowers/specs/` are gitignored.
- **NEVER mass-email real users for testing**: Test against a single test member (e.g. ID 8) or an event whose audience is only that member. Never call `POST /kscw/events/:id/notify` with `send_email: true` on an all-roles/large-audience event. (There is no dedicated test-email endpoint.)
- **Verification gate**: `npm run build` (tsc -b + vite) is the type gate — never `tsc --noEmit`. ALSO run `npm run lint` on React component edits (the build gate skips rules-of-hooks → React #310 crashes ship). Tests: `npm run test:unit` (vitest), `npm run test` (Playwright e2e), `npm run test:scripts` (node --test for directus scripts). ⚠ eslint's `no-undef` covers `directus/extensions/` but NOT `directus/scripts/` — a new branch there is gated only by executing it.

## Key Patterns
- **shadcn/ui**: Load the `/kscw-ui` skill for all UI work — KSCW conventions, shadcn + Magic UI + Aceternity catalog, theming, dark mode, animations (single source of UI truth for wiedisync + kscw-website).
- **Lists → tables, always**: Any view of homogeneous **data** records (rosters, members, expenses, audit logs, registrations, absences, scheduled games in admin views, sponsors, error logs, etc.) MUST use `<Table>` from `src/components/ui/table.tsx` — never card-stacks or `space-y-*` row lists. Mobile compaction rules: (a) names wrap to 2 lines (last name / first name), no truncation; (b) positions render as initials via `getPositionInitial()` (S/O/M/D/L/G + BB equivalents), full label in `title`; (c) action toggles (K/G/captain/etc.) stack vertically (`flex-col`) on `<sm`, horizontal on `≥sm`; (d) optional columns (photos, secondary metadata) hide via `hidden sm:table-cell`; (e) row min-height ≥44px on mobile. Exceptions: (1) calendar grids, kanban boards, chat threads; (2) **event/activity cards** (`GameCard`, `TrainingCard`, `EventCard`, `ScorerRow`) — rich cards with logos/scores/RSVP CTAs; (3) **branded entity cards** (`TeamCard`) — team photo + brand color is the primary visual; (4) **prose / release notes** (`ChangelogPage`) — versioned narrative copy with bulleted change lists, not tabular records. The data-list rule applies when each row is a *record* you want to scan/edit; the card rule applies when each row is an *event/entity/release* you want to act on or read. Reference impl: `src/modules/teams/RosterEditor.tsx`.
- **Mobile-first**: Responsive, touch targets ≥44px, test small screens before desktop.
- **Capitalisation**: All user-facing strings (UI labels, button text, badges, toasts, push/email subjects, i18n values, error messages, placeholder text, form field labels, etc.) MUST start with a capital letter — Sentence case only (capitalize the first letter of each sentence, OR the single word when the label is one word). Never Title Case. Lowercase is only acceptable when explicitly required (e.g. all-caps acronyms, brand names with documented lowercase styling like `iOS`, code identifiers in inline `<code>`). Applies to all 5 locales (en/de/gsw/fr/it). Examples — Correct: "Absent", "Training cancelled", "Log in", "Save", "Add a note". Wrong: "absent", "training cancelled" (lowercase), "Training Cancelled", "Add A Note" (Title Case).
- **Date & time format (Swiss, app-wide)**:
  - Dates: `dd.mm.yyyy` always — `10.05.2026`, never `05/10/26` (en-US mm/dd/yy) or `10/05/2026` (en-CH slashes). Exception: where space is critical (mobile tables, dense calendar grids) `dd.mm.yy` is acceptable, but still dot-separated and day-first.
  - Times: 24-hour `HH:MM` always — `14:32`, never `2:32 PM`.
  - Combined: `dd.mm.yyyy HH:MM` (space-separated) or `dd.mm.yyyy, HH:MM` (comma-separated for sentences).
  - Hardcode locale to `de-CH` on every `Intl.DateTimeFormat` / `toLocaleString` / `toLocaleDateString` / `toLocaleTimeString` call — passing `currentLocale()` or omitting the argument silently breaks for English-speaking users (en-US gives `5/10/26, 2:32 PM`; en-CH gives `10/05/2026`). Always explicitly pass `hour12: false` on time formatters too.
  - Prefer the central helpers in `src/utils/dateHelpers.ts` (`formatDateZurich` → `dd.mm.yyyy`, `formatDateCompactZurich` → `dd.mm.yyyy`, `formatTimeZurich` → `HH:MM`, `formatDateTimeCompact` = both joined). They enforce the rule once. Inline `toLocaleString` calls that bypass the helpers MUST hardcode `'de-CH'` and `hour12: false`.
  - Same rule in `kscw-website` (`CLAUDE.md → Conventions`) — both repos use Swiss dot format regardless of UI language.
- **Dark mode**: Use shadcn semantic tokens (`bg-background`, `text-foreground`, `bg-primary`) — auto-switch. For non-semantic colors, add explicit `dark:` variants.
- **Native `<select>` dark mode**: `<option>` inherits the `<select>` background, not Tailwind dark styles. Every `<select>` MUST have `dark:bg-gray-800` (or equivalent) — `bg-transparent` alone renders white dropdowns in dark mode.
- **No native browser dialogs (`window.confirm`/`alert`/`prompt`) — EVER**: they are unstyled, not dark-mode aware, not translated, and break the branded UX. Use the app's promise-based modal helpers instead: `const confirm = useConfirm()` → `if (!(await confirm({ message, danger }))) return`, and `const prompt = usePrompt()` → `const v = await prompt({ message, defaultValue })` (both from `src/components/ConfirmProvider.tsx`, mounted app-wide; same `if (!(await …)) return` control flow as the native calls). For informational alerts use `toast` (sonner), not `alert()`. Make the enclosing handler `async` when converting. Applies to bare `confirm(`/`alert(`/`prompt(` too.
- **Hallenplan virtual slots**: Games/trainings/GCal events render as `HallSlot`-shaped objects at display time via `_virtual`, merged with real `hall_slots`. Never stored. See `INFRA.md → Hallenplan Virtual Slots`.
- **Data integrity**: Postgres triggers enforce validation (slot claims, shell invites, coach approval, game sync skips rows without `away_team`). See `directus/scripts/001-postgres-triggers.sql`.
- **ClubDesk sync-up CSVs**: UPDATE rows are **`[Id]`-keyed and name-less** — ClubDesk's import consumes a `[Id]` column as the record identity and touches only the columns present; an unknown `[Id]` hard-aborts the whole import (hence `/up`'s stale-link guard). NEVER re-add `Vorname`/`Nachname` to `CD_PUSH_HEADERS` (would overwrite legal names in the register) and never key an update on name/email matching (name drift previews as "Neue" dups; ClubDesk ignores email when matching). CREATE rows keep the wiedisync name. Ground truth table: `INFRA.md → ClubDesk import-wizard semantics`.
- **ClubDesk contact matching in the UI (group assignment, any Filtern automation) — ALWAYS match by ID, never by name**: type the **Wiedisync ID (`members.uuid`)** into the grid Filtern box — unique, immune to name-drift (CD "Berke-Wenger" vs "Berke") and accents. The `clubdesk_id`/`[Id]` is **NOT** Filtern-searchable (returns "(leer)"); it's only the CSV-import record identity. Search **"Alle Kontakte"** (not "Mitglieder") to include ehemalige / kein-Mitglied contacts. ⚠ This is the OPPOSITE of the CSV *import* wizard (there the Wiedisync ID is not a match key). Reference impl: `clubdesk-scrape-groups.mjs` (`selectRow(uuid)`). See `INFRA.md → ClubDesk group assignment`.
- **Error logging**: ALL frontend + backend errors → persistent JSONL via `GET /kscw/admin/error-logs`. Frontend also to Sentry (de.sentry.io, org "kscw"). Load `/kscw-error-logs` skill. Check logs FIRST when debugging.
- **Audit logging (actor capture) — log WHO did WHAT for every state change**: Custom endpoints write raw SQL via knex (`database(...).insert/update/delete`), which **bypasses Directus's automatic `directus_activity` + revision trail** — so the acting user is lost unless captured explicitly. Rule: every custom endpoint that **mutates state** (create/update/delete, confirm, book, block, override, send) MUST record the actor — (a) call `writeUserLog(database, log, { accountability, action, collection, recordId, data })` from `kscw-endpoints/src/activity-log.js` so the action lands in `user_logs` and shows up in the superadmin audit-log page (`/admin/audit-log`, which the `items.*` hook only auto-feeds for items-API writes — raw-knex writes bypass it); and/or (b) for domain-meaningful "who owns this record" cases, also persist an `*_by_name`/`*_by_email` actor pair on the row. Reads never need it. Reference impl: `resolveActingUser(req)` → `confirmed_by_*` + `writeUserLog(...)` in `game-scheduling.js` (confirm-home / confirm-away / manual-booking / block-slot). When you add or touch a mutating endpoint, add actor capture in the SAME commit; if it's a new column, register it in `directus_fields` (schema-only migration) so the items API + dashboard can read it. Operations that go through the normal Directus items API are already actor-logged by Directus — this rule is specifically for the custom `kscw-endpoints`.
- **Code graph**: `npm run graph` builds a tree-sitter knowledge graph of the repo into `graphify-out/` (gitignored) — `graph.html` to browse, `GRAPH_REPORT.md`, `graph.json` to query. ~25s, 0 LLM tokens. ⚠⚠ **Never run bare `graphify`/`/graphify` on this repo** — it silently drops all 328 `.sql` files, never resolves the `@/*` alias (so `cn()`, the most-connected node, is invisible), and leaves the SQL layer a disconnected island. `scripts/graphify-build.py` fixes all three; see its docstring and `README.md → Code graph`. ⚠ When querying, use full node ids (`src_hooks_useauth_useauth`), not labels (they collide), pass `--undirected` to `graphify path`, and ignore `relation: indirect_call` — it is 100% false positives here.
- **Troubleshooting**: When you solve an error, document it in `INFRA.md → Troubleshooting & Gotchas`. Check that section FIRST.
- **M2M junction objects in forms**: Extract related IDs from junction objects. Never pass raw expanded junction objects to `string[]` UI. Pattern: `.map((j: any) => String(typeof j === 'object' ? (j.related_field?.id ?? j.related_field ?? j) : j))`.
- **M2M writes to Directus**: Flat ID arrays trigger junction-PK lookup (403s for non-admin); use junction-object format: `[{ teams_id: 3 }]`. Grant junction CRUD + base CRUD as a pair. **On UPDATE, every kept link MUST carry its junction row `id`** — `[{ id: 14, teams_id: 3 }, { teams_id: 9 }]`. A PK-less object is a CREATE to Directus and the old row is only deleted afterwards, so re-sending an unchanged link duplicate-inserts and now 400s on migration 245's pair uniques (`Value for field "events_id, teams_id" … has to be unique`). Use `m2mUpdatePayload(field, relatedIds, existingJunctionRows)` from `src/lib/api.ts`, and request the junction PK when reading (`teams.id` **next to** `teams.teams_id`, `coach.id` next to `coach.members_id`) — without it the helper silently degrades. See `INFRA.md → Troubleshooting`.
- **M2M reads must expand `.members_id` — bare IDs are junction IDs, not member IDs (CRITICAL)**: When fetching a team with `fields: ['*', 'team.*']` or no fields at all, Directus returns M2M aliases like `coach` and `team_responsible` as bare arrays of *junction row IDs* (`teams_coaches.id` / `teams_responsibles.id`), NOT member IDs. Passing those to `flattenMemberIds()` produces garbage "members" whose IDs happen to equal a junction row's ID — surfaced 2026-05-12 as Aditya Dave (member 6) appearing in D1's absences because D1's `teams_coaches.id` was 6. **Rule**: every Directus query that needs coach/TR membership MUST include `coach.members_id` and `team_responsible.members_id` in the `fields:` array (or `team.coach.members_id` / `kscw_team.coach.members_id` when expanding through a parent FK). Same for `events.teams.teams_id.coach.members_id`. Captain is M2O so `team.captain` is a real FK and is fine bare. Audit any code calling `flattenMemberIds(team.coach)` to verify the team object was fetched with the expand.
- **M2M deep filter + policy walk = silent empty (CRITICAL)**: Never combine a frontend filter that walks an M2M/o2m alias with a policy filter that walks the *same* alias. Directus cannot reliably AND two filter expressions through the same junction → query silently returns `[]` for non-admin (admins bypass policy filters so it appears to "work"). Concrete cases hit so far: `members` filtered by `{ member_teams: { team: { _in: [...] } } }` (KSCW Coach policy walks `member_teams.team.coach=$CURRENT_USER`); `events` filtered by `{ teams: { teams_id: { _eq: id } } }` + `{ invited_members: { members_id: { _eq: user } } }` (policy walks `events.teams.teams_id.{members,coach,team_responsible}`). **Pattern**: do a single-level junction fetch first (`events_teams`, `member_teams`, etc. with `{ teams_id: { _in: ids } }`), collect the parent IDs, then filter the parent collection with `{ id: { _in: ids } }`. Reference impls: `useMultiTeamMembers` (`src/hooks/useTeamMembers.ts`), `useUserVisibleEventIds` (`src/hooks/useUserVisibleEventIds.ts`).
- **Promise.all in context loading**: One failed query fails all. Verify each collection exists in Directus (via `GET /relations`) before querying after M2M recreations.
- `.env` is gitignored — CF Pages env vars handle prod config.

## Directus Admin
- **Admin UI**: `https://directus.kscw.ch/admin` (prod), `https://directus-dev.kscw.ch/admin` (dev)
- **Schema changes**: Make on dev, sync to prod via `npm run schema:pull` / `npm run schema:push`. See `INFRA.md → Schema Sync`.
- **Extensions**: Endpoints in `directus/extensions/kscw-endpoints/`, hooks in `directus/extensions/kscw-hooks/`. Deploy by restarting container.
- **Deleting collections/records**: Confirm with user first.
- **A raw-SQL `directus_fields` insert does NOT bust the schema cache**: the field reads back as `type: alias` until the container is restarted, and a policy filter on a phantom alias does not behave. Restart after any migration that registers a field.
- **`/items` is license-restricted on both envs** — a real admin session is refused too, so a hook/cron cascade cannot be triggered through the API. Run it via `docker exec node`, importing the module with knex pointed at the container's pnpm store.
- **M2M fields MUST be created via the admin UI** — API-created M2M relations show "relationship hasn't been configured correctly". Flow: (1) nuke junction + PG table + field, (2) create via Settings → Data Model → Add Field → Many to Many in browser, (3) restore data via API. UI auto-generates junction names (e.g. `teams_members_3`) — rename via SQL after + update Directus metadata. Check names via `/relations` API.
- **Junction names (prod)**: `hall_slots_teams`, `teams_coaches`, `teams_responsibles`, `teams_sponsors`, `events_teams`, `events_members`, `forms_teams`. `captain` is M2O on `teams` (not a junction). (`hall_events_halls` was dropped in migration 252 — never populated.)
- **Dev DB is overwritten nightly** by a scrubbed prod clone (03:00 UTC cron; on demand via `npm run db:refresh-dev`). Dev-only data does not survive the night; test tokens are re-pinned by the refresh script.

## Migration & Permission Policy (READ BEFORE TOUCHING SQL OR PERMS)
The "every audit pass breaks something" loop comes from treating permissions as patches. Hard rules:

1. **Permissions live ONLY in `directus/scripts/setup-permissions.mjs`.** Never write a permission row in a numbered `0NN-*.sql` migration. The script is declarative + idempotent (`clearPolicyPermissions` then recreate) and is the single source of truth. Re-runs are safe and required after every deploy.
2. **Numbered migrations are SCHEMA-ONLY.** DDL, triggers, RLS policies, grants, foreign keys, data backfills. Each must be idempotent (`CREATE OR REPLACE`, `IF NOT EXISTS`, `DROP IF EXISTS`-then-`CREATE`, `DO $$ … END $$` for FK adds, `ON CONFLICT DO NOTHING` for backfills). One numbered migration = one bounded change.
3. **The runner enforces apply-once.** `npm run db:migrate:dev|prod` reads `kscw_migrations` (filename + sha256), applies pending in numeric order, errors if any applied migration's on-disk content has been edited (sha mismatch). Don't edit applied migrations — fix forward with a new number.
4. **Deploy command is one of these, not bespoke psql:**
   - `npm run db:deploy:dev` — runs `db:snapshot:dev` (pre-deploy DB snapshot on the VPS) → `db:migrate:dev` → `db:setup-perms:dev` → `db:smoke:dev`
   - `npm run db:deploy:prod` — same on prod
   - **When a change touches BOTH schema and extension code, deploy schema FIRST: `npm run deploy:dev` / `npm run deploy:prod` chain `db:deploy:*` → `ext:deploy:*`** so the migration that adds a column lands before the endpoint code that selects it restarts. Shipping `ext:deploy` ahead of its migration is what produced the 2026-06-19 `public/team` 500s (`column … does not exist`). Frontend still deploys separately on git push (CF Pages).
5. **Smoke test is part of deploy.** `db:smoke` logs in as a non-admin Member and exercises every collection that `loadTeamContext` + the home page touch. Catches the silent `Promise.all` failure pattern (4.4.4) the same minute it ships.
6. **Fresh installs use `SCHEMA.sql` + setup-permissions.mjs, not the migration journal.** Regenerate `directus/scripts/SCHEMA.sql` from prod via `npm run db:baseline:prod` after any schema migration and commit it. The journal stays as the audit trail.
7. **PERMISSIONS.md and SECURITY.md are operational docs, not vibes.** When you change a permission row in `setup-permissions.mjs`, update PERMISSIONS.md the same commit. When you fix a security finding, append to SECURITY.md "Hardening completed". Reviewers diff both.

If a future change tempts you to add a permission row in a numbered SQL file: stop. Update `setup-permissions.mjs` instead and let the next deploy reconcile. If you need a permission *fix on prod NOW*, either run `npm run db:setup-perms:prod` or apply the SQL by hand AND update the script in the same commit.

## SSH to VPS
- `ssh hetzner` (alias in `~/.ssh/config`)
- Containers: `directus-kscw` (8055), `directus-kscw-dev` (8056)
- Restart: `ssh hetzner "sudo docker restart directus-kscw"`
- Logs: `ssh hetzner "sudo docker logs --tail 30 directus-kscw"`
- See `INFRA.md → Hetzner VPS Management`.

## Domains
- `kscw.ch` — Public website (Astro, CF Pages project `kscw-website`) since the 2026-06-18 cutover — no longer ClubDesk. `kscw-website.pages.dev` 302-redirects here (`functions/_middleware.js` in that repo).
- `wiedisync.kscw.ch` — React prod, CF Pages `wiedisync` (`prod` branch) → `directus.kscw.ch`
- `dev.wiedisync.pages.dev` — React dev, CF Pages (`dev` branch) → `directus-dev.kscw.ch` (auto-detected in `src/lib/api.ts`). ⚠ **`wiedisync.pages.dev` (no `dev.` prefix) is the PROD-branch alias, not dev** — it serves the same build as `wiedisync.kscw.ch`. It still talks to `directus-dev.kscw.ch`, because `api.ts` pins prod Directus by hostname (`host === 'wiedisync.kscw.ch'`) and a `pages.dev` origin is not in that list — so it is prod code against dev data. ⚠⚠ **Never verify a prod deploy against it**: it tracks the project's production deployment and is correct even when the real hostname is not (2026-08-11 froze for ~3 releases; INFRA.md → Troubleshooting).
- `spielplanung-dev.kscw.ch` — Spielplanung **dev** (CF Pages `wiedisync-spielplanung-dev`, `dev` branch → `directus-dev.kscw.ch`). ⚠ Until 2026-08-11 this was a second custom domain on the PROD project and served prod code against **prod data**; it is a real dev environment now. It is the only `.kscw.ch` scheduling host, so it is where authenticated (cookie-SSO) scheduling work happens — `*.pages.dev` cannot hold the `.kscw.ch` session cookie.
- `spielplanung.wiedisync.kscw.ch` — Spielplanung standalone app (own CF Pages project; built via `npm run build:scheduling` / `VITE_APP_TARGET=scheduling`; cookie-session SSO from the member app). In-app `/admin/spielplanung|terminplanung` routes redirect here.
- `directus.kscw.ch` / `directus-dev.kscw.ch` — Directus API prod/dev (plain Docker on Hetzner, not Coolify)
- `kscw-website.pages.dev` — CF Pages project behind `kscw.ch`. Dev-first like wiedisync (`dev` branch → preview, `prod` branch → live at `kscw.ch`); promote `dev` → `prod` with user approval.
- `kscw-push.lucanepa.workers.dev` — Web push CF Worker

See `INFRA.md → Domains & Hosting Overview` for full map.

## Branches & Dev-First Workflow
- `prod` → production (`wiedisync.kscw.ch` / `directus.kscw.ch`)
- `dev` → preview (`wiedisync.pages.dev` / `directus-dev.kscw.ch`)

**All changes go through `dev` first.** Never push to `prod` unless explicitly told. Flow:
1. Commit on `dev`
2. Frontend deploys automatically on push
3. Backend: `npm run ext:deploy:dev` — runs `ext:install` (npm ci in `kscw-endpoints`; skipping this once crashed ALL `/kscw/*` routes) → rsync `directus/extensions/` to VPS → restart container → `ext:smoke:dev` curl-check. Note: `directus/scripts/` is a separate bind-mount deployed via `npm run scripts:deploy:dev|prod`, NOT covered by `ext:deploy`.
4. Test on `wiedisync.pages.dev` → `directus-dev.kscw.ch`
5. With user approval, merge `dev` → `prod` and push
6. `npm run ext:deploy:prod` for backend extensions

## Session Workflow
1. **Start**: Read `CLAUDE.md` + `INFRA.md` before doing anything.
2. **End**: Record dev/deploy history in **`docs/DEVLOG.md`** (one dated line) — NOT inline in this file. git log + DEVLOG are the record; keep CLAUDE.md instruction-only. If you touch "Recent dev log" below, prune it back to ~5 entries.
3. **Before finishing**: Ask "Should this commit be added to the changelog and version bumped?" If yes: update `CHANGELOG.md`, bump `package.json` (semver), and update `APP_VERSION` + `CHANGELOG` array in `src/modules/changelog/ChangelogPage.tsx` (in-app via Options → What's New). `ChangelogPage` entries and `CHANGELOG.md` are both in English (consistent with the English-first convention).

### Versioning discipline (don't bump for every micro-fix)
- **Skip the bump** for trivial changes: typo fixes, single-line CSS tweaks, missing translations, dependency-comment cleanups, README edits. Just commit + push without touching `package.json` / `CHANGELOG.md` / `ChangelogPage.tsx`.
- **Batch** small fixes — when several minor things land together, bump once and write a single short entry like *"Bug fixes and polish"* without enumerating each item. Detail belongs in commit messages, not the in-app changelog.
- **Bump + write detailed entry** only when there's user-visible behavior change, a new feature, a schema migration, security work, or a non-obvious bug fix worth explaining. The audience for `ChangelogPage` is end users — they don't care that v4.6.6 fixed a bug that v4.6.7 had to refix, they care that the count is right.
- If the same area of code gets multiple commits in a single day chasing the same root cause, **collapse into one entry** before the day ends. Iterative debugging notes belong in git, not the in-app changelog.

## Recent dev log
<!-- Last few dev/deploy entries only, for at-a-glance recent context. Full history → docs/DEVLOG.md
     (append new dev/deploy entries THERE, not here). User-facing release notes → CHANGELOG.md.
     Keep this list pruned to ~5 entries. -->
- **2026-09-08** Basketplan has not published 26/27 yet, and the day it does every fixture would have landed twice (no migration, dev)
- **2026-09-08** A tournament that closed in July still had a live Edit button, and a finance cron that never ran once (no migration, dev+prod)
- **2026-09-08** Two doors onto one ClubDesk login, and a toast that said `API /clubdesk-member-sync: 409` (no migration, dev)
- **2026-09-07** Basketball games announced to the school as volleyball, and the agreed dates not announced at all (no migration, dev+prod)
- **2026-09-06** The bilingual scorer-course feedback export, committed three weeks after it was written (no migration, dev+prod)
**Full history → [`docs/DEVLOG.md`](docs/DEVLOG.md)** · **pre-1.0 → [`docs/DEVLOG-archive.md`](docs/DEVLOG-archive.md)** (v1.0.0 baseline consolidated 2026-06-19).
