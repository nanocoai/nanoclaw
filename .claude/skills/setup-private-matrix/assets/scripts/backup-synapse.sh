#!/usr/bin/env bash
# Backs up Synapse data to Google Drive, encrypted with age.
# Encryption key: age key pair at ~/.config/nanoclaw/backup-age-key
# Recovery:
#   1. Download backup-age-key.enc from gdrive:nanoclaw-backups/
#   2. RECOVERY_KEY=$(grep '^MATRIX_RECOVERY_KEY=' /path/to/.env | cut -d= -f2-)
#      echo "$RECOVERY_KEY" | openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
#        -pass stdin -in backup-age-key.enc -out backup-age-key
#   3. age --decrypt -i backup-age-key synapse-YYYYMMDD-HHMMSS.tar.gz.age | tar -xzf -
set -euo pipefail

NANOCLAW_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SYNAPSE_DATA="${SYNAPSE_DATA:-$HOME/synapse-data}"
# Your OWN age public key. /setup-private-matrix step 12b generates a fresh keypair
# per install and step 12e writes the public half in here (or set it via env).
AGE_PUBLIC_KEY="${AGE_PUBLIC_KEY:-age1REPLACE_WITH_YOUR_PUBLIC_KEY}"
RCLONE_REMOTE="${RCLONE_REMOTE:-gdrive:nanoclaw-backups/synapse}"
KEEP=14
LOG="$NANOCLAW_DIR/logs/backup-synapse.log"

# Fail closed: never encrypt backups to an unconfigured or foreign key. Without this,
# running before step 12e would silently encrypt to a key whose private half you lack.
case "$AGE_PUBLIC_KEY" in
  age1REPLACE_WITH_YOUR_PUBLIC_KEY | "")
    echo "ERROR: AGE_PUBLIC_KEY is not configured — refusing to encrypt backups to an unknown key." >&2
    echo "Run /setup-private-matrix step 12 (it generates your keypair), or export AGE_PUBLIC_KEY=<your age public key>." >&2
    exit 1
    ;;
esac

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

TMPDIR="$(mktemp -d)"
ARCHIVE=""
trap '[[ -n "$ARCHIVE" ]] && rm -f "$ARCHIVE"; rm -rf "$TMPDIR"' EXIT

log "=== Synapse backup starting ==="

# Consistent SQLite snapshot (works while Synapse is running — WAL safe)
log "Snapshotting SQLite database..."
sqlite3 "$SYNAPSE_DATA/homeserver.db" ".backup '$TMPDIR/homeserver.db'"

# Copy the rest
cp "$SYNAPSE_DATA/homeserver.yaml" "$TMPDIR/"
cp "$SYNAPSE_DATA/"*.signing.key "$TMPDIR/" 2>/dev/null || true
if [[ -d "$SYNAPSE_DATA/media_store" ]]; then
    cp -r "$SYNAPSE_DATA/media_store" "$TMPDIR/"
fi

DATE="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="/tmp/synapse-$DATE.tar.gz.age"

log "Encrypting..."
tar -czf - -C "$TMPDIR" . | age -r "$AGE_PUBLIC_KEY" -o "$ARCHIVE"

log "Uploading $(du -sh "$ARCHIVE" | cut -f1) to $RCLONE_REMOTE ..."
rclone copy "$ARCHIVE" "$RCLONE_REMOTE" --log-level ERROR 2>>"$LOG"
rm -f "$ARCHIVE"; ARCHIVE=""

# Prune — keep the KEEP most recent backups
log "Pruning (keeping $KEEP most recent)..."
TOTAL=$(rclone lsf "$RCLONE_REMOTE" 2>/dev/null | wc -l | tr -d ' ')
DELETE=$(( TOTAL - KEEP ))
if (( DELETE > 0 )); then
    rclone lsf "$RCLONE_REMOTE" --format "t;n" 2>/dev/null \
    | sort | head -n "$DELETE" | cut -d';' -f2 \
    | while IFS= read -r f; do
        rclone deletefile "$RCLONE_REMOTE/$f" 2>>"$LOG" && log "Deleted $f"
    done
fi

log "=== Backup complete: synapse-$DATE.tar.gz.age ==="
