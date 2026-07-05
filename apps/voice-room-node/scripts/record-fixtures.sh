#!/usr/bin/env bash
# Records the wake / non-wake test fixtures from the real mic in the node-wide
# format (PCM16 / 24kHz / mono) straight into test/fixtures/.
#
# Run it, then speak the prompted phrase once, clearly, at normal room distance.
# Verify afterwards with `soxi <file>` or `ffprobe <file>` (expect: 24000 Hz,
# 1 channel, 16-bit).
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fixtures_dir="${script_dir}/../test/fixtures"
mkdir -p "${fixtures_dir}"

# ALSA capture device (arecord -D); override for a specific mic, e.g.
# DEVICE="plughw:CARD=Anker,DEV=0" scripts/record-fixtures.sh
DEVICE="${DEVICE:-default}"
# Seconds to record per clip; a single short utterance fits in the default.
DURATION="${DURATION:-3}"

record_clip() {
  local name="$1" phrase="$2"
  local dest="${fixtures_dir}/${name}"
  echo
  echo ">>> About to record '${name}'. Say: \"${phrase}\""
  read -r -p "    Press Enter to start ${DURATION}s recording..." _
  # -t wav so the header carries the format; -f/-r/-c pin PCM16/24kHz/mono.
  arecord -t wav -f S16_LE -r 24000 -c1 -D "${DEVICE}" -d "${DURATION}" "${dest}"
  echo "    wrote ${dest}"
}

record_clip "hey_jarvis.wav" "Hey Jarvis"
record_clip "hey_there.wav" "Hey there"

echo
echo "Recorded fixtures in ${fixtures_dir}:"
ls -l "${fixtures_dir}"/hey_jarvis.wav "${fixtures_dir}"/hey_there.wav
