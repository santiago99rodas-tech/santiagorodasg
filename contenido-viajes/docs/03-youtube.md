# YouTube (videos largos)

Canal existente, con seguidores y Shorts. Se suman videos largos de mucho valor por destino, hechos con material de viajes anteriores. Reglas obligatorias en `../CLAUDE.md`.

## Fórmula

| | Regla |
|---|---|
| Formato | Horizontal 16:9, 1920×1080, 5–10 min |
| Audio | Voz en off de Santiago contando el viaje + música baja + efectos |
| Animación 2D | **~70 % del tiempo** (mínimo 50 %): escenarios del destino, el personaje Santi, mapas, rutas, precios, boletos, listas |
| Material real | **~30 %**: fotos y videos de Santiago para cosas puntuales (el lugar exacto, un momento vivido, la prueba de que estuvo ahí) |
| Coherencia | La animación corresponde al destino y a la frase. Si habla de Egipto se ve Egipto |

**Regla de reparto**: material real en los momentos de experiencia ("llegamos de noche", "me pasó esto"); animación en los de información (precios, rutas, pasos, errores).

## Reglas de diseño (borrador v2, pendiente de aprobar con el prototipo)

Salen de analizar 17 videos con muchas vistas (`docs/10-referencias-youtube.md`). La v1 del prototipo se sentía como **un reel en horizontal**; YouTube es **explicación**:

| Regla | Valor |
|---|---|
| Gancho | El tema en los **primeros 5–15 s**: Santi de frente dice una paradoja, un dato que duele al bolsillo o un caso real. **Nada de intro cinematográfica** |
| Intro explicada | Antes del minuto: **promesa + agenda** ("te explico 3 cosas: …"), en voz y en pantalla, y después una **tarjeta de título sobria de 2–3 s** |
| Estructura | **Capítulos con nombre** (45–120 s), patrón **problema → truco**, un solo tema por video |
| Animación | **≥ 80 %**. Santi en dos modos: **plano base** (de frente, fondo liso, presenta y opina; vuelve cada 20–40 s) y **actor** (vive la situación). Imagen nueva cada **4–7 s**; poses y fondos reutilizables |
| Fotos reales | **10–20 %**, solo de apoyo o prueba: en tarjeta o polaroid, con Santi al lado o recortado encima, capturas de precios, mapas. **Color natural, sin filtros** |
| Texto | Escaso y funcional: cifra gigante, etiquetas, listas de 2–4 puntos línea por línea, título de capítulo. Letra sólida, Bebas Neue predominante |
| Mapas | En cada lugar nuevo: zoom, pin, ruta que se dibuja |
| Música | Suave (ambiental/inspiradora sin percusión fuerte), **~16 dB por debajo de la voz** (rango 14–18), sube un poco en pausas y cambios de capítulo |
| Efectos | **1–2 por minuto** como máximo, solo al cambiar de capítulo o al aparecer una cifra clave |
| Voz | 160–175 palabras por minuto, limpia (reducción de ruido obligatoria) |
| Cierre | Resumen de 1–3 frases → **una sola pregunta para comentar** → **"Nos vemos pues"** |

## Personaje: Santi

Estilo **póster de viaje** (propuesta 4) **con expresiones**, basado en la foto de Santiago.

- Proporciones adultas (~7 cabezas): no se ve infantil, no quita credibilidad.
- Pelo oscuro corto, más largo arriba con raya al lado; barba de pocos días.
- Buzo blanco de cuello redondo (sin marca), pantalón gris oscuro, tenis claros, reloj plateado.
- Colores tierra, sombras planas, textura de papel.
- Poses: en bolsillos, camina (con mochila), señala.
- Expresiones: neutral, sonrisa, sorpresa, duda, ¡ojo!, risa. La expresión cambia con lo que dice la voz.

Archivos: `../youtube/personaje/santi-hoja.png`, `santi-egipto.png`, fuente `santi.html`.
**Estado:** aprobado por Santiago. Siguiente paso: animarlo en Remotion.

Descartados: viajero con sombrero (`../youtube/pruebas/prueba-v1-viajero-descartado.mp4`) y las propuestas 1–3 (`../youtube/personaje/descartadas/`).

## Ejemplos de escenas (Egipto)

| La voz dice | Se ve |
|---|---|
| "Llegamos a El Cairo de noche…" | Video real de Santiago en El Cairo |
| "El vuelo me costó 650 dólares" | Avión cruzando el mapa + precio que cuenta hasta 650 |
| "Para entrar a las pirámides hay 3 tipos de boleto" | Santi frente a las pirámides; tres boletos con su precio |
| "Te van a querer cobrar por la foto con el camello" | Santi con cara de "¡ojo!", vendedor y camello, sello rojo |
| "Mi ruta fue Cairo → Asuán → Luxor" | Mapa; la ruta se dibuja con avión y barco por el Nilo |

## Equipo de agentes

| # | Agente | Hace |
|---|---|---|
| 1 | Transcriptor | Texto del audio con el tiempo de cada palabra |
| 2 | Investigador | Verifica y actualiza datos (precios, visas, horarios). Marca lo que cambió desde el viaje |
| 3 | Estructura | Capítulos, gancho de 30 s, un giro cada 60–90 s; propone recortes |
| 4 | Director | Frase por frase decide: material real, animación, mapa, dato o Santi. Busca la toma en Drive |
| 5 | Animador | Construye las escenas en Remotion con una biblioteca reutilizable que crece por destino |
| 6 | Montaje | Voz + escenas + material + subtítulos + música + efectos |
| 7 | Empaque | 3 títulos, 3 miniaturas, descripción, capítulos, etiquetas y 3–5 Shorts/Reels derivados |
| 8 | Revisor | Comprueba coherencia imagen–frase, datos verificados, ritmo y % de animación |

Agente de producción definido en `../../.claude/agents/editor-youtube.md`.

## Herramienta: Remotion (`../youtube/`)

Video hecho con código (React → MP4). Prueba actual: `src/PruebaEgipto.tsx` (aún con el personaje descartado; se cambia a Santi cuando se apruebe). Render: `npm run render` dentro de `youtube/`. Un video de 10 min tarda del orden de decenas de minutos en renderizar.

## Lo que graba Santiago

**Firma de cierre obligatoria:** todo video termina con su voz diciendo **"Nos vemos pues"** y el texto en pantalla. Si no lo grabó, se toma de otra grabación suya (limpiada con la misma cadena e igualada en volumen).

**Edición de la voz (`youtube/pulir_voz.py`)**: Santiago manda el audio crudo, con silencios y errores. Claude lo transcribe con tiempos por palabra, marca titubeos y repeticiones, corta las pausas (0,3 s entre frases y 0,4 s entre ideas), aplica **reducción de ruido obligatoria** (red neuronal RNNoise), ecualiza (menos caja, más presencia), comprime y deja el volumen estándar de YouTube (−14 a −16 LUFS, pico bajo 0 dB). Después vuelve a transcribir y compara palabra por palabra para confirmar que no se cortó nada.

- Audio de 5–10 min por destino, contado como a un amigo: qué hizo, cuánto costó, qué salió mal, qué recomienda. No tiene que ser perfecto.
- Fotos y videos de ese viaje en `Fotos viajes/<Destino>/` en Drive.

## Calendario

1 video largo cada 2 semanas al inicio, luego semanal. Cada uno alimenta 3–5 piezas cortas. Empezar por los destinos con más vistas en Shorts. **Piloto: Egipto.**
