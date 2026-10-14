import { db } from "@/db";
import { processedEvents } from "@/db/schema";
import { env } from "@/lib/env";
import { timingSafeEqual, stableKey } from "@/lib/crypto";
import { enqueueJob } from "@/lib/jobs/queue";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * Gmail → Pub/Sub push endpoint.
 * Authenticated with a shared secret in the subscription's push URL query
 * string. Every delivery is deduplicated on the Pub/Sub message id so a
 * replayed event can never create a duplicate record or alert.
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  const secret = env.gmailPushSecret;
  if (!secret || !token || !timingSafeEqual(token, secret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { message?: { messageId?: string; data?: string; publishTime?: string } };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }

  const messageId = body.message?.messageId;
  if (!messageId) return Response.json({ ok: true, skipped: "no messageId" });

  const inserted = await db
    .insert(processedEvents)
    .values({ source: "gmail_push", eventId: messageId })
    .onConflictDoNothing()
    .returning({ id: processedEvents.id });

  if (!inserted[0]) {
    // Replay / duplicate delivery: acknowledge without reprocessing.
    return Response.json({ ok: true, duplicate: true });
  }

  await enqueueJob({
    type: "poll_replies",
    idempotencyKey: `poll-push-${stableKey(messageId)}`,
    maxAttempts: 4,
  });
  log.info("gmail_push_received", { messageId });
  return Response.json({ ok: true });
}
