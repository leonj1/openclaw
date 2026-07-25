import { describe, expect, it } from "vitest";
import {
  type WakeConfirmResult,
  type WakeWordConfirmation,
  LlmWakeWordConfirmation,
} from "./confirm.ts";
import type { OllamaJudge } from "../llm/ollama-judge.ts";
import { fakeOllamaJudge } from "../llm/ollama-judge.test.ts";

// ---------------------------------------------------------------------------
// Fake WakeWordConfirmation factory
// ---------------------------------------------------------------------------

export interface FakeWakeWordConfirmationState {
  calls: number;
  lastFrames: Buffer | null;
  response: WakeConfirmResult;
}

export function fakeWakeWordConfirmation(
  response: WakeConfirmResult,
): WakeWordConfirmation & FakeWakeWordConfirmationState {
  const state: FakeWakeWordConfirmationState = {
    calls: 0,
    lastFrames: null,
    response,
  };
  return {
    get calls() {
      return state.calls;
    },
    get lastFrames() {
      return state.lastFrames;
    },
    set response(r: WakeConfirmResult) {
      state.response = r;
    },
    async confirm(frames: AsyncIterableIterator<Buffer>): Promise<WakeConfirmResult> {
      state.calls++;
      const chunks: Buffer[] = [];
      for await (const frame of frames) {
        chunks.push(frame);
      }
      state.lastFrames = Buffer.concat(chunks);
      return state.response;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* frameGenerator(frames: Buffer[]): AsyncIterableIterator<Buffer> {
  for (const frame of frames) {
    yield frame;
  }
}

// Each frame is 48 bytes = 1ms of PCM16 24kHz mono audio.
function frame(): Buffer {
  return Buffer.alloc(48, 0x01);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LlmWakeWordConfirmation", () => {
  it("returns accepted with empty clipPcm when disabled", async () => {
    const judge = fakeOllamaJudge({ ok: true, value: "YES" });
    const logLines: string[] = [];
    const transcribe = async () => {
      throw new Error("should not be called");
    };

    const confirm = new LlmWakeWordConfirmation({
      transcribe,
      judge,
      log: (line) => logLines.push(line),
      enabled: false,
      clipMs: 1200,
    });

    const result = await confirm.confirm(frameGenerator([]));
    expect(result).toEqual({ accepted: true, clipPcm: Buffer.alloc(0) });
    expect(logLines).toHaveLength(0);
  });

  describe("when judge returns YES", () => {
    it("accepts and returns the clip PCM", async () => {
      const judge = fakeOllamaJudge({ ok: true, value: "YES" });
      const logLines: string[] = [];
      let transcribedPcm: Buffer | undefined;
      const transcribe = async (pcm: Buffer) => {
        transcribedPcm = pcm;
        return { ok: true, text: "hey jarvis what time is it" };
      };

      const confirm = new LlmWakeWordConfirmation({
        transcribe,
        judge,
        log: (line) => logLines.push(line),
        enabled: true,
        clipMs: 10,
      });

      const frames = [frame(), frame(), frame()]; // 3ms worth
      const result = await confirm.confirm(frameGenerator(frames));

      expect(result.accepted).toBe(true);
      if (!result.accepted) throw new Error("expected accepted");
      expect(result.clipPcm.length).toBe(48 * 3);
      expect(transcribedPcm).toEqual(Buffer.concat(frames));
      expect(judge.calls).toHaveLength(1);
      expect(judge.calls[0]).toBe("hey jarvis what time is it");
    });
  });

  describe("when judge returns NO", () => {
    it("rejects the wake", async () => {
      const judge = fakeOllamaJudge({ ok: true, value: "NO" });
      const logLines: string[] = [];
      const transcribe = async () => ({ ok: true, text: "hello world" } as const);

      const confirm = new LlmWakeWordConfirmation({
        transcribe,
        judge,
        log: (line) => logLines.push(line),
        enabled: true,
        clipMs: 10,
      });

      const result = await confirm.confirm(frameGenerator([frame()]));
      expect(result).toEqual({ accepted: false });
      expect(logLines.some((l) => l.includes("rejected"))).toBe(true);
    });
  });

  describe("fail-open: judge error", () => {
    it("accepts when the judge returns an error", async () => {
      const judge = fakeOllamaJudge({ ok: false, error: "connection refused" });
      const logLines: string[] = [];
      const transcribe = async () => ({ ok: true, text: "hey jarvis" } as const);

      const confirm = new LlmWakeWordConfirmation({
        transcribe,
        judge,
        log: (line) => logLines.push(line),
        enabled: true,
        clipMs: 10,
      });

      const result = await confirm.confirm(frameGenerator([frame()]));
      expect(result.accepted).toBe(true);
      if (!result.accepted) throw new Error("expected accepted");
      expect(result.clipPcm.length).toBe(48);
      expect(logLines.some((l) => l.includes("judge error"))).toBe(true);
      expect(logLines.some((l) => l.includes("fail-open"))).toBe(true);
    });
  });

  describe("fail-open: STT error", () => {
    it("accepts when transcription fails", async () => {
      const judge = fakeOllamaJudge({ ok: true, value: "YES" });
      const logLines: string[] = [];
      const transcribe = async () => ({ ok: false, error: "network error" } as const);

      const confirm = new LlmWakeWordConfirmation({
        transcribe,
        judge,
        log: (line) => logLines.push(line),
        enabled: true,
        clipMs: 10,
      });

      const result = await confirm.confirm(frameGenerator([frame()]));
      expect(result.accepted).toBe(true);
      expect(judge.calls).toHaveLength(0); // judge never called
      expect(logLines.some((l) => l.includes("STT error"))).toBe(true);
    });
  });

  describe("fail-open: empty clip", () => {
    it("accepts when no frames are captured", async () => {
      const judge = fakeOllamaJudge({ ok: true, value: "YES" });
      const logLines: string[] = [];
      let transcribeCalled = false;
      const transcribe = async () => {
        transcribeCalled = true;
        return { ok: true, text: "unused" } as const;
      };

      const confirm = new LlmWakeWordConfirmation({
        transcribe,
        judge,
        log: (line) => logLines.push(line),
        enabled: true,
        clipMs: 10,
      });

      const result = await confirm.confirm(frameGenerator([]));
      expect(result.accepted).toBe(true);
      expect(transcribeCalled).toBe(false);
    });
  });
});
