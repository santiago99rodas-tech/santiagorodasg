import { pool, one } from "../db/pool.js";

let houseId: number | null = null;

/** Cuenta interna de la casa (market maker). No tiene billetera externa. */
export async function houseAccount(): Promise<number> {
  if (houseId) return houseId;
  const r = await one(pool, "SELECT id FROM players WHERE is_house AND operator_id IS NULL LIMIT 1");
  houseId = r ? r.id : (await one(pool, "INSERT INTO players (operator_id, external_id, display_name, is_house) VALUES (NULL, 'house-mm', 'Casa', TRUE) RETURNING id"))!.id;
  return houseId!;
}
export function resetHouseCache() { houseId = null; }
