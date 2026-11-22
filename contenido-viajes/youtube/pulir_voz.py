#!/usr/bin/env python3
"""Pule la voz cruda de Santiago: corta silencios y titubeos y la deja con sonido de estudio.

1. Detecta las pausas (ffmpeg silencedetect) y las acorta:
   - entre ideas (la palabra anterior termina en . ? !): queda 0.40 s
   - entre frases: queda 0.30 s
   - titubeos marcados a mano (--titubeo 28.0-29.0): queda 0.12 s
2. Une los tramos con fundidos de 15 ms (sin clics).
3. Cadena de sonido: filtro de graves (80 Hz), reducción de ruido con red neuronal (RNNoise, modelo
   libre reels/recursos/ruido/bd.rnnn; REGLA: toda voz de Santiago la lleva), menos "caja" (300 Hz),
   más presencia (3 kHz) y aire (10 kHz), de-esser, compresor y volumen estándar de YouTube
   (-14 LUFS integrado, pico -1.5 dB).

Uso:
  python pulir_voz.py cruda.ogg cruda.json voz-pulida.wav [--titubeo 28.0-29.0 ...] [--quitar 40.1-40.9 ...]
  (cruda.json = transcripción con tiempos por palabra de reels/transcribir.py)
"""
import argparse
import json
import os
import re
import subprocess
import sys


def pausas(audio):
    r = subprocess.run(["ffmpeg", "-hide_banner", "-i", audio, "-af", "highpass=f=80,silencedetect=n=-38dB:d=0.22",
                        "-f", "null", "-"], capture_output=True, text=True)
    ini = [float(x) for x in re.findall(r"silence_start: ([0-9.]+)", r.stderr)]
    fin = [float(x) for x in re.findall(r"silence_end: ([0-9.]+)", r.stderr)]
    return list(zip(ini, fin))


def duracion(audio):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", audio],
                       capture_output=True, text=True)
    return float(r.stdout.strip())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cruda")
    ap.add_argument("transcripcion")
    ap.add_argument("salida")
    ap.add_argument("--titubeo", nargs="*", default=[])
    ap.add_argument("--quitar", nargs="*", default=[], help="tramos a eliminar por completo (errores, repeticiones)")
    a = ap.parse_args()

    tr = json.load(open(a.transcripcion, encoding="utf-8"))
    palabras = [w for s in tr["segmentos"] for w in s["palabras"]]
    rango = lambda t: tuple(float(x) for x in t.split("-"))
    titubeos = [rango(t) for t in a.titubeo]
    quitar = [rango(t) for t in a.quitar]
    total = duracion(a.cruda)

    # tramos con voz = todo menos las pausas largas (acortadas)
    cortes = []  # (desde, hasta) de silencio que se elimina
    for s, e in pausas(a.cruda):
        if s < 0.3:  # silencio inicial: deja 0.1 s
            cortes.append((0, max(0, e - 0.1)))
            continue
        if e > total - 0.1:  # silencio final: deja 0.4 s
            cortes.append((s + 0.4, total))
            continue
        antes = [w for w in palabras if w["e"] <= s + 0.15]
        fin_idea = bool(antes) and antes[-1]["w"].rstrip().endswith((".", "?", "!"))
        dejar = 0.12 if any(t0 <= s + 0.1 and e - 0.1 <= t1 for t0, t1 in titubeos) else (0.40 if fin_idea else 0.30)
        if e - s > dejar + 0.05:
            m = (e - s - dejar) / 2
            cortes.append((s + dejar / 2, e - dejar / 2) if m > 0 else (s, s))
    cortes += quitar
    cortes.sort()
    tramos, t = [], 0.0
    for c0, c1 in cortes:
        if c0 > t + 0.02:
            tramos.append((t, c0))
        t = max(t, c1)
    if t < total - 0.02:
        tramos.append((t, total))

    f = 0.015
    partes = [f"[0:a]atrim={x:.3f}:{y:.3f},asetpts=PTS-STARTPTS,afade=t=in:d={f},afade=t=out:st={max(0, y - x - f):.3f}:d={f}[p{i}]"
              for i, (x, y) in enumerate(tramos)]
    unir = "".join(f"[p{i}]" for i in range(len(tramos))) + f"concat=n={len(tramos)}:v=0:a=1[cortada]"
    pulir = ("[cortada]highpass=f=80,arnndn=m=bd.rnnn:mix=0.85,"
             "equalizer=f=300:t=q:w=1.2:g=-2.5,equalizer=f=3000:t=q:w=1.0:g=3,equalizer=f=10000:t=q:w=0.8:g=2,"
             "deesser=i=0.35,acompressor=threshold=-20dB:ratio=3:attack=5:release=90:makeup=2,"
             "loudnorm=I=-14:TP=-1.5:LRA=7,aresample=48000,alimiter=limit=0.84:level=false[v]")
    grafo = ";".join(partes + [unir, pulir])
    ruido = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "reels", "recursos", "ruido")
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", os.path.abspath(a.cruda), "-filter_complex", grafo,
                    "-map", "[v]", "-ac", "1", "-c:a", "pcm_s16le", os.path.abspath(a.salida)], check=True, cwd=ruido)
    nueva = sum(y - x for x, y in tramos)
    print(f"voz pulida: {a.salida}  ({total:.1f} s -> {nueva:.1f} s, {len(tramos)} tramos)")
    json.dump({"tramos": tramos}, open(a.salida + ".tramos.json", "w"), indent=0)


if __name__ == "__main__":
    sys.exit(main())
