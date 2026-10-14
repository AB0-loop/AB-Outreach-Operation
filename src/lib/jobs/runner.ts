import { getSettings } from "../settings";
import { claimNextJob, completeJob, enqueueJob, failJob, type JobType } from "./queue";
import { runJob, reconcileReportDelivery } from "./handlers";
import { flushNotifications } from "../providers/telegram";
import { errorMessage, log } from "../log";

const g = globalThis as typeof globalThis & {
  __aurumTickRunning?: boolean;
  __aurumSchedulerStarted?: boolean;
};

function bucket(ms: number): string {
  return String(Math.floor(Date.now() / ms));
}

/** Recurring work is enqueued with time-bucketed idempotency keys, so a
 *  duplicate tick (or a second instance) can never double-schedule. */
async function enqueueRecurring(emergencyStop: boolean) {
  const recurring: { type: JobType; everyMs: number; outbound: boolean }[] = [
    { type: "poll_replies", everyMs: 2 * 60_000, outbound: false },
    { type: "verify_prospects", everyMs: 5 * 60_000, outbound: false },
    { type: "promote_eligible", everyMs: 5 * 60_000, outbound: false },
    { type: "draft_and_queue", everyMs: 15 * 60_000, outbound: true },
    { type: "send_due_messages", everyMs: 5 * 60_000, outbound: true },
    { type: "schedule_followups", everyMs: 60 * 60_000, outbound: true },
    { type: "recompute_budget", everyMs: 6 * 60 * 60_000, outbound: false },
    { type: "gmail_watch_renew", everyMs: 24 * 60 * 60_000, outbound: false },
  ];
  for (const r of recurring) {
    if (emergencyStop && r.outbound) continue;
    await enqueueJob({
      type: r.type,
      idempotencyKey: `${r.type}-${bucket(r.everyMs)}`,
      maxAttempts: 4,
    });
  }
}

async function enqueueReportIfDue() {
  const s = await getSettings();
  const intervalMs = s.reportIntervalHours * 3600_000;
  const due = !s.lastReportAt || Date.now() - s.lastReportAt.getTime() >= intervalMs;
  if (!due) return;
  await enqueueJob({
    type: "generate_report",
    idempotencyKey: `generate_report-${bucket(intervalMs)}`,
    maxAttempts: 3,
  });
}

export type TickResult = {
  ran: number;
  results: { type: string; outcome: string }[];
  notificationsDelivered: number;
  emergencyStop: boolean;
};

/** One scheduler pass. Safe to call concurrently and repeatedly. */
export async function tick(maxJobs = 8): Promise<TickResult> {
  if (g.__aurumTickRunning)
    return { ran: 0, results: [], notificationsDelivered: 0, emergencyStop: false };
  g.__aurumTickRunning = true;

  const results: { type: string; outcome: string }[] = [];
  let ran = 0;
  let emergencyStop = false;

  try {
    const s = await getSettings();
    emergencyStop = s.emergencyStop;
    await enqueueRecurring(s.emergencyStop);
    await enqueueReportIfDue();

    for (let i = 0; i < maxJobs; i++) {
      const job = await claimNextJob();
      if (!job) break;
      ran += 1;
      try {
        const outcome = await runJob(job.type, job.payload ?? {});
        await completeJob(job.id);
        results.push({ type: job.type, outcome });
      } catch (e) {
        await failJob(job.id, job.attempts, job.max_attempts, e);
        results.push({ type: job.type, outcome: `error: ${errorMessage(e)}` });
      }
    }

    await reconcileReportDelivery();
    const notificationsDelivered = await flushNotifications(10);
    return { ran, results, notificationsDelivered, emergencyStop };
  } catch (e) {
    log.error("tick_failed", { error: errorMessage(e) });
    return { ran, results, notificationsDelivered: 0, emergencyStop };
  } finally {
    g.__aurumTickRunning = false;
  }
}

/** In-process loop for single-instance hosts. Disable with SCHEDULER_ENABLED=0
 *  and drive /api/cron from an external scheduler instead. */
export function startScheduler(intervalMs: number) {
  if (g.__aurumSchedulerStarted) return;
  g.__aurumSchedulerStarted = true;
  log.info("scheduler_started", { intervalMs });
  const loop = async () => {
    try {
      await tick();
    } catch (e) {
      log.error("scheduler_tick_error", { error: errorMessage(e) });
    }
  };
  setTimeout(loop, 5000);
  const timer = setInterval(loop, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
}
