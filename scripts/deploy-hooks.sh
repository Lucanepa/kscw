#!/bin/bash
# Deploy PocketBase hooks to Synology NAS and restart the container.
# Usage: ./scripts/deploy-hooks.sh

set -euo pipefail

echo "Deploying pb_hooks to Synology..."
rsync -avz pb_hooks/ synology:/volume1/docker/pocketbase/pb_hooks/

echo "Restarting PocketBase container..."
ssh synology "sudo docker restart pocketbase-kscw"

echo "Done. Hooks deployed and PocketBase restarted."
