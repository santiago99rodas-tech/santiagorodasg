# Sistema de Reels y TikToks de viaje con Claude

Perfil: **@SantiagoRodas** (Instagram) · **@SantiagoRodasTravel** (TikTok)

Este documento junta tres cosas:

1. Qué hace el video de referencia ("Comenta CALENDARIO") y por qué funciona.
2. Cómo se reparte el trabajo: qué hacen las 13 skills `ig-*`, qué hace el editor de video de esta carpeta y qué te toca a ti.
3. El flujo semanal para producir 3 a 5 piezas con ese estilo, adaptado a viajes.

---

## 1. Análisis del video de referencia

66 segundos, vertical 720×1280 a 30 fps, una sola toma de cámara (ella sentada en un sofá con micrófono de mano). Detecté **16 cortes duros** y un cambio de recurso visual cada **2 a 4 segundos**. Nunca pasan más de 4 s sin que algo nuevo aparezca en pantalla.

### Línea de tiempo

| Seg. | Qué pasa en pantalla | Recurso |
|---|---|---|
| 0–5.8 | "Planeo **TODO** tu contenido de *noviembre* por ti" | Gancho de texto gigante: sans negra blanca + palabra clave en verde lima enorme + serif itálica. Stickers (chincheta, calendario) |
| 5.8–7.1 | "Okey?!" en blanco y negro con marco REC | **Cámara 2 falsa**: misma toma, desaturada, con marco de grabadora (REC, 4K 60FPS, batería). Interrupción de patrón |
| 7–14 | Un "1" gigante, palabras sueltas ("solamente", "pero"), cursor que hace clic, captura del calendario | Subtítulo de **una sola palabra**, cursor animado, captura de pantalla flotante |
| 14–20 | "de 2 a 5 *veces por semana*" sobre capturas del calendario | Dato duro + prueba visual |
| 20–24 | Pantalla completa beige: mapa mental "nicho TENNIS" que se arma por partes | **Gráfico explicativo** a pantalla completa (corta el talking head) |
| 24–25 | "y a cada tema le vas a d\|" | Texto tipo máquina de escribir con cursor |
| 25–33 | "pero **Ana...**" en B/N + burbuja "¿Qué es un ángulo?" | Cámara 2 + la **objeción del público** como burbuja de chat |
| 33–44 | Tarjetas que se apilan: Precaución, Solución, Comparación, Resultados, Temporal | Infografía que se construye mientras habla |
| 44–50 | "y ahora" / "cada **post** tiene que tener *un propósito*" con stickers de celular | Frase-regla con mezcla tipográfica |
| 50–55 | Grabación de pantalla de la app + "Entonces lo escoges, llenas los datos..." | Demo del producto con subtítulo de bloque |
| 55–58 | Hoja de papel con clip "para hac\|", collage translúcido de videos ajenos | Textura de papel, superposición con transparencia |
| 58.8–60 | "**NO** no te les vas a copiar" tachado en rojo, B/N | Negación fuerte + cámara 2 |
| 60–62 | "qué les **funcionó**" con emoji de mano | Emoji integrado dentro de la palabra |
| 62–64 | Nota de iPhone "Recordatorio" que se escribe sola, B/N | Maqueta de app del sistema |
| 64–66 | "comenta **"calendario"**" + capturas + cursor + "y sí **postees**" | CTA de palabra clave → DM automático |

### La gramática del estilo (lo que hay que copiar)

- **Tres tipografías con roles fijos**: sans negra (Poppins/Inter Black) para lo que se dice, serif itálica (tipo Playfair/Times) para el matiz emocional, y la palabra clave enorme en el color de marca.
- **Un solo color de acento** (ella: verde lima #D4F06A; el resto blanco y café oscuro). Nada más.
- **Subtítulos de una palabra** al centro, pequeños. No son subtítulos completos: son ritmo.
- **Cámara 2 falsa** cada 15–20 s: blanco y negro + marco REC. Se usa justo en las objeciones y en los "pero". Con una sola cámara parece que hay dos.
- **Cortar todos los silencios** (jump cuts). El zoom de golpe de 110–120 % entre cortes disimula el salto.
- **Mostrar en vez de decir**: cada sustantivo importante tiene una imagen (captura, gráfico, sticker, B-roll).
- **Sonido**: whoosh en cada entrada de texto grande, pop en stickers, clic con el cursor, tecleo en la máquina de escribir, obturador al entrar a la cámara 2. Música de fondo muy baja.
- **Luz**: una sola fuente cálida lateral (lámpara a la derecha), fondo neutro, ropa de color que combina con el acento. Ella viste verde porque su acento es verde.
- **Estructura**: gancho de resultado (0–3 s) → promesa → método en pasos visuales → objeción ("pero Ana...") → respuesta → CTA de palabra clave.

---

## 2. Quién hace qué

### Las 13 skills (repo `Jakeschincariol/instagram-agent-skill`, licencia MIT)

Escriben y planean; **no editan video ni publican**. Están pensadas para Instagram, pero los guiones, ganchos y textos sirven igual para TikTok.

| Skill | Uso para tu perfil de viajes |
|---|---|
| `/ig-viral` | Darle 6–12 cuentas de viaje de tu nicho (las que tú sigues) y sacar qué ganchos les funcionan. 1 vez al mes |
| `/ig-audit` | Pasarle capturas de estadísticas de tus últimos reels de @SantiagoRodas y TikTok |
| `/ig-profile` | Calificar bio, destacadas, fijados y cuadrícula (sobre 100) |
| `/ig-plan` | Plan semanal: 4–5 piezas, al menos 3 reels |
| `/ig-reel` | **La principal**: idea → 3 ganchos con puntaje → guion → texto en pantalla → hoja de tiempos |
| `/ig-carousel` | Itinerarios, presupuestos, "5 errores en…" (1080×1350) |
| `/ig-story` | Historias del día cuando estás viajando, con stickers y embudo a DM |
| `/ig-caption` | Caption con la primera línea que sobrevive al "más", palabras de búsqueda y máx. 5 hashtags |
| `/ig-repurpose` | Convertir un vlog largo o un hilo de notas de un viaje en una semana de piezas |
| `/ig-comment`, `/ig-reply`, `/ig-dm` | Comentarios en otras cuentas, respuestas y el DM que entrega la guía cuando comentan "RUTA" |
| `/ig-human` | Quitarle a los textos el tono de IA antes de publicar |

**Instalación** (en Claude Code, en tu computadora):

```
/plugin marketplace add Jakeschincariol/instagram-agent-skill
/plugin install instagram-agent
```

Luego copiar `templates/voice.md` a `~/.claude/instagram/voice.md` y llenarlo (abajo hay un borrador para ti). La primera vez te pide 3 reels tuyos para aprender tu voz.

### El editor de video de esta carpeta (`editor/editar.py`)

Las skills no tocan video, así que armé un editor propio que reproduce la gramática del referente. Claude escribe un **plan de edición en JSON** (a partir del guion de `/ig-reel` o de la transcripción de tu clip) y el script renderiza el video final con ffmpeg.

Lo que ya hace (ver `demo/demo-estilo.mp4`):

| Evento | Qué produce |
|---|---|
| `gancho` | Título apilado con mezcla sans negra / número gigante en acento / serif itálica, entra línea por línea con rebote |
| `rec` | Cámara 2: blanco y negro + más contraste + marco REC con punto rojo que parpadea, batería, 4K 60FPS, HD |
| `palabras` | Subtítulo de una palabra al centro, palabras clave en color de acento. Acepta marcas de tiempo exactas por palabra |
| `zoom` | Punch-in (por defecto 115 %) para disimular cortes |
| `sticker` | Etiqueta de color girada que entra con rebote |
| `maquina` | Texto que se escribe letra por letra con cursor |
| `cta` | "comenta" en serif + palabra clave gigante |
| sonido | Whoosh, pop, golpe, obturador, tecleo y ding generados al vuelo, sincronizados con cada evento |

Uso:

```
python3 editor/editar.py plan.json final.mp4          # con tu clip ("source" en el plan)
python3 editor/editar.py editor/plan-demo.json demo.mp4 --demo   # fondo de prueba
```

Lo que falta para llegar al 100 % del referente, en orden de impacto:

1. **Transcripción automática con marcas de tiempo por palabra** (Whisper). En esta sesión en la nube la descarga del modelo está bloqueada por la red; en tu computadora funciona con `pip install faster-whisper`. Con eso Claude corta silencios y sincroniza cada palabra sola.
2. **Corte de silencios automático** a partir de la transcripción.
3. **Capas de imagen**: capturas, fotos del destino, mapas y stickers PNG/emoji encima del video (ffmpeg `overlay`). Necesita tus fotos y una carpeta de stickers.
4. **Gráficos a pantalla completa** (como el mapa mental): Claude los diseña en HTML y se exportan a video; para esto conviene **Remotion** (React → MP4), que es la herramienta más común para "editar con código/IA".
5. **Música** de fondo con ducking (que baje sola cuando hablas).

Sobre "editado con IA desde Claude": no puedo confirmar con qué lo editó ella. Todos los recursos del video se pueden hacer en CapCut/Edits con plantillas, o por código como este editor. La ventaja de hacerlo con Claude es que el plan de edición sale del guion automáticamente y el estilo queda idéntico en todos tus videos.

### Lo que te toca a ti

- Grabar: talking head (con luz lateral cálida) + B-roll del destino. **Grabar siempre vertical 4K o 1080p, y 5–10 s de B-roll por cada idea del guion.**
- Mandar el clip y las fotos a Claude, revisar el render y publicar.
- Responder DMs en vivo (o usar los textos de `/ig-dm`).

---

## 3. Adaptación a viajes

### Identidad visual propuesta

| Elemento | Propuesta | Por qué |
|---|---|---|
| Acento | Amarillo pasaporte `#FFD54A` | Contrasta con cielo, mar y verde (los fondos más comunes en viajes). El lima de ella se pierde contra vegetación |
| Oscuro | Café `#2B1A12` | Para texto sobre fondos claros |
| Sans | Inter Black (o Poppins Black) | Igual al referente |
| Serif | Playfair Display Italic | Igual al referente |
| Cámara 2 | B/N + marco REC | Se mantiene tal cual |
| Firma visual propia | Sello de pasaporte (sticker) con el nombre del país al aparecer cada destino | Te diferencia del referente y es 100 % de viajes |

### 6 formatos de serie (rotarlos para no repetir el mismo tipo seguido)

1. **"Gasté $X en…"** – Presupuesto real desglosado. Gancho con el número gigante. CTA: comenta "PRESUPUESTO".
2. **"3 errores que cometí en…"** – Cámara 2 en cada error, tachado rojo como el "NO" del referente.
3. **"Itinerario de N días"** – Mapa que se arma por partes (el equivalente del mapa mental). CTA: comenta "RUTA" → DM con la guía.
4. **"Lo que nadie te dice de…"** – Objeción del público en burbuja de chat ("pero Santiago, ¿no es carísimo?").
5. **"Esto vs. esto"** – Pantalla dividida: lo que esperas / lo que es. Comparación de precios.
6. **"Día en…"** – Vlog rápido de 30 s con subtítulo de una palabra y sonido ambiente.

### Diferencias Instagram vs. TikTok

| | Instagram @SantiagoRodas | TikTok @SantiagoRodasTravel |
|---|---|---|
| Duración ideal | 30–60 s | 20–45 s (gancho aún más rápido, primera palabra en 0.5 s) |
| CTA | "Comenta RUTA" → DM automático (ManyChat o similar) | "Guárdalo" / "Sígueme para la parte 2" (los DM automáticos son más limitados) |
| Texto en pantalla | Zona segura: dejar libres 250 px abajo y 120 px a la derecha | Zona segura más grande: 380 px abajo, 140 px derecha |
| Caption | `/ig-caption` (palabras de búsqueda + máx. 5 hashtags) | Mismo caption más corto, 3–5 hashtags de búsqueda (#viajarbarato #islandia) |
| Sonido | Audio original + música baja | Probar con sonido en tendencia muy bajo debajo de la voz |

El mismo render sirve para ambas; solo cambian el CTA final y la zona segura (se puede sacar una versión de cada una con dos planes JSON).

---

## 4. Flujo de producción por video

```
Idea ──► /ig-reel ──► guion + ganchos + hoja de tiempos
                          │
             grabas talking head + B-roll
                          │
Clip ──► transcripción (Whisper) ──► Claude escribe plan.json
                          │            (gancho, cámara 2 en objeciones,
                          │             palabras, zooms, stickers, CTA)
                          ▼
              editor/editar.py ──► final_ig.mp4 / final_tiktok.mp4
                          │
         /ig-caption + /ig-human ──► publicas
                          │
       /ig-reply + /ig-dm (keyword "RUTA") ──► /ig-audit cada 2 semanas
```

### Semana tipo

| Día | Tarea | Skill / herramienta |
|---|---|---|
| Lunes | Plan de la semana | `/ig-plan` |
| Lunes | Guiones de 3 reels | `/ig-reel` ×3 |
| Martes | Grabar los 3 (1 hora, misma luz y ropa por lote) | tú |
| Martes | Editar | `editar.py` |
| Mar / Jue / Sáb | Publicar en IG y TikTok | `/ig-caption`, `/ig-human` |
| Miércoles | 1 carrusel (itinerario o presupuesto) | `/ig-carousel` |
| Diario | Historias + 15 min de comentarios | `/ig-story`, `/ig-comment`, `/ig-reply` |
| Cada 2 semanas | Qué funcionó | `/ig-audit` |
| Mensual | Qué funciona en el nicho | `/ig-viral` |

---

## 5. Borrador de `voice.md`

Para revisar y corregir antes de instalarlo en `~/.claude/instagram/voice.md`:

```
Nombre: Santiago Rodas
Cuentas: Instagram @SantiagoRodas · TikTok @SantiagoRodasTravel
Nicho: viajes (completar: ¿mochilero, presupuesto, lujo accesible, Latinoamérica, Europa?)
Público: (completar: edad, país, qué quieren — p. ej. "latinos de 22–35 que quieren viajar más gastando menos")
Qué vendo / quiero vender: (completar: guías, asesorías, afiliados, marcas)
Tono: cercano, en español neutro, con datos concretos (precios, días, nombres de lugares)
Palabras que sí uso: (completar)
Palabras que nunca uso: (completar)
Palabra clave para DM: RUTA
```

---

## 6. Próximos pasos

1. Instalar las 13 skills en Claude Code en tu computadora (comandos arriba) y llenar `voice.md`.
2. Pasar capturas de tu perfil actual por `/ig-profile` y tus estadísticas por `/ig-audit`.
3. Mandarme **un clip real tuyo** (talking head de 30–60 s + B-roll del viaje) para hacer el primer video completo con este editor y ajustar el estilo sobre tu imagen.
4. Con eso agregamos al editor: Whisper, corte de silencios, capas de fotos/stickers y música.
