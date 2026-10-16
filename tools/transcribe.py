# /// script
# requires-python = ">=3.12"
# dependencies = ["faster-whisper==1.2.1", "numpy", "nvidia-cublas-cu12", "nvidia-cudnn-cu12==9.*"]
# ///
"""Transcribe one audio file to plain text on stdout (English, GPU)."""
import ctypes
import glob
import os
import subprocess
import sys

import numpy as np
import nvidia.cublas
import nvidia.cudnn
from faster_whisper import WhisperModel

# No system CUDA here: load the pip-shipped cuBLAS/cuDNN before ctranslate2 looks for them.
for pkg in (nvidia.cublas, nvidia.cudnn):
    for lib in sorted(glob.glob(os.path.join(pkg.__path__[0], "lib", "lib*.so*"))):
        ctypes.CDLL(lib, mode=ctypes.RTLD_GLOBAL)

model = WhisperModel("large-v3-turbo", device="cuda", compute_type="float16")

# faster-whisper builds the spectrogram of everything it is handed in one go, about 2.6 GB per
# hour of speech: a 9-hour livestream took 18 GB. So decode and transcribe in 10-minute pieces,
# which keeps memory flat however long the video is. A word cut at a boundary costs one word.
# Decoding goes through ffmpeg, not PyAV: faster-whisper's PyAV call breaks on current av releases.
PIECE_BYTES = 10 * 60 * 16000 * 4  # f32le, mono, 16 kHz
with subprocess.Popen(
    ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", sys.argv[1], "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
    stdout=subprocess.PIPE,
) as ffmpeg:
    while pcm := ffmpeg.stdout.read(PIECE_BYTES):
        segments, _ = model.transcribe(np.frombuffer(pcm, dtype=np.float32), language="en", vad_filter=True)
        for segment in segments:
            print(segment.text.strip(), flush=True)
if ffmpeg.returncode:
    sys.exit(f"ffmpeg exited {ffmpeg.returncode}")
