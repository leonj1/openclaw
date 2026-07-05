# NOTES — "Hey Jarvis" voice-room node

Cross-step decisions, conventions, and gotchas. Append as steps complete.

## Conventions

- App root: `apps/voice-room-node/`. Scripts live under `apps/voice-room-node/scripts/`.
- Target platform is **x86_64 Linux only**. `onnxruntime-node` prebuilt binaries
  and the `arecord`/`aplay` (ALSA / `alsa-utils`) audio pipeline are only
  validated there; other arches should fail closed.
- Audio format standard across the node: **PCM16, 24kHz, mono** (`-f S16_LE -r 24000 -c1`).
  Keep capture, playback, wake fixtures, and TTS all on this format.
- Shell scripts: `#!/usr/bin/env bash` + `set -euo pipefail`.

## Step: check-env.sh (done)

- `apps/voice-room-node/scripts/check-env.sh` prints `arch: <uname -m>`, runs
  `arecord --version` / `aplay --version`, and exits non-zero if either ALSA tool
  is missing OR arch != `x86_64`. It accumulates failures (`fail=1`) rather than
  exiting on the first, so a run reports every missing prerequisite at once.
- Script is committed executable (`chmod +x`), but the acceptance command uses
  `bash apps/voice-room-node/scripts/check-env.sh`, so the exec bit is not required
  to run it.
- **Gotcha — dev vs target box:** this dev machine is `x86_64` but does NOT have
  `alsa-utils` installed, so the script correctly exits 1 here. The `exit 0`
  acceptance criterion is only expected on the real target box (Anker/voice box)
  where `alsa-utils` is installed. Verified here: arch detection prints `x86_64`
  and the fail-closed path fires on missing ALSA tools.
- Later steps (APPROVALS.md) reference this script as the confirmation that
  x86_64 Linux was checked for the `onnxruntime-node` dependency.
