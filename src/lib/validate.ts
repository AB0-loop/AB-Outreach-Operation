import type { Settings } from "@/db/schema";

export type ValidationIssue = { code: string; detail: string };
export type ValidationReport = {
  passed: boolean;
  issues: ValidationIssue[];
  checkedAt: string;
};

export type EvidenceRef = {
  id: number;
  claimText: string;
  sourceUrl: string;
  excerpt: string;
  verified: boolean;
  retrievedAt: Date;
};

export type DraftToValidate = {
  subject: string;
  body: string;
  personalizationSentence: string | null;
  claimIds: number[];
  recipientEmail: string;
};

export const OPT_OUT_SENTENCE =
  'If you would prefer no further emails, reply with "UNSUBSCRIBE" and I will remove you immediately.';

/** Phrases that assert a fact about the recipient and therefore need evidence. */
const FABRICATION_PATTERNS: { re: RegExp; code: string }[] = [
  { re: /\b(congratulations|congrats)\b/i, code: "UNVERIFIABLE_CONGRATULATION" },
  { re: /\bI (saw|noticed|read) (your|that you)\b/i, code: "UNSOURCED_OBSERVATION" },
  { re: /\b(referred by|recommended by|introduced by)\b/i, code: "FAKE_REFERRAL" },
  { re: /\b(we spoke|as discussed|following (up on )?our (call|conversation|chat))\b/i, code: "FAKE_PRIOR_CONTACT" },
  { re: /\b(our client[s]?|clients like|trusted by)\b/i, code: "UNVERIFIED_CLIENT_CLAIM" },
  { re: /\b(award[- ]winning|#1|india'?s (best|leading)|world[- ]class)\b/i, code: "UNSUPPORTED_SUPERLATIVE" },
  { re: /\b(guarantee[d]?|100%|risk[- ]free)\b/i, code: "UNSUPPORTED_GUARANTEE" },
  { re: /\b(only \d+ (slots?|spots?|seats?)|limited time|offer expires|act now|last chance)\b/i, code: "FALSE_URGENCY" },
  { re: /\b(₹|rs\.?|inr)\s?\d/i, code: "UNAPPROVED_PRICE_CLAIM" },
];

const DECEPTIVE_SUBJECT = /^(re|fw|fwd)\s*:/i;
const PLACEHOLDER = /(\{\{[^}]*\}\}|\{[A-Z_]{2,}\}|\[\s*(name|company|phone|website|placeholder|todo|insert)[^\]]*\]|XXX+|TBD)/i;

export const MAX_SUBJECT_LENGTH = 90;
export const MAX_BODY_LENGTH = 1500;

function allowedHosts(settings: Settings, evidence: EvidenceRef[]): Set<string> {
  const hosts = new Set<string>();
  try {
    hosts.add(new URL(settings.businessWebsite).hostname.replace(/^www\./, ""));
  } catch {
    /* validated separately */
  }
  for (const e of evidence) {
    try {
      hosts.add(new URL(e.sourceUrl).hostname.replace(/^www\./, ""));
    } catch {
      /* ignore malformed evidence url, flagged separately */
    }
  }
  return hosts;
}

function tokensOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9₹\s.'-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

const COMMON_WORDS = new Set([
  "i","you","your","the","a","an","and","or","of","to","in","at","on","for","with",
  "that","this","is","are","was","were","be","been","as","it","its","from","by",
  "noted","note","see","saw","public","profile","work","works","working","based",
  "team","role","who","which","their","they","we","our","us","me","my","have","has",
  "also","about","into","over","under","after","before","than","then","so","if",
]);

/**
 * Every distinctive token in the personalization sentence must appear in the
 * supporting evidence excerpt/claim. This blocks hallucinated specifics
 * (awards, dates, client names, numbers) even when the AI cites a real claim.
 */
export function personalizationIsGrounded(
  sentence: string,
  evidence: EvidenceRef[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!sentence.trim()) return issues;
  if (evidence.length === 0) {
    issues.push({
      code: "NO_EVIDENCE",
      detail: "Personalized sentence present but no verified evidence is linked",
    });
    return issues;
  }
  const haystack = tokensOf(
    evidence.map((e) => `${e.claimText} ${e.excerpt}`).join(" "),
  );
  const haySet = new Set(haystack);
  const unsupported = tokensOf(sentence).filter(
    (t) => t.length > 3 && !COMMON_WORDS.has(t) && !haySet.has(t),
  );
  if (unsupported.length > 0) {
    issues.push({
      code: "UNSUPPORTED_CLAIM_TOKENS",
      detail: `Not traceable to evidence: ${unsupported.slice(0, 8).join(", ")}`,
    });
  }
  return issues;
}

export function validateDraft(
  draft: DraftToValidate,
  settings: Settings,
  evidence: EvidenceRef[],
): ValidationReport {
  const issues: ValidationIssue[] = [];
  const subject = draft.subject.trim();
  const body = draft.body;
  const push = (code: string, detail: string) => issues.push({ code, detail });

  /* --- Subject --- */
  if (!subject) push("MISSING_SUBJECT", "Subject is empty");
  if (subject.length > MAX_SUBJECT_LENGTH)
    push("SUBJECT_TOO_LONG", `Subject exceeds ${MAX_SUBJECT_LENGTH} characters`);
  if (DECEPTIVE_SUBJECT.test(subject))
    push("DECEPTIVE_SUBJECT", "Subject uses a fake reply/forward prefix");
  if (/[A-Z]{6,}/.test(subject))
    push("SHOUTING_SUBJECT", "Subject contains shouting capitals");

  /* --- Mandatory content (section 9) --- */
  if (!body.includes(settings.senderName))
    push("MISSING_SENDER_IDENTITY", "Body does not identify Aurum Bespoke");
  if (!settings.businessWebsite || !body.includes(settings.businessWebsite))
    push("MISSING_WEBSITE", "Body does not contain the Aurum Bespoke website");
  if (!settings.businessPhone || !settings.businessPhoneVerified)
    push("MISSING_BUSINESS_PHONE", "Verified business phone number is not configured");
  else if (!body.includes(settings.businessPhone))
    push("MISSING_PHONE_IN_BODY", "Body does not contain the verified business phone");
  if (!/unsubscribe/i.test(body))
    push("MISSING_OPT_OUT", "Body does not contain a clear opt-out instruction");
  if (!/—\s*$|Aurum Bespoke\s*\n/m.test(body) && !body.trimEnd().includes(settings.senderName))
    push("MISSING_SIGNATURE", "Body does not contain a signature");

  /* --- Hygiene --- */
  if (PLACEHOLDER.test(body) || PLACEHOLDER.test(subject))
    push("UNRESOLVED_PLACEHOLDER", "Unresolved template placeholder detected");
  if (body.length > MAX_BODY_LENGTH)
    push("BODY_TOO_LONG", `Body exceeds ${MAX_BODY_LENGTH} characters`);
  if (body.trim().length < 150)
    push("BODY_TOO_SHORT", "Body is too short to explain the outreach purpose");
  if (!draft.recipientEmail.includes("@"))
    push("INVALID_RECIPIENT", "Recipient email is malformed");

  /* --- Link integrity --- */
  const hosts = allowedHosts(settings, evidence);
  const urls = body.match(/https?:\/\/[^\s<>)"']+/g) ?? [];
  for (const u of urls) {
    try {
      const host = new URL(u).hostname.replace(/^www\./, "");
      if (!hosts.has(host))
        push("DISALLOWED_LINK", `Link host not allowed: ${host}`);
      if (new URL(u).protocol !== "https:")
        push("INSECURE_LINK", `Non-HTTPS link: ${u}`);
    } catch {
      push("BROKEN_LINK", `Malformed URL: ${u.slice(0, 60)}`);
    }
  }
  if (/\[.+?\]\(https?:\/\//.test(body))
    push("HIDDEN_LINK", "Markdown-style hidden link detected in a plain-text email");

  /* --- Fabrication guards --- */
  const groundedText = (draft.personalizationSentence ?? "").toLowerCase();
  for (const { re, code } of FABRICATION_PATTERNS) {
    const m = re.exec(body);
    if (!m) continue;
    const insidePersonalization = groundedText.includes(m[0].toLowerCase());
    const supported =
      insidePersonalization &&
      evidence.some((e) =>
        `${e.claimText} ${e.excerpt}`.toLowerCase().includes(m[0].toLowerCase()),
      );
    if (!supported) push(code, `Unsupported phrase: "${m[0]}"`);
  }

  /* --- Evidence binding --- */
  if (draft.personalizationSentence) {
    if (draft.claimIds.length === 0)
      push("NO_CLAIM_REFERENCE", "Personalized sentence is not linked to any claim");
    const evidenceIds = new Set(evidence.map((e) => e.id));
    for (const id of draft.claimIds) {
      if (!evidenceIds.has(id))
        push("UNKNOWN_CLAIM", `Claim ${id} does not belong to this prospect`);
    }
    for (const e of evidence) {
      if (!e.verified) push("UNVERIFIED_CLAIM", `Claim ${e.id} is not verified`);
      if (!/^https:\/\//.test(e.sourceUrl))
        push("INVALID_EVIDENCE_URL", `Claim ${e.id} has no valid https source URL`);
      const ageDays =
        (Date.now() - new Date(e.retrievedAt).getTime()) / 86_400_000;
      if (ageDays > settings.evidenceMaxAgeDays)
        push("STALE_EVIDENCE", `Claim ${e.id} evidence is ${Math.round(ageDays)} days old`);
    }
    issues.push(
      ...personalizationIsGrounded(draft.personalizationSentence, evidence),
    );
    if (!body.includes(draft.personalizationSentence.trim()))
      push("PERSONALIZATION_MISMATCH", "Declared personalization sentence is not in the body");
  }

  return {
    passed: issues.length === 0,
    issues,
    checkedAt: new Date().toISOString(),
  };
}
