# STEPS — "Hey Jarvis" voice-room node

Ordered, individually completable steps. Each ends with a concrete acceptance
condition. Do not mark a step done until its `Done when:` check passes.

## Phase 0 — Scaffolding & dependency approval

- [x] Add `apps/voice-room-node/scripts/check-env.sh`: a preflight script that runs `arecord --version` and `aplay --version`, prints the machine arch (`uname -m`), and exits non-zero if ALSA tools are missing or the arch is not `x86_64`.
  Done when: `bash apps/voice-room-node/scripts/check-env.sh` on the target box exits 0 and prints the `arecord`/`aplay` versions and `x86_64`.

- [x] Create `apps/voice-room-node/APPROVALS.md` documenting the `onnxruntime-node` dependency: its rationale (openWakeWord ONNX inference), that x86_64 Linux was confirmed via `scripts/check-env.sh`, and an explicit `Approving PR/issue:` field initialized to `PENDING`.
  Done when: `apps/voice-room-node/APPROVALS.md` exists, names `onnxruntime-node`, states x86_64 Linux was confirmed, and contains an `Approving PR/issue:` line.

- [x] Add a dependency-approval request draft at `apps/voice-room-node/APPROVALS.request.md` (issue/PR body) that names `onnxruntime-node`, its pinned version, arch (x86_64 Linux), and rationale, and asks a maintainer to approve the dependency addition.
  Done when: `apps/voice-room-node/APPROVALS.request.md` exists and names the dependency, version, arch, and rationale, ready to paste into a GitHub issue/PR.

- [ ] Once a maintainer grants approval, replace the `PENDING` value on the `Approving PR/issue:` line in `APPROVALS.md` with the real approving PR/issue URL.
  Done when: the `Approving PR/issue:` line in `apps/voice-room-node/APPROVALS.md` contains a `https://github.com/openclaw/openclaw/...` URL and no longer says `PENDING`.

- [ ] Create `apps/voice-room-node/package.json` (private, ESM, name `@openclaw/voice-room-node`) with `onnxruntime-node` as a dependency and `vitest` for tests; add an `AGENTS.md` for the app subtree plus a sibling `CLAUDE.md` symlink to it.
  Done when: `apps/voice-room-node/package.json` exists with `onnxruntime-node` listed, `ls -l apps/voice-room-node/CLAUDE.md` shows a symlink to `AGENTS.md`, and `pnpm install` completes without error.

- [ ] Verify (and edit if needed) the package-exclude/core-dist config so `apps/voice-room-node` is excluded from the core dist build, per architecture rules.
  Done when: the package-exclude/core-dist config lists `apps/voice-room-node`, and a core dist build (`pnpm build`) produces no files from `apps/voice-room-node`.

- [ ] Verify `onnxruntime-node` does not leak into the root package: confirm it is declared only in `apps/voice-room-node/package.json` and not in the root `package.json`.
  Done when: `grep onnxruntime-node package.json` at the repo root returns no match, while `apps/voice-room-node/package.json` still lists it.

- [ ] Add an `apps/voice-room-node/**` rule to `.github/labeler.yml` for the new app surface.
  Done when: `.github/labeler.yml` contains a rule matching `apps/voice-room-node/**`.

- [ ] Create the matching GitHub label for the new app surface referenced by the `.github/labeler.yml` rule (external, out-of-repo action).
  Done when: `gh label list` shows the label named in the new `.github/labeler.yml` rule.

- [ ] Add `apps/voice-room-node/src/config.ts` defining a typed node config (gateway URL/token source, ALSA capture + playback device ids, wake threshold, silence/endpointing timeouts) loaded from a node-local config file/env, with schema validation via `zod` or an existing helper.
  Done when: `pnpm test apps/voice-room-node/src/config.test.ts` passes a test that valid config parses and an invalid one (missing gateway URL) is rejected.

## Phase 1 — Device node skeleton (capture/playback + gateway + push-to-talk)

- [ ] Implement `apps/voice-room-node/src/audio/capture.ts`: spawn `arecord -f S16_LE -r 24000 -c1 -D <device>`, emit fixed-size PCM16 frames, apply backpressure, and clean up the child on SIGTERM.
  Done when: `pnpm test apps/voice-room-node/src/audio/capture.test.ts` passes — using a fake `arecord` stub script it asserts the spawn flags (`S16_LE`, `24000`, `1` channel), frame chunking size, backpressure, and clean SIGTERM shutdown.

- [ ] Implement `apps/voice-room-node/src/audio/playback.ts`: spawn `aplay` for PCM16 24kHz, queue and drain base64 TTS frames, expose a barge-in `stop()` that flushes the queue and kills playback, and clean up on SIGTERM.
  Done when: `pnpm test apps/voice-room-node/src/audio/playback.test.ts` passes — with a fake `aplay` stub it asserts format flags, ordered frame draining, that `stop()` halts output mid-queue, and clean SIGTERM.

- [ ] Implement `apps/voice-room-node/src/gateway/connect.ts`: connect to the gateway via `packages/gateway-client` using the config, and advertise capability `"talk"`, exposing a small typed handle (send PCM, receive TTS frames, close).
  Done when: `pnpm test apps/voice-room-node/src/gateway/connect.test.ts` passes — against a stub gateway it asserts the client connects and registers a node advertising cap `"talk"`.

- [ ] Implement `apps/voice-room-node/src/main.ts` boot path: load config, open capture/playback, and call the gateway connect helper; wire clean shutdown of all three on SIGTERM. No push-to-talk or streaming yet.
  Done when: `pnpm build` (or the app's build/typecheck lane) succeeds for `apps/voice-room-node`, and running `main.ts` against a local/stub gateway connects and registers a node advertising cap `"talk"` (observed in gateway logs or a stub assertion).

- [ ] Add a manual push-to-talk trigger (e.g. stdin/signal) in `main.ts` that streams one captured utterance to the gateway and plays the TTS reply through playback.
  Done when: with a stub gateway, firing the trigger streams captured PCM frames to the gateway and the playback stub receives the reply audio (asserted in a test or observed manually).

- [ ] Extend the `server-talk-nodes` capability test so a node advertising `"talk"` (as the voice-room node does) is detected as talk-capable.
  Done when: `pnpm test src/gateway/server-talk-nodes.test.ts` passes including the new assertion.

- [ ] Verify the ElevenLabs live path end-to-end at the API level (no hardware): `scribe_v2` transcribes the wake-fixture utterance and TTS returns playable audio, reusing existing live helpers.
  Done when: `OPENCLAW_LIVE_TEST=1 pnpm test extensions/elevenlabs/elevenlabs-voiceroom.live.test.ts` passes (skips cleanly when the flag/key is absent), asserting a non-empty transcript marker and non-empty audio bytes.

## Phase 2 — Wake word + session state machine

- [ ] Add `apps/voice-room-node/scripts/fetch-models.sh` that downloads the three openWakeWord ONNX artifacts (`hey_jarvis`, shared `melspectrogram`, and `embedding`) into `apps/voice-room-node/models/`, and note their Apache-2.0 license in the app AGENTS.md/README.
  Done when: running the script populates the three ONNX files under `apps/voice-room-node/models/` and the Apache-2.0 license is noted in the app AGENTS.md/README.

- [ ] Add a silence WAV fixture (generated programmatically) plus a `README`/recipe under `apps/voice-room-node/test/fixtures/` documenting the required format (24kHz mono PCM16) and how the "hey jarvis" / "hey there" clips must be recorded.
  Done when: a silence WAV in the documented format exists under `apps/voice-room-node/test/fixtures/` and the recipe README states the exact format and naming for the wake/non-wake clips.

- [ ] Add `apps/voice-room-node/scripts/record-fixtures.sh` that uses `arecord -f S16_LE -r 24000 -c1` to capture `hey_jarvis.wav` (wake) and `hey_there.wav` (non-wake) into `apps/voice-room-node/test/fixtures/` in the documented format.
  Done when: running `bash apps/voice-room-node/scripts/record-fixtures.sh` writes `hey_jarvis.wav` and `hey_there.wav` as 24kHz mono PCM16 WAVs (verified via `soxi`/`ffprobe`).

- [ ] Add `apps/voice-room-node/test/fixtures/format-check.test.ts` that asserts each wake/non-wake WAV under `test/fixtures/` is 24kHz mono PCM16.
  Done when: `pnpm test apps/voice-room-node/test/fixtures/format-check.test.ts` passes for a correctly-formatted WAV and fails for a deliberately malformed one.

- [ ] Add `apps/voice-room-node/scripts/synth-fixtures.ts` that synthesizes "hey jarvis" (wake) and "hey there" (non-wake) utterances via the existing ElevenLabs TTS live helper and converts the output to 24kHz mono PCM16 WAVs under `test/fixtures/`, for use when no human recording is available.
  Done when: with `OPENCLAW_LIVE_TEST=1` and a key set, running the script writes `hey_jarvis.wav` and `hey_there.wav` that pass `format-check.test.ts`; it skips cleanly when the flag/key is absent.

- [ ] Produce and place the final `hey_jarvis.wav` (wake) and `hey_there.wav` (non-wake) clips under `apps/voice-room-node/test/fixtures/` using `record-fixtures.sh` or `synth-fixtures.ts`.
  Done when: `hey_jarvis.wav` and `hey_there.wav` exist alongside the silence fixture and pass `format-check.test.ts` (each 24kHz mono PCM16).

- [ ] Implement `apps/voice-room-node/src/wake/onnx-sessions.ts`: load the mel, embedding, and `hey_jarvis` ONNX sessions from `models/` via `onnxruntime-node` and expose typed run helpers.
  Done when: `pnpm test apps/voice-room-node/src/wake/onnx-sessions.test.ts` passes — it loads all three sessions and asserts their expected input/output tensor names and shapes.

- [ ] Implement `apps/voice-room-node/src/wake/features.ts`: transform a PCM16 window through the mel-spectrogram model then the embedding model, producing the embedding vector shape openWakeWord's classifier expects.
  Done when: `pnpm test apps/voice-room-node/src/wake/features.test.ts` passes — a fixture PCM window yields an embedding tensor of the expected shape.

- [ ] Implement `apps/voice-room-node/src/wake/openwakeword.ts`: run a sliding audio window through features → `hey_jarvis`, compute a per-window score, and emit `WakeEvent{score,ts}` when the score crosses the configured threshold (no debounce yet).
  Done when: `pnpm test apps/voice-room-node/src/wake/openwakeword.test.ts` passes the threshold cases — the "hey jarvis" fixture yields at least one window above threshold; silence and "hey there" yield none.

- [ ] Add debounce to `openwakeword.ts` so rapid repeated crossings collapse into a single `WakeEvent`.
  Done when: `pnpm test apps/voice-room-node/src/wake/openwakeword.test.ts` passes the full set — exactly one `WakeEvent` for "hey jarvis", none for silence/"hey there", and two utterances 200ms apart produce a single (debounced) wake.

- [ ] Implement `apps/voice-room-node/src/session/talk-node.ts` state-machine skeleton: states `idle → listening → streaming → speaking → idle` with an explicit transition API and no external I/O.
  Done when: `pnpm test apps/voice-room-node/src/session/talk-node.test.ts` passes the transition cases — `idle→listening` on wake and `→idle` on end.

- [ ] Extend `talk-node.ts`: on wake open a Talk session via the (mocked) gateway client and stream captured PCM (`listening→streaming`); send no PCM before a wake event.
  Done when: `pnpm test apps/voice-room-node/src/session/talk-node.test.ts` passes assertions that PCM is streamed after wake and that no PCM is sent to the gateway before a wake event.

- [ ] Extend `talk-node.ts`: on a TTS frame transition `→speaking` and play audio via playback, then `→idle` on stream end.
  Done when: `pnpm test apps/voice-room-node/src/session/talk-node.test.ts` passes assertions that a TTS frame drives `→speaking`, playback receives the audio, and `→idle` on end.

- [ ] Extend `talk-node.ts`: endpoint the utterance on a silence timeout (`streaming` ends after configured silence).
  Done when: `pnpm test apps/voice-room-node/src/session/talk-node.test.ts` passes the silence-timeout case — the utterance ends when the silence timeout elapses.

- [ ] Extend `talk-node.ts`: support barge-in (stop playback) and gate the mic while `speaking` so TTS cannot re-trigger wake.
  Done when: `pnpm test apps/voice-room-node/src/session/talk-node.test.ts` passes the full suite including barge-in stopping playback and no wake events being processed while `speaking`.

- [ ] Wire wake → session in `main.ts` (replace the push-to-talk trigger with the wake trigger) and mark wake-originated Talk sessions with `source:"wake"` in existing session metadata (no gateway-protocol version bump).
  Done when: the app build/typecheck lane passes and a unit assertion confirms the Talk session opened from a wake carries `source:"wake"` metadata.

- [ ] Add the multi-stub integration test `apps/voice-room-node/src/session/talk-node.integration.test.ts` spanning wake → stub STT transcript → stubbed brief reply → TTS bytes → playback stub.
  Done when: the integration test passes: wake fixture → transcript → stubbed reply → TTS bytes → playback stub receives audio, asserting turn ordering and that no audio streams pre-wake.

## Phase 3 — Brevity persona + voicewake routing (core)

- [ ] In `src/talk/agent-run-control.ts` (and `agent-run-control-shared.ts` as needed), attach a spoken-brief directive ("≤2 sentences, plain speech, no markdown/URLs/code") to sessions flagged `source:"wake"`, gated so text/non-wake sessions are unaffected.
  Done when: `pnpm test src/talk/agent-run-control.test.ts` passes new cases: a wake-flagged session injects the brevity directive; a text/non-wake session does not (no cross-surface leak).

- [ ] In `src/infra/voicewake-routing.ts`, register the `hey jarvis` trigger routed to the configured target agent/session, reusing the existing routing store (no new persisted store).
  Done when: `pnpm test src/infra/voicewake-routing.test.ts` passes new cases: `hey jarvis` resolves to the configured agent; an unknown phrase falls back to the default target.

- [ ] Extend the Phase-2 integration test to route the reply through the real brevity persona + voicewake routing (replacing the stubbed reply) instead of the inline stub.
  Done when: the integration test's reply path invokes the real brevity persona and routing, and `apps/voice-room-node/src/session/talk-node.integration.test.ts` remains green.

- [ ] Assert the brevity constraint end-to-end and run the scoped core suites.
  Done when: the integration test confirms the reply is constrained to ≤2 sentences / plain speech, and `pnpm test src/talk src/infra/voicewake-routing.test.ts` is green.

## Phase 4 — Hardening (service, doctor, soak, runbook)

- [ ] Add `apps/voice-room-node/openclaw-voice-room.service` (systemd user unit) that runs the node, and document enabling it (including `loginctl enable-linger`) in the app AGENTS.md/README.
  Done when: `systemd-analyze verify apps/voice-room-node/openclaw-voice-room.service` reports no errors (or `systemctl --user cat` loads it cleanly on the box).

- [ ] Add an `openclaw doctor` finding that reports when the voice-room device/service is expected but the ALSA device is missing or the systemd unit is not active, tying into existing Doctor systemd-linger findings; keep it in the appropriate doctor owner (core vs plugin) per boundary rules.
  Done when: `pnpm test <the doctor finding's test path>` passes — with the device/unit absent the finding is emitted; with both present it is not.

- [ ] Write `apps/voice-room-node/voice-room.e2e.md` runbook for the physical box: "Hey Jarvis, what's the date" → ≤2-sentence spoken reply from the Anker, plus how to capture wake latency, end-to-end latency, and false-accept rate over a 10-minute quiet soak.
  Done when: `apps/voice-room-node/voice-room.e2e.md` exists with the step-by-step procedure and the exact commands/metrics to record.

- [ ] Add `apps/voice-room-node/scripts/soak-metrics.ts` (or `.sh`) that logs wake-event timestamps and computes wake latency, end-to-end latency, and false-accept count over a soak window, matching the runbook's metric fields.
  Done when: running the soak-metrics tool against a stub/replayed input produces the wake-latency, end-to-end-latency, and false-accept fields the runbook records.

- [ ] Add `apps/voice-room-node/scripts/soak-replay.ts` (no-hardware harness) that replays the wake/silence fixtures through the stubbed capture→gateway→playback path and emits the same metric fields as `soak-metrics` (wake latency, end-to-end latency, false-accept count).
  Done when: running `soak-replay.ts` against the wake/silence fixtures prints a metrics record containing wake-latency, end-to-end-latency, and false-accept fields.

- [ ] Add a "Results" table to `apps/voice-room-node/voice-room.e2e.md` with the exact metric fields to record (wake latency, end-to-end latency, false-accept count over a 10-min quiet soak) and empty value cells for a no-hardware baseline row and a real-hardware row.
  Done when: `voice-room.e2e.md` contains a Results table with wake-latency, end-to-end-latency, and false-accept-count rows and empty value cells to fill.

- [ ] Run `soak-replay.ts` and record its simulated baseline metrics into the `voice-room.e2e.md` Results table, labeled as a no-hardware baseline.
  Done when: the Results table's no-hardware baseline row is populated with numeric values produced by `soak-replay.ts`.

- [ ] Record the real-hardware E2E measurements into the `voice-room.e2e.md` Results table: run the runbook on the Anker box ("Hey Jarvis, what's the date" → ≤2-sentence spoken reply) plus the 10-min quiet soak, then enter the measured numbers.
  Done when: the Results table's real-hardware row is filled with measured wake-latency, end-to-end-latency, and false-accept-count values (target 0 false accepts) and no placeholder cells remain.

## Closeout

- [ ] Run a single `/code-review` (autoreview) pass over the changed surface and capture each accepted/actionable finding as a `- [ ]` checkbox item in `apps/voice-room-node/REVIEW.md` (write "No findings." if the pass is clean).
  Done when: `apps/voice-room-node/REVIEW.md` exists and lists the current review's actionable findings as checkboxes, or states "No findings."

- [ ] Triage `apps/voice-room-node/REVIEW.md`: reorder its findings most-severe first and split any item that bundles multiple independent changes into separate `- [ ]` items, each scoped to a single fix. Do not fix anything in this pass.
  Done when: every `- [ ]` item in `apps/voice-room-node/REVIEW.md` is a single discrete fix, ordered most-severe first, with no item bundling multiple independent changes.

- [ ] Resolve the top unchecked finding in `apps/voice-room-node/REVIEW.md`: implement only that one finding's fix (refactor rather than patch where the finding calls for it), then check that one item off with a one-line note of the resolving change. Leave all other findings untouched.
  Done when: the previously top-most unchecked finding in `apps/voice-room-node/REVIEW.md` is now checked off with a one-line resolving-change note, its fix is present in the working tree, and the count of unchecked items dropped by exactly one.

- [ ] Repeat the single-finding resolution above for each remaining unchecked finding in `apps/voice-room-node/REVIEW.md` — one finding per focused pass, in severity order — until none remain.
  Done when: `apps/voice-room-node/REVIEW.md` has no unchecked `- [ ]` finding items and each is annotated with its resolving change.

- [ ] Run a fresh confirmation `/code-review` pass over the changed surface and append every new accepted/actionable finding it reports to `apps/voice-room-node/REVIEW.md` as an unchecked `- [ ]` item (append nothing if the pass is clean). Do not fix anything in this pass.
  Done when: a fresh `/code-review` has been run and each new accepted/actionable finding it reported is present as an unchecked `- [ ]` item in `apps/voice-room-node/REVIEW.md` (or the file is unchanged because the pass was clean).

- [ ] Resolve the top unchecked finding appended by the confirmation review in `apps/voice-room-node/REVIEW.md`: implement only that one finding's fix (refactor rather than patch where called for), then check it off with a one-line resolving-change note. Leave other findings untouched.
  Done when: the top-most unchecked confirmation-review finding is checked off with a one-line resolving-change note and its fix is in the working tree.

- [ ] Repeat the single-finding resolution above for each remaining unchecked finding in `apps/voice-room-node/REVIEW.md` — one finding per focused pass — until none remain.
  Done when: `apps/voice-room-node/REVIEW.md` has no unchecked `- [ ]` finding items.

- [ ] Re-run `/code-review` as a final gate; append any newly surfaced accepted/actionable findings to `apps/voice-room-node/REVIEW.md` as unchecked items (to be handled by another resolution pass) and stop only when the run is clean.
  Done when: a `/code-review` run reports no accepted/actionable findings and `apps/voice-room-node/REVIEW.md` has no unchecked items.

- [ ] Run the scoped test and typecheck/build lanes for the changed surface.
  Done when: `pnpm test:changed` (or scoped `pnpm test <paths>`) is green and the app typecheck/build lane passes.

- [ ] Review `git diff --numstat` for LOC discipline and trim or justify any non-test growth.
  Done when: `git diff --numstat` has been reviewed and any non-test LOC growth is trimmed or explicitly justified in the PR.
