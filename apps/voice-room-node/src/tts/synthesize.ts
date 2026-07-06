// On-device text-to-speech for the Layer 2 turn (ElevenLabs).
//
// Speaks the (succinct) agent reply back through playback. POSTs the reply text
// to the ElevenLabs REST TTS endpoint requesting raw PCM16 24kHz mono
// (`output_format=pcm_24000`) — the node-wide format — then splits the audio
// into base64 frames for `playback.enqueue` (same contract as
// scripts/synth-fixtures.ts and extensions/elevenlabs/tts.ts).
//
// The API key comes ONLY from `ELEVENLABS_API_KEY`. Voice/model ids come from
// config (with defaults). The HTTP client is injectable for tests.
import { framePcmToBase64 } from "../audio/wav.js";

// `pcm_24000` returns headerless PCM16 24kHz mono — exactly the playback format.
const OUTPUT_FORMAT = "pcm_24000";
const SAMPLE_RATE = 24_000;
const BYTES_PER_SAMPLE = 2;
const FRAME_MS = 20;
const FRAME_BYTES = (SAMPLE_RATE * BYTES_PER_SAMPLE * FRAME_MS) / 1000;

// Minimal shape we read off a fetch Response for the raw-audio body.
export interface TtsResponseLike {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export type TtsFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<TtsResponseLike>;

export interface SynthesizeParams {
  text: string;
  baseUrl: string;
  voiceId: string;
  modelId: string;
  env?: NodeJS.ProcessEnv;
  fetchFn?: TtsFetchLike;
}

export type SynthesizeResult =
  | { ok: true; frames: string[] }
  | { ok: false; error: string };

export async function synthesizeReply(params: SynthesizeParams): Promise<SynthesizeResult> {
  const env = params.env ?? process.env;
  const apiKey = env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, error: "ELEVENLABS_API_KEY is not set (TTS key is env-only)" };
  }
  const text = params.text.trim();
  if (!text) {
    return { ok: false, error: "empty reply: nothing to synthesize" };
  }

  const url = new URL(
    `${params.baseUrl.replace(/\/+$/, "")}/v1/text-to-speech/${params.voiceId}`,
  );
  url.searchParams.set("output_format", OUTPUT_FORMAT);

  const fetchFn = params.fetchFn ?? (globalThis.fetch as unknown as TtsFetchLike);
  let response: TtsResponseLike;
  try {
    response = await fetchFn(url.toString(), {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: params.modelId }),
    });
  } catch (err) {
    return { ok: false, error: `ElevenLabs TTS request failed: ${errorText(err)}` };
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return {
      ok: false,
      error: `ElevenLabs TTS failed (${response.status}): ${detail.slice(0, 200)}`,
    };
  }

  const pcm = Buffer.from(await response.arrayBuffer());
  if (pcm.length === 0) {
    return { ok: false, error: "ElevenLabs TTS returned no audio" };
  }
  const frames = framePcmToBase64(pcm, FRAME_BYTES);
  // A reply shorter than one 20ms frame still gets spoken as a single frame so
  // very short answers are not silently dropped.
  if (frames.length === 0) {
    return { ok: true, frames: [pcm.toString("base64")] };
  }
  return { ok: true, frames };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
