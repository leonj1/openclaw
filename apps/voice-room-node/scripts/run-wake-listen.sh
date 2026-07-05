#!/usr/bin/env bash
set -euo pipefail

# Runs the Layer 1 live wake-word listener — the on-hardware confirmation gate.
# Ensures the app deps and openWakeWord models are present, then starts the
# listener on the mic. Say "Hey Jarvis" and it prints `WAKE score=… ts=…` and
# plays a short beep. Ctrl-C (SIGTERM) to stop. No gateway / no OpenClaw.
#
# Just run it: `scripts/run-wake-listen.sh` — it defaults to the Anker PowerConf
# USB speakerphone (mic + speaker in one unit), which is not the ALSA `default`
# card on this box. Override for other hardware via args or env:
#   scripts/run-wake-listen.sh [CAPTURE_DEVICE] [PLAYBACK_DEVICE]
# List device names with `arecord -L` (use the `plughw:CARD=…,DEV=0` form).

# Default ALSA devices. `CARD=` names are stable across reboots/re-plug and index
# changes, so the PowerConf resolves the same regardless of its card number.
DEFAULT_CAPTURE_DEVICE="plughw:CARD=PowerConf,DEV=0"
DEFAULT_PLAYBACK_DEVICE="plughw:CARD=PowerConf,DEV=0"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"

# Preflight: x86_64 Linux + ALSA tools. Fails closed on other arches or when
# arecord/aplay are missing (this layer needs a real mic to be useful).
echo "==> Checking environment (arch + ALSA tools)…"
bash "$APP_DIR/scripts/check-env.sh"

# App-local native dep (onnxruntime-node); the app is outside the pnpm workspace.
if [[ ! -d "$APP_DIR/node_modules/onnxruntime-node" ]]; then
  echo "==> Installing app dependencies (onnxruntime-node)…"
  ( cd "$APP_DIR" && npm install )
fi

# openWakeWord models (mel + embedding + hey_jarvis); fetch only when absent.
MODELS_DIR="$APP_DIR/models"
if [[ -f "$MODELS_DIR/hey_jarvis_v0.1.onnx" \
   && -f "$MODELS_DIR/melspectrogram.onnx" \
   && -f "$MODELS_DIR/embedding_model.onnx" ]]; then
  echo "==> Models present."
else
  echo "==> Fetching openWakeWord models…"
  bash "$APP_DIR/scripts/fetch-models.sh"
fi

# The TypeScript entry runs through the repo-root tsx runner.
if [[ ! -x "$REPO_ROOT/node_modules/.bin/tsx" ]]; then
  echo "ERROR: repo-root tsx not found. Run 'pnpm install' in $REPO_ROOT first." >&2
  exit 1
fi

# Resolve ALSA devices: positional arg wins, else any pre-set env var, else the
# PowerConf default. These env vars are what the config loader honors, so Layer 1
# needs no config file.
export OPENCLAW_VOICE_ROOM_CAPTURE_DEVICE="${1:-${OPENCLAW_VOICE_ROOM_CAPTURE_DEVICE:-$DEFAULT_CAPTURE_DEVICE}}"
export OPENCLAW_VOICE_ROOM_PLAYBACK_DEVICE="${2:-${OPENCLAW_VOICE_ROOM_PLAYBACK_DEVICE:-$DEFAULT_PLAYBACK_DEVICE}}"
echo "==> Capture device:  $OPENCLAW_VOICE_ROOM_CAPTURE_DEVICE"
echo "==> Playback device: $OPENCLAW_VOICE_ROOM_PLAYBACK_DEVICE"

echo '==> Starting listener. Say "Hey Jarvis" (Ctrl-C to stop).'
cd "$REPO_ROOT"
exec node_modules/.bin/tsx apps/voice-room-node/src/wake/wake-listen.ts
