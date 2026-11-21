# YouTube: videos largos de 5–10 min con animación 2D + material real

Canal existente (ya tiene seguidores y Shorts). Objetivo: sumar videos largos de mucho valor por destino, hechos a partir de la voz de Santiago y su material de viajes anteriores.

## Qué se toma del video de referencia ("granja de videos para YT Shorts")

- Mundo ilustrado simple (estilo plano, colores sólidos, luz suave), nada de animación tipo película.
- **Personajes pequeños y expresivos** que hacen las acciones que narra la voz.
- **La cámara se mueve dentro de una sola escena** (acerca, se desplaza, aleja) en vez de cortar a escenas nuevas todo el tiempo.
- **Pantallas y tarjetas** que muestran el dato concreto: contador de visitas, una gráfica que cae, un chat de WhatsApp, un botón con cursor.
- **Subtítulo arriba**, palabra a palabra, con la palabra clave enmarcada.
- Cada frase tiene una imagen que la ilustra literalmente.

## Cómo se adapta a viajes

| Lo que dice la voz | Lo que se ve |
|---|---|
| "Llegamos a El Cairo de noche…" | Foto/video real de Santiago en El Cairo (prueba de que es vivido) |
| "El vuelo me costó 650 dólares" | Avión 2D cruzando un mapa + etiqueta de precio que cuenta hasta 650 |
| "Para entrar a las pirámides hay 3 tipos de boleto" | Escena 2D del desierto con pirámides; tres boletos que aparecen con su precio |
| "Te van a querer cobrar por la foto con el camello" | Personaje-mascota y un vendedor con camello; burbuja de diálogo; sello rojo de "ojo" |
| "Mi ruta fue Cairo → Asuán → Luxor" | Mapa de Egipto, la ruta se dibuja con un barco por el Nilo |
| "Total del viaje" | Ticket o calculadora animada con el desglose |

Regla fija: **la animación siempre corresponde al destino y a la frase**. Nada genérico ni de otro país.

Proporción objetivo por video: **~70 % animación y gráficos (mínimo 50 %)** y **~30 % material real** de Santiago, solo para mostrar cosas puntuales. Formato horizontal 1920×1080 con voz en off. (Reglas completas en `CLAUDE.md`.) El material real aparece siempre en los momentos de experiencia ("yo viví", "me pasó") y la animación en los de información (precios, rutas, pasos, errores).

**Mascota del canal**: un personaje propio y original (p. ej. un viajero pequeño con mochila y sombrero, o una maleta con patas) que aparece en todos los videos. Da identidad y repetirlo abarata la producción. Se diseña una vez, con varias poses (camina, señala, se sorprende, paga, duerme, toma foto).

## El equipo de agentes

```
Audio de Santiago (Drive)
        │
 1. Transcriptor ──► texto con el tiempo exacto de cada palabra
        │
 2. Investigador ──► verifica y actualiza datos (precios, visas, horarios,
        │            seguridad). Como el material es viejo, marca lo que cambió
        │            para que Santiago lo diga en una nota de voz corta o se
        │            ponga como texto en pantalla ("precio actualizado 2026")
        │
 3. Estructura ───► capítulos, gancho de los primeros 30 s, un "giro" cada
        │            60–90 s para la retención; propone recortes del audio
        │
 4. Director ─────► frase por frase: ¿foto/video real, animación, mapa,
        │            gráfico de datos o mascota? Busca en el material de Drive
        │            la toma real que corresponde
        │
 5. Animador ─────► construye las escenas 2D con una biblioteca reutilizable
        │            (desierto, playa, ciudad, aeropuerto, mapa, dinero,
        │            checklist, chat, mascota…) que crece con cada destino
        │
 6. Montaje ──────► voz + escenas + material real + subtítulos + música +
        │            efectos → video 16:9 1920×1080
        │
 7. Empaque ──────► 3 títulos, 3 miniaturas, descripción, capítulos, etiquetas
        │            y 3–5 Shorts/Reels recortados del video largo
        │
 8. Revisor ──────► revisa que cada imagen corresponda a lo que se dice, que
        │            los datos estén verificados y el ritmo
        ▼
 Revisión semanal de Santiago ──► programación en YouTube Studio (desde Chrome)
```

## Herramienta de animación

**Remotion** (video hecho con código React, renderiza MP4). Es la vía práctica para que Claude genere animación 2D a partir de un guion: personajes y escenarios en SVG, movimientos de cámara, contadores, mapas, subtítulos sincronizados con la voz. El editor actual (`editor/editar.py`) sigue sirviendo para Reels/TikTok.

Tiempo de render estimado de un video de 10 min en 1080p: del orden de decenas de minutos en un computador normal; se hace mientras Santiago no lo usa.

## Qué graba Santiago

- **Audio de 5–10 min por destino**, contando el viaje como si se lo contara a un amigo: qué hizo, cuánto costó, qué salió mal, qué recomendaría. No tiene que ser perfecto: el agente de estructura recorta y reordena.
- Opcional: una nota de voz corta con datos actualizados que pida el investigador.
- Subir a Drive: `Fotos viajes/Egipto/` con el audio y todas las fotos/videos de ese viaje.

## Calendario sugerido

- 1 video largo cada 2 semanas al principio (luego semanal).
- Cada video largo genera 3–5 piezas cortas para Shorts, Reels y TikTok, que llevan al video largo.
- Orden de destinos: empezar por los que ya tienen más vistas en Shorts (los datos del canal dicen qué interesa).

## Primer paso

Un video piloto de un destino (p. ej. Egipto): audio + material en Drive → se produce completo → se ajusta el estilo y la mascota → se convierte en plantilla para el resto.
