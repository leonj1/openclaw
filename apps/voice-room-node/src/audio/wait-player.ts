// Randomized "thinking" wait audio for the Layer 2 turn.
//
// While OpenClaw processes a turn the node plays *something* so the room hears
// activity. There are two flavors and each turn picks one at random:
//   - instrumental: the royalty-free hold loop (WaitLoop over wait-loop.wav).
//   - spoken fillers: short "one moment…", "thinking…", "working on it" clips
//     played one at a time with a random 2-3s silent gap between them, cycling.
// Both satisfy the same start()/stop() handle the talk-node drives, so the turn
// orchestrator never learns which one is playing.
import fs from "node:fs";
import { WaitLoop, loadWaitLoopFrames, type WaitLoopSink } from "./wait-loop.js";

// Minimal handle the talk-node drives (WaitLoop and the players below satisfy it).
export interface WaitPlayer {
  start(): void;
  stop(): Promise<void>;
}

const DEFAULT_HIGH_WATER_FRAMES = 50;
const DEFAULT_POLL_MS = 20;
// Silent spacing between spoken fillers so each cue lands as its own utterance.
const DEFAULT_GAP_MS_RANGE: readonly [number, number] = [2000, 3000];

export interface FillerLoopOptions {
  // Each clip is its ordered base64 PCM16 24kHz mono frames (see loadWaitLoopFrames).
  clips: string[][];
  sink: WaitLoopSink;
  gapMsRange?: readonly [number, number];
  highWaterFrames?: number;
  pollMs?: number;
  // Injectable for deterministic tests; defaults to Math.random.
  random?: () => number;
}

// Plays the spoken filler clips in sequence, pausing a random gap between each,
// and cycles until stop(). Feeds frames throttled to the sink's queue depth
// (same backpressure contract as WaitLoop) and lets a clip fully drain before
// the gap so the pause is real silence, not a queued tail.
export class FillerLoop implements WaitPlayer {
  private readonly clips: string[][];
  private readonly sink: WaitLoopSink;
  private readonly gapMsRange: readonly [number, number];
  private readonly highWaterFrames: number;
  private readonly pollMs: number;
  private readonly random: () => number;
  private index = 0;
  private stopped = false;
  private running?: Promise<void>;

  constructor(options: FillerLoopOptions) {
    if (options.clips.length === 0) {
      throw new Error("filler-loop: no clips to play");
    }
    this.clips = options.clips;
    this.sink = options.sink;
    this.gapMsRange = options.gapMsRange ?? DEFAULT_GAP_MS_RANGE;
    this.highWaterFrames = options.highWaterFrames ?? DEFAULT_HIGH_WATER_FRAMES;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.random = options.random ?? Math.random;
  }

  // Idempotent while running. Resets the stop() latch and restarts from the
  // first clip so a reused instance plays on every turn.
  start(): void {
    if (this.running) {
      return;
    }
    this.stopped = false;
    this.index = 0;
    this.running = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.running;
    this.running = undefined;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      await this.feedClip(this.clips[this.index]);
      if (this.stopped) return;
      await this.waitForDrain();
      if (this.stopped) return;
      await this.sleepGap();
      this.index = (this.index + 1) % this.clips.length;
    }
  }

  private async feedClip(frames: string[]): Promise<void> {
    for (const frame of frames) {
      while (!this.stopped && this.sink.pendingFrames() >= this.highWaterFrames) {
        await this.delay(this.pollMs);
      }
      if (this.stopped) return;
      this.sink.enqueue(frame);
    }
  }

  private async waitForDrain(): Promise<void> {
    while (!this.stopped && this.sink.pendingFrames() > 0) {
      await this.delay(this.pollMs);
    }
  }

  private async sleepGap(): Promise<void> {
    const [min, max] = this.gapMsRange;
    const total = min + this.random() * (max - min);
    // Sleep in poll-sized steps so stop() breaks the gap promptly.
    let elapsed = 0;
    while (!this.stopped && elapsed < total) {
      const step = Math.min(this.pollMs, total - elapsed);
      await this.delay(step);
      elapsed += step;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export interface RandomWaitPlayerOptions {
  instrumental: () => WaitPlayer;
  // Omitted when no filler clips are available, forcing the instrumental loop.
  fillers?: () => WaitPlayer;
  random?: () => number;
}

// On each start() flips a coin between the instrumental loop and the spoken
// fillers, then delegates. One turn plays exactly one flavor.
export class RandomWaitPlayer implements WaitPlayer {
  private readonly random: () => number;
  private active?: WaitPlayer;

  constructor(private readonly options: RandomWaitPlayerOptions) {
    this.random = options.random ?? Math.random;
  }

  start(): void {
    if (this.active) {
      return;
    }
    const useFillers = this.options.fillers !== undefined && this.random() < 0.5;
    this.active = useFillers ? this.options.fillers!() : this.options.instrumental();
    this.active.start();
  }

  async stop(): Promise<void> {
    const active = this.active;
    this.active = undefined;
    await active?.stop();
  }
}

// Convenience boot: preload the instrumental clip and any present filler clips
// once, then return a randomizer bound to the sink. Missing filler files are
// skipped (they are optional, git-ignored assets); with none present the player
// always plays the instrumental loop.
export function createWaitPlayer(params: {
  instrumentalPath: string;
  fillerPaths: string[];
  sink: WaitLoopSink;
  random?: () => number;
}): WaitPlayer {
  const instrumentalFrames = loadWaitLoopFrames(params.instrumentalPath);
  const fillerClips = params.fillerPaths
    .filter((filePath) => fs.existsSync(filePath))
    .map((filePath) => loadWaitLoopFrames(filePath));
  return new RandomWaitPlayer({
    instrumental: () => new WaitLoop({ frames: instrumentalFrames, sink: params.sink }),
    fillers:
      fillerClips.length > 0
        ? () => new FillerLoop({ clips: fillerClips, sink: params.sink, random: params.random })
        : undefined,
    random: params.random,
  });
}
