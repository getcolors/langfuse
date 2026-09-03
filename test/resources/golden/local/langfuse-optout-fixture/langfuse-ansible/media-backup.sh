#!/usr/bin/env bash
# The media archive: an ADDITIVE copy of the live media prefix into the backup
# bucket. `rclone copy`, never `sync`, so a deletion on the live prefix is
# never mirrored; media objects are content-addressed and immutable, so an
# additive archive is exact and is never pruned. After the copy, the WHOLE
# destination prefix is checked against the source, and only then is the
# run's marker written.
set -euo pipefail
. /opt/colors/r2-env.sh
STAMP=$(stamp_now)
SRC="store:$STORE_BUCKET/${STORE_PREFIX}media"
DST="backup:$BACKUP_BUCKET/$PROFILE/media"
RUNS="backup:$BACKUP_BUCKET/$PROFILE/media-runs"

rclone copy "$SRC" "$DST" --transfers 8 2>/dev/null || true
# --one-way: every source object must exist at the destination with the same
# size and hash; extra destination objects (archived after a live deletion)
# are expected and not a difference.
if ! rclone check --one-way "$SRC" "$DST" 2>/tmp/media-check.err; then
  echo "media-backup: destination differs from source:" >&2; tail -5 /tmp/media-check.err >&2; exit 1
fi
# Every destination object with its hash. The live check above covers what
# is still on the live prefix; an object that was archived and has since been
# deleted live is covered by comparing this listing against the PREVIOUS
# run's manifest: whatever was archived before must still be there with the
# same hash, or the copy has been corrupted and the run must not complete.
hashes=$(mktemp)
rclone hashsum MD5 "$DST/" 2>/dev/null | sort -k2 > "$hashes"
count=$(grep -c . "$hashes" || true)
prev=$(newest_completed_set "$RUNS")
if [ -n "$prev" ]; then
  prevhashes=$(mktemp)
  rclone cat "$RUNS/$prev/manifest.txt" 2>/dev/null | sed -n 's/^hash=//p' | sort -k2 > "$prevhashes"
  missing=$(comm -23 "$prevhashes" "$hashes" | head -3)
  if [ -n "$missing" ]; then
    echo "media-backup: archived objects changed or vanished since run $prev:" >&2; printf '%s\n' "$missing" >&2
    rm -f "$hashes" "$prevhashes"; exit 1
  fi
  rm -f "$prevhashes"
fi
manifest=$(mktemp)
{
  printf 'stamp=%s\n' "$STAMP"
  printf 'objects=%s\n' "$count"
  sed 's/^/hash=/' "$hashes"
} > "$manifest"
rm -f "$hashes"
r2_put "$manifest" "$RUNS/$STAMP/manifest.txt"
rm -f "$manifest"
r2_put_string "$(stamp_now)" "$RUNS/$STAMP/.complete"
echo "media-backup: run $STAMP complete ($count objects archived, every hash recorded)"
