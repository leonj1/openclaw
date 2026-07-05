#!/usr/bin/env bash
set -euo pipefail

# Installs Layer 1 (wake-word) dependencies and runs the Layer 1 test suite.
#
# Layer 1 needs three things: the app-local onnxruntime-node native dep, the
# openWakeWord ONNX models, and vitest (resolved from the repo root). This is the
# offline (Tier A) verification — no ALSA/mic required. It proves the wake-word
# implementation is correct by scoring the fixtures: "hey jarvis" fires, silence
# and "hey there" do not. The live on-hardware gate is separate (see
# voice-room.e2e.md).
#
# Idempotent: re-running skips the model download when the models are present and
# is otherwise a no-op reinstall. Usage: bash scripts/verify-layer1.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"

echo "==> App:  $APP_DIR"
echo "==> Repo: $REPO_ROOT"

# 1. App-local deps (onnxruntime-node). The app lives outside the pnpm workspace
#    and owns its own package.json + package-lock.json, so it installs with npm
#    on its own rather than through the root pnpm install.
echo "==> [1/4] Installing app dependencies (onnxruntime-node)…"
( cd "$APP_DIR" && npm install )

# 2. vitest and the @openclaw/* source aliases the app's vitest config borrows
#    come from the repo-root install. Only install if it is missing so this stays
#    fast on a normal checkout.
if [[ ! -x "$REPO_ROOT/node_modules/.bin/vitest" ]]; then
  echo "==> [2/4] Root vitest not found; installing repo dependencies (pnpm)…"
  ( cd "$REPO_ROOT" && pnpm install )
else
  echo "==> [2/4] Root vitest present; skipping repo install."
fi

# 3. openWakeWord ONNX models (mel + embedding + hey_jarvis). Git-ignored and
#    reproducible from the release, so fetch only when absent.
MODELS_DIR="$APP_DIR/models"
if [[ -f "$MODELS_DIR/hey_jarvis_v0.1.onnx" \
   && -f "$MODELS_DIR/melspectrogram.onnx" \
   && -f "$MODELS_DIR/embedding_model.onnx" ]]; then
  echo "==> [3/4] Models already present; skipping download."
else
  echo "==> [3/4] Fetching openWakeWord models…"
  bash "$APP_DIR/scripts/fetch-models.sh"
fi

# 4. Run the Layer 1 tests: the wake detector (onnx-sessions, features,
#    openwakeword, wake-listen) plus the fixture format checks. onnxruntime-node
#    resolves from the app; vitest and its config run from the repo root.
echo "==> [4/4] Running Layer 1 tests…"
cd "$REPO_ROOT"
node_modules/.bin/vitest run \
  --config test/vitest/vitest.apps-voice-room.config.ts \
  apps/voice-room-node/src/wake \
  apps/voice-room-node/test/fixtures

echo "==> Layer 1 verified. For the live on-hardware gate, see apps/voice-room-node/voice-room.e2e.md"
