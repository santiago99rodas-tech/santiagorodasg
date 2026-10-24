// Formato del catálogo de mercados semilla.
//
// Binario:  { q: "¿Lanzará SpaceX una Starship hacia Marte antes del 31 de diciembre de 2026?", close: "2026-12-31", p: 0.25, src: "SpaceX / NASA" }
// Múltiple: { q: "¿Quién ganará la Champions League 2026-27?", close: "2027-05-29", options: [["Real Madrid", 0.16], ["Otro", 0.2]], src: "UEFA" }
//
// - close: fecha "AAAA-MM-DD" en la que se deja de apostar (23:59 hora de Ecuador). Debe ser anterior al momento en que se conoce el resultado.
// - p: probabilidad inicial del Sí (0,03 a 0,97).
// - options: opciones excluyentes que cubren todos los casos (incluye "Otro" si hace falta). Probabilidades que suman ~1.
// - src: fuente oficial que decide. Si se omite, se usa la de la categoría.
// - rule: criterio de resolución. Si se omite, se genera uno estándar a partir de la pregunta, la fuente y la fecha.
// - tags: opcional.

export interface CatalogBinary { q: string; close: string; p: number; src?: string; rule?: string; tags?: string[]; featured?: boolean }
export interface CatalogMulti { q: string; close: string; options: [string, number][]; src?: string; rule?: string; tags?: string[]; featured?: boolean }
export type CatalogItem = CatalogBinary | CatalogMulti;

export interface CatalogCategory {
  category: string; // slug de categories
  source: string; // fuente por defecto de la categoría
  items: CatalogItem[];
}

export const isMulti = (i: CatalogItem): i is CatalogMulti => "options" in i;
