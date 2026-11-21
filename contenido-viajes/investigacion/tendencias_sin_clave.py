#!/usr/bin/env python3
"""Outliers de YouTube SIN clave y SIN cuenta: 100 % gratis.

Usa yt-dlp (programa libre y gratuito) para leer resultados de búsqueda y los
últimos videos de cada canal, y calcula cuántas veces superó cada video la
mediana de su propio canal (lo mismo que hacen herramientas de pago).

Instalación (una vez, gratis):
  pip install yt-dlp

Uso:
  python3 tendencias_sin_clave.py "egipto viaje" "que hacer en egipto" --n 40 --salida egipto.md
"""
import argparse
import json
import statistics
import subprocess
import sys


def ytdlp_json(url, limite=None):
    cmd = [sys.executable, "-m", "yt_dlp", "--flat-playlist", "-J", "--no-warnings", url]
    if limite:
        cmd[3:3] = ["--playlist-end", str(limite)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[:300])
    return json.loads(r.stdout)


def mediana_canal(canal_id, cache):
    if canal_id not in cache:
        try:
            d = ytdlp_json(f"https://www.youtube.com/channel/{canal_id}/videos", 20)
            vistas = [e.get("view_count") or 0 for e in d.get("entries", []) if e]
            cache[canal_id] = statistics.median(vistas) if vistas else 0
        except Exception:
            cache[canal_id] = 0
    return cache[canal_id]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("consultas", nargs="+")
    ap.add_argument("--n", type=int, default=30, help="resultados por consulta")
    ap.add_argument("--salida")
    a = ap.parse_args()

    vistos, filas, cache = set(), [], {}
    for q in a.consultas:
        d = ytdlp_json(f"ytsearch{a.n}:{q}")
        for e in d.get("entries", []):
            if not e or e.get("id") in vistos:
                continue
            vistos.add(e["id"])
            vistas = e.get("view_count") or 0
            med = mediana_canal(e.get("channel_id"), cache) if e.get("channel_id") else 0
            dur = e.get("duration") or 0
            filas.append({
                "mult": round(vistas / med, 1) if med else 0, "titulo": e.get("title", ""),
                "canal": e.get("channel") or e.get("uploader") or "", "vistas": vistas,
                "formato": "Short" if dur and dur <= 60 else ("Largo" if dur >= 300 else "Medio"),
                "min": round(dur / 60, 1), "url": f"https://youtu.be/{e['id']}",
            })
    filas.sort(key=lambda f: f["mult"], reverse=True)
    out = [f"# Outliers de YouTube: {', '.join(a.consultas)}", "",
           "| Mult. | Título | Canal | Vistas | Formato | Link |", "|---|---|---|---|---|---|"]
    out += [f"| **{f['mult']}x** | {f['titulo']} | {f['canal']} | {f['vistas']:,} | {f['formato']} {f['min']} min | {f['url']} |" for f in filas]
    out += ["", "Mult. = vistas ÷ mediana de los últimos 20 videos del canal."]
    texto = "\n".join(out)
    if a.salida:
        open(a.salida, "w", encoding="utf-8").write(texto + "\n")
        print(f"listo: {a.salida} ({len(filas)} videos)")
    else:
        print(texto)


if __name__ == "__main__":
    main()
