// "Thinking" wait-music loop for the Layer 2 turn.
//
// While OpenClaw processes a turn (chat.send -> agent.wait blocks), the node
// plays a royalty-free hold loop so the room hears something. The loop clip is
// only a few minutes long but a wait can outlast it, so we decode the WAV once
// and re-enqueue its frames on repeat until stop().
//
// Pacing: playback (aplay) drains at real-time 24kHz and applies stdin
// backpressure, so we keep the sink's queue between empty and a high-water mark
// instead of blasting the whole clip in at once (which would buffer unbounded
// and make barge-in slow to flush). stop() halts enqueue promptly so the reply
// TTS never overlaps the wait music.
import { PLAYBACK_SAMPLE_RATE } from "./playback.js";
import { framePcmToBase64, readWavFile } from "./wav.js";

// Sink is the playback handle: queue one base64 PCM16 frame and report queue
// depth so the loop can throttle. AudioPlayback satisfies this structurally.
export interface WaitLoopSink {
  enqueue(frameBase64: string): void;
  pendingFrames(): number;
}

export interface WaitLoopOptions {
  // Decoded PCM16 24kHz mono frames of the loop clip, in play order.
  frames: string[];
  sink: WaitLoopSink;
  // Keep at most this many frames queued in the sink; refill when it drops.
  highWaterFrames?: number;
  // Poll interval while the sink queue is full or between refills.
  pollMs?: number;
}

const DEFAULT_FRAME_MS = 20;
// ~1s of audio buffered ahead at 20ms/frame: enough to ride out scheduler
// jitter without making barge-in flush a long backlog.
const DEFAULT_HIGH_WATER_FRAMES = 50;
const DEFAULT_POLL_MS = 20;

const BYTES_PER_SAMPLE = 2;

// Bytes in one `frameMs` PCM16 frame at the playback rate.
function frameBytesForMs(frameMs: number): number {
  return (PLAYBACK_SAMPLE_RATE * BYTES_PER_SAMPLE * frameMs) / 1000;
}

// Loads the wait-loop WAV from disk and pre-frames it. Rejects a WAV that is not
// the node-wide PCM16 24kHz mono format so a mis-encoded asset fails loudly.
export function loadWaitLoopFrames(path: string, frameMs = DEFAULT_FRAME_MS): string[] {
  const parsed = readWavFile(path);
  if (!parsed.ok) {
    throw new Error(`wait-loop: cannot read ${path}: ${parsed.error}`);
  }
  const { sampleRate, channels, bitsPerSample } = parsed.wav;
  if (sampleRate !== PLAYBACK_SAMPLE_RATE || channels !== 1 || bitsPerSample !== 16) {
    throw new Error(
      `wait-loop: ${path} must be PCM16 24kHz mono, got ${bitsPerSample}-bit ${sampleRate}Hz ${channels}ch`,
    );
  }
  const frames = framePcmToBase64(parsed.wav.pcm, frameBytesForMs(frameMs));
  if (frames.length === 0) {
    throw new Error(`wait-loop: ${path} has no full frames`);
  }
  return frames;
}

export class WaitLoop {
  private readonly frames: string[];
  private readonly sink: WaitLoopSink;
  private readonly highWaterFrames: number;
  private readonly pollMs: number;
  private index = 0;
  private stopped = false;
  private running?: Promise<void>;

  constructor(options: WaitLoopOptions) {
    if (options.frames.length === 0) {
      throw new Error("wait-loop: no frames to play");
    }
    this.frames = options.frames;
    this.sink = options.sink;
    this.highWaterFrames = options.highWaterFrames ?? DEFAULT_HIGH_WATER_FRAMES;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  }

  // Begin (or rejoin) the loop. Enqueues frames on repeat, throttled to the
  // sink's queue depth, until stop(). Idempotent while running. One instance is
  // reused across turns, so start() must clear the prior stop() latch and restart
  // the clip from the top; without this reset only the first turn would play.
  start(): void {
    if (this.running) {
      return;
    }
    this.stopped = false;
    this.index = 0;
    this.running = this.run();
  }

  // Halt enqueue. Does not flush the sink — the caller flushes via
  // playback.stop() so the queued tail stops the instant the reply lands.
  // Clears `running` so the next turn's start() can spin the loop back up.
  async stop(): Promise<void> {
    this.stopped = true;
    await this.running;
    this.running = undefined;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      // Enqueue a bounded batch to refill up to the high-water mark, then yield
      // so aplay can drain and a concurrent stop() can break between polls. The
      // deficit is read once per poll so a sink that reports queue depth only
      // after playback drains (not synchronously on enqueue) cannot spin us.
      const deficit = this.highWaterFrames - this.sink.pendingFrames();
      for (let i = 0; i < deficit && !this.stopped; i++) {
        this.sink.enqueue(this.frames[this.index]);
        this.index = (this.index + 1) % this.frames.length;
      }
      if (this.stopped) {
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, this.pollMs));
    }
  }
}

// Convenience boot: load the WAV and return a ready loop bound to the sink.
export function createWaitLoop(params: {
  path: string;
  sink: WaitLoopSink;
  highWaterFrames?: number;
  pollMs?: number;
}): WaitLoop {
  return new WaitLoop({
    frames: loadWaitLoopFrames(params.path),
    sink: params.sink,
    highWaterFrames: params.highWaterFrames,
    pollMs: params.pollMs,
  });
}
