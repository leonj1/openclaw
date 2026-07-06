import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { connectToGateway, type GatewayTalkHandle } from "./connect.js";
import { parseNodeConfig, type NodeConfig } from "../config.js";

// Redirect the persisted device identity into a temp dir so the connect handshake
// (which loads/creates one) never touches the real ~/.openclaw home.
function tempIdentityEnv(): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-room-connect-"));
  return { OPENCLAW_VOICE_ROOM_DEVICE_IDENTITY: path.join(dir, "device-identity.json") };
}

// Records what the stub gateway saw during the connect handshake so the test
// can assert the node advertised cap "talk".
type StubConnect = {
  caps: unknown;
  mode: unknown;
  role: unknown;
  scopes: unknown;
};

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
        params?: { caps?: unknown; client?: { mode?: unknown }; role?: unknown; scopes?: unknown };
      };
      if (frame.method !== "connect") {
        return;
      }
      onConnect({
        caps: frame.params?.caps,
        mode: frame.params?.client?.mode,
        role: frame.params?.role,
        scopes: frame.params?.scopes,
      });
      socket.send(JSON.stringify({ type: "res", id: frame.id ?? "connect", ok: true, payload: helloOkPayload() }));
    });
  });
}

function nodeConfig(url: string): NodeConfig {
  const result = parseNodeConfig({ gateway: { url } });
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.config;
}

let wss: WebSocketServer | null = null;
let handle: GatewayTalkHandle | null = null;

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
  if (wss) {
    await new Promise<void>((resolve) => {
      wss?.close(() => resolve());
    });
    wss = null;
  }
});

test("connects as an operator authorized for the chat.* turn RPCs", async () => {
  const port = await getFreePort();
  wss = new WebSocketServer({ port, host: "127.0.0.1" });

  let seen: StubConnect | null = null;
  startStubGateway(wss, (connect) => {
    seen = connect;
  });

  handle = await connectToGateway({
    config: nodeConfig(`ws://127.0.0.1:${port}`),
    env: tempIdentityEnv(),
    connectTimeoutMs: 5_000,
  });

  // Resolved handle == the gateway acknowledged the connection.
  expect(handle.client).toBeDefined();
  expect(seen).not.toBeNull();
  const connect = seen as unknown as StubConnect;
  // Layer 2 drives operator RPCs (chat.send/agent.wait/chat.history), so the node
  // connects as an operator with the scopes those methods require — not role:node.
  expect(connect.mode).toBe("cli");
  expect(connect.role).toBe("operator");
  expect(connect.scopes).toEqual(["operator.read", "operator.write"]);
});
