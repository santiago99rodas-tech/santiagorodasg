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

## Personaje: Santi

Estilo **póster de viaje** (propuesta 4) **con expresiones**, basado en la foto de Santiago.

- Proporciones adultas (~7 cabezas): no se ve infantil, no quita credibilidad.
- Pelo oscuro corto, más largo arriba con raya al lado; barba de pocos días.
- Buzo blanco de cuello redondo (sin marca), pantalón gris oscuro, tenis claros, reloj plateado.
- Colores tierra, sombras planas, textura de papel.
- Poses: en bolsillos, camina (con mochila), señala.
- Expresiones: neutral, sonrisa, sorpresa, duda, ¡ojo!, risa. La expresión cambia con lo que dice la voz.

Archivos: `../youtube/personaje/santi-hoja.png`, `santi-egipto.png`, fuente `santi.html`.
**Estado:** propuesto, falta aprobación final y ajustes (parecido, ropa fija o por destino, intensidad de expresiones).

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

- Audio de 5–10 min por destino, contado como a un amigo: qué hizo, cuánto costó, qué salió mal, qué recomienda. No tiene que ser perfecto.
- Fotos y videos de ese viaje en `Fotos viajes/<Destino>/` en Drive.

## Calendario

1 video largo cada 2 semanas al inicio, luego semanal. Cada uno alimenta 3–5 piezas cortas. Empezar por los destinos con más vistas en Shorts. **Piloto: Egipto.**
