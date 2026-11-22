"""v3: voz más ágil. Respiros más cortos antes de capítulos y tempo 1.07 (sin cambiar el tono).
Escribe voz-v3.wav y palabras-v3.ts con:
  PALABRAS_V3  tiempos por palabra en la voz nueva (boca de Santi)
  MAPA_V2, MAPA_V3  inicios de palabra en v2 y en v3, para pasar los tiempos de escena de v2 a v3
"""
import json, subprocess
import numpy as np

AQUI = r"C:\Users\larod\AppData\Local\Temp\claude\226921f72ac8e3bb\ffa4fa7e-343f-4da8-acad-c9afc7270a6a\scratchpad\yt-milan\voz2"
TS = r"C:\Users\larod\AppData\Local\Temp\claude\226921f72ac8e3bb\ffa4fa7e-343f-4da8-acad-c9afc7270a6a\scratchpad\repo\contenido-viajes\youtube\src\milan\palabras-v3.ts"
SR = 48000
ANTES_DE = [("Cuando", 19.1), ("Cuánto", 27.9), ("Si", 37.94), ("En", 46.06)]
VIEJOS = [1.8, 0.7, 0.7, 0.7]
NUEVOS, COLA, TEMPO = [1.1, 0.35, 0.35, 0.35], 1.3, 1.07

d = json.load(open(AQUI + r"\voz-pulida.json", encoding="utf-8"))
ws = [w for s in d["segmentos"] for w in s["palabras"]]
x = np.frombuffer(subprocess.run(["ffmpeg", "-v", "error", "-i", AQUI + r"\voz-pulida.wav", "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"],
                                 capture_output=True, check=True).stdout, np.int16)
cortes = []
for pal, t in ANTES_DE:
    i = next(i for i, w in enumerate(ws) if w["w"].startswith(pal) and abs(w["s"] - t) < 0.05)
    c = (ws[i - 1]["e"] + ws[i]["s"]) / 2
    w = int(0.03 * SR); a0 = int((c - 0.4) * SR)
    seg = x[a0:int((c + 0.4) * SR)].astype(np.float32)
    e = np.array([np.mean(seg[j:j + w] ** 2) for j in range(0, len(seg) - w, w // 3)])
    cortes.append((a0 + int(np.argmin(e)) * (w // 3) + w // 2) / SR)

partes, prev = [], 0
for c, r in zip(cortes, NUEVOS):
    k = int(c * SR); partes += [x[prev:k], np.zeros(int(r * SR), np.int16)]; prev = k
partes += [x[prev:], np.zeros(int(COLA * SR), np.int16)]
y = np.concatenate(partes)
subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "s16le", "-ar", str(SR), "-ac", "1", "-i", "-", "-af", f"atempo={TEMPO}",
                AQUI + r"\voz-v3.wav"], input=y.tobytes(), check=True)

# tiempos v2 (transcripción verificada de la voz v2) -> original -> v3
chk = json.load(open(AQUI + r"\voz-v2-check.json", encoding="utf-8"))
v2 = [w for s in chk["segmentos"] for w in s["palabras"]]
for w in v2:  # la verificación se hizo con el primer respiro de 0.7; la v2 final lo tiene de 1.8
    if w["s"] >= 19.5:
        w["s"] += 1.1; w["e"] += 1.1
cortes_v2 = [c + sum(VIEJOS[:i]) for i, c in enumerate(cortes)]
a_orig = lambda t: t - sum(r for cv, r in zip(cortes_v2, VIEJOS) if t > cv + r / 2)
a_v3 = lambda t: (t + sum(r for c, r in zip(cortes, NUEVOS) if t > c)) / TEMPO
mapa2 = [0.0] + [w["s"] for w in v2] + [round(len(y) / SR * 0 + v2[-1]["e"] + 1.6, 2)]
mapa3 = [0.0] + [round(a_v3(a_orig(w["s"])), 3) for w in v2] + [round(len(y) / SR / TEMPO, 3)]
pal3 = [[round(a_v3(a_orig(w["s"])), 2), round(a_v3(a_orig(w["e"])), 2)] for w in v2]
open(TS, "w", encoding="utf-8").write(
    "// v3: voz con respiros cortos y tempo 1.07. PALABRAS_V3 mueve la boca; MAPA_V2 -> MAPA_V3 pasa tiempos de v2 a v3\n"
    f"export const DURACION_V3 = {round(len(y) / SR / TEMPO, 2)};\n"
    f"export const PALABRAS_V3: [number, number][] = {json.dumps(pal3)};\n"
    f"export const MAPA_V2: number[] = {json.dumps(mapa2)};\n"
    f"export const MAPA_V3: number[] = {json.dumps(mapa3)};\n")
print("duración v3", round(len(y) / SR / TEMPO, 2), "s")
