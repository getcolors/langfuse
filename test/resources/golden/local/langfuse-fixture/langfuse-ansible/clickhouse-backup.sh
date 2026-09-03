#!/usr/bin/env bash
# A ClickHouse backup set: native BACKUP of the `default` database to the
# backup disk (an S3 disk on the backup bucket -- the credential lives in
# that disk's configuration and never in this statement), then the manifest,
# then the completion marker LAST. Restore picks completed sets only.
set -euo pipefail
. /opt/colors/r2-env.sh
STAMP=$(stamp_now)
PREFIX="backup:$BACKUP_BUCKET/$PROFILE/clickhouse"
admin_pw=$(cat /etc/clickhouse-secrets/admin_password)
cq() { clickhouse-client --user admin --password "$admin_pw" --query "$1"; }

status=$(cq "BACKUP DATABASE default TO Disk('backups', '$STAMP/') SETTINGS async = 0 FORMAT TSV" | cut -f2)
[ "$status" = "BACKUP_CREATED" ] || { echo "clickhouse-backup: BACKUP returned '$status'" >&2; exit 1; }

# Verify what landed: objects under the set, including ClickHouse's own
# `.backup` metadata file, which it writes last.
count=$(rclone lsf --recursive --files-only "$PREFIX/$STAMP/" 2>/dev/null | grep -c . || true)
[ "${count:-0}" -gt 0 ] || { echo "clickhouse-backup: no objects under $STAMP/" >&2; exit 1; }
rclone lsf --files-only "$PREFIX/$STAMP/" 2>/dev/null | grep -qx '.backup' \
  || { echo "clickhouse-backup: .backup metadata missing under $STAMP/" >&2; exit 1; }
bytes=$(rclone size --json "$PREFIX/$STAMP/" | python3 -c 'import json,sys; print(json.load(sys.stdin)["bytes"])')
tables=$(cq "SELECT count() FROM system.tables WHERE database = 'default'")
completed=$(stamp_now)

manifest=$(mktemp)
{
  printf 'stamp=%s\n' "$STAMP"
  printf 'completed_at=%s\n' "$completed"
  printf 'clickhouse_version=%s\n' "26.3.29.7"
  printf 'tables=%s\n' "$tables"
  printf 'objects=%s\n' "$count"
  printf 'bytes=%s\n' "$bytes"
} > "$manifest"
r2_put "$manifest" "$PREFIX/$STAMP/manifest.txt"
rm -f "$manifest"
r2_put_string "$completed" "$PREFIX/$STAMP/.complete"

prune_sets "$PREFIX" || true
echo "clickhouse-backup: set $STAMP complete ($count objects, $bytes bytes)"
echo "stamp=$STAMP"
