#!/usr/bin/env bash
set -euo pipefail

# Downloads a royalty-free "thinking" / hold-music loop and converts it to the
# node-wide audio format (PCM16, 24kHz, mono) at assets/wait-loop.wav. This is a
# Creative-Commons Jeopardy-style SUBSTITUTE — never the copyrighted "Think!"
# theme. Source + license are recorded in the app AGENTS.md.
#
# Source: "Local Forecast - Elevator" by Kevin MacLeod (incompetech.com), the
# classic elevator/hold loop, mirrored on Wikimedia Commons.
#   License: CC BY 3.0 (https://creativecommons.org/licenses/by/3.0)
#   Page:    https://commons.wikimedia.org/wiki/File:Local_Forecast_-_Elevator_(ISRC_USUAN1300012).mp3

SOURCE_URL="https://upload.wikimedia.org/wikipedia/commons/9/9f/Local_Forecast_-_Elevator_%28ISRC_USUAN1300012%29.mp3"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(cd "${script_dir}/.." && pwd)"
assets_dir="${app_dir}/assets"
dest="${assets_dir}/wait-loop.wav"

# Node-wide audio format (see AGENTS.md): PCM16 / 24kHz / mono.
SAMPLE_RATE=24000
CHANNELS=1

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "fetch-wait-sound: missing required tool '$1'." >&2
    echo "  Install it, e.g.: sudo apt-get install -y $2" >&2
    exit 1
  }
}

need curl curl
# Converter: prefer ffmpeg, fall back to sox. One of them is required.
converter=""
if command -v ffmpeg >/dev/null 2>&1; then
  converter="ffmpeg"
elif command -v sox >/dev/null 2>&1; then
  converter="sox"
else
  echo "fetch-wait-sound: need a converter but neither 'ffmpeg' nor 'sox' is installed." >&2
  echo "  Install one, e.g.: sudo apt-get install -y ffmpeg" >&2
  exit 1
fi

mkdir -p "${assets_dir}"
tmp_src="$(mktemp --suffix=.mp3)"
trap 'rm -f "${tmp_src}"' EXIT

echo "fetch-wait-sound: downloading ${SOURCE_URL}"
if ! curl -fsSL --max-time 120 -o "${tmp_src}" "${SOURCE_URL}"; then
  echo "fetch-wait-sound: download failed (network unreachable or URL moved)." >&2
  echo "  Verify the source is still live, or point SOURCE_URL at another CC-BY/CC0 loop." >&2
  exit 1
fi

echo "fetch-wait-sound: converting to PCM16 ${SAMPLE_RATE}Hz mono via ${converter}"
if [[ "${converter}" == "ffmpeg" ]]; then
  ffmpeg -y -loglevel error -i "${tmp_src}" \
    -ac "${CHANNELS}" -ar "${SAMPLE_RATE}" -acodec pcm_s16le -f wav "${dest}"
else
  sox "${tmp_src}" -b 16 -e signed-integer -c "${CHANNELS}" -r "${SAMPLE_RATE}" "${dest}"
fi

echo "fetch-wait-sound: wrote ${dest}"
echo "fetch-wait-sound: verify format with: soxi \"${dest}\"  (expect 24000 Hz, 1 ch, 16-bit)"
