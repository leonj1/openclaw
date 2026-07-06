// Utterance endpointing for the Layer 2 turn.
//
// After a wake, the follow-up speech is captured frame by frame. This buffers
// the PCM utterance and decides when the speaker has finished: it resolves when
// trailing silence exceeds `silenceMs`, or when the utterance reaches the
// `maxUtteranceMs` cap so a stuck/never-quiet stream still endpoints.
//
// Silence is a simple RMS energy gate on PCM16 frames — enough to detect a gap
// after speech on a near-field mic, without a VAD dependency.
import { BYTES_PER_SAMPLE, CAPTURE_SAMPLE_RATE } from "./capture.js";

export interface EndpointOptions {
  // Trailing silence (ms) that ends the utterance once speech has started.
  silenceMs: number;
  // Hard cap (ms): resolve even if the speaker never pauses.
  maxUtteranceMs: number;
  // RMS threshold (0..1 of full scale) below which a frame counts as silence.
  // Tuned for a near-field USB speakerphone; injectable for tests.
  silenceRms?: number;
}

// Why the utterance ended — callers may treat a cap hit differently (e.g. warn).
export type EndpointReason = "silence" | "max";

export interface EndpointResult {
  // Concatenated PCM16 24kHz mono utterance audio (leading silence trimmed off).
  pcm: Buffer;
  reason: EndpointReason;
  durationMs: number;
}

// Default gate: -40 dBFS. Below this a frame is treated as silence.
const DEFAULT_SILENCE_RMS = 0.01;

// Mean-square energy of a PCM16 frame as a fraction of full scale (0..1).
export function frameRms(frame: Buffer): number {
  const samples = Math.floor(frame.length / BYTES_PER_SAMPLE);
  if (samples === 0) {
    return 0;
  }
  let sumSquares = 0;
  for (let i = 0; i < samples; i++) {
    const sample = frame.readInt16LE(i * BYTES_PER_SAMPLE) / 32768;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / samples);
}

function frameDurationMs(frame: Buffer): number {
  const samples = Math.floor(frame.length / BYTES_PER_SAMPLE);
  return (samples / CAPTURE_SAMPLE_RATE) * 1000;
}

// Consumes capture frames and resolves the buffered utterance once the speaker
// stops (trailing silence) or the max-duration cap is hit. Leading silence
// before the first voiced frame is discarded so the transcript is not padded.
export async function endpointUtterance(
  frames: AsyncIterable<Buffer>,
  options: EndpointOptions,
): Promise<EndpointResult> {
  const silenceRms = options.silenceRms ?? DEFAULT_SILENCE_RMS;
  const voiced: Buffer[] = [];
  let started = false;
  let totalMs = 0;
  let trailingSilenceMs = 0;

  for await (const frame of frames) {
    const durationMs = frameDurationMs(frame);
    const isSilent = frameRms(frame) < silenceRms;

    if (!started) {
      // Drop leading silence; the utterance begins at the first voiced frame.
      if (isSilent) {
        continue;
      }
      started = true;
    }

    voiced.push(frame);
    totalMs += durationMs;
    trailingSilenceMs = isSilent ? trailingSilenceMs + durationMs : 0;

    if (trailingSilenceMs >= options.silenceMs) {
      return { pcm: Buffer.concat(voiced), reason: "silence", durationMs: totalMs };
    }
    if (totalMs >= options.maxUtteranceMs) {
      return { pcm: Buffer.concat(voiced), reason: "max", durationMs: totalMs };
    }
  }

  // Capture ended (EOF/stop) before an explicit boundary: return what we have.
  return { pcm: Buffer.concat(voiced), reason: "silence", durationMs: totalMs };
}
