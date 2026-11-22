#!/usr/bin/env python3
"""Montaje base de un reel: muchas fotos y videos sobre la voz de Santiago.

Lee la lista de tomas del plan (clave "tomas") y arma un video vertical
1080x1920 a 30 fps, con:
  - fotos con movimiento (zoom lento hacia adentro/afuera o paneo), sin bordes negros
  - fotos horizontales recorridas con paneo lateral para llenar la pantalla vertical
  - videos recortados al centro (o donde diga "foco")
  - flash blanco corto en las tomas marcadas con "flash": true (cambio de lugar)
y le pone debajo la voz (plan["voz"]) y, si hay, música baja con ducking
(plan["musica"]): la música baja sola cuando Santiago habla.

El resultado es el "source" que luego decora editar.py (textos, stickers, sello...).

Uso:
  python montar.py plan.json base.mp4

Cada toma: {"archivo": "...", "inicio": 0.0, "fin": 2.4,
            "mov": "zoom_in" | "zoom_out" | "pan_izq" | "pan_der" | "pan_arriba" | "pan_abajo" | "fijo",
            "foco": [0.5, 0.5],   # punto de interés (x, y) de 0 a 1; centro por defecto
            "desde": 3.0,         # sólo videos: segundo del clip donde empieza
            "flash": false}
Necesita ffmpeg y Pillow (para girar las fotos según el EXIF).
"""
import json
import os
import subprocess
import sys
import tempfile

W, H, FPS = 1080, 1920, 30
FOTOS = (".jpg", ".jpeg", ".png", ".webp", ".heic")


def run(cmd):
    subprocess.run(cmd, check=True)


def foto_derecha(path, tmp, i):
    """Aplica la rotación EXIF y deja la foto en un tamaño manejable (lado largo 3000 px)."""
    from PIL import Image, ImageOps
    im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    im.thumbnail((3000, 3000))
    out = os.path.join(tmp, f"foto{i}.jpg")
    im.save(out, quality=92)
    return out, im.size


def tramo_foto(t, src, size, dur, out):
    """Foto -> clip con movimiento. Se escala a 'cubrir' 1080x1920 con margen y se mueve el recorte."""
    iw, ih = size
    n = max(1, round(dur * FPS))
    mov = t.get("mov", "zoom_in")
    fx, fy = t.get("foco", [0.5, 0.5])
    extra = 1.18  # margen para moverse sin mostrar bordes
    esc = max(W / iw, H / ih) * extra
    sw, sh = int(iw * esc) // 2 * 2, int(ih * esc) // 2 * 2
    mx, my = sw - W, sh - H  # cuánto se puede mover el recorte
    cx, cy = min(max(fx * sw - W / 2, 0), mx), min(max(fy * sh - H / 2, 0), my)
    p = f"(n/{n})"  # progreso 0..1
    ease = f"(0.5-0.5*cos(PI*{p}))"
    if mov in ("zoom_in", "zoom_out"):
        z0, z1 = (1.0, 1.12) if mov == "zoom_in" else (1.12, 1.0)
        z = f"({z0}+({z1}-{z0})*{ease})"
        # se escala por cuadro y se recorta alrededor del foco
        vf = (f"scale={sw}:{sh},scale=w='trunc({sw}*{z}/2)*2':h='trunc({sh}*{z}/2)*2':eval=frame,"
              f"crop={W}:{H}:x='min(max({fx}*iw-{W}/2,0),iw-{W})':y='min(max({fy}*ih-{H}/2,0),ih-{H})'")
    else:
        if mov == "pan_izq":
            x, y = f"{mx}*(1-{ease})", f"{cy}"
        elif mov == "pan_der":
            x, y = f"{mx}*{ease}", f"{cy}"
        elif mov == "pan_arriba":
            x, y = f"{cx}", f"{my}*(1-{ease})"
        elif mov == "pan_abajo":
            x, y = f"{cx}", f"{my}*{ease}"
        else:  # fijo
            x, y = f"{cx}", f"{cy}"
        vf = f"scale={sw}:{sh},crop={W}:{H}:x='{x}':y='{y}'"
    vf += f",fps={FPS},format=yuv420p,setsar=1"
    if t.get("flash"):
        vf += ",fade=t=in:st=0:d=0.18:color=white"
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-loop", "1", "-framerate", str(FPS),
         "-i", src, "-frames:v", str(n), "-vf", vf, "-an", "-c:v", "libx264", "-preset", "veryfast",
         "-crf", "17", out])


def tramo_video(t, dur, out):
    fx, fy = t.get("foco", [0.5, 0.5])
    vf = (f"scale={W}:{H}:force_original_aspect_ratio=increase,"
          f"crop={W}:{H}:x='(iw-{W})*{fx}':y='(ih-{H})*{fy}',fps={FPS},format=yuv420p,setsar=1")
    if t.get("flash"):
        vf += ",fade=t=in:st=0:d=0.18:color=white"
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", str(t.get("desde", 0)),
         "-i", t["archivo"], "-t", f"{dur:.3f}", "-vf", vf, "-an", "-c:v", "libx264",
         "-preset", "veryfast", "-crf", "17", out])


def montar(plan, salida):
    tmp = tempfile.mkdtemp()
    partes = []
    for i, t in enumerate(plan["tomas"]):
        dur = t["fin"] - t["inicio"]
        out = os.path.join(tmp, f"t{i:03d}.mp4")
        if t["archivo"].lower().endswith(FOTOS):
            src, size = foto_derecha(t["archivo"], tmp, i)
            tramo_foto(t, src, size, dur, out)
        else:
            tramo_video(t, dur, out)
        partes.append(out)
    lista = os.path.join(tmp, "lista.txt")
    with open(lista, "w", encoding="utf-8") as f:
        f.writelines(f"file '{p.replace(os.sep, '/')}'\n" for p in partes)
    video = os.path.join(tmp, "video.mp4")
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0",
         "-i", lista, "-c", "copy", video])

    dur = plan["duracion"]
    voz = plan["voz"]
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", video, "-i", voz]
    if plan.get("musica"):
        cmd += ["-stream_loop", "-1", "-i", plan["musica"]]
        vol = plan.get("volumen_musica", 0.18)
        graph = (f"[1:a]aformat=channel_layouts=stereo,asplit=2[v1][v2];"
                 f"[2:a]aformat=channel_layouts=stereo,volume={vol}[m];"
                 f"[m][v2]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[md];"
                 f"[v1][md]amix=inputs=2:normalize=0,atrim=0:{dur}[a]")
    else:
        graph = f"[1:a]aformat=channel_layouts=stereo,apad,atrim=0:{dur}[a]"
    cmd += ["-filter_complex", graph, "-map", "0:v", "-map", "[a]", "-t", str(dur),
            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", salida]
    run(cmd)
    print(f"base lista: {salida}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    with open(sys.argv[1], encoding="utf-8") as f:
        montar(json.load(f), sys.argv[2])
