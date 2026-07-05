# Plan: "Hey Jarvis" voice assistant via Anker room speaker

A room speaker (Anker conference mic/speaker) that listens locally for the wake
word **"Hey Jarvis"**, streams the spoken request to OpenClaw, gets a **brief**
answer, converts it to an **ElevenLabs** voice, and plays it back through the
speaker.

## Locked decisions

- **Wake word:** openWakeWord (Apache-2.0) pretrained `hey_jarvis` ONNX model,
  run **device-side** via `onnxruntime-node`. No cloud key; only post-wake audio
  leaves the box (privacy + bandwidth).
- **STT + TTS:** ElevenLabs — `scribe_v2` realtime transcription and the
  ElevenLabs speech provider (one provider/key).
- **Brevity:** spoken replies hard-capped at ~2 sentences, plain speech, no
  markdown/URLs/code. Persona attaches only to wake-originated sessions.

## What already exists (reuse, do not rebuild)

| Capability | Where | Notes |
|---|---|---|
| Realtime voice / Talk pipeline | `src/talk/*`, `src/gateway/talk-realtime-relay.ts`, `talk-agent-consult.ts` | audio-in → STT → agent consult → TTS → audio-out |
| Talk over a device "node" | `src/gateway/server-talk-nodes.ts`, `packages/gateway-client` | node advertises cap `"talk"`; audio is base64 PCM16 (`REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ`) over the gateway WS |
| ElevenLabs TTS + STT | `extensions/elevenlabs/` | `speechProviders` (TTS) + `realtimeTranscriptionProviders` (`scribe_v2`). Deepgram (`extensions/deepgram/`) is an alt STT |
| Wake-phrase → agent/session routing | `src/infra/voicewake.ts`, `voicewake-routing.ts` | persisted triggers + routing rules. Transcript-phrase matching, NOT acoustic detection |
| Agent consult / reply control | `src/talk/agent-consult-*.ts`, `agent-run-control.ts` | where the brief spoken persona attaches |

## What is genuinely new

1. A headless **voice-room node** (`apps/voice-room-node/`) — separate local
   process wired to the Anker: mic capture, wake-word, speaker playback,
   connects via `packages/gateway-client`, advertises cap `"talk"`.
2. **Acoustic wake-word detection** ("Hey Jarvis"), device-side.
3. A **brief-spoken-reply persona** + registering `hey jarvis` as a voicewake
   trigger routed to an agent.

## Data flow

```
Anker mic ──PCM16 24kHz──▶ [voice-room node (local process)]
                                │  openWakeWord "hey_jarvis" (device-side)
                                │  ── silence: nothing leaves the box ──
                                ▼ on wake: open Talk session, stream utterance
                          gateway WS  (cap "talk", packages/gateway-client)
                                ▼
   talk-realtime-relay ─▶ ElevenLabs scribe_v2 (STT) ─▶ talk-agent-consult
                                ▼                          (brief spoken persona)
                          agent brief reply (≤2 sentences)
                                ▼
                          ElevenLabs TTS (speechProvider)
                                ▼  base64 audio frames
                          voice-room node ──▶ aplay ──▶ Anker speaker
```

Everything from "gateway WS" rightward already exists. The new work is the
voice-room node plus the brevity persona.

## Components & file layout

### New — device side: `apps/voice-room-node/` (own process, node-local deps)

| File | Responsibility |
|---|---|
| `src/main.ts` | Boot: read config, open audio devices, connect gateway via `packages/gateway-client`, advertise cap `"talk"` |
| `src/audio/capture.ts` | Spawn `arecord -f S16_LE -r 24000 -c1`, emit PCM frames; select Anker ALSA device |
| `src/audio/playback.ts` | Spawn `aplay`; queue + drain TTS frames; barge-in stop |
| `src/wake/openwakeword.ts` | `onnxruntime-node` over `hey_jarvis.onnx` + melspectrogram/embedding models; sliding window → `WakeEvent{score,ts}` above threshold |
| `src/session/talk-node.ts` | State machine `idle → listening → streaming → speaking → idle`; endpointing (VAD/silence timeout); maps gateway Talk frames ↔ audio devices |
| `package.json` | `onnxruntime-node`; ALSA via `child_process` (no lib). Excluded from core dist; deps stay node-local, never root |
| `openclaw-voice-room.service` | systemd (user) unit; ties to existing Doctor systemd-linger findings |

### New — core side (small, plugin-agnostic)

| File | Change |
|---|---|
| `src/talk/agent-run-control.ts` (or `agent-consult-tool.ts`) | Attach spoken-brief directive to wake-originated sessions ("≤2 sentences, plain speech, no markdown/URLs/code"). Gate by a session flag so text channels are unaffected |
| `src/infra/voicewake-routing.ts` | Register `hey jarvis` trigger → target agent/session (reuses existing routing, no new store) |
| `packages/gateway-protocol` | Only if a Talk frame field for `source:"wake"` is needed; additive only. Prefer reusing existing session metadata to avoid a protocol bump (owner-confirmation-only) |

### Reused unchanged

`talk-realtime-relay.ts`, `talk-agent-consult.ts`, `server-talk-nodes.ts`,
`extensions/elevenlabs/*` (STT `scribe_v2` + TTS), `src/infra/voicewake.ts`.

## Existing-solutions preflight

- **openWakeWord** (Apache-2.0): pretrained `hey_jarvis` ONNX; chosen.
- **Picovoice Porcupine** (`@picovoice/porcupine-node`): built-in `Jarvis`
  keyword, simplest API, but proprietary + cloud AccessKey. Rejected (not OSS).
- **Audio I/O:** `arecord`/`aplay` (ALSA, zero npm deps) on Linux/Anker-USB;
  `naudiodon` (PortAudio) as fallback.

## Test plan

Vitest, colocated `*.test.ts`; `*.live.test.ts` for real APIs; `*.e2e` for
hardware. Run `pnpm test <path>` / `pnpm test:extensions`; broad/live proof via
Crabbox. Clean child processes / temp / sockets per repo rules.

### Unit (fast, no hardware, no network)

1. `apps/voice-room-node/src/wake/openwakeword.test.ts`
   - Fixture WAV of "hey jarvis" → score crosses threshold, exactly one `WakeEvent`.
   - Silence + non-wake phrase ("hey there") → no event (false-positive guard).
   - Debounce: two utterances 200ms apart → single wake.
2. `src/session/talk-node.test.ts` — state machine with a mocked gateway client:
   `idle→listening` on wake; `→streaming` sends PCM; `→speaking` on TTS frame;
   `→idle` on end/timeout. Barge-in stops playback. Silence timeout ends utterance.
3. `src/audio/capture.test.ts` / `playback.test.ts` — fake `arecord`/`aplay`
   stub scripts; assert format flags, frame chunking, backpressure, clean SIGTERM.
4. `src/talk/agent-run-control.*.test.ts` (core) — wake-flagged session injects
   the brevity directive; text/non-wake session does not (no cross-surface leak).
5. `src/infra/voicewake-routing.test.ts` (extend) — `hey jarvis` → configured
   agent; unknown phrase → default target.

### Integration (in-process, mocked externals)

6. `talk-node.integration.test.ts` — full loop with fake gateway relay + stub
   STT/TTS (reuse `src/talk/talk.test-helpers.ts`, `plugin-runtime-mock.ts`):
   wake fixture → transcript → stubbed brief reply → TTS bytes → playback stub
   receives audio. Asserts turn ordering and that no audio streams pre-wake.
7. `server-talk-nodes` cap test (extend) — voice-room node advertising `"talk"`
   is detected as talk-capable.

### Live (opt-in, real ElevenLabs; gated like existing `elevenlabs.live.test.ts`)

8. `elevenlabs-voiceroom.live.test.ts` — `OPENCLAW_LIVE_TEST=1`: real
   `scribe_v2` transcribes the wake-fixture utterance (reuse `stt-live-audio.ts`
   + `expectOpenClawLiveTranscriptMarker`); real TTS returns playable audio.
   No hardware.

### E2E / hardware proof (Crabbox / manual, documented not CI)

9. `voice-room.e2e.md` runbook — on the physical box: "Hey Jarvis, what's the
   date" → ≤2-sentence spoken reply from the Anker. Capture wake latency,
   end-to-end latency, false-accept rate over a 10-min quiet soak.

## Phased rollout

1. **P1 — device node skeleton:** capture/playback + gateway connect + manual
   push-to-talk (no wake). Proves Anker + Talk transport. Tests 3, 7, 8.
2. **P2 — wake word:** openWakeWord + state machine + barge-in. Tests 1, 2, 6.
3. **P3 — brevity persona + routing:** core changes. Tests 4, 5.
4. **P4 — hardening:** systemd unit + `openclaw doctor` finding if device/service
   missing, soak test, runbook. Test 9.

## Open decisions / risks

- **Wake threshold & endpointing** need tuning on the real Anker (far-field,
  room echo). Fixtures get CI green; final values from P4 soak.
- **Barge-in / echo cancellation:** if the Anker DSP does not echo-cancel, gate
  the mic while `speaking` so TTS does not re-trigger wake. Test 2 covers gating.
- **Protocol bump:** prefer carrying `source:"wake"` in existing session metadata
  to avoid a gateway-protocol version bump.
- **onnxruntime-node** must resolve on the box arch (x86_64 Linux — fine).
