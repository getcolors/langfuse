#!/usr/bin/env bash
# The app-host half of the restore rehearsal: boot the PINNED web image, in a
# second Compose project on loopback, against the two restored databases and
# with the operator-held ENCRYPTION_KEY and SALT -- then prove through the
# supported APIs what a row count cannot: the live project keys authenticate
# (hashed keys + salt + Postgres), the smoke trace reads back with its
# generation and score (ClickHouse restore usable through the app), and the
# seeded LLM connection decrypts.
#
# Usage: langfuse-rehearsal <clickhouse-set> <postgres-set>
set -uo pipefail
. /opt/colors/r2-env.sh
CH_SET="${1:?usage: langfuse-rehearsal <clickhouse-set> <postgres-set>}"
PG_SET="${2:?usage: langfuse-rehearsal <clickhouse-set> <postgres-set>}"
rc=0
pass() { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*" >&2; rc=1; }
DIR=/var/tmp/langfuse-restore
PORT=3100
PK=$(cat /etc/langfuse/secrets/project_public_key); SK=$(cat /etc/langfuse/secrets/project_secret_key)
T=$(cat /var/lib/colors/smoke-trace-id 2>/dev/null || true)
cleanup() { (cd "$DIR" 2>/dev/null && docker compose down -v >/dev/null 2>&1) || true; rm -rf "$DIR"; }
trap cleanup EXIT

echo "== R: restore-and-boot (clickhouse $CH_SET, postgres $PG_SET) =="
mkdir -p "$DIR"; chmod 700 "$DIR"
live_db=$(sed -n 's/^DATABASE_URL=//p' /etc/langfuse/host.env)
scratch_db=$(printf '%s' "$live_db" | sed -E 's#/<{ neon-database }>$#/langfuse_restore_check#')
umask 077
cat > "$DIR/scratch.env" <<ENV
DATABASE_URL=$scratch_db
CLICKHOUSE_DB=restore_check
REDIS_KEY_PREFIX=restore:
NEXTAUTH_URL=http://127.0.0.1:$PORT
NEXTAUTH_SECRET=$(openssl rand -base64 32)
LANGFUSE_AUTO_CLICKHOUSE_MIGRATION_DISABLED=true
LANGFUSE_AUTO_POSTGRES_MIGRATION_DISABLED=true
LANGFUSE_CSP_ENFORCE_HTTPS=false
ENV
cat > "$DIR/compose.yml" <<COMPOSE
name: langfuse-restore
services:
  web:
    image: <{ langfuse-image }>
    restart: "no"
    env_file:
      - /etc/langfuse/langfuse.env
      - /etc/langfuse/host.env
      - /etc/langfuse/operator.env
      - $DIR/scratch.env
    ports: ["127.0.0.1:$PORT:3000"]
COMPOSE
(cd "$DIR" && docker compose up -d >/dev/null 2>&1) || { fail "R1 the scratch project did not start"; exit 1; }

ready=1
for _ in $(seq 1 60); do
  h=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/public/health?failIfDatabaseUnavailable=true" 2>/dev/null)
  [ "$h" = "200" ] && { ready=0; break; }; sleep 5
done
[ "$ready" = 0 ] && pass "R1 the pinned image boots against the restored databases" || { fail "R1 the scratch web never became healthy"; (cd "$DIR" && docker compose logs --tail 40 web) >&2; exit 1; }

r=$(curl -sS --max-time 30 -u "$PK:$SK" -w '\n%{http_code}' "http://127.0.0.1:$PORT/api/public/projects")
st=$(printf '%s' "$r" | tail -1); body=$(printf '%s' "$r" | sed '$d')
if [ "$st" = "200" ] && printf '%s' "$body" | grep -q '"<{ langfuse-init-project-id }>"'; then
  pass "R2 the live project keys authenticate against the restored Postgres"
else
  fail "R2 /api/public/projects answered $st through the scratch web"
fi

if [ -n "$T" ]; then
  # Observations API v2: the legacy /traces/:id route is 404 on v4.
  r=$(curl -sS --max-time 30 -u "$PK:$SK" -w '\n%{http_code}' "http://127.0.0.1:$PORT/api/public/v2/observations?traceId=$T&fields=core,basic&limit=50")
  st=$(printf '%s' "$r" | tail -1); body=$(printf '%s' "$r" | sed '$d')
  if [ "$st" = "200" ]; then
    counts=$(printf '%s' "$body" | python3 -c 'import json,sys; d=json.load(sys.stdin).get("data",[]); print(sum(1 for x in d if x.get("isRootObservation")), sum(1 for x in d if x.get("type")=="GENERATION"))' 2>/dev/null || echo "0 0")
    set -- $counts
    [ "${1:-0}" -ge 1 ] && [ "${2:-0}" -ge 1 ] && pass "R3 the smoke trace reads back from restored ClickHouse with its root and generation" \
      || fail "R3 the smoke trace reads back with $1 roots and $2 generations"
  else
    fail "R3 the smoke trace $T answered $st through the scratch web"
  fi
else
  fail "R3 no smoke trace id recorded; run the converge first"
fi

r=$(curl -sS --max-time 30 -u "$PK:$SK" -w '\n%{http_code}' "http://127.0.0.1:$PORT/api/public/llm-connections")
st=$(printf '%s' "$r" | tail -1); body=$(printf '%s' "$r" | sed '$d')
if [ "$st" = "200" ] && printf '%s' "$body" | python3 -c 'import json,sys; d=json.load(sys.stdin); xs=d.get("data",d if isinstance(d,list) else []); sys.exit(0 if any(x.get("provider")=="colors-rehearsal" and x.get("displaySecretKey") for x in xs) else 1)' 2>/dev/null; then
  pass "R4 the seeded LLM connection decrypts with the operator-held key"
else
  fail "R4 the seeded LLM connection did not decrypt ($st)"
fi

[ "$rc" -eq 0 ] && echo "rehearsal: restore-and-boot passed" || echo "rehearsal: FAILED" >&2
exit "$rc"
