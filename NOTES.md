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

## Step: APPROVALS.md (done)

- `apps/voice-room-node/APPROVALS.md` documents the `onnxruntime-node` dependency:
  rationale (openWakeWord "Hey Jarvis" ONNX inference — mel/embedding/hey_jarvis
  models), x86_64 Linux confirmed via `scripts/check-env.sh`, and an
  `Approving PR/issue:` line initialized to `PENDING`.
- **Convention:** the `Approving PR/issue:` line is the machine-checkable field.
  A later step flips `PENDING` to the real approval URL (must become a
  `https://github.com/openclaw/openclaw/...` URL). Keep the line label exactly
  `Approving PR/issue:` so that step's grep/replace stays stable.
- The next step writes `APPROVALS.request.md` (the pasteable issue/PR body) which
  must name the **pinned version** of `onnxruntime-node`. APPROVALS.md itself
  intentionally does NOT pin a version yet — the version is decided when
  `package.json` is created (later Phase 0 step). If a version gets pinned, note
  it in both places.
- Repo policy (root AGENTS.md): new deps need explicit maintainer approval;
  plugin/app-only deps stay app-local (declared only in the app's package.json,
  excluded from core dist). APPROVALS.md restates this scope so the approval
  request and the package.json step stay aligned.
