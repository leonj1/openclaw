// Typed configuration for the "Hey Jarvis" voice-room device node.
//
// The node reads a small JSON config file (path from OPENCLAW_VOICE_ROOM_CONFIG,
// else a home-dir default) and lets a few environment variables override the
// most operational fields. The gateway auth token is never stored in the config
// file: `gateway.tokenEnv` names the environment variable that holds it, so the
// secret lives only in the process environment.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

// Audio pipeline is locked to ALSA on x86_64 Linux (see AGENTS.md); device ids
// are ALSA identifiers such as "default" or "plughw:CARD=Anker,DEV=0".
const AlsaDeviceSchema = z.string().min(1);

// Audio + wake sections are shared between the full node config and the Layer 1
// wake-listen config, so they are named schemas reused by both below.
const AudioConfigSchema = z
  .object({
    captureDevice: AlsaDeviceSchema.default("default"),
    playbackDevice: AlsaDeviceSchema.default("default"),
  })
  .strict()
  .prefault({});

const WakeConfigSchema = z
  .object({
    // openWakeWord score in [0,1]; crossings above this fire a wake event.
    threshold: z.number().min(0).max(1).default(0.5),
  })
  .strict()
  .prefault({});

export const NodeConfigSchema = z
  .object({
    gateway: z
      .object({
        // Required. A missing/empty URL is the canonical rejection case.
        url: z.string().url(),
        // Name of the env var that carries the gateway auth token, not the
        // token itself, so credentials never land in the on-disk config.
        tokenEnv: z.string().min(1).default("OPENCLAW_VOICE_ROOM_TOKEN"),
      })
      .strict(),
    audio: AudioConfigSchema,
    wake: WakeConfigSchema,
    endpointing: z
      .object({
        // Trailing silence that ends an utterance while streaming.
        silenceMs: z.number().int().positive().default(800),
        // Hard cap on a single utterance so a stuck stream still endpoints.
        maxUtteranceMs: z.number().int().positive().default(15_000),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type NodeConfig = z.infer<typeof NodeConfigSchema>;

// Closed result shape: callers branch on `ok` instead of catching throws or
// juggling parallel value/error fields.
export type NodeConfigResult =
  | { ok: true; config: NodeConfig }
  | { ok: false; error: string };

export function parseNodeConfig(input: unknown): NodeConfigResult {
  const result = NodeConfigSchema.safeParse(input);
  if (!result.success) {
    return { ok: false, error: z.prettifyError(result.error) };
  }
  return { ok: true, config: result.data };
}

// Layer 1 wake-listen never connects to the gateway, so it must load from the
// same file/env without requiring a `gateway` block. It reads only the audio +
// wake sections; any other keys (gateway/endpointing) are ignored, so a full
// node config also loads here.
export const WakeListenConfigSchema = z
  .object({ audio: AudioConfigSchema, wake: WakeConfigSchema })
  .strip();

export type WakeListenConfigData = z.infer<typeof WakeListenConfigSchema>;

export type WakeListenConfigResult =
  | { ok: true; config: WakeListenConfigData }
  | { ok: false; error: string };

export function parseWakeListenConfig(input: unknown): WakeListenConfigResult {
  const result = WakeListenConfigSchema.safeParse(input);
  if (!result.success) {
    return { ok: false, error: z.prettifyError(result.error) };
  }
  return { ok: true, config: result.data };
}

const DEFAULT_CONFIG_FILENAME = "voice-room.json";

// Resolves the node-local config file: explicit env path wins, else
// ~/.openclaw/voice-room.json.
export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENCLAW_VOICE_ROOM_CONFIG?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.join(os.homedir(), ".openclaw", DEFAULT_CONFIG_FILENAME);
}

// Sparse overlay applied on top of the file so operators can retarget the
// gateway or audio devices without editing JSON. Omitted vars change nothing.
function readEnvOverrides(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const gateway: Record<string, unknown> = {};
  if (env.OPENCLAW_VOICE_ROOM_GATEWAY_URL) {
    gateway.url = env.OPENCLAW_VOICE_ROOM_GATEWAY_URL;
  }
  if (env.OPENCLAW_VOICE_ROOM_TOKEN_ENV) {
    gateway.tokenEnv = env.OPENCLAW_VOICE_ROOM_TOKEN_ENV;
  }
  const audio: Record<string, unknown> = {};
  if (env.OPENCLAW_VOICE_ROOM_CAPTURE_DEVICE) {
    audio.captureDevice = env.OPENCLAW_VOICE_ROOM_CAPTURE_DEVICE;
  }
  if (env.OPENCLAW_VOICE_ROOM_PLAYBACK_DEVICE) {
    audio.playbackDevice = env.OPENCLAW_VOICE_ROOM_PLAYBACK_DEVICE;
  }

  const overrides: Record<string, unknown> = {};
  if (Object.keys(gateway).length > 0) {
    overrides.gateway = gateway;
  }
  if (Object.keys(audio).length > 0) {
    overrides.audio = audio;
  }
  return overrides;
}

function readConfigFile(configPath: string): NodeConfigResult | Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    // Missing file is fine: env overrides + schema defaults may still validate.
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: `Config at ${configPath} must be a JSON object` };
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Invalid JSON in ${configPath}: ${detail}` };
  }
}

// Merges the on-disk config file with env overrides into a raw object ready for
// schema validation. Shared by `loadNodeConfig` and `loadWakeListenConfig` so
// both read identical file/env sources; only the schema they validate differs.
type MergedConfigResult =
  | { ok: true; raw: Record<string, unknown> }
  | { ok: false; error: string };

function readMergedConfig(env: NodeJS.ProcessEnv): MergedConfigResult {
  const configPath = resolveConfigPath(env);
  const fileData = readConfigFile(configPath);
  if ("ok" in fileData) {
    return fileData;
  }

  const overrides = readEnvOverrides(env);
  const gateway = {
    ...(fileData.gateway as Record<string, unknown> | undefined),
    ...(overrides.gateway as Record<string, unknown> | undefined),
  };
  const audio = {
    ...(fileData.audio as Record<string, unknown> | undefined),
    ...(overrides.audio as Record<string, unknown> | undefined),
  };
  const raw: Record<string, unknown> = { ...fileData };
  if (Object.keys(gateway).length > 0) {
    raw.gateway = gateway;
  }
  if (Object.keys(audio).length > 0) {
    raw.audio = audio;
  }
  return { ok: true, raw };
}

// Loads the full node config from file + environment overrides and validates it.
export function loadNodeConfig(env: NodeJS.ProcessEnv = process.env): NodeConfigResult {
  const merged = readMergedConfig(env);
  if (!merged.ok) {
    return merged;
  }
  return parseNodeConfig(merged.raw);
}

// Loads just the audio + wake sections for the standalone Layer 1 wake-listen
// entry, which runs without a gateway.
export function loadWakeListenConfig(
  env: NodeJS.ProcessEnv = process.env,
): WakeListenConfigResult {
  const merged = readMergedConfig(env);
  if (!merged.ok) {
    return merged;
  }
  return parseWakeListenConfig(merged.raw);
}
