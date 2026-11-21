# Investigación de temas y retención (sin pagar)

Objetivo: antes de producir, saber **qué quiere ver la gente** de cada destino y **dónde se va** en los videos, para hacer contenido que retenga. Aplica a todos los destinos y a las tres plataformas.

Inspiración: video "Claude hizo un video completo mientras me duchaba". Ahí Claude se conecta a **NexLev** (herramienta de pago) para encontrar el video que "está petando" en el nicho, desmonta su gancho, ritmo y curva de retención, escribe el guion, clona la voz, monta y sube a YouTube Studio.

## Qué se toma y qué se reemplaza

| Paso del video | ¿Hace falta? | Cómo lo hacemos gratis |
|---|---|---|
| Buscar qué está funcionando en el nicho (NexLev, de pago: sin prueba gratis, desde ~US$9–13/mes) | Sí, es lo más valioso | **YouTube Data API v3** (gratis, 10.000 unidades/día) + script propio `investigacion/tendencias_youtube.py` que calcula el multiplicador de outlier. Complemento: **vidIQ MCP**, que hoy está incluido en el plan gratis (150 créditos/mes ≈ 30 consultas; puede ser temporal) |
| Desmontar gancho, ritmo y retención del video ganador | Sí | Claude analiza el video (cortes, primeras frases, estructura). Fórmulas de gancho de `/ig-reel` |
| Curva de retención propia (dónde se va la gente) | Sí | **YouTube Studio → Analytics → Retención** (gratis, desde Chrome o con la YouTube Analytics API). Instagram/TikTok: estadísticas de cada video (capturas o Chrome) |
| Escribir el guion | Sí | Claude + skills `ig-*` |
| Clonar la voz | **No** | Santiago graba su voz: es más creíble y gratis |
| Montar | Sí | `reels/editar.py` y Remotion (gratis) |
| Subir con título, descripción y miniatura | Sí | YouTube Studio desde el Chrome de Santiago (gratis), solo lo aprobado |

**Resultado: nada del flujo requiere pagar.** La única configuración es una clave gratis de la YouTube Data API.

## Agente "Investigador de tendencias" (antes de cada destino)

1. **Qué busca la gente** (gratis, sin clave): autocompletado de YouTube y Google Trends para "<destino> + viaje / qué hacer / cuánto cuesta / errores / peligroso / visa".
2. **Qué está funcionando**: `tendencias_youtube.py "<destino> viaje" "qué hacer en <destino>" ...` → tabla de videos ordenados por multiplicador (cuántas veces superaron el promedio de su canal), con vistas por día, formato (Short / largo) y comentarios.
3. **Qué preguntan** los comentarios de los 3–5 outliers: dudas repetidas = temas de video y objeciones para la "cámara 2".
4. **Cruce con el material de Santiago**: qué de eso puede mostrar con material real de su viaje.
5. Salida: `investigacion/<destino>.md` con 5–10 ideas ordenadas, cada una con gancho sugerido, formato (reel / largo) y la prueba (video outlier que lo respalda).

TikTok e Instagram: TikTok Creative Center (gratis) para sonidos y hashtags en tendencia; para Instagram, `/ig-viral` con 6–12 cuentas de viaje que Santiago elija.

## Agente "Analista de retención" (después de publicar)

Cada 2 semanas, por video:
- **Retención a los 3 s, 30 s y 50 %**, y el momento exacto de las caídas fuertes.
- Qué había en pantalla y qué se decía en cada caída (cruzando con el plan de edición).
- Comparación con el promedio del canal.
- Reglas que salen de ahí (p. ej. "los ganchos con precio retienen más que los ganchos con paisaje") → se agregan a `docs/02` o `docs/03`.

## Cómo se usa en la producción

```
Destino ──► Investigador de tendencias ──► ideas respaldadas por datos
        ──► guion (Santiago graba su voz) ──► producción (reels / YouTube)
        ──► revisión semanal ──► publicación ──► Analista de retención ──► reglas nuevas
```

## Configuración pendiente

1. **Clave de la YouTube Data API** (gratis): Google Cloud Console → crear proyecto → habilitar "YouTube Data API v3" → Credenciales → clave de API. Se guarda como credencial del entorno (nunca en el chat ni en el repositorio).
2. Opcional: **vidIQ** (conector disponible en Claude; plan gratis con 150 créditos/mes).
3. Acceso a **YouTube Studio Analytics** de su canal (desde su Chrome, o autorizando la YouTube Analytics API).

Nota: el script no se ha podido probar todavía porque la red de esta sesión no llega a Google/YouTube. Se prueba en cuanto haya clave y acceso.

Fuentes de precios y cuotas (noviembre 2026): [NexLev pricing (OutlierKit)](https://outlierkit.com/resources/nexlev-pricing/), [NexLev](https://www.nexlev.io/pricing), [Cuota YouTube Data API](https://developers.google.com/youtube/v3/determine_quota_cost), [vidIQ MCP](https://vidiq.com/mcp/), [vidIQ MCP precios](https://www.activepieces.com/blog/vidiq-mcp-setup-credits-pricing-2026-guide.md).
