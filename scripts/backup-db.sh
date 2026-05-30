#!/usr/bin/env bash
# Nightly Postgres backup — minimal, cron-friendly.
#
# Schedules `pg_dump --format=custom` into $BACKUP_DIR with a date-stamped
# filename, then prunes anything older than $BACKUP_KEEP_DAYS (default 14).
# Deliberately does NOT ship the offsite step (S3 sync, restic, borg); that
# belongs in the operator's environment.
#
# Required env:
#   BACKUP_DIR         where to drop the dump (e.g. /var/lib/hearme-backups)
#   PGHOST PGUSER PGPASSWORD PGDATABASE — standard libpq env vars (no DSN
#                                          parsing here; let libpq handle it)
#
# Optional:
#   BACKUP_KEEP_DAYS   prune dumps older than this many days (default 14)
#
# Cron example (daily 03:17 UTC):
#   17 3 * * * BACKUP_DIR=/var/lib/hearme-backups \
#              PGHOST=db PGUSER=hearme_admin PGDATABASE=hearme \
#              PGPASSWORD=$(cat /run/secrets/pg-admin-pw) \
#              /opt/hearme/scripts/backup-db.sh >> /var/log/hearme-backup.log 2>&1
#
# After restoring, run scripts/verify-db.sh against the restored DB before
# pointing the broker at it.

set -euo pipefail

: "${BACKUP_DIR:?must set BACKUP_DIR}"
: "${PGHOST:?must set PGHOST}"
: "${PGUSER:?must set PGUSER}"
: "${PGDATABASE:?must set PGDATABASE}"
# PGPASSWORD intentionally not 'required' — libpq also reads from ~/.pgpass.

KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

mkdir -p "$BACKUP_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/hearme-$stamp.dump"
tmp="$out.partial"

echo "[backup-db] $(date -uIs) starting $PGDATABASE → $out"

# --format=custom is required for `pg_restore`'s parallel/selective restore.
# --no-owner / --no-privileges keep the dump portable across hosts.
if pg_dump --format=custom --no-owner --no-privileges --file="$tmp"; then
    mv "$tmp" "$out"
    echo "[backup-db] $(date -uIs) wrote $(stat -c%s "$out") bytes"
else
    rc=$?
    rm -f "$tmp"
    echo "[backup-db] $(date -uIs) pg_dump FAILED (rc=$rc)" >&2
    exit "$rc"
fi

# Prune. -mtime +N matches files modified MORE than N*24h ago.
removed=$(find "$BACKUP_DIR" -maxdepth 1 -name 'hearme-*.dump' -type f -mtime "+$KEEP_DAYS" -print -delete | wc -l)
if [ "$removed" -gt 0 ]; then
    echo "[backup-db] $(date -uIs) pruned $removed dump(s) older than $KEEP_DAYS days"
fi
