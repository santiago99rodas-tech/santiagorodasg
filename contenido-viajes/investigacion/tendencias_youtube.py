#!/usr/bin/env python3
"""Busca qué videos de viajes están funcionando en YouTube, gratis.

Reemplazo gratuito de herramientas como NexLev: usa la YouTube Data API v3
(cuota gratis de 10.000 unidades al día) y calcula el "multiplicador de outlier":
cuántas veces superó un video el promedio reciente de su propio canal.
Un canal pequeño con un video 10x por encima de su promedio dice más sobre lo
que la gente quiere ver que un canal gigante con un video normal.

Uso:
  export YOUTUBE_API_KEY=...            # clave gratis de Google Cloud
  python3 tendencias_youtube.py "egipto viaje" "que hacer en egipto" --dias 180 --idioma es
  python3 tendencias_youtube.py "georgia viaje" --salida georgia.md

Costo aproximado de cuota por consulta: 100 (búsqueda) + ~3 por canal encontrado.
Con 10.000 unidades diarias alcanzan ~50 consultas al día.

Solo usa la biblioteca estándar de Python.
"""
import argparse
import datetime as dt
import json
import os
import re
import statistics
import sys
import urllib.parse
import urllib.request

API = "https://www.googleapis.com/youtube/v3/"


def get(endpoint, **params):
    params["key"] = os.environ["YOUTUBE_API_KEY"]
    url = API + endpoint + "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.load(r)


def chunks(xs, n=50):
    for i in range(0, len(xs), n):
        yield xs[i:i + n]


def duracion_seg(iso):
    m = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", iso or "")
    if not m:
        return 0
    h, mi, s = (int(x or 0) for x in m.groups())
    return h * 3600 + mi * 60 + s


def buscar(q, dias, idioma, region, n):
    desde = (dt.datetime.utcnow() - dt.timedelta(days=dias)).strftime("%Y-%m-%dT%H:%M:%SZ")
    r = get("search", part="id", q=q, type="video", order="viewCount", maxResults=n,
            publishedAfter=desde, relevanceLanguage=idioma, regionCode=region)
    return [it["id"]["videoId"] for it in r.get("items", [])]


def videos(ids):
    out = {}
    for c in chunks(ids):
        r = get("videos", part="snippet,statistics,contentDetails", id=",".join(c))
        for v in r.get("items", []):
            out[v["id"]] = v
    return out


def promedio_canal(canal_id, cache):
    """Mediana de vistas de los últimos ~20 videos del canal (costo: ~3 unidades)."""
    if canal_id in cache:
        return cache[canal_id]
    ch = get("channels", part="contentDetails,statistics", id=canal_id)["items"][0]
    uploads = ch["contentDetails"]["relatedPlaylists"]["uploads"]
    pl = get("playlistItems", part="contentDetails", playlistId=uploads, maxResults=20)
    ids = [i["contentDetails"]["videoId"] for i in pl.get("items", [])]
    vistas = [int(v["statistics"].get("viewCount", 0)) for v in videos(ids).values()]
    med = statistics.median(vistas) if vistas else 0
    cache[canal_id] = (med, int(ch["statistics"].get("subscriberCount", 0) or 0))
    return cache[canal_id]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("consultas", nargs="+")
    ap.add_argument("--dias", type=int, default=365)
    ap.add_argument("--idioma", default="es")
    ap.add_argument("--region", default="CO")
    ap.add_argument("--n", type=int, default=25, help="videos por consulta (máx 50)")
    ap.add_argument("--salida", default=None, help="archivo .md de salida")
    a = ap.parse_args()
    if "YOUTUBE_API_KEY" not in os.environ:
        sys.exit("Falta YOUTUBE_API_KEY (clave gratis en console.cloud.google.com → YouTube Data API v3)")

    ids = []
    for q in a.consultas:
        ids += buscar(q, a.dias, a.idioma, a.region, a.n)
    ids = list(dict.fromkeys(ids))
    info = videos(ids)
    cache, filas = {}, []
    hoy = dt.datetime.utcnow()
    for vid, v in info.items():
        sn, st = v["snippet"], v["statistics"]
        vistas = int(st.get("viewCount", 0))
        med, subs = promedio_canal(sn["channelId"], cache)
        dias = max(1, (hoy - dt.datetime.strptime(sn["publishedAt"][:19], "%Y-%m-%dT%H:%M:%S")).days)
        dur = duracion_seg(v["contentDetails"].get("duration"))
        filas.append({
            "titulo": sn["title"], "canal": sn["channelTitle"], "url": f"https://youtu.be/{vid}",
            "vistas": vistas, "mult": round(vistas / med, 1) if med else 0, "subs": subs,
            "vistas_dia": round(vistas / dias), "dias": dias,
            "formato": "Short" if dur <= 60 else ("Largo" if dur >= 300 else "Medio"), "dur_min": round(dur / 60, 1),
            "comentarios": int(st.get("commentCount", 0)),
        })
    filas.sort(key=lambda f: f["mult"], reverse=True)

    lineas = [f"# Outliers de YouTube: {', '.join(a.consultas)}", "",
              f"Últimos {a.dias} días · idioma {a.idioma} · región {a.region} · generado {hoy:%Y-%m-%d}", "",
              "| Mult. | Título | Canal | Subs | Vistas | Vistas/día | Formato | Link |", "|---|---|---|---|---|---|---|---|"]
    for f in filas:
        lineas.append(f"| **{f['mult']}x** | {f['titulo']} | {f['canal']} | {f['subs']:,} | {f['vistas']:,} | {f['vistas_dia']:,} | {f['formato']} {f['dur_min']} min | {f['url']} |")
    lineas += ["", "Mult. = vistas del video ÷ mediana de vistas de los últimos 20 videos del canal."]
    texto = "\n".join(lineas)
    if a.salida:
        open(a.salida, "w", encoding="utf-8").write(texto + "\n")
        print(f"listo: {a.salida} ({len(filas)} videos)")
    else:
        print(texto)


if __name__ == "__main__":
    main()
