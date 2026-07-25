import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadNodeConfig, loadWakeListenConfig, parseNodeConfig } from "./config.ts";

const validInput = {
  gateway: { url: "wss://gateway.example.test/ws", tokenEnv: "MY_TOKEN" },
  audio: { captureDevice: "plughw:CARD=Anker,DEV=0", playbackDevice: "default" },
  wake: { threshold: 0.6 },
  endpointing: { silenceMs: 900, maxUtteranceMs: 12_000 },
};

describe("parseNodeConfig", () => {
  it("accepts a valid config and preserves values", () => {
    const result = parseNodeConfig(validInput);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.config.gateway.url).toBe("wss://gateway.example.test/ws");
    expect(result.config.audio.captureDevice).toBe("plughw:CARD=Anker,DEV=0");
    expect(result.config.wake.threshold).toBe(0.6);
    expect(result.config.wake.patienceWindows).toBe(1);
    expect(result.config.wake.smoothingWindows).toBe(1);
    expect(result.config.wake.vad).toEqual({ enabled: false, minRms: 0.01 });
    expect(result.config.endpointing.silenceMs).toBe(900);
  });

  it("applies nested defaults when optional sections are omitted", () => {
    const result = parseNodeConfig({ gateway: { url: "wss://g.example.test" } });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.config.gateway.tokenEnv).toBe("OPENCLAW_VOICE_ROOM_TOKEN");
    expect(result.config.audio.captureDevice).toBe("default");
    expect(result.config.wake.threshold).toBe(0.5);
    expect(result.config.wake.patienceWindows).toBe(1);
    expect(result.config.wake.smoothingWindows).toBe(1);
    expect(result.config.wake.vad).toEqual({ enabled: false, minRms: 0.01 });
    expect(result.config.endpointing.silenceMs).toBe(800);
    expect(result.config.endpointing.maxUtteranceMs).toBe(15_000);
    // Wake-verification defaults
    expect(result.config.wakeVerification).toEqual({
      enabled: true,
      model: "llama3.2:3b",
      baseUrl: "http://localhost:11434",
      timeoutMs: 3000,
      clipMs: 1200,
    });
  });

  it("rejects a config missing the gateway URL", () => {
    const result = parseNodeConfig({ audio: { captureDevice: "default" } });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected rejection");
    }
    expect(result.error).toMatch(/gateway/i);
  });

  it("rejects an out-of-range wake threshold", () => {
    const result = parseNodeConfig({ gateway: { url: "wss://g.example.test" }, wake: { threshold: 2 } });
    expect(result.ok).toBe(false);
  });

  it("accepts the legacy-equivalent wake decision config", () => {
    const result = parseNodeConfig({
      gateway: { url: "wss://g.example.test" },
      wake: {
        threshold: 0.5,
        patienceWindows: 1,
        smoothingWindows: 1,
        vad: { enabled: false, minRms: 0 },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.config.wake).toEqual({
      threshold: 0.5,
      patienceWindows: 1,
      smoothingWindows: 1,
      vad: { enabled: false, minRms: 0 },
    });
  });

  it.each([
    { patienceWindows: 0 },
    { patienceWindows: 1.5 },
    { smoothingWindows: 0 },
    { smoothingWindows: 1.5 },
  ])("rejects invalid temporal wake config: %j", (wake) => {
    const result = parseNodeConfig({ gateway: { url: "wss://g.example.test" }, wake });
    expect(result.ok).toBe(false);
  });

  it.each([-0.01, 1.01])("rejects out-of-range normalized RMS %s", (minRms) => {
    const result = parseNodeConfig({
      gateway: { url: "wss://g.example.test" },
      wake: { vad: { minRms } },
    });
    expect(result.ok).toBe(false);
  });
});

describe("loadNodeConfig", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  function writeConfigFile(contents: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-room-config-"));
    tmpDirs.push(dir);
    const filePath = path.join(dir, "voice-room.json");
    fs.writeFileSync(filePath, contents);
    return filePath;
  }

  it("loads and validates a node-local config file", () => {
    const filePath = writeConfigFile(JSON.stringify(validInput));
    const result = loadNodeConfig({ OPENCLAW_VOICE_ROOM_CONFIG: filePath });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.config.gateway.url).toBe("wss://gateway.example.test/ws");
  });

  it("lets an env var override the gateway URL from the file", () => {
    const filePath = writeConfigFile(JSON.stringify({ gateway: { url: "wss://old.example.test" } }));
    const result = loadNodeConfig({
      OPENCLAW_VOICE_ROOM_CONFIG: filePath,
      OPENCLAW_VOICE_ROOM_GATEWAY_URL: "wss://new.example.test",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.config.gateway.url).toBe("wss://new.example.test");
  });

  it("rejects a file whose config is missing the gateway URL", () => {
    const filePath = writeConfigFile(JSON.stringify({ wake: { threshold: 0.4 } }));
    const result = loadNodeConfig({ OPENCLAW_VOICE_ROOM_CONFIG: filePath });
    expect(result.ok).toBe(false);
  });

  it("reports invalid JSON instead of throwing", () => {
    const filePath = writeConfigFile("{ not json");
    const result = loadNodeConfig({ OPENCLAW_VOICE_ROOM_CONFIG: filePath });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected rejection");
    }
    expect(result.error).toMatch(/invalid json/i);
  });
});

describe("loadWakeListenConfig", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  function writeConfigFile(contents: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-room-wake-config-"));
    tmpDirs.push(dir);
    const filePath = path.join(dir, "voice-room.json");
    fs.writeFileSync(filePath, contents);
    return filePath;
  }

  it("loads with no gateway block and applies audio + wake defaults", () => {
    // Layer 1 runs standalone: a config with no gateway (or no file at all) must
    // still load. Point at a missing path so only schema defaults apply.
    const result = loadWakeListenConfig({
      OPENCLAW_VOICE_ROOM_CONFIG: path.join(os.tmpdir(), "voice-room-absent.json"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.config.audio.captureDevice).toBe("default");
    expect(result.config.wake.threshold).toBe(0.5);
    expect(result.config.wake.patienceWindows).toBe(1);
    expect(result.config.wake.smoothingWindows).toBe(1);
    expect(result.config.wake.vad).toEqual({ enabled: false, minRms: 0.01 });
  });

  it("reads audio device + wake threshold and ignores an unrelated gateway block", () => {
    const filePath = writeConfigFile(
      JSON.stringify({
        gateway: { url: "wss://ignored.example.test" },
        audio: { captureDevice: "plughw:CARD=Anker,DEV=0" },
        wake: { threshold: 0.7 },
      }),
    );
    const result = loadWakeListenConfig({ OPENCLAW_VOICE_ROOM_CONFIG: filePath });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.config.audio.captureDevice).toBe("plughw:CARD=Anker,DEV=0");
    expect(result.config.wake.threshold).toBe(0.7);
  });

  it("lets an env var override the capture device", () => {
    const result = loadWakeListenConfig({
      OPENCLAW_VOICE_ROOM_CONFIG: path.join(os.tmpdir(), "voice-room-absent.json"),
      OPENCLAW_VOICE_ROOM_CAPTURE_DEVICE: "plughw:CARD=USB,DEV=0",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.config.audio.captureDevice).toBe("plughw:CARD=USB,DEV=0");
  });
});

describe("wakeVerification config", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  function writeConfigFile(contents: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-room-wv-config-"));
    tmpDirs.push(dir);
    const filePath = path.join(dir, "voice-room.json");
    fs.writeFileSync(filePath, contents);
    return filePath;
  }

  it("defaults wakeVerification to enabled with llama3.2:3b", () => {
    const filePath = writeConfigFile(JSON.stringify({ gateway: { url: "ws://localhost" } }));
    const result = loadNodeConfig({ OPENCLAW_VOICE_ROOM_CONFIG: filePath });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.config.wakeVerification.enabled).toBe(true);
    expect(result.config.wakeVerification.model).toBe("llama3.2:3b");
    expect(result.config.wakeVerification.baseUrl).toBe("http://localhost:11434");
    expect(result.config.wakeVerification.timeoutMs).toBe(3000);
    expect(result.config.wakeVerification.clipMs).toBe(1200);
  });

  it("overrides all wakeVerification fields via env vars", () => {
    const filePath = writeConfigFile(JSON.stringify({ gateway: { url: "ws://localhost" } }));
    const result = loadNodeConfig({
      OPENCLAW_VOICE_ROOM_CONFIG: filePath,
      OPENCLAW_VOICE_ROOM_WAKE_VERIFY_MODEL: "qwen3:8b",
      OPENCLAW_VOICE_ROOM_WAKE_VERIFY_BASE_URL: "http://ollama:9999",
      OPENCLAW_VOICE_ROOM_WAKE_VERIFY_TIMEOUT_MS: "600",
      OPENCLAW_VOICE_ROOM_WAKE_VERIFY_CLIP_MS: "900",
      OPENCLAW_VOICE_ROOM_WAKE_VERIFY_ENABLED: "false",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const wv = result.config.wakeVerification;
    expect(wv.model).toBe("qwen3:8b");
    expect(wv.baseUrl).toBe("http://ollama:9999");
    expect(wv.timeoutMs).toBe(600);
    expect(wv.clipMs).toBe(900);
    expect(wv.enabled).toBe(false);
  });

  it("file-level wakeVerification config is preserved", () => {
    const filePath = writeConfigFile(
      JSON.stringify({
        gateway: { url: "ws://localhost" },
        wakeVerification: { enabled: false, model: "gemma:2b", clipMs: 600 },
      }),
    );
    const result = loadNodeConfig({ OPENCLAW_VOICE_ROOM_CONFIG: filePath });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const wv = result.config.wakeVerification;
    expect(wv.enabled).toBe(false);
    expect(wv.model).toBe("gemma:2b");
    expect(wv.clipMs).toBe(600);
    // Fields not in file use defaults
    expect(wv.timeoutMs).toBe(3000);
  });

  it("treats ENABLED=true (case-insensitive) as true and unknown values as omitted", () => {
    const filePath = writeConfigFile(JSON.stringify({ gateway: { url: "ws://localhost" } }));
    // "TRUE" (uppercase) → true
    const r1 = loadNodeConfig({
      OPENCLAW_VOICE_ROOM_CONFIG: filePath,
      OPENCLAW_VOICE_ROOM_WAKE_VERIFY_ENABLED: "TRUE",
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) throw new Error(r1.error);
    expect(r1.config.wakeVerification.enabled).toBe(true);

    // "garbage" → omitted, default applies
    const r2 = loadNodeConfig({
      OPENCLAW_VOICE_ROOM_CONFIG: filePath,
      OPENCLAW_VOICE_ROOM_WAKE_VERIFY_ENABLED: "garbage",
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) throw new Error(r2.error);
    expect(r2.config.wakeVerification.enabled).toBe(true);
  });
});
