# /// script
# requires-python = ">=3.12"
# dependencies = ["faster-whisper==1.2.1", "numpy", "nvidia-cublas-cu12", "nvidia-cudnn-cu12==9.*"]
# ///
"""Piece size of transcribe.py, with the model stubbed (no GPU, no download):
`uv run --script tools/test_transcribe.py [path/to/transcribe.py]`.

faster-whisper's memory grows with the length of what one transcribe() call is handed, so no
call may get more than the piece length, and the pieces must add up to the whole file.
"""
import os
import runpy
import subprocess
import sys
import tempfile

import faster_whisper

SAMPLE_RATE = 16000
MINUTES = 25
MAX_PIECE_SAMPLES = 10 * 60 * SAMPLE_RATE

script = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "transcribe.py")
sizes: list[int] = []


class StubModel:
    def __init__(self, *_args, **_kwargs):
        pass

    def transcribe(self, audio, **_kwargs):
        sizes.append(len(audio))
        return iter(()), None


faster_whisper.WhisperModel = StubModel
with tempfile.TemporaryDirectory() as tmp:
    path = os.path.join(tmp, "silence.wav")
    subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", f"anullsrc=r={SAMPLE_RATE}:cl=mono",
         "-t", str(MINUTES * 60), path],
        check=True,
    )
    sys.argv = [script, path]
    runpy.run_path(script, run_name="__main__")

assert max(sizes) <= MAX_PIECE_SAMPLES, f"a call got {max(sizes) / SAMPLE_RATE / 60:.1f} min of audio"
assert abs(sum(sizes) - MINUTES * 60 * SAMPLE_RATE) < SAMPLE_RATE, f"pieces cover {sum(sizes)} samples"
print(f"ok: {len(sizes)} pieces, largest {max(sizes) / SAMPLE_RATE / 60:.1f} min")
