import { db } from "@/db";
import {
  budgetDecisions,
  emailMessages,
  prospects,
  replies,
  suppressions,
  type Settings,
} from "@/db/schema";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { getSettings, updateSettings } from "./settings";
import { startOfZonedDay, zonedParts } from "./time";
import { enqueueNotification } from "./providers/telegram";
import { audit } from "./audit";

/**
 * Adaptive sending controller.
 *
 * There is no hard-coded "5 per day". The daily budget starts at `budgetFloor`
 * and moves only in response to *measured* delivery health. The binding limit
 * is always the STRICTEST of:
 *   - the operator-verified provider recipient limit for this Gmail account
 *   - the operator-set budget ceiling
 *   - the health-derived budget
 *
 * The controller never raises volume to hit a quota, never rotates accounts,
 * and never increases more than once per 24 hours.
 */

export type HealthMetrics = {
  windowDays: number;
  sent: number;
  hardBounces: number;
  complaints: number;
  optOuts: number;
  declines: number;
  positiveReplies: number;
  bounceRate: number;
  complaintRate: number;
  optOutRate: number;
  positiveRate: number;
  avgVerificationConfidence: number;
  eligiblePool: number;
};

const WINDOW_DAYS = 14;

export async function collectHealthMetrics(
  windowDays = WINDOW_DAYS,
): Promise<HealthMetrics> {
  const since = new Date(Date.now() - windowDays * 86_400_000);
  const n = async (q: Promise<{ n: string }[]>) => Number((await q)[0]?.n ?? 0);

  const sent = await n(
    db
      .select({ n: sql<string>`count(*)` })
      .from(emailMessages)
      .where(and(eq(emailMessages.status, "sent"), gte(emailMessages.sentAt, since))),
  );
  const hardBounces = await n(
    db
      .select({ n: sql<string>`count(*)` })
      .from(replies)
      .where(and(eq(replies.classification, "hard_bounce"), gte(replies.receivedAt, since))),
  );
  const complaints = await n(
    db
      .select({ n: sql<string>`count(*)` })
      .from(replies)
      .where(and(eq(replies.classification, "complaint"), gte(replies.receivedAt, since))),
  );
  const optOuts = await n(
    db
      .select({ n: sql<string>`count(*)` })
      .from(suppressions)
      .where(and(eq(suppressions.reason, "unsubscribe"), gte(suppressions.createdAt, since))),
  );
  const declines = await n(
    db
      .select({ n: sql<string>`count(*)` })
      .from(replies)
      .where(and(eq(replies.classification, "decline"), gte(replies.receivedAt, since))),
  );
  const positiveReplies = await n(
    db
      .select({ n: sql<string>`count(*)` })
      .from(replies)
      .where(
        and(
          inArray(replies.classification, ["interested", "consultation", "pricing"]),
          gte(replies.receivedAt, since),
        ),
      ),
  );
  const eligiblePool = await n(
    db
      .select({ n: sql<string>`count(*)` })
      .from(prospects)
      .where(eq(prospects.status, "ELIGIBLE")),
  );
  const confRows = await db
    .select({ avg: sql<string>`coalesce(avg(${prospects.verificationConfidence}), 0)` })
    .from(prospects)
    .where(eq(prospects.status, "ELIGIBLE"));
  const avgVerificationConfidence = Number(confRows[0]?.avg ?? 0);

  const rate = (x: number) => (sent > 0 ? x / sent : 0);
  return {
    windowDays,
    sent,
    hardBounces,
    complaints,
    optOuts,
    declines,
    positiveReplies,
    bounceRate: rate(hardBounces),
    complaintRate: rate(complaints),
    optOutRate: rate(optOuts),
    positiveRate: rate(positiveReplies),
    avgVerificationConfidence,
    eligiblePool,
  };
}

export type BudgetDecision = {
  previous: number;
  next: number;
  action: "increase" | "hold" | "decrease" | "pause";
  reason: string;
  bindingConstraint: string;
  metrics: HealthMetrics;
};

/** Risk thresholds. Deliberately stricter than any provider's own tolerance. */
export const THRESHOLDS = {
  bounceHalve: 0.05,
  bouncePause: 0.1,
  complaintHalve: 0.003,
  complaintPause: 0.01,
  optOutHalve: 0.05,
  growthBounce: 0.02,
  growthComplaint: 0.001,
  growthOptOut: 0.03,
  minSentBeforeGrowth: 10,
  minConfidenceForGrowth: 70,
};

export function computeBudget(
  s: Settings,
  m: HealthMetrics,
  canGrowNow: boolean,
): BudgetDecision {
  const previous = s.currentDailyBudget;
  // The hard outer bound is always the strictest operator-verified limit.
  const hardMax = Math.min(s.budgetCeiling, s.providerDailyLimit);

  const base = (
    action: BudgetDecision["action"],
    next: number,
    reason: string,
    bindingConstraint: string,
  ): BudgetDecision => ({
    previous,
    next: Math.max(0, Math.min(next, hardMax)),
    action,
    reason,
    bindingConstraint,
    metrics: m,
  });

  // --- Deteriorating health: reduce or stop, immediately. ---
  if (m.sent >= 5 && m.bounceRate >= THRESHOLDS.bouncePause)
    return base("pause", 0, `Hard bounce rate ${(m.bounceRate * 100).toFixed(1)}% ≥ 10% — sending paused for list review`, "delivery_health");
  if (m.sent >= 5 && m.complaintRate >= THRESHOLDS.complaintPause)
    return base("pause", 0, `Complaint rate ${(m.complaintRate * 100).toFixed(2)}% ≥ 1% — sending paused`, "delivery_health");
  if (m.sent >= 5 && m.bounceRate >= THRESHOLDS.bounceHalve)
    return base("decrease", Math.max(s.budgetFloor, Math.floor(previous / 2)), `Hard bounce rate ${(m.bounceRate * 100).toFixed(1)}% ≥ 5% — volume halved`, "delivery_health");
  if (m.sent >= 5 && m.complaintRate >= THRESHOLDS.complaintHalve)
    return base("decrease", Math.max(s.budgetFloor, Math.floor(previous / 2)), `Complaint rate ${(m.complaintRate * 100).toFixed(2)}% ≥ 0.3% — volume halved`, "delivery_health");
  if (m.sent >= 10 && m.optOutRate >= THRESHOLDS.optOutHalve)
    return base("decrease", Math.max(s.budgetFloor, Math.floor(previous / 2)), `Opt-out rate ${(m.optOutRate * 100).toFixed(1)}% ≥ 5% — targeting quality is too low`, "recipient_quality");

  // --- Growth: only on measured evidence, at most once per 24h. ---
  if (!canGrowNow)
    return base("hold", previous, "Budget already adjusted within the last 24 hours", "growth_interval");
  if (m.sent < THRESHOLDS.minSentBeforeGrowth)
    return base("hold", previous, `Only ${m.sent} sends in ${m.windowDays}d — insufficient evidence to raise volume`, "insufficient_evidence");
  if (m.avgVerificationConfidence < THRESHOLDS.minConfidenceForGrowth)
    return base("hold", previous, `Average queue verification confidence ${m.avgVerificationConfidence.toFixed(0)} < ${THRESHOLDS.minConfidenceForGrowth}`, "recipient_quality");
  if (
    m.bounceRate > THRESHOLDS.growthBounce ||
    m.complaintRate > THRESHOLDS.growthComplaint ||
    m.optOutRate > THRESHOLDS.growthOptOut
  )
    return base("hold", previous, "Delivery metrics are acceptable but not clean enough to justify growth", "delivery_health");
  if (previous >= hardMax)
    return base(
      "hold",
      previous,
      `At the strictest configured limit (ceiling ${s.budgetCeiling}, operator-verified provider limit ${s.providerDailyLimit})`,
      previous >= s.providerDailyLimit ? "provider_limit" : "operator_ceiling",
    );

  const step = Math.max(1, Math.round((previous * s.budgetGrowthPct) / 100));
  return base(
    "increase",
    previous + step,
    `Clean metrics over ${m.windowDays}d (bounce ${(m.bounceRate * 100).toFixed(1)}%, complaints ${(m.complaintRate * 100).toFixed(2)}%, opt-outs ${(m.optOutRate * 100).toFixed(1)}%) — +${step}`,
    "delivery_health",
  );
}

/** Evaluates and persists today's budget. Idempotent per local day. */
export async function evaluateDailyBudget(force = false): Promise<BudgetDecision | null> {
  const s = await getSettings();
  const dayKey = zonedParts(new Date(), s.timezone).dateKey;

  const existing = await db
    .select()
    .from(budgetDecisions)
    .where(eq(budgetDecisions.dayKey, dayKey))
    .limit(1);
  if (existing.length > 0 && !force) return null;

  const canGrowNow =
    !s.lastBudgetDecisionAt ||
    Date.now() - s.lastBudgetDecisionAt.getTime() >= 24 * 3600_000;

  const metrics = await collectHealthMetrics();
  const decision = computeBudget(s, metrics, canGrowNow);

  await db
    .insert(budgetDecisions)
    .values({
      dayKey,
      previousBudget: decision.previous,
      newBudget: decision.next,
      action: decision.action,
      reason: decision.reason,
      bindingConstraint: decision.bindingConstraint,
      metrics: {
        sent: metrics.sent,
        hardBounces: metrics.hardBounces,
        complaints: metrics.complaints,
        optOuts: metrics.optOuts,
        positiveReplies: metrics.positiveReplies,
        bounceRatePct: Number((metrics.bounceRate * 100).toFixed(2)),
        complaintRatePct: Number((metrics.complaintRate * 100).toFixed(2)),
        optOutRatePct: Number((metrics.optOutRate * 100).toFixed(2)),
        avgVerificationConfidence: Number(metrics.avgVerificationConfidence.toFixed(1)),
        eligiblePool: metrics.eligiblePool,
      },
    })
    .onConflictDoNothing({ target: budgetDecisions.dayKey });

  if (decision.next !== decision.previous || decision.action === "pause") {
    await updateSettings({
      currentDailyBudget: decision.next,
      lastBudgetDecisionAt: new Date(),
      ...(decision.action === "pause"
        ? { sendingEnabled: false, budgetPausedReason: decision.reason }
        : { budgetPausedReason: null }),
    });
  } else {
    await updateSettings({ lastBudgetDecisionAt: new Date() });
  }

  await audit({
    actor: "system",
    action: `budget.${decision.action}`,
    detail: { from: decision.previous, to: decision.next, reason: decision.reason },
  });

  if (decision.action === "pause" || decision.action === "decrease") {
    await enqueueNotification({
      kind: "critical",
      dedupeKey: `budget-${decision.action}-${dayKey}`,
      text:
        `${decision.action === "pause" ? "🛑" : "⚠️"} <b>Sending volume ${decision.action}d</b>\n` +
        `${decision.previous} → ${decision.next} per day\n${decision.reason}`,
    });
  }
  return decision;
}

/** How many NEW cold emails may still be sent in the current local day. */
export async function remainingDailyQuota(s: Settings): Promise<number> {
  const dayStart = startOfZonedDay(new Date(), s.timezone);
  // Follow-ups consume the same budget as new messages.
  const rows = await db
    .select({ n: sql<string>`count(*)` })
    .from(emailMessages)
    .where(and(eq(emailMessages.status, "sent"), gte(emailMessages.sentAt, dayStart)));
  const usedToday = Number(rows[0]?.n ?? 0);
  const effective = Math.min(s.currentDailyBudget, s.budgetCeiling, s.providerDailyLimit);
  return Math.max(0, effective - usedToday);
}

export async function sentTodayCount(s: Settings): Promise<number> {
  const dayStart = startOfZonedDay(new Date(), s.timezone);
  const rows = await db
    .select({ n: sql<string>`count(*)` })
    .from(emailMessages)
    .where(and(eq(emailMessages.status, "sent"), gte(emailMessages.sentAt, dayStart)));
  return Number(rows[0]?.n ?? 0);
}

export async function recentBudgetDecisions(limit = 10) {
  return db
    .select()
    .from(budgetDecisions)
    .orderBy(sql`${budgetDecisions.id} desc`)
    .limit(limit);
}
