import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { encodeWav, parseWav, readWavFile } from "../../src/audio/wav.ts";

// The node-wide fixture format: PCM16 / 24kHz / mono. Any wake/non-wake clip
// that drifts off this must fail the check.
const EXPECTED = { sampleRate: 24_000, channels: 1, bitsPerSample: 16 } as const;

const fixturesDir = path.dirname(fileURLToPath(import.meta.url));

function wavFiles(): string[] {
  return fs
    .readdirSync(fixturesDir)
    .filter((f) => f.toLowerCase().endsWith(".wav"))
    .sort();
}

describe("fixture WAV format", () => {
  const files = wavFiles();

  it("has at least one fixture WAV to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s is PCM16 24kHz mono", (name) => {
    const result = readWavFile(path.join(fixturesDir, name));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.wav.sampleRate).toBe(EXPECTED.sampleRate);
    expect(result.wav.channels).toBe(EXPECTED.channels);
    expect(result.wav.bitsPerSample).toBe(EXPECTED.bitsPerSample);
    // A whole number of PCM16 mono samples (no split sample at the tail).
    expect(result.wav.pcm.length % (EXPECTED.bitsPerSample / 8)).toBe(0);
  });
});

// Guard the guard: a deliberately malformed WAV (wrong rate / stereo / 8-bit)
// must be rejected, proving the check fails for off-format audio.
describe("format-check rejects malformed WAV", () => {
  const tmp: string[] = [];
  afterEach(() => {
    for (const f of tmp.splice(0)) {
      fs.rmSync(f, { force: true });
    }
  });

  it("flags a 16kHz stereo 8-bit clip as off-format", () => {
    const bad = encodeWav({
      sampleRate: 16_000,
      channels: 2,
      bitsPerSample: 8,
      pcm: Buffer.alloc(320),
    });
    const parsed = parseWav(bad);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const matches =
      parsed.wav.sampleRate === EXPECTED.sampleRate &&
      parsed.wav.channels === EXPECTED.channels &&
      parsed.wav.bitsPerSample === EXPECTED.bitsPerSample;
    expect(matches).toBe(false);
  });

  it("rejects a non-RIFF blob", () => {
    const parsed = parseWav(Buffer.from("this is not a wav file"));
    expect(parsed.ok).toBe(false);
  });
});
