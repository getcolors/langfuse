#!/usr/bin/env bash
# A Postgres backup set: one custom-format dump of the Langfuse database, its
# manifest with checksums, and the completion marker LAST, written only after
# every uploaded object has been verified against the local copy.
#
# pg_dump runs INSIDE the compute container: Ubuntu's client is 16 and Neon's
# compute serves 17, and pg_dump refuses that gap outright (`aborting because
# of server version mismatch`). A custom-format dump is its own consistent
# snapshot, so the application is not stopped for it.
set -euo pipefail
cd /opt/neon
. /opt/colors/r2-env.sh
STAMP=$(stamp_now)
PREFIX="backup:$BACKUP_BUCKET/$PROFILE/postgres"
WORK=$(mktemp -d /var/tmp/postgres-backup.XXXXXX)
trap 'rm -rf "$WORK"' EXIT

docker compose exec -T compute env PGPASSWORD="$(cat /etc/neon/secrets/cloud_admin_password)" \
  pg_dump -w --format=custom --no-owner --no-acl \
  -h 127.0.0.1 -p 55433 -U cloud_admin "langfuse" > "$WORK/langfuse.dump"
bytes=$(stat -c%s "$WORK/langfuse.dump")
[ "$bytes" -gt 0 ] || { echo "postgres-backup: empty dump" >&2; exit 1; }
sha=$(sha256sum "$WORK/langfuse.dump" | cut -d' ' -f1)

{
  printf 'stamp=%s\n' "$STAMP"
  printf 'database=%s\n' "langfuse"
  printf 'compute_image=%s\n' "ghcr.io/neondatabase/compute-node-v17:release-compute-9073@sha256:ed6a613231d7026b4df8b00563444b9f33745370a3b3f0a2183e723f460ba974"
  printf 'dump_sha256=%s\n' "$sha"
  printf 'dump_bytes=%s\n' "$bytes"
} > "$WORK/manifest.txt"

r2_put "$WORK/langfuse.dump" "$PREFIX/$STAMP/langfuse.dump"
r2_put "$WORK/manifest.txt" "$PREFIX/$STAMP/manifest.txt"
# Verified by read-back: the object's size must match, and its content must
# hash to what the manifest says, before the marker is written.
remote_bytes=$(rclone lsjson "$PREFIX/$STAMP/langfuse.dump" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["Size"])')
[ "$remote_bytes" = "$bytes" ] || { echo "postgres-backup: uploaded size $remote_bytes != $bytes" >&2; exit 1; }
remote_sha=$(rclone cat "$PREFIX/$STAMP/langfuse.dump" | sha256sum | cut -d' ' -f1)
[ "$remote_sha" = "$sha" ] || { echo "postgres-backup: uploaded sha256 differs" >&2; exit 1; }
completed=$(stamp_now)
r2_put_string "$completed" "$PREFIX/$STAMP/.complete"

prune_sets "$PREFIX" || true
echo "postgres-backup: set $STAMP complete ($bytes bytes)"
echo "stamp=$STAMP"
