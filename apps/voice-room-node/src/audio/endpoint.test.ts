import { describe, expect, it } from "vitest";
import { endpointUtterance, frameRms } from "./endpoint.ts";

const FRAME_MS = 20;
const FRAME_SAMPLES = (24_000 * FRAME_MS) / 1000; // 480 samples per 20ms frame

// One PCM16 20ms frame. `amplitude` 0 => silence; higher => "speech" energy.
function frame(amplitude: number): Buffer {
  const buf = Buffer.alloc(FRAME_SAMPLES * 2);
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    // Alternate sign so RMS reflects amplitude regardless of DC offset.
    buf.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
  }
  return buf;
}

async function* fromFrames(frames: Buffer[]): AsyncIterable<Buffer> {
  for (const f of frames) {
    yield f;
  }
}

const SPEECH = frame(8000); // ~0.24 RMS, well above the gate
const SILENCE = frame(0);

describe("frameRms", () => {
  it("is ~0 for silence and positive for speech", () => {
    expect(frameRms(SILENCE)).toBe(0);
    expect(frameRms(SPEECH)).toBeGreaterThan(0.1);
  });
});

describe("endpointUtterance", () => {
  it("resolves at the trailing-silence boundary", async () => {
    // 10 speech frames (200ms) then enough silence to cross a 100ms gate.
    const frames = [...Array(10).fill(SPEECH), ...Array(8).fill(SILENCE)];
    const result = await endpointUtterance(fromFrames(frames), {
      silenceMs: 100,
      maxUtteranceMs: 10_000,
    });
    expect(result.reason).toBe("silence");
    // 10 speech + 5 silence frames (100ms of silence) = 15 frames buffered.
    expect(result.pcm.length).toBe(15 * FRAME_SAMPLES * 2);
    expect(result.durationMs).toBe(15 * FRAME_MS);
  });

  it("trims leading silence before the first voiced frame", async () => {
    const frames = [...Array(4).fill(SILENCE), ...Array(6).fill(SPEECH), ...Array(6).fill(SILENCE)];
    const result = await endpointUtterance(fromFrames(frames), {
      silenceMs: 100,
      maxUtteranceMs: 10_000,
    });
    // Leading 4 silence frames dropped; 6 speech + 5 trailing silence buffered.
    expect(result.pcm.length).toBe(11 * FRAME_SAMPLES * 2);
  });

  it("resolves at the maxUtteranceMs cap for a non-stop stream", async () => {
    // 100 speech frames = 2000ms, cap at 500ms -> resolves early via cap.
    const frames = Array(100).fill(SPEECH);
    const result = await endpointUtterance(fromFrames(frames), {
      silenceMs: 100,
      maxUtteranceMs: 500,
    });
    expect(result.reason).toBe("max");
    expect(result.durationMs).toBe(500);
    expect(result.pcm.length).toBe(25 * FRAME_SAMPLES * 2); // 500ms / 20ms = 25 frames
  });
});
