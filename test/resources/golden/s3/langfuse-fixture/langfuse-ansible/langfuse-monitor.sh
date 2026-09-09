#!/usr/bin/env bash
# Health check for the app host. Writes /var/lib/colors/langfuse-monitor.json.
set -uo pipefail
. /opt/colors/r2-env.sh
problems=()
h=$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' "http://127.0.0.1:3000/api/public/health?failIfDatabaseUnavailable=true" 2>/dev/null)
[ "$h" = "200" ] || problems+=("web health answered $h")
w=$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' "http://127.0.0.1:3030/api/health?failIfQueueConsumptionStuck=true" 2>/dev/null)
[ "$w" = "200" ] || problems+=("worker health answered $w (queue consumption may be stuck)")
cd /opt/langfuse 2>/dev/null && for s in langfuse-web langfuse-worker caddy; do
  id=$(docker compose ps -q "$s" 2>/dev/null)
  st=$(docker inspect -f '{{.State.Status}}' "$id" 2>/dev/null || echo missing)
  [ "$st" = running ] || problems+=("container $s is $st")
  # RestartCount is cumulative for the container's life, so it alone flags a
  # container that looped once weeks ago and has been fine since. A container
  # that is restarting NOW has a recent StartedAt; that pair is the signal.
  rcnt=$(docker inspect -f '{{.RestartCount}}' "$id" 2>/dev/null || echo 0)
  started=$(docker inspect -f '{{.State.StartedAt}}' "$id" 2>/dev/null || echo "")
  age=$(( $(date +%s) - $(date -d "${started:-1970-01-01}" +%s 2>/dev/null || echo 0) ))
  { [ "${rcnt:-0}" -ge 5 ] && [ "$age" -lt 1800 ]; } && problems+=("container $s is restarting (${rcnt} restarts, last start ${age}s ago)")
done
disk=$(df --output=pcent / | tail -1 | tr -dc '0-9'); [ "${disk:-0}" -lt 80 ] || problems+=("disk ${disk}%")
mem=$(free | awk '/^Mem:/ {printf "%d", $3*100/$2}'); [ "${mem:-0}" -lt 85 ] || problems+=("memory ${mem}%")
# Certificate expiry, through Caddy on loopback with the public SNI.
exp=$(echo | timeout 15 openssl s_client -servername "langfuse.fixture.example" -connect 127.0.0.1:443 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | sed 's/notAfter=//')
if [ -n "$exp" ]; then
  left=$(( ($(date -d "$exp" +%s) - $(date +%s)) / 86400 ))
  [ "$left" -gt 14 ] || problems+=("certificate expires in ${left} days")
else
  problems+=("no certificate served on 443")
fi
ok=0; [ "${#problems[@]}" -eq 0 ] || ok=1
write_monitor /var/lib/colors/langfuse-monitor.json "$ok" "${problems[@]}"
[ "$ok" -eq 0 ] && echo "langfuse-monitor: ok" || { printf 'langfuse-monitor: %s\n' "${problems[@]}" >&2; }
exit "$ok"
