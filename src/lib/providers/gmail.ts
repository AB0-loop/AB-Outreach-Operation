import { db } from "@/db";
import { oauthAccounts } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { env } from "../env";
import { decryptSecret, encryptSecret } from "../crypto";
import { errorMessage, log } from "../log";
import { mockStore, nextMockId, type MockInboundEmail } from "./mock";

/** Least-privilege scopes: send outbound, read replies. No modify/delete. */
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export class GmailNotAuthorizedError extends Error {}
export class GmailUncertainSendError extends Error {}

export function authUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.googleClientId ?? "",
    redirect_uri: env.googleRedirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function getAccount() {
  const rows = await db
    .select()
    .from(oauthAccounts)
    .where(eq(oauthAccounts.provider, "gmail"))
    .limit(1);
  return rows[0] ?? null;
}

export async function exchangeCode(code: string) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.googleClientId ?? "",
      client_secret: env.googleClientSecret ?? "",
      redirect_uri: env.googleRedirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
  };

  const profile = await fetch(
    "https://www.googleapis.com/oauth2/v2/userinfo",
    { headers: { authorization: `Bearer ${json.access_token}` } },
  );
  const email = ((await profile.json()) as { email?: string }).email ?? "unknown";

  const values = {
    provider: "gmail",
    email,
    accessTokenEnc: encryptSecret(json.access_token),
    refreshTokenEnc: json.refresh_token ? encryptSecret(json.refresh_token) : null,
    accessTokenExpiresAt: new Date(Date.now() + (json.expires_in - 60) * 1000),
    scopes: json.scope,
    authorized: true,
    updatedAt: new Date(),
  };

  await db
    .insert(oauthAccounts)
    .values(values)
    .onConflictDoUpdate({
      target: [oauthAccounts.provider, oauthAccounts.email],
      set: {
        accessTokenEnc: values.accessTokenEnc,
        ...(values.refreshTokenEnc ? { refreshTokenEnc: values.refreshTokenEnc } : {}),
        accessTokenExpiresAt: values.accessTokenExpiresAt,
        scopes: values.scopes,
        authorized: true,
        updatedAt: new Date(),
      },
    });
  return email;
}

async function accessToken(): Promise<string> {
  const acct = await getAccount();
  if (!acct || !acct.authorized)
    throw new GmailNotAuthorizedError("Gmail account is not authorized");

  if (
    acct.accessTokenEnc &&
    acct.accessTokenExpiresAt &&
    acct.accessTokenExpiresAt.getTime() > Date.now()
  ) {
    return decryptSecret(acct.accessTokenEnc);
  }
  if (!acct.refreshTokenEnc)
    throw new GmailNotAuthorizedError("No refresh token stored; re-authorize");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.googleClientId ?? "",
      client_secret: env.googleClientSecret ?? "",
      refresh_token: decryptSecret(acct.refreshTokenEnc),
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new GmailNotAuthorizedError(`Token refresh failed (${res.status})`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  await db
    .update(oauthAccounts)
    .set({
      accessTokenEnc: encryptSecret(json.access_token),
      accessTokenExpiresAt: new Date(Date.now() + (json.expires_in - 60) * 1000),
      updatedAt: new Date(),
    })
    .where(eq(oauthAccounts.id, acct.id));
  return json.access_token;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await accessToken();
  const res = await fetch(`${GMAIL_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gmail API ${path} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

function buildRaw(opts: {
  from: string;
  fromName: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
}) {
  const headers = [
    `From: ${opts.fromName} <${opts.from}>`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
  ];
  if (opts.inReplyTo) {
    headers.push(`In-Reply-To: ${opts.inReplyTo}`, `References: ${opts.inReplyTo}`);
  }
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${opts.body}`, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export type SendResult = { gmailMessageId: string; gmailThreadId: string };

export async function sendEmail(opts: {
  from: string;
  fromName: string;
  to: string;
  subject: string;
  body: string;
  threadId?: string | null;
  inReplyTo?: string | null;
}): Promise<SendResult> {
  if (env.mockMode) {
    const store = mockStore();
    if (store.failGmailSend)
      throw new GmailUncertainSendError("mock gmail send failure");
    const id = nextMockId("msg");
    const threadId = opts.threadId ?? nextMockId("thr");
    store.sent.push({
      id,
      threadId,
      to: opts.to,
      subject: opts.subject,
      body: opts.body,
      sentAt: new Date().toISOString(),
    });
    return { gmailMessageId: id, gmailThreadId: threadId };
  }

  const raw = buildRaw({
    from: opts.from,
    fromName: opts.fromName,
    to: opts.to,
    subject: opts.subject,
    body: opts.body,
    inReplyTo: opts.inReplyTo ?? undefined,
  });
  const res = await api<{ id: string; threadId: string }>("/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw, ...(opts.threadId ? { threadId: opts.threadId } : {}) }),
  });
  return { gmailMessageId: res.id, gmailThreadId: res.threadId };
}

/**
 * Reconciliation safety net: confirms whether a message with the given
 * idempotency marker already exists in the Sent mailbox. Used before any
 * retry of an uncertain send.
 */
export async function findSentTo(to: string, subject: string): Promise<SendResult | null> {
  if (env.mockMode) {
    const hit = mockStore().sent.find((m) => m.to === to && m.subject === subject);
    return hit ? { gmailMessageId: hit.id, gmailThreadId: hit.threadId } : null;
  }
  const q = encodeURIComponent(`in:sent to:${to} subject:"${subject.replace(/"/g, "")}"`);
  const res = await api<{ messages?: { id: string; threadId: string }[] }>(
    `/messages?q=${q}&maxResults=1`,
  );
  const m = res.messages?.[0];
  return m ? { gmailMessageId: m.id, gmailThreadId: m.threadId } : null;
}

export type InboundMessage = {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  receivedAt: Date;
  labelIds: string[];
};

type GmailPart = {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
};

function extractBody(payload: GmailPart | undefined): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf8");
  }
  for (const p of payload.parts ?? []) {
    const found = extractBody(p);
    if (found) return found;
  }
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url")
      .toString("utf8")
      .replace(/<[^>]+>/g, " ");
  }
  return "";
}

function toInbound(m: {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: { headers?: { name: string; value: string }[] } & GmailPart;
}): InboundMessage {
  const headers = Object.fromEntries(
    (m.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]),
  );
  return {
    id: m.id,
    threadId: m.threadId,
    from: headers.from ?? "",
    to: headers.to ?? "",
    subject: headers.subject ?? "",
    body: extractBody(m.payload),
    receivedAt: new Date(Number(m.internalDate ?? Date.now())),
    labelIds: m.labelIds ?? [],
  };
}

/** Fetches unread/recent inbox messages. Durable reconciliation entrypoint. */
export async function listInbound(maxResults = 25): Promise<InboundMessage[]> {
  if (env.mockMode) {
    return mockStore().inbox.map((m: MockInboundEmail) => ({
      id: m.id,
      threadId: m.threadId,
      from: m.from,
      to: m.to,
      subject: m.subject,
      body: m.body,
      receivedAt: new Date(m.receivedAt),
      labelIds: ["INBOX"],
    }));
  }
  const list = await api<{ messages?: { id: string }[] }>(
    `/messages?q=${encodeURIComponent("in:inbox newer_than:14d")}&maxResults=${maxResults}`,
  );
  const out: InboundMessage[] = [];
  for (const m of list.messages ?? []) {
    try {
      const full = await api<Parameters<typeof toInbound>[0]>(
        `/messages/${m.id}?format=full`,
      );
      out.push(toInbound(full));
    } catch (e) {
      log.warn("gmail_fetch_message_failed", { id: m.id, error: errorMessage(e) });
    }
  }
  return out;
}

/** Registers Gmail push notifications. Safe no-op when not configured. */
export async function startWatch(): Promise<{ ok: boolean; detail: string }> {
  if (env.mockMode) return { ok: true, detail: "mock watch" };
  if (!env.gmailPubsubTopic)
    return { ok: false, detail: "GMAIL_PUBSUB_TOPIC not configured; polling fallback in use" };
  try {
    const res = await api<{ historyId: string; expiration: string }>("/watch", {
      method: "POST",
      body: JSON.stringify({ topicName: env.gmailPubsubTopic, labelIds: ["INBOX"] }),
    });
    const acct = await getAccount();
    if (acct) {
      await db
        .update(oauthAccounts)
        .set({
          historyId: res.historyId,
          watchExpiration: new Date(Number(res.expiration)),
          updatedAt: new Date(),
        })
        .where(and(eq(oauthAccounts.id, acct.id)));
    }
    return { ok: true, detail: `watch active until ${new Date(Number(res.expiration)).toISOString()}` };
  } catch (e) {
    return { ok: false, detail: errorMessage(e) };
  }
}

export async function gmailHealth(): Promise<{ ok: boolean; detail: string }> {
  if (env.mockMode) return { ok: true, detail: "mock mode" };
  const acct = await getAccount();
  if (!acct?.authorized) return { ok: false, detail: "not authorized" };
  try {
    const p = await api<{ emailAddress: string }>("/profile");
    return { ok: true, detail: p.emailAddress };
  } catch (e) {
    return { ok: false, detail: errorMessage(e) };
  }
}
