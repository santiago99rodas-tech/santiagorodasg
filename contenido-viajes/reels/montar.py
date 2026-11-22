#!/usr/bin/env python3
"""Montaje base de un reel: muchas fotos y videos sobre la voz de Santiago.

Lee la lista de tomas del plan (clave "tomas") y arma un video vertical
1080x1920 a 30 fps, con:
  - fotos con movimiento (zoom hacia adentro/afuera o paneo), sin bordes negros
  - videos recortados al centro (o donde diga "foco")
  - pantalla dividida (dos fotos, una arriba y otra abajo): "dividida": [arriba, abajo]
  - transiciones entre tomas (xfade): barrido suave, zoom, desenfoque, flash blanco...
  - color cálido de cine, viñeta y grano de película (plan["color"], activado por defecto)
y debajo la voz (plan["voz"], con reducción de ruido automática) y la música con ducking (plan["musica"]): la música
baja sola cuando Santiago habla y sube en los silencios.

El resultado es el "source" que luego decora editar.py (textos, sello, mapa...).

Uso:
  python montar.py plan.json base.mp4

Cada toma: {"archivo": "...", "inicio": 0.0, "fin": 2.4,
            "mov": "zoom_in" | "zoom_out" | "pan_izq" | "pan_der" | "pan_arriba" | "pan_abajo" | "fijo",
            "foco": [0.5, 0.5],      # punto de interés (x, y) de 0 a 1
            "desde": 3.0,            # sólo videos: segundo del clip donde empieza
            "trans": "smoothleft",   # transición de ENTRADA a esta toma (nombres de xfade)
            "dividida": ["a.jpg", "b.jpg"]}  # en lugar de "archivo"
Necesita ffmpeg y Pillow.
"""
import json
import os
import subprocess
import sys
import tempfile

W, H, FPS = 1080, 1920, 30
TD = 0.3  # duración de cada transición (s)
FOTOS = (".jpg", ".jpeg", ".png", ".webp")
TRANS_ROTACION = ["smoothleft", "zoomin", "smoothup", "hblur", "smoothright", "slideleft"]


RUIDO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "recursos", "ruido")
# REGLA: toda voz de Santiago lleva reducción de ruido (red neuronal RNNoise, modelo libre "bd").
# ffmpeg corre dentro de recursos/ruido para que el filtro encuentre el modelo (en Windows "C:" rompe el filtro).
LIMPIAR_VOZ = "highpass=f=80,arnndn=m=bd.rnnn:mix=0.85"


def run(cmd, cwd=None):
    subprocess.run(cmd, check=True, cwd=cwd)


def foto_derecha(path, tmp, tag):
    from PIL import Image, ImageOps
    im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    im.thumbnail((3000, 3000))
    out = os.path.join(tmp, f"foto{tag}.jpg")
    im.save(out, quality=92)
    return out, im.size


def filtro_foto(t, size, n, w, h):
    """Cadena de filtros que convierte una foto en un clip w x h con movimiento."""
    iw, ih = size
    mov = t.get("mov", "zoom_in")
    fx, fy = t.get("foco", [0.5, 0.5])
    extra = 1.25
    esc = max(w / iw, h / ih) * extra
    sw, sh = int(iw * esc) // 2 * 2, int(ih * esc) // 2 * 2
    mx, my = sw - w, sh - h
    cx, cy = min(max(fx * sw - w / 2, 0), mx), min(max(fy * sh - h / 2, 0), my)
    p = f"(n/{n})"
    ease = f"(1-pow(1-{p},2))"  # arranca rápido y frena: se siente más vivo
    if mov in ("zoom_in", "zoom_out"):
        z0, z1 = (1.0, 1.2) if mov == "zoom_in" else (1.2, 1.0)
        z = f"({z0}+({z1}-{z0})*{ease})"
        return (f"scale={sw}:{sh},scale=w='trunc({sw}*{z}/2)*2':h='trunc({sh}*{z}/2)*2':eval=frame,"
                f"crop={w}:{h}:x='min(max({fx}*iw-{w}/2,0),iw-{w})':y='min(max({fy}*ih-{h}/2,0),ih-{h})'")
    if mov == "pan_izq":
        x, y = f"{mx}*(1-{ease})", f"{cy}"
    elif mov == "pan_der":
        x, y = f"{mx}*{ease}", f"{cy}"
    elif mov == "pan_arriba":
        x, y = f"{cx}", f"{my}*(1-{ease})"
    elif mov == "pan_abajo":
        x, y = f"{cx}", f"{my}*{ease}"
    else:
        x, y = f"{cx}", f"{cy}"
    return f"scale={sw}:{sh},crop={w}:{h}:x='{x}':y='{y}'"


def tramo(t, dur, out, tmp, i):
    n = max(2, round(dur * FPS))
    enc = ["-frames:v", str(n), "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16",
           "-pix_fmt", "yuv420p", "-r", str(FPS), out]
    if "dividida" in t:
        a, sa = foto_derecha(t["dividida"][0], tmp, f"{i}a")
        b, sb = foto_derecha(t["dividida"][1], tmp, f"{i}b")
        ta = dict(t, mov=t.get("mov", "zoom_in"), foco=t.get("foco", [0.5, 0.5]))
        tb = dict(t, mov=t.get("mov2", "zoom_out"), foco=t.get("foco2", [0.5, 0.5]))
        h2 = H // 2
        graph = (f"[0:v]{filtro_foto(ta, sa, n, W, h2)},setsar=1[a];"
                 f"[1:v]{filtro_foto(tb, sb, n, W, h2)},setsar=1[b];"
                 f"[a][b]vstack,drawbox=x=0:y={h2-4}:w={W}:h=8:color=white@0.95:t=fill,fps={FPS}[v]")
        run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
             "-loop", "1", "-framerate", str(FPS), "-i", a, "-loop", "1", "-framerate", str(FPS), "-i", b,
             "-filter_complex", graph, "-map", "[v]", *enc])
    elif t["archivo"].lower().endswith(FOTOS):
        src, size = foto_derecha(t["archivo"], tmp, i)
        vf = filtro_foto(t, size, n, W, H) + f",fps={FPS},setsar=1"
        run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-loop", "1", "-framerate", str(FPS),
             "-i", src, "-vf", vf, *enc])
    else:
        fx, fy = t.get("foco", [0.5, 0.5])
        vf = (f"scale={W}:{H}:force_original_aspect_ratio=increase,"
              f"crop={W}:{H}:x='(iw-{W})*{fx}':y='(ih-{H})*{fy}',fps={FPS},setsar=1")
        run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", str(t.get("desde", 0)),
             "-i", t["archivo"], "-vf", vf, *enc])


def montar(plan, salida):
    tmp = tempfile.mkdtemp()
    tomas, dur = plan["tomas"], plan["duracion"]
    starts = [t["inicio"] for t in tomas]
    partes, largos = [], []
    for i, t in enumerate(tomas):
        # largo de cada clip para que el corte (mitad de la transición) caiga en t["inicio"]
        a = 0 if i == 0 else starts[i] - TD / 2
        b = (starts[i + 1] + TD / 2) if i + 1 < len(tomas) else dur
        out = os.path.join(tmp, f"t{i:03d}.mp4")
        tramo(t, b - a, out, tmp, i)
        partes.append(out)
        largos.append(b - a)

    # cadena de xfade
    inputs, graph, prev, rot = [], [], "[0:v]", 0
    for p in partes:
        inputs += ["-i", p]
    for i in range(1, len(partes)):
        t = tomas[i]
        tr = t.get("trans") or ("fadewhite" if t.get("flash") else TRANS_ROTACION[rot % len(TRANS_ROTACION)])
        rot += 1
        off = starts[i] - TD / 2
        graph.append(f"{prev}[{i}:v]xfade=transition={tr}:duration={TD}:offset={off:.3f}[x{i}]")
        prev = f"[x{i}]"
    color = plan.get("color", True)
    final = prev
    if color:
        # REGLA: color cálido y luminoso (golden hour), nunca oscuro: gamma >1, viñeta suave, grano leve
        graph.append(f"{prev}eq=contrast=1.04:saturation=1.12:gamma=1.08:brightness=0.02,"
                     f"colorbalance=rs=0.06:gs=0.02:bs=-0.07:rm=0.06:gm=0.01:bm=-0.06:rh=0.04:bh=-0.05,"
                     f"vignette=angle=PI/7,noise=alls=4:allf=t+u,format=yuv420p[vf]")
        final = "[vf]"
    video = os.path.join(tmp, "video.mp4")
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *inputs,
         "-filter_complex", ";".join(graph), "-map", final, "-t", str(dur),
         "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", video])

    # audio: voz + música con ducking
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", video, "-i", plan["voz"]]
    vd = plan.get("retraso_voz", 0)
    limpiar = LIMPIAR_VOZ + "," if plan.get("limpiar_voz", True) else ""
    voz = f"[1:a]{limpiar}aformat=channel_layouts=stereo,adelay={int(vd*1000)}|{int(vd*1000)},volume={plan.get('volumen_voz', 1.0)},apad"
    if plan.get("musica"):
        cmd += ["-stream_loop", "-1", "-i", plan["musica"]]
        vol = plan.get("volumen_musica", 0.5)
        ss = plan.get("musica_desde", 0)
        graph = (f"{voz},asplit=2[v1][v2];"
                 f"[2:a]atrim=start={ss},asetpts=PTS-STARTPTS,aformat=channel_layouts=stereo,volume={vol},"
                 f"afade=t=out:st={dur-2.5}:d=2.5[m];"
                 f"[m][v2]sidechaincompress=threshold=0.03:ratio={plan.get('ducking_ratio', 6)}:attack=30:release=600:makeup=1[md];"
                 f"[v1][md]amix=inputs=2:normalize=0,atrim=0:{dur}[a]")
    else:
        graph = f"{voz},atrim=0:{dur}[a]"
    cmd += ["-filter_complex", graph, "-map", "0:v", "-map", "[a]", "-t", str(dur),
            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", os.path.abspath(salida)]
    run(cmd, cwd=RUIDO)
    print(f"base lista: {salida}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    with open(sys.argv[1], encoding="utf-8") as f:
        montar(json.load(f), sys.argv[2])
