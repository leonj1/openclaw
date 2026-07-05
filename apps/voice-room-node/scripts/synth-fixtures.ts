// Synthesizes the wake / non-wake fixtures via ElevenLabs when no mic recording
// is available. Requests raw PCM16 @ 24kHz mono (`output_format=pcm_24000`),
// which is exactly the node-wide fixture format, then wraps it in a WAV.
//
// Live helper: does nothing (exits 0) unless OPENCLAW_LIVE_TEST is truthy AND
// ELEVENLABS_API_KEY is set, so it is safe to invoke unconditionally in CI.
// Run: OPENCLAW_LIVE_TEST=1 ELEVENLABS_API_KEY=... node scripts/synth-fixtures.ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { writeWavFile } from "../src/audio/wav.ts";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

const EnvSchema = z.object({
  OPENCLAW_LIVE_TEST: z.string().optional(),
  ELEVENLABS_API_KEY: z.string().optional(),
  // Rachel by default; override for a different voice.
  ELEVENLABS_VOICE_ID: z.string().default("21m00Tcm4TlvDq8ikWAM"),
  ELEVENLABS_MODEL_ID: z.string().default("eleven_multilingual_v2"),
  ELEVENLABS_BASE_URL: z.string().default("https://api.elevenlabs.io"),
});

// PCM16 / 24kHz / mono — the node-wide format. `pcm_24000` returns exactly this.
const OUTPUT_FORMAT = "pcm_24000";
const SAMPLE_RATE = 24_000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

const CLIPS: ReadonlyArray<{ file: string; text: string }> = [
  { file: "hey_jarvis.wav", text: "Hey Jarvis" },
  { file: "hey_there.wav", text: "Hey there" },
];

async function synthesize(
  env: z.infer<typeof EnvSchema>,
  apiKey: string,
  text: string,
): Promise<Buffer> {
  const url = new URL(`${env.ELEVENLABS_BASE_URL}/v1/text-to-speech/${env.ELEVENLABS_VOICE_ID}`);
  url.searchParams.set("output_format", OUTPUT_FORMAT);
  const response = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: env.ELEVENLABS_MODEL_ID }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed (${response.status}): ${detail.slice(0, 200)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function main(): Promise<void> {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error(`synth-fixtures: bad env: ${z.prettifyError(parsed.error)}`);
    process.exitCode = 1;
    return;
  }
  const env = parsed.data;
  const live = TRUTHY.has((env.OPENCLAW_LIVE_TEST ?? "").trim().toLowerCase());
  const apiKey = env.ELEVENLABS_API_KEY?.trim();
  if (!live || !apiKey) {
    console.log(
      "synth-fixtures: skipped (needs OPENCLAW_LIVE_TEST=1 and ELEVENLABS_API_KEY). Nothing written.",
    );
    return;
  }

  const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");
  for (const clip of CLIPS) {
    const pcm = await synthesize(env, apiKey, clip.text);
    const dest = path.join(fixturesDir, clip.file);
    writeWavFile(dest, { sampleRate: SAMPLE_RATE, channels: CHANNELS, bitsPerSample: BITS_PER_SAMPLE, pcm });
    console.log(`synth-fixtures: wrote ${dest} (${pcm.length} pcm bytes)`);
  }
}

await main();
