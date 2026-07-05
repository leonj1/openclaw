// Standalone Layer 1 entry: listen on the mic and react to "hey jarvis".
//
// Opens mic capture, streams frames through the openWakeWord detector, and on
// each WakeEvent prints a `WAKE score=… ts=…` line and plays a short audible cue
// through playback. No gateway, no OpenClaw — this proves detection on real audio
// (see STEPS.md Layer 1). SIGTERM stops capture and playback cleanly.
import { pathToFileURL } from "node:url";
import {
  PLAYBACK_SAMPLE_RATE,
  startPlayback,
  type AudioPlaybackOptions,
} from "../audio/playback.js";
import { startCapture, type AudioCaptureOptions } from "../audio/capture.js";
import { loadWakeListenConfig } from "../config.js";
import { createOpenWakeWord, type WakeEvent } from "./openwakeword.js";

// Narrow structural handles so the test can inject stubs and stay off real
// arecord/aplay; the real subsystems satisfy them.
interface CaptureHandle {
  frames(): AsyncIterableIterator<Buffer>;
  stop(): Promise<void>;
}
interface PlaybackHandle {
  enqueue(frameBase64: string): void;
  stop(): Promise<void>;
}
interface Detector {
  process(pcm24k: Buffer): Promise<WakeEvent | null>;
}

// What wake-listen needs from config; injectable so the test skips gateway setup.
export interface WakeListenConfig {
  captureDevice: string;
  playbackDevice: string;
  threshold: number;
}

export interface WakeListenDeps {
  env?: NodeJS.ProcessEnv;
  config?: WakeListenConfig;
  startCapture?: (options: AudioCaptureOptions) => CaptureHandle;
  startPlayback?: (options: AudioPlaybackOptions) => PlaybackHandle;
  createDetector?: (params: { threshold: number }) => Promise<Detector>;
  // Sink for the wake line; defaults to console.log.
  log?: (line: string) => void;
}

export interface WakeListenHandle {
  // Resolves when capture ends (stub EOF or after stop()).
  done: Promise<void>;
  // Stop capture + playback and wait for the pump to finish. Idempotent.
  stop(): Promise<void>;
}

// Short 880Hz sine "beep" as PCM16 at the playback rate, with a few-ms fade so
// the abrupt start/stop does not click. Built once and reused per wake.
export function makeWakeCuePcm(
  sampleRate: number = PLAYBACK_SAMPLE_RATE,
  freqHz = 880,
  durationMs = 150,
): Buffer {
  const total = Math.round((sampleRate * durationMs) / 1000);
  const fade = Math.round(sampleRate * 0.005); // 5ms fade in/out
  const pcm = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i++) {
    let gain = 0.3;
    if (i < fade) {
      gain *= i / fade;
    } else if (i > total - fade) {
      gain *= (total - i) / fade;
    }
    const sample = Math.round(Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * gain * 32767);
    pcm.writeInt16LE(sample, i * 2);
  }
  return pcm;
}

function resolveConfig(deps: WakeListenDeps): WakeListenConfig {
  if (deps.config) {
    return deps.config;
  }
  const loaded = loadWakeListenConfig(deps.env ?? process.env);
  if (!loaded.ok) {
    throw new Error(`wake-listen: invalid config: ${loaded.error}`);
  }
  return {
    captureDevice: loaded.config.audio.captureDevice,
    playbackDevice: loaded.config.audio.playbackDevice,
    threshold: loaded.config.wake.threshold,
  };
}

export async function runWakeListen(deps: WakeListenDeps = {}): Promise<WakeListenHandle> {
  const config = resolveConfig(deps);
  const log = deps.log ?? ((line: string) => console.log(line));

  const detector = await (deps.createDetector ?? createOpenWakeWord)({ threshold: config.threshold });
  const capture = (deps.startCapture ?? startCapture)({
    device: config.captureDevice,
    handleProcessSignals: false,
  });
  const playback = (deps.startPlayback ?? startPlayback)({
    device: config.playbackDevice,
    handleProcessSignals: false,
  });

  const cueBase64 = makeWakeCuePcm().toString("base64");

  const pump = (async (): Promise<void> => {
    try {
      for await (const frame of capture.frames()) {
        const event = await detector.process(frame);
        if (event) {
          log(`WAKE score=${event.score.toFixed(3)} ts=${event.ts}`);
          playback.enqueue(cueBase64);
        }
      }
    } catch {
      // Capture ended/errored (expected on shutdown). Nothing more to detect.
    }
  })();

  let stopping: Promise<void> | undefined;
  const onSigterm = (): void => {
    void stop();
  };
  const stop = (): Promise<void> => {
    if (!stopping) {
      process.removeListener("SIGTERM", onSigterm);
      stopping = (async () => {
        await capture.stop();
        await pump;
        await playback.stop();
      })();
    }
    return stopping;
  };
  process.on("SIGTERM", onSigterm);

  return { done: pump, stop };
}

// Direct-run entry: listen until SIGTERM. A boot failure (bad config, missing
// models) exits non-zero after logging.
async function main(): Promise<void> {
  try {
    const handle = await runWakeListen();
    console.log('wake-listen: listening for "Hey Jarvis". SIGTERM to stop.');
    await handle.done;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`wake-listen: failed: ${detail}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
