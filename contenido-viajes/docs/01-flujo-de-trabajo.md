# Flujo de trabajo

## Roles

| Quién | Qué |
|---|---|
| **Santiago** | Graba la voz de los guiones (nota de voz basta) y sube voz + fotos/videos a Google Drive. Hace la revisión semanal |
| **Claude** | Guiones, edición de reels/TikToks y videos de YouTube, carruseles, posts, historias, captions. Corrige lo pedido y programa lo aprobado |

Santiago no sale a cámara en ninguna plataforma.

## Material en Google Drive

```
Fotos viajes/
  ├─ Guiones/            notas de voz de los reels (y el texto si existe)
  ├─ Egipto/             audio largo de YouTube + todas las fotos y videos del viaje
  ├─ Georgia/            ídem (incluye las tomas originales SIN subtítulos)
  └─ <Destino>/
```

Claude tiene acceso de lectura a Drive desde las sesiones en la nube.

## Semana tipo

| Día | Quién | Tarea |
|---|---|---|
| **Domingo** (propuesto, 30–45 min) | Santiago | Revisa el lote: 3 reels, 1–2 carruseles, posts, historias y (cada 2 semanas) el video largo. Aprueba, rechaza o comenta |
| Domingo / lunes | Claude | Corrige y programa lo aprobado de lunes a sábado. Entrega los guiones nuevos |
| Lunes a miércoles | Santiago | Graba voces y sube material (15–20 min) |
| Miércoles a sábado | Claude | Produce el lote siguiente |
| Cada 2 semanas | Claude | Auditoría de resultados con propuestas |
| Mensual | Claude | Revisión del nicho e ideas nuevas |

Siempre hay una semana programada por delante.

## Revisión semanal

Cada pieza llega con: el archivo, el caption, la fecha/hora propuesta y el porcentaje medido (material real en IG/TikTok, animación en YouTube). Propuesta: un tablero privado donde Santiago marca aprobar / rechazar / comentar y Claude lee las respuestas. **Pendiente de construir.**

## Programación

- **Vía elegida:** Claude opera el Chrome de Santiago (extensión Claude in Chrome) desde una sesión que corre en su computador: Meta Business Suite (Instagram), TikTok Studio, YouTube Studio.
- Las plataformas guardan lo programado en sus servidores: **no hace falta que el computador esté prendido** para que se publique. Basta una sesión por semana después de la revisión. (Instagram permite programar semanas antes; TikTok hasta ~10 días.)
- Regla: solo se programa lo aprobado, y antes de cada "programar" Claude muestra video, texto, fecha y hora.
- Alternativa disponible: conector Metricool (programa IG y TikTok y trae estadísticas).
- Las sesiones en la nube no pueden tocar el computador ni el navegador de Santiago; la programación se hace desde una sesión local (app Claude Desktop o `claude remote-control`).

## Skills de Instagram (texto, no video)

Repo `Jakeschincariol/instagram-agent-skill` (MIT), 13 skills. Instalar en Claude Code en el computador de Santiago:

```
/plugin marketplace add Jakeschincariol/instagram-agent-skill
/plugin install instagram-agent
```

Luego llenar `~/.claude/instagram/voice.md`.

| Skill | Uso |
|---|---|
| `/ig-reel` | Idea → ganchos con puntaje → guion → texto en pantalla → tiempos. La principal |
| `/ig-caption`, `/ig-human` | Caption y limpieza del tono de IA |
| `/ig-carousel`, `/ig-story` | Carruseles 1080×1350 e historias |
| `/ig-plan` | Plan semanal |
| `/ig-viral`, `/ig-audit`, `/ig-profile` | Qué funciona en el nicho, qué funcionó en la cuenta, calificación del perfil |
| `/ig-repurpose` | Un video largo de YouTube → semana de piezas cortas |
| `/ig-comment`, `/ig-reply`, `/ig-dm` | Comunidad y DMs de palabra clave |

No editan video ni publican. Sirven igual para los textos de TikTok.

## Borrador de `voice.md`

```
Nombre: Santiago Rodas
Cuentas: Instagram @SantiagoRodas · TikTok @SantiagoRodasTravel · YouTube (canal existente)
Formato: voz en off sobre material real; no sale a cámara
Nicho: viajes (completar: ¿presupuesto, Latinoamérica, Europa, destinos poco comunes?)
Público: (completar)
Qué vendo / quiero vender: (completar)
Tono: cercano, español neutro, datos concretos (precios, días, lugares)
Palabras que sí uso / nunca uso: (completar)
Palabra clave para DM: RUTA
```
