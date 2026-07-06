import { describe, expect, it } from "vitest";
import { TalkNode, type TalkNodeDeps, type TalkState } from "./talk-node.ts";
import { BREVITY_PREAMBLE } from "../agent/brevity.ts";

// Shared event log across all stubbed deps so tests can assert the exact
// ordering of state transitions, wait-loop start/stop, submit, and TTS enqueue.
type Event =
  | { kind: "state"; state: TalkState }
  | { kind: "submit" }
  | { kind: "wait-start" }
  | { kind: "wait-stop" }
  | { kind: "enqueue" };

function makeDeps(overrides: Partial<TalkNodeDeps> = {}): { deps: TalkNodeDeps; events: Event[] } {
  const events: Event[] = [];
  const deps: TalkNodeDeps = {
    captureUtterance: async () => ({ pcm: Buffer.from([1, 2, 3, 4]), reason: "silence", durationMs: 400 }),
    transcribe: async () => ({ ok: true, text: "what's the date" }),
    requestReply: async ({ onSubmitted }) => {
      events.push({ kind: "submit" });
      onSubmitted(); // chat.send submitted -> wait loop should start here
      return { ok: true, runId: "run-1", text: "It is Sunday." };
    },
    synthesize: async () => ({ ok: true, frames: ["FRAME1", "FRAME2"] }),
    waitLoop: {
      start: () => events.push({ kind: "wait-start" }),
      stop: async () => {
        events.push({ kind: "wait-stop" });
      },
    },
    playback: {
      enqueue: () => events.push({ kind: "enqueue" }),
      drained: async () => {},
    },
    onState: (state) => events.push({ kind: "state", state }),
    ...overrides,
  };
  return { deps, events };
}

describe("TalkNode.runTurn", () => {
  it("walks idle -> capturing -> thinking -> speaking -> idle and returns the reply", async () => {
    const { deps, events } = makeDeps();
    const node = new TalkNode(deps);
    const result = await node.runTurn();

    expect(result).toEqual({ ok: true, transcript: "what's the date", reply: "It is Sunday." });
    const states = events.filter((e) => e.kind === "state").map((e) => (e as { state: TalkState }).state);
    expect(states).toEqual(["capturing", "thinking", "speaking", "idle"]);
    expect(node.state).toBe("idle");
  });

  it("prepends the brevity preamble to the transcribed message", async () => {
    let sentMessage = "";
    const { deps } = makeDeps({
      requestReply: async ({ message, onSubmitted }) => {
        sentMessage = message;
        onSubmitted();
        return { ok: true, runId: "r", text: "ok" };
      },
    });
    await new TalkNode(deps).runTurn();
    expect(sentMessage.startsWith(BREVITY_PREAMBLE)).toBe(true);
    expect(sentMessage.endsWith("what's the date")).toBe(true);
  });

  it("gates the mic during thinking and speaking, not during capturing/idle", async () => {
    const gatedStates: Array<{ state: TalkState; gated: boolean }> = [];
    let node!: TalkNode;
    // Sample the gate at each transition from the node's own view.
    const { deps } = makeDeps({
      onState: (state) => gatedStates.push({ state, gated: node.isMicGated() }),
    });
    node = new TalkNode(deps);
    await node.runTurn();

    const gateFor = (state: TalkState) => gatedStates.find((g) => g.state === state)?.gated;
    expect(gateFor("capturing")).toBe(false);
    expect(gateFor("thinking")).toBe(true);
    expect(gateFor("speaking")).toBe(true);
    expect(gateFor("idle")).toBe(false);
  });

  // Timing contract: wait loop starts only after submit (chat.send), and stops
  // the instant the reply arrives, before the first TTS frame is enqueued.
  it("starts wait music after submit and stops it before TTS playback", async () => {
    const { deps, events } = makeDeps();
    await new TalkNode(deps).runTurn();

    const kinds = events.map((e) => e.kind);
    const submitIdx = kinds.indexOf("submit");
    const startIdx = kinds.indexOf("wait-start");
    const stopIdx = kinds.indexOf("wait-stop");
    const firstEnqueueIdx = kinds.indexOf("enqueue");

    // start-after-submit
    expect(startIdx).toBeGreaterThan(submitIdx);
    // stop-before-reply-playback (before the first TTS frame)
    expect(stopIdx).toBeLessThan(firstEnqueueIdx);
    expect(startIdx).toBeLessThan(stopIdx);
    // wait music never overlaps the spoken reply
    expect(kinds.slice(firstEnqueueIdx)).not.toContain("wait-start");
  });

  it("never starts the wait loop when STT fails, and returns a staged error", async () => {
    const { deps, events } = makeDeps({
      transcribe: async () => ({ ok: false, error: "stt down" }),
    });
    const result = await new TalkNode(deps).runTurn();
    expect(result).toEqual({ ok: false, stage: "stt", error: "stt down" });
    expect(events.some((e) => e.kind === "wait-start")).toBe(false);
    expect(events.some((e) => e.kind === "enqueue")).toBe(false);
  });

  it("stops the wait loop and reports an agent error without speaking", async () => {
    const { deps, events } = makeDeps({
      requestReply: async ({ onSubmitted }) => {
        onSubmitted();
        return { ok: false, error: "run timeout" };
      },
    });
    const result = await new TalkNode(deps).runTurn();
    expect(result).toEqual({ ok: false, stage: "agent", error: "run timeout" });
    expect(events.some((e) => e.kind === "wait-stop")).toBe(true);
    expect(events.some((e) => e.kind === "enqueue")).toBe(false);
  });
});
