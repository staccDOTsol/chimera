#!/bin/sh
# Railway role router — one image, two roles (set SERVICE_ROLE per service):
#   SERVICE_ROLE=onion → the Tor onion-host (publishes the seed brains' .onion
#                        hidden services so the feed's onion links resolve).
#   otherwise          → an agent brain on a loop (CHIMERA_NAME / CHIMERA_GOAL /
#                        OpenRouter key via env), re-running every CHIMERA_INTERVAL s.
if [ "$SERVICE_ROLE" = "onion" ]; then
  exec node src/onion-host.ts
fi
while true; do
  node src/agent.ts || true
  sleep "${CHIMERA_INTERVAL:-300}"
done
