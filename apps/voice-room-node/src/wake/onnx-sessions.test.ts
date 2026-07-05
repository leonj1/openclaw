import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EMBED_DIM,
  EMBED_WINDOW_FRAMES,
  MEL_BINS,
  WAKE_FEATURE_FRAMES,
  defaultModelsDir,
  loadWakeSessions,
  runEmbedding,
  runMelspectrogram,
  runWake,
  type WakeSessions,
} from "./onnx-sessions.ts";

// These tests load the real openWakeWord ONNX artifacts. They are skipped (not
// failed) when the models are absent so a checkout without `fetch-models.sh` run
// still passes the rest of the suite.
const modelsDir = defaultModelsDir();
const haveModels = ["melspectrogram.onnx", "embedding_model.onnx", "hey_jarvis_v0.1.onnx"].every(
  (f) => fs.existsSync(`${modelsDir}/${f}`),
);
const describeModels = haveModels ? describe : describe.skip;

describeModels("wake onnx sessions", () => {
  let sessions: WakeSessions;

  it("loads all three sessions with the expected tensor names", async () => {
    sessions = await loadWakeSessions();
    expect(sessions.mel.inputNames).toEqual(["input"]);
    expect(sessions.mel.outputNames).toEqual(["output"]);
    expect(sessions.embedding.inputNames).toEqual(["input_1"]);
    expect(sessions.embedding.outputNames).toEqual(["conv2d_19"]);
    // The wake classifier's tensor names are opaque graph ids; bind by position.
    expect(sessions.wake.inputNames).toHaveLength(1);
    expect(sessions.wake.outputNames).toHaveLength(1);
  });

  it("mel model maps 1280 samples to 5 mel frames of 32 bins", async () => {
    const samples = new Float32Array(1280);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.sin(i / 8) * 1000;
    }
    const mel = await runMelspectrogram(sessions, samples);
    expect(mel.frames).toBe(5);
    expect(mel.data.length).toBe(5 * MEL_BINS);
  });

  it("embedding model maps a 76x32 mel window to a 96-d vector", async () => {
    const window = new Float32Array(EMBED_WINDOW_FRAMES * MEL_BINS).fill(2);
    const embedding = await runEmbedding(sessions, window);
    expect(embedding.length).toBe(EMBED_DIM);
  });

  it("wake model maps 16x96 features to a single score in [0,1]", async () => {
    const features = new Float32Array(WAKE_FEATURE_FRAMES * EMBED_DIM).fill(0);
    const score = await runWake(sessions, features);
    expect(typeof score).toBe("number");
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});
