#!/usr/bin/env bash
# Downloads the three openWakeWord ONNX artifacts the wake layer needs into
# apps/voice-room-node/models/:
#   - hey_jarvis_v0.1.onnx  (wake classifier for "hey jarvis")
#   - melspectrogram.onnx   (shared PCM -> mel-spectrogram front end)
#   - embedding_model.onnx  (shared mel -> speech-embedding front end)
#
# Source: the openWakeWord project (github.com/dscripka/openWakeWord) release
# assets, licensed Apache-2.0 (see AGENTS.md). Pinned to release v0.5.1 so the
# tensor shapes/names the wake code asserts stay stable. URLs verified live with
# `curl --fail` against the GitHub release before pinning.
set -euo pipefail

RELEASE="v0.5.1"
BASE="https://github.com/dscripka/openWakeWord/releases/download/${RELEASE}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
models_dir="${script_dir}/../models"
mkdir -p "${models_dir}"

# name in the release -> local filename (kept identical so paths match utils.py)
files=(
  "melspectrogram.onnx"
  "embedding_model.onnx"
  "hey_jarvis_v0.1.onnx"
)

for name in "${files[@]}"; do
  dest="${models_dir}/${name}"
  if [ -s "${dest}" ]; then
    echo "have ${name}"
    continue
  fi
  echo "fetching ${name}"
  # --fail: turn an HTTP error (e.g. a moved asset) into a non-zero exit instead
  # of writing an HTML error page over the model. -L: follow the release redirect.
  curl -sSL --fail -o "${dest}.tmp" "${BASE}/${name}"
  mv "${dest}.tmp" "${dest}"
done

echo "models in ${models_dir}:"
ls -l "${models_dir}"
