#!/usr/bin/env bash
# Health check for the storage host: the Neon containers, disk, and the
# freshness of the two backup sets this host owns.
set -uo pipefail
. /opt/colors/r2-env.sh
problems=()
cd /opt/neon 2>/dev/null && for s in storage_broker pageserver safekeeper compute; do
  id=$(docker compose ps -q "$s" 2>/dev/null)
  st=$(docker inspect -f '{{.State.Status}}' "$id" 2>/dev/null || echo missing)
  [ "$st" = running ] || problems+=("container $s is $st")
done
curl -sf http://127.0.0.1:9898/v1/status >/dev/null || problems+=("pageserver /v1/status failed")
curl -sf http://127.0.0.1:7676/v1/status >/dev/null || problems+=("safekeeper /v1/status failed")
disk=$(df --output=pcent / | tail -1 | tr -dc '0-9'); [ "${disk:-0}" -lt 80 ] || problems+=("disk ${disk}%")
age=$(newest_set_age_hours "backup:$BACKUP_BUCKET/$PROFILE/postgres")
[ "$age" -le 8 ] || problems+=("newest completed postgres backup is ${age}h old")
mage=$(newest_set_age_hours "backup:$BACKUP_BUCKET/$PROFILE/media-runs")
[ "$mage" -le 30 ] || problems+=("newest completed media run is ${mage}h old")
ok=0; [ "${#problems[@]}" -eq 0 ] || ok=1
write_monitor /var/lib/colors/neon-monitor.json "$ok" "${problems[@]}"
[ "$ok" -eq 0 ] && echo "neon-monitor: ok" || { printf 'neon-monitor: %s\n' "${problems[@]}" >&2; }
exit "$ok"
