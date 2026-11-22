import json, glob, os
B = os.path.dirname(os.path.abspath(__file__))
M = os.path.join(B, "material", "Milan - Venecia ")
fotos = sorted(glob.glob(os.path.join(M, "*.jpg")))
F = lambda n: fotos[n-1].replace("\\", "/")
VID = os.path.join(M, "VID-20261120-WA0036.mp4").replace("\\", "/")
VOZ = os.path.join(M, "Milan-venecia-silence-trim-40db-0-05s.mp3").replace("\\", "/")
tr = json.load(open(os.path.join(B, "transcripcion.json"), encoding="utf-8"))
DUR = 74.0
# (inicio, archivo, movimiento, foco, flash)
cortes = [
 (0.0, F(19), "zoom_in", [0.45,0.5], False),   # Gran Canal: gancho
 (3.0, F(23), "pan_der", [0.5,0.5], False),    # estación con maletas
 (5.2, F(28), "zoom_out", [0.5,0.5], False),
 (7.1, F(14), "pan_arriba", [0.5,0.5], False), # calle: caminar
 (9.4, F(26), "zoom_in", [0.5,0.6], False),
 (12.2, F(7), "zoom_in", [0.5,0.45], True),    # 48 horas: Duomo
 (15.8, F(3), "pan_abajo", [0.5,0.5], True),   # Llegamos a Milán
 (17.6, F(1), "zoom_in", [0.5,0.35], False),   # La Scala
 (19.3, F(16), "pan_izq", [0.5,0.5], False),
 (21.1, VID, None, [0.5,0.5], False),          # biblioteca (video): "no necesitas entrar a un museo"
 (25.3, F(11), "zoom_out", [0.5,0.5], False),  # obra de arte
 (27.2, F(12), "pan_arriba", [0.5,0.5], False),
 (28.8, F(13), "pan_der", [0.5,0.5], False),   # fachadas
 (30.9, F(29), "zoom_in", [0.5,0.5], True),    # estación Central
 (33.1, F(30), "zoom_in", [0.5,0.55], False),
 (35.5, F(31), "pan_izq", [0.5,0.5], False),   # tren rumbo a Venecia
 (37.3, F(9), "pan_arriba", [0.5,0.5], False), # pasarela
 (39.2, F(4), "zoom_in", [0.5,0.55], False),   # Santiago en la Galería
 (41.2, F(21), "zoom_in", [0.5,0.5], True),    # perderse: Venecia de noche
 (43.4, F(20), "zoom_in", [0.45,0.6], False),  # Santiago en el puente
 (46.0, F(32), "pan_der", [0.5,0.5], False),   # góndola
 (48.7, F(19), "pan_izq", [0.5,0.5], False),   # canales en lugar de carreteras
 (51.0, F(33), "pan_arriba", [0.5,0.5], False),# puentes / siglos de historia
 (53.4, F(22), "zoom_in", [0.5,0.6], False),   # callejones
 (56.2, F(18), "zoom_out", [0.5,0.5], False),
 (58.9, F(24), "pan_arriba", [0.5,0.5], True), # dos ciudades: Milán
 (60.6, F(32), "zoom_out", [0.6,0.5], False),  # ... y Venecia
 (62.6, F(2), "pan_abajo", [0.5,0.5], False),  # enamorarse de Italia
 (64.4, F(10), "pan_arriba", [0.5,0.5], False),
 (66.2, F(17), "zoom_in", [0.5,0.4], False),   # "Viajar cansa, sí" (cámara 2)
 (68.6, F(5), "zoom_out", [0.5,0.5], False),
 (71.3, F(20), "zoom_out", [0.45,0.6], True),  # cierre
]
tomas = []
for i, (a, f, mov, foco, flash) in enumerate(cortes):
    b = cortes[i+1][0] if i+1 < len(cortes) else DUR
    t = {"archivo": f, "inicio": a, "fin": b, "foco": foco, "flash": flash}
    if mov: t["mov"] = mov
    else: t["desde"] = 1.0
    tomas.append(t)

# subtítulos de una palabra con los tiempos reales, saltando los tramos con texto grande
palabras = [w for s in tr["segmentos"] for w in s["palabras"]]
libres = lambda w: not (0 <= w["s"] < 3.0 or 12.2 <= w["s"] < 15.7 or 66.2 <= w["s"] < 68.5 or w["s"] >= 71.3)
subs = [w for w in palabras if libres(w)]
resaltar = ["descansar", "renuncia", "italia", "milán", "moda", "historia", "arquitectura", "arte",
            "fachadas", "tren", "venecia", "pasarela", "perderse", "imposibles", "canales", "puentes",
            "callejones", "perdido", "enamorarse", "conclusión", "ganas", "mundo"]
plan = {
 "titulo": "Prueba de diseño v1: 48 horas en el norte de Italia",
 "source": os.path.join(B, "base.mp4").replace("\\", "/"),
 "voz": VOZ, "duracion": DUR, "tomas": tomas,
 "marca": {"acento": "#FFD54A", "oscuro": "#2B1A12", "fuente_sans": "Bebas Neue",
           "fuente_serif": "Playfair Display", "fuente_texto": "Montserrat"},
 "eventos": [
  {"tipo": "gancho", "inicio": 0.15, "fin": 3.0, "y": 300, "lineas": [
     {"t": "¿Viajar para", "estilo": "sans", "tam": 150},
     {"t": "DESCANSAR?", "estilo": "big", "tam": 250},
     {"t": "sí, claro…", "estilo": "serif", "tam": 120}]},
  {"tipo": "palabras", "inicio": 3.0, "fin": 71.3, "y": 1180, "palabras": subs, "resaltar": resaltar},
  {"tipo": "gancho", "inicio": 12.2, "fin": 15.7, "y": 380, "lineas": [
     {"t": "48", "estilo": "big", "tam": 380},
     {"t": "HORAS", "estilo": "sans", "tam": 170},
     {"t": "en el norte de Italia", "estilo": "serif", "tam": 95}]},
  {"tipo": "sello", "inicio": 15.9, "fin": 19.0, "pais": "MILÁN", "ciudad": "ITALIA", "fecha": "SEP 2023",
   "color": "#009246", "x": 760, "y": 330, "giro": 9},
  {"tipo": "etiqueta", "inicio": 35.6, "fin": 39.0, "texto": "TREN  Milán → Venecia", "y": 420, "ancho": 640},
  {"tipo": "sello", "inicio": 43.5, "fin": 47.0, "pais": "VENECIA", "ciudad": "ITALIA", "fecha": "SEP 2023",
   "color": "#CE2B37", "x": 330, "y": 330, "giro": -8, "ancho": 440},
  {"tipo": "zoom", "inicio": 48.7, "fin": 50.0, "escala": 1.12},
  {"tipo": "rec", "inicio": 66.2, "fin": 68.6, "texto": "VIAJAR CANSA", "subtexto": "sí…", "y": 520, "tam": 170},
  {"tipo": "cta", "inicio": 71.3, "fin": 74.0, "pequeno": "comenta", "grande": "“ITALIA”", "y": 420},
 ],
 "audio_original": True,
}
json.dump(plan, open(os.path.join(B, "plan-v1.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(len(tomas), "tomas,", len(subs), "palabras")
