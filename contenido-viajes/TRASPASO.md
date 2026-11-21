# Traspaso de contexto

Este documento resume una conversación larga con Claude en la nube (21-nov-2026) para continuarla en una sesión de Claude Desktop en el computador de Santiago, que sí puede usar su Chrome. **Léelo completo antes de hacer nada.** Después lee `README.md`, `CLAUDE.md` y los `docs/` que se citan.

---

## 1. Quién es y qué quiere

- **Santiago Rodas**, creador de contenido de viajes. Instagram **@SantiagoRodas**, TikTok **@SantiagoRodasTravel**, canal de YouTube existente con seguidores (hoy solo Shorts, los mismos videos de IG/TikTok).
- Dueño de **RODI / RODI CLUB**: marca de moda de viaje por Chapters + app de viajes (rodiclub.com, app iOS "RODI – Planificador de viajes"). Ver `docs/06-rodi.md`.
- Escribe en español, mensajes cortos. Prefiere que Claude proponga y decida lo técnico, y pregunte solo lo que es suyo de decidir.

**Objetivo:** que Claude produzca casi todo su contenido. Santiago solo graba su voz, sube su material a Drive y revisa una vez por semana. Claude edita, arma carruseles, posts e historias, escribe textos y programa lo aprobado. Además: crecer YouTube con videos largos de valor y conectar todo con RODI CLUB.

## 2. Preferencias firmes de Santiago

1. **No sale a cámara.** Lo que mejor le ha funcionado es su **voz en off** sobre fotos y videos reales.
2. **Nada de pago.** Ninguna herramienta que cobre (descartados NexLev y la clonación de voz). Solo gratis/libre.
3. **Instagram y TikTok:** ≥ 90 % material real, ≤ 10 % animaciones pequeñas (precios, pins, stickers). **Cero muñequitos.** La gente en viajes quiere ver lo real.
4. **YouTube:** horizontal, 5–10 min, ~70 % animación 2D con su personaje + ~30 % material real puntual.
5. **El personaje no puede verse infantil**: le quitaría credibilidad.
6. Quiere **todo ordenado y claro**, en un solo lugar.

## 3. Decisiones tomadas (todas confirmadas por Santiago)

| Tema | Decisión |
|---|---|
| Base de IG/TikTok | Su **video de Georgia** (`referencias/santiago-video-georgia.mp4`) |
| Capa de edición | Inspirada en **"Comenta CALENDARIO"** (`referencias/ref-edicion-comenta-calendario.mp4`): tipografías de varios tamaños, stickers, B/N con marco REC, sonido. Implementar poco a poco, no copiar |
| Tipografía | **Bebas Neue** (principal, elegida por él) + Playfair Display Italic + Montserrat. En `fuentes/` |
| Color | **Opción C**: amarillo `#FFD54A` fijo en palabras clave + color de cada país solo en el **sello de pasaporte** y detalles |
| Personaje YouTube | **Santi**, estilo póster con expresiones, basado en su foto (`referencias/santiago-foto-referencia-personaje.jpg`). **Aprobado.** Archivos en `youtube/personaje/` |
| Inspiración YouTube | `referencias/ref-youtube-granja-animacion.mp4` (animación 2D, cámara que se mueve dentro de la escena) |
| Investigación y retención | Estrategia de `referencias/ref-investigacion-video-ducha.mp4`, pero **gratis**: scripts en `investigacion/` (yt-dlp sin clave, o API de YouTube con clave gratis). Ver `docs/05-investigacion-y-retencion.md` |
| Revisión | **Domingos**, 30–45 min |
| Programación | Desde su Chrome: Meta Business Suite, TikTok Studio, YouTube Studio. Solo lo aprobado, mostrando antes video, texto, fecha y hora |
| Material | Google Drive, carpeta **`Fotos viajes/`**, una subcarpeta por destino (+ `Guiones/`) |
| RODI | Los cierres ("comenta RUTA") llevan a guías e itinerarios en RODI CLUB con `?src=ig/tiktok/yt`. La app aparece como material real. El sello del video = el sello del pasaporte de la app. Logo de RODI **nunca generado con IA** |
| Skills de texto | 13 skills `ig-*` del repo `Jakeschincariol/instagram-agent-skill` (guía en `referencias/guia-13-skills-instagram.pdf`). Instalar en Claude Code del PC |

## 4. Qué hay construido (rama `ccr-103411ab-mfj82d`)

- `README.md`: índice, decisiones, estado, pendientes, fases.
- `CLAUDE.md`: reglas obligatorias para agentes.
- `docs/01`–`06`: flujo de trabajo, IG/TikTok, YouTube, referencias analizadas, investigación/retención, RODI.
- `reels/editar.py`: editor ffmpeg (gancho tipográfico, B/N + REC, subtítulos de una palabra, zoom, stickers, máquina de escribir, CTA, efectos de sonido). Maquetas antes/después en `reels/maquetas/`.
- `youtube/`: proyecto Remotion (prueba con un personaje viejo descartado) y `youtube/personaje/` con Santi.
- `investigacion/egipto.md`: investigación preliminar por búsqueda web (falta cruzar con outliers).
- `guiones/egipto-youtube-largo.md`: guion de 8–10 min con estrategia de retención. **Faltan 4 respuestas de Santiago** (año/mes/días/ruta, precios, estafas vividas, qué museo visitó). Él dice que **tiene varios videos de Egipto en su Instagram**: sacar las respuestas de ahí.
- `.claude/agents/` (raíz del repo): `editor-reels` y `editor-youtube`.
- `referencias/`: todos los videos, imágenes y el PDF que Santiago envió.

## 5. Lo que no se pudo hacer en la nube (por eso el traspaso)

- La sesión en la nube **no puede usar su Chrome**: su computador (LaRodajaOficial) aparece en Remote Control pero no ofrece carpetas a sesiones en la nube.
- La red de la nube no llega a Instagram, TikTok ni YouTube. No se pudieron revisar sus perfiles ni probar los scripts de `investigacion/`.
- No se pudo transcribir audio (el modelo de Whisper no se puede descargar en la nube). En el PC sí: `pip install faster-whisper`.

## 6. Tareas inmediatas para esta sesión (en orden)

**Ya hechas por la sesión del PC (21-nov-2026):** inventario de redes (`docs/05-inventario.md`), estudio de nicho y público (`docs/07-nicho-y-publico.md`) y respuestas del guion de Egipto sacadas de sus videos (`guiones/egipto-youtube-largo.md`). Hallazgos clave: lo que más rinde son los **tips prácticos** (maleta de 10 kg: 110 K IG / 122 K TikTok) y los **lugares poco comunes con relato emocional** (Oporto 64 K, "Vivir en silencio" 50 K); público hispano con base en **Colombia**, dos grupos (**25–34** y **55+**); casi nadie vuelve (falta comunidad); en TikTok **2/3 del tráfico es búsqueda**. Egipto fue en **sept-2023**, 5 días, en familia, con guía y crucero; **sin precios ni estafas** en los videos.

**Hechas además el 21-nov-2026 (sesión del PC):** cambios del guion de Egipto aplicados (gancho 2:30 a. m., bloque de regateo, Tutankamón en museo antiguo vs. GEM, título con crucero); Python 3.12 + yt-dlp instalados y outliers de 7 temas en `investigacion/outliers/`; parrilla de 4 semanas en `docs/08-parrilla.md`; `voice.md` lleno. **Falta:** instalar las skills `ig-*` (Santiago, ver `docs/01`) y lo que Santiago debe mandar (precios de Egipto, transporte Cairo–Luxor/Asuán, confirmar sept-2023, capturas de estadísticas de Instagram).

Siguiente (original):
1. Pedir a Santiago lo que falta del guion de Egipto: **precios** (vuelos, visa, paquete crucero + guía, hoteles, entradas, Abu Simbel, propinas), cómo se movió Cairo ↔ Luxor/Asuán, y confirmar la fecha. Aplicar los cambios propuestos al guion (gancho sin "estafas", bloque de regateo con los mercaderes del Nilo, bloque del museo antiguo vs. GEM).
2. Instalar `yt-dlp` y correr `investigacion/tendencias_sin_clave.py` con Egipto y sus destinos fuertes (Portugal/Oporto, Georgia, Marruecos, EAU, Suiza). Actualizar `investigacion/`.
3. Replantear la parrilla con el inventario: más **tips prácticos buscables** + **lugar poco común con emoción**; series con continuidad y cierres a RODI CLUB para crear comunidad. Pedir capturas de *Estadísticas → Seguidores* de la app de Instagram (la web no da edad/país).
4. Instalar las skills `ig-*` y llenar `~/.claude/instagram/voice.md` con el estudio de público (tono antioqueño auténtico).
5. Subir todo a la rama `ccr-103411ab-mfj82d`.

## 7. Pendientes de Santiago

- Subir a Drive `Fotos viajes/Georgia/` con su audio y las tomas originales **sin subtítulos** (para rehacer Georgia como primer reel con el estilo nuevo).
- Subir los guiones que ya grabó (`Fotos viajes/Guiones/`).
- Grabar el guion de Egipto y subir `Fotos viajes/Egipto/` con audio y material.
- RODI: decir qué destinos tienen guía o itinerario publicado en RODI CLUB, pasar los SVG del logo y decidir si también se produce **@rodi.club** (con la identidad de RODI, no la suya).

## 8. Pendientes técnicos (después de lo anterior)

1. Editor de reels: montaje de muchas tomas sobre la voz, movimiento en fotos, etiquetas con emoji, mapa con ruta animada, transiciones, sello de pasaporte (basado en `rodi-stamps.css` del tema de RODI), música con ducking, transcripción y corte de silencios.
2. Medición automática de % material real / % animación.
3. Animar a Santi en Remotion y reemplazar el personaje de la prueba; biblioteca de escenas por destino.
4. Tablero de revisión semanal.
5. Primer reel real (Georgia rehecho) y piloto de YouTube (Egipto).
