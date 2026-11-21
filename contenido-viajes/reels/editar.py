#!/usr/bin/env python3
"""Editor de reels/TikToks estilo "talking head + motion text".

Toma un plan de edicion en JSON (lo escribe Claude a partir del guion o la
transcripcion) y un clip vertical, y renderiza el video final con:

  - gancho de texto grande con mezcla de tipografias (sans negra + serif italica)
  - subtitulos palabra por palabra (una sola palabra en pantalla, como el referente)
  - segmentos "camara 2": blanco y negro + marco de grabadora (REC, 4K 60FPS)
  - zoom de golpe (punch-in) para simular cambio de camara
  - stickers / etiquetas de color que aparecen con rebote
  - tarjeta de llamado a la accion ("comenta RUTA")
  - efectos de sonido sintetizados (whoosh, pop, click, obturador) en cada evento

Uso:
  python3 editar.py plan.json salida.mp4            # usa plan["source"]
  python3 editar.py plan.json salida.mp4 --demo     # fondo de prueba si no hay clip

Solo necesita ffmpeg (con libass). Sin dependencias de Python.
"""
import json
import os
import subprocess
import sys
import tempfile

W, H = 1080, 1920


# ---------------------------------------------------------------- utilidades
def ts(t):
    """segundos -> h:mm:ss.cc para ASS"""
    cs = int(round(t * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def bgr(hexcolor):
    """#RRGGBB -> &H00BBGGRR (formato ASS)"""
    h = hexcolor.lstrip("#")
    return f"&H00{h[4:6]}{h[2:4]}{h[0:2]}".upper()


POP = r"\fscx40\fscy40\t(0,120,\fscx112\fscy112)\t(120,220,\fscx100\fscy100)"
FADE = r"\fad(0,120)"


# ---------------------------------------------------------------- estilos ASS
def header(brand):
    acc = bgr(brand["acento"])
    white = "&H00FFFFFF"
    dark = bgr(brand["oscuro"])
    sans, serif = brand["fuente_sans"], brand["fuente_serif"]
    texto = brand.get("fuente_texto", "Montserrat")
    styles = [
        # Nombre, fuente, tamano, color, negrita, italica, borde, sombra
        # Bebas Neue (principal) no tiene negrita: Bold=0 para no deformarla
        ("Sans", sans, 120, white, 0, 0, 0, 3),
        ("SansDark", sans, 120, dark, 0, 0, 0, 0),
        ("Big", sans, 260, acc, 0, 0, 0, 4),
        ("Serif", serif, 120, white, 0, -1, 0, 3),
        ("SerifAcc", serif, 130, acc, -1, -1, 0, 3),
        ("Word", sans, 96, white, 0, 0, 0, 3),
        ("Tag", texto, 50, dark, -1, 0, 0, 0),
        ("Rec", texto, 40, white, -1, 0, 0, 0),
        ("Shape", texto, 20, white, 0, 0, 0, 0),
    ]
    out = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {W}",
        f"PlayResY: {H}",
        "WrapStyle: 2",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, "
        "Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ]
    for n, f, s, c, b, i, o, sh in styles:
        out.append(
            f"Style: {n},{f},{s},{c},{c},&H00000000,&H80000000,{b},{i},0,0,100,100,-2,0,1,{o},{sh},5,40,40,40,1"
        )
    out += ["", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"]
    return out


def dia(layer, a, b, style, text):
    return f"Dialogue: {layer},{ts(a)},{ts(b)},{style},,0,0,0,,{text}"


# ---------------------------------------------------------------- eventos
def ev_hook(e, out):
    """Titulo de gancho: lineas apiladas que entran una por una con rebote."""
    y = e.get("y", 330)
    gap = e.get("intervalo", 0.18)
    sizes = {"sans": 190, "big": 400, "serif": 150, "serifacc": 165, "sansdark": 190}
    styles = {"sans": "Sans", "big": "Big", "serif": "Serif", "serifacc": "SerifAcc", "sansdark": "SansDark"}
    for i, ln in enumerate(e["lineas"]):
        st = ln.get("estilo", "sans")
        size = ln.get("tam", sizes[st])
        y += size * 0.5
        t0 = e["inicio"] + i * gap
        out.append(dia(5, t0, e["fin"], styles[st], f"{{\\pos({W//2},{int(y)})\\fs{size}{POP}{FADE}}}{ln['t']}"))
        y += size * 0.5 - size * 0.12


def ev_words(e, out):
    """Subtitulos de una palabra (o par corto) al centro, cambian al ritmo del habla."""
    words = e.get("palabras")
    if not words:  # sin marcas de tiempo: reparte las palabras parejo
        toks = e["texto"].split()
        d = (e["fin"] - e["inicio"]) / len(toks)
        words = [{"w": w, "s": e["inicio"] + k * d, "e": e["inicio"] + (k + 1) * d} for k, w in enumerate(toks)]
    resaltar = {w.lower() for w in e.get("resaltar", [])}
    y = e.get("y", 1080)
    for w in words:
        clean = w["w"].strip(",.!?¡¿").lower()
        color = r"\1c" + bgr(e["_acento"]) if clean in resaltar else ""
        out.append(dia(4, w["s"], w["e"], "Word", f"{{\\pos({W//2},{y}){color}\\fscx85\\fscy85\\t(0,80,\\fscx100\\fscy100)}}{w['w']}"))


def ev_rec(e, out):
    """Marco de camara de grabadora para los segmentos en blanco y negro."""
    a, b = e["inicio"], e["fin"]
    m, L, T = 50, 110, 6  # margen, largo de esquina, grosor
    corners = [
        (m, m, L, T), (m, m, T, L),
        (W - m - L, m, L, T), (W - m - T, m, T, L),
        (m, H - m - T, L, T), (m, H - m - L, T, L),
        (W - m - L, H - m - T, L, T), (W - m - T, H - m - L, T, L),
    ]
    for x, y, w, h in corners:
        out.append(dia(6, a, b, "Shape", f"{{\\an7\\pos({x},{y})\\p1}}m 0 0 l {w} 0 {w} {h} 0 {h}{{\\p0}}"))
    # punto rojo que parpadea + REC
    blink = "".join(f"\\t({k*1000},{k*1000+500},\\alpha&HFF&)\\t({k*1000+500},{k*1000+520},\\alpha&H00&)" for k in range(int(b - a) + 1))
    out.append(dia(6, a, b, "Shape", f"{{\\an7\\pos({W-m-170},{m+40})\\1c&H0000E0&{blink}\\p1}}m 12 0 b 19 0 24 5 24 12 b 24 19 19 24 12 24 b 5 24 0 19 0 12 b 0 5 5 0 12 0{{\\p0}}"))
    out.append(dia(6, a, b, "Rec", f"{{\\an7\\pos({W-m-135},{m+30})}}REC"))
    out.append(dia(6, a, b, "Rec", f"{{\\an1\\pos({m+30},{H-m-25})\\fs38}}4K 60FPS"))
    out.append(dia(6, a, b, "Rec", f"{{\\an3\\pos({W-m-30},{H-m-25})\\fs38}}HD"))
    # bateria
    out.append(dia(6, a, b, "Shape", f"{{\\an7\\pos({m+40},{m+38})\\p1}}m 0 0 l 60 0 60 30 0 30 0 0 m 4 4 l 4 26 30 26 30 4{{\\p0}}"))
    if e.get("texto"):
        out.append(dia(7, a, b, "SansDark" if e.get("oscuro") else "Sans",
                       f"{{\\pos({W//2},{e.get('y', 420)})\\fs{e.get('tam', 170)}{POP}}}{e['texto']}"))
    if e.get("subtexto"):
        out.append(dia(7, a + 0.3, b, "SerifAcc", f"{{\\pos({W//2},{e.get('y', 420)+150})\\fs110{POP}}}{e['subtexto']}"))


def ev_sticker(e, out):
    """Etiqueta tipo sticker: caja de color redondeada con texto, entra con rebote y giro."""
    x, y = e.get("x", W // 2), e.get("y", 600)
    w, h, r = e.get("ancho", 420), 100, 24
    rot = e.get("giro", -4)
    box = (f"m {r} 0 l {w-r} 0 b {w} 0 {w} 0 {w} {r} l {w} {h-r} b {w} {h} {w} {h} {w-r} {h} "
           f"l {r} {h} b 0 {h} 0 {h} 0 {h-r} l 0 {r} b 0 0 0 0 {r} 0")
    out.append(dia(8, e["inicio"], e["fin"], "Shape",
                   f"{{\\an5\\pos({x},{y})\\frz{rot}\\1c{bgr(e['_acento'])}{POP}\\p1}}{box}{{\\p0}}"))
    out.append(dia(9, e["inicio"], e["fin"], "Tag", f"{{\\an5\\pos({x},{y})\\frz{rot}{POP}}}{e['texto']}"))


def ev_cta(e, out):
    a, b = e["inicio"], e["fin"]
    out.append(dia(5, a, b, "Serif", f"{{\\pos({W//2},{e.get('y', 380)})\\fs120{POP}}}{e['pequeno']}"))
    out.append(dia(5, a + 0.2, b, "Big", f"{{\\pos({W//2},{e.get('y', 380)+150})\\fs170{POP}}}{e['grande']}"))


def ev_typewriter(e, out):
    """Texto que se escribe letra por letra con cursor (como 'ya voy|' del referente)."""
    txt, a, b = e["texto"], e["inicio"], e["fin"]
    vel = e.get("vel", 0.05)
    st = e.get("estilo", "SerifAcc")
    for k in range(1, len(txt) + 1):
        t0 = a + (k - 1) * vel
        t1 = a + k * vel if k < len(txt) else b
        out.append(dia(5, t0, t1, st, f"{{\\pos({W//2},{e.get('y', 400)})\\fs{e.get('tam', 120)}}}{txt[:k]}|"))


HANDLERS = {"gancho": ev_hook, "palabras": ev_words, "rec": ev_rec, "sticker": ev_sticker,
            "cta": ev_cta, "maquina": ev_typewriter}

# efecto de sonido por defecto segun el tipo de evento
SFX_AUTO = {"gancho": "whoosh", "rec": "obturador", "sticker": "pop", "cta": "pop",
            "maquina": "teclado", "zoom": "golpe"}


# ---------------------------------------------------------------- sonido
def sfx_src(kind, idx):
    """Genera un efecto de sonido con filtros de ffmpeg (sin archivos externos)."""
    if kind == "whoosh":
        return (f"anoisesrc=d=0.45:c=pink:a=0.6,highpass=f=400,lowpass=f=5000,"
                f"afade=t=in:d=0.3,afade=t=out:st=0.3:d=0.15[s{idx}]")
    if kind == "pop":
        return f"sine=f=900:d=0.09,volume=0.7,afade=t=out:st=0.02:d=0.07[s{idx}]"
    if kind == "golpe":
        return f"sine=f=70:d=0.25,volume=1.6,afade=t=out:st=0.03:d=0.22[s{idx}]"
    if kind == "obturador":
        return f"anoisesrc=d=0.12:c=white:a=0.7,highpass=f=1500,afade=t=out:st=0.02:d=0.1[s{idx}]"
    if kind in ("click", "teclado"):
        return f"anoisesrc=d=0.03:c=white:a=0.6,highpass=f=3000[s{idx}]"
    if kind == "ding":
        return f"sine=f=1320:d=0.5,volume=0.5,afade=t=out:st=0.05:d=0.45[s{idx}]"
    raise ValueError(f"efecto de sonido desconocido: {kind}")


# ---------------------------------------------------------------- render
def build(plan, out_path, demo=False):
    brand = plan["marca"]
    dur = plan["duracion"]
    lines = header(brand)
    zooms, bw, sfx = [], [], list(plan.get("sfx", []))
    for e in plan["eventos"]:
        e["_acento"] = brand["acento"]
        if e["tipo"] == "zoom":
            zooms.append(e)
        elif e["tipo"] in HANDLERS:
            HANDLERS[e["tipo"]](e, lines)
        else:
            raise ValueError(f"tipo de evento desconocido: {e['tipo']}")
        if e["tipo"] == "rec":
            bw.append((e["inicio"], e["fin"]))
        if plan.get("sfx_auto", True) and e["tipo"] in SFX_AUTO and not e.get("sin_sfx"):
            sfx.append({"t": e["inicio"], "tipo": SFX_AUTO[e["tipo"]]})

    tmp = tempfile.mkdtemp()
    ass = os.path.join(tmp, "capa.ass")
    with open(ass, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    # --- entrada de video
    inputs = []
    src = plan.get("source")
    if demo or not src:
        # fondo de prueba: cielo de atardecer que se mueve, para ver los efectos sin clip
        inputs += ["-f", "lavfi", "-i",
                   f"gradients=s={W}x{H}:c0=0x1d3b6e:c1=0xf4a259:c2=0xe86a4f:n=3:speed=0.02:d={dur}:r=30"]
        has_audio = False
    else:
        inputs += ["-i", src]
        has_audio = plan.get("audio_original", True)

    # --- cadena de video: zoom de golpe -> blanco y negro -> capa de texto
    zexpr = "1"
    for z in zooms:
        zexpr = f"if(between(t,{z['inicio']},{z['fin']}),{z.get('escala', 1.15)},{zexpr})"
    bwexpr = "+".join(f"between(t,{a},{b})" for a, b in bw) or "0"
    vf = (f"[0:v]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},"
          f"scale=w='trunc({W}*({zexpr})/2)*2':h='trunc({H}*({zexpr})/2)*2':eval=frame,"
          f"crop={W}:{H},"
          f"hue=s='if({bwexpr},0,1)',"
          f"eq=contrast='if({bwexpr},1.15,1.0)':eval=frame,"
          f"ass='{ass}'[v]")

    # --- audio: original + efectos con retardo
    af_parts, mix = [], []
    if has_audio:
        mix.append("[0:a]")
    for i, s in enumerate(sorted(sfx, key=lambda x: x["t"])):
        ms = int(s["t"] * 1000)
        af_parts.append(sfx_src(s["tipo"], i).replace(f"[s{i}]", f",adelay={ms}|{ms}[s{i}]"))
        mix.append(f"[s{i}]")
    graph = [vf] + af_parts
    if mix:
        graph.append("".join(mix) + f"amix=inputs={len(mix)}:normalize=0,atrim=0:{dur}[a]")
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *inputs,
           "-filter_complex", ";".join(graph), "-map", "[v]"]
    if mix:
        cmd += ["-map", "[a]", "-c:a", "aac", "-b:a", "192k"]
    cmd += ["-t", str(dur), "-c:v", "libx264", "-preset", "medium", "-crf", "20",
            "-pix_fmt", "yuv420p", "-r", "30", "-movflags", "+faststart", out_path]
    subprocess.run(cmd, check=True)
    print(f"listo: {out_path}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    with open(sys.argv[1], encoding="utf-8") as f:
        plan = json.load(f)
    build(plan, sys.argv[2], demo="--demo" in sys.argv)
