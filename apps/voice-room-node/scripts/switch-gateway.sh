#!/usr/bin/env bash
set -euo pipefail

# Switches the OpenClaw gateway from the box's global install (protocol v3) to
# THIS repo's built gateway (protocol v4) so the voice-room node can connect.
#
# Why: the node's client (packages/gateway-client) speaks gateway protocol v4,
# but the running global openclaw 2026.5.7 systemd gateway speaks v3, so it
# rejects the node with "protocol mismatch". A v3<->v4 gap is a breaking bump —
# both ends must be the same version.
#
# Runs the v4 gateway in the FOREGROUND — keep this terminal open. Then, in
# ANOTHER terminal:  export ELEVENLABS_API_KEY=… && scripts/run-turn.sh
#
# Steps: stop the old v3 service, back up ~/.openclaw (a v4 gateway may migrate
# it irreversibly vs v3), start the repo v4 gateway on the port. Re-runnable.
#
# Env:
#   GATEWAY_PORT=18789   port to serve (default 18789)
#   SKIP_BACKUP=1        skip the ~/.openclaw backup (e.g. on re-runs)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"
GATEWAY_PORT="${GATEWAY_PORT:-18789}"
STATE_DIR="$HOME/.openclaw"

# Soft check: the repo's built gateway should be protocol v4 (matches the node's
# client). Warn, don't block — a stale dist is the likely cause if it isn't.
if ! grep -rqE "PROTOCOL_VERSION *= *4([^0-9]|$)" "$REPO_ROOT/dist" 2>/dev/null; then
  echo "WARN: could not confirm protocol v4 in $REPO_ROOT/dist (build may be stale)." >&2
  echo "      If connect still fails with 'protocol mismatch', run:" >&2
  echo "        (cd $REPO_ROOT && pnpm build)" >&2
fi

# 1. Stop the old (v3) gateway first, so the backup below is a consistent copy
#    (not a mid-write SQLite). `openclaw gateway stop` handles the systemd/
#    launchd service so it does not auto-restart under linger.
if command -v openclaw >/dev/null 2>&1; then
  echo "==> Stopping the existing (global) gateway service…"
  openclaw gateway stop || echo "    (nothing to stop, or already stopped)"
else
  echo "WARN: global 'openclaw' not on PATH; skipping service stop. If a stale" >&2
  echo "      gateway still holds :$GATEWAY_PORT, the --force below frees it." >&2
fi

# 2. Back up state (now that the writer is stopped). Skip on re-runs / opt-out.
if [[ "${SKIP_BACKUP:-}" == "1" ]]; then
  echo "==> Skipping state backup (SKIP_BACKUP=1)."
elif [[ -d "$STATE_DIR" ]]; then
  BACKUP_DIR="$STATE_DIR.bak-$(date +%Y%m%d)"
  if [[ -e "$BACKUP_DIR" ]]; then
    echo "==> Backup already exists, leaving it: $BACKUP_DIR"
  else
    echo "==> Backing up $STATE_DIR -> $BACKUP_DIR (may take a moment)…"
    cp -a "$STATE_DIR" "$BACKUP_DIR"
  fi
else
  echo "==> No $STATE_DIR to back up."
fi

# 3. Start THIS repo's v4 gateway in the foreground. --force frees the port if a
#    stale listener remains. First start may run state migrations (expected).
echo "==> Starting repo gateway (protocol v4) on :$GATEWAY_PORT."
echo "    Keep this terminal open. In another terminal:"
echo "      export ELEVENLABS_API_KEY=…"
echo "      bash $APP_DIR/scripts/run-turn.sh"
cd "$REPO_ROOT"
exec pnpm openclaw gateway --port "$GATEWAY_PORT" --force
