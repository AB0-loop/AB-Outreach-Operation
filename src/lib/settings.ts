import { db } from "@/db";
import { settings, type Settings } from "@/db/schema";
import { eq } from "drizzle-orm";

/** Loads the singleton settings row, creating it with safe defaults. */
export async function getSettings(): Promise<Settings> {
  const rows = await db.select().from(settings).where(eq(settings.id, 1));
  if (rows.length > 0) return rows[0];
  await db.insert(settings).values({ id: 1 }).onConflictDoNothing();
  const created = await db.select().from(settings).where(eq(settings.id, 1));
  return created[0];
}

export async function updateSettings(
  patch: Partial<typeof settings.$inferInsert>,
): Promise<Settings> {
  await getSettings();
  await db
    .update(settings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(settings.id, 1));
  return getSettings();
}

export type SendGate = { allowed: boolean; reasons: string[] };

/**
 * Deterministic configuration gate. Live sending is impossible until every
 * mandatory content element is configured and validated.
 */
export function evaluateSendGate(s: Settings): SendGate {
  const reasons: string[] = [];
  if (s.emergencyStop) reasons.push("EMERGENCY_STOP is active");
  if (!s.sendingEnabled) reasons.push("Sending is disabled");
  if (!s.businessPhone || !s.businessPhoneVerified)
    reasons.push("Verified business phone number is not configured");
  if (s.businessPhone && !isValidIndianBusinessPhone(s.businessPhone))
    reasons.push("Configured business phone fails format validation");
  if (!s.businessWebsite?.startsWith("https://"))
    reasons.push("Business website is not configured");
  if (!s.senderEmail?.includes("@"))
    reasons.push("Sender email is not configured");
  return { allowed: reasons.length === 0, reasons };
}

/** E.164 India or a plain 10-digit national number with optional +91. */
export function isValidIndianBusinessPhone(phone: string): boolean {
  const cleaned = phone.replace(/[\s()\-.]/g, "");
  if (/^\+91[6-9]\d{9}$/.test(cleaned)) return true;
  if (/^\+91(80|11|22|33|44)\d{7,8}$/.test(cleaned)) return true; // landline STD
  return false;
}

export function normalizePhone(phone: string): string {
  const cleaned = phone.replace(/[\s()\-.]/g, "");
  if (/^[6-9]\d{9}$/.test(cleaned)) return `+91${cleaned}`;
  if (/^0[6-9]\d{9}$/.test(cleaned)) return `+91${cleaned.slice(1)}`;
  if (/^91[6-9]\d{9}$/.test(cleaned)) return `+${cleaned}`;
  return cleaned;
}
