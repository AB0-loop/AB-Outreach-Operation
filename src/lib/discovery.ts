import dns from "node:dns/promises";
import { db } from "@/db";
import { discoverySources, evidenceClaims, prospects } from "@/db/schema";
import { eq } from "drizzle-orm";
import { normalizeEmail, findSuppression } from "./suppression";
import { normalizePhone } from "./settings";
import { errorMessage, log } from "./log";
import { audit } from "./audit";
import { env } from "./env";
import { scoreLead } from "./quality";

export type ProspectInput = {
  fullName: string;
  role?: string;
  company?: string;
  segment?: "professional" | "event_planner";
  category?: string;
  email: string;
  emailSourceUrl: string;
  phone?: string;
  phoneType?: "public_business" | "unverified";
  phoneSourceUrl?: string;
  website?: string;
  sourceUrl: string;
  sourceName?: string;
  linkedinUrl?: string;
  bengaluruEvidenceUrl?: string;
  qualificationReason: string;
  claims?: { claimText: string; sourceUrl: string; excerpt: string }[];
};

const EMAIL_RE = /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/;
const ROLE_RELEVANCE =
  /(founder|co-?founder|ceo|cto|coo|cfo|managing director|director|partner|proprietor|owner|principal|advocate|lawyer|attorney|chartered accountant|\bca\b|consultant|head of|vice president|\bvp\b|president|senior manager|general manager|wedding planner|event planner|event manager|wedding)/i;

export type IngestResult = {
  created: number;
  duplicates: number;
  rejected: { email: string; reason: string }[];
};

/** MX lookup proves the domain can receive mail. It does NOT prove the mailbox
 *  exists — the status stays "source_verified", never "confirmed". */
async function domainAcceptsMail(email: string): Promise<boolean> {
  if (env.mockMode) return !email.endsWith("@invalid.test");
  const domain = email.split("@")[1];
  try {
    const mx = await dns.resolveMx(domain);
    return mx.length > 0;
  } catch {
    return false;
  }
}

export async function ingestProspects(
  inputs: ProspectInput[],
  actor = "system",
): Promise<IngestResult> {
  const result: IngestResult = { created: 0, duplicates: 0, rejected: [] };

  for (const input of inputs) {
    const email = normalizeEmail(input.email ?? "");
    const reject = (reason: string) => result.rejected.push({ email, reason });

    if (!EMAIL_RE.test(email)) {
      reject("Malformed email address");
      continue;
    }
    if (!input.fullName?.trim()) {
      reject("Missing verified person name");
      continue;
    }
    if (!input.emailSourceUrl?.startsWith("https://")) {
      reject("Email has no public https source URL");
      continue;
    }
    if (!input.sourceUrl?.startsWith("https://")) {
      reject("Missing https source URL for the prospect record");
      continue;
    }
    if (!input.qualificationReason?.trim()) {
      reject("Missing qualification reason");
      continue;
    }
    const roleBlob = `${input.role ?? ""} ${input.category ?? ""} ${input.company ?? ""}`;
    if (!ROLE_RELEVANCE.test(roleBlob)) {
      reject("Role is not a relevant decision-maker / planner category");
      continue;
    }
    try {
      if (await findSuppression(email)) {
        reject("Address is on the global suppression list");
        continue;
      }
    } catch {
      reject("Suppression list unavailable — ingestion refused");
      continue;
    }

    const existing = await db
      .select({ id: prospects.id })
      .from(prospects)
      .where(eq(prospects.emailNormalized, email))
      .limit(1);
    if (existing.length > 0) {
      result.duplicates += 1;
      continue;
    }

    const mxOk = await domainAcceptsMail(email);

    // Claims are verified against their own excerpt before scoring, so the
    // score reflects real evidence rather than operator assertion.
    const candidateClaims = (input.claims ?? []).filter(
      (c) => c.sourceUrl?.startsWith("https://") && c.excerpt?.trim(),
    );
    const verifiedClaims = candidateClaims.filter((c) =>
      claimSupportedByExcerpt(c.claimText, c.excerpt),
    );
    const scored = scoreLead({
      role: input.role ?? null,
      company: input.company ?? null,
      city: "Bengaluru",
      segment: input.segment ?? "professional",
      website: input.website ?? null,
      emailStatus: mxOk ? "source_verified" : "invalid",
      emailSourceUrl: input.emailSourceUrl,
      bengaluruEvidenceUrl: input.bengaluruEvidenceUrl ?? input.sourceUrl,
      claimCount: candidateClaims.length,
      verifiedClaimCount: verifiedClaims.length,
    });

    const [created] = await db
      .insert(prospects)
      .values({
        leadScore: scored.score,
        leadScoreReason: scored.reason,
        verificationConfidence: scored.confidence,
        linkedinUrl: input.linkedinUrl ?? null,
        fullName: input.fullName.trim(),
        role: input.role ?? null,
        company: input.company ?? null,
        segment: input.segment ?? "professional",
        category: input.category ?? null,
        email,
        emailNormalized: email,
        emailStatus: mxOk ? "source_verified" : "invalid",
        emailSourceUrl: input.emailSourceUrl,
        emailVerifiedAt: mxOk ? new Date() : null,
        emailVerificationMethod: mxOk
          ? "public source URL + domain MX record (mailbox existence not asserted)"
          : "domain has no MX record",
        phone: input.phone ? normalizePhone(input.phone) : null,
        phoneType: input.phone ? (input.phoneType ?? "unverified") : null,
        phoneSourceUrl: input.phoneSourceUrl ?? null,
        phoneVerified: input.phoneType === "public_business",
        website: input.website ?? null,
        sourceUrl: input.sourceUrl,
        sourceName: input.sourceName ?? "manual_import",
        bengaluruEvidenceUrl: input.bengaluruEvidenceUrl ?? input.sourceUrl,
        qualificationReason: input.qualificationReason,
        status: "DISCOVERED",
        lastVerifiedAt: new Date(),
      })
      .onConflictDoNothing({ target: prospects.emailNormalized })
      .returning({ id: prospects.id });

    if (!created) {
      result.duplicates += 1;
      continue;
    }

    for (const claim of input.claims ?? []) {
      if (!claim.sourceUrl?.startsWith("https://")) continue;
      if (!claim.excerpt?.trim()) continue;
      // A claim is verified only when its own excerpt actually contains the
      // claim's distinctive words — never trust an operator-supplied flag.
      const verified = claimSupportedByExcerpt(claim.claimText, claim.excerpt);
      await db.insert(evidenceClaims).values({
        prospectId: created.id,
        claimText: claim.claimText.trim(),
        sourceUrl: claim.sourceUrl,
        excerpt: claim.excerpt.trim().slice(0, 1200),
        verified,
        verificationMethod: verified
          ? "excerpt contains claim terms"
          : "excerpt does not support claim",
      });
    }

    result.created += 1;
  }

  await audit({
    actor,
    action: "prospects.ingest",
    detail: {
      created: result.created,
      duplicates: result.duplicates,
      rejected: result.rejected.length,
    },
  });
  return result;
}

const STOPWORDS = new Set([
  "the","a","an","and","or","of","to","in","at","on","for","with","is","are",
  "was","were","be","been","as","it","its","from","by","that","this","their",
]);

export function claimSupportedByExcerpt(claim: string, excerpt: string): boolean {
  const ex = excerpt.toLowerCase();
  const terms = claim
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 3 && !STOPWORDS.has(t));
  if (terms.length === 0) return false;
  const hits = terms.filter((t) => ex.includes(t)).length;
  return hits / terms.length >= 0.8;
}

/* ------------------------------------------------------------------ */
/* Public source fetching (robots-respecting, no CAPTCHA circumvention)*/
/* ------------------------------------------------------------------ */

const UA = "AurumBespokeOutreachBot/1.0 (+https://aurumbespoke.com; contact via website)";

export async function robotsAllows(targetUrl: string): Promise<boolean> {
  try {
    const u = new URL(targetUrl);
    const res = await fetch(`${u.origin}/robots.txt`, {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return res.status === 404; // no robots.txt => allowed
    const txt = await res.text();
    const lines = txt.split(/\r?\n/).map((l) => l.trim());
    let applies = false;
    const disallows: string[] = [];
    for (const line of lines) {
      const [rawKey, ...rest] = line.split(":");
      const key = rawKey.trim().toLowerCase();
      const value = rest.join(":").trim();
      if (key === "user-agent") applies = value === "*" || UA.toLowerCase().includes(value.toLowerCase());
      else if (applies && key === "disallow" && value) disallows.push(value);
    }
    return !disallows.some((d) => u.pathname.startsWith(d));
  } catch {
    return false; // fail closed
  }
}

/**
 * Fetches one operator-configured public directory page and returns candidate
 * records. Never bypasses logins, CAPTCHAs or anti-bot protections: a non-200
 * or a robots disallow simply yields nothing.
 */
export async function fetchPublicSource(sourceId: number): Promise<ProspectInput[]> {
  const [src] = await db
    .select()
    .from(discoverySources)
    .where(eq(discoverySources.id, sourceId))
    .limit(1);
  if (!src || !src.enabled) return [];

  const mark = (status: string) =>
    db
      .update(discoverySources)
      .set({ lastFetchedAt: new Date(), lastStatus: status })
      .where(eq(discoverySources.id, sourceId));

  if (!(await robotsAllows(src.url))) {
    await mark("blocked_by_robots");
    return [];
  }

  try {
    const res = await fetch(src.url, {
      headers: { "user-agent": UA, accept: "text/html" },
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 403 || res.status === 401 || res.status === 429) {
      await mark(`access_restricted_${res.status}`);
      return [];
    }
    if (!res.ok) {
      await mark(`http_${res.status}`);
      return [];
    }
    const html = await res.text();
    if (/captcha|cf-challenge|are you a robot/i.test(html)) {
      await mark("anti_bot_detected");
      return [];
    }

    const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
    const emails = new Set<string>();
    for (const m of text.matchAll(/mailto:([^"'?>\s]+@[^"'?>\s]+)/gi))
      emails.add(normalizeEmail(m[1]));

    const out: ProspectInput[] = [];
    for (const email of emails) {
      if (!EMAIL_RE.test(email)) continue;
      const idx = text.indexOf(email);
      const context = text
        .slice(Math.max(0, idx - 400), idx + 200)
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const nameMatch = /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/.exec(context);
      if (!nameMatch) continue;
      out.push({
        fullName: nameMatch[1],
        role: (ROLE_RELEVANCE.exec(context) ?? [])[0],
        segment: src.segment === "event_planner" ? "event_planner" : "professional",
        email,
        emailSourceUrl: src.url,
        sourceUrl: src.url,
        sourceName: src.name,
        bengaluruEvidenceUrl: /bengaluru|bangalore/i.test(context) ? src.url : undefined,
        qualificationReason: `Listed publicly on ${src.name} as ${(ROLE_RELEVANCE.exec(context) ?? ["a relevant professional"])[0]}`,
        claims: [
          {
            claimText: `${nameMatch[1]} is listed on ${src.name}`,
            sourceUrl: src.url,
            excerpt: context.slice(0, 600),
          },
        ],
      });
    }
    await mark(`ok_${out.length}_candidates`);
    return out;
  } catch (e) {
    log.warn("discovery_fetch_failed", { sourceId, error: errorMessage(e) });
    await mark("fetch_error");
    return [];
  }
}
