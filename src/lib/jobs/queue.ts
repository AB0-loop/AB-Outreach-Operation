import { db } from "@/db";
import { jobs } from "@/db/schema";
import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import { errorMessage, log } from "../log";

export type JobType =
  | "verify_prospects"
  | "promote_eligible"
  | "draft_and_queue"
  | "send_due_messages"
  | "poll_replies"
  | "process_reply"
  | "schedule_followups"
  | "generate_report"
  | "recompute_budget"
  | "gmail_watch_renew";

export type ErrorCategory = "transient" | "permanent" | "dependency" | "unknown";

export class PermanentJobError extends Error {
  category: ErrorCategory = "permanent";
}
export class DependencyJobError extends Error {
  category: ErrorCategory = "dependency";
}

export async function enqueueJob(opts: {
  type: JobType;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
  runAt?: Date;
  maxAttempts?: number;
}): Promise<number | null> {
  const [row] = await db
    .insert(jobs)
    .values({
      type: opts.type,
      idempotencyKey: opts.idempotencyKey,
      payload: opts.payload ?? {},
      runAt: opts.runAt ?? new Date(),
      maxAttempts: opts.maxAttempts ?? 5,
    })
    .onConflictDoNothing({ target: jobs.idempotencyKey })
    .returning({ id: jobs.id });
  return row?.id ?? null;
}

/** Atomically claims one due job (safe across concurrent runners). */
export async function claimNextJob() {
  const result = await db.execute(sql`
    update jobs set status = 'running', started_at = now(), attempts = attempts + 1
    where id = (
      select id from jobs
      where status in ('pending','failed') and run_at <= now()
      order by run_at asc, id asc
      for update skip locked
      limit 1
    )
    returning id, type, payload, attempts, max_attempts, idempotency_key
  `);
  const row = (result.rows as unknown[])[0] as
    | {
        id: number;
        type: JobType;
        payload: Record<string, unknown>;
        attempts: number;
        max_attempts: number;
        idempotency_key: string;
      }
    | undefined;
  return row ?? null;
}

export async function completeJob(id: number) {
  await db
    .update(jobs)
    .set({ status: "done", finishedAt: new Date(), lastError: null })
    .where(eq(jobs.id, id));
}

export async function failJob(
  id: number,
  attempts: number,
  maxAttempts: number,
  error: unknown,
) {
  const category: ErrorCategory =
    error instanceof PermanentJobError
      ? "permanent"
      : error instanceof DependencyJobError
        ? "dependency"
        : "transient";
  const dead = category === "permanent" || attempts >= maxAttempts;
  const backoffMs = Math.min(2 ** attempts * 10000, 1800_000);
  await db
    .update(jobs)
    .set({
      status: dead ? "dead" : "failed",
      lastError: errorMessage(error).slice(0, 800),
      errorCategory: category,
      runAt: new Date(Date.now() + backoffMs),
      finishedAt: dead ? new Date() : null,
    })
    .where(eq(jobs.id, id));
  log.warn("job_failed", { id, attempts, dead, category });
}

export async function pendingJobCount(): Promise<number> {
  const rows = await db
    .select({ n: sql<string>`count(*)` })
    .from(jobs)
    .where(
      and(
        or(eq(jobs.status, "pending"), eq(jobs.status, "failed")),
        lte(jobs.runAt, new Date(Date.now() + 86_400_000)),
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

export async function deadLetterCount(): Promise<number> {
  const rows = await db
    .select({ n: sql<string>`count(*)` })
    .from(jobs)
    .where(eq(jobs.status, "dead"));
  return Number(rows[0]?.n ?? 0);
}

export async function recentJobs(limit = 20) {
  return db.select().from(jobs).orderBy(asc(jobs.status), sql`${jobs.id} desc`).limit(limit);
}
