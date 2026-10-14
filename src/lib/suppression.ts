import { db } from "@/db";
import { suppressions } from "@/db/schema";
import { eq } from "drizzle-orm";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class SuppressionUnavailableError extends Error {}

export type SuppressionReason =
  | "unsubscribe"
  | "complaint"
  | "hard_bounce"
  | "decline"
  | "manual";

/**
 * Returns the suppression record or null. Throws SuppressionUnavailableError
 * when the lookup itself fails — callers MUST treat a throw as "do not send".
 */
export async function findSuppression(email: string) {
  const normalized = normalizeEmail(email);
  try {
    const rows = await db
      .select()
      .from(suppressions)
      .where(eq(suppressions.emailNormalized, normalized))
      .limit(1);
    return rows[0] ?? null;
  } catch (e) {
    throw new SuppressionUnavailableError(
      `Suppression lookup failed: ${e instanceof Error ? e.message : "unknown"}`,
    );
  }
}

export async function isSuppressed(email: string): Promise<boolean> {
  return (await findSuppression(email)) !== null;
}

/** Idempotent, permanent. An existing record is never downgraded or removed. */
export async function suppress(opts: {
  email: string;
  reason: SuppressionReason;
  sourceRef?: string;
  note?: string;
}) {
  const normalized = normalizeEmail(opts.email);
  await db
    .insert(suppressions)
    .values({
      emailNormalized: normalized,
      reason: opts.reason,
      sourceRef: opts.sourceRef,
      note: opts.note,
    })
    .onConflictDoNothing({ target: suppressions.emailNormalized });
  return findSuppression(normalized);
}
