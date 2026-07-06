import { describe, expect, it } from "vitest";
import { type AgentGatewayClient, requestAgentReply } from "./request.ts";

// Records every RPC call and replies per the verified gateway contract:
// chat.send -> { runId, status: "in_flight" }; agent.wait -> terminal status;
// chat.history -> { messages: [...] }.
class StubGatewayClient implements AgentGatewayClient {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  waitStatus: "ok" | "error" | "timeout" = "ok";
  waitError?: string;
  assistantText = "It is Sunday.";
  historyMessages: unknown[] | null = null;

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method === "chat.send") {
      const idempotencyKey = (params as { idempotencyKey?: string }).idempotencyKey;
      return { runId: idempotencyKey, status: "in_flight" } as T;
    }
    if (method === "agent.wait") {
      return { runId: (params as { runId: string }).runId, status: this.waitStatus, error: this.waitError } as T;
    }
    if (method === "chat.history") {
      const messages = this.historyMessages ?? [
        { role: "user", content: [{ type: "text", text: "what's the date" }] },
        { role: "assistant", content: [{ type: "text", text: this.assistantText }] },
      ];
      return { messages } as T;
    }
    throw new Error(`unexpected method ${method}`);
  }
}

describe("requestAgentReply", () => {
  it("sends the prepended text and reads the reply from the agent.wait terminal + history", async () => {
    const client = new StubGatewayClient();
    const submitted: string[] = [];
    const result = await requestAgentReply({
      client,
      sessionKey: "voice-room",
      message: "BREVITY PREAMBLE\n\nwhat's the date",
      onSubmitted: (runId) => submitted.push(runId),
    });

    expect(result).toEqual({ ok: true, runId: expect.any(String), text: "It is Sunday." });

    const send = client.calls.find((c) => c.method === "chat.send");
    expect((send?.params as { message: string }).message).toBe("BREVITY PREAMBLE\n\nwhat's the date");
    const runId = (result as { runId: string }).runId;
    // chat.send runId echoes idempotencyKey, and agent.wait waits on it.
    expect((send?.params as { idempotencyKey: string }).idempotencyKey).toBe(runId);
    const wait = client.calls.find((c) => c.method === "agent.wait");
    expect((wait?.params as { runId: string }).runId).toBe(runId);
    // onSubmitted fired once, at submit, before the reply resolved.
    expect(submitted).toEqual([runId]);
  });

  it("issues the RPCs in order: chat.send, agent.wait, chat.history", async () => {
    const client = new StubGatewayClient();
    await requestAgentReply({ client, sessionKey: "s", message: "hi" });
    expect(client.calls.map((c) => c.method)).toEqual(["chat.send", "agent.wait", "chat.history"]);
  });

  it("fails when the run does not reach ok", async () => {
    const client = new StubGatewayClient();
    client.waitStatus = "error";
    client.waitError = "provider refused";
    const result = await requestAgentReply({ client, sessionKey: "s", message: "hi" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("error");
      expect(result.error).toContain("provider refused");
    }
    // No history read after a failed run.
    expect(client.calls.some((c) => c.method === "chat.history")).toBe(false);
  });

  it("reads text from a plain `text` message field too", async () => {
    const client = new StubGatewayClient();
    client.historyMessages = [{ role: "assistant", text: "Plain text reply." }];
    const result = await requestAgentReply({ client, sessionKey: "s", message: "hi" });
    expect(result).toEqual({ ok: true, runId: expect.any(String), text: "Plain text reply." });
  });

  it("fails clearly when no assistant text is present", async () => {
    const client = new StubGatewayClient();
    client.historyMessages = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    const result = await requestAgentReply({ client, sessionKey: "s", message: "hi" });
    expect(result.ok).toBe(false);
  });
});
