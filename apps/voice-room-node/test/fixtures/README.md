# Wake-word audio fixtures

Audio clips the Layer 1 wake tests run against. Everything here is the node-wide
audio format — anything off-format is a bug the fixtures must catch:

- **PCM16 / 24kHz / mono** (`-f S16_LE -r 24000 -c1`), canonical WAV container.

`format-check.test.ts` asserts every `*.wav` in this directory matches that
format, so a mis-recorded clip fails fast instead of silently degrading detection.

## Files

| File             | Role      | Contents                                             |
| ---------------- | --------- | ---------------------------------------------------- |
| `silence.wav`    | control   | 1s of digital silence (generated programmatically).  |
| `hey_jarvis.wav` | wake      | One clear "Hey Jarvis" utterance, room distance.     |
| `hey_there.wav`  | non-wake  | One "Hey there" utterance (near-miss that must not fire). |

Naming is a contract the tests rely on: `hey_jarvis.wav` is the positive case
(exactly one wake), `hey_there.wav` and `silence.wav` are negatives (zero wakes).

## Producing the wake / non-wake clips

Two supported paths, both writing straight into this directory in the required
format:

1. **Record on real hardware** (preferred — matches the deployment mic):

   ```bash
   apps/voice-room-node/scripts/record-fixtures.sh
   ```

   Uses `arecord -f S16_LE -r 24000 -c1`. Verify with `soxi hey_jarvis.wav`
   (or `ffprobe`): sample rate 24000, 1 channel, 16-bit.

2. **Synthesize via ElevenLabs** (no mic available):

   ```bash
   OPENCLAW_LIVE_TEST=1 ELEVENLABS_API_KEY=... \
     node apps/voice-room-node/scripts/synth-fixtures.ts
   ```

   Skips cleanly (writes nothing, exits 0) when the flag or key is absent.

Regenerate `silence.wav` at any time — it is 1s of zero-valued PCM16 24kHz mono
samples wrapped in a canonical WAV header (see `src/audio/wav.ts`).
