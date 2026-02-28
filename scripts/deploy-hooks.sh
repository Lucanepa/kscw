#!/bin/bash
# Deploy PocketBase hooks to Synology NAS and restart the container.
# Usage: ./scripts/deploy-hooks.sh

set -euo pipefail

SYNOLOGY="lucanepa@DS923Luca"
HOOKS_PATH="/volume1/docker/pocketbase-dev/pb_hooks/"
CONTAINER="pocketbase-kscw"

echo "Deploying pb_hooks to Synology..."
scp pb_hooks/* "$SYNOLOGY:$HOOKS_PATH"

echo "Restarting $CONTAINER..."
ssh "$SYNOLOGY" "sudo docker restart $CONTAINER"

echo "Done. Hooks deployed and $CONTAINER restarted."
