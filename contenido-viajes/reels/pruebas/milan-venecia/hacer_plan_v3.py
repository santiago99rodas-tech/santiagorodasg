import json, glob, os
B = os.path.dirname(os.path.abspath(__file__))
M = os.path.join(B, "material", "Milan - Venecia ")
fotos = sorted(glob.glob(os.path.join(M, "*.jpg")))
F = lambda n: fotos[n-1].replace("\\", "/")
VID = os.path.join(M, "VID-20261120-WA0036.mp4").replace("\\", "/")
VOZ = os.path.join(M, "Milan-venecia-silence-trim-40db-0-05s.mp3").replace("\\", "/")
MUS = os.path.join(B, "musica", "cutscene-crush.mp3").replace("\\", "/")
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


def L(t, t0, estilo="anton", tam=None, **kw):
    d = dict(t=t, t0=t0, estilo=estilo, **kw)
    if tam:
        d["tam"] = tam
    return d


def E(archivo, a, b, x, y, tam=230, giro=0):
    return {"tipo": "emoji", "archivo": archivo, "inicio": a, "fin": b, "x": x, "y": y, "tam": tam, "giro": giro}


bloques = [  # (inicio, fin, y, líneas)
 (0.1, 3.2, 300, [L("¿VIAJAR", 0.15, tam=170, entrada="golpe", sfx="whoosh"), L("para", 0.6, "marker", 95, entrada="sube", espacio=12),
                  L("DESCANSAR?", 0.95, "big", 270, entrada="golpe", sfx="impacto2"),
                  L("sí, claro…", 1.9, "serif", 115, entrada="foco")]),
 (9.1, 12.15, 600, [L("CAMINAR", 9.14, tam=180, entrada="golpe", sfx="whoosh"), L("hasta que los pies", 9.72, "serif", 100, entrada="sube"),
                    L("nos pidan", 10.84, "texto", 78, entrada="sube"),
                    L("LA RENUNCIA", 11.4, tam=150, caja=True, entrada="golpe", sfx="pop", giro=-3, espacio=20)]),
 (13.9, 15.75, 900, [L("HORAS", 14.0, tam=200, entrada="golpe", sfx="whoosh"),
                     L("por el norte de Italia", 14.48, "marker", 72, entrada="sube")]),
 (17.6, 21.05, 620, [L("LA MODA", 17.74, "big", 240, entrada="golpe"), L("la historia", 18.6, "serif", 135, entrada="sube", sfx="pop"),
                     L("y la", 19.1, "marker", 80, entrada="sube", espacio=18),
                     L("ARQUITECTURA", 19.34, tam=140, caja="blanca", entrada="golpe", sfx="whoosh", giro=2, espacio=10)]),
 (26.4, 27.5, 700, [L("una", 26.44, "serif", 120, entrada="sube"), L("OBRA DE ARTE", 26.6, "big", 230, entrada="golpe", sfx="magia")]),
 (39.3, 43.35, 540, [L("una PASARELA", 39.42, tam=150, caja=True, entrada="golpe", giro=-2, espacio=15),
                     L("a otra donde", 40.06, "serif", 100, entrada="sube"), L("hasta PERDERSE", 41.12, tam=170, entrada="golpe", sfx="whoosh"),
                     L("tiene su encanto", 42.22, "marker", 92, entrada="foco")]),
 (50.2, 52.95, 620, [L("CANALES", 50.28, "big", 240, entrada="golpe", sfx="impacto2"), L("en lugar de", 50.88, "serif", 105, entrada="sube"),
                     L("CARRETERAS", 52.32, tam=150, caja="negra", entrada="golpe", sfx="pop")]),
 (57.5, 60.2, 620, [L("perdido", 57.56, "marker", 110, entrada="sube", espacio=12), L("o viviendo", 58.14, "serif", 105, entrada="sube"),
                    L("TU MEJOR MOMENTO", 58.86, tam=145, caja=True, entrada="golpe", sfx="magia", giro=-2, espacio=15)]),
 (60.3, 62.5, 905, [L("DOS CIUDADES", 60.3, tam=150, caja=True, entrada="golpe", sfx="impacto")]),
 (60.5, 62.5, 120, [L("MILÁN", 60.5, tam=110, caja="negra", entrada="pop", sfx="pop")]),
 (60.8, 62.5, 1690, [L("VENECIA", 60.8, tam=110, caja="negra", entrada="pop", sfx="pop")]),
 (62.55, 64.85, 600, [L("dos maneras de", 62.6, "serif", 110, entrada="sube"), L("ENAMORARSE", 63.5, "big", 240, entrada="golpe"),
                      L("de Italia", 64.04, "marker", 130, entrada="foco")]),
 (67.4, 72.4, 480, [L("pero qué tristeza sería", 67.44, "serif", 100, entrada="sube"),
                    L("tener la energía", 68.74, "marker", 92, entrada="sube", espacio=22, color="#FFFFFF"),
                    L("y no tener", 69.82, "texto", 80, entrada="sube"),
                    L("LAS GANAS", 70.64, "big", 280, entrada="foco", sfx="impacto"),
                    L("de descubrir el mundo", 71.28, "serif", 100, entrada="sube")]),
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
 {"tipo": "mapa", "inicio": 35.46, "fin": 39.2, "y": 860, "desde": "MILÁN", "hasta": "VENECIA", "texto": "en tren", "dibujo": 1.6},
 {"tipo": "sello", "inicio": 43.42, "fin": 47.3, "pais": "VENECIA", "ciudad": "ITALIA", "fecha": "SEP 2023",
  "color": "#CE2B37", "x": 330, "y": 330, "giro": -8, "ancho": 440},
 {"tipo": "maquina", "inicio": 64.88, "fin": 66.15, "texto": "y una sola conclusión…", "y": 1250, "tam": 95, "estilo": "SerifAcc", "vel": 0.035},
 {"tipo": "rec", "inicio": 66.16, "fin": 67.42, "texto": "VIAJAR CANSA", "subtexto": "sí…", "y": 560, "tam": 170},
 {"tipo": "cta", "inicio": 72.5, "fin": DUR, "pequeno": "comenta", "grande": "“ITALIA”", "y": 470},
 {"tipo": "gancho", "inicio": 73.3, "fin": DUR, "y": 860, "sin_sfx": True, "velo": False,
  "lineas": [L("y te mando mi ruta", 73.3, "texto", 80, entrada="sube", caja="blanca")]},
 # stickers 3D con equilibrio: solo en momentos clave (~1 cada 7 s), nunca dos a la vez
 E("dormido", 1.9, 3.2, 840, 1000, 220, 8),
 E("cansado", 11.4, 12.15, 880, 1430, 230, 6),
 E("reloj", 13.24, 15.7, 860, 330, 230, 10),
 E("cuadro", 26.6, 29.0, 540, 560, 240, -5),
 E("tren", 35.6, 39.2, 540, 470, 250),
 E("camara", 46.72, 48.6, 820, 960, 220, -8),
 E("explota", 49.2, 50.2, 540, 960, 260),
 E("enamorado", 63.5, 64.85, 830, 420, 240, 8),
 E("avion", 71.28, 72.45, 850, 380, 220, -10),
 E("mensaje", 72.6, DUR, 840, 1080, 220, 8),
]
# sonidos con lógica: lo que se nombra, suena (recursos/sfx)
sfx = [
 {"t": 9.1, "tipo": "pasos", "dur": 3.0, "vol": 0.55},
 {"t": 11.4, "tipo": "latido", "dur": 0.8, "vol": 0.5},
 {"t": 15.8, "tipo": "ciudad", "dur": 7.2, "vol": 0.35, "entra": 0.8},
 {"t": 17.74, "tipo": "flashes", "dur": 1.8, "vol": 0.45},
 {"t": 29.92, "tipo": "obturador", "dur": 1, "vol": 0.8},
 {"t": 35.4, "tipo": "tren", "dur": 3.9, "vol": 0.55, "entra": 0.5},
 {"t": 36.0, "tipo": "bocina", "dur": 2.2, "vol": 0.3},
 {"t": 39.42, "tipo": "tacones", "dur": 1.8, "vol": 0.55},
 {"t": 43.3, "tipo": "campana", "dur": 4.5, "vol": 0.45},
 {"t": 43.5, "tipo": "agua", "dur": 14.0, "vol": 0.3, "entra": 1.0},
 {"t": 46.72, "tipo": "obturador", "dur": 1, "vol": 0.8},
 {"t": 49.2, "tipo": "impacto2", "dur": 2, "vol": 0.45},
 {"t": 63.5, "tipo": "latido", "dur": 0.8, "vol": 0.7},
 {"t": 64.0, "tipo": "latido", "dur": 0.8, "vol": 0.7},
 {"t": 71.28, "tipo": "viento", "dur": 1.6, "vol": 0.4},
 {"t": 73.0, "tipo": "ding", "dur": 2, "vol": 0.5},
]
plan = {
 "titulo": "Prueba de diseño v3: 48 horas en el norte de Italia",
 "source": os.path.join(B, "base-v3.mp4").replace("\\", "/"),
 "voz": VOZ, "musica": MUS, "volumen_musica": 0.5, "duracion": DUR, "tomas": cortes,
 "marca": {"acento": "#FFD54A", "oscuro": "#2B1A12", "fuente_sans": "Bebas Neue",
           "fuente_serif": "Playfair Display", "fuente_texto": "Montserrat"},
 "eventos": eventos, "audio_original": True, "sfx": sfx,
}
json.dump(plan, open(os.path.join(B, "plan-v3.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(len(cortes), "tomas,", len(subs), "palabras sueltas,", len(eventos), "eventos")
