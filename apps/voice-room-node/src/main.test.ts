import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { bootVoiceRoomNode, type VoiceRoomNode } from "./main.js";

// Everything the stub gateway observed, so tests can assert the connect
// handshake and the push-to-talk uplink.
type StubRecord = {
  connect: { caps: unknown; mode: unknown; role: unknown } | null;
  createParams: unknown;
  appendedAudio: string[];
  closedSessionId: unknown;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// A capture stub that streams non-empty PCM frames until stopped, so the
// push-to-talk pump has audio to forward while an utterance is held.
function fakeCapture() {
  let stopped = false;
  let stops = 0;
  const isStopped = (): boolean => stopped;
  async function* gen(): AsyncGenerator<Buffer> {
    let i = 0;
    while (!isStopped()) {
      // Two non-zero bytes so `sendPcm` never treats the frame as empty.
      yield Buffer.from([(i & 0xff) || 1, ((i >> 8) & 0xff) || 1]);
      i += 1;
      await delay(3);
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

// A playback stub that records the base64 TTS frames it was handed.
function fakePlayback() {
  let stops = 0;
  const enqueued: string[] = [];
  return {
    enqueue: (frameBase64: string): void => {
      enqueued.push(frameBase64);
    },
    stop: async (): Promise<void> => {
      stops += 1;
    },
    stopCount: (): number => stops,
    enqueued: (): string[] => enqueued,
  };
}

function rawDataToString(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
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

// Minimal gateway hello so the client resolves the connect. Large tick interval
// keeps the client's tick watchdog quiet for the duration of the test.
function helloOkPayload() {
  return {
    type: "hello-ok",
    protocol: 2,
    server: { version: "dev", connId: "c1" },
    features: { methods: [], events: [] },
    snapshot: {
      presence: [],
      health: {},
      stateVersion: { presence: 1, health: 1 },
      uptimeMs: 1,
    },
    policy: { maxPayload: 512 * 1024, maxBufferedBytes: 1024 * 1024, tickIntervalMs: 30_000 },
  };
}

// Base64 PCM16 the stub returns as the TTS reply for the push-to-talk test.
const TTS_REPLY_BASE64 = Buffer.from([9, 9, 9, 9]).toString("base64");

// Stub gateway that drives the real handshake and the talk-session RPCs: replies
// with hello-ok, hands out a session id on create, records appended audio (and
// answers the first append with a TTS reply event), and records close.
function startStubGateway(wss: WebSocketServer, record: StubRecord): void {
  wss.on("connection", (socket: WebSocket) => {
    socket.send(
      JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "test-nonce" } }),
    );
    let ttsSent = false;
    socket.on("message", (data) => {
      const frame = JSON.parse(rawDataToString(data)) as {
        id?: string;
        method?: string;
        params?: {
          caps?: unknown;
          client?: { mode?: unknown };
          role?: unknown;
          sessionId?: unknown;
          audioBase64?: unknown;
        };
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
        case "talk.session.create":
          record.createParams = frame.params;
          respond({ sessionId: "sess-1" });
          return;
        case "talk.session.appendAudio":
          if (typeof frame.params?.audioBase64 === "string") {
            record.appendedAudio.push(frame.params.audioBase64);
          }
          respond({ ok: true });
          if (!ttsSent) {
            ttsSent = true;
            socket.send(
              JSON.stringify({
                type: "event",
                event: "talk.event",
                payload: { type: "audio", audioBase64: TTS_REPLY_BASE64 },
              }),
            );
          }
          return;
        case "talk.session.close":
          record.closedSessionId = frame.params?.sessionId;
          respond({ ok: true });
          return;
        default:
          if (frame.method) {
            respond({ ok: true });
          }
      }
    });
  });
}

function newRecord(): StubRecord {
  return { connect: null, createParams: null, appendedAudio: [], closedSessionId: null };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await delay(5);
  }
}

let wss: WebSocketServer | null = null;
let node: VoiceRoomNode | null = null;

afterEach(async () => {
  if (node) {
    await node.shutdown();
    node = null;
  }
  if (wss) {
    await new Promise<void>((resolve) => {
      wss?.close(() => resolve());
    });
    wss = null;
  }
});

async function bootAgainstStub(record: StubRecord) {
  const port = await getFreePort();
  wss = new WebSocketServer({ port, host: "127.0.0.1" });
  startStubGateway(wss, record);

  const capture = fakeCapture();
  const playback = fakePlayback();

  // Missing config file + env override supplies the required gateway URL, so the
  // boot exercises the real config loader without touching the home-dir config.
  const env: NodeJS.ProcessEnv = {
    OPENCLAW_VOICE_ROOM_CONFIG: path.join(os.tmpdir(), "voice-room-node-nonexistent-config.json"),
    OPENCLAW_VOICE_ROOM_GATEWAY_URL: `ws://127.0.0.1:${port}`,
  };

  const booted = await bootVoiceRoomNode({
    env,
    startCapture: () => capture,
    startPlayback: () => playback,
  });
  node = booted;
  return { booted, capture, playback };
}

test("boots, connects, and registers a node advertising cap 'talk'", async () => {
  const record = newRecord();
  const { booted, capture, playback } = await bootAgainstStub(record);

  // A resolved node == the gateway acknowledged the connection.
  expect(record.connect).not.toBeNull();
  expect(record.connect?.caps).toEqual(["talk"]);
  expect(record.connect?.mode).toBe("node");
  expect(record.connect?.role).toBe("node");

  // No audio is streamed before a push-to-talk press.
  await delay(20);
  expect(record.appendedAudio).toHaveLength(0);

  // Shutdown stops both audio children exactly once.
  await booted.shutdown();
  node = null;
  expect(capture.stopCount()).toBe(1);
  expect(playback.stopCount()).toBe(1);
});

test("push-to-talk streams captured PCM and plays the TTS reply", async () => {
  const record = newRecord();
  const { booted, playback } = await bootAgainstStub(record);

  // Press: opens the talk session and starts streaming captured frames.
  await booted.startUtterance();
  await waitFor(() => record.appendedAudio.length >= 3);

  // Streamed frames reached the gateway as base64 appendAudio.
  expect(record.appendedAudio.length).toBeGreaterThanOrEqual(3);
  expect(record.createParams).toMatchObject({ mode: "realtime" });

  // The TTS reply the gateway pushed back was handed to playback.
  await waitFor(() => playback.enqueued().includes(TTS_REPLY_BASE64));
  expect(playback.enqueued()).toContain(TTS_REPLY_BASE64);

  // Release: streaming stops; no new audio is appended afterward.
  booted.endUtterance();
  const afterRelease = record.appendedAudio.length;
  await delay(30);
  expect(record.appendedAudio.length).toBe(afterRelease);

  await booted.shutdown();
  node = null;
  // The session opened for the utterance was closed on shutdown.
  expect(record.closedSessionId).toBe("sess-1");
});
