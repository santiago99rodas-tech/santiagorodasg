import json, sys
# Transcribe la voz con tiempo por palabra (faster-whisper, gratis, corre local).
# Uso: python transcribir.py audio.mp3 transcripcion.json
from faster_whisper import WhisperModel
audio, salida = sys.argv[1], sys.argv[2]
import subprocess, numpy as np
pcm = subprocess.run(["ffmpeg","-v","error","-i",audio,"-ac","1","-ar","16000","-f","s16le","-"], capture_output=True, check=True).stdout
audio = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768.0
m = WhisperModel("medium", device="cpu", compute_type="int8")
segs, info = m.transcribe(audio, language="es", word_timestamps=True, vad_filter=False)
out = {"duracion": info.duration, "segmentos": []}
for s in segs:
    out["segmentos"].append({"s": round(s.start,2), "e": round(s.end,2), "texto": s.text.strip(),
        "palabras": [{"w": w.word.strip(), "s": round(w.start,2), "e": round(w.end,2)} for w in s.words]})
json.dump(out, open(salida, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("listo", info.duration, len(out["segmentos"]))
