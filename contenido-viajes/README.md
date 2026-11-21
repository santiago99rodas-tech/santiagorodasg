# Contenido de viajes de Santiago Rodas

Sistema para producir el contenido de viajes con Claude: Reels de Instagram (**@SantiagoRodas**), TikToks (**@SantiagoRodasTravel**) y videos largos de YouTube (canal existente), conectado con **RODI CLUB**, la app de viajes de Santiago.

Santiago graba su voz y sube su material a Drive; Claude produce todo; Santiago revisa una vez por semana; Claude programa lo aprobado.

> **Agentes: lean primero [`CLAUDE.md`](CLAUDE.md).** Son las reglas obligatorias de estilo.
>
> **¿Sesión nueva?** Empieza por [`TRASPASO.md`](TRASPASO.md): todo el contexto de la conversación original, preferencias de Santiago y tareas inmediatas.

---

## Decisiones tomadas

| # | Decisión |
|---|---|
| 1 | Santiago **no sale a cámara**. Todo es su **voz en off** + material visual |
| 2 | **Instagram y TikTok**: vertical, **≥ 90 % material real**, **≤ 10 % animaciones pequeñas** encima (precios, pins, stickers). **Cero muñequitos** |
| 3 | La **base** de Instagram/TikTok es su formato del **video de Georgia**; la **capa de edición** sale del video **"Comenta CALENDARIO"** (tipografías, stickers, color, sonido), implementada poco a poco, sin copiarla |
| 4 | **YouTube**: horizontal, 5–10 min, **~70 % animación 2D** (mínimo 50 %) + **~30 % material real** puntual |
| 5 | El personaje de YouTube es **Santi**: estilo póster de viaje, proporciones adultas y **con expresiones**, para no perder credibilidad. Basado en su foto. **Aprobado.** |
| 6 | Material de entrada en **Google Drive**, carpeta `Fotos viajes/`, una subcarpeta por destino |
| 7 | **Revisión semanal los domingos**: Santiago aprueba / rechaza / comenta todo el lote |
| 8 | **Programación desde el Chrome de Santiago** (Meta Business Suite, TikTok Studio, YouTube Studio) solo con lo aprobado |
| 9 | Los textos se apoyan en las **13 skills `ig-*`** (guiones, captions, carruseles, DMs) |
| 10 | Un agente distinto por plataforma: `editor-reels` y `editor-youtube` (`.claude/agents/`) |
| 12 | Tipografía principal **Bebas Neue**; secundarias Playfair Display Italic y Montserrat. Todas gratis |
| 14 | Todo el contenido se conecta con **RODI CLUB** (su app de viajes): los cierres llevan a guías e itinerarios en RODI, la app aparece como material real, el sello de pasaporte es el mismo de la app. Ver `docs/06-rodi.md` |
| 13 | Color: **amarillo fijo** en palabras clave + **color de cada país** en el sello de pasaporte y detalles (opción C) |
| 11 | Antes de cada destino se investiga **qué quiere ver la gente** y después de publicar se mide **la retención**, todo con herramientas **gratis** (YouTube Data API, vidIQ plan gratis, YouTube Studio). Nada de NexLev ni clonación de voz |

## Documentación

| Archivo | Contenido |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Reglas obligatorias para agentes (porcentajes, formatos, prohibiciones, cómo medir) |
| [`docs/01-flujo-de-trabajo.md`](docs/01-flujo-de-trabajo.md) | Roles, Drive, semana tipo, revisión, programación, skills `ig-*`, `voice.md` |
| [`docs/02-instagram-tiktok.md`](docs/02-instagram-tiktok.md) | Fórmula, lenguaje de edición, identidad visual, formatos de serie, IG vs TikTok |
| [`docs/03-youtube.md`](docs/03-youtube.md) | Fórmula, personaje Santi, escenas, equipo de agentes, Remotion |
| [`docs/04-referencias.md`](docs/04-referencias.md) | Análisis de los videos de referencia |
| [`docs/05-investigacion-y-retencion.md`](docs/05-investigacion-y-retencion.md) | Investigar temas que funcionan y medir retención, gratis |
| [`docs/06-rodi.md`](docs/06-rodi.md) | Integración con RODI / RODI CLUB y reglas de marca |

## Estructura de carpetas

```
contenido-viajes/
├─ README.md                  ← este índice
├─ CLAUDE.md                  ← reglas para agentes
├─ TRASPASO.md                ← contexto completo para una sesión nueva
├─ referencias/               ← videos, fotos y PDF que envió Santiago
├─ docs/                      ← documentación
├─ fuentes/                   ← Bebas Neue, Playfair Display, Montserrat (gratis, licencia OFL)
├─ investigacion/             ← scripts de outliers del nicho y un .md por destino (egipto.md)
├─ guiones/                   ← guiones listos para grabar (egipto-youtube-largo.md)
├─ reels/                     ← Instagram y TikTok
│  ├─ editar.py               editor (ffmpeg) que aplica la capa de edición
│  ├─ plan-demo.json          ejemplo de plan de edición
│  ├─ demo-efectos.mp4        demo de los efectos del editor
│  └─ maquetas/               antes/después sobre cuadros de Georgia
└─ youtube/                   ← YouTube
   ├─ src/                    proyecto Remotion (animación)
   ├─ personaje/              Santi: hoja de poses y expresiones, escena de Egipto
   │  └─ descartadas/         propuestas de estilo 1–4 originales
   └─ pruebas/                renders de prueba
.claude/agents/               ← editor-reels.md, editor-youtube.md (en la raíz del repo)
```

## Estado

### Hecho
- Análisis de las 3 referencias y del repo de skills.
- Reglas para agentes y dos agentes separados por plataforma.
- Editor de reels con: gancho tipográfico, cámara 2 (B/N + REC), subtítulos de una palabra, zoom, stickers, máquina de escribir, CTA y efectos de sonido.
- Maquetas antes/después del nuevo estilo sobre Georgia.
- Prueba animada de Remotion (con personaje descartado) y 4 propuestas de estilo.
- Personaje Santi en estilo póster con 3 poses y 6 expresiones.

### Pendiente de Santiago
| # | Qué | Para qué |
|---|---|---|
| 1 | ~~Aprobar a Santi~~ ✔ aprobado | — |
| 2 | ~~Maquetas, tipografía y color~~ ✔ decididos | — |
| 3 | Subir **`Fotos viajes/Georgia/`** con audio y tomas originales sin subtítulos | Primer reel real: rehacer Georgia y comparar |
| 4 | Subir **`Fotos viajes/Guiones/`** con los guiones grabados y su material | Primer lote de reels |
| 5 | Responder las 4 preguntas de `guiones/egipto-youtube-largo.md`, grabar ese guion y subir **`Fotos viajes/Egipto/`** con el audio y el material | Piloto de YouTube |
| 7 | Instalar **Claude in Chrome** y las **skills `ig-*`** en su computador | Programación y textos |
| 8 | Estudio de **nicho y público** a partir de sus redes (lo hace la sesión del PC con Chrome; Santiago aporta capturas de estadísticas de audiencia si hace falta) | Tono y temas |
| 9 | Crear la **clave gratis de YouTube Data API** (pasos en `docs/05`) | Investigación de tendencias |
| 10 | Dar acceso a **YouTube Studio Analytics** (vía Chrome) | Análisis de retención |

### Pendiente técnico (Claude)
| # | Qué | Plataforma |
|---|---|---|
| 1 | Montaje de muchas tomas sobre la voz (hoy el editor trabaja sobre un solo clip) | Reels |
| 2 | Movimiento en fotos, etiquetas de precio con emoji, mapa con ruta animada, transiciones | Reels |
| 3 | Música con ducking | Ambas |
| 4 | Transcripción con tiempo por palabra y corte de silencios (Whisper; corre en el computador de Santiago, bloqueado en la nube) | Ambas |
| 5 | Medición automática de % material real / % animación | Ambas |
| 6 | Animar a Santi en Remotion y reemplazar el personaje de la prueba | YouTube |
| 7 | Biblioteca de escenas reutilizables (desierto, ciudad, playa, montaña, aeropuerto, mapa, dinero, listas) | YouTube |
| 8 | Tablero de revisión semanal | Ambas |
| 9 | Probar `investigacion/tendencias_youtube.py` con la clave y generar el informe del primer destino | Ambas |
| 10 | Analista de retención: informe cada 2 semanas | Ambas |

## Hoja de ruta

| Fase | Contenido | Depende de |
|---|---|---|
| **1. Estilo e investigación** | Aprobar Santi y la guía visual de reels; informe de tendencias del primer destino | Pendientes 1–2 y 9 de Santiago |
| **2. Primer reel** | Rehacer Georgia con el estilo nuevo, comparar antes/después | Pendiente 3 + técnicos 1–5 |
| **3. Piloto YouTube** | Video completo de Egipto con Santi | Pendiente 5 + técnicos 4, 6, 7 |
| **4. Operación semanal** | Lotes de 3 reels + 1 carrusel + historias; YouTube cada 2 semanas; revisión y programación | Pendientes 4, 6, 7 + técnico 8 |
| **5. Medir y ajustar** | Auditoría cada 2 semanas, revisión mensual del nicho | Fase 4 en marcha |
