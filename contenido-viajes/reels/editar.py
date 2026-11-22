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
import shutil
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
        # REGLA DE DISEÑO: letras sólidas, sin contorno, sin sombra, sin brillo (borde 0, sombra 0).
        # La lectura sobre fotos claras la da un "velo" oscuro difuso DETRÁS del bloque, no la letra.
        # Bebas Neue (principal) no tiene negrita: Bold=0 para no deformarla
        ("Sans", sans, 120, white, 0, 0, 0, 0),
        ("SansDark", sans, 120, dark, 0, 0, 0, 0),
        ("Big", sans, 260, acc, 0, 0, 0, 0),
        ("Anton", "Anton", 150, white, 0, 0, 0, 0),
        ("Texto", "Montserrat ExtraBold", 90, white, 0, 0, 0, 0),
        ("Serif", serif, 120, white, 0, -1, 0, 0),
        ("SerifAcc", serif, 130, acc, -1, -1, 0, 0),
        ("Word", "Montserrat ExtraBold", 84, white, 0, 0, 0, 0),
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
            f"Style: {n},{f},{s},{c},{c},&H78000000,&H80000000,{b},{i},0,0,100,100,-2,0,1,{o},{sh},5,40,40,40,1"
        )
    out += ["", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"]
    return out


def dia(layer, a, b, style, text):
    return f"Dialogue: {layer},{ts(a)},{ts(b)},{style},,0,0,0,,{text}"


# ---------------------------------------------------------------- eventos
ENTRADAS = {
    # rebote (por defecto)
    "pop": r"\fscx40\fscy40\t(0,120,\fscx112\fscy112)\t(120,220,\fscx100\fscy100)",
    # golpe: entra gigante y cae en su sitio (para palabras fuertes)
    "golpe": r"\fscx260\fscy260\alpha&HFF&\t(0,150,\fscx94\fscy94\alpha&H00&)\t(150,240,\fscx100\fscy100)",
    # sube: aparece desde abajo, suave (frases emotivas)
    "sube": r"\alpha&HFF&\t(0,350,\alpha&H00&)",
    # desenfoque: entra borroso y se enfoca
    "foco": r"\blur18\alpha&HFF&\t(0,300,\blur0\alpha&H00&)",
}


def _caja(x, y, w, h, color, layer, a, b, rot=0, anim=""):
    r = 14
    box = (f"m {r} 0 l {w-r} 0 b {w} 0 {w} 0 {w} {r} l {w} {h-r} b {w} {h} {w} {h} {w-r} {h} "
           f"l {r} {h} b 0 {h} 0 {h} 0 {h-r} l 0 {r} b 0 0 0 0 {r} 0")
    return dia(layer, a, b, "Shape", f"{{\\an5\\pos({x},{y})\\frz{rot}\\1c{bgr(color)}\\bord0\\shad0{anim}\\p1}}{box}{{\\p0}}")


def _ancho(txt, size, estilo):
    k = {"sans": 0.42, "big": 0.42, "sansdark": 0.42, "serif": 0.5, "serifacc": 0.5,
         "anton": 0.5, "texto": 0.66}.get(estilo, 0.45)
    return int(len(txt) * size * k) + 50


def _velo(y, h, a, b, alfa="78", layer=2):
    """Velo oscuro difuso detrás de un bloque de texto (no toca la letra: la letra sigue sólida).
    y = centro vertical, h = alto. alfa: 00 opaco ... FF invisible."""
    return dia(layer, a, b, "Shape",
               f"{{\\an5\\pos({W//2},{int(y)})\\1c&H000000&\\1a&H{alfa}&\\bord0\\shad0\\blur80\\fad(220,180)\\p1}}"
               f"m 0 0 l {W+240} 0 {W+240} {int(h)} 0 {int(h)}{{\\p0}}")


# cajas sólidas: (color de la caja, color del texto)
CAJAS = {"amarilla": (None, None), "blanca": ("#FFFFFF", "#14110F"), "negra": ("#14110F", "#FFFFFF"),
         "roja": ("#CE2B37", "#FFFFFF"), "verde": ("#009246", "#FFFFFF")}
ESTILOS = {"sans": "Sans", "big": "Big", "serif": "Serif", "serifacc": "SerifAcc", "sansdark": "SansDark",
           "anton": "Anton", "texto": "Texto"}
# Montserrat se ve chica al mismo \fs que Bebas: se agranda al dibujar
FS_K = {"texto": 1.15}
TAMANOS = {"sans": 190, "big": 400, "serif": 150, "serifacc": 165, "sansdark": 190, "anton": 170, "texto": 90}


def ev_hook(e, out):
    """Bloque de texto cinético: líneas apiladas que entran una por una.
    Cada línea: "t" texto, "estilo" (sans = Bebas, la principal / big / serif / serifacc / texto / anton), "tam", "t0" (segundo absoluto),
    "entrada" (pop/golpe/sube/foco), "caja" (true = amarilla, o "blanca"/"negra"/"roja"/"verde"),
    "color" (#hex), "x", "giro", "espacio".
    Texto sólido siempre: sin contorno, sin sombra, sin brillo. Si el bloque no va todo en cajas,
    se pone un velo oscuro difuso detrás (desactivar con "velo": false)."""
    y = e.get("y", 330)
    gap = e.get("intervalo", 0.18)
    y_ini = y
    alto = sum(ln.get("tam", TAMANOS[ln.get("estilo", "sans")]) * 0.88 + ln.get("espacio", 0) for ln in e["lineas"])
    t_pri = min(ln.get("t0", e["inicio"]) for ln in e["lineas"])
    if e.get("velo", True) and not all(ln.get("caja") for ln in e["lineas"]):
        out.append(_velo(y_ini + alto / 2, alto + 160, t_pri, e["fin"]))
    for i, ln in enumerate(e["lineas"]):
        st = ln.get("estilo", "sans")
        size = ln.get("tam", TAMANOS[st])
        y += size * 0.5
        t0 = ln.get("t0", e["inicio"] + i * gap)
        x = ln.get("x", W // 2)
        anim = ENTRADAS[ln.get("entrada", e.get("entrada", "pop"))]
        rot = ln.get("giro", 0)
        extra = f"\\frz{rot}" if rot else ""
        if ln.get("color"):
            extra += r"\1c" + bgr(ln["color"])
        if ln.get("caja"):
            fondo, letra = CAJAS.get(ln["caja"] if isinstance(ln["caja"], str) else "amarilla", (None, None))
            fondo = fondo or e["_acento"]
            letra = letra or e.get("_oscuro", "#2B1A12")
            out.append(_caja(x, int(y + size * 0.04), _ancho(ln["t"], size, st), int(size * 0.98),
                             fondo, 4, t0, e["fin"], rot, anim))
            extra += r"\1c" + bgr(letra)
        out.append(dia(5, t0, e["fin"], ESTILOS[st], f"{{\\pos({x},{int(y)})\\fs{int(size * FS_K.get(st, 1))}{extra}{anim}{FADE}}}{ln['t']}"))
        y += size * 0.5 - size * 0.12 + ln.get("espacio", 0)


def ev_words(e, out):
    """Subtitulos de una palabra al centro, al ritmo del habla. Las palabras clave van en caja amarilla."""
    words = e.get("palabras")
    if not words:  # sin marcas de tiempo: reparte las palabras parejo
        toks = e["texto"].split()
        d = (e["fin"] - e["inicio"]) / len(toks)
        words = [{"w": w, "s": e["inicio"] + k * d, "e": e["inicio"] + (k + 1) * d} for k, w in enumerate(toks)]
    resaltar = {w.lower() for w in e.get("resaltar", [])}
    y = e.get("y", 1080)
    # velo difuso detrás de cada tramo seguido de subtítulos (no parpadea palabra a palabra)
    tramos = []
    for w in words:
        if tramos and w["s"] - tramos[-1][1] < 0.7:
            tramos[-1][1] = w["e"]
        else:
            tramos.append([w["s"], w["e"]])
    for a, b in tramos:
        out.append(_velo(y, 260, a, b, alfa="88", layer=1))
    for k, w in enumerate(words):
        clean = w["w"].strip(",.!?¡¿").lower()
        rot = (-3, 2, -1, 3, 0, -2)[k % 6]
        if clean in resaltar:
            size = 150
            out.append(_caja(W // 2, y + 4, _ancho(w["w"], size, "sans"), int(size * 0.95), e["_acento"], 3,
                             w["s"], w["e"], rot, r"\fscx60\fscy60\t(0,90,\fscx105\fscy105)\t(90,150,\fscx100\fscy100)"))
            out.append(dia(4, w["s"], w["e"], "Word",
                           f"{{\\pos({W//2},{y})\\frz{rot}\\fs{size}\\bord0\\1c{bgr(e.get('_oscuro', '#2B1A12'))}"
                           f"\\fscx60\\fscy60\\t(0,90,\\fscx105\\fscy105)\\t(90,150,\\fscx100\\fscy100)}}{w['w'].rstrip(',.!?')}"))
        else:
            out.append(dia(4, w["s"], w["e"], "Word",
                           f"{{\\pos({W//2},{y})\\frz{rot}\\fscx70\\fscy70\\t(0,80,\\fscx104\\fscy104)\\t(80,130,\\fscx100\\fscy100)}}{w['w'].rstrip(',.!?')}"))


def ev_counter(e, out):
    """Número que cuenta rápido (0 -> 48) y se queda con un golpe."""
    a, b, d = e["inicio"], e["fin"], e.get("cuenta", 0.8)
    ini, fin = e.get("desde", 0), e["hasta"]
    x, y, size = e.get("x", W // 2), e.get("y", 600), e.get("tam", 420)
    pasos = 16
    out.append(_velo(y, size * 1.1, a, b))
    for k in range(pasos):
        t0, t1 = a + d * k / pasos, a + d * (k + 1) / pasos
        v = round(ini + (fin - ini) * ((k + 1) / pasos) ** 0.6)
        out.append(dia(5, t0, t1, "Big", f"{{\\pos({x},{y})\\fs{size}}}{v}"))
    out.append(dia(5, a + d, b, "Big",
                   f"{{\\pos({x},{y})\\fs{size}\\fscx125\\fscy125\\t(0,160,\\fscx100\\fscy100){FADE}}}{fin}"))


def ev_map(e, out):
    """Tarjeta de mapa: dos pines y la ruta que se dibuja entre ellos, con un punto que viaja."""
    a, b = e["inicio"], e["fin"]
    cy = e.get("y", 900)
    x1, x2 = 250, 830
    y1, y2 = cy + 60, cy - 60
    dark = bgr("#14110F")
    panel = 880, 520
    out.append(_caja(W // 2, cy, panel[0], panel[1], "#14110F", 6, a, b, 0, r"\alpha&HFF&\t(0,200,\alpha&H30&)"))
    out[-1] = out[-1].replace(f"\\1c{bgr('#14110F')}", f"\\1c{dark}\\1a&H30&")
    # ruta punteada que aparece por tramos
    seg = 14
    dur_dibujo = e.get("dibujo", 1.4)
    for k in range(seg):
        f0, f1 = k / seg, (k + 0.55) / seg
        px0, py0 = x1 + (x2 - x1) * f0, y1 + (y2 - y1) * f0 - 90 * (1 - (2 * f0 - 1) ** 2)
        px1, py1 = x1 + (x2 - x1) * f1, y1 + (y2 - y1) * f1 - 90 * (1 - (2 * f1 - 1) ** 2)
        t0 = a + 0.4 + dur_dibujo * f0
        out.append(dia(7, t0, b, "Shape",
                       f"{{\\an7\\pos(0,0)\\1c{bgr(e['_acento'])}\\bord0\\shad0\\p1}}"
                       f"m {px0:.0f} {py0-5:.0f} l {px1:.0f} {py1-5:.0f} {px1:.0f} {py1+5:.0f} {px0:.0f} {py0+5:.0f}{{\\p0}}"))
    # punto que viaja (el tren)
    out.append(dia(8, a + 0.4, a + 0.4 + dur_dibujo, "Shape",
                   f"{{\\an5\\move({x1},{y1},{x2},{y2})\\1c&H00FFFFFF&\\bord0\\shad0\\p1}}"
                   f"m 0 -14 b 8 -14 14 -8 14 0 b 14 8 8 14 0 14 b -8 14 -14 8 -14 0 b -14 -8 -8 -14 0 -14{{\\p0}}"))
    for (x, y, nombre, col, t0) in ((x1, y1, e.get("desde", "MILÁN"), e.get("color1", "#009246"), a + 0.15),
                                    (x2, y2, e.get("hasta", "VENECIA"), e.get("color2", "#CE2B37"), a + 0.4 + dur_dibujo)):
        pin = (f"m 0 0 b -34 -40 -40 -62 -40 -78 b -40 -104 -22 -122 0 -122 b 22 -122 40 -104 40 -78 "
               f"b 40 -62 34 -40 0 0 m 0 -96 b -10 -96 -17 -88 -17 -78 b -17 -68 -10 -60 0 -60 b 10 -60 17 -68 17 -78 b 17 -88 10 -96 0 -96")
        out.append(dia(8, t0, b, "Shape", f"{{\\an7\\pos({x},{y})\\1c{bgr(col)}\\bord0\\shad0{POP}\\p1}}{pin}{{\\p0}}"))
        out.append(dia(8, t0, b, "Sans", f"{{\\pos({x},{y + 70})\\fs92{POP}}}{nombre}"))
    if e.get("texto"):
        out.append(dia(8, a + 0.4 + dur_dibujo, b, "SerifAcc",
                       f"{{\\pos({W//2},{cy + 195})\\fs90\\1c{bgr(e['_acento'])}{ENTRADAS['sube']}}}{e['texto']}"))


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
        out.append(_velo(e.get('y', 420) + 70, 380, a, b, layer=5))
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
    y = e.get("y", 380)
    out.append(_velo(y + 90, 420, a, b))
    out.append(dia(5, a, b, "Serif", f"{{\\pos({W//2},{y})\\fs125\\1c&HFFFFFF&{POP}}}{e['pequeno']}"))
    out.append(dia(5, a + 0.2, b, "Big", f"{{\\pos({W//2},{y+175})\\fs250\\1c{bgr(e['_acento'])}{POP}}}{e['grande']}"))


def ev_typewriter(e, out):
    """Texto que se escribe letra por letra con cursor (como 'ya voy|' del referente)."""
    txt, a, b = e["texto"], e["inicio"], e["fin"]
    vel = e.get("vel", 0.05)
    st = e.get("estilo", "SerifAcc")
    out.append(_velo(e.get('y', 400), e.get('tam', 120) * 1.8, a, b))
    for k in range(1, len(txt) + 1):
        t0 = a + (k - 1) * vel
        t1 = a + k * vel if k < len(txt) else b
        out.append(dia(5, t0, t1, st, f"{{\\pos({W//2},{e.get('y', 400)})\\fs{e.get('tam', 120)}}}{txt[:k]}|"))


def ev_stamp(e, out):
    """Sello de pasaporte del país: rectángulo de doble borde en el color del país, girado,
    con el nombre del país, la ciudad y la fecha. Entra como si lo estamparan (grande -> golpe)."""
    x, y = e.get("x", 790), e.get("y", 300)
    w, h = e.get("ancho", 400), e.get("alto", 250)
    rot = e.get("giro", 8)
    col = bgr(e.get("color", "#009246"))
    a, b = e["inicio"], e["fin"]
    golpe = r"\fscx180\fscy180\alpha&HFF&\t(0,140,\fscx92\fscy92\alpha&H00&)\t(140,220,\fscx100\fscy100)"

    def marco(m, g):
        # contorno rectangular de grosor g, a m px del borde exterior
        x0, y0, x1, y1 = m, m, w - m, h - m
        return (f"m {x0} {y0} l {x1} {y0} {x1} {y1} {x0} {y1} "
                f"m {x0+g} {y0+g} l {x0+g} {y1-g} {x1-g} {y1-g} {x1-g} {y0+g}")

    # papel de fondo (marfil) para que el sello se lea sobre cualquier foto
    out.append(_caja(x, y, w + 30, h + 30, "#F5F1EA", 7, a, b, rot, golpe + r"\1a&H18&"))
    for m, g in ((0, 9), (18, 4)):
        out.append(dia(8, a, b, "Shape",
                       f"{{\\an5\\pos({x},{y})\\frz{rot}\\1c{col}\\bord0\\shad0{golpe}{FADE}\\p1}}{marco(m, g)}{{\\p0}}"))
    pais = e.get("pais", "ITALIA")
    out.append(dia(9, a, b, "Sans",
                   f"{{\\an5\\pos({x},{y - 18})\\frz{rot}\\fs{e.get('tam', 118)}\\1c{col}\\shad0{golpe}{FADE}}}{pais}"))
    sub = " · ".join(s for s in (e.get("ciudad"), e.get("fecha")) if s)
    if sub:
        out.append(dia(9, a, b, "Tag",
                       f"{{\\an5\\pos({x},{y + 72})\\frz{rot}\\fs40\\1c{col}{golpe}{FADE}}}{sub}"))


def ev_label(e, out):
    """Etiqueta de dato (tarjeta blanca con emoji + texto), por ejemplo un precio o una hora."""
    x, y = e.get("x", W // 2), e.get("y", 1350)
    w, h, r = e.get("ancho", 560), 120, 30
    box = (f"m {r} 0 l {w-r} 0 b {w} 0 {w} 0 {w} {r} l {w} {h-r} b {w} {h} {w} {h} {w-r} {h} "
           f"l {r} {h} b 0 {h} 0 {h} 0 {h-r} l 0 {r} b 0 0 0 0 {r} 0")
    out.append(dia(8, e["inicio"], e["fin"], "Shape",
                   f"{{\\an5\\pos({x},{y})\\frz{e.get('giro', -3)}\\1c&H00FFFFFF&\\shad0{POP}\\p1}}{box}{{\\p0}}"))
    out.append(dia(9, e["inicio"], e["fin"], "Tag",
                   f"{{\\an5\\pos({x},{y})\\frz{e.get('giro', -3)}\\fs{e.get('tam', 56)}{POP}}}{e['texto']}"))


HANDLERS = {"sello": ev_stamp, "etiqueta": ev_label, "gancho": ev_hook, "palabras": ev_words, "rec": ev_rec, "sticker": ev_sticker,
            "cta": ev_cta, "maquina": ev_typewriter, "contador": ev_counter, "mapa": ev_map}

# efecto de sonido por defecto segun el tipo de evento (si existe recursos/sfx/<nombre>.mp3 se usa el real)
SFX_AUTO = {"contador": "impacto", "mapa": "whoosh", "sello": "impacto2", "etiqueta": "pop", "gancho": "whoosh", "rec": "obturador",
            "sticker": "pop", "cta": "pop", "maquina": "teclado", "zoom": "golpe", "emoji": "pop"}

RECURSOS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "recursos")


def _archivo(carpeta, nombre, exts):
    """Busca un recurso por nombre (ruta directa o recursos/<carpeta>/<nombre>.<ext>)."""
    if os.path.isfile(nombre):
        return os.path.abspath(nombre)
    for ext in exts:
        p = os.path.join(RECURSOS, carpeta, nombre + ext)
        if os.path.isfile(p):
            return p
    return None


def filtro_emoji(e, k, entrada):
    """Sticker 3D (PNG con transparencia) que entra con rebote, flota suave y sale encogiéndose.
    e: {"archivo": "tren", "inicio", "fin", "x", "y", "tam": 230, "giro": -8}"""
    a, b = e["inicio"], e["fin"]
    d = b - a
    tam = e.get("tam", 230)
    rad = e.get("giro", 0) * 3.14159 / 180
    u = f"(t-{a})"
    pop = (f"if(lt({u},0.14),0.3+0.95*{u}/0.14,if(lt({u},0.24),1.25-0.25*({u}-0.14)/0.1,1))"
           f"*if(gt({u},{d-0.14}),max(0.05,({d}-{u})/0.14),1)")
    x, y = e.get("x", W // 2), e.get("y", 600)
    cad = (f"[{k}:v]format=rgba,scale={tam}:{tam},"
           f"rotate=a='{rad}+0.07*sin(2*PI*0.55*t)':c=none:ow='hypot(iw,ih)':oh=ow,"
           f"setpts=PTS+{a}/TB,"
           f"scale=w='max(2,trunc(iw*({pop})/2)*2)':h='max(2,trunc(ih*({pop})/2)*2)':eval=frame[e{k}];"
           f"{entrada}[e{k}]overlay=x='{x}-w/2':y='{y}-h/2+9*sin(2*PI*0.8*t)':eval=frame:eof_action=pass")
    return cad


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
    if kind == "boom":  # impacto grave de cine
        return (f"aevalsrc='0.9*sin(2*PI*(55-25*t)*t)*exp(-3.5*t)':d=1.4,"
                f"aformat=channel_layouts=stereo,volume=1.4[s{idx}]")
    if kind == "riser":  # subida de tensión antes de una revelación (1.2 s)
        return (f"aevalsrc='0.25*sin(2*PI*(180+500*t*t)*t)*(t/1.2)':d=1.2,"
                f"aformat=channel_layouts=stereo,afade=t=out:st=1.1:d=0.1[s{idx}]")
    if kind == "swish":  # whoosh corto de transición
        return (f"anoisesrc=d=0.3:c=pink:a=0.5,highpass=f=700,lowpass=f=7000,"
                f"afade=t=in:d=0.18,afade=t=out:st=0.18:d=0.12[s{idx}]")
    if kind == "campana":  # campana lejana (Venecia)
        return (f"aevalsrc='0.22*(sin(2*PI*523*t)+0.6*sin(2*PI*1046*t)+0.35*sin(2*PI*1570*t)+0.25*sin(2*PI*1240*t))*exp(-1.6*t)':d=2.6,"
                f"aecho=0.8:0.6:180:0.3,aformat=channel_layouts=stereo[s{idx}]")
    if kind == "agua":  # agua de canal, muy baja (4 s)
        return (f"anoisesrc=d=4:c=brown:a=0.35,lowpass=f=900,highpass=f=120,"
                f"afade=t=in:d=0.8,afade=t=out:st=3:d=1,aformat=channel_layouts=stereo[s{idx}]")
    if kind == "ding":
        return f"sine=f=1320:d=0.5,volume=0.5,afade=t=out:st=0.05:d=0.45[s{idx}]"
    raise ValueError(f"efecto de sonido desconocido: {kind}")


# ---------------------------------------------------------------- render
def _n_entradas(inputs):
    return inputs.count("-i")


def build(plan, out_path, demo=False):
    brand = plan["marca"]
    dur = plan["duracion"]
    lines = header(brand)
    zooms, bw, emojis, sfx = [], [], [], list(plan.get("sfx", []))
    for e in plan["eventos"]:
        e["_acento"] = brand["acento"]
        e["_oscuro"] = brand["oscuro"]
        for ln in e.get("lineas", []):  # efecto de sonido propio de cada línea de un bloque
            if ln.get("sfx"):
                sfx.append({"t": ln.get("t0", e["inicio"]), "tipo": ln["sfx"]})
        if e["tipo"] == "zoom":
            zooms.append(e)
        elif e["tipo"] == "emoji":
            emojis.append(e)
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
    # Tipografías del repo (fuentes/) al lado del .ass: libass las usa aunque no estén instaladas.
    # ffmpeg corre dentro de tmp con rutas relativas (en Windows "C:" rompe el filtro ass).
    fuentes = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fuentes")
    os.makedirs(os.path.join(tmp, "fuentes"), exist_ok=True)
    for fn in os.listdir(fuentes):
        if fn.lower().endswith((".ttf", ".otf")):
            shutil.copy(os.path.join(fuentes, fn), os.path.join(tmp, "fuentes", fn))
    out_path = os.path.abspath(out_path)

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
          f"eq=contrast='if({bwexpr},1.15,1.0)':eval=frame[b0]")
    # stickers 3D encima de la foto y debajo del texto
    graph_v = [vf]
    prev = "[b0]"
    for j, e in enumerate(emojis):
        png = _archivo("stickers", e["archivo"], (".png",))
        if not png:
            raise FileNotFoundError(f"sticker no encontrado: {e['archivo']}")
        k = _n_entradas(inputs)
        inputs += ["-loop", "1", "-framerate", "30", "-t", f"{e['fin'] - e['inicio'] + 0.05:.2f}", "-i", png]
        graph_v.append(filtro_emoji(e, k, prev) + f"[b{j+1}]")
        prev = f"[b{j+1}]"
    graph_v.append(f"{prev}ass=capa.ass:fontsdir=fuentes[v]")

    # --- audio: original + efectos con retardo
    af_parts, mix = [], []
    for i, s in enumerate(sorted(sfx, key=lambda x: x["t"])):
        ms = int(s["t"] * 1000)
        real = _archivo("sfx", s["tipo"], (".mp3", ".wav"))
        if real:  # efecto real (recursos/sfx): "vol" volumen, "dur" segundos (sale con fundido), "desde"
            k = _n_entradas(inputs)
            inputs += ["-i", real]
            d = s.get("dur", 6)
            af_parts.append(f"[{k}:a]atrim={s.get('desde', 0)}:{s.get('desde', 0) + d},asetpts=PTS-STARTPTS,"
                            f"aformat=sample_rates=48000:channel_layouts=stereo,"
                            f"afade=t=in:d={s.get('entra', 0.01)},afade=t=out:st={max(0, d - 0.35)}:d=0.35,"
                            f"volume={s.get('vol', 0.6)},adelay={ms}|{ms}[s{i}]")
        else:
            af_parts.append(sfx_src(s["tipo"], i).replace(f"[s{i}]", f",adelay={ms}|{ms}[s{i}]"))
        mix.append(f"[s{i}]")
    graph = graph_v + af_parts
    # REGLA: los efectos pueden sonar fuerte (impacto) pero NUNCA por encima de la voz.
    # Van a un bus propio que se comprime con la voz como llave: cuando Santiago habla,
    # los efectos bajan solos (~5-8 dB) y quedan por debajo de la voz; en los silencios suenan completos.
    salida = []
    if has_audio:
        salida.append("[0:a]")
    if mix:
        graph.append("".join(mix) + f"amix=inputs={len(mix)}:normalize=0,volume={plan.get('volumen_sfx', 1.0)}[sfxbus]")
        voz = plan.get("voz")
        if voz and not demo:
            k = _n_entradas(inputs)
            inputs += ["-i", voz]
            graph.append(f"[{k}:a]aformat=sample_rates=48000:channel_layouts=stereo,apad,asplit=1[llave]")
            graph.append(f"[sfxbus][llave]sidechaincompress=threshold={plan.get('sfx_umbral', 0.08)}:ratio={plan.get('sfx_ratio', 2.5)}:attack=5:release=300:makeup=1[sfxd]")
            salida.append("[sfxd]")
        else:
            salida.append("[sfxbus]")
    if salida:
        mix = salida
        graph.append("".join(salida) + f"amix=inputs={len(salida)}:normalize=0,alimiter=limit=0.89:level=false,atrim=0:{dur}[a]")
    # el grafo va en un archivo: con muchos stickers y sonidos el comando supera el límite de Windows
    with open(os.path.join(tmp, "grafo.txt"), "w", encoding="utf-8") as f:
        f.write(";\n".join(graph))
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *inputs,
           "-/filter_complex", "grafo.txt", "-map", "[v]"]
    if mix:
        cmd += ["-map", "[a]", "-c:a", "aac", "-b:a", "192k"]
    cmd += ["-t", str(dur), "-c:v", "libx264", "-preset", "medium", "-crf", "20",
            "-pix_fmt", "yuv420p", "-r", "30", "-movflags", "+faststart", out_path]
    subprocess.run(cmd, check=True, cwd=tmp)
    print(f"listo: {out_path}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    with open(sys.argv[1], encoding="utf-8") as f:
        plan = json.load(f)
    build(plan, sys.argv[2], demo="--demo" in sys.argv)
