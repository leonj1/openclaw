// Boot path for the "Hey Jarvis" voice-room device node (Layer 2).
//
// Loads config, opens mic capture + TTS playback, connects to the gateway, and
// runs the wake -> turn loop: a single mic consumer routes frames to wake
// detection while idle, to utterance endpointing after a wake, and drops them
// while the node is thinking/speaking (so the wait music and spoken reply can
// never re-trigger "hey jarvis"). Each wake runs one talk-node turn
// (STT -> brevity -> chat.send/agent.wait -> TTS). One SIGTERM handler tears
// capture, playback, and the gateway down together.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requestAgentReply } from "./agent/request.js";
import { endpointUtterance } from "./audio/endpoint.js";
import { startCapture, type AudioCaptureOptions } from "./audio/capture.js";
import { startPlayback, type AudioPlaybackOptions } from "./audio/playback.js";
import { createWaitPlayer } from "./audio/wait-player.js";
import { connectToGateway, type ConnectToGatewayParams } from "./gateway/connect.js";
import { loadNodeConfig, type NodeConfig } from "./config.js";
import { synthesizeReply } from "./tts/synthesize.js";
import { transcribeUtterance } from "./stt/transcribe.js";
import { createOpenWakeWord, type WakeEvent } from "./wake/openwakeword.js";
import {
  TalkNode,
  type SttResult,
  type TalkNodeDeps,
  type WaitLoopHandle,
} from "./session/talk-node.js";

// Structural handles so the boot test can inject fakes and stay off real
// arecord/aplay/onnx; the real subsystems satisfy them.
interface CaptureHandle {
  frames(): AsyncIterableIterator<Buffer>;
  stop(): Promise<void>;
}
interface PlaybackHandle {
  enqueue(frameBase64: string): void;
  pendingFrames(): number;
  drained(): Promise<void>;
  stop(): Promise<void>;
}
interface GatewayHandle {
  close(): Promise<void>;
  client: { request<T = unknown>(method: string, params?: unknown): Promise<T> };
}
interface Detector {
  process(pcm24k: Buffer): Promise<WakeEvent | null>;
}

const ASSETS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "assets");
// Instrumental wait loop (downloaded by scripts/fetch-wait-sound.sh; git-ignored).
const WAIT_LOOP_PATH = path.join(ASSETS_DIR, "wait-loop.wav");
// Spoken wait fillers (scripts/fetch-voice-fillers.ts; git-ignored, optional).
// The wait player randomizes between these and the instrumental loop each turn.
const FILLER_PATHS = ["filler-one-moment.wav", "filler-thinking.wav", "filler-working-on-it.wav"].map(
  (name) => path.join(ASSETS_DIR, name),
);

// Session key for the voice-room conversation. Env-overridable (no config-schema
// growth): one room => one conversation by default.
function resolveSessionKey(env: NodeJS.ProcessEnv): string {
  return env.OPENCLAW_VOICE_ROOM_SESSION_KEY?.trim() || "voice-room";
}

// Push-based frame channel: the pump pushes utterance frames after a wake and
// the endpointer consumes them as an async iterable. Closing ends the iterable.
class FrameChannel implements AsyncIterableIterator<Buffer> {
  private readonly queue: Buffer[] = [];
  private waiter?: (result: IteratorResult<Buffer>) => void;
  private closed = false;

  push(frame: Buffer): void {
    if (this.closed) {
      return;
    }
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter({ value: frame, done: false });
      return;
    }
    this.queue.push(frame);
  }

  close(): void {
    this.closed = true;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<Buffer> {
    return this;
  }

  next(): Promise<IteratorResult<Buffer>> {
    const frame = this.queue.shift();
    if (frame) {
      return Promise.resolve({ value: frame, done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

// Injection seams for the boot test. Defaults are the real subsystems.
export interface BootDeps {
  env?: NodeJS.ProcessEnv;
  startCapture?: (options: AudioCaptureOptions) => CaptureHandle;
  startPlayback?: (options: AudioPlaybackOptions) => PlaybackHandle;
  connectToGateway?: (params: ConnectToGatewayParams) => Promise<GatewayHandle>;
  createDetector?: (params: { threshold: number }) => Promise<Detector>;
  // Wait-music loop factory; defaults to loading the asset WAV and binding it to
  // playback. Tests inject a stub to skip file IO.
  makeWaitLoop?: (sink: PlaybackHandle) => WaitLoopHandle;
  // ElevenLabs boundaries; tests stub these so no network is touched.
  transcribe?: (pcm: Buffer, config: NodeConfig, env: NodeJS.ProcessEnv) => Promise<SttResult>;
  synthesize?: TalkNodeDeps["synthesize"];
  // Observes each completed turn (result), for the boot test.
  onTurn?: (result: Awaited<ReturnType<TalkNode["runTurn"]>>) => void;
  log?: (line: string) => void;
}

export interface VoiceRoomNode {
  // Resolves when the node stops cleanly (via `shutdown`/SIGTERM). REJECTS if mic
  // capture ends on its own (arecord died) so the entry point can exit non-zero
  // and let systemd restart the node with a fresh recorder.
  done: Promise<void>;
  // Current turn state, for tests/observability.
  state(): TalkNode["state"];
  // Stop capture + playback and close the gateway. Idempotent.
  shutdown(): Promise<void>;
}

function defaultTranscribe(pcm: Buffer, config: NodeConfig, env: NodeJS.ProcessEnv): Promise<SttResult> {
  return transcribeUtterance({
    pcm,
    baseUrl: config.elevenlabs.baseUrl,
    model: config.elevenlabs.sttModel,
    env,
  });
}

/**
 * Boots the node: load config, open capture/playback, connect to the gateway,
 * build the wake detector + talk-node, and run the wake -> turn loop. Throws on
 * invalid config or a failed gateway connect (audio children are reaped first so
 * a failed boot leaves no orphan arecord/aplay).
 */
export async function bootVoiceRoomNode(deps: BootDeps = {}): Promise<VoiceRoomNode> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => console.log(line));

  const loaded = loadNodeConfig(env);
  if (!loaded.ok) {
    throw new Error(`voice-room-node: invalid config: ${loaded.error}`);
  }
  const config = loaded.config;
  const sessionKey = resolveSessionKey(env);

  // Resolved TTS boundary, used both for the preflight below and every turn.
  const synthesize =
    deps.synthesize ??
    ((text: string) =>
      synthesizeReply({
        text,
        baseUrl: config.elevenlabs.baseUrl,
        voiceId: config.elevenlabs.ttsVoiceId,
        modelId: config.elevenlabs.ttsModelId,
        env,
      }));

  // Fail closed BEFORE the node can accept any wake: prove ElevenLabs TTS
  // actually synthesizes with the configured key/voice/model. A bad key or a
  // plan-blocked voice (cloned -> 401, library -> 402) aborts boot here instead
  // of letting the node listen for "Hey Jarvis" and then fail the turn at TTS.
  // No fallback — the throw propagates out of boot and nothing has been opened.
  const ttsCheck = await synthesize("Voice check.");
  if (!ttsCheck.ok) {
    throw new Error(`voice-room-node: ElevenLabs TTS preflight failed: ${ttsCheck.error}`);
  }
  if (ttsCheck.frames.length === 0) {
    throw new Error("voice-room-node: ElevenLabs TTS preflight returned no audio");
  }

  const detector = await (deps.createDetector ?? createOpenWakeWord)({
    threshold: config.wake.threshold,
  });

  // Own shutdown centrally: disable the children's SIGTERM handlers so the one
  // handler below stops capture, playback, and the gateway together.
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
    await Promise.allSettled([capture.stop(), playback.stop()]);
    throw error;
  }

  const waitLoop = (
    deps.makeWaitLoop ??
    ((sink) =>
      createWaitPlayer({ instrumentalPath: WAIT_LOOP_PATH, fillerPaths: FILLER_PATHS, sink }))
  )(playback);
  const transcribe = deps.transcribe ?? defaultTranscribe;

  // Active utterance channel while capturing; null otherwise. Its presence is
  // the routing signal: frames go here during capture, to the detector when
  // idle, and are dropped while the node is thinking/speaking. Boxed in an
  // object so the pump closure reads the current value (a closure-mutated `let`
  // would be narrowed away by control-flow analysis).
  const router: { active: FrameChannel | null } = { active: null };

  const talkDeps: TalkNodeDeps = {
    captureUtterance: async () => {
      const channel = router.active;
      if (!channel) {
        throw new Error("captureUtterance called without an active channel");
      }
      const result = await endpointUtterance(channel, {
        silenceMs: config.endpointing.silenceMs,
        maxUtteranceMs: config.endpointing.maxUtteranceMs,
      });
      // Endpointed: stop feeding this channel so thinking/speaking drop frames.
      router.active = null;
      return result;
    },
    transcribe: (pcm) => transcribe(pcm, config, env),
    requestReply: ({ message, onSubmitted }) =>
      requestAgentReply({ client: gateway.client, sessionKey, message, onSubmitted }),
    synthesize,
    waitLoop,
    playback,
  };
  const node = new TalkNode(talkDeps);

  let currentTurn: Promise<void> = Promise.resolve();
  const handleWake = (event: WakeEvent): void => {
    log(`WAKE score=${event.score.toFixed(3)} ts=${event.ts}`);
    router.active = new FrameChannel();
    currentTurn = (async () => {
      const result = await node.runTurn();
      if (!result.ok) {
        log(`voice-room-node: turn failed at ${result.stage}: ${result.error}`);
      }
      deps.onTurn?.(result);
    })();
  };

  const pump = (async (): Promise<void> => {
    try {
      for await (const frame of capture.frames()) {
        if (router.active) {
          router.active.push(frame);
          continue;
        }
        if (node.isMicGated()) {
          // Thinking/speaking: drop mic so the reply cannot self-trigger a wake.
          continue;
        }
        const event = await detector.process(frame);
        if (event) {
          handleWake(event);
        }
      }
    } catch {
      // Capture threw (e.g. arecord spawn/read error). Same as its EOF below: the
      // pump ends and `done` decides fatal-vs-clean from `shutdownRequested`.
    }
  })();

  let shutdownRequested = false;
  // The mic loop only ends on EOF/error from capture. If that happens without a
  // requested shutdown, arecord died (commonly a USB mic re-enumerating ->
  // "No such device") and the node can no longer hear "Hey Jarvis". Make it
  // fatal: `done` rejects so the entry point exits non-zero and systemd
  // (Restart=always) relaunches with a fresh arecord, instead of the process
  // lingering connected-but-deaf forever.
  const done = pump.then(() => {
    if (!shutdownRequested) {
      throw new Error("voice-room-node: mic capture ended unexpectedly (arecord died)");
    }
  });

  let shutdownPromise: Promise<void> | undefined;
  const onSigterm = (): void => {
    void shutdown();
  };
  const shutdown = (): Promise<void> => {
    if (!shutdownPromise) {
      // Set before stopping capture so the pump's end is seen as clean, not fatal.
      shutdownRequested = true;
      process.removeListener("SIGTERM", onSigterm);
      shutdownPromise = (async () => {
        await capture.stop();
        router.active?.close();
        await pump;
        await currentTurn;
        await waitLoop.stop();
        await Promise.allSettled([playback.stop(), gateway.close()]);
      })();
    }
    return shutdownPromise;
  };
  process.on("SIGTERM", onSigterm);

  return {
    done,
    state: () => node.state,
    shutdown,
  };
}

// Direct-run entry: boot and listen until SIGTERM (clean) or the mic dies (exit
// non-zero so systemd's Restart=always relaunches us with a fresh arecord).
async function main(): Promise<void> {
  let node: VoiceRoomNode;
  try {
    node = await bootVoiceRoomNode();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`voice-room-node: boot failed: ${detail}`);
    process.exitCode = 1;
    return;
  }
  console.log('voice-room-node: connected. Listening for "Hey Jarvis". SIGTERM to stop.');
  try {
    await node.done;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`voice-room-node: ${detail}; exiting for restart`);
    process.exitCode = 1;
  } finally {
    // Idempotent: on the mic-death path this closes the still-open gateway/
    // playback so the process can actually exit (and be restarted).
    await node.shutdown();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
