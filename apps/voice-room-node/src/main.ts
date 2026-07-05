// Boot path for the "Hey Jarvis" voice-room device node.
//
// Loads the node config, opens mic capture and TTS playback, and connects to
// the gateway advertising cap "talk". A single SIGTERM handler tears all three
// down together — the capture/playback children's own signal handlers are
// disabled here so shutdown is coordinated from one place instead of three
// racing handlers.
//
// Manual push-to-talk: this node has no keyboard, so one utterance is bracketed
// by two signals (SIGUSR1 = press/start, SIGUSR2 = release/end) or, in tests, by
// the `startUtterance`/`endUtterance` methods. On the first press a talk session
// is opened on the gateway and captured PCM frames start streaming up; TTS reply
// frames flow back into playback. This is a precursor to the Phase-2 wake-word
// state machine (src/session/talk-node.ts), which will own the real
// wake -> session lifecycle and supersede this manual trigger.
import { pathToFileURL } from "node:url";
import {
  startCapture,
  type AudioCaptureOptions,
} from "./audio/capture.js";
import {
  startPlayback,
  type AudioPlaybackOptions,
} from "./audio/playback.js";
import {
  connectToGateway,
  type ConnectToGatewayParams,
} from "./gateway/connect.js";
import { loadNodeConfig } from "./config.js";

// Lifecycle surfaces the boot path drives. Narrow structural shapes so the boot
// test can inject fakes and keep off real `arecord`/`aplay`; the real subsystems
// satisfy them.
interface CaptureHandle {
  // Fixed-size PCM16 frames from the mic, consumed by the push-to-talk pump.
  frames(): AsyncIterableIterator<Buffer>;
  stop(): Promise<void>;
}
interface PlaybackHandle {
  // Queue one base64 TTS frame for playback (decode happens inside).
  enqueue(frameBase64: string): void;
  stop(): Promise<void>;
}
interface GatewayHandle {
  setTalkSession(sessionId: string | null): void;
  sendPcm(frame: Buffer): void;
  onTtsFrame(listener: (audioBase64: string) => void): () => void;
  close(): Promise<void>;
  // Used to open/close the talk session the appended audio targets.
  client: { request<T = unknown>(method: string, params?: unknown): Promise<T> };
}

// Talk-session RPCs. The node streams audio into a `realtime` gateway-relay
// session (the only transport whose `appendAudio` the gateway accepts and which
// emits `talk.event` audio back — see src/gateway/server-methods/talk-session.ts
// and the connect.ts wire contract). Phase-2 talk-node.ts will own this.
const TALK_SESSION_CREATE_METHOD = "talk.session.create";
const TALK_SESSION_CLOSE_METHOD = "talk.session.close";
const TALK_SESSION_CREATE_PARAMS = {
  mode: "realtime",
  transport: "gateway-relay",
  brain: "agent-consult",
} as const;

// Injection seams for the boot test. Defaults are the real subsystems; a test
// swaps capture/playback for fakes and points `connectToGateway` at a stub.
export interface BootDeps {
  env?: NodeJS.ProcessEnv;
  startCapture?: (options: AudioCaptureOptions) => CaptureHandle;
  startPlayback?: (options: AudioPlaybackOptions) => PlaybackHandle;
  connectToGateway?: (params: ConnectToGatewayParams) => Promise<GatewayHandle>;
}

export interface VoiceRoomNode {
  // Push-to-talk press: open the talk session on first use and begin streaming
  // captured PCM as one utterance. Idempotent while already streaming.
  startUtterance(): Promise<void>;
  // Push-to-talk release: stop streaming captured PCM. The session stays open so
  // the next press reuses it; TTS replies keep flowing into playback.
  endUtterance(): void;
  // Stop capture and playback and close the gateway connection. Idempotent.
  shutdown(): Promise<void>;
}

/**
 * Boots the node: load config, open capture/playback, connect to the gateway
 * advertising cap "talk", wire TTS replies into playback, and start the
 * push-to-talk pump. Throws on invalid config or a failed gateway connect (the
 * audio children are reaped first so a failed boot leaves no orphan
 * `arecord`/`aplay`).
 */
export async function bootVoiceRoomNode(deps: BootDeps = {}): Promise<VoiceRoomNode> {
  const env = deps.env ?? process.env;

  const loaded = loadNodeConfig(env);
  if (!loaded.ok) {
    throw new Error(`voice-room-node: invalid config: ${loaded.error}`);
  }
  const config = loaded.config;

  // Own shutdown centrally: disable the children's built-in SIGTERM handlers so
  // the single handler below stops capture, playback, and the gateway together.
  const capture = (deps.startCapture ?? startCapture)({
    device: config.audio.captureDevice,
    handleProcessSignals: false,
  });
  const playback = (deps.startPlayback ?? startPlayback)({
    device: config.audio.playbackDevice,
    handleProcessSignals: false,
  });

  let gateway: GatewayHandle;
  try {
    gateway = await (deps.connectToGateway ?? connectToGateway)({ config, env });
  } catch (error) {
    // Connect failed after the audio children were spawned: reap them so a
    // failed boot never leaves an orphan `arecord`/`aplay` behind.
    await Promise.allSettled([capture.stop(), playback.stop()]);
    throw error;
  }

  // TTS reply frames play as they arrive, whether or not we are still streaming.
  const unsubscribeTts = gateway.onTtsFrame((audioBase64) => playback.enqueue(audioBase64));

  // Push-to-talk state. `streaming` gates the single capture consumer below:
  // frames are dropped until a press, then forwarded to the bound talk session.
  let streaming = false;
  let talkSessionId: string | null = null;
  let shuttingDown = false;

  const ensureTalkSession = async (): Promise<void> => {
    if (talkSessionId !== null) {
      return;
    }
    const created = await gateway.client.request<{ sessionId: string }>(
      TALK_SESSION_CREATE_METHOD,
      TALK_SESSION_CREATE_PARAMS,
    );
    talkSessionId = created.sessionId;
    gateway.setTalkSession(talkSessionId);
  };

  // Single consumer of the mic. Runs for the node's lifetime; capture.stop()
  // ends the iterator on shutdown. Forwards frames only while a press is held.
  const pump = (async (): Promise<void> => {
    try {
      for await (const frame of capture.frames()) {
        if (streaming) {
          gateway.sendPcm(frame);
        }
      }
    } catch {
      // Capture ended/errored (expected on shutdown). Nothing to forward.
    }
  })();

  const startUtterance = async (): Promise<void> => {
    if (shuttingDown || streaming) {
      return;
    }
    await ensureTalkSession();
    // Re-check: a concurrent shutdown may have landed while awaiting create.
    if (shuttingDown) {
      return;
    }
    streaming = true;
  };

  const endUtterance = (): void => {
    streaming = false;
  };

  let shutdownPromise: Promise<void> | undefined;
  const onSigterm = (): void => {
    void shutdown();
  };
  const shutdown = (): Promise<void> => {
    if (!shutdownPromise) {
      shuttingDown = true;
      streaming = false;
      process.removeListener("SIGTERM", onSigterm);
      unsubscribeTts();
      // Close the talk session before dropping the socket so the gateway can
      // release it; best-effort — a failed close must not block teardown.
      const closeSession =
        talkSessionId === null
          ? Promise.resolve()
          : gateway.client
              .request(TALK_SESSION_CLOSE_METHOD, { sessionId: talkSessionId })
              .then(() => {})
              .catch(() => {});
      shutdownPromise = closeSession
        .then(() =>
          Promise.allSettled([capture.stop(), playback.stop(), gateway.close(), pump]),
        )
        .then(() => {});
    }
    return shutdownPromise;
  };

  process.on("SIGTERM", onSigterm);

  return { startUtterance, endUtterance, shutdown };
}

// Direct-run entry: boot and keep the process alive until SIGTERM. SIGUSR1 and
// SIGUSR2 drive the manual push-to-talk (press / release). A boot failure (bad
// config, gateway unreachable) exits non-zero after logging.
async function main(): Promise<void> {
  try {
    const node = await bootVoiceRoomNode();
    console.log(
      'voice-room-node: connected, advertising cap "talk". ' +
        "Push-to-talk: SIGUSR1 = start, SIGUSR2 = end.",
    );
    process.on("SIGUSR1", () => void node.startUtterance());
    process.on("SIGUSR2", () => node.endUtterance());
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`voice-room-node: boot failed: ${detail}`);
    process.exitCode = 1;
  }
}

// Run only when executed as the process entry, not when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
