// Minimal canonical (PCM) WAV read/write for the voice-room node.
//
// Only the node's one format matters here — PCM16 / 24kHz / mono — but the
// parser reads the header fields so `format-check` can reject anything that
// drifts off that format. Kept tiny and dependency-free; not a general WAV lib.
import fs from "node:fs";

export interface WavFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

export interface WavData extends WavFormat {
  // Raw little-endian PCM sample bytes (the `data` chunk payload).
  pcm: Buffer;
}

const RIFF = "RIFF";
const WAVE = "WAVE";
const FMT_ = "fmt ";
const DATA = "data";
const PCM_AUDIO_FORMAT = 1;

// Builds a canonical 44-byte-header PCM WAV around the given samples.
export function encodeWav(data: WavData): Buffer {
  const { sampleRate, channels, bitsPerSample, pcm } = data;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write(RIFF, 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write(WAVE, 8, "ascii");
  header.write(FMT_, 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(PCM_AUDIO_FORMAT, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write(DATA, 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export type WavParseResult =
  | { ok: true; wav: WavData }
  | { ok: false; error: string };

// Walks the RIFF chunks to read `fmt ` and `data`. Tolerates extra chunks
// (LIST/fact) that recorders sometimes insert before `data`.
export function parseWav(buffer: Buffer): WavParseResult {
  if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== RIFF) {
    return { ok: false, error: "not a RIFF file" };
  }
  if (buffer.toString("ascii", 8, 12) !== WAVE) {
    return { ok: false, error: "not a WAVE file" };
  }
  let offset = 12;
  let format: WavFormat | undefined;
  let pcm: Buffer | undefined;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === FMT_) {
      const audioFormat = buffer.readUInt16LE(body);
      if (audioFormat !== PCM_AUDIO_FORMAT) {
        return { ok: false, error: `non-PCM audio format ${audioFormat}` };
      }
      format = {
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === DATA) {
      pcm = buffer.subarray(body, body + size);
    }
    // Chunks are word-aligned: an odd size carries a trailing pad byte.
    offset = body + size + (size % 2);
  }
  if (!format) {
    return { ok: false, error: "missing fmt chunk" };
  }
  if (!pcm) {
    return { ok: false, error: "missing data chunk" };
  }
  return { ok: true, wav: { ...format, pcm } };
}

// Splits a raw PCM buffer into fixed byte-size frames, each base64-encoded (the
// wire form playback.enqueue expects). A trailing partial frame (< frameBytes)
// is dropped so every frame is a whole set of samples. Shared by the wait-loop
// and TTS paths, which both stream PCM into playback frame by frame.
export function framePcmToBase64(pcm: Buffer, frameBytes: number): string[] {
  if (frameBytes <= 0) {
    throw new Error(`framePcmToBase64: frameBytes must be positive, got ${frameBytes}`);
  }
  const frames: string[] = [];
  for (let offset = 0; offset + frameBytes <= pcm.length; offset += frameBytes) {
    frames.push(pcm.subarray(offset, offset + frameBytes).toString("base64"));
  }
  return frames;
}

export function readWavFile(path: string): WavParseResult {
  return parseWav(fs.readFileSync(path));
}

export function writeWavFile(path: string, data: WavData): void {
  fs.writeFileSync(path, encodeWav(data));
}
