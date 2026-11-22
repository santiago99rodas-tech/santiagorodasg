# Cómo son los videos de YouTube que funcionan (17 referencias analizadas)

Investigación del 22-nov-2026, pedida por Santiago después del prototipo v1 de Milán–Venecia, que **se sentía como un reel de Instagram en horizontal**: música muy dura, muchos efectos, fotos con filtro cinematográfico, intro cinematográfica sin explicar y más fotos que animación.

Tres agentes analizaron 17 videos con muchas vistas, con la misma herramienta (`analizar_ref.py`: subtítulos con tiempos, hoja de cuadros cada 6 s, primeros 60 s cada 2 s y nivel de la música frente a la voz):

- **Español: explicativos de viajes y destinos** → [`investigacion/referencias-youtube/espanol.md`](../investigacion/referencias-youtube/espanol.md)
- **Inglés: explicativos animados de lugares y turismo** → [`investigacion/referencias-youtube/ingles.md`](../investigacion/referencias-youtube/ingles.md)
- **Canales con personaje animado recurrente** → [`investigacion/referencias-youtube/personaje.md`](../investigacion/referencias-youtube/personaje.md)

## Los videos

| Video | Canal | Vistas | Música bajo la voz | Animación / real | Palabras/min |
|---|---|---|---|---|---|
| ¿Qué hay debajo de Venecia? | Sapiens Explica (10k subs) | 735 k | 9,3 dB (ambiental sin ritmo) | ~65 % esquemas | 166 |
| Venecia explicada | Manuel Bravo | 2,7 M | 18,7 dB | mapas, Google Earth y planos | 171 |
| ¿Por qué los boletos de avión están más caros? | Moris Dieckonomics | 461 k (6× sus subs) | 15,8 dB | presentador + capturas + mapas | 201 |
| Por qué Uruguay es el país más caro | BBC Mundo | 984 k | 18,9 dB | presentadora + gráficos | — |
| 20 países baratos | Turispedia | 225 k | 16,4 dB | 100 % stock (contraste) | 135 |
| Primer viaje a Europa, 17 tips | Ceci Saia | 527 k | 18,7 dB | 75 % cara a cámara (contraste) | — |
| Why Was Venice Actually Built on Water | The Infographics Show | 627 k | 15,4 dB | 100 % animación | ~160 |
| Why Cancun is the Perfect Vacation Destination | Half as Interesting | 1,2 M | 11,9 dB | 10 % / 90 % stock | 233 |
| How Budget Airlines Work | Wendover | 10,2 M | 14,4 dB | 50 / 50 | 180 |
| Iceland's Tourism Revolution | Wendover | 1,3 M | 16,2 dB | 35 / 65 | ~170 |
| The Crazy Engineering of Venice | Primal Space | 11,3 M | 12,8 dB | 70 % 3D / 30 % pinturas y fotos | 167 |
| Travel | Casually Explained (personaje) | 6,7 M | 23,5 dB | ~100 % personaje | 231 |
| Creative Weapons of the Medieval Era | Sam O'Nella (personaje) | 15,1 M | 17,3 dB | ~100 % personaje | 206 |
| ¿Por qué surgen las fobias? | CuriosaMente (personaje) | 950 k | 17,3 dB | ~95 % animación | 150 |
| What a Dollar Gets You Around the World | The Infographics Show (personaje) | 4,0 M | 12,4 dB | ~100 % animación | 218 |
| El Imperio Romano en 10 minutos | Academia Play | 7,1 M | 15,1 dB | pizarra dibujada | 166 |
| (más el video de prueba de Venecia en 1 día, formato clásico) | Mariano por el Mundo | 24 k | 17,8 dB | cara a cámara + paseo | 153 |

**Nuestro prototipo v1:** música a **9,5 dB** bajo la voz (la mediana de las referencias es **~16 dB**), muchos efectos, fotos con filtro cálido y ~25 % de fotos a pantalla completa.

## Lo que se repite (y lo que hay que cambiar)

| Tema | Lo que hacen los que funcionan | Lo que hizo la v1 | Regla nueva |
|---|---|---|---|
| **Gancho** | El tema se dice en los **primeros 5–15 s**: una paradoja, un dato que duele al bolsillo o un caso real. Nadie abre con intro cinematográfica | Foto de Venecia + "entrar era gratis" sin contexto | Santi de frente, sobre fondo simple, dice la paradoja o el dato |
| **Intro explicada** | Antes del minuto dicen **qué vas a aprender** ("en este video: 1… 2… 3…") y después ponen una **tarjeta de título sobria de 2–3 s** | No había promesa ni agenda | Promesa + agenda en voz y en pantalla, luego título |
| **Estructura** | **Capítulos con nombre** de 45–120 s, patrón **problema → truco**. Idea nueva cada 20–40 s | Datos seguidos sin capítulos | Capítulos con título, cada uno con un solo dato o consejo |
| **Música** | Ambiental o corporativa suave, **14–19 dB bajo la voz**, constante, sin subidas épicas; sube un poco en pausas y cambios de capítulo | Épica a 9,5 dB | **~16 dB bajo la voz**, ambiental/inspiradora suave, sin percusión fuerte |
| **Efectos** | Casi ninguno: **~1 por minuto**, solo en cambios de capítulo y cuando aparece una cifra clave. La emoción la da el guion | Decenas | Máximo 1–2 por minuto |
| **Fotos reales** | **Color natural, sin filtros.** Como prueba, en marcos o tarjetas, con el personaje recortado encima, capturas de precios, titulares, mapas con círculo rojo. Con crédito de la fuente | Pantalla completa con filtro cálido, ~25 % | **10–20 %**, siempre de apoyo, en tarjeta o con Santi al lado, sin filtro |
| **Animación** | Barata a propósito: **imagen nueva cada 4–7 s**, poses fijas que cambian, fondos que se reutilizan, mucho fondo liso | Mucho movimiento tipo reel | Plano base de Santi + escenas con datos; cambio cada 4–7 s |
| **Personaje** | Dos modos: **plano base** (de frente, fondo simple, opina o hace el chiste, vuelve cada 20–40 s) y **actor** (vive la situación). En pantalla 35–80 % del tiempo | Santi aparecía pero no presentaba | Santi presenta (plano base) y actúa (escenas) |
| **Texto** | Escaso y funcional: **una cifra gigante**, etiquetas en mapas, listas de 2–4 puntos que aparecen línea por línea, títulos de capítulo | Mucho texto decorativo | Solo cifras, etiquetas, listas y títulos |
| **Mapas** | El lenguaje de "explicado": zoom del continente a la ciudad, pin, ruta que se dibuja | Un mapa | Mapa en cada lugar nuevo |
| **Voz** | **160–175 palabras por minuto** con voz en off | ~155 | Igual (está bien) |
| **Cierre** | Resumen de 1–3 frases → **una sola petición** (una pregunta concreta para comentar) → frase de despedida | CTA + firma | Resumen + pregunta + "Nos vemos pues" |

## Oportunidad

En español **casi no hay explicadores animados de viajes**. "Tasa de Venecia" solo tiene noticieros con menos de 7 mil vistas, y Sapiens Explica (10 mil suscriptores) llegó a 735 mil vistas con esquemas animados y un "por qué" bien contado. Un canal en español narrado por un personaje animado (Santi) que explica viajes con datos prácticos no tiene competencia directa.

## Modelos a seguir

- **Estructura "viajar inteligente":** Wendover, *How Budget Airlines Work* (10 M): lista de "esto cuesta → así lo evitas", con precios reales en capturas.
- **Gancho y capítulos en español:** Moris Dieckonomics (caso real → 3 preguntas → capítulos con nombre → consejos).
- **Personaje + datos dentro de la escena:** The Infographics Show, *What a Dollar Gets You* (escena del personaje → misma escena con etiquetas → mapa).
- **Venecia explicada con esquemas:** Sapiens Explica.
