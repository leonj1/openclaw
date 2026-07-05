// TTS playback for the "Hey Jarvis" voice-room node.
//
// Spawns `aplay` in raw PCM16 mode (24kHz mono — the node-wide audio format,
// see AGENTS.md) and feeds it base64-encoded TTS frames through stdin. Frames
// are written in enqueue order and one at a time, honoring the child's stdin
// backpressure so we never over-buffer. `stop()` is the barge-in path: it drops
// every queued frame and SIGTERMs the child so speech halts mid-utterance. The
// parent process receiving SIGTERM tears the child down the same way so no
// orphan `aplay` survives the node.
import { spawn, type ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";

// Node-wide playback format. Locked to PCM16 / 24kHz / mono to match capture,
// wake fixtures, and TTS.
export const PLAYBACK_FORMAT = "S16_LE";
export const PLAYBACK_SAMPLE_RATE = 24_000;
export const PLAYBACK_CHANNELS = 1;

export interface AudioPlaybackOptions {
  // ALSA playback device id passed to `aplay -D` (e.g. "plughw:CARD=Anker,DEV=0").
  device: string;
  // Player binary; overridable so tests can inject a fake `aplay`.
  binaryPath?: string;
  // Forward the parent process SIGTERM to the child so it is not orphaned.
  handleProcessSignals?: boolean;
  // Extra environment for the player process, merged over process.env.
  env?: NodeJS.ProcessEnv;
}

export class AudioPlayback {
  private readonly child: ChildProcess;
  private readonly stdin: Writable;
  private onProcessTerm?: () => void;

  // Decoded PCM frames waiting to be written, in enqueue order.
  private readonly queue: Buffer[] = [];
  // True while a frame is in flight so enqueue never interleaves the stream.
  private writing = false;
  // Barge-in / shutdown latch: once set we stop writing and drop the queue.
  private closing = false;
  private stopping?: Promise<void>;
  // Resolved when the queue empties (playback caught up) or after stop().
  private drainWaiters: Array<() => void> = [];
  private readonly exited: Promise<void>;

  constructor(options: AudioPlaybackOptions) {
    const binary = options.binaryPath ?? "aplay";
    // `-t raw`: aplay would otherwise expect a WAV container on stdin and the raw
    // PCM header bytes would be misread. Stay raw so stdin is pure sample data.
    const args = [
      "-t", "raw",
      "-f", PLAYBACK_FORMAT,
      "-r", String(PLAYBACK_SAMPLE_RATE),
      "-c", String(PLAYBACK_CHANNELS),
      "-D", options.device,
    ];
    this.child = spawn(binary, args, {
      stdio: ["pipe", "ignore", "inherit"],
      env: options.env ? { ...process.env, ...options.env } : process.env,
    });

    const stdin = this.child.stdin;
    if (!stdin) {
      throw new Error("aplay child was spawned without a stdin pipe");
    }
    this.stdin = stdin;
    // Killing the child (barge-in) breaks the pipe mid-write; swallow the EPIPE
    // so a discarded frame never crashes the node.
    this.stdin.on("error", () => {});
    this.child.on("error", () => {});
    // `close` fires after the process exited and stdio is released; `stop()`
    // waits on it before reporting clean shutdown.
    this.exited = new Promise((resolve) => {
      this.child.once("close", () => resolve());
    });
    // aplay exiting on its own (device error, EOF) should still release waiters.
    this.child.once("close", () => {
      this.closing = true;
      this.queue.length = 0;
      this.writing = false;
      this.notifyDrained();
    });

    if (options.handleProcessSignals ?? true) {
      this.onProcessTerm = () => void this.stop();
      process.on("SIGTERM", this.onProcessTerm);
    }
  }

  // Queue one base64-encoded PCM16 frame for playback. Frames play in the order
  // enqueued; a no-op once stopped.
  enqueue(frameBase64: string): void {
    if (this.closing) {
      return;
    }
    const frame = Buffer.from(frameBase64, "base64");
    if (frame.length === 0) {
      return;
    }
    this.queue.push(frame);
    this.pump();
  }

  // Barge-in: drop every queued frame and SIGTERM the player so speech stops
  // immediately. Resolves once the child has exited. Idempotent.
  stop(): Promise<void> {
    if (!this.stopping) {
      this.stopping = this.terminate();
    }
    return this.stopping;
  }

  // Resolves when the queue has fully drained to the player (or after stop()).
  drained(): Promise<void> {
    if (!this.writing && this.queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  // Frames queued but not yet written — introspection for barge-in/backpressure.
  pendingFrames(): number {
    return this.queue.length;
  }

  private pump(): void {
    if (this.writing || this.closing) {
      return;
    }
    this.writing = true;
    const writeNext = (): void => {
      if (this.closing) {
        this.writing = false;
        return;
      }
      const frame = this.queue.shift();
      if (!frame) {
        this.writing = false;
        this.notifyDrained();
        return;
      }
      // write() returns false when the child's stdin buffer is full: wait for
      // `drain` before the next frame so we track real playback backpressure.
      const flushed = this.stdin.write(frame);
      if (flushed) {
        setImmediate(writeNext);
      } else {
        this.stdin.once("drain", writeNext);
      }
    };
    writeNext();
  }

  private notifyDrained(): void {
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  private async terminate(): Promise<void> {
    this.closing = true;
    this.detachProcessSignals();
    // Barge-in: everything still queued is abandoned so it never reaches aplay.
    this.queue.length = 0;
    const running = this.child.exitCode === null && this.child.signalCode === null;
    if (running) {
      this.child.kill("SIGTERM");
    }
    await this.exited;
    this.notifyDrained();
  }

  private detachProcessSignals(): void {
    if (this.onProcessTerm) {
      process.removeListener("SIGTERM", this.onProcessTerm);
      this.onProcessTerm = undefined;
    }
  }
}

export function startPlayback(options: AudioPlaybackOptions): AudioPlayback {
  return new AudioPlayback(options);
}
