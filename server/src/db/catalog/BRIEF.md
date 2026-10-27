# Instrucciones para escribir el catálogo de mercados

Fecha de hoy: 24 de octubre de 2026. Público: jugadores de casinos online en Ecuador, Colombia y Latinoamérica.
Escribe en español neutro latinoamericano.

## Formato
Archivo TypeScript en `server/src/db/catalog/<nombre>.ts` (ver `types.ts`):

```ts
import type { CatalogCategory } from "./types.js";
export default [
  { category: "futbol", source: "Organizador oficial de cada competición", items: [
    { q: "¿Ganará el Real Madrid la UEFA Champions League 2026-27?", close: "2027-05-28", p: 0.17, src: "UEFA" },
    { q: "¿Quién ganará la UEFA Champions League 2026-27?", close: "2027-05-28", src: "UEFA",
      options: [["Real Madrid", 0.16], ["FC Barcelona", 0.14], ["PSG", 0.13], ["Arsenal", 0.12], ["Bayern Múnich", 0.11], ["Liverpool", 0.09], ["Otro", 0.25]] },
  ] },
] satisfies CatalogCategory[];
```

## Reglas
1. **Mínimo 26 preguntas por categoría** (para tener margen sobre el mínimo de 25). Mezcla: ~65% binarias (Sí/No) y ~35% de opción múltiple.
2. **No deben estar resueltas hoy.** Tu conocimiento puede no llegar hasta octubre de 2026: evita eventos que pudieron ocurrir entre enero y octubre de 2026 (por ejemplo el Mundial 2026 ya se jugó, las elecciones de Colombia 2026 ya pasaron, el Balón de Oro 2026 y los Nobel 2026 ya se entregaron). Prefiere:
   - eventos programados desde noviembre de 2026 en adelante (finales, galas, estrenos, elecciones, lanzamientos con fecha),
   - preguntas "¿…antes del 31 de diciembre de 2027?" sobre cosas que con alta probabilidad aún no han pasado,
   - umbrales numéricos que hoy probablemente no se han alcanzado (si dudas, pon el umbral más lejos).
3. **close**: entre el 2026-10-27 y el 2028-05-31, y ANTES de que se conozca el resultado (para una gala del 15 de marzo, cierra el 14 de marzo). Para "antes del 31 de diciembre de 2027", cierra el 2027-12-31.
4. **Resoluble y objetiva**: una fuente oficial pública decide (`src`). La pregunta incluye el plazo y el umbral exacto. Si hace falta precisión, agrega `rule` con el criterio exacto (empates, aplazamientos, qué cuenta).
5. **Múltiples**: 3 a 8 opciones excluyentes que cubren todos los casos; incluye "Otro"/"Otra" cuando la lista no es cerrada. Probabilidades que sumen 1.
6. **Probabilidades realistas** según lo que sabes (0,03 a 0,97). No todo en 0,5.
7. **Prohibido**: muertes, salud, enfermedades, embarazos o accidentes de personas concretas; violencia, crímenes, atentados, víctimas de guerras o desastres; menores de edad; personas privadas; contenido sexual; cosas que un jugador podría provocar o manipular. Diplomacia (acuerdos, ceses al fuego, cumbres) sí está permitida.
8. Foco: mezcla de Ecuador, Colombia, Latinoamérica y lo global que la gente busca en Google (estrenos, sagas, videojuegos, famosos, deportes, ciencia, espacio, OVNIs, animales…). Piensa en lo que genera alto flujo de apuestas: temas populares, nombres conocidos, resultados cercanos en el tiempo.
9. Sin preguntas duplicadas entre sí (ni casi iguales). Máximo 200 caracteres por pregunta.

## Hechos de contexto que puedes usar (a octubre de 2026)
- GTA VI tiene lanzamiento anunciado para el 19 de noviembre de 2026 (PS5 y Xbox Series).
- Miss Universo 2025 lo ganó México (Fátima Bosch). La próxima edición (2026) aún no se celebra.
- En enero de 2026 Estados Unidos capturó a Nicolás Maduro; Delcy Rodríguez quedó al frente del gobierno venezolano.
- José Antonio Kast es presidente de Chile desde marzo de 2026. Daniel Noboa es presidente de Ecuador (periodo 2025-2029).
- Elecciones de mitad de periodo en EE. UU.: 3 de noviembre de 2026. Elecciones presidenciales de Argentina: octubre de 2027. Francia: abril-mayo de 2027.
- Papa León XIV (elegido en mayo de 2025).
- Avengers: Doomsday y Dune: Parte Tres se estrenan el 18 de diciembre de 2026. Shrek 5 está programada para 2027. The Batman Parte II para octubre de 2027.
- La final de la Champions League 2026-27 será a finales de mayo de 2027.

## Validación
Cuando termines, corre desde `server/`: `npx tsx src/db/catalog/validate.ts src/db/catalog/<nombre>.ts`
(el validador revisa formato, fechas, probabilidades, duplicados y mínimo por categoría; corrige hasta que diga "catálogo válido").
