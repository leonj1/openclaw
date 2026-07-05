// Streaming audio feature extraction for the openWakeWord "hey jarvis" pipeline.
//
// Turns a stream of PCM16 frames into the rolling embedding buffer the wake
// classifier scores. This mirrors openWakeWord's AudioFeatures streaming path:
//   raw 16kHz PCM -> mel-spectrogram frames -> 76-frame windows -> 96-d
//   embeddings, kept in a rolling feature buffer.
//
// SAMPLE-RATE INVARIANT (non-obvious): the whole node runs at 24kHz (capture,
// playback, TTS — see AGENTS.md) but these models are trained at 16kHz. Every
// PCM16 frame handed to `pushPcm24k` is resampled 24k -> 16k here before it ever
// reaches the mel model. Nothing downstream of this file sees 24kHz audio.
import {
  CAPTURE_SAMPLE_RATE,
  BYTES_PER_SAMPLE,
} from "../audio/capture.js";
import {
  EMBED_DIM,
  EMBED_WINDOW_FRAMES,
  MEL_BINS,
  MODEL_SAMPLE_RATE,
  WAKE_FEATURE_FRAMES,
  runEmbedding,
  runMelspectrogram,
  type WakeSessions,
} from "./onnx-sessions.js";

// One openWakeWord streaming step processes an 80ms chunk: 1280 samples @ 16kHz.
const CHUNK_SAMPLES = 1280;
// Extra mel context openWakeWord prepends per chunk (160*3 = three hops) so the
// streaming mel frames align with the whole-clip computation.
const MEL_CONTEXT_SAMPLES = 160 * 3;
// Mel frames per streaming window; capped to ~10s so the buffer stays bounded.
const MEL_BUFFER_MAX_FRAMES = 10 * 97;
// ~10s of embedding history; the classifier only needs the last 16 frames.
const FEATURE_BUFFER_MAX_FRAMES = 120;
// Seconds of silence used to pre-fill the feature buffer at construction, so the
// 16-frame classifier window is full from the first spoken chunk. openWakeWord
// seeds with random audio; silence is deterministic and reads as non-speech.
const PRIME_SECONDS = 4;
// Mel window stride when embedding a whole clip (openWakeWord uses 8).
const EMBED_WINDOW_STEP = 8;

// Decodes a little-endian PCM16 buffer into signed 16-bit sample values.
export function pcm16ToInt16(pcm: Buffer): Int16Array {
  const count = Math.floor(pcm.length / BYTES_PER_SAMPLE);
  const out = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = pcm.readInt16LE(i * BYTES_PER_SAMPLE);
  }
  return out;
}

// Linear-interpolation resampler from the node's 24kHz capture to the models'
// 16kHz domain. Wake detection is robust to the mild quality loss, and linear
// interpolation keeps this dependency-free. Samples stay in int16 range because
// the mel model consumes raw PCM sample magnitudes (not normalized floats).
export function resample24kTo16k(input: Int16Array): Int16Array {
  if (input.length === 0) {
    return new Int16Array(0);
  }
  const ratio = MODEL_SAMPLE_RATE / CAPTURE_SAMPLE_RATE; // 2/3
  const outLength = Math.floor(input.length * ratio);
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i / ratio;
    const left = Math.floor(srcPos);
    const right = Math.min(left + 1, input.length - 1);
    const frac = srcPos - left;
    out[i] = Math.round(input[left] * (1 - frac) + input[right] * frac);
  }
  return out;
}

// Rolling wake-feature state. One instance per detector; `reset()` clears it
// between detached utterances if a caller ever needs a clean buffer.
export class WakeFeatures {
  private readonly sessions: WakeSessions;

  // 16kHz samples awaiting mel processing. openWakeWord keeps a long raw buffer
  // so each mel step can look back over prior context (MEL_CONTEXT_SAMPLES).
  private rawBuffer: number[] = [];
  // 16kHz samples left over from a push that did not complete an 80ms chunk.
  private remainder = new Int16Array(0);
  // Count of samples buffered toward the next 1280-sample chunk boundary.
  private accumulated = 0;
  // Rolling [frames, 32] mel spectrogram, seeded with ones like openWakeWord.
  private melBuffer: Float32Array;
  private melFrames: number;
  // Rolling [frames, 96] embedding history the classifier reads its window from.
  private featureBuffer: Float32Array;
  private featureFrames: number;

  constructor(sessions: WakeSessions) {
    this.sessions = sessions;
    this.melBuffer = new Float32Array(EMBED_WINDOW_FRAMES * MEL_BINS).fill(1);
    this.melFrames = EMBED_WINDOW_FRAMES;
    this.featureBuffer = new Float32Array(0);
    this.featureFrames = 0;
  }

  // Constructs and pre-fills the feature buffer so `latestWindow()` is non-null
  // from the first real chunk. Use this instead of `new WakeFeatures(...)`.
  static async create(sessions: WakeSessions): Promise<WakeFeatures> {
    const feats = new WakeFeatures(sessions);
    await feats.prime();
    return feats;
  }

  // Seeds the feature buffer with embeddings of PRIME_SECONDS of silence via the
  // one-shot (non-streaming) path, matching openWakeWord's constructor pre-fill.
  private async prime(): Promise<void> {
    const silence = new Float32Array(MODEL_SAMPLE_RATE * PRIME_SECONDS);
    const mel = await runMelspectrogram(this.sessions, silence);
    for (let f = 0; f + EMBED_WINDOW_FRAMES <= mel.frames; f += EMBED_WINDOW_STEP) {
      const window = mel.data.slice(f * MEL_BINS, (f + EMBED_WINDOW_FRAMES) * MEL_BINS);
      const embedding = await runEmbedding(this.sessions, window);
      this.appendFeature(embedding);
    }
  }

  reset(): void {
    this.rawBuffer = [];
    this.remainder = new Int16Array(0);
    this.accumulated = 0;
    this.melBuffer = new Float32Array(EMBED_WINDOW_FRAMES * MEL_BINS).fill(1);
    this.melFrames = EMBED_WINDOW_FRAMES;
    this.featureBuffer = new Float32Array(0);
    this.featureFrames = 0;
  }

  // Number of embedding frames currently buffered.
  get frames(): number {
    return this.featureFrames;
  }

  // Feeds one PCM16 frame captured at 24kHz. Resamples to 16kHz, then advances
  // the streaming pipeline for every whole 80ms chunk the input completed.
  // Returns the number of new embedding frames appended.
  async pushPcm24k(pcm: Buffer): Promise<number> {
    const resampled = resample24kTo16k(pcm16ToInt16(pcm));
    return this.push16k(resampled);
  }

  // Feeds 16kHz PCM samples directly (test seam / already-resampled audio).
  async push16k(samples: Int16Array): Promise<number> {
    // Prepend any samples left over from the previous push.
    let x = samples;
    if (this.remainder.length > 0) {
      const merged = new Int16Array(this.remainder.length + samples.length);
      merged.set(this.remainder, 0);
      merged.set(samples, this.remainder.length);
      x = merged;
      this.remainder = new Int16Array(0);
    }

    // Buffer whole samples toward the next chunk boundary, holding a partial
    // 80ms tail as the remainder for the next push.
    if (this.accumulated + x.length >= CHUNK_SAMPLES) {
      const rem = (this.accumulated + x.length) % CHUNK_SAMPLES;
      if (rem !== 0) {
        const even = x.subarray(0, x.length - rem);
        this.bufferRaw(even);
        this.accumulated += even.length;
        this.remainder = x.slice(x.length - rem);
      } else {
        this.bufferRaw(x);
        this.accumulated += x.length;
      }
    } else {
      this.accumulated += x.length;
      this.bufferRaw(x);
    }

    if (this.accumulated < CHUNK_SAMPLES || this.accumulated % CHUNK_SAMPLES !== 0) {
      return 0;
    }

    await this.streamMelspectrogram(this.accumulated);
    let appended = 0;
    // One 1280-sample chunk yields eight new mel frames (step 8); walk them back
    // to front so the newest 76-frame window lands last in the feature buffer.
    for (let i = this.accumulated / CHUNK_SAMPLES - 1; i >= 0; i--) {
      const ndx = i === 0 ? this.melFrames : this.melFrames - 8 * i;
      const start = ndx - EMBED_WINDOW_FRAMES;
      if (start < 0) {
        continue;
      }
      const window = this.melBuffer.slice(start * MEL_BINS, ndx * MEL_BINS);
      const embedding = await runEmbedding(this.sessions, window);
      this.appendFeature(embedding);
      appended++;
    }
    this.accumulated = 0;
    return appended;
  }

  // Returns the last `WAKE_FEATURE_FRAMES` embedding frames as a flat
  // [16*96] Float32Array, or null until enough audio has streamed in.
  latestWindow(): Float32Array | null {
    if (this.featureFrames < WAKE_FEATURE_FRAMES) {
      return null;
    }
    const start = (this.featureFrames - WAKE_FEATURE_FRAMES) * EMBED_DIM;
    return this.featureBuffer.slice(start, start + WAKE_FEATURE_FRAMES * EMBED_DIM);
  }

  private bufferRaw(samples: Int16Array): void {
    for (let i = 0; i < samples.length; i++) {
      this.rawBuffer.push(samples[i]);
    }
    const maxRaw = MODEL_SAMPLE_RATE * 10;
    if (this.rawBuffer.length > maxRaw) {
      this.rawBuffer = this.rawBuffer.slice(this.rawBuffer.length - maxRaw);
    }
  }

  private async streamMelspectrogram(nSamples: number): Promise<void> {
    const take = nSamples + MEL_CONTEXT_SAMPLES;
    const from = Math.max(0, this.rawBuffer.length - take);
    const slice = this.rawBuffer.slice(from);
    const floats = new Float32Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      floats[i] = slice[i];
    }
    const mel = await runMelspectrogram(this.sessions, floats);
    this.appendMel(mel.data, mel.frames);
  }

  private appendMel(data: Float32Array, frames: number): void {
    const combined = new Float32Array(this.melBuffer.length + data.length);
    combined.set(this.melBuffer, 0);
    combined.set(data, this.melBuffer.length);
    let totalFrames = this.melFrames + frames;
    if (totalFrames > MEL_BUFFER_MAX_FRAMES) {
      const drop = totalFrames - MEL_BUFFER_MAX_FRAMES;
      this.melBuffer = combined.slice(drop * MEL_BINS);
      totalFrames = MEL_BUFFER_MAX_FRAMES;
    } else {
      this.melBuffer = combined;
    }
    this.melFrames = totalFrames;
  }

  private appendFeature(embedding: Float32Array): void {
    const combined = new Float32Array(this.featureBuffer.length + embedding.length);
    combined.set(this.featureBuffer, 0);
    combined.set(embedding, this.featureBuffer.length);
    let totalFrames = this.featureFrames + 1;
    if (totalFrames > FEATURE_BUFFER_MAX_FRAMES) {
      const drop = totalFrames - FEATURE_BUFFER_MAX_FRAMES;
      this.featureBuffer = combined.slice(drop * EMBED_DIM);
      totalFrames = FEATURE_BUFFER_MAX_FRAMES;
    } else {
      this.featureBuffer = combined;
    }
    this.featureFrames = totalFrames;
  }
}
