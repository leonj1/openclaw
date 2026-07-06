import { describe, expect, it } from "vitest";
import { parseWav } from "../audio/wav.ts";
import { type FetchLike, type HttpResponseLike, transcribeUtterance } from "./transcribe.ts";

const PCM = Buffer.from(new Int16Array([100, -100, 200, -200, 300, -300]).buffer);

function okResponse(body: unknown): HttpResponseLike {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("transcribeUtterance", () => {
  it("posts a WAV of the utterance and returns the transcript", async () => {
    let seenUrl = "";
    let seenKey = "";
    let seenModel: FormDataEntryValue | null = null;
    let fileBytes = 0;
    const fetchFn: FetchLike = async (url, init) => {
      seenUrl = url;
      seenKey = init.headers["xi-api-key"];
      seenModel = init.body.get("model_id");
      const file = init.body.get("file");
      if (file instanceof Blob) {
        const buf = Buffer.from(await file.arrayBuffer());
        fileBytes = buf.length;
        // Uploaded body is a valid PCM16 24kHz mono WAV wrapping the utterance.
        const parsed = parseWav(buf);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) {
          expect(parsed.wav.sampleRate).toBe(24_000);
          expect(parsed.wav.channels).toBe(1);
          expect(parsed.wav.pcm.equals(PCM)).toBe(true);
        }
      }
      return okResponse({ text: "what's the date" });
    };

    const result = await transcribeUtterance({
      pcm: PCM,
      baseUrl: "https://api.elevenlabs.io",
      model: "scribe_v2",
      env: { ELEVENLABS_API_KEY: "secret-key" },
      fetchFn,
    });

    expect(result).toEqual({ ok: true, text: "what's the date" });
    expect(seenUrl).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(seenKey).toBe("secret-key");
    expect(seenModel).toBe("scribe_v2");
    expect(fileBytes).toBeGreaterThan(PCM.length);
  });

  it("errors clearly when the API key is absent", async () => {
    const result = await transcribeUtterance({
      pcm: PCM,
      baseUrl: "https://api.elevenlabs.io",
      model: "scribe_v2",
      env: {},
      fetchFn: async () => okResponse({ text: "unreached" }),
    });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("ELEVENLABS_API_KEY") });
  });

  it("errors on a non-2xx response with the status", async () => {
    const result = await transcribeUtterance({
      pcm: PCM,
      baseUrl: "https://api.elevenlabs.io",
      model: "scribe_v2",
      env: { ELEVENLABS_API_KEY: "k" },
      fetchFn: async () => ({
        ok: false,
        status: 401,
        json: async () => ({}),
        text: async () => "unauthorized",
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("401");
    }
  });

  it("errors when the response has no text", async () => {
    const result = await transcribeUtterance({
      pcm: PCM,
      baseUrl: "https://api.elevenlabs.io",
      model: "scribe_v2",
      env: { ELEVENLABS_API_KEY: "k" },
      fetchFn: async () => okResponse({ text: "   " }),
    });
    expect(result.ok).toBe(false);
  });
});
