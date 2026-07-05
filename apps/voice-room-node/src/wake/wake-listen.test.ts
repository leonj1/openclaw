import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readWavFile } from "../audio/wav.ts";
import { makeWakeCuePcm, runWakeListen, type WakeListenConfig } from "./wake-listen.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "..", "..", "test", "fixtures");
const modelsDir = path.resolve(here, "..", "..", "models");
const haveModels = ["melspectrogram.onnx", "embedding_model.onnx", "hey_jarvis_v0.1.onnx"].every(
  (f) => fs.existsSync(path.join(modelsDir, f)),
);

const FRAME_BYTES = 480 * 2; // 20ms @ 24kHz, matching capture's default frame

function fixturePcm(name: string): Buffer {
  const wav = readWavFile(path.join(fixturesDir, name));
  if (!wav.ok) {
    throw new Error(`fixture ${name}: ${wav.error}`);
  }
  return wav.wav.pcm;
}

// Stub capture: replays a fixed PCM buffer as 20ms frames, then ends the
// iterator (EOF) like a finite recording. `stop()` short-circuits the stream.
class StubCapture {
  private stopped = false;
  constructor(private readonly pcm: Buffer) {}
  async *frames(): AsyncIterableIterator<Buffer> {
    for (let off = 0; off + FRAME_BYTES <= this.pcm.length; off += FRAME_BYTES) {
      if (this.stopped) {
        return;
      }
      yield this.pcm.subarray(off, off + FRAME_BYTES);
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
}

// Stub playback: records enqueued cue frames instead of spawning aplay.
class StubPlayback {
  readonly enqueued: string[] = [];
  enqueue(frameBase64: string): void {
    this.enqueued.push(frameBase64);
  }
  async stop(): Promise<void> {}
}

const config: WakeListenConfig = {
  captureDevice: "stub",
  playbackDevice: "stub",
  threshold: 0.5,
};

async function listen(pcm: Buffer): Promise<{ lines: string[]; cues: string[] }> {
  const capture = new StubCapture(pcm);
  const playback = new StubPlayback();
  const lines: string[] = [];
  const handle = await runWakeListen({
    config,
    startCapture: () => capture,
    startPlayback: () => playback,
    log: (line) => lines.push(line),
  });
  await handle.done;
  await handle.stop();
  return { lines, cues: playback.enqueued };
}

describe("makeWakeCuePcm", () => {
  it("produces a non-empty PCM16 tone of whole samples", () => {
    const cue = makeWakeCuePcm();
    expect(cue.length).toBeGreaterThan(0);
    expect(cue.length % 2).toBe(0);
  });
});

const describeModels = haveModels ? describe : describe.skip;

describeModels("runWakeListen wake reactions", () => {
  it("prints one wake line and plays a cue for hey_jarvis", async () => {
    const { lines, cues } = await listen(fixturePcm("hey_jarvis.wav"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^WAKE score=\d\.\d{3} ts=\d+$/);
    expect(cues).toHaveLength(1);
  });

  it("stays quiet on silence", async () => {
    const { lines, cues } = await listen(fixturePcm("silence.wav"));
    expect(lines).toHaveLength(0);
    expect(cues).toHaveLength(0);
  });

  it("stays quiet on the near-miss hey_there", async () => {
    const { lines, cues } = await listen(fixturePcm("hey_there.wav"));
    expect(lines).toHaveLength(0);
    expect(cues).toHaveLength(0);
  });
});
