import json, glob, os
B = os.path.dirname(os.path.abspath(__file__))
M = os.path.join(B, "material", "Milan - Venecia ")
fotos = sorted(glob.glob(os.path.join(M, "*.jpg")))
F = lambda n: fotos[n-1].replace("\\", "/")
VID = os.path.join(M, "VID-20261120-WA0036.mp4").replace("\\", "/")
VOZ = os.path.join(M, "Milan-venecia-silence-trim-40db-0-05s.mp3").replace("\\", "/")
MUS = os.path.join(B, "musica", "taking-flight.mp3").replace("\\", "/")
tr = json.load(open(os.path.join(B, "transcripcion.json"), encoding="utf-8"))
DUR = 75.5


def C(t, f, mov="zoom_in", foco=(0.5, 0.5), flash=False, **kw):
    return dict(inicio=t, archivo=f, mov=mov, foco=list(foco), flash=flash, **kw)


cortes = [
 C(0.0, F(19)), C(1.9, F(4), foco=(0.5, 0.55)), C(3.5, F(23), "pan_der"), C(5.5, F(28), "zoom_out"),
 C(7.3, F(26), "pan_izq"), C(9.1, F(14), "pan_arriba"), C(10.6, F(22), foco=(0.5, 0.6)),
 C(12.2, F(7), foco=(0.5, 0.45), flash=True), C(14.0, F(24), "pan_arriba"),
 C(15.76, F(3), "pan_abajo", flash=True), C(17.5, F(1), foco=(0.5, 0.35)), C(18.6, F(2), "pan_abajo"),
 C(19.34, F(13), "pan_der"), C(21.1, F(16), "pan_izq"),
 dict(inicio=23.1, archivo=VID, desde=1.0, foco=[0.5, 0.5]),
 C(25.6, F(11), "zoom_out"), C(27.0, F(12), "pan_arriba"), C(28.6, F(10), "pan_arriba"), C(29.9, F(25), "pan_der"),
 C(30.9, F(29), flash=True), C(32.6, F(30), foco=(0.5, 0.55)), C(34.1, F(18), "zoom_out"),
 C(35.46, F(31), "pan_izq"), C(37.0, F(9), "pan_arriba"), C(38.7, F(5), "zoom_out"),
 C(40.06, F(21), flash=True), C(41.5, F(33), "pan_arriba"),
 C(43.42, F(20), foco=(0.45, 0.6), flash=True), C(45.3, F(32), "pan_der"), C(47.5, F(21), "pan_abajo"),
 C(49.2, F(19), "zoom_out", (0.5, 0.75)), C(50.28, F(32), foco=(0.75, 0.7)), C(52.3, F(33), "zoom_out"),
 C(53.6, F(22), "pan_arriba"), C(55.6, F(21), foco=(0.4, 0.6)), C(57.5, F(20), "pan_arriba"),
 dict(inicio=60.3, dividida=[F(7), F(19)], mov="zoom_in", mov2="zoom_out", foco=[0.5, 0.4], foco2=[0.5, 0.5], trans="fadewhite"),
 C(62.6, F(4), "zoom_out", (0.5, 0.55)), C(64.2, F(6)), C(64.88, F(8), "pan_der"),
 C(66.16, F(17), foco=(0.5, 0.4)), C(67.44, F(19), "zoom_out", (0.5, 0.4)), C(69.4, F(32), "pan_izq"),
 C(71.28, F(20), "zoom_out", (0.45, 0.6), flash=True),
]
for i, c in enumerate(cortes):
    c["fin"] = cortes[i+1]["inicio"] if i+1 < len(cortes) else DUR


def L(t, t0, estilo="sans", tam=None, **kw):
    d = dict(t=t, t0=t0, estilo=estilo, **kw)
    if tam:
        d["tam"] = tam
    return d


bloques = [  # (inicio, fin, y, líneas)
 (0.1, 3.2, 260, [L("¿VIAJAR", 0.15, tam=190, entrada="golpe", sfx="boom"), L("para", 0.6, "serif", 120, entrada="sube"),
                  L("DESCANSAR?", 0.95, "big", 270, entrada="golpe", sfx="swish"),
                  L("sí, claro…", 1.9, "serif", 120, entrada="foco", brillo=True)]),
 (9.1, 12.15, 620, [L("CAMINAR", 9.14, tam=180, entrada="golpe", sfx="swish"), L("hasta que los pies", 9.72, "serif", 105, entrada="sube"),
                    L("nos pidan", 10.84, tam=140), L("LA RENUNCIA", 11.4, tam=165, caja=True, entrada="golpe", sfx="pop", giro=-3)]),
 (13.9, 15.75, 900, [L("HORAS", 14.0, tam=210, entrada="golpe", sfx="swish"),
                     L("por el norte de Italia", 14.48, "serif", 100, entrada="sube", brillo=True)]),
 (17.6, 21.05, 650, [L("LA MODA", 17.74, tam=170, entrada="golpe", sfx="pop"), L("la historia", 18.6, "serif", 140, entrada="sube", sfx="pop"),
                     L("y la ARQUITECTURA", 19.34, tam=150, caja=True, entrada="golpe", sfx="swish", giro=2)]),
 (26.4, 27.5, 700, [L("una", 26.44, "serif", 120, entrada="sube"), L("OBRA DE ARTE", 26.6, "big", 220, entrada="golpe", sfx="boom")]),
 (39.3, 43.35, 560, [L("una PASARELA", 39.42, tam=160, caja=True, entrada="golpe", sfx="swish", giro=-2),
                     L("a otra donde", 40.06, "serif", 105, entrada="sube"), L("hasta PERDERSE", 41.12, tam=165, entrada="golpe", sfx="pop"),
                     L("tiene su encanto", 42.22, "serif", 125, entrada="foco", brillo=True)]),
 (50.2, 52.95, 650, [L("CANALES", 50.28, "big", 230, entrada="golpe", sfx="boom"), L("en lugar de", 50.88, "serif", 105, entrada="sube"),
                     L("CARRETERAS", 52.32, tam=150, entrada="golpe", sfx="pop")]),
 (57.5, 60.2, 650, [L("perdido", 57.56, "serif", 130, entrada="sube"), L("o viviendo", 58.14, "serif", 105, entrada="sube"),
                    L("TU MEJOR MOMENTO", 58.86, tam=150, caja=True, entrada="golpe", sfx="swish", giro=-2)]),
 (60.3, 62.5, 905, [L("DOS CIUDADES", 60.3, tam=150, caja=True, entrada="golpe", sfx="boom")]),
 (60.5, 62.5, 120, [L("MILÁN", 60.5, tam=120, entrada="pop", sfx="pop")]),
 (60.8, 62.5, 1690, [L("VENECIA", 60.8, tam=120, entrada="pop", sfx="pop")]),
 (62.55, 64.85, 600, [L("dos maneras de", 62.6, "serif", 110, entrada="sube"), L("ENAMORARSE", 63.5, "big", 230, entrada="golpe", sfx="swish"),
                      L("de Italia", 64.04, "serif", 140, entrada="foco", brillo=True)]),
 (67.4, 72.4, 520, [L("pero qué tristeza sería", 67.44, "serif", 100, entrada="sube", brillo=True),
                    L("tener la energía", 68.74, "serif", 125, entrada="sube", brillo=True),
                    L("y no tener", 69.82, tam=150, entrada="sube"),
                    L("LAS GANAS", 70.64, "big", 260, entrada="foco"),
                    L("de descubrir el mundo", 71.28, "serif", 100, entrada="sube", brillo=True)]),
]
eventos = []
for a, b, y, lineas in bloques:
    eventos.append({"tipo": "gancho", "inicio": a, "fin": b, "y": y, "lineas": lineas, "sin_sfx": True})
ocupado = [(a, b) for a, b, _, _ in bloques] + [(12.2, 15.75), (35.4, 39.2), (64.85, 67.4), (72.4, DUR)]
palabras = [w for s in tr["segmentos"] for w in s["palabras"]]
subs = [w for w in palabras if not any(a - 0.05 <= w["s"] < b for a, b in ocupado)]
resaltar = ["descansar", "mundo", "italia", "milán", "arte", "fachadas", "tren", "venecia", "imposibles", "puentes",
            "historia", "callejones", "conclusión", "suficiente", "fotografías"]
eventos += [
 {"tipo": "palabras", "inicio": 0, "fin": DUR, "y": 1240, "palabras": subs, "resaltar": resaltar},
 {"tipo": "contador", "inicio": 13.24, "fin": 15.75, "hasta": 48, "y": 640, "tam": 470, "cuenta": 0.7},
 {"tipo": "sello", "inicio": 16.32, "fin": 19.2, "pais": "MILÁN", "ciudad": "ITALIA", "fecha": "SEP 2023",
  "color": "#009246", "x": 760, "y": 330, "giro": 9},
 {"tipo": "mapa", "inicio": 35.46, "fin": 39.2, "y": 820, "desde": "MILÁN", "hasta": "VENECIA", "texto": "en tren", "dibujo": 1.6},
 {"tipo": "sello", "inicio": 43.42, "fin": 47.3, "pais": "VENECIA", "ciudad": "ITALIA", "fecha": "SEP 2023",
  "color": "#CE2B37", "x": 330, "y": 330, "giro": -8, "ancho": 440},
 {"tipo": "maquina", "inicio": 64.88, "fin": 66.15, "texto": "y una sola conclusión…", "y": 1250, "tam": 95, "estilo": "SerifAcc", "vel": 0.035},
 {"tipo": "rec", "inicio": 66.16, "fin": 67.42, "texto": "VIAJAR CANSA", "subtexto": "sí…", "y": 560, "tam": 170},
 {"tipo": "cta", "inicio": 72.5, "fin": DUR, "pequeno": "comenta", "grande": "“ITALIA”", "y": 520},
 {"tipo": "gancho", "inicio": 73.3, "fin": DUR, "y": 830, "sin_sfx": True,
  "lineas": [L("y te mando mi ruta", 73.3, "serif", 90, entrada="sube", brillo=True)]},
]
plan = {
 "titulo": "Prueba de diseño v2: 48 horas en el norte de Italia",
 "source": os.path.join(B, "base-v2.mp4").replace("\\", "/"),
 "voz": VOZ, "musica": MUS, "volumen_musica": 0.55, "duracion": DUR, "tomas": cortes,
 "marca": {"acento": "#FFD54A", "oscuro": "#2B1A12", "fuente_sans": "Bebas Neue",
           "fuente_serif": "Playfair Display", "fuente_texto": "Montserrat"},
 "eventos": eventos, "audio_original": True,
 "sfx": [{"t": 10.95, "tipo": "riser"}, {"t": 42.25, "tipo": "riser"}, {"t": 43.42, "tipo": "campana"},
         {"t": 43.6, "tipo": "agua"}, {"t": 49.5, "tipo": "agua"}, {"t": 73.0, "tipo": "ding"}],
}
json.dump(plan, open(os.path.join(B, "plan-v2.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(len(cortes), "tomas,", len(subs), "palabras sueltas,", len(eventos), "eventos")
