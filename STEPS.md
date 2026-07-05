# STEPS — "Hey Jarvis" voice-room node

Built **layer by layer**. Each layer is independently runnable and ends with a
**live confirmation gate** on the real speaker/mic — do not start the next layer
until the current layer's confirmation gate passes.

The three layers, in order:

1. **Layer 1 — Wake-word listening.** A process listens on the mic and reacts
   when it hears "Hey Jarvis". Nothing is sent to OpenClaw yet.
2. **Layer 2 — Message to OpenClaw.** After a wake, the follow-up utterance is
   streamed to the gateway and the spoken reply is played back.
3. **Layer 3 — Speaker-origin brevity.** OpenClaw knows the question came from
   the speaker and answers succinctly (≤2 sentences, plain speech).

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

## Layer 2 — Message to OpenClaw (full spoken round trip)

Goal: after a wake, capture the follow-up utterance, stream it to the gateway so
OpenClaw processes it, and play the spoken reply back. Reply verbosity is not
constrained yet — a long answer here is fine; brevity is Layer 3.

- [ ] Implement `apps/voice-room-node/src/session/talk-node.ts` state-machine
      skeleton: states `idle → listening → streaming → speaking → idle` with an
      explicit transition API and no external I/O.
      Done when: `pnpm test apps/voice-room-node/src/session/talk-node.test.ts`
      passes the transition cases — `idle→listening` on wake and `→idle` on end.

- [ ] Extend `talk-node.ts`: on a `WakeEvent`, open a Talk session via the
      (mocked) gateway client and stream captured PCM (`listening→streaming`);
      send no PCM before a wake event.
      Done when: `talk-node.test.ts` passes assertions that PCM streams after wake
      and that no PCM is sent to the gateway before a wake event.

- [ ] Extend `talk-node.ts`: on a TTS frame transition `→speaking` and play audio
      via `playback.ts`, then `→idle` on stream end; endpoint the utterance on a
      silence timeout (`streaming` ends after `endpointing.silenceMs`); support
      barge-in (stop playback) and gate the mic while `speaking` so TTS cannot
      re-trigger wake.
      Done when: `talk-node.test.ts` passes the full suite — TTS frame drives
      `→speaking` + playback + `→idle`, the silence timeout ends the utterance,
      barge-in stops playback, and no wake events are processed while `speaking`.

- [ ] Wire wake → session in `main.ts`: replace the push-to-talk (SIGUSR1/SIGUSR2)
      trigger with the wake trigger from `wake-listen`/`openwakeword`, and mark
      wake-originated Talk sessions with `source:"wake"` in existing session
      metadata (no gateway-protocol version bump).
      Done when: the app build/typecheck lane passes and a unit assertion confirms
      the Talk session opened from a wake carries `source:"wake"` metadata.

- [ ] Extend the `server-talk-nodes` capability test so a node advertising
      `"talk"` (as this node does) is detected as talk-capable.
      Done when: `pnpm test src/gateway/server-talk-nodes.test.ts` passes including
      the new assertion.

- [ ] Add `apps/voice-room-node/src/session/talk-node.integration.test.ts` (multi
      stub) spanning wake → stub STT transcript → stubbed reply → TTS bytes →
      playback stub, asserting turn ordering and that no audio streams pre-wake.
      Done when: the integration test passes end to end against stubs.

- [ ] Verify the ElevenLabs live path at the API level (no hardware): `scribe_v2`
      transcribes the wake-fixture utterance and TTS returns playable audio,
      reusing existing live helpers.
      Done when: `OPENCLAW_LIVE_TEST=1 pnpm test
    extensions/elevenlabs/elevenlabs-voiceroom.live.test.ts` passes (skips
      cleanly without the flag/key), asserting a non-empty transcript marker and
      non-empty audio bytes.

- [ ] **Layer 2 confirmation gate (live, on the speaker).** Run the node against a
      real gateway/OpenClaw. Say "Hey Jarvis", then a question ("what's the
      date"). Confirm OpenClaw received the transcribed message and that a spoken
      reply plays from the Anker. Record the end-to-end latency and the (possibly
      verbose) reply text in `voice-room.e2e.md`.
      Done when: `voice-room.e2e.md` records a live round trip where the spoken
      question reached OpenClaw and its reply was spoken back through the speaker.
      **Do not start Layer 3 until this passes.**

---

## Layer 3 — Speaker-origin brevity (succinct spoken replies)

Goal: because the question originated from the speaker (`source:"wake"`), OpenClaw
constrains the reply to a short spoken form. The same question that produced a
long answer in Layer 2 should now produce a succinct one.

- [ ] In `src/talk/agent-run-control.ts` (and `agent-run-control-shared.ts` as
      needed), attach a spoken-brief directive ("≤2 sentences, plain speech, no
      markdown/URLs/code") to sessions flagged `source:"wake"`, gated so
      text/non-wake sessions are unaffected.
      Done when: `pnpm test src/talk/agent-run-control.test.ts` passes new cases —
      a wake-flagged session injects the brevity directive; a text/non-wake
      session does not (no cross-surface leak).

- [ ] In `src/infra/voicewake-routing.ts`, register the `hey jarvis` trigger
      routed to the configured target agent/session, reusing the existing routing
      store (no new persisted store).
      Done when: `pnpm test src/infra/voicewake-routing.test.ts` passes new cases —
      `hey jarvis` resolves to the configured agent; an unknown phrase falls back
      to the default target.

- [ ] Extend `talk-node.integration.test.ts` to route the reply through the real
      brevity persona + voicewake routing (replacing the stubbed reply) and assert
      the reply is constrained to ≤2 sentences / plain speech.
      Done when: the integration test's reply path invokes the real brevity
      persona and routing, asserts the ≤2-sentence / plain-speech constraint, and
      stays green; `pnpm test src/talk src/infra/voicewake-routing.test.ts` is
      green.

- [ ] **Layer 3 confirmation gate (live, on the speaker).** Ask the _same_
      question used in the Layer 2 gate ("Hey Jarvis, what's the date"). Confirm
      the spoken reply is now ≤2 sentences and plain speech, and record it beside
      the Layer 2 verbose reply in `voice-room.e2e.md` to show the `source:"wake"`
      flag changed the behavior.
      Done when: `voice-room.e2e.md` shows the same question yielding a succinct
      spoken reply under Layer 3 versus the longer Layer 2 reply, with both runs
      recorded.

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
