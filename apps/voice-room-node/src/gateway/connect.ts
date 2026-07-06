// Gateway connection for the "Hey Jarvis" voice-room node.
//
// Connects to the OpenClaw gateway through the shared `@openclaw/gateway-client`
// and advertises the `talk` capability so the gateway routes talk to this node
// (matches gateway talk-node detection in src/gateway/server-talk-nodes.ts).
// Returns a small typed handle the later talk phase drives: stream captured PCM
// up, receive TTS audio frames back, and close the connection.
//
// Audio wire contract (both real gateway methods/events, not node-local names):
//   - Uplink PCM  -> `talk.session.appendAudio` RPC ({ sessionId, audioBase64 }).
//   - Downlink TTS -> `talk.event` events whose payload is `{ type: "audio",
//     audioBase64 }` (see src/gateway/talk-realtime-relay.ts).
// The talk-session lifecycle (create/turn/close) is owned by the talk phase via
// the exposed `client`; `setTalkSession` binds the active session id so
// `sendPcm` targets it.
import { GatewayClient } from "@openclaw/gateway-client";
import { GATEWAY_CLIENT_MODES } from "@openclaw/gateway-protocol/client-info";
import type { EventFrame } from "@openclaw/gateway-protocol";
import type { NodeConfig } from "../config.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  resolveDeviceIdentityPath,
  signDevicePayload,
} from "./device-identity.js";

// Capability advertised on connect. Must equal the gateway's talk-node
// detection string so this node is routed talk (server-talk-nodes.ts).
export const TALK_CAPABILITY = "talk";

// Gateway audio contract. TTS arrives as `talk.event` frames carrying an
// `audio` payload; captured PCM is appended to the active talk session.
const TALK_EVENT = "talk.event";
const TALK_OUTPUT_AUDIO_TYPE = "audio";
const TALK_APPEND_AUDIO_METHOD = "talk.session.appendAudio";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/** Receives one base64-encoded TTS PCM16 frame from the gateway. */
export type TtsFrameListener = (audioBase64: string) => void;

// Small typed handle over the connected client. The talk phase creates a talk
// session on `client`, binds it via `setTalkSession`, then streams with
// `sendPcm` and consumes replies via `onTtsFrame`.
export type GatewayTalkHandle = {
  // Connected gateway client; the talk phase drives talk.session.* RPCs on it.
  readonly client: GatewayClient;
  // Bind (or clear with null) the active talk session `sendPcm` appends to.
  setTalkSession(sessionId: string | null): void;
  // Stream one captured PCM16 frame (24kHz mono) to the active talk session.
  // No-op when no session is bound or the frame is empty.
  sendPcm(frame: Buffer): void;
  // Subscribe to base64 TTS audio frames; returns an unsubscribe function.
  onTtsFrame(listener: TtsFrameListener): () => void;
  // Close the gateway connection and stop the client.
  close(): Promise<void>;
};

export type ConnectToGatewayParams = {
  config: NodeConfig;
  // Environment carrying the auth token named by `config.gateway.tokenEnv`.
  env?: NodeJS.ProcessEnv;
  // How long to wait for the gateway hello before failing the connect.
  connectTimeoutMs?: number;
};

// Extracts a base64 TTS frame from a gateway event, or null when the event is
// not talk output audio. Keeps the payload read defensive since events cross a
// process boundary.
function readTtsAudioFrame(evt: EventFrame): string | null {
  if (evt.event !== TALK_EVENT) {
    return null;
  }
  const payload = evt.payload;
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as { type?: unknown; audioBase64?: unknown };
  if (record.type !== TALK_OUTPUT_AUDIO_TYPE || typeof record.audioBase64 !== "string") {
    return null;
  }
  return record.audioBase64;
}

/**
 * Connects to the gateway advertising cap `talk` and resolves a typed handle
 * once the gateway acknowledges the connection (hello). Rejects on connect
 * error or if the hello does not arrive within `connectTimeoutMs`.
 */
export async function connectToGateway(
  params: ConnectToGatewayParams,
): Promise<GatewayTalkHandle> {
  const env = params.env ?? process.env;
  const token = env[params.config.gateway.tokenEnv];
  const connectTimeoutMs = params.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  const ttsListeners = new Set<TtsFrameListener>();
  let talkSessionId: string | null = null;

  let settleConnect: (err?: Error) => void = () => {};
  // First hello resolves the connect; the first connect error (or timeout)
  // fails it. The client is stopped on failure below (after the await) so no
  // reconnect loop is left dangling.
  const connected = new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error(`gateway connect timed out after ${connectTimeoutMs}ms`));
    }, connectTimeoutMs);

    settleConnect = (err?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };
  });

  // Persisted signed device identity for the handshake; localhost silently pairs
  // a new one on first connect and it is reused across restarts.
  const deviceIdentity = loadOrCreateDeviceIdentity(resolveDeviceIdentityPath(env));

  const client = new GatewayClient({
    url: params.config.gateway.url,
    token: token || undefined,
    // Layer 2 drives OpenClaw through operator RPCs (chat.send/agent.wait/
    // chat.history), which reject role:"node" with "unauthorized role: node".
    // Connect as an operator: the shared gateway token authorizes it and lets a
    // local operator bypass device pairing (src/gateway/server/ws-connection/
    // connect-policy.ts). chat.send/agent.wait need `operator.write`,
    // chat.history needs `operator.read`.
    mode: GATEWAY_CLIENT_MODES.CLI,
    role: "operator",
    scopes: ["operator.read", "operator.write"],
    env,
    deviceIdentity,
    // Signing callbacks the handshake uses; encoding matches core exactly so the
    // gateway verifies our signature (see device-identity.ts).
    hostDeps: { signDevicePayload, publicKeyRawBase64UrlFromPem },
    onEvent: (evt) => {
      const frame = readTtsAudioFrame(evt);
      if (frame === null) {
        return;
      }
      for (const listener of ttsListeners) {
        listener(frame);
      }
    },
    onHelloOk: () => settleConnect(),
    onConnectError: (err) => settleConnect(err),
  });
  client.start();
  try {
    await connected;
  } catch (err) {
    // Failed connect (error or timeout): stop the client so its reconnect loop
    // does not keep running after we reject.
    client.stop();
    throw err;
  }

  return {
    client,
    setTalkSession(sessionId) {
      talkSessionId = sessionId;
    },
    sendPcm(frame) {
      if (talkSessionId === null || frame.length === 0) {
        return;
      }
      // Best-effort uplink: a dropped audio frame must never crash capture, so
      // rejects (transient socket state, missing session) are swallowed.
      void client
        .request(TALK_APPEND_AUDIO_METHOD, {
          sessionId: talkSessionId,
          audioBase64: frame.toString("base64"),
        })
        .catch(() => {});
    },
    onTtsFrame(listener) {
      ttsListeners.add(listener);
      return () => {
        ttsListeners.delete(listener);
      };
    },
    async close() {
      ttsListeners.clear();
      await client.stopAndWait();
    },
  };
}
