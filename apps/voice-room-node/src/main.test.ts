import { createServer } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { bootVoiceRoomNode, type VoiceRoomNode } from "./main.js";
import { BREVITY_PREAMBLE } from "./agent/brevity.js";

// Everything the stub gateway observed, so tests can assert the connect
// handshake (cap "talk") and the Layer 2 turn RPCs (chat.send/agent.wait).
type StubRecord = {
  connect: { caps: unknown; mode: unknown; role: unknown } | null;
  chatSendMessage: string | null;
  agentWaitRunId: unknown;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const FRAME_SAMPLES = (24_000 * 20) / 1000; // 20ms PCM16 frame
function pcmFrame(amplitude: number): Buffer {
  const buf = Buffer.alloc(FRAME_SAMPLES * 2);
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    buf.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
  }
  return buf;
}

// The single frame the stub detector treats as "hey jarvis".
const WAKE_FRAME = pcmFrame(1);

// Capture stub: emits the wake frame, then a speech-then-silence utterance, then
// idles on silence until stopped, so the endpointer can resolve and the pump
// keeps running.
function fakeCapture() {
  let stopped = false;
  let stops = 0;
  async function* gen(): AsyncGenerator<Buffer> {
    yield WAKE_FRAME;
    for (let i = 0; i < 10 && !stopped; i++) {
      yield pcmFrame(8000); // 200ms of speech
      await delay(1);
    }
    while (!stopped) {
      yield pcmFrame(0); // trailing silence -> endpoint, then idle
      await delay(2);
    }
  }
  return {
    frames: (): AsyncGenerator<Buffer> => gen(),
    stop: async (): Promise<void> => {
      stopped = true;
      stops += 1;
    },
    stopCount: (): number => stops,
  };
}

// Capture stub that emits a little silence, then ENDS on its own — the
// arecord-died case (a USB mic re-enumerating throws "No such device", so
// arecord exits and its frame iterator completes). No wake fires.
function fakeCaptureThatEnds() {
  let stops = 0;
  async function* gen(): AsyncGenerator<Buffer> {
    for (let i = 0; i < 3; i++) {
      yield pcmFrame(0);
      await delay(1);
    }
    // arecord exited: stdout EOF -> the frames iterator ends here.
  }
  return {
    frames: (): AsyncGenerator<Buffer> => gen(),
    stop: async (): Promise<void> => {
      stops += 1;
    },
    stopCount: (): number => stops,
  };
}

// Playback stub: records enqueued TTS frames; satisfies the PlaybackHandle shape.
function fakePlayback() {
  let stops = 0;
  const enqueued: string[] = [];
  return {
    enqueue: (frameBase64: string): void => {
      enqueued.push(frameBase64);
    },
    pendingFrames: (): number => 0,
    drained: async (): Promise<void> => {},
    stop: async (): Promise<void> => {
      stops += 1;
    },
    stopCount: (): number => stops,
    enqueued: (): string[] => enqueued,
  };
}

// Detector stub: fires one wake on the WAKE_FRAME, nothing otherwise.
function fakeDetector() {
  return {
    process: async (frame: Buffer): Promise<{ score: number; ts: number } | null> =>
      frame.equals(WAKE_FRAME) ? { score: 0.9, ts: 1 } : null,
  };
}

function rawDataToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return String(data);
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("no port")));
      }
    });
  });
}

function helloOkPayload() {
  return {
    type: "hello-ok",
    protocol: 2,
    server: { version: "dev", connId: "c1" },
    features: { methods: [], events: [] },
    snapshot: { presence: [], health: {}, stateVersion: { presence: 1, health: 1 }, uptimeMs: 1 },
    policy: { maxPayload: 512 * 1024, maxBufferedBytes: 1024 * 1024, tickIntervalMs: 30_000 },
  };
}

// Stub gateway: drives the real handshake, then answers the Layer 2 turn RPCs
// per the verified contract (chat.send -> runId, agent.wait -> ok, chat.history
// -> assistant text).
function startStubGateway(wss: WebSocketServer, record: StubRecord): void {
  wss.on("connection", (socket: WebSocket) => {
    socket.send(
      JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "test-nonce" } }),
    );
    socket.on("message", (data) => {
      const frame = JSON.parse(rawDataToString(data)) as {
        id?: string;
        method?: string;
        params?: Record<string, unknown> & { client?: { mode?: unknown } };
      };
      const id = frame.id ?? frame.method ?? "req";
      const respond = (payload: unknown): void => {
        socket.send(JSON.stringify({ type: "res", id, ok: true, payload }));
      };
      switch (frame.method) {
        case "connect":
          record.connect = {
            caps: frame.params?.caps,
            mode: frame.params?.client?.mode,
            role: frame.params?.role,
          };
          respond(helloOkPayload());
          return;
        case "chat.send":
          record.chatSendMessage = String(frame.params?.message ?? "");
          respond({ runId: frame.params?.idempotencyKey, status: "in_flight" });
          return;
        case "agent.wait":
          record.agentWaitRunId = frame.params?.runId;
          respond({ runId: frame.params?.runId, status: "ok" });
          return;
        case "chat.history":
          respond({
            messages: [
              { role: "user", content: [{ type: "text", text: "what's the date" }] },
              { role: "assistant", content: [{ type: "text", text: "It is Sunday." }] },
            ],
          });
          return;
        default:
          if (frame.method) respond({ ok: true });
      }
    });
  });
}

function newRecord(): StubRecord {
  return { connect: null, chatSendMessage: null, agentWaitRunId: null };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await delay(5);
  }
}

let wss: WebSocketServer | null = null;
let node: VoiceRoomNode | null = null;
const tmpFiles: string[] = [];

afterEach(async () => {
  if (node) {
    await node.shutdown();
    node = null;
  }
  if (wss) {
    await new Promise<void>((resolve) => wss?.close(() => resolve()));
    wss = null;
  }
  for (const f of tmpFiles.splice(0)) fs.rmSync(f, { force: true });
});

async function bootAgainstStub(record: StubRecord, ttsFrames: string[]) {
  const port = await getFreePort();
  wss = new WebSocketServer({ port, host: "127.0.0.1" });
  startStubGateway(wss, record);

  // Temp config: small silence gate so the utterance endpoints quickly in-test.
  const configPath = path.join(os.tmpdir(), `voice-room-node-${port}.json`);
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      gateway: { url: `ws://127.0.0.1:${port}` },
      endpointing: { silenceMs: 60, maxUtteranceMs: 5_000 },
    }),
  );
  tmpFiles.push(configPath);

  const capture = fakeCapture();
  const playback = fakePlayback();
  const env: NodeJS.ProcessEnv = { OPENCLAW_VOICE_ROOM_CONFIG: configPath };

  const booted = await bootVoiceRoomNode({
    env,
    startCapture: () => capture,
    startPlayback: () => playback,
    createDetector: async () => fakeDetector(),
    makeWaitLoop: () => ({ start: () => {}, stop: async () => {} }),
    transcribe: async () => ({ ok: true, text: "what's the date" }),
    synthesize: async () => ({ ok: true, frames: ttsFrames }),
  });
  node = booted;
  return { booted, capture, playback };
}

test("connects as an operator (for the chat.* turn RPCs)", async () => {
  const record = newRecord();
  await bootAgainstStub(record, ["TTS"]);

  expect(record.connect).not.toBeNull();
  expect(record.connect?.role).toBe("operator");
});

test("refuses to boot (never listens) when the ElevenLabs TTS preflight fails", async () => {
  // No fallback: a plan-blocked / bad-key TTS must abort boot before the wake
  // detector, capture, or gateway are ever opened.
  const configPath = path.join(os.tmpdir(), `voice-room-node-ttsfail-${Date.now()}.json`);
  fs.writeFileSync(configPath, JSON.stringify({ gateway: { url: "ws://127.0.0.1:1" } }));
  tmpFiles.push(configPath);

  const capture = fakeCapture();
  await expect(
    bootVoiceRoomNode({
      env: { OPENCLAW_VOICE_ROOM_CONFIG: configPath },
      startCapture: () => capture,
      startPlayback: () => fakePlayback(),
      createDetector: async () => fakeDetector(),
      makeWaitLoop: () => ({ start: () => {}, stop: async () => {} }),
      transcribe: async () => ({ ok: true, text: "x" }),
      synthesize: async () => ({ ok: false, error: "401 subscription_required" }),
    }),
  ).rejects.toThrow(/TTS preflight failed/);
  // Fail-closed happened before any capture was opened.
  expect(capture.stopCount()).toBe(0);
});

test("exits for restart when mic capture ends unexpectedly (arecord died)", async () => {
  // A dropped mic (arecord dies mid-run) must be fatal, not silent: `done`
  // rejects so the entry point exits non-zero and systemd (Restart=always)
  // relaunches the node with a fresh arecord, instead of lingering deaf.
  const record = newRecord();
  const port = await getFreePort();
  wss = new WebSocketServer({ port, host: "127.0.0.1" });
  startStubGateway(wss, record);

  const configPath = path.join(os.tmpdir(), `voice-room-node-capend-${port}.json`);
  fs.writeFileSync(configPath, JSON.stringify({ gateway: { url: `ws://127.0.0.1:${port}` } }));
  tmpFiles.push(configPath);

  const capture = fakeCaptureThatEnds();
  const booted = await bootVoiceRoomNode({
    env: { OPENCLAW_VOICE_ROOM_CONFIG: configPath },
    startCapture: () => capture,
    startPlayback: () => fakePlayback(),
    createDetector: async () => fakeDetector(),
    makeWaitLoop: () => ({ start: () => {}, stop: async () => {} }),
    transcribe: async () => ({ ok: true, text: "x" }),
    synthesize: async () => ({ ok: true, frames: ["TTS"] }),
  });
  node = booted;

  await expect(booted.done).rejects.toThrow(/capture ended/i);
});

test("runs exactly one talk turn per wake: chat.send carries the brevity prepend and TTS plays", async () => {
  const record = newRecord();
  const { booted, playback } = await bootAgainstStub(record, ["TTSFRAME1", "TTSFRAME2"]);

  // Wake -> turn -> the spoken reply reaches playback.
  await waitFor(() => playback.enqueued().length >= 2);

  // The prepended brevity message reached chat.send with the transcript verbatim.
  expect(record.chatSendMessage).not.toBeNull();
  expect(record.chatSendMessage?.startsWith(BREVITY_PREAMBLE)).toBe(true);
  expect(record.chatSendMessage?.endsWith("what's the date")).toBe(true);
  // agent.wait was called for the run.
  expect(typeof record.agentWaitRunId).toBe("string");
  // TTS frames were enqueued to playback in order.
  expect(playback.enqueued()).toEqual(["TTSFRAME1", "TTSFRAME2"]);

  // Turn finished -> back to idle.
  await waitFor(() => booted.state() === "idle");
  expect(booted.state()).toBe("idle");
});
