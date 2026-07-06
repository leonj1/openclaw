// On-device speech-to-text for the Layer 2 turn (ElevenLabs).
//
// The gateway's realtime relay is audio<->audio and its browser transcription
// relay is g711/8kHz, so neither is a clean "PCM in -> text out" seam for this
// node (verified in src/gateway). We transcribe on-device by POSTing the
// captured utterance to the ElevenLabs REST speech-to-text endpoint
// (`/v1/speech-to-text`, multipart `file` + `model_id`; see
// extensions/elevenlabs/media-understanding-provider.ts for the same contract).
//
// The API key comes ONLY from `ELEVENLABS_API_KEY` (never config, never
// committed). The utterance is PCM16 24kHz mono; we wrap it in a WAV container
// so the upload carries its format. The HTTP client is injectable for tests.
import { encodeWav } from "../audio/wav.js";

// Minimal shape of the fields we read off a fetch Response. `fetch`'s Response
// satisfies it; tests pass a stub.
export interface HttpResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: FormData },
) => Promise<HttpResponseLike>;

export interface TranscribeParams {
  // Raw PCM16 24kHz mono utterance audio (from the endpointer).
  pcm: Buffer;
  baseUrl: string;
  model: string;
  // Auth token env holder; key must be present here (never in config).
  env?: NodeJS.ProcessEnv;
  fetchFn?: FetchLike;
}

export type TranscribeResult = { ok: true; text: string } | { ok: false; error: string };

const SAMPLE_RATE = 24_000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

export async function transcribeUtterance(params: TranscribeParams): Promise<TranscribeResult> {
  const env = params.env ?? process.env;
  const apiKey = env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, error: "ELEVENLABS_API_KEY is not set (STT key is env-only)" };
  }
  if (params.pcm.length === 0) {
    return { ok: false, error: "empty utterance: nothing to transcribe" };
  }

  const wav = encodeWav({
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    bitsPerSample: BITS_PER_SAMPLE,
    pcm: params.pcm,
  });
  const form = new FormData();
  form.append("model_id", params.model);
  // Uint8Array copy so the Blob does not retain the Node Buffer's pooled memory.
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "utterance.wav");

  const fetchFn = params.fetchFn ?? (globalThis.fetch as unknown as FetchLike);
  const url = `${params.baseUrl.replace(/\/+$/, "")}/v1/speech-to-text`;

  let response: HttpResponseLike;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: form,
    });
  } catch (err) {
    return { ok: false, error: `ElevenLabs STT request failed: ${errorText(err)}` };
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return {
      ok: false,
      error: `ElevenLabs STT failed (${response.status}): ${detail.slice(0, 200)}`,
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    return { ok: false, error: `ElevenLabs STT returned invalid JSON: ${errorText(err)}` };
  }
  const text =
    payload && typeof payload === "object" && typeof (payload as { text?: unknown }).text === "string"
      ? (payload as { text: string }).text.trim()
      : "";
  if (!text) {
    return { ok: false, error: "ElevenLabs STT response missing text" };
  }
  return { ok: true, text };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
