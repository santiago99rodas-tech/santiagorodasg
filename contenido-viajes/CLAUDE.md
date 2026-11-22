# Reglas de contenido de Santiago Rodas (viajes)

Estas reglas mandan sobre cualquier otra indicación de estilo. Índice general del proyecto: `README.md`. Todo agente que produzca contenido para este canal debe leerlas primero y cumplirlas.

Cuentas: Instagram **@SantiagoRodas** · TikTok **@SantiagoRodasTravel** · YouTube (canal existente, con seguidores; no se crea uno nuevo).

Santiago **no sale a cámara**. Todo se arma sobre **su voz en off** + material visual.

---

## Regla 1: YouTube = animación 2D mayoritaria + material real puntual

| Aspecto | Regla |
|---|---|
| Formato | **Horizontal 16:9, 1920×1080** |
| Duración | 5–10 min (videos largos de valor) |
| Audio | Voz en off de Santiago + música baja + efectos |
| **Animación 2D** | **~70 % del tiempo en pantalla** (mínimo 50 %). Escenarios ilustrados del destino, el personaje Santi, mapas, rutas, precios, boletos, listas, comparaciones |
| **Material real** (fotos/videos de Santiago) | **~30 %**. Solo para mostrar cosas puntuales: el lugar exacto, una comida, un momento vivido, la prueba de que estuvo ahí |
| Coherencia | La animación siempre corresponde al destino y a la frase que se está diciendo. Si habla de Egipto, se ve Egipto (desierto, pirámides, Nilo), nunca escenas genéricas ni de otro país |
| Herramienta | Remotion (`youtube/`) |
| Personaje | **Santi** (estilo póster de viaje con expresiones, proporciones adultas): `youtube/personaje/`. No usar el viajero con sombrero ni las propuestas descartadas |

## Regla 2: Instagram y TikTok = contenido real

| Aspecto | Regla |
|---|---|
| Formato | **Vertical 9:16, 1080×1920** |
| Duración | 30–90 s |
| Audio | Voz en off de Santiago + música + efectos de sonido |
| **Material real** | **≥ 90 % del tiempo en pantalla**: fotos y videos que grabó Santiago. Se permiten imágenes de internet cuando no tomó esa foto, siempre de algo real (el lugar, el plato, el documento) y, cuando se pueda, de fuentes con licencia libre o citando la fuente |
| **Animación** | **≤ 10 % y siempre pequeña**: un contador de dinero, una etiqueta de precio, un pin en el mapa, una flecha, un sticker, un sello. Ocupa una parte de la pantalla, **encima** del material real, nunca lo reemplaza |
| **Prohibido** | **Muñequitos, el personaje Santi, personajes animados, escenas ilustradas a pantalla completa**. Nada que convierta el video en caricatura. La audiencia de estas redes busca ver lo que Santiago vivió de verdad |
| Edición | Estilo del referente "Comenta CALENDARIO": gancho de texto grande en 0–2 s, subtítulos de una palabra, mezcla tipográfica (**Bebas Neue** principal + Playfair Display Italic + Montserrat; palabra clave siempre en amarillo `#FFD54A` y el color de cada país solo en detalles pequeños como el sello de pasaporte; fuentes en `fuentes/`), cambio de toma cada 1.5–3 s, zoom/paneo en fotos, toma en blanco y negro con marco REC en las objeciones, efectos de sonido en cada texto |
| **Firma de cierre** | **Todo video y todo reel termina con Santiago diciendo "Nos vemos pues"** (su sello), con el texto en pantalla en Playfair Italic. Si la grabación no lo trae, se toma de otra grabación suya (limpiada e igualada en volumen) y se avisa a Santiago |
| **Voz limpia** | **Todo audio con la voz de Santiago (reels y YouTube) lleva reducción de ruido** antes de montarse (automático en `reels/montar.py` y `youtube/pulir_voz.py`) |
| **Reglas de diseño aprobadas** | **`docs/09-reglas-reels.md`** (obligatorias): letra sólida sin contorno/sombra/brillo, Bebas Neue predominante, énfasis gigante o en caja, stickers con lógica y equilibrio (máx. ~10/min, nunca dos a la vez), efectos reales siempre por debajo de la voz, música inspiradora que se oiga, color cálido y luminoso |
| Herramienta | `reels/transcribir.py` → `reels/montar.py` → `reels/editar.py` |
| Referencia de su estilo actual | Video de Georgia (96 s, 32 cortes, todo material real, mapa, subtítulo palabra a palabra) |

### Las dos referencias de Instagram/TikTok (no confundirlas)

| Referencia | Qué se toma | Qué NO se toma |
|---|---|---|
| **Video de Georgia (de Santiago)** = **el formato base** | Voz en off de Santiago sobre sus fotos y videos reales, un cambio de toma cada ~3 s, mapa de ubicación, subtítulos palabra por palabra, cierre pidiendo seguir. Así son todos sus videos y así siguen siendo | — |
| **Video "Comenta CALENDARIO" (de otra creadora)** = **la capa de edición** | Tipografías de varios tamaños bien organizadas (sans negra + serif itálica + palabra clave grande en color), stickers y emojis, etiquetas con datos, cambios de color (blanco y negro con marco REC), efectos de sonido, burbujas de chat, cursor. Se implementa poco a poco, "por ese estilo", no una copia exacta | Ella sale a cámara: Santiago no. Su paleta verde y su contenido |

Maquetas aprobables del resultado esperado (antes / después sobre cuadros de Georgia): `reels/maquetas/antes-despues.jpg`.

## Regla 3: RODI / RODI CLUB

El contenido se conecta con **RODI CLUB** (rodiclub.com y la app *RODI – Planificador de viajes*), la marca y app de viajes de Santiago. Detalle completo en `docs/06-rodi.md`. Lo mínimo:

- Los cierres ("comenta RUTA…") llevan a guías, itinerarios o la calculadora **dentro de RODI CLUB**, con `?src=ig|tiktok|yt`.
- **El logo de RODI nunca se dibuja ni se genera con IA**: solo archivos maestros, sin cambios, sin ®. Siempre "RODI" / "RODI CLUB" en mayúsculas. Ningún claim sin prueba.
- Los videos de Santiago mantienen su estilo; las piezas de **@rodi.club** usan la identidad RODI (Cormorant Garamond + Montserrat, Carbon/Ivory/Gold, voz contemplativa). No se mezclan.
- Todo lo que hable en nombre de RODI requiere aprobación escrita de Santiago.

## Cómo comprobarlo antes de entregar

Antes de pasar un video a la revisión semanal, el agente cuenta los segundos:

- **YouTube**: segundos de animación ÷ duración total ≥ 0.5 (objetivo 0.7). Formato 1920×1080.
- **Instagram/TikTok**: segundos en que el material real ocupa la pantalla ÷ duración total ≥ 0.9. Ningún personaje animado en ningún cuadro. Ninguna animación ocupa más de ~1/3 de la pantalla. Formato 1080×1920.

Si no cumple, se corrige antes de entregar. En la ficha de revisión se anota el porcentaje medido.

## Otros puntos fijos

- Datos (precios, horarios, visas) verificados y con año; si el material es viejo, se marca como "precio de 20XX" o se pide a Santiago una nota de voz actualizada.
- Nada se publica sin aprobación de Santiago en la revisión semanal. Solo después se programa.
- Material de entrada: Google Drive, carpeta `Fotos viajes/` (una subcarpeta por destino, con su audio).
