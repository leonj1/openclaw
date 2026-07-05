// ONNX session loading + typed run helpers for the openWakeWord "hey jarvis"
// front end.
//
// The wake detector is a three-model pipeline, all shipped by openWakeWord
// (Apache-2.0; fetched by scripts/fetch-models.sh into ../../models):
//   1. melspectrogram.onnx  raw PCM samples -> mel-spectrogram frames (32 bins)
//   2. embedding_model.onnx  a 76-frame mel window -> 96-d speech embedding
//   3. hey_jarvis_v0.1.onnx  16 stacked embeddings -> a single wake score
//
// IMPORTANT sample-rate invariant: these models are trained at 16kHz, but the
// node captures at 24kHz (see AGENTS.md). features.ts resamples 24k -> 16k
// before feeding samples here; everything in this module is 16kHz-domain.
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-node";

// Model-domain constants (contract of the pinned v0.5.1 openWakeWord artifacts).
export const MODEL_SAMPLE_RATE = 16_000;
// mel-spectrogram model emits one frame per 160 samples (10ms hop @ 16kHz).
export const MEL_HOP_SAMPLES = 160;
export const MEL_BINS = 32;
// embedding model consumes a fixed 76-frame mel window and emits 96 features.
export const EMBED_WINDOW_FRAMES = 76;
export const EMBED_DIM = 96;
// wake classifier consumes the last 16 embedding frames.
export const WAKE_FEATURE_FRAMES = 16;

const MODEL_FILES = {
  mel: "melspectrogram.onnx",
  embedding: "embedding_model.onnx",
  wake: "hey_jarvis_v0.1.onnx",
} as const;

// Loaded sessions plus the input/output tensor names read back from each model,
// so callers bind by real name instead of a hard-coded literal.
export interface WakeSessions {
  readonly mel: ort.InferenceSession;
  readonly embedding: ort.InferenceSession;
  readonly wake: ort.InferenceSession;
  readonly names: {
    mel: { input: string; output: string };
    embedding: { input: string; output: string };
    wake: { input: string; output: string };
  };
}

export function defaultModelsDir(): string {
  // src/wake/onnx-sessions.ts -> ../../models
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "models");
}

async function createSession(file: string): Promise<ort.InferenceSession> {
  // Single-threaded intra-op: the wake pipeline runs per 80ms audio chunk on a
  // small model, so extra threads add scheduling cost without throughput gain.
  return ort.InferenceSession.create(file, { intraOpNumThreads: 1 });
}

export async function loadWakeSessions(modelsDir: string = defaultModelsDir()): Promise<WakeSessions> {
  const [mel, embedding, wake] = await Promise.all([
    createSession(path.join(modelsDir, MODEL_FILES.mel)),
    createSession(path.join(modelsDir, MODEL_FILES.embedding)),
    createSession(path.join(modelsDir, MODEL_FILES.wake)),
  ]);
  return {
    mel,
    embedding,
    wake,
    names: {
      mel: { input: mel.inputNames[0], output: mel.outputNames[0] },
      embedding: { input: embedding.inputNames[0], output: embedding.outputNames[0] },
      wake: { input: wake.inputNames[0], output: wake.outputNames[0] },
    },
  };
}

// Makes the ONNX mel-spectrogram output track Google's TF speech_embedding front
// end (same transform openWakeWord applies). Kept here so mel output handed to
// the embedding model is always in the expected range.
function melTransform(value: number): number {
  return value / 10 + 2;
}

export interface MelResult {
  // Number of mel frames produced (samples/160 - 3).
  frames: number;
  // Row-major [frames, MEL_BINS] float data, transform already applied.
  data: Float32Array;
}

// Runs the mel model over raw 16kHz samples (as float, not normalized) and
// returns the transformed [frames, 32] spectrogram.
export async function runMelspectrogram(
  sessions: WakeSessions,
  samples: Float32Array,
): Promise<MelResult> {
  const input = new ort.Tensor("float32", samples, [1, samples.length]);
  const out = await sessions.mel.run({ [sessions.names.mel.input]: input });
  const tensor = out[sessions.names.mel.output];
  const dims = tensor.dims; // [1, 1, frames, 32]
  const frames = dims[dims.length - 2];
  const raw = tensor.data as Float32Array;
  const data = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    data[i] = melTransform(raw[i]);
  }
  return { frames, data };
}

// Runs the embedding model over one [76, 32] mel window and returns its 96-d
// embedding vector.
export async function runEmbedding(
  sessions: WakeSessions,
  window: Float32Array,
): Promise<Float32Array> {
  if (window.length !== EMBED_WINDOW_FRAMES * MEL_BINS) {
    throw new Error(
      `embedding window must be ${EMBED_WINDOW_FRAMES * MEL_BINS} floats, got ${window.length}`,
    );
  }
  const input = new ort.Tensor("float32", window, [1, EMBED_WINDOW_FRAMES, MEL_BINS, 1]);
  const out = await sessions.embedding.run({ [sessions.names.embedding.input]: input });
  const tensor = out[sessions.names.embedding.output];
  // Output is [1, 1, 1, 96]; copy into a plain 96-d vector.
  return Float32Array.from(tensor.data as Float32Array);
}

// Runs the wake classifier over the last 16 embedding frames ([16, 96] flattened)
// and returns the scalar wake score in [0, 1].
export async function runWake(sessions: WakeSessions, features: Float32Array): Promise<number> {
  if (features.length !== WAKE_FEATURE_FRAMES * EMBED_DIM) {
    throw new Error(
      `wake features must be ${WAKE_FEATURE_FRAMES * EMBED_DIM} floats, got ${features.length}`,
    );
  }
  const input = new ort.Tensor("float32", features, [1, WAKE_FEATURE_FRAMES, EMBED_DIM]);
  const out = await sessions.wake.run({ [sessions.names.wake.input]: input });
  const tensor = out[sessions.names.wake.output];
  return (tensor.data as Float32Array)[0];
}
