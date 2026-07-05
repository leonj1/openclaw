// Boot path for the "Hey Jarvis" voice-room device node.
//
// Loads the node config, opens mic capture and TTS playback, and connects to
// the gateway advertising cap "talk". A single SIGTERM handler tears all three
// down together — the capture/playback children's own signal handlers are
// disabled here so shutdown is coordinated from one place instead of three
// racing handlers. No push-to-talk or streaming yet: capture frames are not
// consumed and no PCM is sent until a later step wires the talk session.
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

// Lifecycle surfaces the boot path drives. Capture/playback expose `stop()` and
// the gateway handle exposes `close()`; the real implementations satisfy these,
// and injecting narrow fakes keeps the boot test off real `arecord`/`aplay`.
interface Stoppable {
  stop(): Promise<void>;
}
interface Closeable {
  close(): Promise<void>;
}

// Injection seams for the boot test. Defaults are the real subsystems; a test
// swaps capture/playback for fakes and points `connectToGateway` at a stub.
export interface BootDeps {
  env?: NodeJS.ProcessEnv;
  startCapture?: (options: AudioCaptureOptions) => Stoppable;
  startPlayback?: (options: AudioPlaybackOptions) => Stoppable;
  connectToGateway?: (params: ConnectToGatewayParams) => Promise<Closeable>;
}

export interface VoiceRoomNode {
  // Stop capture and playback and close the gateway connection. Idempotent.
  shutdown(): Promise<void>;
}

/**
 * Boots the node: load config, open capture/playback, connect to the gateway
 * advertising cap "talk", and register a single SIGTERM shutdown for all three.
 * Throws on invalid config or a failed gateway connect (the audio children are
 * reaped first so a failed boot leaves no orphan `arecord`/`aplay`).
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

  let gateway: Closeable;
  try {
    gateway = await (deps.connectToGateway ?? connectToGateway)({ config, env });
  } catch (error) {
    // Connect failed after the audio children were spawned: reap them so a
    // failed boot never leaves an orphan `arecord`/`aplay` behind.
    await Promise.allSettled([capture.stop(), playback.stop()]);
    throw error;
  }

  let shuttingDown: Promise<void> | undefined;
  const onSigterm = (): void => {
    void shutdown();
  };
  const shutdown = (): Promise<void> => {
    if (!shuttingDown) {
      process.removeListener("SIGTERM", onSigterm);
      shuttingDown = Promise.allSettled([
        capture.stop(),
        playback.stop(),
        gateway.close(),
      ]).then(() => {});
    }
    return shuttingDown;
  };

  process.on("SIGTERM", onSigterm);

  return { shutdown };
}

// Direct-run entry: boot and keep the process alive until SIGTERM. A boot
// failure (bad config, gateway unreachable) exits non-zero after logging.
async function main(): Promise<void> {
  try {
    await bootVoiceRoomNode();
    console.log('voice-room-node: connected, advertising cap "talk"');
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
