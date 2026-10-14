import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { redact, log } from "./log";

export async function audit(entry: {
  actor: string;
  action: string;
  entity?: string;
  entityId?: string | number;
  detail?: unknown;
}) {
  try {
    await db.insert(auditLog).values({
      actor: entry.actor,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId !== undefined ? String(entry.entityId) : null,
      detail: (redact(entry.detail ?? {}) ?? {}) as Record<string, unknown>,
    });
  } catch (e) {
    log.error("audit_write_failed", { action: entry.action, error: String(e) });
  }
}
