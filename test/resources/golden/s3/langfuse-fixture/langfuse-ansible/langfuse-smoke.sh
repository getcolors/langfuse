#!/usr/bin/env bash
# Acceptance. Every gate proves a property that could otherwise be false while
# everything still looks healthy. Failing any gate fails the converge.
#
# Written against Langfuse v4 in its default write mode (events_only): the
# legacy batch endpoint /api/public/ingestion answers 207 while rejecting every
# event, and GET /api/public/traces/:id is 404 for everyone. Ingestion here is
# OTLP/HTTP JSON with the x-langfuse-ingestion-version: 4 header, reads go
# through the Observations API v2, and ClickHouse evidence lives in
# events_full and scores -- the traces and observations tables stay empty.
#
# Modes:
#   (none)          the full gate set, then the ready marker
#   --ingest-only   one trace in, read back -- the node-loss drill's probe
#   --enqueue-only  one trace in, id printed, no wait -- the Redis drill's probe
set -uo pipefail
. /opt/colors/r2-env.sh
MODE="${1:-}"
rc=0
pass() { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*" >&2; rc=1; }
warn() { printf '  WARN  %s\n' "$*"; }

BASE="http://127.0.0.1:3000"
PK=$(cat /etc/langfuse/secrets/project_public_key)
SK=$(cat /etc/langfuse/secrets/project_secret_key)
AUTH="$PK:$SK"
envget() { sed -n "s/^$2=//p" "$1" | head -1; }
CH_URL=$(envget /etc/langfuse/langfuse.env CLICKHOUSE_URL)
CH_PW=$(envget /etc/langfuse/host.env CLICKHOUSE_PASSWORD)
REDIS_HOST=$(envget /etc/langfuse/langfuse.env REDIS_HOST)
REDIS_PORT=$(envget /etc/langfuse/langfuse.env REDIS_PORT)
DB_URL=$(envget /etc/langfuse/host.env DATABASE_URL)
NEON_HOST=$(printf '%s' "$DB_URL" | sed -E 's#.*@([^:/]+):.*#\1#')
NEON_PW=$(printf '%s' "$DB_URL" | sed -E 's#postgresql://[^:]+:([^@]+)@.*#\1#')
CH0=$(printf '%s' "$CH_URL" | sed -E 's#http://([^:/]+).*#\1#')
NOW() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }
NANOS() { date +%s%N; }

api() { # method path [data]
  local m="$1" p="$2" d="${3:-}"
  if [ -n "$d" ]; then
    curl -sS --max-time 60 -u "$AUTH" -H 'Content-Type: application/json' -X "$m" --data-binary "$d" -w '\n%{http_code}' "$BASE$p"
  else
    curl -sS --max-time 60 -u "$AUTH" -X "$m" -w '\n%{http_code}' "$BASE$p"
  fi
}
otlp() { # OTLP JSON body -> http status
  curl -sS --max-time 60 -o /dev/null -w '%{http_code}' -u "$AUTH" -H 'Content-Type: application/json' \
    -H 'x-langfuse-ingestion-version: 4' --data-binary "$1" "$BASE/api/public/otel/v1/traces"
}
status_of() { printf '%s' "$1" | tail -1; }
body_of() { printf '%s' "$1" | sed '$d'; }
chq() { # host query -> result via HTTP with the langfuse user
  curl -sS --max-time 30 -H "X-ClickHouse-User: langfuse" -H "X-ClickHouse-Key: $CH_PW" \
    --data-binary "$2" "http://$1:8123/" 2>/dev/null
}
tcp_open() { timeout 3 bash -c "</dev/tcp/$1/$2" 2>/dev/null; }

# One trace: a root span carrying the trace name and tags, and a generation
# beneath it. Ids are OTel ids -- 32 and 16 hex characters.
span_json() { # trace-id span-id parent-id name type tag [model]
  local t="$1" s="$2" p="$3" n="$4" ty="$5" tag="$6" model="${7:-}" now later
  now=$(NANOS); later=$((now + 500000000))
  printf '{"traceId":"%s","spanId":"%s"%s,"name":"%s","kind":1,"startTimeUnixNano":"%s","endTimeUnixNano":"%s","attributes":[' \
    "$t" "$s" "$([ -n "$p" ] && printf ',"parentSpanId":"%s"' "$p")" "$n" "$now" "$later"
  printf '{"key":"langfuse.observation.type","value":{"stringValue":"%s"}},' "$ty"
  printf '{"key":"langfuse.trace.name","value":{"stringValue":"%s"}},' "$n"
  printf '{"key":"langfuse.trace.tags","value":{"arrayValue":{"values":[{"stringValue":"colors-smoke"},{"stringValue":"%s"}]}}},' "$tag"
  [ -n "$model" ] && printf '{"key":"langfuse.observation.model.name","value":{"stringValue":"%s"}},' "$model"
  printf '{"key":"langfuse.observation.input","value":{"stringValue":"is the whole path alive"}},'
  printf '{"key":"langfuse.observation.output","value":{"stringValue":"yes"}}]}'
}
otlp_body() { printf '{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"colors-smoke"}}]},"scopeSpans":[{"scope":{"name":"colors-smoke"},"spans":[%s]}]}]}' "$1"; }
ingest_trace() { # $1 trace id, $2 tag -> http status; also posts a score
  local t="$1" tag="$2" root gen st
  root=$(openssl rand -hex 8); gen=$(openssl rand -hex 8)
  st=$(otlp "$(otlp_body "$(span_json "$t" "$root" "" "colors-smoke" span "$tag"),$(span_json "$t" "$gen" "$root" "colors-smoke-generation" generation "$tag" colors-model)")")
  [ "$st" = "200" ] && api POST /api/public/scores "{\"traceId\":\"$t\",\"observationId\":\"$gen\",\"name\":\"colors-smoke-score\",\"value\":1}" >/dev/null
  printf '%s' "$st"
}
trace_rows() { # $1 trace id -> the v2 observation rows JSON
  api GET "/api/public/v2/observations?traceId=$1&fields=core,basic,trace_context&limit=50" | sed '$d'
}
wait_trace() { # $1 trace id, $2 seconds -> 0 when the root and the generation are readable
  local t="$1" deadline=$(( $(date +%s) + $2 )) rows n
  while [ "$(date +%s)" -lt "$deadline" ]; do
    rows=$(trace_rows "$t")
    n=$(printf '%s' "$rows" | python3 -c 'import json,sys; d=json.load(sys.stdin).get("data",[]); print(sum(1 for x in d if x.get("type") in ("SPAN","GENERATION")))' 2>/dev/null || echo 0)
    [ "${n:-0}" -ge 2 ] && { printf '%s' "$rows"; return 0; }
    sleep 3
  done
  return 1
}

if [ "$MODE" = "--enqueue-only" ]; then
  t=$(openssl rand -hex 16)
  st=$(ingest_trace "$t" "colors-drill")
  [ "$st" = "200" ] && { echo "$t"; exit 0; } || { echo "enqueue failed: $st" >&2; exit 1; }
fi
if [ "$MODE" = "--ingest-only" ]; then
  t=$(openssl rand -hex 16)
  st=$(ingest_trace "$t" "colors-drill")
  [ "$st" = "200" ] || { echo "ingest failed: $st" >&2; exit 1; }
  wait_trace "$t" 120 >/dev/null && { echo "trace $t readable"; exit 0; } || { echo "trace $t not readable within 120s" >&2; exit 1; }
fi

RUN="run-$(date -u +%Y%m%dT%H%M%SZ)"
RUN_START=$(date -u -d '-5 minutes' +%FT%TZ)

echo "== N: the network says what the firewall says =="
for target in "neon $NEON_HOST 55433" "redis $REDIS_HOST $REDIS_PORT" "clickhouse-0 $CH0 8123" "clickhouse-0 $CH0 9000"; do
  set -- $target
  tcp_open "$2" "$3" && pass "N1 $1 $2:$3 reachable by raw TCP" || fail "N1 $1 $2:$3 NOT reachable"
done
tcp_open "$CH0" "9181" && fail "N2 app reaches Keeper on $CH0:9181 -- the firewall is wider than desired state" \
                                              || pass "N2 app is refused on Keeper $CH0:9181"

echo "== T: both databases run in UTC =="
tz=$(env -i PATH=/usr/bin:/bin PGPASSWORD="$NEON_PW" psql -w "postgresql://langfuse@$NEON_HOST:55433/langfuse?connect_timeout=10" -tAc "SHOW timezone" 2>/dev/null | tr -d '[:space:]')
[ "$tz" = "UTC" ] && pass "T1 Postgres timezone UTC" || fail "T1 Postgres timezone is '${tz:-unreadable}'"
ctz=$(chq "$CH0" "SELECT timezone()" | tr -d '[:space:]')
[ "$ctz" = "UTC" ] && pass "T2 ClickHouse timezone UTC" || fail "T2 ClickHouse timezone is '${ctz:-unreadable}'"

echo "== K: the analytics tier is a cluster =="
reps=$(chq "$CH0" "SELECT count() FROM clusterAllReplicas('default', system.one)" | tr -d '[:space:]')
[ "$reps" = "3" ] && pass "K1 clusterAllReplicas sees 3 replicas" || fail "K1 clusterAllReplicas sees '${reps:-none}'"
kz=$(chq "$CH0" "SELECT count() FROM system.zookeeper WHERE path = '/'" | tr -d '[:space:]')
[ "${kz:-0}" -gt 0 ] && pass "K2 Keeper root readable ($kz entries)" || fail "K2 Keeper root not readable"

echo "== H: the application answers =="
h=$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' "$BASE/api/public/health?failIfDatabaseUnavailable=true")
[ "$h" = "200" ] && pass "H1 web health with the database" || fail "H1 web health answered $h"
w=$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' "http://127.0.0.1:3030/api/health?failIfQueueConsumptionStuck=true")
[ "$w" = "200" ] && pass "H2 worker health, queue consumers alive" || fail "H2 worker health answered $w"

echo "== I: one trace through the whole path =="
T=$(openssl rand -hex 16)
before=$(mktemp); rclone lsf --recursive --files-only "store:$STORE_BUCKET/${STORE_PREFIX}events/" 2>/dev/null | sort > "$before"
st=$(ingest_trace "$T" "$RUN")
[ "$st" = "200" ] && pass "I1 OTLP ingestion accepted ($st)" || fail "I1 OTLP ingestion answered $st"
if rows=$(wait_trace "$T" 120); then
  pass "I2 trace $T readable through the Observations API v2"
  printf '%s' "$rows" | python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]; sys.exit(0 if any(x.get("type")=="GENERATION" for x in d) else 1)' \
    && pass "I3 the generation is attached" || fail "I3 no GENERATION on the trace"
  printf '%s' "$rows" | python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]; sys.exit(0 if any(x.get("isRootObservation") and "colors-smoke" in (x.get("tags") or []) for x in d) else 1)' \
    && pass "I4 the root observation carries the trace tags" || fail "I4 no tagged root observation"
else
  fail "I2 trace $T not readable within 120s"
fi
printf '%s' "$T" > /var/lib/colors/smoke-trace-id
n0=$(chq "$CH0" "SELECT count() FROM events_full WHERE trace_id = '$T'" | tr -d '[:space:]')
[ "${n0:-0}" -ge 2 ] && pass "I5 $n0 event rows on clickhouse-0" || fail "I5 event rows missing on clickhouse-0 (${n0:-none})"
s0=""; for _ in $(seq 1 10); do s0=$(chq "$CH0" "SELECT count() FROM scores WHERE trace_id = '$T'" | tr -d '[:space:]'); [ "${s0:-0}" -ge 1 ] && break; sleep 3; done
[ "${s0:-0}" -ge 1 ] && pass "I6 the score row is on clickhouse-0" || fail "I6 score row missing on clickhouse-0"
CH2=$(chq "$CH0" "SELECT host_address FROM system.clusters WHERE cluster = 'default' ORDER BY replica_num DESC LIMIT 1" | tr -d '[:space:]')
if [ -n "$CH2" ]; then
  n2=""; for _ in $(seq 1 20); do n2=$(chq "$CH2" "SELECT count() FROM events_full WHERE trace_id = '$T'" | tr -d '[:space:]'); [ "${n2:-0}" -ge 2 ] && break; sleep 3; done
  [ "${n2:-0}" -ge 2 ] && pass "I7 event rows replicated to $CH2" || fail "I7 event rows NOT replicated to $CH2 within 60s"
else
  fail "I7 could not resolve the last replica from system.clusters"
fi
after=$(mktemp); new=""
for _ in $(seq 1 12); do
  rclone lsf --recursive --files-only "store:$STORE_BUCKET/${STORE_PREFIX}events/" 2>/dev/null | sort > "$after"
  new=$(comm -13 "$before" "$after" | head -1); [ -n "$new" ] && break; sleep 5
done
[ -n "$new" ] && pass "I8 a NEW raw event object landed under ${STORE_PREFIX}events/" || fail "I8 no new object under ${STORE_PREFIX}events/ after ingestion"
rm -f "$before" "$after"

echo "== M: the media path, SDK-style =="
media=$(mktemp); printf 'colors smoke media %s\n' "$RUN" > "$media"
len=$(stat -c%s "$media"); sha_b64=$(openssl dgst -sha256 -binary "$media" | base64 -w0); sha_hex=$(sha256sum "$media" | cut -d' ' -f1)
r=$(api POST /api/public/media "{\"traceId\":\"$T\",\"contentType\":\"text/plain\",\"contentLength\":$len,\"sha256Hash\":\"$sha_b64\",\"field\":\"input\"}")
case "$(status_of "$r")" in
  200|201)
    mid=$(body_of "$r" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("mediaId",""))')
    url=$(body_of "$r" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("uploadUrl") or "")')
    if [ -n "$url" ]; then
      up=$(curl -sS --max-time 60 -o /dev/null -w '%{http_code}' -X PUT -H 'Content-Type: text/plain' -H "x-amz-checksum-sha256: $sha_b64" --data-binary "@$media" "$url")
      [ "$up" = "200" ] && pass "M1 presigned upload to R2 accepted" || fail "M1 presigned upload answered $up"
      api PATCH "/api/public/media/$mid" "{\"uploadedAt\":\"$(NOW)\",\"uploadHttpStatus\":$up}" >/dev/null
    else
      pass "M1 media already present (deduplicated by hash)"
    fi
    g=$(api GET "/api/public/media/$mid")
    durl=$(body_of "$g" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("url",""))' 2>/dev/null)
    if [ -n "$durl" ]; then
      got=$(curl -sS --max-time 60 "$durl" | sha256sum | cut -d' ' -f1)
      [ "$got" = "$sha_hex" ] && pass "M2 media downloaded from R2 with the same sha256" || fail "M2 downloaded media sha256 differs"
    else
      fail "M2 no download URL for media $mid ($(status_of "$g"))"
    fi ;;
  *) fail "M1 POST /api/public/media answered $(status_of "$r"): $(body_of "$r" | head -c 300)" ;;
esac
rm -f "$media"
# Browser rendering of media needs CORS on the bucket, which only an admin
# token can set. Reported, never gated: the SDK path above needs none.
cors_hdr=$(curl -sS --max-time 20 -D - -o /dev/null -X OPTIONS -H "Origin: https://langfuse.fixture.example" -H 'Access-Control-Request-Method: GET' "https://fixture.r2.cloudflarestorage.com/$STORE_BUCKET/" 2>/dev/null | grep -ci 'access-control-allow-origin' || true)
[ "${cors_hdr:-0}" -gt 0 ] && pass "M3 the storage bucket answers CORS preflight for https://langfuse.fixture.example" \
  || warn "M3 no CORS on $STORE_BUCKET for https://langfuse.fixture.example: media renders in the UI only after the operator adds the CORS rule from the README"

echo "== L: an encrypted row exists for the restore rehearsal =="
r=$(api PUT /api/public/llm-connections "{\"provider\":\"colors-rehearsal\",\"adapter\":\"openai\",\"secretKey\":\"sk-colors-rehearsal-not-a-real-key-000000\",\"withDefaultModels\":false,\"customModels\":[\"colors-rehearsal-model\"]}")
case "$(status_of "$r")" in
  200|201) pass "L1 LLM connection colors-rehearsal upserted (encrypted with ENCRYPTION_KEY)" ;;
  *) fail "L1 PUT /api/public/llm-connections answered $(status_of "$r"): $(body_of "$r" | head -c 200)" ;;
esac
g=$(api GET /api/public/llm-connections)
printf '%s' "$(body_of "$g")" | python3 -c 'import json,sys; d=json.load(sys.stdin); xs=d.get("data",d if isinstance(d,list) else []); sys.exit(0 if any(x.get("provider")=="colors-rehearsal" and x.get("displaySecretKey") for x in xs) else 1)' 2>/dev/null \
  && pass "L2 the connection reads back with a display secret" || fail "L2 the connection did not read back"

echo "== A: the negative space =="
d=$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' -u "$PK:not-the-key" "$BASE/api/public/v2/observations?limit=1")
[ "$d" = "401" ] && pass "A1 wrong secret key refused ($d)" || fail "A1 wrong secret key answered $d"
a=$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' "$BASE/api/public/v2/observations?limit=1")
[ "$a" = "401" ] && pass "A2 unauthenticated request refused ($a)" || fail "A2 unauthenticated request answered $a"
rp=$(timeout 5 bash -c "exec 3<>/dev/tcp/$REDIS_HOST/$REDIS_PORT; printf 'PING\r\n' >&3; read -r -t 4 line <&3; printf '%s' \"\$line\"" 2>/dev/null | tr -d '\r')
case "$rp" in *NOAUTH*) pass "A3 unauthenticated Redis PING refused" ;; *) fail "A3 unauthenticated Redis PING answered '${rp:-nothing}'" ;; esac
cw=$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' -H "X-ClickHouse-User: langfuse" -H "X-ClickHouse-Key: not-the-password" --data-binary "SELECT 1" "http://$CH0:8123/")
[ "$cw" != "200" ] && pass "A4 wrong ClickHouse password refused ($cw)" || fail "A4 wrong ClickHouse password ACCEPTED"
if env -i PATH=/usr/bin:/bin PGPASSWORD="not-the-password" psql -w "postgresql://langfuse@$NEON_HOST:55433/langfuse?connect_timeout=10" -c "SELECT 1" >/dev/null 2>&1; then
  fail "A5 wrong Postgres password ACCEPTED"
else
  pass "A5 wrong Postgres password refused"
fi
lg=$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' -u "$AUTH" -H 'Content-Type: application/json' -X POST --data-binary "{\"batch\":[{\"id\":\"x\",\"type\":\"trace-create\",\"timestamp\":\"$(NOW)\",\"body\":{\"id\":\"legacy-$RUN\"}}]}" "$BASE/api/public/ingestion")
lr=$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' -u "$AUTH" "$BASE/api/public/traces/legacy-$RUN")
[ "$lr" = "404" ] && pass "A6 v4 write mode confirmed: legacy batch $lg, legacy trace read $lr" || warn "A6 legacy trace read answered $lr (write mode is not events_only?)"

echo "== P: throughput =="
N=200; sent=0; spans=""; i=0
while [ "$i" -lt "$N" ]; do
  t=$(openssl rand -hex 16); s=$(openssl rand -hex 8)
  spans="$spans$(span_json "$t" "$s" "" "colors-load-$RUN" span "$RUN-load"),"
  i=$((i+1))
  if [ $((i % 25)) -eq 0 ] || [ "$i" -eq "$N" ]; then
    st=$(otlp "$(otlp_body "${spans%,}")")
    [ "$st" = "200" ] && sent=$((sent + 25)) || fail "P1 load batch answered $st"
    spans=""
  fi
done
deadline=$(( $(date +%s) + 120 )); total=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  total=$(api GET "/api/public/v2/observations?name=colors-load-$RUN&isRootObservation=true&fromStartTime=$RUN_START&limit=1000" | sed '$d' | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("data",[])))' 2>/dev/null || echo 0)
  [ "${total:-0}" -ge "$N" ] && break; sleep 5
done
[ "${total:-0}" -ge "$N" ] && pass "P1 $N traces queryable within 120s" || fail "P1 only ${total:-0} of $N traces queryable within 120s"
mem=$(free | awk '/^Mem:/ {printf "%d", $3*100/$2}')
[ "${mem:-0}" -lt 85 ] && pass "P2 host memory ${mem}% after the load" || fail "P2 host memory ${mem}% after the load"

echo "== C: containers =="
ids=$(cd /opt/langfuse && docker compose ps -q | sort | tr '\n' ' ')
if [ -f /var/lib/colors/container-ids ] && [ "$(cat /var/lib/colors/container-ids)" = "$ids" ]; then
  pass "C1 no container recreated since the last converge"
else
  [ -f /var/lib/colors/container-ids ] && warn "C1 containers were recreated since the last converge (expected after a config change)" || pass "C1 first converge on this host"
fi
printf '%s' "$ids" > /var/lib/colors/container-ids

echo "== R: the ready marker =="
if [ "$rc" -eq 0 ]; then
  r2_put_string "$PROFILE" "store:$STORE_BUCKET/${STORE_PREFIX}.colors-ready" && pass "R1 ready marker written and read back" || fail "R1 ready marker could not be written"
else
  fail "R1 ready marker withheld: a gate failed"
fi

[ "$rc" -eq 0 ] && echo "acceptance: all gates passed" || echo "acceptance: FAILED" >&2
exit "$rc"
