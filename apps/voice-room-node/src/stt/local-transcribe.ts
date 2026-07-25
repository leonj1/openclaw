// Local speech-to-text via whisper (faster-whisper Python subprocess).
//
// Runs a long-lived Python child process that loads a Whisper model once
// and transcribes short audio clips on demand via a JSON-line protocol on
// stdin/stdout. This avoids ElevenLabs costs for wake-word verification.
//
// The subprocess is spawned at construction time and stays warm for the
// lifetime of the node. PCM audio is WAV-encoded and base64'd before being
// sent over stdin.

import { spawn, type ChildProcess } from "node:child_process";
import { encodeWav } from "../audio/wav.js";
import type { SttResult } from "../session/talk-node.js";

export interface LocalStt {
  transcribe(pcm: Buffer): Promise<SttResult>;
  close(): void;
}

export interface WhisperLocalSttParams {
  pythonPath: string;
  scriptPath: string;
  modelSize?: string;
  onReady?: () => void;
}

const SAMPLE_RATE = 24_000;
const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;

export class WhisperLocalStt implements LocalStt {
  private child: ChildProcess | null = null;
  private pending: Map<
    number,
    { resolve: (r: SttResult) => void; reject: (e: Error) => void }
  > = new Map();
  private nextId = 0;
  private buffer = "";
  private closed = false;
  private params: WhisperLocalSttParams;
  private readyPromise: Promise<void> | null = null;

  constructor(params: WhisperLocalSttParams) {
    this.params = params;
  }

  private ensureChild(): ChildProcess {
    if (this.closed) {
      throw new Error("whisper subprocess closed");
    }
    if (this.child) return this.child;

    this.child = spawn(this.params.pythonPath, ["-u", this.params.scriptPath], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env },
    });

    this.child.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        this.handleLine(line);
      }
    });

    this.child.on("exit", (code) => {
      if (!this.closed) {
        const msg = `whisper subprocess exited with code ${code}`;
        for (const [, p] of this.pending) {
          p.resolve({ ok: false, error: msg });
        }
        this.pending.clear();
      }
    });

    return this.child;
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    // Special first line: {"status":"ready"}
    if (trimmed.includes('"status":"ready"')) {
      // Clear the dummy pending entry
      for (const [id] of this.pending) {
        this.pending.delete(id);
      }
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== "object") return;

    const obj = parsed as Record<string, unknown>;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      if (obj.ok === true && typeof obj.text === "string") {
        p.resolve({ ok: true, text: obj.text });
      } else {
        p.resolve({
          ok: false,
          error: typeof obj.error === "string" ? obj.error : "whisper STT failed",
        });
      }
      return;
    }
  }

  async transcribe(pcm: Buffer): Promise<SttResult> {
    if (this.closed) {
      return { ok: false, error: "whisper subprocess closed" };
    }

    const child = this.ensureChild();

    const wav = encodeWav({
      sampleRate: SAMPLE_RATE,
      bitsPerSample: BITS_PER_SAMPLE,
      channels: CHANNELS,
      pcm,
    });

    const id = this.nextId++;
    return new Promise<SttResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        child.stdin!.write(
          JSON.stringify({ id, wav: wav.toString("base64") }) + "\n",
        );
      } catch (err) {
        this.pending.delete(id);
        resolve({
          ok: false,
          error: `whisper stdin write failed: ${errorText(err)}`,
        });
      }
    });
  }

  close(): void {
    this.closed = true;
    if (this.child) {
      try {
        this.child.stdin?.end();
      } catch {
        // ignore
      }
      this.child.kill();
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
