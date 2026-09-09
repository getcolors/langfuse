#!/usr/bin/env bash
# Health check for one replica; on node 0 also backup freshness. Writes
# /var/lib/colors/clickhouse-monitor.json, which `describe` reads over SSH.
set -uo pipefail
. /opt/colors/r2-env.sh
problems=()
admin_pw=$(cat /etc/clickhouse-secrets/admin_password 2>/dev/null || true)
cq() { clickhouse-client --user admin --password "$admin_pw" --query "$1" 2>/dev/null; }

curl -sf "http://127.0.0.1:8123/ping" >/dev/null || problems+=("clickhouse does not answer /ping")
q=$(cq "SELECT count() FROM system.replication_queue"); [ "${q:-0}" -lt 100 ] || problems+=("replication_queue depth $q")
k=$(cq "SELECT count() FROM system.zookeeper WHERE path = '/'"); [ "${k:-0}" -gt 0 ] || problems+=("keeper root not readable")
r=$(cq "SELECT count() FROM clusterAllReplicas('default', system.one)"); [ "${r:-0}" = "3" ] || problems+=("cluster sees ${r:-0} replicas, not 3")
disk=$(df --output=pcent /var/lib/clickhouse | tail -1 | tr -dc '0-9'); [ "${disk:-0}" -lt 80 ] || problems+=("disk ${disk}%")
if [ -f /etc/colors/backup-r2.env ]; then
  age=$(newest_set_age_hours "backup:$BACKUP_BUCKET/$PROFILE/clickhouse")
  [ "$age" -le 30 ] || problems+=("newest completed clickhouse backup is ${age}h old")
fi
ok=0; [ "${#problems[@]}" -eq 0 ] || ok=1
write_monitor /var/lib/colors/clickhouse-monitor.json "$ok" "${problems[@]}"
[ "$ok" -eq 0 ] && echo "clickhouse-monitor: ok" || { printf 'clickhouse-monitor: %s\n' "${problems[@]}" >&2; }
exit "$ok"
