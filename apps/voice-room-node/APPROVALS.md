# Dependency approvals — voice-room node

Per repo policy, new dependencies need explicit maintainer approval. This file
tracks the approval state for dependencies added by `apps/voice-room-node`.

## `onnxruntime-node`

- **Pinned version:** `1.27.0` (kept in sync with `APPROVALS.request.md` and,
  when created, `apps/voice-room-node/package.json`).
- **Rationale:** openWakeWord "Hey Jarvis" detection runs its mel-spectrogram,
  embedding, and `hey_jarvis` classifier as ONNX models. `onnxruntime-node`
  provides the native ONNX Runtime inference bindings that execute these models
  on the device node.
- **Arch / platform:** x86_64 Linux only. Confirmed via
  `apps/voice-room-node/scripts/check-env.sh`, which prints `uname -m` and fails
  closed unless the arch is `x86_64` (it also gates on the ALSA `arecord`/`aplay`
  tools). x86_64 Linux was confirmed on this target.
- **Scope:** declared only in `apps/voice-room-node/package.json`; the app is
  excluded from the core dist build, so the native binary does not leak into the
  root package.

Approving PR/issue: PENDING
