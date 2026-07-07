import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeWavFile } from "./wav.ts";
import { FillerLoop, RandomWaitPlayer, createWaitPlayer, type WaitPlayer } from "./wait-player.ts";

// Records enqueued frames; `held` is the simulated queue depth the loop throttles
// against and drain waits on.
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

function writeTinyWav(name: string, frames: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wait-player-"));
  tmpDirs.push(dir);
  const bytesPerFrame = (24_000 * 2 * 20) / 1000;
  const pcm = Buffer.alloc(bytesPerFrame * frames);
  const file = path.join(dir, name);
  writeWavFile(file, { sampleRate: 24_000, channels: 1, bitsPerSample: 16, pcm });
  return file;
}

describe("FillerLoop", () => {
  it("plays each clip in sequence and cycles with gaps", async () => {
    const sink = new StubSink(); // held stays 0 -> clips drain instantly
    const loop = new FillerLoop({
      clips: [["a1", "a2"], ["b1"], ["c1"]],
      sink,
      gapMsRange: [4, 6],
      pollMs: 2,
      random: () => 0.5,
    });
    loop.start();
    await delay(80);
    await loop.stop();
    // First clip's frames come out in order before the second clip begins.
    expect(sink.enqueued.slice(0, 3)).toEqual(["a1", "a2", "b1"]);
    // Cycled past all three clips back to the first.
    expect(sink.enqueued.length).toBeGreaterThan(4);
    expect(sink.enqueued).toContain("c1");
  });

  it("honors backpressure: no enqueue while the sink queue is full", async () => {
    const sink = new StubSink();
    sink.held = 100; // above high-water for the whole test
    const loop = new FillerLoop({ clips: [["x"]], sink, gapMsRange: [4, 6], pollMs: 2 });
    loop.start();
    await delay(20);
    await loop.stop();
    expect(sink.enqueued.length).toBe(0);
  });

  it("stops enqueuing promptly after stop()", async () => {
    const sink = new StubSink();
    const loop = new FillerLoop({ clips: [["x", "y"]], sink, gapMsRange: [4, 6], pollMs: 2 });
    loop.start();
    await delay(10);
    await loop.stop();
    const after = sink.enqueued.length;
    await delay(20);
    expect(sink.enqueued.length).toBe(after);
  });

  it("rejects an empty clip set", () => {
    expect(() => new FillerLoop({ clips: [], sink: new StubSink() })).toThrow(/no clips/);
  });
});

describe("RandomWaitPlayer", () => {
  function makeSpy(): WaitPlayer & { started: number } {
    return {
      started: 0,
      start() {
        this.started += 1;
      },
      async stop() {},
    };
  }

  it("picks fillers when the coin is below 0.5", async () => {
    const instrumental = makeSpy();
    const fillers = makeSpy();
    const player = new RandomWaitPlayer({
      instrumental: () => instrumental,
      fillers: () => fillers,
      random: () => 0.1,
    });
    player.start();
    await player.stop();
    expect(fillers.started).toBe(1);
    expect(instrumental.started).toBe(0);
  });

  it("picks the instrumental loop when the coin is at/above 0.5", async () => {
    const instrumental = makeSpy();
    const fillers = makeSpy();
    const player = new RandomWaitPlayer({
      instrumental: () => instrumental,
      fillers: () => fillers,
      random: () => 0.9,
    });
    player.start();
    await player.stop();
    expect(instrumental.started).toBe(1);
    expect(fillers.started).toBe(0);
  });

  it("always plays the instrumental loop when no fillers are available", async () => {
    const instrumental = makeSpy();
    const player = new RandomWaitPlayer({ instrumental: () => instrumental, random: () => 0.1 });
    player.start();
    await player.stop();
    expect(instrumental.started).toBe(1);
  });
});

describe("createWaitPlayer", () => {
  it("skips missing filler files and still loads the instrumental clip", async () => {
    const sink = new StubSink();
    const player = createWaitPlayer({
      instrumentalPath: writeTinyWav("wait-loop.wav", 2),
      fillerPaths: [path.join(os.tmpdir(), "does-not-exist.wav")],
      sink,
      random: () => 0.1, // would prefer fillers, but none exist -> instrumental
    });
    player.start();
    await delay(15);
    await player.stop();
    expect(sink.enqueued.length).toBeGreaterThan(0);
  });
});
