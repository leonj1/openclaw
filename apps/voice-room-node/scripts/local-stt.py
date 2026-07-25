#!/usr/bin/env python3
"""Local STT helper: reads WAV on stdin, writes transcript on stdout.

Called by the voice-room-node to transcribe short verification clips
without touching ElevenLabs.  Uses a tiny Whisper model loaded once
and kept warm across invocations via a simple stdin loop.
"""

import sys
import json
import io
import wave
import struct
from pathlib import Path

import numpy as np

MODEL_SIZE = "tiny"  # tiny (75 MB), base (145 MB), small (488 MB)


def transcribe(model, wav_bytes: bytes) -> str:
    """Decode WAV bytes and run Whisper."""
    with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
        sampwidth = wf.getsampwidth()
        framerate = wf.getframerate()
        raw = wf.readframes(wf.getnframes())

    # Convert to float32 numpy array
    n = len(raw) // sampwidth
    if sampwidth == 2:
        samples = struct.unpack(f"<{n}h", raw)
    elif sampwidth == 4:
        samples = struct.unpack(f"<{n}i", raw)
    else:
        raise ValueError(f"unsupported sample width: {sampwidth}")
    audio = np.array(samples, dtype=np.float32) / 32768.0

    segments, _info = model.transcribe(audio, language="en")
    text = " ".join(seg.text.strip() for seg in segments)
    return text


def main() -> None:
    from faster_whisper import WhisperModel

    model = WhisperModel(
        MODEL_SIZE,
        device="cpu",
        compute_type="int8",
        download_root=str(Path.home() / ".cache" / "whisper"),
    )

    # Warm the model with a tiny dummy clip
    model.transcribe(np.zeros(16000, dtype=np.float32), language="en")
    print(json.dumps({"status": "ready"}), flush=True)

    # Stdin loop: each request is one line of JSON with a base64-encoded WAV
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            import base64
            wav_bytes = base64.b64decode(req["wav"])
            text = transcribe(model, wav_bytes)
            print(json.dumps({"ok": True, "text": text}), flush=True)
        except Exception as exc:
            print(json.dumps({"ok": False, "error": str(exc)}), flush=True)


if __name__ == "__main__":
    main()
