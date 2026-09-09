#!/usr/bin/env bash
# What this host knows: its last monitor result and the deployment markers.
set -uo pipefail
. /opt/colors/r2-env.sh
echo "== monitor =="; cat /var/lib/colors/langfuse-monitor.json 2>/dev/null || echo "(no monitor result yet)"; echo
echo "== markers in $STORE_BUCKET/$STORE_PREFIX =="
for m in .colors-ready .colors-recovery-verified; do
  v=$(r2_cat "store:$STORE_BUCKET/${STORE_PREFIX}$m" || true)
  printf '%-28s %s\n' "$m" "${v:-absent}"
done
echo
echo "== containers =="; cd /opt/langfuse && docker compose ps
