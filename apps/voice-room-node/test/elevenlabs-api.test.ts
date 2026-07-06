// ElevenLabs API-level live check for the Layer 2 STT + TTS path (no hardware).
//
// Skips cleanly unless OPENCLAW_LIVE_TEST is truthy AND ELEVENLABS_API_KEY is
// set, so it is safe in the default suite. When live, it does a self-contained
// round trip: TTS a phrase to PCM16 24kHz, then STT that audio back, asserting
// non-empty audio bytes and a non-empty transcript against the real endpoints
// this node uses in production (src/tts/synthesize.ts, src/stt/transcribe.ts).
//
// This file is intentionally NOT named `*.live.test.ts`: the app vitest config
// excludes that pattern, and this check must run when explicitly requested.
import { describe, expect, it } from "vitest";
import { synthesizeReply } from "../src/tts/synthesize.ts";
import { transcribeUtterance } from "../src/stt/transcribe.ts";

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const LIVE = TRUTHY.has((process.env.OPENCLAW_LIVE_TEST ?? "").trim().toLowerCase());
const HAS_KEY = Boolean(process.env.ELEVENLABS_API_KEY?.trim());
const describeLive = LIVE && HAS_KEY ? describe : describe.skip;

const BASE_URL = process.env.ELEVENLABS_BASE_URL ?? "https://api.elevenlabs.io";
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM";
const TTS_MODEL = process.env.ELEVENLABS_MODEL_ID ?? "eleven_multilingual_v2";
const STT_MODEL = process.env.ELEVENLABS_STT_MODEL ?? "scribe_v2";

describeLive("ElevenLabs live STT + TTS round trip", () => {
  it("synthesizes audio and transcribes it back", async () => {
    const tts = await synthesizeReply({
      text: "The meeting is at three o'clock.",
      baseUrl: BASE_URL,
      voiceId: VOICE_ID,
      modelId: TTS_MODEL,
    });
    expect(tts.ok).toBe(true);
    if (!tts.ok) return;
    expect(tts.frames.length).toBeGreaterThan(0);

    // Concatenate the base64 PCM frames back into one utterance for STT.
    const pcm = Buffer.concat(tts.frames.map((f) => Buffer.from(f, "base64")));
    expect(pcm.length).toBeGreaterThan(0);

    const stt = await transcribeUtterance({
      pcm,
      baseUrl: BASE_URL,
      model: STT_MODEL,
    });
    expect(stt.ok).toBe(true);
    if (!stt.ok) return;
    expect(stt.text.length).toBeGreaterThan(0);
    // Loose sanity: the transcript should mention the spoken time word.
    expect(stt.text.toLowerCase()).toMatch(/three|3|o'clock|meeting/);
  }, 60_000);
});
