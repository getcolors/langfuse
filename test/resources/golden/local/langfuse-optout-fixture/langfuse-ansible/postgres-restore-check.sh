#!/usr/bin/env bash
# Restore a completed Postgres set into `langfuse_restore_check` on the live
# compute, OWNED by the application role and restored AS that role, so the
# scratch web -- which connects as that role -- has full privileges. A
# checksum proves the set is intact; the boot on the app host proves it is a
# recovery.
#
# Usage: postgres-restore-check <stamp>
set -euo pipefail
cd /opt/neon
. /opt/colors/r2-env.sh
SET="${1:?usage: postgres-restore-check <stamp>}"
PREFIX="backup:$BACKUP_BUCKET/$PROFILE/postgres"
SCRATCH=langfuse_restore_check
WORK=$(mktemp -d /var/tmp/postgres-restore.XXXXXX)
trap 'rm -rf "$WORK"' EXIT
[ -n "$(set_complete "$PREFIX" "$SET")" ] || { echo "postgres-restore-check: set $SET is not complete" >&2; exit 1; }

rclone copyto "$PREFIX/$SET/langfuse.dump" "$WORK/langfuse.dump"
rclone copyto "$PREFIX/$SET/manifest.txt" "$WORK/manifest.txt"
. "$WORK/manifest.txt"
[ "$(sha256sum "$WORK/langfuse.dump" | cut -d' ' -f1)" = "$dump_sha256" ] \
  || { echo "postgres-restore-check: dump checksum mismatch" >&2; exit 1; }

admin_pw=$(cat /etc/neon/secrets/cloud_admin_password)
role_pw=$(cat /etc/neon/secrets/neon_role_password)
psql_admin() { env -i PATH=/usr/bin:/bin PGPASSWORD="$admin_pw" psql -w "postgresql://cloud_admin@127.0.0.1:55433/postgres?connect_timeout=10" -v ON_ERROR_STOP=1 -tAc "$1"; }
psql_scratch() { env -i PATH=/usr/bin:/bin PGPASSWORD="$role_pw" psql -w "postgresql://langfuse@127.0.0.1:55433/$SCRATCH?connect_timeout=10" -tAc "$1"; }

psql_admin "DROP DATABASE IF EXISTS $SCRATCH WITH (FORCE)" >/dev/null
psql_admin "CREATE DATABASE $SCRATCH OWNER langfuse" >/dev/null
# The dump is piped on stdin: the compute container mounts a tmpfs on /tmp,
# and a `docker compose cp` lands underneath it. pg_restore from the compute
# image for the same reason pg_dump runs there.
# Failures are not discarded: a partial restore with SOME tables would pass
# the counts below and reach the boot. Only one diagnostic is benign here —
# the dump carries COMMENT ON EXTENSION plpgsql, which the application role
# may not own — and every other error line fails the restore.
docker compose exec -T compute env PGPASSWORD="$role_pw" \
  pg_restore -w --no-owner --no-acl -h 127.0.0.1 -p 55433 -U langfuse -d "$SCRATCH" < "$WORK/langfuse.dump" 2>"$WORK/restore.log" || true
bad=$(grep -E '^pg_restore: (error|warning):' "$WORK/restore.log" | grep -vE 'must be owner of extension|errors ignored on restore' | grep -c . || true)
if [ "${bad:-0}" -gt 0 ]; then
  echo "postgres-restore-check: pg_restore reported $bad error lines:" >&2; grep -E '^pg_restore: (error|warning):' "$WORK/restore.log" | head -5 >&2; exit 1
fi
tables=$(psql_scratch "select count(*) from information_schema.tables where table_schema='public'")
[ "${tables:-0}" -gt 0 ] || { echo "postgres-restore-check: the restore produced no tables" >&2; tail -5 "$WORK/restore.log" >&2; exit 1; }
foreign=$(psql_scratch "select count(*) from pg_tables where schemaname='public' and tableowner <> 'langfuse'")
[ "${foreign:-1}" = "0" ] || { echo "postgres-restore-check: $foreign tables are not owned by langfuse" >&2; exit 1; }
projects=$(psql_scratch "select count(*) from projects" 2>/dev/null || echo "n/a")
echo "postgres-restore-check: restored $SET into $SCRATCH ($tables tables, $projects projects), all owned by langfuse"
