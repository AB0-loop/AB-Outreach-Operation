import type { Settings } from "@/db/schema";
import { aiComplete, AiUnavailableError, redactForAi, safeJson } from "./providers/ai";
import type { EvidenceRef, ValidationReport } from "./validate";

/**
 * Independent quality review of a drafted email.
 *
 * Two layers:
 *  1. Deterministic heuristics (always run, cannot be skipped) — these catch
 *     the "luxury brand voice" failures that validation does not: hype,
 *     flattery, repetition, bulk-template feel, multiple CTAs, name-stuffing.
 *  2. An AI reviewer (advisory only) — it can LOWER the score but can never
 *     raise it above the deterministic ceiling, and its absence never blocks
 *     a structurally sound email.
 */

export type QualityIssue = { code: string; detail: string; penalty: number };
export type QualityReport = {
  score: number;
  deterministicScore: number;
  aiScore: number | null;
  issues: QualityIssue[];
  reviewer: "deterministic" | "deterministic+ai";
  checkedAt: string;
};

const HYPE = /\b(amazing|incredible|unbeatable|revolutionary|game[- ]chang\w+|best[- ]in[- ]class|unparalleled|exquisite beyond|once[- ]in[- ]a[- ]lifetime|elevate your|unlock|supercharge|transform your life)\b/gi;
const FLATTERY = /\b(impressive|remarkable|outstanding|inspiring|admire|huge fan|love what you|incredible work|visionary|trailblaz\w+)\b/gi;
const URGENCY = /\b(act now|limited (time|slots)|hurry|don'?t miss|expires|last chance|today only|while stocks last)\b/gi;
const BULK_TELLS = /\b(i hope this email finds you well|i wanted to reach out|quick question|just checking in|circling back|touching base|per my last email|dear sir\/madam|to whom it may concern)\b/gi;
const CTA = /(\?\s*$|reply to this email|call (us|me)|book a|schedule a|arrange a|let me know|happy to)/gim;

function count(re: RegExp, text: string): number {
  return (text.match(re) ?? []).length;
}

export function deterministicQuality(opts: {
  subject: string;
  body: string;
  recipientFirstName: string;
  hook: string | null;
  evidence: EvidenceRef[];
  isFollowup: boolean;
}): { score: number; issues: QualityIssue[] } {
  const issues: QualityIssue[] = [];
  const { body, subject } = opts;
  const add = (code: string, detail: string, penalty: number) =>
    issues.push({ code, detail, penalty });

  const hype = count(HYPE, body);
  if (hype > 0) add("HYPE_LANGUAGE", `${hype} hype phrase(s) — not consistent with a discreet luxury voice`, 20 * hype);

  const flattery = count(FLATTERY, body);
  if (flattery > 0) add("EXCESSIVE_FLATTERY", `${flattery} flattery phrase(s)`, 15 * flattery);

  const urgency = count(URGENCY, body);
  if (urgency > 0) add("MANUFACTURED_URGENCY", `${urgency} urgency phrase(s)`, 30 * urgency);

  const bulk = count(BULK_TELLS, body);
  if (bulk > 0) add("BULK_TEMPLATE_PHRASING", `${bulk} mass-mail cliché(s)`, 18 * bulk);

  // Name stuffing: the first name should appear once, in the greeting.
  const first = opts.recipientFirstName.trim();
  if (first.length > 2) {
    const nameUses = count(new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), body);
    if (nameUses > 1) add("NAME_REPETITION", `Recipient name used ${nameUses} times`, 12 * (nameUses - 1));
  }

  // Exactly one clear, low-pressure call to action.
  const ctas = count(CTA, body);
  if (ctas === 0) add("NO_CALL_TO_ACTION", "No discernible call to action", 15);
  if (ctas > 2) add("MULTIPLE_CTAS", `${ctas} competing calls to action`, 10 * (ctas - 2));

  // Question density — more than two questions reads as an interrogation.
  const questions = count(/\?/g, body);
  if (questions > 2) add("TOO_MANY_QUESTIONS", `${questions} questions`, 8 * (questions - 2));

  // Length discipline.
  const words = body.trim().split(/\s+/).length;
  if (words > 220) add("TOO_LONG", `${words} words — a senior reader will not finish it`, Math.min(25, (words - 220) / 8));
  if (words < 70) add("TOO_THIN", `${words} words — insufficient to establish relevance`, 15);

  // Personalization substance (initial emails only).
  if (!opts.isFollowup) {
    if (!opts.hook) add("NO_PERSONALIZATION_HOOK", "Neutral template used — no verified hook available", 18);
    else if (opts.evidence.length === 0) add("HOOK_WITHOUT_EVIDENCE", "Hook present but no linked evidence", 40);
  }

  // Subject discipline.
  if (subject.trim().split(/\s+/).length > 10) add("SUBJECT_TOO_WORDY", "Subject exceeds 10 words", 8);
  if (/!/.test(subject)) add("SUBJECT_EXCLAMATION", "Exclamation mark in subject", 10);
  if (count(/!/g, body) > 0) add("BODY_EXCLAMATION", "Exclamation marks are off-brand", 8);

  // ALL CAPS shouting.
  if (/\b[A-Z]{5,}\b/.test(body.replace(/UNSUBSCRIBE/g, ""))) add("SHOUTING", "Shouting capitals in body", 10);

  const penalty = issues.reduce((a, i) => a + i.penalty, 0);
  return { score: Math.max(0, Math.round(100 - penalty)), issues };
}

export async function reviewQuality(opts: {
  subject: string;
  body: string;
  recipientFirstName: string;
  company: string | null;
  hook: string | null;
  evidence: EvidenceRef[];
  isFollowup: boolean;
  settings: Settings;
  validation: ValidationReport;
}): Promise<QualityReport> {
  const det = deterministicQuality(opts);
  const issues = [...det.issues];
  let aiScore: number | null = null;
  let reviewer: QualityReport["reviewer"] = "deterministic";

  // Structural failures are already fatal; do not spend AI budget on them.
  if (opts.validation.passed) {
    try {
      const res = await aiComplete({
        task: "quality_review",
        maxOutputTokens: 400,
        messages: [
          {
            role: "system",
            content:
              "You review a B2B email from a bespoke tailor to a senior professional in Bengaluru. " +
              "Score 0-100 for: factual grounding in the supplied EVIDENCE, natural individual writing (not a mail-merge), " +
              "measured luxury tone without hype or flattery, grammatical accuracy, and one clear low-pressure call to action. " +
              "Penalise any claim not present in EVIDENCE. " +
              'Respond with JSON only: {"score": number, "issues": string[], "verdict": "pass"|"fail"}.',
          },
          {
            role: "user",
            content: redactForAi(
              [
                `EVIDENCE: ${opts.evidence.map((e) => e.excerpt).join(" | ") || "(none — neutral template expected)"}`,
                `SUBJECT: ${opts.subject}`,
                `BODY: ${opts.body}`,
              ].join("\n"),
            ),
          },
        ],
      });
      const parsed = safeJson<{ score?: number; issues?: string[]; verdict?: string }>(res.content);
      if (typeof parsed?.score === "number") {
        aiScore = Math.max(0, Math.min(100, Math.round(parsed.score)));
        reviewer = "deterministic+ai";
        for (const i of (parsed.issues ?? []).slice(0, 6))
          issues.push({ code: "AI_REVIEW", detail: String(i).slice(0, 180), penalty: 0 });
      }
    } catch (e) {
      if (!(e instanceof AiUnavailableError)) throw e;
      // Reviewer unavailable: the deterministic score alone decides.
    }
  }

  // The AI may only lower the score, never raise it.
  const score = aiScore === null ? det.score : Math.min(det.score, aiScore);

  return {
    score,
    deterministicScore: det.score,
    aiScore,
    issues,
    reviewer,
    checkedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Lead scoring                                                        */
/* ------------------------------------------------------------------ */

const SENIORITY: { re: RegExp; points: number; label: string }[] = [
  { re: /\b(founder|co-?founder|ceo|managing director|managing partner|proprietor|owner)\b/i, points: 30, label: "owner/founder-level" },
  { re: /\b(cto|coo|cfo|chief|president|vice president|\bvp\b|director)\b/i, points: 25, label: "executive" },
  { re: /\b(partner|principal|advocate|lawyer|attorney|chartered accountant|\bca\b)\b/i, points: 24, label: "senior professional" },
  { re: /\b(wedding planner|event planner|event manager|wedding designer)\b/i, points: 24, label: "event/wedding planner" },
  { re: /\b(consultant|head of|general manager|senior manager)\b/i, points: 18, label: "senior manager" },
];

/**
 * Deterministic 0-100 relevance score. Deliberately not AI-decided: lead
 * suitability drives who gets contacted, so it must be auditable.
 */
export function scoreLead(p: {
  role: string | null;
  company: string | null;
  city: string;
  segment: string;
  website: string | null;
  emailStatus: string;
  emailSourceUrl: string | null;
  bengaluruEvidenceUrl: string | null;
  claimCount: number;
  verifiedClaimCount: number;
}): { score: number; reason: string; confidence: number } {
  const reasons: string[] = [];
  let score = 0;

  const blob = `${p.role ?? ""} ${p.company ?? ""}`;
  const seniority = SENIORITY.find((s) => s.re.test(blob));
  if (seniority) {
    score += seniority.points;
    reasons.push(seniority.label);
  } else {
    reasons.push("no recognised senior role");
  }

  if (/bengaluru|bangalore/i.test(p.city)) {
    score += 20;
    reasons.push("Bengaluru");
  }
  if (p.bengaluruEvidenceUrl) {
    score += 5;
    reasons.push("location evidence");
  }
  if (p.emailStatus === "source_verified") {
    score += 15;
    reasons.push("source-verified email");
  }
  if (p.emailSourceUrl) score += 5;
  if (p.company) score += 5;
  if (p.website) score += 5;
  if (p.verifiedClaimCount > 0) {
    score += 15;
    reasons.push(`${p.verifiedClaimCount} verified claim(s)`);
  } else if (p.claimCount > 0) {
    reasons.push("claims present but unverified");
  } else {
    reasons.push("no personalisation evidence");
  }

  // Verification confidence is a separate axis from commercial relevance.
  let confidence = 0;
  if (p.emailStatus === "source_verified") confidence += 40;
  if (p.emailSourceUrl) confidence += 20;
  if (p.bengaluruEvidenceUrl) confidence += 15;
  if (p.verifiedClaimCount > 0) confidence += 20;
  if (p.role) confidence += 5;

  return {
    score: Math.max(0, Math.min(100, score)),
    reason: reasons.join("; "),
    confidence: Math.min(100, confidence),
  };
}
