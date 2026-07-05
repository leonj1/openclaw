import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { readWavFile } from "../audio/wav.ts";
import { WakeFeatures } from "./features.ts";
import { OpenWakeWord, type WakeEvent } from "./openwakeword.ts";
import { loadWakeSessions, type WakeSessions } from "./onnx-sessions.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "..", "..", "test", "fixtures");
const modelsDir = path.resolve(here, "..", "..", "models");
const haveModels = ["melspectrogram.onnx", "embedding_model.onnx", "hey_jarvis_v0.1.onnx"].every(
  (f) => fs.existsSync(path.join(modelsDir, f)),
);

const FRAME_BYTES = 480 * 2; // 20ms @ 24kHz PCM16 mono
const THRESHOLD = 0.5;

function fixturePcm(name: string): Buffer {
  const wav = readWavFile(path.join(fixturesDir, name));
  if (!wav.ok) {
    throw new Error(`fixture ${name}: ${wav.error}`);
  }
  return wav.wav.pcm;
}

const describeModels = haveModels ? describe : describe.skip;

describeModels("OpenWakeWord detection", () => {
  let sessions: WakeSessions;
  beforeAll(async () => {
    sessions = await loadWakeSessions(modelsDir);
  });

  async function detect(pcm: Buffer): Promise<WakeEvent[]> {
    const features = await WakeFeatures.create(sessions);
    // Fixed clock: WakeEvent.ts is not under test, debounce runs on audio time.
    const detector = new OpenWakeWord({ sessions, features, threshold: THRESHOLD, now: () => 1 });
    const events: WakeEvent[] = [];
    for (let off = 0; off + FRAME_BYTES <= pcm.length; off += FRAME_BYTES) {
      const event = await detector.process(pcm.subarray(off, off + FRAME_BYTES));
      if (event) {
        events.push(event);
      }
    }
    return events;
  }

  it("fires exactly one wake for the hey_jarvis fixture", async () => {
    const events = await detect(fixturePcm("hey_jarvis.wav"));
    expect(events).toHaveLength(1);
    expect(events[0].score).toBeGreaterThanOrEqual(THRESHOLD);
  });

  it("does not fire on silence", async () => {
    const events = await detect(fixturePcm("silence.wav"));
    expect(events).toHaveLength(0);
  });

  it("does not fire on the near-miss hey_there fixture", async () => {
    const events = await detect(fixturePcm("hey_there.wav"));
    expect(events).toHaveLength(0);
  });

  it("debounces two utterances 200ms apart into a single wake", async () => {
    const clip = fixturePcm("hey_jarvis.wav");
    // 200ms of silence between the two utterances.
    const gap = Buffer.alloc(Math.round(24_000 * 0.2) * 2);
    const events = await detect(Buffer.concat([clip, gap, clip]));
    expect(events).toHaveLength(1);
  });
});
