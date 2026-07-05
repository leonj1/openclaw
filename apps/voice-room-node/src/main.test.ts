import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { bootVoiceRoomNode, type VoiceRoomNode } from "./main.js";

// Records what the stub gateway saw during the connect handshake so the test
// can assert the booted node advertised cap "talk".
type StubConnect = {
  caps: unknown;
  mode: unknown;
  role: unknown;
};

// Minimal stoppable stub so the boot path never spawns real `arecord`/`aplay`.
function fakeStoppable() {
  let stops = 0;
  return {
    stop: async (): Promise<void> => {
      stops += 1;
    },
    stopCount: (): number => stops,
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

// Stub gateway that drives the real connect handshake: sends a connect
// challenge, records the connect params, and replies with hello-ok.
function startStubGateway(
  wss: WebSocketServer,
  onConnect: (connect: StubConnect) => void,
): void {
  wss.on("connection", (socket: WebSocket) => {
    socket.send(
      JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "test-nonce" } }),
    );
    socket.on("message", (data) => {
      const frame = JSON.parse(rawDataToString(data)) as {
        id?: string;
        method?: string;
        params?: { caps?: unknown; client?: { mode?: unknown }; role?: unknown };
      };
      if (frame.method !== "connect") {
        return;
      }
      onConnect({
        caps: frame.params?.caps,
        mode: frame.params?.client?.mode,
        role: frame.params?.role,
      });
      socket.send(JSON.stringify({ type: "res", id: frame.id ?? "connect", ok: true, payload: helloOkPayload() }));
    });
  });
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

test("boots, connects, and registers a node advertising cap 'talk'", async () => {
  const port = await getFreePort();
  wss = new WebSocketServer({ port, host: "127.0.0.1" });

  let seen: StubConnect | null = null;
  startStubGateway(wss, (connect) => {
    seen = connect;
  });

  const capture = fakeStoppable();
  const playback = fakeStoppable();

  // Missing config file + env override supplies the required gateway URL, so the
  // boot exercises the real config loader without touching the home-dir config.
  const env: NodeJS.ProcessEnv = {
    OPENCLAW_VOICE_ROOM_CONFIG: path.join(os.tmpdir(), "voice-room-node-nonexistent-config.json"),
    OPENCLAW_VOICE_ROOM_GATEWAY_URL: `ws://127.0.0.1:${port}`,
  };

  node = await bootVoiceRoomNode({
    env,
    startCapture: () => capture,
    startPlayback: () => playback,
  });

  // A resolved node == the gateway acknowledged the connection.
  expect(seen).not.toBeNull();
  const connect = seen as unknown as StubConnect;
  expect(connect.caps).toEqual(["talk"]);
  expect(connect.mode).toBe("node");
  expect(connect.role).toBe("node");

  // Shutdown stops both audio children exactly once.
  await node.shutdown();
  node = null;
  expect(capture.stopCount()).toBe(1);
  expect(playback.stopCount()).toBe(1);
});
