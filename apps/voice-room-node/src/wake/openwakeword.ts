// openWakeWord "hey jarvis" detector.
//
// Feeds PCM16 frames through the streaming feature pipeline (features.ts), scores
// each new classifier window with the wake model, and emits a WakeEvent when the
// score crosses the configured threshold. A refractory window debounces the
// several above-threshold windows a single utterance produces (and back-to-back
// repeats) down to one event.
import { BYTES_PER_SAMPLE, CAPTURE_SAMPLE_RATE } from "../audio/capture.js";
import { WakeFeatures } from "./features.js";
import {
  defaultModelsDir,
  loadWakeSessions,
  runWake,
  type WakeSessions,
} from "./onnx-sessions.js";

export interface WakeEvent {
  // Wake model score in [0,1] at the crossing.
  score: number;
  // Wall-clock epoch ms when the crossing fired (for logging).
  ts: number;
}

export interface OpenWakeWordOptions {
  sessions: WakeSessions;
  features: WakeFeatures;
  // Crossings at/above this score fire a wake (from config.wake.threshold).
  threshold: number;
  // Refractory span, in audio time, after a wake during which further crossings
  // are suppressed. Collapses one utterance's repeated crossings — and rapid
  // repeats — into a single event.
  debounceMs?: number;
  // Wall clock for WakeEvent.ts; injectable for tests.
  now?: () => number;
}

// Long enough to span one utterance plus a closely following repeat, short
// enough not to swallow a deliberate second wake seconds later.
const DEFAULT_DEBOUNCE_MS = 2500;

export class OpenWakeWord {
  private readonly sessions: WakeSessions;
  private readonly features: WakeFeatures;
  private readonly threshold: number;
  private readonly debounceMs: number;
  private readonly now: () => number;

  // Cumulative audio time pushed, in ms. Debounce compares against this instead
  // of wall time so detection is deterministic regardless of processing speed.
  private audioMs = 0;
  private lastWakeAudioMs: number | null = null;

  constructor(options: OpenWakeWordOptions) {
    this.sessions = options.sessions;
    this.features = options.features;
    this.threshold = options.threshold;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.now = options.now ?? Date.now;
  }

  // Pushes one PCM16 frame captured at 24kHz. Returns a WakeEvent when this frame
  // completed an above-threshold, non-debounced crossing, else null.
  async process(pcm24k: Buffer): Promise<WakeEvent | null> {
    const samples = Math.floor(pcm24k.length / BYTES_PER_SAMPLE);
    const appended = await this.features.pushPcm24k(pcm24k);
    this.audioMs += (samples / CAPTURE_SAMPLE_RATE) * 1000;

    // No new classifier window this frame: nothing to score.
    if (appended <= 0) {
      return null;
    }
    const window = this.features.latestWindow();
    if (!window) {
      return null;
    }
    const score = await runWake(this.sessions, window);
    if (score < this.threshold) {
      return null;
    }
    if (this.lastWakeAudioMs !== null && this.audioMs - this.lastWakeAudioMs < this.debounceMs) {
      // Within the refractory window: same-utterance crossing or rapid repeat.
      return null;
    }
    this.lastWakeAudioMs = this.audioMs;
    return { score, ts: this.now() };
  }
}

export interface CreateOpenWakeWordParams {
  threshold: number;
  debounceMs?: number;
  now?: () => number;
  modelsDir?: string;
}

// Loads the ONNX sessions and a primed feature buffer, then returns a ready
// detector. This is the boot path callers (wake-listen.ts) use.
export async function createOpenWakeWord(params: CreateOpenWakeWordParams): Promise<OpenWakeWord> {
  const sessions = await loadWakeSessions(params.modelsDir ?? defaultModelsDir());
  const features = await WakeFeatures.create(sessions);
  return new OpenWakeWord({
    sessions,
    features,
    threshold: params.threshold,
    debounceMs: params.debounceMs,
    now: params.now,
  });
}
