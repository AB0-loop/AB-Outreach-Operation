import { db } from "@/db";
import { emailMessages, type Prospect, type Settings } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { findSuppression, SuppressionUnavailableError } from "./suppression";
import { evaluateSendGate } from "./settings";
import { STOP_STATES, type ProspectState } from "./state";
import { getAccount } from "./providers/gmail";
import { env } from "./env";

export { remainingDailyQuota, sentTodayCount } from "./budget";

export type EligibilityResult = {
  eligible: boolean;
  blockers: string[];
  review: boolean;
};

const EMAIL_RE = /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/;

/**
 * Section 6 gate. Every condition must pass before a prospect may be queued.
 * A thrown suppression error is converted into a hard blocker — never a pass.
 */
export async function checkEligibility(
  prospect: Prospect,
  settings: Settings,
): Promise<EligibilityResult> {
  const blockers: string[] = [];
  let review = false;

  // Identity & relevance
  if (!prospect.fullName || prospect.fullName.trim().split(/\s+/).length < 1)
    blockers.push("Prospect name is missing");
  if (!prospect.role && !prospect.company) {
    blockers.push("No professional role or company recorded");
    review = true;
  }
  if (!prospect.qualificationReason) {
    blockers.push("No recorded reason this prospect qualifies");
    review = true;
  }
  if (prospect.leadScore < settings.minLeadScore) {
    blockers.push(
      `Lead score ${prospect.leadScore} is below the configured minimum ${settings.minLeadScore}`,
    );
    review = true;
  }
  if (!prospect.bengaluruEvidenceUrl && !prospect.sourceUrl) {
    blockers.push("No source URL supporting the Bengaluru connection");
    review = true;
  }

  // Email + verification status
  if (!prospect.email || !EMAIL_RE.test(prospect.email))
    blockers.push("Email address is missing or malformed");
  if (prospect.emailStatus !== "source_verified")
    blockers.push(`Email is not source-verified (status: ${prospect.emailStatus})`);
  if (!prospect.emailSourceUrl)
    blockers.push("Email address has no recorded public source URL");

  // Terminal / stop states
  if (STOP_STATES.includes(prospect.status as ProspectState))
    blockers.push(`Prospect is in terminal state ${prospect.status}`);

  // Suppression (fail closed)
  try {
    const suppression = await findSuppression(prospect.email);
    if (suppression)
      blockers.push(`Address is suppressed (${suppression.reason})`);
  } catch (e) {
    blockers.push(
      e instanceof SuppressionUnavailableError
        ? "Suppression list could not be checked"
        : "Suppression check error",
    );
  }

  // Duplicate sequence guard
  const existing = await db
    .select({ id: emailMessages.id, status: emailMessages.status })
    .from(emailMessages)
    .where(
      and(
        eq(emailMessages.prospectId, prospect.id),
        inArray(emailMessages.status, ["queued", "sent", "uncertain"]),
      ),
    );
  if (existing.length > 0)
    blockers.push("Prospect already has an active or completed sequence");

  // Business-purpose & configuration gates
  const gate = evaluateSendGate(settings);
  if (!gate.allowed) blockers.push(...gate.reasons);

  // Authorized sender
  if (!env.mockMode) {
    const acct = await getAccount();
    if (!acct?.authorized) blockers.push("No authorized Gmail sender account");
    else if (acct.email.toLowerCase() !== settings.senderEmail.toLowerCase())
      blockers.push("Authorized Gmail account does not match configured sender");
  }

  return { eligible: blockers.length === 0, blockers, review };
}
