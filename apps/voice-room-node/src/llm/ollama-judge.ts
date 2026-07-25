// On-device wake-word verification via a local LLM (ollama).
//
// After the ONNX wake-word detector fires, the captured audio is transcribed
// and the resulting text is sent to a local ollama instance for secondary
// confirmation. This module isolates the ollama HTTP boundary behind an
// interface so consumers are never coupled to ollama's REST contract.
//
// The HTTP client is injectable for tests; the default is global fetch.
// AbortController enforces a configurable timeout so a slow/missing ollama
// never blocks the wake loop indefinitely.

export interface HttpResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<HttpResponseLike>;

export type JudgeResult =
  | { ok: true; value: "YES" | "NO" }
  | { ok: false; error: string };

export interface OllamaJudge {
  judge(transcript: string): Promise<JudgeResult>;
}

export interface HttpOllamaJudgeParams {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  fetchFn?: FetchLike;
}

const PROMPT = (
  transcript: string,
) => `You are a wake-word verifier. The following text is a transcript of audio that a wake-word detector flagged as containing the phrase "Hey Jarvis". Respond with exactly one word, YES or NO: YES if the transcript actually contains someone saying "Hey Jarvis" (allowing for minor STT transcription errors or homophones), NO otherwise.

Transcript: "${transcript}"

Answer (YES or NO only):`;

export class HttpOllamaJudge implements OllamaJudge {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchLike;

  constructor(params: HttpOllamaJudgeParams) {
    this.baseUrl = params.baseUrl.replace(/\/+$/, "");
    this.model = params.model;
    this.timeoutMs = params.timeoutMs;
    this.fetchFn = params.fetchFn ?? (globalThis.fetch as unknown as FetchLike);
  }

  async judge(transcript: string): Promise<JudgeResult> {
    const prompt = PROMPT(transcript);
    const url = `${this.baseUrl}/api/generate`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: HttpResponseLike;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt, stream: false }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof DOMException && err.name === "AbortError") {
        return { ok: false, error: `ollama judge timed out after ${this.timeoutMs}ms` };
      }
      return { ok: false, error: `ollama judge request failed: ${errorText(err)}` };
    } finally {
      clearTimeout(timer);
    }

    if (response.status !== 200) {
      const detail = await response.text().catch(() => "");
      return {
        ok: false,
        error: `ollama judge failed (${response.status}): ${detail.slice(0, 200)}`,
      };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (err) {
      return { ok: false, error: `ollama judge returned invalid JSON: ${errorText(err)}` };
    }

    const raw =
      payload && typeof payload === "object" && typeof (payload as { response?: unknown }).response === "string"
        ? (payload as { response: string }).response
        : "";
    if (!raw) {
      return { ok: false, error: "ollama judge response missing 'response' field" };
    }

    const upper = raw.trim().toUpperCase();
    if (upper.startsWith("YES")) {
      return { ok: true, value: "YES" };
    }
    return { ok: true, value: "NO" };
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
