import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { framePcmToBase64, writeWavFile } from "./wav.ts";
import { WaitLoop, createWaitLoop, loadWaitLoopFrames } from "./wait-loop.ts";

// A sink that records enqueued frames. `held` is the simulated queue depth the
// loop throttles against; tests set it to control refill vs backpressure.
class StubSink {
  readonly enqueued: string[] = [];
  held = 0;
  enqueue(frameBase64: string): void {
    this.enqueued.push(frameBase64);
  }
  pendingFrames(): number {
    return this.held;
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Tiny in-test PCM16 24kHz mono WAV so the loop test never touches the real
// downloaded asset (hermetic, per AGENTS.md).
function writeTinyWav(frames: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wait-loop-"));
  tmpDirs.push(dir);
  const bytesPerFrame = (24_000 * 2 * 20) / 1000; // 20ms frame
  const pcm = Buffer.alloc(bytesPerFrame * frames);
  for (let i = 0; i < pcm.length; i += 2) {
    pcm.writeInt16LE((i % 5000) - 2500, i);
  }
  const file = path.join(dir, "loop.wav");
  writeWavFile(file, { sampleRate: 24_000, channels: 1, bitsPerSample: 16, pcm });
  return file;
}

describe("framePcmToBase64", () => {
  it("splits into whole frames and drops a partial tail", () => {
    const frameBytes = (24_000 * 2 * 20) / 1000;
    const pcm = Buffer.alloc(frameBytes * 2 + 7); // two frames + partial
    expect(framePcmToBase64(pcm, frameBytes).length).toBe(2);
  });
});

describe("loadWaitLoopFrames", () => {
  it("loads a valid PCM16 24kHz mono WAV", () => {
    const frames = loadWaitLoopFrames(writeTinyWav(3));
    expect(frames.length).toBe(3);
  });

  it("rejects a WAV that is not 24kHz mono PCM16", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wait-loop-bad-"));
    tmpDirs.push(dir);
    const file = path.join(dir, "bad.wav");
    writeWavFile(file, { sampleRate: 16_000, channels: 1, bitsPerSample: 16, pcm: Buffer.alloc(64) });
    expect(() => loadWaitLoopFrames(file)).toThrow(/24kHz mono/);
  });
});

describe("WaitLoop", () => {
  it("keeps enqueuing past one clip length (it loops)", async () => {
    const sink = new StubSink(); // held stays 0 -> loop refills every poll
    const frames = ["AAAA", "BBBB", "CCCC"];
    const loop = new WaitLoop({ frames, sink, highWaterFrames: 2, pollMs: 2 });
    loop.start();
    await delay(30);
    await loop.stop();
    // Wrapped past the 3-frame clip and reused earlier frames.
    expect(sink.enqueued.length).toBeGreaterThan(frames.length);
    expect(sink.enqueued).toContain("AAAA");
    expect(sink.enqueued).toContain("CCCC");
  });

  it("stops enqueuing promptly after stop()", async () => {
    const sink = new StubSink();
    const loop = new WaitLoop({ frames: ["X", "Y"], sink, highWaterFrames: 2, pollMs: 2 });
    loop.start();
    await delay(10);
    await loop.stop();
    const after = sink.enqueued.length;
    await delay(20);
    expect(sink.enqueued.length).toBe(after);
  });

  it("honors backpressure: no enqueue while the sink queue is full", async () => {
    const sink = new StubSink();
    sink.held = 10; // above high-water for the whole test
    const loop = new WaitLoop({ frames: ["X"], sink, highWaterFrames: 2, pollMs: 2 });
    loop.start();
    await delay(20);
    await loop.stop();
    expect(sink.enqueued.length).toBe(0);
  });

  it("createWaitLoop loads from a WAV path", async () => {
    const sink = new StubSink();
    const loop = createWaitLoop({ path: writeTinyWav(2), sink, highWaterFrames: 3, pollMs: 2 });
    loop.start();
    await delay(15);
    await loop.stop();
    expect(sink.enqueued.length).toBeGreaterThan(0);
  });
});
