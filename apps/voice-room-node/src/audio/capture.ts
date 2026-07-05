// Microphone capture for the "Hey Jarvis" voice-room node.
//
// Spawns `arecord` in raw PCM16 mode (24kHz mono — the node-wide audio format,
// see AGENTS.md) and hands its byte stream out as fixed-size frames through an
// async iterator. Backpressure is pull-based: when the consumer stops pulling,
// we pause the child's stdout so `arecord`'s pipe fills and it stops producing,
// instead of buffering unbounded audio. `stop()` (or the parent process
// receiving SIGTERM) tears the child down with SIGTERM so no orphan `arecord`
// survives the node.
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

// Node-wide capture format. The whole pipeline (capture, playback, wake
// fixtures, TTS) is locked to PCM16 / 24kHz / mono.
export const CAPTURE_FORMAT = "S16_LE";
export const CAPTURE_SAMPLE_RATE = 24_000;
export const CAPTURE_CHANNELS = 1;
export const BYTES_PER_SAMPLE = 2;

const DEFAULT_FRAME_MS = 20;
const DEFAULT_HIGH_WATER_MARK_FRAMES = 16;

export interface AudioCaptureOptions {
  // ALSA capture device id passed to `arecord -D` (e.g. "plughw:CARD=Anker,DEV=0").
  device: string;
  // Recorder binary; overridable so tests can inject a fake `arecord`.
  binaryPath?: string;
  // Frame size in milliseconds of audio; every emitted frame is this fixed size.
  frameMs?: number;
  // Queued frames tolerated before the child's stdout is paused (backpressure).
  highWaterMarkFrames?: number;
  // Forward the parent process SIGTERM to the child so it is not orphaned.
  handleProcessSignals?: boolean;
  // Extra environment for the recorder process, merged over process.env.
  env?: NodeJS.ProcessEnv;
}

// Bytes in one PCM16 frame of `frameMs` audio. Must land on a whole sample so a
// frame never splits a 16-bit sample across a boundary.
export function frameBytesForMs(frameMs: number): number {
  const bytes = (CAPTURE_SAMPLE_RATE * CAPTURE_CHANNELS * BYTES_PER_SAMPLE * frameMs) / 1000;
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new Error(`frameMs=${frameMs} does not map to a whole PCM16 frame`);
  }
  return bytes;
}

type Pending = {
  resolve: (result: IteratorResult<Buffer>) => void;
  reject: (error: Error) => void;
};

export class AudioCapture implements AsyncIterableIterator<Buffer> {
  readonly frameBytes: number;

  private readonly child: ChildProcess;
  private readonly stdout: Readable;
  private readonly highWaterMarkFrames: number;
  private onProcessTerm?: () => void;

  // Bytes carried between chunks that did not fill a whole frame yet.
  private leftover = Buffer.alloc(0);
  // Complete frames ready to hand to the consumer.
  private readonly queue: Buffer[] = [];
  private pending?: Pending;
  private ended = false;
  // While shutting down we drain and discard so the paused pipe cannot wedge
  // the child's exit (a paused readable never emits `close`).
  private closing = false;
  private failure?: Error;
  private stopping?: Promise<void>;
  private readonly exited: Promise<void>;

  constructor(options: AudioCaptureOptions) {
    this.frameBytes = frameBytesForMs(options.frameMs ?? DEFAULT_FRAME_MS);
    this.highWaterMarkFrames = options.highWaterMarkFrames ?? DEFAULT_HIGH_WATER_MARK_FRAMES;

    const binary = options.binaryPath ?? "arecord";
    // `-t raw`: without it `arecord` prepends a WAV header that would corrupt the
    // first PCM frame. Stay raw so every byte read is sample data.
    const args = [
      "-t", "raw",
      "-f", CAPTURE_FORMAT,
      "-r", String(CAPTURE_SAMPLE_RATE),
      "-c", String(CAPTURE_CHANNELS),
      "-D", options.device,
    ];
    this.child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "inherit"],
      env: options.env ? { ...process.env, ...options.env } : process.env,
    });

    const stdout = this.child.stdout;
    if (!stdout) {
      throw new Error("arecord child was spawned without a stdout pipe");
    }
    this.stdout = stdout;
    this.stdout.on("data", (chunk: Buffer) => this.ingest(chunk));
    // Natural end: `arecord` closed stdout. Ends the iterator once drained.
    this.stdout.on("end", () => this.finish());
    this.child.on("error", (error) => this.fail(error));
    // `close` fires after the process exited and stdio is released; `stop()`
    // waits on it before reporting clean shutdown.
    this.exited = new Promise((resolve) => {
      this.child.once("close", () => resolve());
    });

    if (options.handleProcessSignals ?? true) {
      this.onProcessTerm = () => void this.stop();
      process.on("SIGTERM", this.onProcessTerm);
    }
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<Buffer> {
    return this;
  }

  // Readable alias for `for await (const frame of capture.frames())`.
  frames(): AsyncIterableIterator<Buffer> {
    return this;
  }

  next(): Promise<IteratorResult<Buffer>> {
    if (this.queue.length > 0) {
      const frame = this.queue.shift() as Buffer;
      this.maybeResume();
      return Promise.resolve({ value: frame, done: false });
    }
    if (this.failure) {
      const error = this.failure;
      this.failure = undefined;
      return Promise.reject(error);
    }
    if (this.ended) {
      return Promise.resolve({ value: undefined, done: true });
    }
    this.maybeResume();
    return new Promise<IteratorResult<Buffer>>((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  // Ending the loop early (break/return) stops the recorder.
  async return(): Promise<IteratorResult<Buffer>> {
    await this.stop();
    return { value: undefined, done: true };
  }

  // Sends SIGTERM to the recorder and resolves once it has exited. Idempotent.
  stop(): Promise<void> {
    if (!this.stopping) {
      this.stopping = this.terminate();
    }
    return this.stopping;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  // Frames buffered but not yet pulled — introspection for backpressure checks.
  queuedFrames(): number {
    return this.queue.length;
  }

  // True while the recorder's stdout is paused because the queue is full.
  isPaused(): boolean {
    return this.stdout.isPaused();
  }

  private ingest(chunk: Buffer): void {
    if (this.ended || this.closing) {
      // Draining to EOF during shutdown: swallow bytes without re-pausing.
      return;
    }
    const buf = this.leftover.length > 0 ? Buffer.concat([this.leftover, chunk]) : chunk;
    let offset = 0;
    while (buf.length - offset >= this.frameBytes) {
      this.enqueue(Buffer.from(buf.subarray(offset, offset + this.frameBytes)));
      offset += this.frameBytes;
    }
    // Detach the tail into its own buffer so we do not retain the whole chunk.
    this.leftover = offset > 0 ? Buffer.from(buf.subarray(offset)) : buf;
  }

  private enqueue(frame: Buffer): void {
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      pending.resolve({ value: frame, done: false });
      return;
    }
    this.queue.push(frame);
    if (this.queue.length >= this.highWaterMarkFrames && !this.stdout.isPaused()) {
      this.stdout.pause();
    }
  }

  private maybeResume(): void {
    if (!this.ended && this.queue.length < this.highWaterMarkFrames && this.stdout.isPaused()) {
      this.stdout.resume();
    }
  }

  private finish(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.detachProcessSignals();
    // A partial trailing frame (< frameBytes) is intentionally dropped: only
    // whole PCM16 frames are emitted.
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      pending.resolve({ value: undefined, done: true });
    }
  }

  private fail(error: Error): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.failure = error;
    this.detachProcessSignals();
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      this.failure = undefined;
      pending.reject(error);
    }
  }

  private async terminate(): Promise<void> {
    this.closing = true;
    this.detachProcessSignals();
    const running = this.child.exitCode === null && this.child.signalCode === null;
    if (running) {
      this.child.kill("SIGTERM");
    }
    // Discard buffered mic audio and keep the reader flowing so the child's
    // stdout reaches EOF and `close` can fire even if we were backpressured.
    this.queue.length = 0;
    this.stdout.resume();
    await this.exited;
    this.finish();
  }

  private detachProcessSignals(): void {
    if (this.onProcessTerm) {
      process.removeListener("SIGTERM", this.onProcessTerm);
      this.onProcessTerm = undefined;
    }
  }
}

export function startCapture(options: AudioCaptureOptions): AudioCapture {
  return new AudioCapture(options);
}
