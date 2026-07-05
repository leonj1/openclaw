import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AudioPlayback, startPlayback } from "./playback.ts";

// A fake `aplay`: records its argv, then consumes stdin. With APLAY_OUT_FILE it
// appends every received byte (so tests can assert ordered draining); with
// APLAY_CHUNK_DELAY_MS it throttles reads to build backpressure so a mid-stream
// stop() leaves frames unplayed; on SIGTERM it drops an APLAY_TERM_FILE marker
// and exits 0. Written as a Node script (shebang) so it is deterministic.
const FAKE_APLAY = `#!/usr/bin/env node
import fs from "node:fs";

const argsFile = process.env.APLAY_ARGS_FILE;
if (argsFile) {
  fs.writeFileSync(argsFile, process.argv.slice(2).join("\\n"));
}

process.on("SIGTERM", () => {
  const termFile = process.env.APLAY_TERM_FILE;
  if (termFile) fs.writeFileSync(termFile, "term");
  process.exit(0);
});

const outFile = process.env.APLAY_OUT_FILE;
const delayMs = Number(process.env.APLAY_CHUNK_DELAY_MS || 0);
process.stdin.on("data", (chunk) => {
  if (outFile) fs.appendFileSync(outFile, chunk);
  // Throttle so the parent's writes back up and stop() can halt mid-stream.
  if (delayMs > 0) {
    process.stdin.pause();
    setTimeout(() => process.stdin.resume(), delayMs);
  }
});
process.stdin.on("end", () => process.exit(0));
`;

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await delay(10);
  }
}

function fileSize(file: string): number {
  return fs.existsSync(file) ? fs.statSync(file).size : 0;
}

const tmpDirs: string[] = [];
const live: AudioPlayback[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-room-playback-"));
  tmpDirs.push(dir);
  return dir;
}

function writeFakeAplay(): string {
  const dir = tmpDir();
  const scriptPath = path.join(dir, "fake-aplay.mjs");
  fs.writeFileSync(scriptPath, FAKE_APLAY, { mode: 0o755 });
  return scriptPath;
}

function track(playback: AudioPlayback): AudioPlayback {
  live.push(playback);
  return playback;
}

afterEach(async () => {
  for (const playback of live.splice(0)) {
    await playback.stop();
  }
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe("AudioPlayback spawn flags", () => {
  it("invokes aplay with raw PCM16 24kHz mono flags and the device", async () => {
    const binaryPath = writeFakeAplay();
    const argsFile = path.join(path.dirname(binaryPath), "args.txt");
    track(
      startPlayback({
        binaryPath,
        device: "plughw:CARD=Anker,DEV=0",
        handleProcessSignals: false,
        env: { APLAY_ARGS_FILE: argsFile },
      }),
    );

    await waitFor(() => fs.existsSync(argsFile));
    const args = fs.readFileSync(argsFile, "utf8").split("\n");
    expect(args).toEqual([
      "-t", "raw",
      "-f", "S16_LE",
      "-r", "24000",
      "-c", "1",
      "-D", "plughw:CARD=Anker,DEV=0",
    ]);
    // Format assertions the acceptance criterion names explicitly.
    expect(args).toContain("S16_LE");
    expect(args).toContain("24000");
    expect(args[args.indexOf("-c") + 1]).toBe("1");
  });
});

describe("AudioPlayback frame draining", () => {
  it("writes decoded base64 frames to aplay in enqueue order", async () => {
    const binaryPath = writeFakeAplay();
    const outFile = path.join(path.dirname(binaryPath), "out.raw");
    const playback = track(
      startPlayback({
        binaryPath,
        device: "default",
        handleProcessSignals: false,
        env: { APLAY_OUT_FILE: outFile },
      }),
    );

    // Distinct per-frame fills make out-of-order or dropped frames obvious.
    const frames = [
      Buffer.alloc(512, 0x11),
      Buffer.alloc(512, 0x22),
      Buffer.alloc(512, 0x33),
      Buffer.alloc(512, 0x44),
    ];
    const expected = Buffer.concat(frames);
    for (const frame of frames) {
      playback.enqueue(frame.toString("base64"));
    }

    await playback.drained();
    await waitFor(() => fileSize(outFile) >= expected.length);

    const written = fs.readFileSync(outFile);
    expect(written.length).toBe(expected.length);
    expect(written.equals(expected)).toBe(true);
  });
});

describe("AudioPlayback barge-in stop", () => {
  it("drops queued frames and halts output mid-stream on stop()", async () => {
    const binaryPath = writeFakeAplay();
    const outFile = path.join(path.dirname(binaryPath), "out.raw");
    const termFile = path.join(path.dirname(binaryPath), "term.txt");
    const playback = track(
      startPlayback({
        binaryPath,
        device: "default",
        handleProcessSignals: false,
        // Throttle playback so most frames are still queued when we stop.
        env: { APLAY_OUT_FILE: outFile, APLAY_TERM_FILE: termFile, APLAY_CHUNK_DELAY_MS: "40" },
      }),
    );

    const frameCount = 40;
    const frameBytes = 16_384;
    const total = frameCount * frameBytes;
    for (let i = 0; i < frameCount; i++) {
      playback.enqueue(Buffer.alloc(frameBytes, i % 256).toString("base64"));
    }

    // The slow consumer leaves frames backed up in our queue.
    await waitFor(() => playback.pendingFrames() > 0);
    // Let a little audio actually play so we prove the stop is mid-stream.
    await waitFor(() => fileSize(outFile) > 0);

    await playback.stop();

    const delivered = fileSize(outFile);
    expect(delivered).toBeGreaterThan(0);
    expect(delivered).toBeLessThan(total);
    // Barge-in flushed the backlog; nothing more can be written.
    expect(playback.pendingFrames()).toBe(0);
    // The stub only writes this marker from its SIGTERM handler → clean SIGTERM.
    expect(fs.readFileSync(termFile, "utf8")).toBe("term");

    // Post-stop enqueues are ignored and the delivered byte count stays put.
    playback.enqueue(Buffer.alloc(frameBytes, 0xff).toString("base64"));
    await delay(20);
    expect(fileSize(outFile)).toBe(delivered);
  });
});

describe("AudioPlayback SIGTERM handler", () => {
  it("registers and cleans up a parent SIGTERM handler when enabled", async () => {
    const binaryPath = writeFakeAplay();
    const before = process.listenerCount("SIGTERM");
    const playback = startPlayback({
      binaryPath,
      device: "default",
      handleProcessSignals: true,
    });

    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    await playback.stop();
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});
