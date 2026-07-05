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
    expect(result.config.endpointing.silenceMs).toBe(800);
    expect(result.config.endpointing.maxUtteranceMs).toBe(15_000);
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
