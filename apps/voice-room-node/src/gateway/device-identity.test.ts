import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  resolveDeviceIdentityPath,
  signDevicePayload,
} from "./device-identity.js";

const tempDirs: string[] = [];

function tempIdentityPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-room-identity-"));
  tempDirs.push(dir);
  return path.join(dir, "device-identity.json");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("creates, persists, and reuses the same identity across calls", () => {
  const filePath = tempIdentityPath();
  expect(fs.existsSync(filePath)).toBe(false);

  const first = loadOrCreateDeviceIdentity(filePath);
  expect(first.deviceId).toMatch(/^[0-9a-f]{64}$/);
  expect(first.publicKeyPem).toContain("BEGIN PUBLIC KEY");
  expect(first.privateKeyPem).toContain("BEGIN PRIVATE KEY");
  expect(fs.existsSync(filePath)).toBe(true);

  const second = loadOrCreateDeviceIdentity(filePath);
  expect(second).toEqual(first);
});

test("persists the identity file with 0600 permissions", () => {
  const filePath = tempIdentityPath();
  loadOrCreateDeviceIdentity(filePath);
  const mode = fs.statSync(filePath).mode & 0o777;
  expect(mode).toBe(0o600);
});

test("regenerates when the stored key pair is invalid", () => {
  const filePath = tempIdentityPath();
  const original = loadOrCreateDeviceIdentity(filePath);
  // Corrupt the stored private key so the self-check fails.
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      version: 1,
      deviceId: original.deviceId,
      publicKeyPem: original.publicKeyPem,
      privateKeyPem: "-----BEGIN PRIVATE KEY-----\nbroken\n-----END PRIVATE KEY-----\n",
      createdAtMs: Date.now(),
    }),
  );
  const regenerated = loadOrCreateDeviceIdentity(filePath);
  expect(regenerated.deviceId).not.toBe(original.deviceId);
  expect(regenerated.privateKeyPem).toContain("BEGIN PRIVATE KEY");
});

test("deviceId is the sha256-hex fingerprint of the raw public key", () => {
  const identity = loadOrCreateDeviceIdentity(tempIdentityPath());
  const rawB64Url = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
  const rawBytes = Buffer.from(
    rawB64Url.replaceAll("-", "+").replaceAll("_", "/"),
    "base64",
  );
  expect(rawBytes.length).toBe(32);
  const expected = crypto.createHash("sha256").update(rawBytes).digest("hex");
  expect(identity.deviceId).toBe(expected);
});

test("signDevicePayload produces a base64url signature the public key verifies", () => {
  const identity = loadOrCreateDeviceIdentity(tempIdentityPath());
  const payload = "device-auth-payload";
  const sigB64Url = signDevicePayload(identity.privateKeyPem, payload);
  expect(sigB64Url).not.toMatch(/[+/=]/); // base64url, no padding
  const sig = Buffer.from(sigB64Url.replaceAll("-", "+").replaceAll("_", "/"), "base64");
  const ok = crypto.verify(
    null,
    Buffer.from(payload, "utf8"),
    crypto.createPublicKey(identity.publicKeyPem),
    sig,
  );
  expect(ok).toBe(true);
});

test("resolveDeviceIdentityPath honors the env override and home default", () => {
  expect(resolveDeviceIdentityPath({ OPENCLAW_VOICE_ROOM_DEVICE_IDENTITY: "/x/y/id.json" })).toBe(
    "/x/y/id.json",
  );
  expect(resolveDeviceIdentityPath({})).toBe(
    path.join(os.homedir(), ".openclaw", "voice-room", "device-identity.json"),
  );
});
