#!/usr/bin/env bash
# Restore a completed ClickHouse set into the `restore_check` database on this
# node, and pick the Postgres set it pairs with.
#
# Pairing is decided here, at restore time: the OLDEST completed Postgres dump
# that finished AFTER this ClickHouse set completed, so Postgres (projects,
# keys, prompts) is always the newer snapshot and every project a restored
# trace references exists. A ClickHouse set with no later dump is refused
# rather than paired backwards.
#
# Usage: clickhouse-restore-check [--pair] [<stamp>]
#   --pair   choose the newest completed set that has a later Postgres dump
set -euo pipefail
. /opt/colors/r2-env.sh
CH="backup:$BACKUP_BUCKET/$PROFILE/clickhouse"
PG="backup:$BACKUP_BUCKET/$PROFILE/postgres"
admin_pw=$(cat /etc/clickhouse-secrets/admin_password)
cq() { clickhouse-client --user admin --password "$admin_pw" --query "$1"; }

pair_for() { # $1 clickhouse stamp -> postgres stamp, or empty
  local done_at s c
  done_at=$(set_complete "$CH" "$1")
  for s in $(completed_sets "$PG"); do
    c=$(set_complete "$PG" "$s")
    if [ "$c" \> "$done_at" ]; then echo "$s"; return; fi
  done
}

set=""; pg=""
if [ "${1:-}" = "--pair" ]; then
  for s in $(completed_sets "$CH" | sort -r); do
    pg=$(pair_for "$s"); [ -n "$pg" ] && { set="$s"; break; }
  done
  [ -n "$set" ] || { echo "clickhouse-restore-check: no completed ClickHouse set has a later Postgres dump" >&2; exit 1; }
else
  set="${1:?usage: clickhouse-restore-check [--pair] [<stamp>]}"
  [ -n "$(set_complete "$CH" "$set")" ] || { echo "clickhouse-restore-check: set $set is not complete" >&2; exit 1; }
  pg=$(pair_for "$set")
fi

cq "DROP DATABASE IF EXISTS restore_check SYNC"
status=$(cq "RESTORE DATABASE default AS restore_check FROM Disk('backups', '$set/') SETTINGS async = 0 FORMAT TSV" | cut -f2)
[ "$status" = "RESTORED" ] || { echo "clickhouse-restore-check: RESTORE returned '$status'" >&2; exit 1; }

tables=$(cq "SELECT count() FROM system.tables WHERE database = 'restore_check'")
[ "${tables:-0}" -gt 0 ] || { echo "clickhouse-restore-check: the restore produced no tables" >&2; exit 1; }
# The restored replicated tables must register under their own Keeper paths:
# {uuid} in default_replica_path plus the new UUIDs RESTORE assigns.
collisions=$(cq "SELECT count() FROM system.replicas WHERE database = 'restore_check' AND zookeeper_path IN (SELECT zookeeper_path FROM system.replicas WHERE database = 'default')")
[ "${collisions:-1}" = "0" ] || { echo "clickhouse-restore-check: $collisions restored tables share a Keeper path with the live database" >&2; exit 1; }
# events_full, not traces: on Langfuse v4 the traces table is migrated and empty.
events=$(cq "SELECT count() FROM restore_check.events_full" 2>/dev/null || echo "n/a")

echo "clickhouse-restore-check: restored $set into restore_check ($tables tables, $events event rows), paired with postgres set ${pg:-none}"
echo "clickhouse_set=$set"
echo "postgres_set=$pg"
