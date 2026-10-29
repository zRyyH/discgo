#!/bin/sh
# Daily pg_dump to S3 at $BACKUP_AT (UTC, HH:MM). `backup.sh now` runs one backup and exits.
set -eu

run() {
  name="discgo-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
  echo "backup: dumping to $BACKUP_S3_URI/$name"
  pg_dump --no-owner --format=plain | gzip -9 | aws s3 cp - "$BACKUP_S3_URI/$name" --only-show-errors
  echo "backup: done"
}

if [ "${1:-}" = "now" ]; then
  run
  exit 0
fi

while :; do
  now=$(date -u +%s)
  next=$(date -u -d "$(date -u +%Y-%m-%d) $BACKUP_AT" +%s 2>/dev/null || date -u -D "%Y-%m-%d %H:%M" -d "$(date -u +%Y-%m-%d) $BACKUP_AT" +%s)
  [ "$next" -le "$now" ] && next=$((next + 86400))
  sleep $((next - now))
  run || echo "backup: FAILED" >&2
done
