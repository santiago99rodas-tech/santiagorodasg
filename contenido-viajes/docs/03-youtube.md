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

## Reglas de diseño (aprobadas el 22-nov-2026 con el prototipo v3)

Salen de analizar 17 videos con muchas vistas (`docs/10-referencias-youtube.md`) y de 3 versiones del prototipo de 1 minuto "Venecia cobra por entrar" (`youtube/src/milan/VeneciaTasaV3.tsx`, guion `guiones/milan-venecia-youtube-1min-v2.md`). **YouTube es explicación, no un reel en horizontal**, pero tampoco puede sentirse lento ni plano:

| Regla | Valor |
|---|---|
| Gancho | El tema en los **primeros 5 s**: Santi de frente (plano base) dice la paradoja o el dato, con una **cifra gigante** y **reacción** de Santi (brazos arriba, sorpresa). Nada de intro cinematográfica |
| Intro explicada | Antes del minuto: **promesa + agenda** ("te explico 3 cosas: …"), en voz y en lista numerada en pantalla, y después una **tarjeta de título sobria** (fondo oscuro, ~1,5 s, *whoosh* suave) |
| Estructura | **Capítulos con nombre**, etiqueta fija arriba a la izquierda ("CAPÍTULO 1 · ¿CUÁNDO SE PAGA?") todo el capítulo. Un solo tema por video |
| Ritmo | **Toma nueva cada 3–4 s** (nunca más de ~5 s igual). Cortes secos, sin fundidos. La cámara siempre empuja un poco (+3,5 % por toma) y hay **acercamientos (punch-in) de 10–30 %** en las frases fuertes del plano base |
| Santi | Dos modos: **plano base** (de frente, fondo liso con círculo, presenta y opina) y **actor** (vive la situación). **Reacciona en cada palabra clave**: salto, cambio de pose o de cara (sorpresa, risa, ¡ojo!) |
| Animación | **≥ 80 %**: calendarios, relojes, boletos, mapas con pines, QR, listas. Fondos lisos y piezas reutilizables (`youtube/src/piezas.tsx`) |
| Fotos reales | **10–20 %**, solo de apoyo o prueba, **en polaroid**, casi quietas, con Santi al lado. **Color natural, sin filtros** |
| Texto | Escaso y funcional: cifra gigante, etiquetas, listas de 2–4 puntos línea por línea, cajas sólidas para el énfasis (amarilla, verde, roja). Letra sólida, Bebas Neue predominante, Playfair itálica para frases suaves |
| Stickers | 3–4 por minuto (emoji 3D), solo cuando se nombra la cosa |
| Música | Inspiradora con su brillo original (sin filtro de graves/agudos), compresión suave, **~12 dB por debajo de la voz** (medido con `medir_audio_local.py`; rango 12–14). A 16 dB se sintió apagada |
| Efectos | **~8 por minuto, suaves**: *swoosh* en cada cambio de capítulo, *whoosh* en la tarjeta de título, un golpe en la cifra del gancho, *pop*/*ding* en las cifras o confirmaciones clave. Siempre bajo la voz |
| Voz | Limpia (reducción de ruido obligatoria), **tempo ×1,07** sin cambiar el tono, ~170 palabras por minuto. Respiro de **0,35 s** antes de cada capítulo y **1,1 s** para la tarjeta de título |
| Cierre | Resumen en lista con ✓ → **una sola pregunta para comentar** → **"Nos vemos pues"** (voz + texto) |

Historial del prototipo:

| Versión | Comentario de Santiago | Qué cambió |
|---|---|---|
| v1 | Música muy dura, muchos efectos, fotos cinematográficas, intro sin explicar, más fotos que animación: "parece un reel en horizontal" | Investigación de 17 referencias, guion nuevo |
| v2 | "Me gusta pero le falta emoción, además se ve lento" | Voz más ágil, tomas de 3–4 s, punch-in, reacciones de Santi, música a 12 dB con brillo, efectos en cambios |
| v3 | **Aprobada** | — |

## Personaje: Santi

Estilo **póster de viaje** (propuesta 4) **con expresiones**, basado en la foto de Santiago.

- Proporciones adultas (~7 cabezas): no se ve infantil, no quita credibilidad.
- Pelo oscuro corto, más largo arriba con raya al lado; barba de pocos días.
- Buzo blanco de cuello redondo (sin marca), pantalón gris oscuro, tenis claros, reloj plateado.
- Colores tierra, sombras planas, textura de papel.
- Poses: en bolsillos, camina (con mochila), señala.
- Expresiones: neutral, sonrisa, sorpresa, duda, ¡ojo!, risa. La expresión cambia con lo que dice la voz.

Archivos: `../youtube/personaje/santi-hoja.png`, `santi-egipto.png`, fuente `santi.html`.
**Estado:** aprobado por Santiago y animado en Remotion (poses: bolsillos, señala, camina, explica, brazos arriba).

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

Video hecho con código (React → MP4). Prototipo aprobado: `src/milan/VeneciaTasaV3.tsx` (composición `VeneciaTasaV3`), con Santi animado (`src/santi/Santi.tsx`) y piezas reutilizables (`src/piezas.tsx`). Render: `npm run render` dentro de `youtube/`. Un video de 10 min tarda del orden de decenas de minutos en renderizar.

## Lo que graba Santiago

**Firma de cierre obligatoria:** todo video termina con su voz diciendo **"Nos vemos pues"** y el texto en pantalla. Si no lo grabó, se toma de otra grabación suya (limpiada con la misma cadena e igualada en volumen).

**Edición de la voz (`youtube/pulir_voz.py`)**: Santiago manda el audio crudo, con silencios y errores. Claude lo transcribe con tiempos por palabra, marca titubeos y repeticiones, corta las pausas (0,3 s entre frases y 0,4 s entre ideas), aplica **reducción de ruido obligatoria** (red neuronal RNNoise), ecualiza (menos caja, más presencia), comprime y deja el volumen estándar de YouTube (−14 a −16 LUFS, pico bajo 0 dB). Después vuelve a transcribir y compara palabra por palabra para confirmar que no se cortó nada. Por último se mete un **respiro de silencio antes de cada capítulo** (0,35 s, o 1,1 s después de la intro para la tarjeta de título), buscando el punto más silencioso para no cortar ninguna palabra, y se acelera la voz ×1,07 sin cambiar el tono (ejemplo: `youtube/pruebas/milan-venecia/ritmo_v3.py`).

**Mezcla (`youtube/mezclar_audio.py`)**: la música lleva solo compresión suave (`filtro_musica`) y se ajusta el volumen hasta medir **~12 dB bajo la voz** con `medir_audio_local.py` (prototipo v3 aprobado: Taking Flight a 1,0 → 12,3 dB, `pruebas/milan-venecia/audio-v3.json`). Efectos suaves en cada cambio de capítulo y en las cifras clave (~8 por minuto).

- Audio de 5–10 min por destino, contado como a un amigo: qué hizo, cuánto costó, qué salió mal, qué recomienda. No tiene que ser perfecto.
- Fotos y videos de ese viaje en `Fotos viajes/<Destino>/` en Drive.

## Calendario

1 video largo cada 2 semanas al inicio, luego semanal. Cada uno alimenta 3–5 piezas cortas. Empezar por los destinos con más vistas en Shorts. **Piloto: Egipto.**
