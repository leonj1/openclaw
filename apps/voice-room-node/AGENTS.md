# Voice-Room Node Agent Policy

Root rules still apply. This file adds guardrails for the `apps/voice-room-node`
subtree ("Hey Jarvis" voice-room device node).

## Scope & platform

- Target platform is **x86_64 Linux only**. `onnxruntime-node` prebuilt binaries
  and the ALSA (`arecord`/`aplay`, `alsa-utils`) audio pipeline are validated
  there only; other arches must fail closed. Preflight via `scripts/check-env.sh`.
- This app is **not** part of the pnpm workspace (`pnpm-workspace.yaml` lists
  `.`, `ui`, `packages/*`, `extensions/*`). It owns its own `package.json` and
  deps, and is excluded from the core dist build per root architecture rules.
- App-only dependencies stay app-local. Do not add `onnxruntime-node` (or any
  app dep) to the root `package.json`.

## Dependencies & approval

- Adding native/app deps requires the maintainer-approval gate documented in
  `APPROVALS.md` / `APPROVALS.request.md`. Keep the pinned `onnxruntime-node`
  version identical across `package.json`, `APPROVALS.md`, and
  `APPROVALS.request.md` (currently `1.27.0`).

## Wake models

- The wake layer uses three ONNX artifacts from the openWakeWord project
  (`github.com/dscripka/openWakeWord`): `hey_jarvis_v0.1.onnx`,
  `melspectrogram.onnx`, and `embedding_model.onnx`. Fetch them with
  `scripts/fetch-models.sh` into `models/` (git-ignored; not committed).
- These models are licensed **Apache-2.0** (openWakeWord's license). Keep that
  attribution here when redistributing or documenting them.
- The models are trained at **16kHz**, but this node captures at 24kHz.
  `src/wake/features.ts` resamples 24k -> 16k before the mel model; do not feed
  24kHz audio to the wake sessions.

## Audio format

- Audio format standard across the node: **PCM16, 24kHz, mono**
  (`-f S16_LE -r 24000 -c1`). Keep capture, playback, wake fixtures, and TTS all
  on this format.

## Wait sound (Layer 2)

- The "thinking" wait loop is a royalty-free **substitute** for the copyrighted
  Jeopardy "Think!" theme — never ship the actual theme.
- Source: **"Local Forecast - Elevator" by Kevin MacLeod** (incompetech.com), the
  classic elevator/hold loop, mirrored on Wikimedia Commons:
  `https://commons.wikimedia.org/wiki/File:Local_Forecast_-_Elevator_(ISRC_USUAN1300012).mp3`
  Licensed **CC BY 3.0** (`https://creativecommons.org/licenses/by/3.0`) —
  attribute Kevin MacLeod when redistributing.
- Fetch + convert with `scripts/fetch-wait-sound.sh` into `assets/wait-loop.wav`
  (24kHz mono PCM16; git-ignored, not committed). Swap `SOURCE_URL` in the script
  for another CC0/CC-BY loop if desired.
- Alternative to the loop: short spoken fillers ("one moment…", "thinking…",
  "working on it") synthesized by `scripts/fetch-voice-fillers.ts` into
  `assets/filler-*.wav` (same format; git-ignored, optional). `src/audio/wait-player.ts`
  randomizes per turn between the instrumental loop and playing the fillers in
  sequence with a random 2-3s silent gap between them. Missing filler files just
  fall back to the loop.

## On-device STT/TTS (Layer 2)

- Layer 2 transcribes and speaks on-device via the ElevenLabs REST API
  (`/v1/speech-to-text` scribe, `/v1/text-to-speech/{voice}` with
  `output_format=pcm_24000`). The gateway's relays are not a clean text seam.
- The API key comes **only** from `ELEVENLABS_API_KEY` (env-only, never config,
  never committed). Voice/model ids live in the `elevenlabs` config section (with
  defaults) and are env-overridable (`ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID`,
  `ELEVENLABS_STT_MODEL`, `ELEVENLABS_BASE_URL`).

## Conventions

- TS ESM, strict; schema-validate external boundaries with `zod`.
- Tests: Vitest (`pnpm --dir apps/voice-room-node test` or `vitest run`),
  colocated `*.test.ts`.
- Shell scripts: `#!/usr/bin/env bash` + `set -euo pipefail`.
