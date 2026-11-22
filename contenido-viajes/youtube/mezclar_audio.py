#!/usr/bin/env python3
"""Mezcla final de audio de un video de YouTube y la une al video renderizado (sin audio) de Remotion.

Mismas reglas que los reels (docs/09-reglas-reels.md):
  - la voz (ya pulida con pulir_voz.py) va al frente
  - música inspiradora ~10 dB por debajo de la voz mientras habla (sidechain suave) y sube en los silencios
  - efectos con lógica, en un bus que también baja solo cuando Santiago habla
  - limitador final (pico <= -1 dB)

Uso:
  python mezclar_audio.py plan_audio.json video-sin-audio.mp4 salida.mp4
plan_audio.json: {"voz": "...wav", "musica": "...mp3", "volumen_musica": 0.9, "duracion": 70.6,
                  "sfx": [{"t": 2.6, "tipo": "impacto2", "vol": 0.5, "dur": 2}, ...]}
Los efectos se buscan en ../reels/recursos/sfx/<tipo>.mp3
"""
import json
import os
import subprocess
import sys

SFX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "reels", "recursos", "sfx")


def main(plan_path, video, salida):
    p = json.load(open(plan_path, encoding="utf-8"))
    dur = p["duracion"]
    ins = ["-i", video, "-i", p["voz"], "-stream_loop", "-1", "-i", p["musica"]]
    g = [
        "[1:a]aformat=sample_rates=48000:channel_layouts=stereo,apad,asplit=3[v][k1][k2]",
        f"[2:a]aformat=sample_rates=48000:channel_layouts=stereo,volume={p.get('volumen_musica', 0.9)},"
        f"afade=t=in:d=1.5,afade=t=out:st={dur - 2.5}:d=2.5[m]",
        "[m][k1]sidechaincompress=threshold=0.03:ratio=2.5:attack=30:release=600:makeup=1[md]",
    ]
    etiquetas = []
    for i, s in enumerate(sorted(p["sfx"], key=lambda x: x["t"])):
        f = os.path.join(SFX, s["tipo"] + ".mp3")
        if not os.path.isfile(f):
            raise FileNotFoundError(f)
        ins += ["-i", f]
        k = 3 + i
        d = s.get("dur", 2)
        ms = int(s["t"] * 1000)
        g.append(f"[{k}:a]atrim=0:{d},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,"
                 f"afade=t=in:d={s.get('entra', 0.01)},afade=t=out:st={max(0, d - 0.3)}:d=0.3,volume={s.get('vol', 0.5)},"
                 f"adelay={ms}|{ms}[s{i}]")
        etiquetas.append(f"[s{i}]")
    g.append("".join(etiquetas) + f"amix=inputs={len(etiquetas)}:normalize=0[sb]")
    g.append("[sb][k2]sidechaincompress=threshold=0.08:ratio=2.5:attack=5:release=300:makeup=1[sd]")
    g.append(f"[v][md][sd]amix=inputs=3:normalize=0,alimiter=limit=0.89:level=false,atrim=0:{dur}[a]")
    with open(salida + ".grafo.txt", "w", encoding="utf-8") as fh:
        fh.write(";\n".join(g))
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *ins, "-/filter_complex", salida + ".grafo.txt",
                    "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", str(dur),
                    "-movflags", "+faststart", salida], check=True)
    os.remove(salida + ".grafo.txt")
    print("listo:", salida)


if __name__ == "__main__":
    main(*sys.argv[1:4])
