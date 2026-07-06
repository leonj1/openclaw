// End-to-end (stubbed) Layer 2 turn: wake -> endpoint -> STT -> gateway turn ->
// TTS -> playback, wiring the REAL modules with only the external boundaries
// (ElevenLabs HTTP, gateway RPC, aplay) stubbed. Proves the prepend reaches
// chat.send, the wait loop plays then stops before the reply, and no PCM is
// enqueued before the wake.
import { describe, expect, it } from "vitest";
import { requestAgentReply, type AgentGatewayClient } from "../agent/request.ts";
import { BREVITY_PREAMBLE } from "../agent/brevity.ts";
import { endpointUtterance } from "../audio/endpoint.ts";
import { WaitLoop } from "../audio/wait-loop.ts";
import { transcribeUtterance, type FetchLike } from "../stt/transcribe.ts";
import { synthesizeReply, type TtsFetchLike } from "../tts/synthesize.ts";
import { TalkNode } from "./talk-node.ts";

const FRAME_SAMPLES = (24_000 * 20) / 1000;
function pcmFrame(amplitude: number): Buffer {
  const buf = Buffer.alloc(FRAME_SAMPLES * 2);
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    buf.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
  }
  return buf;
}

async function* utteranceFrames(): AsyncIterable<Buffer> {
  for (let i = 0; i < 10; i++) yield pcmFrame(8000); // 200ms speech
  for (let i = 0; i < 10; i++) yield pcmFrame(0); // trailing silence
}

// Gateway stub honoring the verified chat.send/agent.wait/chat.history contract.
class StubGateway implements AgentGatewayClient {
  sentMessage = "";
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (method === "chat.send") {
      this.sentMessage = (params as { message: string }).message;
      return { runId: (params as { idempotencyKey: string }).idempotencyKey, status: "in_flight" } as T;
    }
    if (method === "agent.wait") {
      return { runId: (params as { runId: string }).runId, status: "ok" } as T;
    }
    if (method === "chat.history") {
      return {
        messages: [
          { role: "user", content: [{ type: "text", text: "what's the date" }] },
          { role: "assistant", content: [{ type: "text", text: "It is Sunday, July sixth." }] },
        ],
      } as T;
    }
    throw new Error(`unexpected ${method}`);
  }
}

// Stub playback sink recording enqueue order and reporting queue depth.
class StubPlayback {
  readonly enqueued: string[] = [];
  held = 0;
  enqueue(frame: string): void {
    this.enqueued.push(frame);
  }
  pendingFrames(): number {
    return this.held;
  }
  async drained(): Promise<void> {}
}

const sttFetch: FetchLike = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ text: "what's the date" }),
  text: async () => "",
});

const ttsAudio = Buffer.alloc(((24_000 * 2 * 20) / 1000) * 3); // 3 frames of PCM16
const ttsFetch: TtsFetchLike = async () => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => ttsAudio.buffer.slice(ttsAudio.byteOffset, ttsAudio.byteOffset + ttsAudio.length),
  text: async () => "",
});

describe("Layer 2 integration (stubbed)", () => {
  it("runs a full wake -> reply turn and enqueues no PCM before the wake", async () => {
    const gateway = new StubGateway();
    const playback = new StubPlayback();
    const env = { ELEVENLABS_API_KEY: "test-key" };

    // Track wait-music start/stop relative to the first TTS enqueue.
    const events: string[] = [];
    const waitLoop = new WaitLoop({
      frames: ["WAITA", "WAITB"],
      sink: {
        enqueue: (frame) => {
          events.push("wait-enqueue");
          playback.enqueue(frame);
        },
        pendingFrames: () => playback.held,
      },
      highWaterFrames: 2,
      pollMs: 2,
    });
    const startedWaitLoop = { value: false };

    const node = new TalkNode({
      captureUtterance: () =>
        endpointUtterance(utteranceFrames(), { silenceMs: 100, maxUtteranceMs: 10_000 }),
      transcribe: (pcm) =>
        transcribeUtterance({ pcm, baseUrl: "https://x", model: "scribe_v2", env, fetchFn: sttFetch }),
      requestReply: ({ message, onSubmitted }) =>
        requestAgentReply({
          client: gateway,
          sessionKey: "voice-room",
          message,
          onSubmitted: () => {
            events.push("submit");
            onSubmitted();
          },
        }),
      synthesize: (text) =>
        synthesizeReply({ text, baseUrl: "https://x", voiceId: "v", modelId: "m", env, fetchFn: ttsFetch }),
      waitLoop: {
        start: () => {
          startedWaitLoop.value = true;
          events.push("wait-start");
          waitLoop.start();
        },
        stop: async () => {
          events.push("wait-stop");
          await waitLoop.stop();
        },
      },
      playback: {
        enqueue: (frame) => {
          events.push("tts-enqueue");
          playback.enqueue(frame);
        },
        drained: () => playback.drained(),
      },
    });

    // Before the wake: nothing has been captured, sent, or played.
    expect(playback.enqueued).toEqual([]);
    expect(gateway.sentMessage).toBe("");

    // Wake fires -> run one turn.
    const result = await node.runTurn();

    expect(result).toEqual({
      ok: true,
      transcript: "what's the date",
      reply: "It is Sunday, July sixth.",
    });
    // The brevity prepend reached chat.send with the transcript verbatim after it.
    expect(gateway.sentMessage.startsWith(BREVITY_PREAMBLE)).toBe(true);
    expect(gateway.sentMessage.endsWith("what's the date")).toBe(true);

    // Wait music started after submit and stopped before the first TTS frame.
    expect(events.indexOf("wait-start")).toBeGreaterThan(events.indexOf("submit"));
    expect(events.indexOf("wait-stop")).toBeLessThan(events.indexOf("tts-enqueue"));
    // No wait-loop frame was enqueued after TTS began (no overlap).
    expect(events.slice(events.indexOf("tts-enqueue"))).not.toContain("wait-enqueue");
    // TTS actually produced spoken frames.
    expect(events.filter((e) => e === "tts-enqueue").length).toBe(3);
    expect(startedWaitLoop.value).toBe(true);
  });
});
