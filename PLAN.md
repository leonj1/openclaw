# PLAN — "Hey Jarvis" voice assistant via Anker room speaker

## Overview

Build a headless **voice-room node** that turns an Anker USB conference
mic/speaker into a local "Hey Jarvis" assistant. The node listens on-device for
the wake word, and only after a wake does audio leave the box. Post-wake it
opens an OpenClaw **Talk** session over the gateway WebSocket (advertising the
existing `"talk"` capability), streams the utterance to ElevenLabs `scribe_v2`
(STT) → agent consult → ElevenLabs TTS, and plays the brief spoken reply back
through the Anker speaker.

Everything from the gateway WS rightward (STT, agent consult, TTS, Talk relay)
already exists and is reused unchanged. The genuinely new work is:

1. The device-side `apps/voice-room-node/` process (mic capture, wake word,
   speaker playback, gateway connection).
2. Device-side acoustic wake-word detection ("Hey Jarvis") via openWakeWord.
3. A brief-spoken-reply persona attached only to wake-originated sessions, plus
   registering `hey jarvis` as a voicewake trigger routed to an agent.

This plan converts the authoritative design in `GOAL.md` / `TODO.md` into an
ordered, checkable step list (`STEPS.md`).

## Goals

- On-device wake detection: silence never leaves the box; only post-wake audio
  is streamed to the gateway.
- Reuse the existing Talk pipeline, gateway-client, gateway-protocol,
  ElevenLabs plugin, and voicewake routing — build only the missing node and
  the brevity persona.
- Spoken replies hard-capped at ~2 sentences, plain speech (no markdown, URLs,
  or code), and only for wake-originated sessions — text channels unaffected.
- Prefer OSS (openWakeWord, Apache-2.0) and zero-dependency ALSA
  (`arecord`/`aplay`) audio I/O.
- Keep node deps node-local: `apps/voice-room-node` is excluded from core dist;
  `onnxruntime-node` never becomes a root dependency.
- Ship a systemd (user) unit and an `openclaw doctor` finding so the box can run
  the node as a managed service, tying into existing Doctor systemd-linger
  findings.

## Constraints (from repo AGENTS.md / architecture rules)

- **Owner boundaries:** the voice-room node is a standalone app under `apps/`
  with node-local deps, excluded from core dist. Core changes stay
  plugin-agnostic and minimal.
- **No new config/env surface unless justified:** prefer node-local config file
  for the node; on the core side reuse existing voicewake routing store — no new
  persisted store. Any new core config must first prove existing product
  behavior/defaults/doctor cannot solve it.
- **Storage:** any node runtime state that must persist goes in SQLite per repo
  rules — but prefer stateless. No JSON/JSONL sidecar state files. Model ONNX
  files are named product artifacts (import), which is allowed.
- **Gateway protocol:** additive only. Prefer carrying `source:"wake"` in
  existing Talk session metadata to avoid a protocol version bump (bumps are
  owner-confirmation-only).
- **Dependencies:** `onnxruntime-node` and any audio libs stay in
  `apps/voice-room-node/package.json`; dependency additions need approval per
  repo policy before install.
- **Tests:** Vitest, colocated `*.test.ts`; `*.live.test.ts` gated by
  `OPENCLAW_LIVE_TEST=1`; hardware `*.e2e` documented, not CI. Clean child
  processes / temp / sockets. Use `pnpm test <path>` (never raw vitest).
- **Terminal-state / hot-path rules:** reuse prepared Talk session facts; do not
  rederive terminal outcome or add request-time discovery.

## Architecture

```
Anker mic ──PCM16 24kHz──▶ [voice-room node: apps/voice-room-node]
                                │  openWakeWord "hey_jarvis" (onnxruntime-node)
                                │  ── silence: nothing leaves the box ──
                                ▼ on wake: open Talk session, stream utterance
                          gateway WS  (cap "talk", packages/gateway-client)
                                ▼
   talk-realtime-relay ─▶ ElevenLabs scribe_v2 (STT) ─▶ talk-agent-consult
                                ▼                          (brief spoken persona)
                          agent brief reply (≤2 sentences)
                                ▼
                          ElevenLabs TTS (speechProvider)
                                ▼  base64 audio frames (PCM16 24kHz)
                          voice-room node ──▶ aplay ──▶ Anker speaker
```

### New — device side: `apps/voice-room-node/`

| File | Responsibility |
|---|---|
| `src/main.ts` | Boot: read config, open audio devices, connect gateway via `packages/gateway-client`, advertise cap `"talk"` |
| `src/config.ts` | Node-local config (gateway URL/token, ALSA device ids, wake threshold, endpointing timeouts) |
| `src/audio/capture.ts` | Spawn `arecord -f S16_LE -r 24000 -c1`, emit PCM frames; select Anker ALSA device |
| `src/audio/playback.ts` | Spawn `aplay`; queue + drain TTS frames; barge-in stop; SIGTERM cleanup |
| `src/wake/openwakeword.ts` | `onnxruntime-node` over `hey_jarvis.onnx` + melspectrogram/embedding models; sliding window → `WakeEvent{score,ts}` above threshold, with debounce |
| `src/session/talk-node.ts` | State machine `idle → listening → streaming → speaking → idle`; endpointing (silence timeout); maps gateway Talk frames ↔ audio devices; mic gating while speaking |
| `models/` | openWakeWord ONNX artifacts (hey_jarvis + shared mel/embedding) |
| `package.json` | `onnxruntime-node`; ALSA via `child_process`. Excluded from core dist |
| `openclaw-voice-room.service` | systemd (user) unit |
| `voice-room.e2e.md` | hardware runbook |

### New — core side (small, plugin-agnostic)

| File | Change |
|---|---|
| `src/talk/agent-run-control.ts` (+ shared) | Attach spoken-brief directive to wake-originated sessions ("≤2 sentences, plain speech, no markdown/URLs/code"), gated by a session flag so text channels are unaffected |
| `src/infra/voicewake-routing.ts` | Register `hey jarvis` trigger → target agent/session (reuse existing routing store) |
| `packages/gateway-protocol` | Only if a Talk frame field for `source:"wake"` is needed; additive. Prefer reusing existing session metadata to avoid a version bump |

### Reused unchanged

`src/gateway/talk-realtime-relay.ts`, `src/gateway/talk-agent-consult.ts`,
`src/gateway/server-talk-nodes.ts`, `packages/gateway-client`,
`extensions/elevenlabs/*` (STT `scribe_v2` + TTS), `src/infra/voicewake.ts`.

## Existing-solutions preflight (decided in GOAL.md)

- **openWakeWord** (Apache-2.0) pretrained `hey_jarvis` ONNX — chosen.
- **Picovoice Porcupine** — proprietary + cloud AccessKey — rejected.
- **Audio I/O** — `arecord`/`aplay` (ALSA, zero npm deps); `naudiodon`
  (PortAudio) noted as fallback only.

## Phased rollout

1. **P1 — device node skeleton:** config + capture/playback + gateway connect +
   manual push-to-talk (no wake). Proves Anker + Talk transport.
2. **P2 — wake word:** openWakeWord + state machine + barge-in + mic gating.
3. **P3 — brevity persona + routing:** core changes, gated to wake sessions.
4. **P4 — hardening:** systemd unit + `openclaw doctor` finding + soak +
   runbook.

## Open decisions / risks

- Wake threshold & endpointing tuned on the real Anker during P4 soak; CI uses
  fixtures.
- Barge-in / echo cancellation: if the Anker DSP does not echo-cancel, gate the
  mic while `speaking` so TTS does not re-trigger wake.
- Protocol: prefer `source:"wake"` in existing session metadata over a
  gateway-protocol version bump.
- `onnxruntime-node` must resolve on the box arch (x86_64 Linux — fine).
- Dependency additions (`onnxruntime-node`) require explicit approval before
  install per repo policy.

## Test strategy (see STEPS.md for the mapped tests)

- **Unit** (no hardware/network): wake detection on WAV fixtures, state machine
  with mocked gateway client, audio capture/playback with stub `arecord`/`aplay`
  scripts, brevity persona gating, voicewake routing.
- **Integration** (in-process, mocked externals): full wake→transcript→brief
  reply→TTS→playback loop; `server-talk-nodes` cap detection.
- **Live** (`OPENCLAW_LIVE_TEST=1`): real ElevenLabs `scribe_v2` transcribes the
  wake-fixture utterance; real TTS returns playable audio. No hardware.
- **E2E / hardware** (documented, not CI): physical box runbook — "Hey Jarvis,
  what's the date" → ≤2-sentence spoken reply, with latency + false-accept
  measurements over a 10-minute quiet soak.
