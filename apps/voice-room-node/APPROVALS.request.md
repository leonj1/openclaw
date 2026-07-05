# Dependency approval request: `onnxruntime-node` for `apps/voice-room-node`

Per repo policy (root `AGENTS.md`), new dependencies need explicit maintainer
approval. This is the request to add one native dependency for the new
"Hey Jarvis" voice-room device node.

## Dependency

- **Package:** `onnxruntime-node`
- **Pinned version:** `1.27.0`
- **Arch / platform:** x86_64 Linux only. Confirmed via
  `apps/voice-room-node/scripts/check-env.sh`, which prints `uname -m` and fails
  closed unless the arch is `x86_64` (it also gates on the ALSA `arecord`/`aplay`
  tools). The prebuilt native ONNX Runtime binaries and the ALSA audio pipeline
  are only validated on x86_64 Linux; other arches fail closed.

## Rationale

openWakeWord "Hey Jarvis" detection runs three ONNX models on the device node:
a shared mel-spectrogram model, an embedding model, and the `hey_jarvis`
classifier. `onnxruntime-node` provides the native ONNX Runtime inference
bindings that execute these models locally on the box, so wake detection runs
on-device with no cloud round-trip.

## Scope

- Declared only in `apps/voice-room-node/package.json` (app-local).
- The app is excluded from the core dist build, so the native binary does not
  leak into the root package. Follows the repo rule that plugin/app-only deps
  stay app-local.

## Ask

Please approve adding `onnxruntime-node@1.27.0` as an app-local dependency of
`apps/voice-room-node`. On approval, the approving PR/issue URL will be recorded
on the `Approving PR/issue:` line in `apps/voice-room-node/APPROVALS.md`.
