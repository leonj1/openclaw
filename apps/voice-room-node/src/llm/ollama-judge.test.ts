import { describe, expect, it } from "vitest";
import {
  type FetchLike,
  type HttpResponseLike,
  type JudgeResult,
  type OllamaJudge,
  HttpOllamaJudge,
} from "./ollama-judge.ts";

// ---------------------------------------------------------------------------
// Fake OllamaJudge factory — configurable for tests that consume OllamaJudge
// ---------------------------------------------------------------------------

export interface FakeOllamaJudgeState {
  calls: string[];
  response: JudgeResult;
}

export function fakeOllamaJudge(response: JudgeResult): OllamaJudge & FakeOllamaJudgeState {
  const state: FakeOllamaJudgeState = { calls: [], response };
  return {
    get calls() {
      return state.calls;
    },
    get response() {
      return state.response;
    },
    set response(r: JudgeResult) {
      state.response = r;
    },
    async judge(transcript: string): Promise<JudgeResult> {
      state.calls.push(transcript);
      return state.response;
    },
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function okResponse(body: unknown): HttpResponseLike {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function makeJudge(
  overrides: { baseUrl?: string; model?: string; timeoutMs?: number; fetchFn?: FetchLike } = {},
): HttpOllamaJudge {
  return new HttpOllamaJudge({
    baseUrl: overrides.baseUrl ?? "http://localhost:11434",
    model: overrides.model ?? "llama3.2:3b",
    timeoutMs: overrides.timeoutMs ?? 800,
    fetchFn: overrides.fetchFn,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HttpOllamaJudge", () => {
  describe("successful responses", () => {
    it("returns YES when ollama response starts with YES", async () => {
      let seenUrl = "";
      let seenBody: string | undefined;
      const fetchFn: FetchLike = async (url, init) => {
        seenUrl = url;
        seenBody = init.body;
        return okResponse({ response: "YES" });
      };

      const judge = makeJudge({ fetchFn });
      const result = await judge.judge("hey jarvis what time is it");

      expect(result).toEqual({ ok: true, value: "YES" });
      expect(seenUrl).toBe("http://localhost:11434/api/generate");
      const parsed = JSON.parse(seenBody!);
      expect(parsed.model).toBe("llama3.2:3b");
      expect(parsed.stream).toBe(false);
      expect(parsed.prompt).toContain("hey jarvis what time is it");
      expect(parsed.prompt).toContain("YES or NO");
    });

    it("returns NO when ollama response does not start with YES", async () => {
      const fetchFn: FetchLike = async () => okResponse({ response: "no, that is not present" });
      const judge = makeJudge({ fetchFn });
      const result = await judge.judge("random noise");
      expect(result).toEqual({ ok: true, value: "NO" });
    });

    it("strips trailing slash from baseUrl", async () => {
      let seenUrl = "";
      const fetchFn: FetchLike = async (url) => {
        seenUrl = url;
        return okResponse({ response: "YES" });
      };
      const judge = makeJudge({ baseUrl: "http://localhost:11434/", fetchFn });
      await judge.judge("test");
      expect(seenUrl).toBe("http://localhost:11434/api/generate");
    });

    it("sends Content-Type application/json header", async () => {
      let seenHeaders: Record<string, string> = {};
      const fetchFn: FetchLike = async (_url, init) => {
        seenHeaders = init.headers;
        return okResponse({ response: "YES" });
      };
      const judge = makeJudge({ fetchFn });
      await judge.judge("test");
      expect(seenHeaders["Content-Type"]).toBe("application/json");
    });
  });

  describe("error responses", () => {
    it("returns error on non-200 status", async () => {
      const fetchFn: FetchLike = async () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => "internal error",
      });
      const judge = makeJudge({ fetchFn });
      const result = await judge.judge("test");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("500");
      }
    });

    it("returns error on 204 (non-200 2xx)", async () => {
      const fetchFn: FetchLike = async () => ({
        ok: true,
        status: 204,
        json: async () => ({}),
        text: async () => "",
      });
      const judge = makeJudge({ fetchFn });
      const result = await judge.judge("test");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("204");
      }
    });

    it("returns error on network failure", async () => {
      const fetchFn: FetchLike = async () => {
        throw new Error("connection refused");
      };
      const judge = makeJudge({ fetchFn });
      const result = await judge.judge("test");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("connection refused");
      }
    });

    it("returns error when response body is not valid JSON", async () => {
      const fetchFn: FetchLike = async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("parse error");
        },
        text: async () => "not json",
      });
      const judge = makeJudge({ fetchFn });
      const result = await judge.judge("test");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("invalid JSON");
      }
    });

    it("returns error when JSON response lacks a 'response' field", async () => {
      const fetchFn: FetchLike = async () => okResponse({ model: "llama3.2" });
      const judge = makeJudge({ fetchFn });
      const result = await judge.judge("test");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("missing");
      }
    });
  });

  describe("timeout", () => {
    it("returns error when the request exceeds the timeout", async () => {
      // A stub fetch that respects the AbortSignal: when aborted, it throws
      // an AbortError-like DOMException.
      const judge = new HttpOllamaJudge({
        baseUrl: "http://localhost:11434",
        model: "llama3.2:3b",
        timeoutMs: 10,
        fetchFn: (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => {
              const err = new DOMException("The operation was aborted", "AbortError");
              reject(err);
            });
          }),
      });

      const result = await judge.judge("test");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("timed out");
      }
    }, 500);
  });
});
