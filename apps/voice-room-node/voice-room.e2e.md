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

_Filled in when Layer 2 is built._

## Layer 3 — Speaker-origin brevity (live)

_Filled in when Layer 3 is built._
