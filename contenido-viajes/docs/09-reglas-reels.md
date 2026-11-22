# Reglas de diseño de reels (Instagram y TikTok)

Aprobadas por Santiago el 21-nov-2026, después de 5 versiones de prueba con el material de Milán–Venecia
(`reels/pruebas/milan-venecia/`, versión aprobada: **v5**, plan `hacer_plan_v5.py`).
Estas reglas mandan sobre cualquier otra indicación de edición de reels en el repo. Las reglas de contenido
(≥ 90 % material real, ≤ 10 % animación, nada de muñequitos) siguen en `CLAUDE.md`.

## Lo que se aprendió en cada versión

| Versión | Lo que dijo Santiago | Qué cambió |
|---|---|---|
| v1 | "Le falta emoción, sentimiento, efectos visuales y de sonido, textos más dinámicos" | Se pasó de fotos con subtítulos a edición completa |
| v2 | "Vamos bien" | Música, transiciones, texto cinético, contador, mapa, sellos |
| v3 | No le gustaron los contornos, las sombras ni los brillos en las letras. Pidió más stickers y sonidos con lógica | Texto sólido, stickers 3D, sonidos reales |
| v3 (ajuste) | "Debe haber equilibrio, no en todas las tomas stickers" | De 22 stickers a 10 |
| v4 | Los efectos tapaban la voz, Bebas debe predominar, la letra manuscrita se veía infantil, la música casi no se oía | Efectos por debajo de la voz, sin manuscrita, música más presente |
| v5 | El filtro era muy oscuro, le quitaba calidez | Filtro cálido y luminoso → **aprobada** |

## 1. Texto

| Regla | Detalle |
|---|---|
| **Letra sólida** | Nunca contorno, sombra, brillo ni halo en las letras. Color plano |
| **Lectura sobre fotos claras** | Se logra con un **velo**: una franja negra muy difusa y transparente **detrás** del bloque de texto (`_velo`, alfa `A8`; en subtítulos `B8`). Nunca oscureciendo la letra ni todo el video |
| **Tipografía principal: Bebas Neue** | Debe predominar: ganchos, títulos, cajas, contador, nombres de lugar, CTA |
| **Acentos: Playfair Display Italic** | La parte emotiva o el matiz ("sí, claro…", "tiene su encanto", "de Italia"). Blanca (`serif`) o amarilla en negrita (`serifacc`) |
| **Textos pequeños: Montserrat ExtraBold** | Subtítulos palabra por palabra, frases de enlace ("nos pidan", "y no tener"), etiquetas |
| **Prohibido** | Tipografías extremas o infantiles (se descartó *Permanent Marker*). Anton existe en `fuentes/` pero no se usa por defecto |
| **Énfasis** | La palabra fuerte va **gigante en amarillo** (`big`: DESCANSAR?, CANALES, LAS GANAS) **o en caja sólida**: amarilla (LA RENUNCIA, TU MEJOR MOMENTO), blanca (ARQUITECTURA) o negra (CARRETERAS, nombres en pantalla dividida). Un énfasis por bloque |
| **Entradas** | Palabra fuerte: `golpe` (entra grande y cae). Frase emotiva: `sube` o `foco` (entra desenfocada). Etiquetas: `pop` |
| **Ritmo** | Cada línea aparece justo cuando Santiago la dice (tiempos de la transcripción con Whisper) |
| **Subtítulos** | Una palabra a la vez, en la parte baja; las palabras clave van en caja amarilla. Se ocultan mientras hay un bloque grande en pantalla. Sin puntuación al final |
| **Colores** | Amarillo `#FFD54A` para el énfasis, blanco para el resto. El color del país solo en el sello de pasaporte (y pines del mapa) |
| **Zona segura** | Instagram: libres 250 px abajo y 120 px a la derecha. TikTok: 380 px abajo y 140 px a la derecha |

## 2. Stickers

| Regla | Detalle |
|---|---|
| **Equilibrio** | Unos **10 por minuto como máximo** (≈ 1 cada 6–7 s). **Nunca dos a la vez** y nunca en todas las tomas: muchas tomas van solo con foto y texto |
| **Lógica** | El sticker aparece **cuando se nombra** lo que muestra: "descansar" → dormido, "48 horas" → reloj, "tren" → tren, "fotografías" → cámara, "imposibles" → cabeza explotando, "enamorarse" → carita enamorada, "comenta" → globo de mensaje |
| **Estilo** | Emoji 3D de Microsoft Fluent (licencia MIT), en `reels/recursos/stickers/`. Entran con rebote, flotan suave y salen encogiéndose |
| **Tamaño y lugar** | 200–260 px, en una esquina o un lado, sin tapar caras ni el texto |
| **Firma** | El sello de pasaporte (fondo de papel marfil, color del país) aparece al llegar a cada ciudad o país |

## 3. Sonido

| Regla | Detalle |
|---|---|
| **Voz limpia (siempre)** | **Todo audio con la voz de Santiago lleva reducción de ruido** (pedido el 22-nov-2026: se oía ruido detrás de la voz). Se hace automático con una red neuronal especializada en voz (RNNoise, modelo libre `reels/recursos/ruido/bd.rnnn`) + filtro de graves a 80 Hz, dentro de `montar.py` y `youtube/pulir_voz.py`. No se desactiva salvo que Santiago lo pida |
| **La voz manda** | Los efectos **nunca suenan por encima de la voz**. El editor los baja solos cuando Santiago habla (sidechain con la voz; queda entre 7 y 15 dB por debajo) y los deja completos en los silencios, donde dan el impacto |
| **Efectos con lógica** | Suena lo que se nombra: pasos al "caminar", ciudad al llegar a Milán, flashes en "la moda", tren y bocina en "tren", tacones en "pasarela", campanas y agua al llegar a Venecia, obturador en "fotografías"/"fachadas", latido en "enamorarse" |
| **Efectos de impacto** | `impacto` (palabra fuerte, contador), `impacto2` (sello), `whoosh` (título), `pop` (caja, sticker), `magia` (frase bonita), `ding` (CTA) |
| **Origen** | Sonidos reales de Mixkit (gratis, sin atribución) en `reels/recursos/sfx/`, con nombre en español. Si falta un efecto, se descarga de Mixkit y se guarda ahí |
| **Música** | **Inspiradora, épica o motivacional** de la Biblioteca de audio de YouTube (género Cinematográfica, ánimo Inspirador). Probadas: *Cutscene Crush* y *Taking Flight* (Blue Deer Studio) |
| **Nivel de música** | Se tiene que sentir siempre: ~**10 dB por debajo de la voz** mientras habla (`volumen_musica` 0.9, `ducking_ratio` 2.5) y sube en los silencios. Antes iba a −22 dB y "casi no se escuchaba" |
| **Música con la historia** | Si la canción arranca suave y crece, se hace coincidir el crecimiento con el momento fuerte del guion (en Milán–Venecia, con "48 horas") |
| **Limitador final** | Pico máximo −1 dB, nada de saturación |

## 4. Imagen

| Regla | Detalle |
|---|---|
| **Color cálido y luminoso** | Tipo atardecer: `gamma 1.08`, brillo `+0.02`, saturación `1.12`, balance hacia naranja en sombras, medios y luces. **Nada de look oscuro de cine** |
| **Viñeta y grano** | Viñeta suave (`PI/7`) y grano leve (`4`) |
| **Ritmo** | Un corte cada 1.5–2.5 s (Milán–Venecia: 44 tomas en 75 s). Cada sustantivo importante tiene su imagen |
| **Fotos con movimiento** | Zoom hacia dentro/fuera o paneo, siempre con salida rápida y frenado suave |
| **Transiciones** | Rotan entre barrido, zoom, desenfoque y deslizamiento (0.3 s). **Flash blanco** al cambiar de ciudad o en una revelación |
| **Recursos de apoyo** (con medida) | Contador que sube (cifras: horas, dinero, días), mapa con la ruta que se dibuja, pantalla dividida para comparar dos lugares, tramo en blanco y negro con marco REC para la frase de giro, máquina de escribir para la conclusión |
| **Cierre** | "comenta *PALABRA*" (Playfair blanca + la palabra en Bebas amarilla gigante) + "y te mando mi ruta" en caja blanca + sticker de mensaje + ding |

## 5. Cómo se hace un reel (paso a paso)

1. **Material**: Santiago sube a Drive `Fotos viajes/<Destino>/` el audio de su voz y las fotos/videos.
2. **Transcribir**: `python reels/transcribir.py voz.mp3 transcripcion.json` (Whisper con tiempo por palabra).
3. **Plan**: un script `hacer_plan.py` como `reels/pruebas/milan-venecia/hacer_plan_v5.py`, con las tomas (una por frase), los bloques de texto con sus tiempos, los stickers y los sonidos según estas reglas.
4. **Montaje base**: `python reels/montar.py plan.json base.mp4` (tomas, transiciones, color, voz y música con ducking). Tarda unos 9 min.
5. **Capa de edición**: `python reels/editar.py plan.json reel.mp4` (textos, stickers, sello, mapa, efectos). Tarda unos 2 min.
6. **Revisión de Claude antes de enviar**: hoja de cuadros clave (ningún texto se sale ni se encima, nada tapa caras), niveles de audio (efectos por debajo de la voz, pico ≤ −1 dB), contar stickers.
7. **Revisión de Santiago**: se envía una copia liviana (720p) para verla en el celular. Nada se publica sin su aprobación del domingo.

## Pendiente de probar con el material completo

- Rehacer Milán–Venecia cuando Santiago termine de recolectar todo el material.
- Mapa: hoy es una tarjeta oscura con dos pines; falta probar un mapa real de la zona.
- Confirmar en el celular que las frases pequeñas en cursiva se leen sobre cielos muy claros (si no, agrandarlas, no oscurecer el video).
