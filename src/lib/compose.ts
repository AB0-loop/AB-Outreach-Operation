import { db } from "@/db";
import { evidenceClaims, type Prospect, type Settings } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { aiComplete, AiUnavailableError, redactForAi, safeJson } from "./providers/ai";
import {
  OPT_OUT_SENTENCE,
  validateDraft,
  type EvidenceRef,
  type ValidationReport,
} from "./validate";
import { reviewQuality, type QualityReport } from "./quality";
import { log } from "./log";

export { safeJson };

export type ComposedDraft = {
  subject: string;
  body: string;
  personalizationSentence: string | null;
  hook: string | null;
  claimIds: number[];
  generator: "ai" | "template";
  provider: "grok" | "gemini" | "template";
  validation: ValidationReport;
  quality: QualityReport;
  evidence: EvidenceRef[];
  attempts: number;
  /** True only when validation passed AND quality cleared the threshold. */
  sendable: boolean;
  blockedReason: string | null;
};

export async function loadEvidence(prospectId: number): Promise<EvidenceRef[]> {
  const rows = await db
    .select()
    .from(evidenceClaims)
    .where(and(eq(evidenceClaims.prospectId, prospectId), eq(evidenceClaims.verified, true)))
    .orderBy(desc(evidenceClaims.retrievedAt));
  return rows.map((r) => ({
    id: r.id,
    claimText: r.claimText,
    sourceUrl: r.sourceUrl,
    excerpt: r.excerpt,
    verified: r.verified,
    retrievedAt: r.retrievedAt,
  }));
}

/* ------------------------------------------------------------------ */
/* Deterministic brand copy                                            */
/* ------------------------------------------------------------------ */

function serviceLine(p: Prospect): string {
  return p.segment === "event_planner"
    ? "Aurum Bespoke is a bespoke tailoring house in Bengaluru. We make made-to-measure suits, sherwanis and formalwear for grooms and wedding parties, with fittings scheduled around the client and a firm delivery date before the event."
    : "Aurum Bespoke is a bespoke tailoring house in Bengaluru. We make made-to-measure suits, jackets and shirts, cut to individual measurements, with fittings arranged around your schedule.";
}

function relevanceLine(p: Prospect): string {
  const role = [p.role, p.company].filter(Boolean).join(" at ");
  if (p.segment === "event_planner") {
    return role
      ? `Your work ${role} regularly involves clients whose formalwear is decided late, which is usually where a tailor is most useful to a planner.`
      : `Planners in Bengaluru regularly meet clients whose formalwear is decided late, which is usually where a tailor is most useful.`;
  }
  return role
    ? `Your work ${role} is the kind of client-facing role where well-cut formalwear tends to earn its keep.`
    : `Senior, client-facing work in Bengaluru is where well-cut formalwear tends to earn its keep.`;
}

function closingLine(p: Prospect, isFollowup: boolean): string {
  if (isFollowup)
    return "If a fitting would be useful at some point, a reply to this note is enough and I will arrange it.";
  return p.segment === "event_planner"
    ? "If it would help to have a tailor you can call on for a client, I am happy to arrange an introduction at your convenience."
    : "If that is of interest, I would be glad to arrange a fitting appointment at your convenience.";
}

export function renderBody(opts: {
  settings: Settings;
  prospect: Prospect;
  openingSentence: string | null;
  isFollowup: boolean;
}): string {
  const { settings: s, prospect: p } = opts;
  const first = p.fullName.trim().split(/\s+/)[0];

  const opening = opts.isFollowup
    ? `I wrote to you last week about bespoke tailoring from ${s.senderName}. I will not write again after this note, but I did not want to leave it unfinished.`
    : opts.openingSentence
      ? `${opts.openingSentence.trim()} ${relevanceLine(p)}`
      : relevanceLine(p);

  return [
    `Dear ${first},`,
    "",
    opening,
    "",
    serviceLine(p),
    "",
    closingLine(p, opts.isFollowup),
    "",
    OPT_OUT_SENTENCE,
    "",
    "With regards,",
    s.senderName,
    s.businessWebsite,
    `Phone: ${s.businessPhone ?? ""}`,
    s.businessAddress ?? "Bengaluru, Karnataka, India",
  ].join("\n");
}

function subjectFor(p: Prospect, isFollowup: boolean): string {
  if (isFollowup) return "A brief follow-up from Aurum Bespoke";
  return p.segment === "event_planner"
    ? "Bespoke formalwear for your Bengaluru clients"
    : "Made-to-measure tailoring in Bengaluru";
}

type AiDraft = { subject?: string; opening_line?: string; hook_summary?: string };

const SYSTEM_PROMPT =
  "You write the opening sentence of a letter from Aurum Bespoke, a bespoke tailoring house in Bengaluru, to a senior professional. " +
  "HARD RULES: Use ONLY the facts in CLAIM and CLAIM_EXCERPT. Never add dates, numbers, awards, achievements, client names, " +
  "affiliations or opinions that are not stated there. No flattery, no compliments, no hype, no urgency, no questions. " +
  "Write one measured, discreet sentence of at most 28 words that shows you know the recipient's actual professional context. " +
  'Respond with JSON only: {"subject": string, "opening_line": string, "hook_summary": string}. Subject must be plain, truthful and under 9 words.';

/**
 * Builds a message.
 *
 * The AI contributes only a personalised opening sentence plus a subject
 * suggestion. Every mandatory element (service description, website, verified
 * phone, opt-out, signature) is rendered deterministically and cannot be
 * altered by a model.
 *
 * The draft must clear BOTH validation and the quality threshold. If the AI
 * opener fails either, the system retries once, then falls back to the neutral
 * template — a prospect with weak evidence never receives an invented hook.
 */
export async function composeMessage(opts: {
  prospect: Prospect;
  settings: Settings;
  isFollowup: boolean;
}): Promise<ComposedDraft> {
  const { prospect: p, settings: s, isFollowup } = opts;
  const evidence = await loadEvidence(p.id);
  const bestClaim = evidence[0];
  const firstName = p.fullName.trim().split(/\s+/)[0];

  const buildNeutral = async (attempts: number, note: string | null): Promise<ComposedDraft> => {
    const subject = subjectFor(p, isFollowup);
    const body = renderBody({ settings: s, prospect: p, openingSentence: null, isFollowup });
    const validation = validateDraft(
      { subject, body, personalizationSentence: null, claimIds: [], recipientEmail: p.email },
      s,
      [],
    );
    const quality = await reviewQuality({
      subject,
      body,
      recipientFirstName: firstName,
      company: p.company,
      hook: null,
      evidence: [],
      isFollowup,
      settings: s,
      validation,
    });
    const sendable = validation.passed && quality.score >= s.minQualityScore;
    return {
      subject,
      body,
      personalizationSentence: null,
      hook: null,
      claimIds: [],
      generator: "template",
      provider: "template",
      validation,
      quality,
      evidence,
      attempts,
      sendable,
      blockedReason: sendable
        ? null
        : [
            ...validation.issues.map((i) => i.code),
            ...(quality.score < s.minQualityScore ? [`QUALITY_${quality.score}_BELOW_${s.minQualityScore}`] : []),
            ...(note ? [note] : []),
          ].join(","),
    };
  };

  // Follow-ups and evidence-free prospects always use the neutral template.
  if (isFollowup || !bestClaim) return buildNeutral(0, null);

  const maxAttempts = 2; // one regeneration before falling back
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let ai;
    try {
      ai = await aiComplete({
        task: "draft_email",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: redactForAi(
              [
                `NAME: ${p.fullName}`,
                `ROLE: ${p.role ?? "not recorded"}`,
                `COMPANY: ${p.company ?? "not recorded"}`,
                `SEGMENT: ${p.segment}`,
                `CLAIM: ${bestClaim.claimText}`,
                `CLAIM_EXCERPT: ${bestClaim.excerpt}`,
                attempt > 1
                  ? "NOTE: The previous attempt was rejected for unsupported content or off-brand tone. Be stricter and plainer."
                  : "",
              ]
                .filter(Boolean)
                .join("\n"),
            ),
          },
        ],
      });
    } catch (e) {
      if (!(e instanceof AiUnavailableError)) throw e;
      // Providers exhausted. Use the deterministic approved template, which
      // must independently pass every rule. No generic copy is invented.
      log.warn("compose_ai_unavailable_neutral_fallback", { prospectId: p.id });
      return buildNeutral(attempt, "AI_UNAVAILABLE_NEUTRAL_TEMPLATE");
    }

    const parsed = safeJson<AiDraft>(ai.content);
    const opening = parsed?.opening_line?.trim();
    if (!opening) continue;

    const subject =
      parsed?.subject && parsed.subject.trim().length <= 70
        ? parsed.subject.trim()
        : subjectFor(p, isFollowup);
    const body = renderBody({ settings: s, prospect: p, openingSentence: opening, isFollowup });
    const usedEvidence = evidence.filter((e) => e.id === bestClaim.id);

    const validation = validateDraft(
      {
        subject,
        body,
        personalizationSentence: opening,
        claimIds: [bestClaim.id],
        recipientEmail: p.email,
      },
      s,
      usedEvidence,
    );
    const quality = await reviewQuality({
      subject,
      body,
      recipientFirstName: firstName,
      company: p.company,
      hook: opening,
      evidence: usedEvidence,
      isFollowup,
      settings: s,
      validation,
    });

    if (validation.passed && quality.score >= s.minQualityScore) {
      return {
        subject,
        body,
        personalizationSentence: opening,
        hook: parsed?.hook_summary?.slice(0, 240) ?? bestClaim.claimText.slice(0, 240),
        claimIds: [bestClaim.id],
        generator: "ai",
        provider: ai.provider,
        validation,
        quality,
        evidence,
        attempts: attempt,
        sendable: true,
        blockedReason: null,
      };
    }
    log.info("compose_draft_rejected", {
      prospectId: p.id,
      attempt,
      quality: quality.score,
      issues: validation.issues.map((i) => i.code),
    });
  }

  // Regeneration did not help — neutral template, never a forced send.
  return buildNeutral(maxAttempts, "AI_DRAFT_REJECTED_FELL_BACK_TO_TEMPLATE");
}
