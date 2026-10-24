import { pool, one, many } from "../db/pool.js";
import { conflict, notFound } from "../lib/errors.js";
import { createEvent } from "./events.js";

export async function listDrafts(status = "pending") {
  return many(pool,
    `SELECT d.*, t.label AS trend_label FROM drafts d LEFT JOIN trends t ON t.id=d.trend_id WHERE d.status=$1 ORDER BY d.created_at DESC LIMIT 200`, [status]);
}

export async function createManualDraft(payload: object, by: string) {
  return one(pool, "INSERT INTO drafts (payload, created_by) VALUES ($1,$2) RETURNING *", [JSON.stringify(payload), by]);
}

/** Aprueba un borrador (con ediciones opcionales del moderador) y publica el evento. */
export async function approveDraft(id: number, edits: Record<string, unknown>, reviewer: string) {
  const d = await one(pool, "SELECT * FROM drafts WHERE id=$1", [id]);
  if (!d) throw notFound("Borrador no encontrado");
  if (d.status !== "pending") throw conflict("draft_reviewed", `El borrador ya fue ${d.status === "approved" ? "aprobado" : "rechazado"}`);
  const payload = { ...d.payload, ...edits };
  const event = await createEvent(payload, { draftId: id });
  await pool.query("UPDATE drafts SET status='approved', reviewed_by=$2, reviewed_at=now(), event_id=$3, payload=$4 WHERE id=$1",
    [id, reviewer, event!.id, JSON.stringify(payload)]);
  return event;
}

export async function rejectDraft(id: number, note: string, reviewer: string) {
  const d = await one(pool, "UPDATE drafts SET status='rejected', reviewed_by=$2, review_note=$3, reviewed_at=now() WHERE id=$1 AND status='pending' RETURNING *", [id, reviewer, note]);
  if (!d) throw conflict("draft_reviewed", "El borrador no existe o ya fue revisado");
  return d;
}
