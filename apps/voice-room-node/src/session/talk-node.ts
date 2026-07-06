// Layer 2 turn orchestrator: one wake -> one spoken reply.
//
// State machine: idle -> capturing -> thinking -> speaking -> idle.
//   capturing: endpoint the follow-up utterance from the mic.
//   thinking:  STT -> prependBrevity -> chat.send + agent.wait. The wait-music
//              loop starts at submit (chat.send) and stops the instant the reply
//              text arrives, before any TTS plays.
//   speaking:  TTS the reply and drain it through playback.
//
// Mic gating: the node must not run wake detection while `thinking`/`speaking`,
// or the wait loop and the spoken reply would re-trigger "hey jarvis". Callers
// gate on `state`/`isMicGated()` (main.ts skips detection unless idle).
import { prependBrevity } from "../agent/brevity.js";
import type { AgentReplyResult } from "../agent/request.js";
import type { EndpointResult } from "../audio/endpoint.js";
import type { SynthesizeResult } from "../tts/synthesize.js";

export type TalkState = "idle" | "capturing" | "thinking" | "speaking";

export type SttResult = { ok: true; text: string } | { ok: false; error: string };

// Wait-music handle (WaitLoop satisfies it structurally).
export interface WaitLoopHandle {
  start(): void;
  stop(): Promise<void>;
}

// Playback sink for TTS frames (AudioPlayback satisfies it structurally).
export interface PlaybackSink {
  enqueue(frameBase64: string): void;
  drained(): Promise<void>;
}

export interface TalkNodeDeps {
  // Endpoint one utterance from the mic (capture + silence/max boundary).
  captureUtterance(): Promise<EndpointResult>;
  // Transcribe the utterance PCM to text (ElevenLabs STT).
  transcribe(pcm: Buffer): Promise<SttResult>;
  // Run the gateway turn. `onSubmitted` fires at chat.send so the wait loop
  // starts exactly at submit time.
  requestReply(params: { message: string; onSubmitted: () => void }): Promise<AgentReplyResult>;
  // Synthesize the reply text to base64 PCM frames (ElevenLabs TTS).
  synthesize(text: string): Promise<SynthesizeResult>;
  waitLoop: WaitLoopHandle;
  playback: PlaybackSink;
  // Observes each state transition; tests assert ordering.
  onState?: (state: TalkState) => void;
}

export type TurnStage = "capture" | "stt" | "agent" | "tts";

export type TurnResult =
  | { ok: true; transcript: string; reply: string }
  | { ok: false; stage: TurnStage; error: string };

export class TalkNode {
  private currentState: TalkState = "idle";

  constructor(private readonly deps: TalkNodeDeps) {}

  get state(): TalkState {
    return this.currentState;
  }

  // True while a turn is processing/speaking: the mic must not feed wake
  // detection here, or the wait loop / reply would self-trigger.
  isMicGated(): boolean {
    return this.currentState === "thinking" || this.currentState === "speaking";
  }

  private setState(state: TalkState): void {
    this.currentState = state;
    this.deps.onState?.(state);
  }

  // Run exactly one turn. Always returns to `idle` and always stops the wait
  // loop, even on failure, so a bad turn never leaves music playing.
  async runTurn(): Promise<TurnResult> {
    try {
      return await this.runTurnInner();
    } finally {
      // Defensive: guarantee no orphaned wait music and a clean idle state.
      await this.deps.waitLoop.stop();
      this.setState("idle");
    }
  }

  private async runTurnInner(): Promise<TurnResult> {
    this.setState("capturing");
    const utterance = await this.deps.captureUtterance();

    this.setState("thinking");
    const stt = await this.deps.transcribe(utterance.pcm);
    if (!stt.ok) {
      return { ok: false, stage: "stt", error: stt.error };
    }

    // Wait music starts at submit (chat.send) and stops the instant the reply
    // resolves — before any TTS is enqueued.
    const message = prependBrevity(stt.text);
    const reply = await this.deps.requestReply({
      message,
      onSubmitted: () => this.deps.waitLoop.start(),
    });
    await this.deps.waitLoop.stop();
    if (!reply.ok) {
      return { ok: false, stage: "agent", error: reply.error };
    }

    this.setState("speaking");
    const tts = await this.deps.synthesize(reply.text);
    if (!tts.ok) {
      return { ok: false, stage: "tts", error: tts.error };
    }
    for (const frame of tts.frames) {
      this.deps.playback.enqueue(frame);
    }
    await this.deps.playback.drained();

    return { ok: true, transcript: stt.text, reply: reply.text };
  }
}
