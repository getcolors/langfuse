#!/usr/bin/env bash
# Health check for the Redis host. Writes /var/lib/colors/redis-monitor.json.
set -uo pipefail
. /opt/colors/r2-env.sh
problems=()
cd /opt/redis || { write_monitor /var/lib/colors/redis-monitor.json 1 "no /opt/redis"; exit 1; }
pw=$(cat /etc/redis/secrets/password 2>/dev/null || true)
r() { docker compose exec -T redis redis-cli --no-auth-warning -a "$pw" "$@" 2>/dev/null | tr -d '\r'; }
r PING | grep -q PONG || problems+=("redis does not answer PING")
r INFO persistence | grep -q '^aof_last_write_status:ok' || problems+=("aof_last_write_status is not ok")
r INFO persistence | grep -q '^aof_last_bgrewrite_status:ok' || problems+=("aof_last_bgrewrite_status is not ok")
used=$(r INFO memory | sed -n 's/^used_memory:\([0-9]*\).*/\1/p'); total=$(free -b | awk '/^Mem:/ {print $2}')
if [ -n "${used:-}" ] && [ -n "${total:-}" ] && [ "$total" -gt 0 ]; then
  pct=$((used * 100 / total)); [ "$pct" -lt 70 ] || problems+=("redis uses ${pct}% of host memory")
fi
rc=$(docker inspect -f '{{.RestartCount}}' "$(docker compose ps -q redis 2>/dev/null)" 2>/dev/null || echo 0)
[ "${rc:-0}" -lt 5 ] || problems+=("redis restarted ${rc} times")
disk=$(df --output=pcent / | tail -1 | tr -dc '0-9'); [ "${disk:-0}" -lt 80 ] || problems+=("disk ${disk}%")
ok=0; [ "${#problems[@]}" -eq 0 ] || ok=1
write_monitor /var/lib/colors/redis-monitor.json "$ok" "${problems[@]}"
[ "$ok" -eq 0 ] && echo "redis-monitor: ok" || { printf 'redis-monitor: %s\n' "${problems[@]}" >&2; }
exit "$ok"
