#!/usr/bin/env bash
# Preflight for the voice-room node: verify ALSA capture/playback tools exist and
# that we are on the supported arch. onnxruntime-node prebuilt binaries and the
# arecord/aplay pipeline are only validated for x86_64 Linux, so fail closed
# elsewhere rather than let later steps spawn missing tools or load a bad binary.
set -euo pipefail

fail=0

arch="$(uname -m)"
echo "arch: ${arch}"

if command -v arecord >/dev/null 2>&1; then
  arecord --version
else
  echo "error: arecord (ALSA) not found; install alsa-utils" >&2
  fail=1
fi

if command -v aplay >/dev/null 2>&1; then
  aplay --version
else
  echo "error: aplay (ALSA) not found; install alsa-utils" >&2
  fail=1
fi

if [ "${arch}" != "x86_64" ]; then
  echo "error: unsupported arch '${arch}'; voice-room node requires x86_64" >&2
  fail=1
fi

exit "${fail}"
