import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { readWavFile } from "../audio/wav.ts";
import { WakeFeatures, pcm16ToInt16, resample24kTo16k } from "./features.ts";
import {
  EMBED_DIM,
  MODEL_SAMPLE_RATE,
  WAKE_FEATURE_FRAMES,
  loadWakeSessions,
  type WakeSessions,
} from "./onnx-sessions.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "..", "..", "test", "fixtures");
const modelsDir = path.resolve(here, "..", "..", "models");
const haveModels = ["melspectrogram.onnx", "embedding_model.onnx"].every((f) =>
  fs.existsSync(path.join(modelsDir, f)),
);

describe("resample24kTo16k", () => {
  it("maps 24kHz sample counts to the 16kHz domain (2/3 length)", () => {
    const input = new Int16Array(24_000).fill(1000);
    const out = resample24kTo16k(input);
    expect(out.length).toBe(MODEL_SAMPLE_RATE);
    // A constant signal stays constant through linear interpolation.
    expect(out[100]).toBe(1000);
  });

  it("handles empty input", () => {
    expect(resample24kTo16k(new Int16Array(0)).length).toBe(0);
  });
});

describe("pcm16ToInt16", () => {
  it("decodes little-endian PCM16 sample values", () => {
    const buf = Buffer.alloc(4);
    buf.writeInt16LE(-1234, 0);
    buf.writeInt16LE(5678, 2);
    const samples = pcm16ToInt16(buf);
    expect(Array.from(samples)).toEqual([-1234, 5678]);
  });
});

const describeModels = haveModels ? describe : describe.skip;

describeModels("WakeFeatures embedding pipeline", () => {
  let sessions: WakeSessions;
  beforeAll(async () => {
    sessions = await loadWakeSessions(modelsDir);
  });

  it("yields a full [16 x 96] classifier window from a fixture PCM stream", async () => {
    const wav = readWavFile(path.join(fixturesDir, "hey_jarvis.wav"));
    expect(wav.ok).toBe(true);
    if (!wav.ok) {
      return;
    }
    const features = await WakeFeatures.create(sessions);
    // Priming fills the buffer, so a window is available immediately.
    const primed = features.latestWindow();
    expect(primed).not.toBeNull();
    expect(primed?.length).toBe(WAKE_FEATURE_FRAMES * EMBED_DIM);

    // Streaming real audio appends new embedding frames.
    const before = features.frames;
    const frameBytes = 480 * 2; // 20ms @ 24kHz
    let appendedTotal = 0;
    for (let off = 0; off + frameBytes <= wav.wav.pcm.length; off += frameBytes) {
      appendedTotal += await features.pushPcm24k(wav.wav.pcm.subarray(off, off + frameBytes));
    }
    expect(appendedTotal).toBeGreaterThan(0);
    expect(features.frames).toBeGreaterThan(before);

    const window = features.latestWindow();
    expect(window?.length).toBe(WAKE_FEATURE_FRAMES * EMBED_DIM);
  });
});
