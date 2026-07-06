# STEPS — "Hey Jarvis" voice-room node

Built **layer by layer**. Each layer is independently runnable and ends with a
**live confirmation gate** on the real speaker/mic — do not start the next layer
until the current layer's confirmation gate passes.

The three layers, in order:

1. **Layer 1 — Wake-word listening.** A process listens on the mic and reacts
   when it hears "Hey Jarvis". Nothing is sent to OpenClaw yet. **(Done.)**
2. **Layer 2 — Message to OpenClaw.** After a wake, the follow-up utterance is
   transcribed on-device (ElevenLabs STT), a brevity instruction is prepended, and
   the text is sent to OpenClaw (`chat.send`/`agent.wait`). A royalty-free
   "thinking" wait loop plays from utterance-end until the reply arrives, then the
   succinct reply is spoken back (ElevenLabs TTS). Because the brevity ask is
   prepended here, the old server-side Layer 3 is folded into this layer.
3. **Layer 3 — (folded into Layer 2).** Optional later hardening only: move the
   brevity ask from a client-side prepend to a server-side session persona.

Each step is a single completable unit ending in a concrete `Done when:` check.
Do not mark a step done until its check passes.

---

## Foundation (already built)

The device-node skeleton exists and is reused by every layer below. Listed here
so the layers can build on it; nothing to do unless a check regresses.

- [x] `apps/voice-room-node/src/config.ts` — typed node config (gateway URL/token
      source, ALSA capture + playback devices, `wake.threshold`, endpointing
      timeouts), `zod`-validated, loaded from node-local file + env overrides.
      Done when: `pnpm test apps/voice-room-node/src/config.test.ts` passes.

- [x] `apps/voice-room-node/src/audio/capture.ts` — spawns
      `arecord -f S16_LE -r 24000 -c1 -D <device>`, emits fixed-size PCM16 frames
      with backpressure, cleans up on SIGTERM.
      Done when: `pnpm test apps/voice-room-node/src/audio/capture.test.ts` passes.

- [x] `apps/voice-room-node/src/audio/playback.ts` — spawns `aplay` for PCM16
      24kHz, drains base64 TTS frames, `stop()` barge-in flush, SIGTERM cleanup.
      Done when: `pnpm test apps/voice-room-node/src/audio/playback.test.ts` passes.

- [x] `apps/voice-room-node/src/gateway/connect.ts` — connects via
      `packages/gateway-client`, advertises capability `"talk"`, exposes a typed
      handle (send PCM, receive TTS frames, close).
      Done when: `pnpm test apps/voice-room-node/src/gateway/connect.test.ts` passes.

- [x] `apps/voice-room-node/src/main.ts` — boot path (config → capture/playback →
      gateway connect → coordinated SIGTERM shutdown) with a temporary manual
      push-to-talk trigger (SIGUSR1/SIGUSR2). The push-to-talk trigger is a
      placeholder that Layer 2 replaces with the wake trigger.
      Done when: `pnpm test apps/voice-room-node/src/main.test.ts` passes.

---

## Layer 1 — Wake-word listening (confirmed on the speaker)

Goal: run a standalone process that listens on the Anker mic and prints a wake
event when it hears "Hey Jarvis", and stays quiet otherwise. No gateway, no
OpenClaw — this layer only proves detection works on real audio.

- [x] Add `apps/voice-room-node/scripts/fetch-models.sh` that downloads the three
      openWakeWord ONNX artifacts (`hey_jarvis`, shared `melspectrogram`, shared
      `embedding`) into `apps/voice-room-node/models/`, and note their Apache-2.0
      license in the app AGENTS.md/README.
      Done when: running the script populates the three ONNX files under
      `apps/voice-room-node/models/` and the Apache-2.0 license is noted.

- [x] Add a silence WAV fixture (generated programmatically) plus a recipe README
      under `apps/voice-room-node/test/fixtures/` documenting the required format
      (24kHz mono PCM16) and how the "hey jarvis" (wake) / "hey there" (non-wake)
      clips must be recorded/named.
      Done when: a silence WAV in the documented format exists under
      `apps/voice-room-node/test/fixtures/` and the recipe README states the exact
      format and naming for the wake/non-wake clips.

- [x] Add `apps/voice-room-node/test/fixtures/format-check.test.ts` asserting each
      wake/non-wake WAV under `test/fixtures/` is 24kHz mono PCM16.
      Done when: `pnpm test apps/voice-room-node/test/fixtures/format-check.test.ts`
      passes for a correct WAV and fails for a deliberately malformed one.

- [ ] Add `apps/voice-room-node/scripts/record-fixtures.sh`
      (`arecord -f S16_LE -r 24000 -c1`) to capture `hey_jarvis.wav` (wake) and
      `hey_there.wav` (non-wake) into `test/fixtures/`, and
      `apps/voice-room-node/scripts/synth-fixtures.ts` that synthesizes the same
      two clips via the existing ElevenLabs TTS live helper (24kHz mono PCM16) for
      when no human recording is available.
      Done when: `record-fixtures.sh` writes both WAVs in the documented format
      (verified via `soxi`/`ffprobe`); and with `OPENCLAW_LIVE_TEST=1` + a key,
      `synth-fixtures.ts` writes both WAVs that pass `format-check.test.ts` and
      skips cleanly when the flag/key is absent.

- [x] Produce and place the final `hey_jarvis.wav` (wake) and `hey_there.wav`
      (non-wake) clips under `test/fixtures/` using either script above.
      Done when: both clips exist alongside the silence fixture and pass
      `format-check.test.ts` (each 24kHz mono PCM16).

- [x] Implement `apps/voice-room-node/src/wake/onnx-sessions.ts`: load the mel,
      embedding, and `hey_jarvis` ONNX sessions from `models/` via
      `onnxruntime-node` and expose typed run helpers. Record each model's
      expected input sample rate/shape so `features.ts` can match it.
      Done when: `pnpm test apps/voice-room-node/src/wake/onnx-sessions.test.ts`
      passes — it loads all three sessions and asserts their input/output tensor
      names and shapes.

- [x] Implement `apps/voice-room-node/src/wake/features.ts`: transform a PCM16
      window through mel-spectrogram → embedding, producing the embedding vector
      openWakeWord's classifier expects. If the models expect 16kHz, resample the
      node's 24kHz capture to the model rate here (non-obvious invariant — the
      whole node runs at 24kHz but the wake models are 16kHz-trained).
      Done when: `pnpm test apps/voice-room-node/src/wake/features.test.ts` passes
      — a fixture PCM window yields an embedding tensor of the expected shape.

- [x] Implement `apps/voice-room-node/src/wake/openwakeword.ts`: slide a window
      through features → `hey_jarvis`, score each window, and emit
      `WakeEvent{score,ts}` when the score crosses `wake.threshold`. Then add
      debounce so rapid repeated crossings collapse into a single `WakeEvent`.
      Done when: `pnpm test apps/voice-room-node/src/wake/openwakeword.test.ts`
      passes — exactly one `WakeEvent` for the "hey jarvis" fixture, none for
      silence or "hey there", and two utterances 200ms apart produce a single
      (debounced) wake.

- [x] Implement `apps/voice-room-node/src/wake/wake-listen.ts` standalone entry:
      open mic capture (`capture.ts`), feed frames through `openwakeword.ts`, and
      on each `WakeEvent` print a line (`WAKE score=… ts=…`) and emit an audible
      cue via `playback.ts` (short beep/tone). SIGTERM stops capture cleanly. No
      gateway connection.
      Done when: `pnpm test apps/voice-room-node/src/wake/wake-listen.test.ts`
      passes — replaying the `hey_jarvis` fixture through a stub capture prints one
      wake line and triggers the audible cue; silence/"hey there" print none.

- [x] **Layer 1 confirmation gate (live, on the speaker).** Run `wake-listen.ts`
      against the real Anker mic. Say "Hey Jarvis" several times from normal room
      distance; say unrelated phrases and stay silent between. Record the observed
      wake latency and any false accepts over ~2 minutes into
      `apps/voice-room-node/voice-room.e2e.md`.
      Confirmed 2026-07-05 on the PowerConf: every "Hey Jarvis" printed `WAKE
  score=…`. Latency + false-accept soak noted as optional follow-up in the
      runbook.
      Done when: `voice-room.e2e.md` records a live run where every "Hey Jarvis"
      printed a wake within the target latency and quiet/other speech produced
      zero (or explicitly noted) false accepts. **Do not start Layer 2 until this
      passes.**

---

## Layer 2 — Message to OpenClaw (turn-based, wait-music + brevity)

Goal: after a wake, capture the follow-up utterance, transcribe it on-device
(ElevenLabs), prepend a 1–2 sentence brevity instruction, send it to OpenClaw as
a text turn (`chat.send` → `agent.wait`), play a royalty-free "thinking" wait loop
from utterance-end until the reply lands, then speak the succinct reply back
(ElevenLabs TTS). Needs `ELEVENLABS_API_KEY` and a reachable gateway.

Architecture notes (verified in the gateway source):

- The gateway realtime relay is audio↔audio and the transcription relay is
  browser g711/8kHz STT-only — neither is a clean "text in → text out" seam, so
  STT + TTS run **on-device via ElevenLabs** and the turn goes through the generic
  `chat.send` (returns `runId`) + `agent.wait` (blocks to terminal) RPCs.
- `agent.wait` returning terminal is the "reply ready" signal that stops the wait
  loop. Reuse `playback.stop()` (Layer 1 barge-in) to flush it.

### Wait sound + audio helpers

- [x] Add `apps/voice-room-node/scripts/fetch-wait-sound.sh`: download a
      royalty-free / Creative-Commons quiz/"thinking" loop (a Jeopardy-style
      substitute, **not** the copyrighted theme), convert it to 24kHz mono PCM16 at
      `apps/voice-room-node/assets/wait-loop.wav` (git-ignored), and record the
      source URL + license in the app AGENTS.md. Detect missing `ffmpeg`/`sox` and
      exit with an install hint.
      Done when: running the script writes `assets/wait-loop.wav` (verified 24kHz
      mono PCM16), AGENTS.md cites the source/license, and a missing converter
      prints an actionable error. Add `assets/wait-loop.wav` to root `.gitignore`.

- [x] Implement `apps/voice-room-node/src/audio/wait-loop.ts`: given a WAV path and
      a playback handle, decode once and enqueue frames on repeat until `stop()`,
      so the loop plays continuously for an arbitrarily long wait.
      Done when: `pnpm test apps/voice-room-node/src/audio/wait-loop.test.ts` passes
      — frames keep enqueuing past one clip length (it loops) and `stop()` halts
      enqueue promptly.

- [x] Implement `apps/voice-room-node/src/audio/endpoint.ts`: consume capture
      frames after a wake, buffer the PCM utterance, and resolve it when trailing
      silence exceeds `endpointing.silenceMs` or the `maxUtteranceMs` cap is hit.
      Done when: `pnpm test apps/voice-room-node/src/audio/endpoint.test.ts`
      passes — a speech-then-silence fixture resolves at the silence boundary and a
      non-stop stream resolves at the `maxUtteranceMs` cap.

### On-device STT / TTS / agent turn

- [x] Implement `apps/voice-room-node/src/stt/transcribe.ts`: send a PCM16 24kHz
      utterance to ElevenLabs speech-to-text and return the transcript string; key
      from `ELEVENLABS_API_KEY`, HTTP client injectable for tests.
      Done when: `pnpm test apps/voice-room-node/src/stt/transcribe.test.ts` passes
      with a stubbed client returning a known transcript; it errors clearly when
      the key is absent.

- [x] Implement `apps/voice-room-node/src/agent/brevity.ts`: export the brevity
      preamble constant and `prependBrevity(text)` that returns the preamble + the
      user's transcript (ask for a 1–2 sentence, plain-text spoken answer).
      Done when: `pnpm test apps/voice-room-node/src/agent/brevity.test.ts` passes —
      the preamble prefixes the message and the original transcript is preserved
      verbatim.

- [x] Implement `apps/voice-room-node/src/agent/request.ts`: over the gateway
      client, `chat.send` the prepended text and `agent.wait` for the terminal
      result, returning the reply text; typed params/result and a bounded timeout.
      Done when: `pnpm test apps/voice-room-node/src/agent/request.test.ts` passes
      against a stub gateway client — `chat.send` receives the prepended text and
      the reply text is read from the `agent.wait` terminal result.

- [x] Implement `apps/voice-room-node/src/tts/synthesize.ts`: ElevenLabs TTS of the
      reply text into base64 PCM16 24kHz frames for `playback.ts`; voice/model ids
      from config with defaults, key from env, client injectable.
      Done when: `pnpm test apps/voice-room-node/src/tts/synthesize.test.ts` passes
      with a stubbed client yielding non-empty ordered frames.

### Orchestrator + wiring

- [x] Implement `apps/voice-room-node/src/session/talk-node.ts` state machine:
      `idle → capturing → thinking → speaking → idle`. On wake: capture+endpoint →
      STT → `prependBrevity` → **start wait-loop** + agent request → on reply
      **stop wait-loop** → TTS → playback → idle. Mute the mic while `thinking`/
      `speaking` so the wait loop and TTS cannot re-trigger wake.
      Done when: `pnpm test apps/voice-room-node/src/session/talk-node.test.ts`
      passes with stubbed STT/agent/TTS — state order is correct and the mic is
      gated during `thinking`/`speaking`.

- [x] Assert the wait-music timing contract in `talk-node.test.ts`: the wait loop
      starts only after the utterance is submitted (post-STT, at `chat.send`) and
      stops the instant the reply text arrives, before TTS playback begins — never
      before submit, never overlapping the spoken reply.
      Done when: `talk-node.test.ts` asserts wait-loop start-after-submit and
      stop-before-reply ordering.

- [x] Wire wake → turn in `main.ts`: replace the push-to-talk (SIGUSR1/SIGUSR2)
      trigger with the wake trigger, connect the gateway, open ElevenLabs STT/TTS + the wait loop, and run one talk-node turn per wake; clean shutdown of all.
      Done when: the app build/typecheck lane passes and a boot unit test wires
      wake → one turn against stubs.

### Tests + gate

- [x] Add `apps/voice-room-node/src/session/talk-node.integration.test.ts` (multi
      stub) spanning wake → stub STT transcript → stub gateway (`chat.send`/
      `agent.wait`) verbose reply → stub TTS bytes → playback stub. Assert: the
      prepend is present in `chat.send`, the wait loop played then stopped before
      the reply, and no audio/PCM before wake.
      Done when: the integration test passes end to end against stubs.

- [x] Verify the ElevenLabs live path at the API level (no hardware): STT
      transcribes a fixture utterance and TTS returns playable audio, reusing
      existing live helpers.
      Done when: `OPENCLAW_LIVE_TEST=1` runs the app's ElevenLabs live test (skips
      cleanly without the flag/key), asserting a non-empty transcript and non-empty
      audio bytes.

- [ ] **Layer 2 confirmation gate (live, on the speaker).** Run the node on the
      amd/PowerConf box against a real gateway/OpenClaw with `ELEVENLABS_API_KEY`
      set. Say "Hey Jarvis", then a question ("what's the date"). Confirm: the wait
      loop plays while OpenClaw thinks, then a **succinct 1–2 sentence** reply is
      spoken from the PowerConf. Record end-to-end latency, wait-loop start/stop,
      and the reply text in `voice-room.e2e.md`.
      Done when: `voice-room.e2e.md` records a live turn — wake → question →
      wait-music during processing → succinct spoken reply through the speaker.

---

## Layer 3 — (folded into Layer 2)

Brevity is now applied in Layer 2 by prepending a 1–2 sentence instruction to the
transcript before `chat.send`, so there is no separate Layer 3 build. The Layer 2
gate already confirms the spoken reply is succinct.

Optional future hardening (only if the client-side prepend proves insufficient):
move the brevity ask to a server-side session persona in
`src/talk/agent-run-control.ts`, flagged by a wake/`source` marker, so the user's
transcript is sent clean. Not scheduled; open a fresh step if wanted.

---

## Hardening (service, doctor, soak, runbook)

Operational robustness once the three layers are confirmed. Not gated on live
speaker confirmation between steps.

- [ ] Add `apps/voice-room-node/openclaw-voice-room.service` (systemd user unit)
      that runs the node, and document enabling it (including
      `loginctl enable-linger`) in the app AGENTS.md/README.
      Done when: `systemd-analyze verify
  apps/voice-room-node/openclaw-voice-room.service` reports no errors (or
      `systemctl --user cat` loads it cleanly on the box).

- [ ] Add an `openclaw doctor` finding that reports when the voice-room
      device/service is expected but the ALSA device is missing or the systemd
      unit is not active, tying into existing Doctor systemd-linger findings; keep
      it in the appropriate doctor owner (core vs plugin) per boundary rules.
      Done when: `pnpm test <the doctor finding's test path>` passes — with the
      device/unit absent the finding is emitted; with both present it is not.

- [ ] Add `apps/voice-room-node/scripts/soak-replay.ts` (no-hardware harness) that
      replays the wake/silence fixtures through the stubbed
      capture→gateway→playback path and emits wake latency, end-to-end latency,
      and false-accept count.
      Done when: running `soak-replay.ts` against the fixtures prints a metrics
      record containing wake-latency, end-to-end-latency, and false-accept fields.

- [ ] Expand `apps/voice-room-node/voice-room.e2e.md` into a full runbook with a
      Results table (wake latency, end-to-end latency, false-accept count over a
      10-min quiet soak) holding a no-hardware baseline row (from `soak-replay.ts`)
      and a real-hardware row measured on the Anker box.
      Done when: `voice-room.e2e.md` contains the runbook plus a Results table with
      both the no-hardware baseline row (numbers from `soak-replay.ts`) and the
      real-hardware row filled in (target 0 false accepts), no placeholder cells.

---

## Closeout

- [ ] Run a `/code-review` pass over the changed surface and capture each
      accepted/actionable finding as a `- [ ]` item in
      `apps/voice-room-node/REVIEW.md` (write "No findings." if clean); reorder
      most-severe first and split bundled items into single-fix items.
      Done when: `apps/voice-room-node/REVIEW.md` lists the review's actionable
      findings as single-fix checkboxes ordered most-severe first, or "No findings."

- [ ] Resolve findings one per focused pass, in severity order, checking each off
      with a one-line resolving-change note (refactor rather than patch where the
      finding calls for it), until none remain; then run a fresh confirmation
      `/code-review` and repeat until a run is clean.
      Done when: a `/code-review` run reports no accepted/actionable findings and
      `apps/voice-room-node/REVIEW.md` has no unchecked `- [ ]` items.

- [ ] Run the scoped test and typecheck/build lanes for the changed surface.
      Done when: `pnpm test:changed` (or scoped `pnpm test <paths>`) is green and
      the app typecheck/build lane passes.
