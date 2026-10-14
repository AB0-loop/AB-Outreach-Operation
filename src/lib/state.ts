import { db } from "@/db";
import { prospects, stateTransitions } from "@/db/schema";
import { eq } from "drizzle-orm";

export const PROSPECT_STATES = [
  "DISCOVERED",
  "VERIFIED",
  "ELIGIBLE",
  "QUEUED",
  "SENT",
  "REPLIED",
  "INTERESTED",
  "DECLINED",
  "UNSUBSCRIBED",
  "BOUNCED",
  "AMBIGUOUS",
  "CLOSED",
  "REVIEW",
  "REJECTED",
] as const;

export type ProspectState = (typeof PROSPECT_STATES)[number];

/** Terminal stop states: no outbound email may ever be generated from these. */
export const STOP_STATES: ProspectState[] = [
  "UNSUBSCRIBED",
  "BOUNCED",
  "DECLINED",
  "REJECTED",
  "CLOSED",
];

const ALLOWED: Record<ProspectState, ProspectState[]> = {
  DISCOVERED: ["VERIFIED", "REVIEW", "REJECTED"],
  VERIFIED: ["ELIGIBLE", "REVIEW", "REJECTED", "UNSUBSCRIBED", "BOUNCED"],
  ELIGIBLE: ["QUEUED", "REVIEW", "REJECTED", "UNSUBSCRIBED", "BOUNCED"],
  QUEUED: ["SENT", "ELIGIBLE", "REVIEW", "REJECTED", "UNSUBSCRIBED", "BOUNCED"],
  SENT: [
    "SENT",
    "REPLIED",
    "BOUNCED",
    "UNSUBSCRIBED",
    "CLOSED",
    "REVIEW",
    "AMBIGUOUS",
  ],
  REPLIED: [
    "INTERESTED",
    "DECLINED",
    "UNSUBSCRIBED",
    "BOUNCED",
    "AMBIGUOUS",
    "CLOSED",
    "REVIEW",
  ],
  AMBIGUOUS: [
    "INTERESTED",
    "DECLINED",
    "UNSUBSCRIBED",
    "BOUNCED",
    "CLOSED",
    "REVIEW",
    "REPLIED",
  ],
  INTERESTED: ["CLOSED", "UNSUBSCRIBED", "DECLINED", "REVIEW"],
  REVIEW: [
    "VERIFIED",
    "ELIGIBLE",
    "REJECTED",
    "UNSUBSCRIBED",
    "BOUNCED",
    "CLOSED",
    "INTERESTED",
    "DECLINED",
  ],
  // Terminal — only an explicit human reopen may move out, and never for
  // UNSUBSCRIBED / BOUNCED (suppression record is permanent regardless).
  DECLINED: ["CLOSED"],
  UNSUBSCRIBED: [],
  BOUNCED: [],
  CLOSED: [],
  REJECTED: [],
};

export function canTransition(
  from: ProspectState,
  to: ProspectState,
  actor: "system" | "human" | "ai",
): boolean {
  if (actor === "ai") return false; // AI never mutates lifecycle state directly
  if (from === to) return true;
  if (ALLOWED[from]?.includes(to)) return true;
  // A human may reopen a DECLINED/CLOSED conversation, but never an opt-out
  // or hard bounce — the suppression record stays authoritative.
  if (
    actor === "human" &&
    (from === "CLOSED" || from === "DECLINED") &&
    to === "INTERESTED"
  )
    return true;
  return false;
}

export class StateTransitionError extends Error {}

export async function transition(opts: {
  prospectId: number;
  to: ProspectState;
  reason: string;
  actor?: "system" | "human" | "ai";
  extra?: Partial<typeof prospects.$inferInsert>;
}): Promise<ProspectState> {
  const actor = opts.actor ?? "system";
  const [current] = await db
    .select()
    .from(prospects)
    .where(eq(prospects.id, opts.prospectId))
    .limit(1);
  if (!current) throw new StateTransitionError("Prospect not found");

  const from = current.status as ProspectState;
  if (!canTransition(from, opts.to, actor)) {
    throw new StateTransitionError(
      `Illegal transition ${from} -> ${opts.to} by ${actor}`,
    );
  }

  await db
    .update(prospects)
    .set({ status: opts.to, updatedAt: new Date(), ...(opts.extra ?? {}) })
    .where(eq(prospects.id, opts.prospectId));

  await db.insert(stateTransitions).values({
    prospectId: opts.prospectId,
    fromState: from,
    toState: opts.to,
    reason: opts.reason,
    actor,
  });

  return opts.to;
}
