import { describe, expect, it } from "vitest";
import { type TtsFetchLike, type TtsResponseLike, synthesizeReply } from "./synthesize.ts";

// 2.5 frames of PCM16 24kHz (20ms frame = 960 bytes) so framing yields >1 frame
// and drops the partial tail.
const FRAME_BYTES = (24_000 * 2 * 20) / 1000;
const AUDIO = Buffer.alloc(FRAME_BYTES * 2 + 100);
for (let i = 0; i < AUDIO.length; i++) {
  AUDIO[i] = i % 256;
}

function audioResponse(bytes: Buffer): TtsResponseLike {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    text: async () => "",
  };
}

describe("synthesizeReply", () => {
  it("posts the reply text and returns ordered base64 PCM frames", async () => {
    let seenUrl = "";
    let seenBody: unknown;
    let seenKey = "";
    const fetchFn: TtsFetchLike = async (url, init) => {
      seenUrl = url;
      seenKey = init.headers["xi-api-key"];
      seenBody = JSON.parse(init.body);
      return audioResponse(AUDIO);
    };

    const result = await synthesizeReply({
      text: "  It is Sunday.  ",
      baseUrl: "https://api.elevenlabs.io",
      voiceId: "voice-1",
      modelId: "eleven_multilingual_v2",
      env: { ELEVENLABS_API_KEY: "secret" },
      fetchFn,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.frames.length).toBe(2); // 2 full frames, partial tail dropped
      // Frames are ordered: decoding + concatenating reproduces the leading audio.
      const decoded = Buffer.concat(result.frames.map((f) => Buffer.from(f, "base64")));
      expect(decoded.equals(AUDIO.subarray(0, FRAME_BYTES * 2))).toBe(true);
    }
    expect(seenUrl).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/voice-1?output_format=pcm_24000",
    );
    expect(seenKey).toBe("secret");
    expect(seenBody).toEqual({ text: "It is Sunday.", model_id: "eleven_multilingual_v2" });
  });

  it("errors when the API key is absent", async () => {
    const result = await synthesizeReply({
      text: "hello",
      baseUrl: "https://api.elevenlabs.io",
      voiceId: "v",
      modelId: "m",
      env: {},
      fetchFn: async () => audioResponse(AUDIO),
    });
    expect(result).toEqual({ ok: false, error: expect.stringContaining("ELEVENLABS_API_KEY") });
  });

  it("errors on a non-2xx response", async () => {
    const result = await synthesizeReply({
      text: "hello",
      baseUrl: "https://api.elevenlabs.io",
      voiceId: "v",
      modelId: "m",
      env: { ELEVENLABS_API_KEY: "k" },
      fetchFn: async () => ({
        ok: false,
        status: 422,
        arrayBuffer: async () => new ArrayBuffer(0),
        text: async () => "bad voice",
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("422");
    }
  });
});
