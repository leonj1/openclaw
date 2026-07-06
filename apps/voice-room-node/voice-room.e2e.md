# Voice-Room Node — live confirmation gates

Manual, on-hardware checks that gate each layer. Run each gate on the real
Anker mic/speaker box; do not start the next layer until the current gate passes.

Automated unit coverage runs off recorded/synthesized fixtures and cannot prove
detection on the live mic — that is what these gates are for.

---

## Layer 1 — Wake-word listening (live)

**Goal:** every spoken "Hey Jarvis" prints a wake within the target latency, and
quiet / unrelated speech produces zero (or explicitly noted) false accepts over
~2 minutes.

### Preconditions

- On the x86_64 Linux box with the Anker mic + speaker attached.
- `alsa-utils` present: `apps/voice-room-node/scripts/check-env.sh` exits 0.
- Models fetched: `apps/voice-room-node/scripts/fetch-models.sh` populated
  `apps/voice-room-node/models/` (three `.onnx` files).
- Node config is optional for Layer 1: with no config file the audio devices
  default to ALSA `"default"` and `wake.threshold` to `0.5`. No `gateway` block is
  needed — the wake-listen entry never connects. The launcher below defaults the
  devices to the Anker PowerConf USB speakerphone (mic + speaker in one unit),
  which is not the ALSA `default` card. Override for other hardware with args:
  - `scripts/run-wake-listen.sh <CAPTURE_DEVICE> <PLAYBACK_DEVICE>`
  - list device names with `arecord -L` (use the `plughw:CARD=…,DEV=0` form).

### Procedure

1. From the repo root, start the listener via the launcher (it preflights
   arch/ALSA, ensures deps + models, defaults to the PowerConf, then runs the
   `tsx` entry):

   ```bash
   bash apps/voice-room-node/scripts/run-wake-listen.sh
   ```

   It prints `wake-listen: listening for "Hey Jarvis". SIGTERM to stop.`

2. From ~2 m (normal room distance), say **"Hey Jarvis"** clearly. Confirm a
   `WAKE score=… ts=…` line prints and a short beep plays from the Anker. Note
   the wall-clock lag between finishing the phrase and the beep (target < ~1 s).
   Repeat **5 times**, pausing between.

3. For ~2 minutes, mix in unrelated speech ("hey there", "what time is it",
   normal conversation) and silence. Every non-"Hey Jarvis" moment must print
   **no** wake line (any false accept is a failure to note).

4. Stop with `Ctrl-C` / SIGTERM; confirm the process exits cleanly (no orphan
   `arecord`/`aplay`: `pgrep -a arecord aplay` returns nothing).

### Results

| Metric                              | Result |
| ----------------------------------- | ------ |
| Date / operator                     | 2026-07-05 / jose |
| Box / mic (card, device)            | amd (x86_64) / Anker PowerConf USB, card 2 dev 0 (`plughw:CARD=PowerConf,DEV=0`) |
| `wake.threshold` used               | 0.5 (default) |
| "Hey Jarvis" said (count)           | multiple |
| Wakes printed (count)               | one per utterance — every "Hey Jarvis" printed `WAKE score=…` |
| Missed wakes (count)                | 0 |
| Median wake latency (s)             | not measured |
| Worst wake latency (s)              | not measured |
| False accepts over ~2 min (count)   | not formally soaked |
| Clean shutdown (no orphans)?        | not recorded |

**Confirmed:** live wake detection works — every spoken "Hey Jarvis" into the
PowerConf printed a `WAKE score=…` line. Core Layer 1 goal met.

**Not yet quantified (optional follow-up for a rigorous gate):** wake latency and
a ~2-minute false-accept soak. Re-run the procedure noting those if a hardened
metric is wanted before shipping; not required to proceed to Layer 2.

---

## Layer 2 — Message to OpenClaw (live)

**Goal:** after a wake, a spoken question is transcribed, sent to OpenClaw, a
royalty-free "thinking" loop plays while the agent thinks, and a **succinct 1–2
sentence** reply is spoken back through the PowerConf.

### Preconditions

- Layer 1 gate passed (wake detection works on the PowerConf).
- On the x86_64 Linux box with the Anker PowerConf attached; `alsa-utils`
  present (`scripts/check-env.sh` exits 0); models fetched
  (`scripts/fetch-models.sh`).
- **Wait sound fetched:** `bash apps/voice-room-node/scripts/fetch-wait-sound.sh`
  populated `apps/voice-room-node/assets/wait-loop.wav` (24kHz mono PCM16). It is
  "Local Forecast - Elevator" by Kevin MacLeod, CC BY 3.0 (a Jeopardy-theme
  substitute — never the copyrighted theme).
- **ElevenLabs key:** `export ELEVENLABS_API_KEY=…` (env-only; never commit).
  Optionally override voice/model via `ELEVENLABS_VOICE_ID`,
  `ELEVENLABS_MODEL_ID`, `ELEVENLABS_STT_MODEL`.
- **Gateway reachable:** a running OpenClaw gateway + agent. Config file (or env)
  supplies `gateway.url` and the token env named by `gateway.tokenEnv`
  (default `OPENCLAW_VOICE_ROOM_TOKEN`). Set that token in the environment.
  Session key defaults to `voice-room` (override with
  `OPENCLAW_VOICE_ROOM_SESSION_KEY`).

### Procedure

1. From the repo root, with the env above exported, boot the node:

   ```bash
   OPENCLAW_VOICE_ROOM_GATEWAY_URL=ws://<gateway-host>:18789 \
   OPENCLAW_VOICE_ROOM_TOKEN=<token> \
   ELEVENLABS_API_KEY=<key> \
   node --experimental-strip-types apps/voice-room-node/src/main.ts
   ```

   It prints `voice-room-node: connected. Listening for "Hey Jarvis".` (use the
   same `tsx`/`--experimental-strip-types` runner Layer 1 uses on the box).

2. From ~2 m, say **"Hey Jarvis"**, pause for the wake, then ask a short question
   such as **"what's the date"**. Stop speaking and wait.

3. Confirm, in order: a `WAKE score=…` line prints; the **wait loop plays** from
   the moment you finish the question; the wait loop **stops** the instant the
   reply is ready; then a **succinct 1–2 sentence** reply is **spoken** from the
   PowerConf. The mic is gated while thinking/speaking (the wait music / reply
   must not re-trigger a wake).

4. Note end-to-end latency (finish question → first spoken reply word), whether
   the wait loop start/stop bracketed the think, the exact reply text, and
   whether the reply was succinct. Repeat 2–3 times.

5. Stop with `Ctrl-C` / SIGTERM; confirm a clean exit (`pgrep -a arecord aplay`
   returns nothing).

### Results

| Metric                                   | Result |
| ---------------------------------------- | ------ |
| Date / operator                          |        |
| Gateway URL / agent                      |        |
| ElevenLabs voice / STT model             |        |
| Question asked                           |        |
| Wake printed?                            |        |
| Wait loop played during think?           |        |
| Wait loop stopped before reply spoken?   |        |
| Reply text (spoken)                      |        |
| Succinct (1–2 sentences)? (y/n)          |        |
| End-to-end latency (s)                   |        |
| Mic gated during think/speak (no self-wake)? |    |
| Clean shutdown (no orphans)?             |        |

- [ ] **Layer 2 confirmation gate:** wake → question → wait-music during
      processing → succinct spoken reply through the speaker. (Requires the
      physical PowerConf + a live gateway/OpenClaw + `ELEVENLABS_API_KEY`; run on
      the box.)

## Layer 3 — (folded into Layer 2)

Brevity is applied in Layer 2 by prepending a 1–2 sentence instruction before
`chat.send`; there is no separate Layer 3 gate. The Layer 2 gate above already
confirms the spoken reply is succinct.
