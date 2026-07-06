// Persistent Ed25519 device identity for the voice-room node's gateway connect.
//
// The v4 gateway requires `role:"node"` clients to present a signed device
// identity; for localhost it silently pairs a not-yet-paired device, but only
// when that signed identity is supplied. This module owns generating, persisting
// (0600, holds a private key), and reloading that identity, plus the two signing
// callbacks the `@openclaw/gateway-client` handshake calls.
//
// Encoding matches core exactly so the gateway verifies our signature:
//   - signDevicePayload -> src/infra/device-identity.ts:286 (Ed25519 sign, base64url no-pad)
//   - publicKeyRawBase64UrlFromPem -> src/infra/device-identity.ts:324 (raw 32 bytes, base64url)
//   - deviceId = sha256-hex of the raw public key -> src/infra/device-identity.ts:77
// This app is out-of-workspace and must not import core `src/**`, so the ~40
// lines of key/sign logic are replicated here against Node `crypto`.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

/** Ed25519 identity the gateway client signs the connect handshake with. */
export type DeviceIdentity = {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
};

// DER prefix for an Ed25519 SubjectPublicKeyInfo; stripping it yields the raw
// 32-byte public key the gateway expects. Mirrors src/infra/device-identity.ts:34.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const DEFAULT_IDENTITY_FILENAME = "device-identity.json";

// Persisted on-disk shape. Versioned so a future rotation can migrate cleanly.
const StoredIdentitySchema = z
  .object({
    version: z.literal(1),
    deviceId: z.string().min(1),
    publicKeyPem: z.string().min(1),
    privateKeyPem: z.string().min(1),
    createdAtMs: z.number(),
  })
  .strict();

type StoredIdentity = z.infer<typeof StoredIdentitySchema>;

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

// Export the raw 32 public-key bytes from a PEM by stripping the SPKI prefix.
// Matches src/infra/device-identity.ts:65 (derivePublicKeyRaw).
function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

// Stable device id: sha256-hex of the raw public key. Matches
// src/infra/device-identity.ts:77 (fingerprintPublicKey) so the id is
// reproducible from the key material alone.
function fingerprintPublicKey(publicKeyPem: string): string {
  return crypto.createHash("sha256").update(derivePublicKeyRaw(publicKeyPem)).digest("hex");
}

// Prove a stored key pair is internally consistent before trusting it, so a
// truncated/hand-edited file is regenerated rather than failing at connect time.
function keyPairMatches(publicKeyPem: string, privateKeyPem: string): boolean {
  try {
    const probe = Buffer.from("openclaw-voice-room-device-identity-self-check", "utf8");
    const signature = crypto.sign(null, probe, crypto.createPrivateKey(privateKeyPem));
    return crypto.verify(null, probe, crypto.createPublicKey(publicKeyPem), signature);
  } catch {
    return false;
  }
}

/**
 * Sign a UTF-8 payload with a PEM Ed25519 private key, returning base64url bytes.
 * Byte-for-byte identical to core's signer (src/infra/device-identity.ts:286);
 * the gateway verifies against this exact encoding.
 */
export function signDevicePayload(privateKeyPem: string, payload: string): string {
  const signature = crypto.sign(null, Buffer.from(payload, "utf8"), crypto.createPrivateKey(privateKeyPem));
  return base64UrlEncode(signature);
}

/**
 * Export a PEM Ed25519 public key as canonical raw base64url bytes.
 * Matches core (src/infra/device-identity.ts:324); this is the `publicKey` the
 * client sends in the connect handshake.
 */
export function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

function generateIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  return { deviceId: fingerprintPublicKey(publicKeyPem), publicKeyPem, privateKeyPem };
}

/** Resolve the identity file path: explicit env override wins, else the home default. */
export function resolveDeviceIdentityPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENCLAW_VOICE_ROOM_DEVICE_IDENTITY?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.join(os.homedir(), ".openclaw", "voice-room", DEFAULT_IDENTITY_FILENAME);
}

function readStoredIdentity(filePath: string): DeviceIdentity | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = StoredIdentitySchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }
  const stored: StoredIdentity = result.data;
  if (!keyPairMatches(stored.publicKeyPem, stored.privateKeyPem)) {
    return null;
  }
  // Re-derive the id from the key so a tampered `deviceId` field cannot lie.
  return {
    deviceId: fingerprintPublicKey(stored.publicKeyPem),
    publicKeyPem: stored.publicKeyPem,
    privateKeyPem: stored.privateKeyPem,
  };
}

// Persist with 0600 (file holds a private key). writeFileSync's mode only binds
// on creation, so chmod afterwards to force perms even if the file pre-existed.
function persistIdentity(filePath: string, identity: DeviceIdentity): void {
  const stored: StoredIdentity = {
    version: 1,
    deviceId: identity.deviceId,
    publicKeyPem: identity.publicKeyPem,
    privateKeyPem: identity.privateKeyPem,
    createdAtMs: Date.now(),
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

/**
 * Load the persisted device identity, or generate + persist a fresh one when the
 * file is absent or unusable. Returns the same identity on every subsequent call
 * for a given path, so the device stays paired across restarts.
 */
export function loadOrCreateDeviceIdentity(
  filePath: string = resolveDeviceIdentityPath(),
): DeviceIdentity {
  const existing = readStoredIdentity(filePath);
  if (existing) {
    return existing;
  }
  const identity = generateIdentity();
  persistIdentity(filePath, identity);
  return identity;
}
