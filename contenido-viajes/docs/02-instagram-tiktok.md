# Instagram y TikTok

Instagram **@SantiagoRodas** · TikTok **@SantiagoRodasTravel**. Reglas obligatorias en `../CLAUDE.md`.

## Fórmula

**Base de Georgia + capa de edición de "Comenta CALENDARIO"** (ver `04-referencias.md`).

| | Regla |
|---|---|
| Formato | Vertical 9:16, 1080×1920, 30–90 s |
| Audio | Voz en off de Santiago + música baja que se aparta cuando habla + efectos de sonido |
| Material real | **≥ 90 % del tiempo**: fotos y videos de Santiago. Imágenes de internet solo si muestran algo real que no fotografió |
| Animación | **≤ 10 %, pequeña y encima del material**: contador de dinero, etiqueta de precio, pin, flecha, sticker, sello. Máximo ~1/3 de la pantalla |
| Prohibido | Muñequitos, personajes, el personaje de YouTube, escenas ilustradas a pantalla completa |

## Lenguaje de edición

> **Las reglas de diseño aprobadas (texto, stickers, sonido, color) están en [`09-reglas-reels.md`](09-reglas-reels.md) y mandan sobre esta sección.**

- **Gancho en 0–2 s**: la toma más fuerte del viaje + texto grande con el dato.
- **Un cambio de toma por frase** (cada 1.5–3 s). Cada sustantivo importante tiene su imagen.
- **Fotos siempre con movimiento**: zoom lento o paneo.
- **Subtítulo de una palabra** al centro; la palabra clave en color.
- **Tres tipografías con rol fijo**: Bebas Neue para lo que se dice y la palabra clave enorme en el color de acento; Playfair Display Italic para el matiz; Montserrat para etiquetas y datos.
- **Datos como etiquetas**: tarjeta blanca con emoji + precio.
- **Mapa** con la ruta que se dibuja.
- **Cámara 2**: la toma pasa a blanco y negro con marco REC en las objeciones ("pero… ¿es seguro?"), con burbuja de chat de la duda.
- **Transiciones**: flash blanco o barrido en los cambios de lugar; cortes al golpe de la música.
- **Sonido**: efectos reales con lógica (lo que se nombra, suena), siempre por debajo de la voz; música inspiradora/épica que se sienta. Detalle en `09-reglas-reels.md`.
- **Cierre**: "comenta *PALABRA* y te mando mi ruta" (en vez de botones like/follow).

Maquetas de referencia (antes/después sobre cuadros de Georgia): `../reels/maquetas/antes-despues.jpg`. Opciones de color comparadas: `../reels/maquetas/opciones-color.jpg` (elegida la C).

## Identidad visual

| Elemento | Valor | Estado |
|---|---|---|
| **Color (opción C)** | **Amarillo `#FFD54A` fijo** para gancho y palabras clave en todos los videos + **color del país** solo en detalles pequeños (sello de pasaporte, pines del mapa, etiquetas). Si el fondo es amarillo/naranja (desierto, atardecer), las palabras clave van en blanco sobre franja oscura | **Decidido por Santiago** |
| Oscuro | Café `#2B1A12` | Propuesto |
| **Tipografía principal** | **Bebas Neue**: ganchos, palabra clave gigante, subtítulos palabra por palabra | **Decidido por Santiago** |
| Secundaria emocional | **Playfair Display Italic**: el matiz ("de Europa?", "¿es seguro?", "comenta", "mi ruta") | Propuesto |
| Secundaria de lectura | **Montserrat** (Medium/Bold/ExtraBold): etiquetas de precio, burbujas, datos pequeños, REC | Propuesto |
| Firma propia | Sello de pasaporte con el nombre del país (en el color del país) al aparecer cada destino | **Decidido** (parte de la opción C) |

## Formatos de serie (rotar, no repetir el mismo seguido)

1. **"Gasté $X en…"**: presupuesto real desglosado. CTA: comenta "PRESUPUESTO".
2. **"3 errores que cometí en…"**: cámara 2 en cada error, tachado rojo.
3. **"Itinerario de N días"**: mapa con la ruta. CTA: comenta "RUTA".
4. **"Lo que nadie te dice de…"**: la objeción del público en burbuja de chat.
5. **"Esto vs. esto"**: lo que esperas / lo que es; comparación de precios.
6. **"Día en…"**: vlog rápido de 30 s con sonido ambiente.

## Instagram vs. TikTok

| | Instagram | TikTok |
|---|---|---|
| Duración ideal | 30–60 s | 20–45 s, primera palabra en 0.5 s |
| CTA | "Comenta PALABRA" → DM con la guía | "Guárdalo" / "Parte 2" |
| Zona segura del texto | Libres 250 px abajo y 120 px a la derecha | Libres 380 px abajo y 140 px a la derecha |
| Caption | Primera línea que sobrevive al "más", palabras de búsqueda, máx. 5 hashtags (`/ig-caption`) | Más corto, 3–5 hashtags de búsqueda |

Del mismo montaje salen las dos versiones; solo cambian el cierre y la zona segura.

## Herramienta: `../reels/editar.py`

Lee un plan JSON y renderiza con ffmpeg. Ya hace: gancho tipográfico, cámara 2 (B/N + REC), subtítulos de una palabra, zoom de golpe, stickers, máquina de escribir, CTA y efectos de sonido sincronizados. Demo: `../reels/demo-efectos.mp4`.

Con `../reels/montar.py` (tomas, transiciones, color cálido, voz + música con ducking) y `../reels/transcribir.py` (Whisper) ya está todo el flujo: ver el paso a paso en `09-reglas-reels.md`. Falta: mapa real de la zona y corte automático de silencios.
