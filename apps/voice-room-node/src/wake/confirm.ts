// Secondary wake-word verification: short clip → STT → local LLM → decide.
//
// After the ONNX detector fires, a short audio clip is captured, transcribed
// via the existing STT pipeline, and confirmed by a local ollama judge. This
// eliminates ONNX false positives before the expensive full-turn pipeline
// starts.
//
// Fail-open rule: if STT or the judge fails, the wake is accepted (proceed
// with the turn) so a stuck or missing ollama never bricks the device.
// A rejection only happens when the judge explicitly returns "NO".

import type { OllamaJudge } from "../llm/ollama-judge.ts";
import type { SttResult } from "../session/talk-node.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WakeConfirmResult =
  | { accepted: true; clipPcm: Buffer }
  | { accepted: false };

export interface WakeWordConfirmation {
  confirm(frames: AsyncIterableIterator<Buffer>): Promise<WakeConfirmResult>;
}

export interface WakeWordConfirmationParams {
  transcribe: (pcm: Buffer) => Promise<SttResult>;
  judge: OllamaJudge;
  log: (line: string) => void;
  enabled: boolean;
  clipMs: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

// Bytes per millisecond for PCM16 24kHz mono: 24_000 samples/s × 2 bytes × 1 channel.
const BYTES_PER_MS = 48;

export class LlmWakeWordConfirmation implements WakeWordConfirmation {
  private readonly transcribe: (pcm: Buffer) => Promise<SttResult>;
  private readonly judge: OllamaJudge;
  private readonly log: (line: string) => void;
  private readonly enabled: boolean;
  private readonly clipBytes: number;

  constructor(params: WakeWordConfirmationParams) {
    this.transcribe = params.transcribe;
    this.judge = params.judge;
    this.log = params.log;
    this.enabled = params.enabled;
    this.clipBytes = params.clipMs * BYTES_PER_MS;
  }

  async confirm(frames: AsyncIterableIterator<Buffer>): Promise<WakeConfirmResult> {
    if (!this.enabled) {
      return { accepted: true, clipPcm: Buffer.alloc(0) };
    }

    const clipPcm = await this.captureClip(frames);

    const stt = await this.transcribeSilently(clipPcm);
    if (stt === null) {
      return { accepted: true, clipPcm };
    }

    const judgeResult = await this.judge.judge(stt);
    if (!judgeResult.ok) {
      this.log(`wake-verify: judge error: ${judgeResult.error} (fail-open, accepting)`);
      return { accepted: true, clipPcm };
    }

    if (judgeResult.value === "YES") {
      return { accepted: true, clipPcm };
    }

    this.log(`wake-verify: judge rejected transcript="${stt}"`);
    return { accepted: false };
  }

  // Collects frames until at least clipBytes of audio have been buffered.
  private async captureClip(frames: AsyncIterableIterator<Buffer>): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const frame of frames) {
      chunks.push(frame);
      total += frame.length;
      if (total >= this.clipBytes) {
        break;
      }
    }
    return Buffer.concat(chunks);
  }

  // Transcribes the clip. On failure returns null so the caller fails open.
  private async transcribeSilently(pcm: Buffer): Promise<string | null> {
    if (pcm.length === 0) {
      this.log("wake-verify: empty clip, failing open (accepting)");
      return null;
    }
    const result = await this.transcribe(pcm);
    if (!result.ok) {
      this.log(`wake-verify: STT error: ${result.error} (fail-open, accepting)`);
      return null;
    }
    return result.text;
  }
}
