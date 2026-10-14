process.env.OUTREACH_MOCK = "1";
process.env.SCHEDULER_ENABLED = "0";
process.env.TOKEN_ENCRYPTION_KEY =
  process.env.TOKEN_ENCRYPTION_KEY ??
  "0000000000000000000000000000000000000000000000000000000000000000";

import { db } from "../src/db";
import { sql } from "drizzle-orm";
import { resetMock, mockStore } from "../src/lib/providers/mock";
import { resetBreakers } from "../src/lib/providers/ai";
import { updateSettings } from "../src/lib/settings";
import { ingestProspects, type ProspectInput } from "../src/lib/discovery";

import { isBusinessDay } from "../src/lib/time";

/**
 * A deterministic "now" that is always slightly in the future (so pacing
 * jitter has elapsed) and always lands on an India business day.
 */
function businessNow(): Date {
  let d = new Date(Date.now() + 20 * 60 * 1000);
  for (let i = 0; i < 7 && !isBusinessDay(d, "Asia/Kolkata"); i++) {
    d = new Date(d.getTime() + 24 * 60 * 60 * 1000);
  }
  return d;
}

export const TEST_NOW = businessNow();

export async function resetAll() {
  resetMock();
  resetBreakers();
  await db.execute(sql`
    truncate table
      state_transitions, evidence_claims, replies, email_messages, prospects,
      suppressions, jobs, notifications, ai_usage, reports, report_counter,
      appointments, budget_decisions, approvals, processed_events,
      audit_log, oauth_accounts, discovery_sources, campaigns, settings
    restart identity cascade
  `);
  await updateSettings({
    emergencyStop: false,
    sendingEnabled: true,
    businessPhone: "+918040001234",
    businessPhoneVerified: true,
    businessWebsite: "https://aurumbespoke.com",
    senderEmail: "connectaurumbespoke@gmail.com",
    currentDailyBudget: 5,
    budgetFloor: 5,
    budgetCeiling: 40,
    providerDailyLimit: 100,
    sendWindowStartHour: 0,
    sendWindowEndHour: 24,
    lastReportAt: null,
    lastBudgetDecisionAt: null,
    aiPaused: false,
    aiPausedReason: null,
    aiDailyCapUsd: "1.0000",
    grokDailyCapUsd: "1.0000",
    geminiDailyCapUsd: "0.5000",
    geminiEnabled: true,
    minQualityScore: 75,
    minLeadScore: 60,
  });
}

export const TEST_DOMAIN = "outreach-test.example.com";

export function prospectInput(overrides: Partial<ProspectInput> = {}): ProspectInput {
  const n = Math.floor(Math.random() * 1e9);
  return {
    fullName: "Rohan Mehta",
    role: "Managing Director",
    company: "Mehta Advisory LLP",
    segment: "professional",
    email: `rohan.test.${n}@${TEST_DOMAIN}`,
    emailSourceUrl: "https://example.com/team/rohan-mehta",
    sourceUrl: "https://example.com/team/rohan-mehta",
    sourceName: "synthetic_test_directory",
    bengaluruEvidenceUrl: "https://example.com/team/rohan-mehta",
    website: "https://example.com",
    qualificationReason:
      "Managing Director of a Bengaluru advisory firm; client-facing senior professional.",
    claims: [
      {
        claimText: "Rohan Mehta is Managing Director at Mehta Advisory LLP in Bengaluru",
        sourceUrl: "https://example.com/team/rohan-mehta",
        excerpt:
          "Rohan Mehta is Managing Director at Mehta Advisory LLP in Bengaluru, leading the corporate advisory practice.",
      },
    ],
    ...overrides,
  };
}

export async function seedProspect(overrides: Partial<ProspectInput> = {}) {
  const input = prospectInput(overrides);
  const res = await ingestProspects([input]);
  if (res.created !== 1) {
    throw new Error(`seed failed: ${JSON.stringify(res.rejected)}`);
  }
  const rows = await db.execute(
    sql`select * from prospects where email_normalized = ${input.email.toLowerCase()}`,
  );
  return { input, prospect: (rows.rows as Record<string, unknown>[])[0] };
}

export function pushInbound(opts: {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  body: string;
}) {
  mockStore().inbox.push({
    ...opts,
    to: "connectaurumbespoke@gmail.com",
    receivedAt: new Date().toISOString(),
  });
}

export { db, sql, mockStore };
