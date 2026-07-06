// One turn against the OpenClaw gateway for the Layer 2 voice turn.
//
// Verified against the gateway source (do not guess these shapes):
//   - `chat.send` (src/gateway/server-methods/chat.ts, handler at "chat.send")
//     takes { sessionKey, message, idempotencyKey, agentId? } and responds
//     immediately with { runId, status: "in_flight" }. `runId` equals the
//     idempotencyKey (clientRunId = p.idempotencyKey). Params schema:
//     packages/gateway-protocol/src/schema/logs-chat.ts ChatSendParamsSchema.
//   - `agent.wait` (src/gateway/server-methods/agent.ts, handler at
//     "agent.wait") takes { runId, timeoutMs? } and BLOCKS until the run reaches
//     a terminal state, responding { runId, status: "ok"|"error"|"timeout", ... }.
//     Params schema: packages/gateway-protocol/src/schema/agent.ts
//     AgentWaitParamsSchema. Crucially the terminal snapshot carries NO reply
//     text (see AgentWaitTerminalSnapshot in
//     src/gateway/server-methods/agent-wait-dedupe.ts) — it is only the
//     "reply ready" signal.
//   - The reply TEXT is therefore read with a follow-up `chat.history`
//     (src/gateway/server-methods/chat.ts) whose payload is
//     { messages: [...] } of projected display messages
//     ({ role, content: [{ type: "text", text }] }; see
//     src/gateway/chat-display-projection.ts). We take the newest assistant
//     message, which is this turn's reply.
import { randomUUID } from "node:crypto";

// Narrow client surface: one JSON-RPC-style request. GatewayClient.request and
// the boot stub both satisfy it.
export interface AgentGatewayClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

export interface AgentRequestParams {
  client: AgentGatewayClient;
  // Session/agent targeting for chat.send + chat.history.
  sessionKey: string;
  agentId?: string;
  // Prepended (brevity) message text to send as the turn.
  message: string;
  // Bound for agent.wait; the server default is 30s if omitted.
  timeoutMs?: number;
  // Idempotency key doubles as the run id; generated when omitted.
  idempotencyKey?: string;
  // Called the instant chat.send is submitted (before agent.wait blocks) so the
  // caller can start the wait-music loop exactly at submit time.
  onSubmitted?: (runId: string) => void;
}

export type AgentReplyResult =
  | { ok: true; runId: string; text: string }
  | { ok: false; error: string };

// Default number of recent messages to pull when reading the reply back.
const HISTORY_LIMIT = 6;

export async function requestAgentReply(params: AgentRequestParams): Promise<AgentReplyResult> {
  const idempotencyKey = params.idempotencyKey ?? randomUUID();

  let sendResult: { runId?: unknown };
  try {
    sendResult = await params.client.request<{ runId?: unknown }>("chat.send", {
      sessionKey: params.sessionKey,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      message: params.message,
      idempotencyKey,
    });
  } catch (err) {
    return { ok: false, error: `chat.send failed: ${errorText(err)}` };
  }
  // runId echoes the idempotencyKey; fall back to it if the server omits it.
  const runId =
    typeof sendResult.runId === "string" && sendResult.runId ? sendResult.runId : idempotencyKey;

  // Submit is done: let the caller start the wait loop before agent.wait blocks.
  params.onSubmitted?.(runId);

  let waitResult: { status?: unknown; error?: unknown };
  try {
    waitResult = await params.client.request<{ status?: unknown; error?: unknown }>("agent.wait", {
      runId,
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    });
  } catch (err) {
    return { ok: false, error: `agent.wait failed: ${errorText(err)}` };
  }
  if (waitResult.status !== "ok") {
    const detail = typeof waitResult.error === "string" ? `: ${waitResult.error}` : "";
    return { ok: false, error: `agent run ${String(waitResult.status ?? "unknown")}${detail}` };
  }

  // Terminal snapshot has no text; read the reply from history.
  let history: { messages?: unknown };
  try {
    history = await params.client.request<{ messages?: unknown }>("chat.history", {
      sessionKey: params.sessionKey,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      limit: HISTORY_LIMIT,
    });
  } catch (err) {
    return { ok: false, error: `chat.history failed: ${errorText(err)}` };
  }
  const text = readLatestAssistantText(history.messages);
  if (!text) {
    return { ok: false, error: "agent reply had no assistant text" };
  }
  return { ok: true, runId, text };
}

// Scans newest-first for the latest assistant message and extracts its spoken
// text. History is oldest->newest, so the last assistant entry is this reply.
function readLatestAssistantText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || typeof message !== "object") {
      continue;
    }
    if ((message as { role?: unknown }).role !== "assistant") {
      continue;
    }
    const text = extractMessageText(message as Record<string, unknown>);
    if (text) {
      return text;
    }
  }
  return undefined;
}

// Reads text from a projected display message: joined `content` text blocks, or
// a plain `text` field (both shapes appear in chat-display-projection output).
function extractMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (Array.isArray(content)) {
    const joined = content
      .map((block) =>
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
          : "",
      )
      .filter(Boolean)
      .join("\n")
      .trim();
    if (joined) {
      return joined;
    }
  }
  return typeof message.text === "string" ? message.text.trim() : "";
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
