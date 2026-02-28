# KSCW Infrastructure Reference

## Synology NAS

| Item | Value |
|------|-------|
| Hostname | `DS923Luca` |
| Tailscale IP | `100.64.212.125` |
| SSH | `ssh lucanepa@100.64.212.125` |
| Docker path | `/volume1/docker/` |

## PocketBase

| Item | Value |
|------|-------|
| Public URL | `https://kscw-api.lucanepa.com` |
| Admin UI | `https://kscw-api.lucanepa.com/_/` |
| Admin email | `admin@kscw.ch` |
| Container name | `pocketbase-kscw` |
| Container port | `8092 → 80` (internal) |
| Data volume | `/volume1/docker/pocketbase-dev/pb_data` |
| Hooks volume | `/volume1/docker/pocketbase-dev/pb_hooks` |
| Migrations volume | `/volume1/docker/pocketbase-dev/pb_migrations` |

### Deploy hooks to PocketBase

```bash
# From local machine — upload to /tmp
cat pb_hooks/sv_sync.pb.js | ssh lucanepa@100.64.212.125 "cat > /tmp/sv_sync.pb.js"
cat pb_hooks/sv_sync_lib.js | ssh lucanepa@100.64.212.125 "cat > /tmp/sv_sync_lib.js"

# From Synology SSH — copy into place and restart
sudo cp /tmp/sv_sync.pb.js /volume1/docker/pocketbase-dev/pb_hooks/sv_sync.pb.js
sudo cp /tmp/sv_sync_lib.js /volume1/docker/pocketbase-dev/pb_hooks/sv_sync_lib.js
sudo docker restart pocketbase-kscw
```

### Trigger Swiss Volley sync manually

```bash
# Get auth token and trigger sync
TOKEN=$(curl -s -X POST https://kscw-api.lucanepa.com/api/collections/_superusers/auth-with-password \
  -H "Content-Type: application/json" \
  -d '{"identity":"admin@kscw.ch","password":"@Bocconi13"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

curl -X POST https://kscw-api.lucanepa.com/api/sv-sync -H "Authorization: Bearer $TOKEN"
```

### Swiss Volley API

| Item | Value |
|------|-------|
| Base URL | `https://api.volleyball.ch` |
| API Key | `253fdead86acc874a1d00cbccdae845a7fb43a21` |
| Cron schedule | Daily at 06:00 UTC |

## Cloudflare

### Tunnel (`kscw`)

| Hostname | Service |
|----------|---------|
| `kscw-api.lucanepa.com` | `http://172.17.0.1:8092` |

### Cloudflare Pages (`kscw`)

| Item | Value |
|------|-------|
| Production URL | `https://kscw.lucanepa.com` |
| Dev preview URL | `https://dev-kscw.lucanepa.com` |
| GitHub repo | `Lucanepa/kscw` |
| Production branch | `main` |
| Preview branches | `dev` |
| Build command | `npm run build` |
| Output directory | `dist` |
| Env var | `VITE_PB_URL=https://kscw-api.lucanepa.com` |

### CORS (PocketBase allowed origins)

- `https://kscw.lucanepa.com`
- `https://dev-kscw.lucanepa.com`
- `https://kscw.ch`
- `http://localhost:5173`

## Git Branches

| Branch | Deploys to | Purpose |
|--------|-----------|---------|
| `main` | `kscw.lucanepa.com` (production) | Stable, production-ready |
| `dev` | `dev-kscw.lucanepa.com` (preview) | Testing before production |
