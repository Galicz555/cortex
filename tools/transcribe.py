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

# Decoding goes through ffmpeg, not PyAV: faster-whisper's PyAV call breaks on current av releases.
pcm = subprocess.run(
    ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", sys.argv[1], "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
    check=True,
    capture_output=True,
).stdout
audio = np.frombuffer(pcm, dtype=np.float32)

# No system CUDA here: load the pip-shipped cuBLAS/cuDNN before ctranslate2 looks for them.
for pkg in (nvidia.cublas, nvidia.cudnn):
    for lib in sorted(glob.glob(os.path.join(pkg.__path__[0], "lib", "lib*.so*"))):
        ctypes.CDLL(lib, mode=ctypes.RTLD_GLOBAL)

model = WhisperModel("large-v3-turbo", device="cuda", compute_type="float16")
segments, _ = model.transcribe(audio, language="en", vad_filter=True)
for s in segments:
    print(s.text.strip())
