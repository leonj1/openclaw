import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AudioCapture, frameBytesForMs, startCapture } from "./capture.ts";

const FRAME_MS = 20;
const FRAME_BYTES = frameBytesForMs(FRAME_MS);

// A fake `arecord`: records its argv, then either emits a fixed number of PCM
// bytes and exits (ARECORD_EMIT_BYTES) or streams continuously while honoring
// stdout backpressure, writing a marker and exiting 0 on SIGTERM. Written as a
// Node script (shebang) so it is deterministic and self-contained.
const FAKE_ARECORD = `#!/usr/bin/env node
import fs from "node:fs";

const argsFile = process.env.ARECORD_ARGS_FILE;
if (argsFile) {
  fs.writeFileSync(argsFile, process.argv.slice(2).join("\\n"));
}

const emitBytes = process.env.ARECORD_EMIT_BYTES;
if (emitBytes) {
  process.stdout.write(Buffer.alloc(Number(emitBytes)), () => process.exit(0));
} else {
  let stopped = false;
  process.on("SIGTERM", () => {
    stopped = true;
    const termFile = process.env.ARECORD_TERM_FILE;
    if (termFile) fs.writeFileSync(termFile, "term");
    process.exit(0);
  });
  const chunk = Buffer.alloc(Number(process.env.ARECORD_CHUNK_BYTES || 4096));
  const pump = () => {
    if (stopped) return;
    // Respect backpressure: back off until the reader drains.
    if (process.stdout.write(chunk)) setImmediate(pump);
    else process.stdout.once("drain", pump);
  };
  pump();
}
`;

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const tmpDirs: string[] = [];
const live: AudioCapture[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-room-capture-"));
  tmpDirs.push(dir);
  return dir;
}

function writeFakeArecord(): string {
  const dir = tmpDir();
  const scriptPath = path.join(dir, "fake-arecord.mjs");
  fs.writeFileSync(scriptPath, FAKE_ARECORD, { mode: 0o755 });
  return scriptPath;
}

function track(capture: AudioCapture): AudioCapture {
  live.push(capture);
  return capture;
}

afterEach(async () => {
  for (const capture of live.splice(0)) {
    await capture.stop();
  }
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe("AudioCapture spawn flags", () => {
  it("invokes arecord with raw PCM16 24kHz mono flags and the device", async () => {
    const binaryPath = writeFakeArecord();
    const argsFile = path.join(path.dirname(binaryPath), "args.txt");
    const capture = track(
      startCapture({
        binaryPath,
        device: "plughw:CARD=Anker,DEV=0",
        frameMs: FRAME_MS,
        handleProcessSignals: false,
        env: { ARECORD_ARGS_FILE: argsFile, ARECORD_EMIT_BYTES: String(FRAME_BYTES) },
      }),
    );

    // Drain to completion so the child has definitely written its argv file.
    let frameCount = 0;
    for await (const frame of capture) {
      frameCount += frame.length;
    }
    expect(frameCount).toBe(FRAME_BYTES);

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

describe("AudioCapture frame chunking", () => {
  it("emits only whole fixed-size frames and drops a trailing partial", async () => {
    const binaryPath = writeFakeArecord();
    // Three whole frames plus a partial that must not be emitted.
    const totalBytes = FRAME_BYTES * 3 + 5;
    const capture = track(
      startCapture({
        binaryPath,
        device: "default",
        frameMs: FRAME_MS,
        handleProcessSignals: false,
        env: { ARECORD_EMIT_BYTES: String(totalBytes) },
      }),
    );

    const frames: Buffer[] = [];
    for await (const frame of capture) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(3);
    for (const frame of frames) {
      expect(frame.length).toBe(FRAME_BYTES);
    }
  });
});

describe("AudioCapture backpressure", () => {
  it("pauses the recorder while the consumer is not pulling frames", async () => {
    const binaryPath = writeFakeArecord();
    const capture = track(
      startCapture({
        binaryPath,
        device: "default",
        frameMs: FRAME_MS,
        highWaterMarkFrames: 4,
        handleProcessSignals: false,
        env: { ARECORD_CHUNK_BYTES: String(FRAME_BYTES) },
      }),
    );

    // No consumption: the queue fills to the high-water mark and stdout pauses.
    await delay(50);
    expect(capture.isPaused()).toBe(true);
    const settled = capture.queuedFrames();
    await delay(50);
    // Paused means no further frames buffer up.
    expect(capture.queuedFrames()).toBe(settled);

    // Resuming consumption drains the backlog and — reading past the buffered
    // `settled` frames proves the recorder was resumed and produced more.
    for (let i = 0; i < settled + 10; i++) {
      const result = await capture.next();
      expect(result.done).toBe(false);
      expect((result.value as Buffer).length).toBe(FRAME_BYTES);
    }
  });
});

describe("AudioCapture SIGTERM shutdown", () => {
  it("terminates the child with SIGTERM and resolves once it exits cleanly", async () => {
    const binaryPath = writeFakeArecord();
    const termFile = path.join(path.dirname(binaryPath), "term.txt");
    const capture = startCapture({
      binaryPath,
      device: "default",
      frameMs: FRAME_MS,
      highWaterMarkFrames: 4,
      handleProcessSignals: false,
      env: { ARECORD_CHUNK_BYTES: String(FRAME_BYTES), ARECORD_TERM_FILE: termFile },
    });

    // Pull a couple of frames so the child is actively streaming, then stop.
    await capture.next();
    await capture.next();
    await capture.stop();

    // The stub only writes this marker from its SIGTERM handler.
    expect(fs.readFileSync(termFile, "utf8")).toBe("term");
    const afterStop = await capture.next();
    expect(afterStop.done).toBe(true);
  });

  it("registers and cleans up a parent SIGTERM handler when enabled", async () => {
    const binaryPath = writeFakeArecord();
    const before = process.listenerCount("SIGTERM");
    const capture = startCapture({
      binaryPath,
      device: "default",
      frameMs: FRAME_MS,
      handleProcessSignals: true,
      env: { ARECORD_CHUNK_BYTES: String(FRAME_BYTES) },
    });

    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    await capture.stop();
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});
