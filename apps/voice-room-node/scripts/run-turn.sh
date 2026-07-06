#!/usr/bin/env bash
set -euo pipefail

# Runs the Layer 2 live confirmation gate — a full spoken turn against a real
# gateway/OpenClaw and real ElevenLabs STT/TTS. This is NOT a test (no pass/fail
# assertions); you judge it by ear: say "Hey Jarvis", ask a question, hear the
# wait loop while OpenClaw thinks, then a succinct 1-2 sentence spoken reply.
# The automated integration coverage is talk-node.integration.test.ts.
#
# Set your key first, then run:
#   export ELEVENLABS_API_KEY=sk_...
#   scripts/run-turn.sh [CAPTURE_DEVICE] [PLAYBACK_DEVICE]
# Devices default to the Anker PowerConf; override via args (arecord -L to list).
#
# Gateway target comes from your node config (~/.openclaw/voice-room.json or
# OPENCLAW_VOICE_ROOM_CONFIG) or env: OPENCLAW_VOICE_ROOM_GATEWAY_URL plus the
# auth token in OPENCLAW_VOICE_ROOM_TOKEN. Optional OPENCLAW_VOICE_ROOM_SESSION_KEY
# selects the conversation (default "voice-room").

DEFAULT_CAPTURE_DEVICE="plughw:CARD=PowerConf,DEV=0"
DEFAULT_PLAYBACK_DEVICE="plughw:CARD=PowerConf,DEV=0"

# Gateway target baked in so you don't re-export it each run. Override any time by
# exporting OPENCLAW_VOICE_ROOM_GATEWAY_URL. Local default is the standard gateway
# port (18789); use a wss:// URL for a remote/TLS gateway.
DEFAULT_GATEWAY_URL="ws://127.0.0.1:18789"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"

# Preflight: x86_64 Linux + ALSA tools. Fails closed elsewhere.
echo "==> Checking environment (arch + ALSA tools)…"
bash "$APP_DIR/scripts/check-env.sh"

# ElevenLabs key is required for STT + TTS (env-only; never printed).
if [[ -z "${ELEVENLABS_API_KEY:-}" ]]; then
  echo "ERROR: ELEVENLABS_API_KEY is not set. Export it first:" >&2
  echo "       export ELEVENLABS_API_KEY=sk_..." >&2
  exit 1
fi
echo "==> ElevenLabs key: present"

# TTS voice. This box's ambient ELEVENLABS_VOICE_ID points at a voice the free
# ElevenLabs plan cannot synthesize via the API (cloned -> 401, library -> 402),
# so pin a built-in premade voice that works. Change this line (or upgrade the
# plan and drop it) to use a different voice.
export ELEVENLABS_VOICE_ID="pNInz6obpgDQGcFmaJgB"  # Adam (premade; free-tier OK)
echo "==> TTS voice: $ELEVENLABS_VOICE_ID (premade)"

# Gateway URL: an explicit export wins, else the baked default above.
export OPENCLAW_VOICE_ROOM_GATEWAY_URL="${OPENCLAW_VOICE_ROOM_GATEWAY_URL:-$DEFAULT_GATEWAY_URL}"
echo "==> Gateway URL:     $OPENCLAW_VOICE_ROOM_GATEWAY_URL"

# Auto-source the gateway auth token from the OpenClaw node config when the env
# var is unset, so operators don't re-export it each run. The token is a plain
# literal at gateway.auth.token in ~/.openclaw/openclaw.json (mode "token"). Read
# it via node WITHOUT printing the value, and ignore an empty token or an unresolved
# ${...} env-ref (those aren't real literals). Only the default token env var is
# populated here; a custom OPENCLAW_VOICE_ROOM_TOKEN_ENV is the operator's to set.
if [[ -z "${OPENCLAW_VOICE_ROOM_TOKEN:-}" && -z "${OPENCLAW_VOICE_ROOM_TOKEN_ENV:-}" ]]; then
  SOURCED_TOKEN="$(node -e 'const t=(require(process.env.HOME+"/.openclaw/openclaw.json").gateway?.auth?.token)||""; process.stdout.write(/^\$\{.*\}$/.test(t)?"":t)' 2>/dev/null || true)"
  if [[ -n "$SOURCED_TOKEN" ]]; then
    export OPENCLAW_VOICE_ROOM_TOKEN="$SOURCED_TOKEN"
    echo "==> Gateway token: sourced from config"
  fi
  unset SOURCED_TOKEN
fi

# Warn (don't fail) if the default token var is still empty and none is configured —
# connect will report the real auth error, but this catches the common miss.
if [[ -z "${OPENCLAW_VOICE_ROOM_TOKEN:-}" && -z "${OPENCLAW_VOICE_ROOM_TOKEN_ENV:-}" ]]; then
  echo "WARN: OPENCLAW_VOICE_ROOM_TOKEN is not set; the gateway may reject the connection." >&2
fi

# App-local native dep (onnxruntime-node); install only if missing.
if [[ ! -d "$APP_DIR/node_modules/onnxruntime-node" ]]; then
  echo "==> Installing app dependencies (onnxruntime-node)…"
  ( cd "$APP_DIR" && npm install )
fi

# openWakeWord models (fetch only when absent).
MODELS_DIR="$APP_DIR/models"
if [[ -f "$MODELS_DIR/hey_jarvis_v0.1.onnx" \
   && -f "$MODELS_DIR/melspectrogram.onnx" \
   && -f "$MODELS_DIR/embedding_model.onnx" ]]; then
  echo "==> Models present."
else
  echo "==> Fetching openWakeWord models…"
  bash "$APP_DIR/scripts/fetch-models.sh"
fi

# Wait-music loop asset (fetch + convert only when absent).
if [[ -f "$APP_DIR/assets/wait-loop.wav" ]]; then
  echo "==> Wait-loop asset present."
else
  echo "==> Fetching wait-loop asset…"
  bash "$APP_DIR/scripts/fetch-wait-sound.sh"
fi

# The TypeScript entry runs through the repo-root tsx runner.
if [[ ! -x "$REPO_ROOT/node_modules/.bin/tsx" ]]; then
  echo "ERROR: repo-root tsx not found. Run 'pnpm install' in $REPO_ROOT first." >&2
  exit 1
fi

# Resolve ALSA devices: positional arg > pre-set env > PowerConf default.
export OPENCLAW_VOICE_ROOM_CAPTURE_DEVICE="${1:-${OPENCLAW_VOICE_ROOM_CAPTURE_DEVICE:-$DEFAULT_CAPTURE_DEVICE}}"
export OPENCLAW_VOICE_ROOM_PLAYBACK_DEVICE="${2:-${OPENCLAW_VOICE_ROOM_PLAYBACK_DEVICE:-$DEFAULT_PLAYBACK_DEVICE}}"
echo "==> Capture device:  $OPENCLAW_VOICE_ROOM_CAPTURE_DEVICE"
echo "==> Playback device: $OPENCLAW_VOICE_ROOM_PLAYBACK_DEVICE"
echo "==> Session key:     ${OPENCLAW_VOICE_ROOM_SESSION_KEY:-voice-room}"

echo '==> Starting node. Say "Hey Jarvis", then your question (Ctrl-C to stop).'
cd "$REPO_ROOT"
exec node_modules/.bin/tsx apps/voice-room-node/src/main.ts
