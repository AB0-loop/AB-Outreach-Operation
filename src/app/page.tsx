import { redirect } from "next/navigation";
import { db } from "@/db";
import {
  prospects,
  emailMessages,
  replies,
  suppressions,
  auditLog,
  jobs,
} from "@/db/schema";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { currentUser } from "@/lib/auth";
import { getSettings, evaluateSendGate } from "@/lib/settings";
import { counts } from "@/lib/jobs/handlers";
import { budgetStatus } from "@/lib/providers/ai";
import { recentBudgetDecisions } from "@/lib/budget";
import { latestReports } from "@/lib/report";
import { gmailThreadLink } from "@/lib/providers/telegram";
import { integrationStatus, missingEnvForSending } from "@/lib/env";
import { getAccount } from "@/lib/providers/gmail";
import { formatZoned } from "@/lib/time";
import Controls from "./_components/Controls";

export const dynamic = "force-dynamic";

function Card({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded border border-neutral-800 bg-neutral-900/60 p-3">
      <div className="text-[10px] uppercase tracking-wider text-neutral-500">{label}</div>
      <div className="mt-1 text-lg font-light text-neutral-100">{value}</div>
      {hint && <div className="mt-0.5 text-[10px] text-neutral-500">{hint}</div>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded border border-neutral-800 bg-neutral-900/40">
      <h2 className="border-b border-neutral-800 px-3 py-2 text-[11px] uppercase tracking-wider text-amber-500/80">
        {title}
      </h2>
      <div className="overflow-x-auto p-3">{children}</div>
    </section>
  );
}

const TH = "px-2 py-1 text-left text-[10px] uppercase tracking-wider text-neutral-500";
const TD = "px-2 py-1 text-xs text-neutral-300 align-top";

export default async function Dashboard() {
  if (!(await currentUser())) redirect("/login");

  const s = await getSettings();
  const gate = evaluateSendGate(s);
  const c = await counts();
  const budget = await budgetStatus();
  const integrations = integrationStatus();
  const gmailAccount = await getAccount();
  const envGaps = missingEnvForSending();

  const [queued, recentReplies, failures, suppressed, activity, reportRows, deadJobs] =
    await Promise.all([
      db
        .select()
        .from(prospects)
        .where(inArray(prospects.status, ["ELIGIBLE", "QUEUED"]))
        .orderBy(desc(prospects.updatedAt))
        .limit(10),
      db.select().from(replies).orderBy(desc(replies.receivedAt)).limit(10),
      db
        .select()
        .from(emailMessages)
        .where(inArray(emailMessages.status, ["blocked", "failed", "uncertain"]))
        .orderBy(desc(emailMessages.id))
        .limit(10),
      db.select().from(suppressions).orderBy(desc(suppressions.createdAt)).limit(10),
      db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(12),
      latestReports(5),
      db.select().from(jobs).where(eq(jobs.status, "dead")).limit(5),
    ]);

  const budgetRows = await recentBudgetDecisions(7);

  const totalProspects = Number(
    (await db.select({ n: sql<string>`count(*)` }).from(prospects))[0]?.n ?? 0,
  );

  const statusLabel = s.emergencyStop
    ? "🛑 EMERGENCY STOP"
    : s.sendingEnabled
      ? "🟢 Sending enabled"
      : "⏸ Sending paused";

  return (
    <main className="min-h-screen bg-neutral-950 p-5 text-neutral-200">
      <div className="mx-auto max-w-7xl space-y-5">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-[10px] tracking-[0.4em] text-amber-500/80">AURUM BESPOKE</div>
            <h1 className="text-xl font-light">Autonomous Outreach — Operations</h1>
          </div>
          <div className="text-right text-xs text-neutral-400">
            <div>{statusLabel}</div>
            <div>
              {integrations.mockMode ? "MOCK MODE (no real email is sent)" : "LIVE PROVIDERS"} ·{" "}
              {s.timezone}
            </div>
          </div>
        </header>

        {(!gate.allowed || envGaps.length > 0) && (
          <div className="rounded border border-amber-800/50 bg-amber-950/30 p-3">
            <div className="text-[11px] uppercase tracking-wider text-amber-400">
              Live sending is blocked
            </div>
            <ul className="mt-1 list-inside list-disc text-xs text-amber-200/90">
              {gate.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
              {envGaps.map((g) => (
                <li key={g.key}>
                  {g.key}: {g.detail}
                </li>
              ))}
            </ul>
          </div>
        )}

        <Controls
          emergencyStop={s.emergencyStop}
          sendingEnabled={s.sendingEnabled}
          businessPhone={s.businessPhone}
          businessPhoneVerified={s.businessPhoneVerified}
          aiPaused={s.aiPaused}
          launched={Boolean(s.launchedAt)}
        />

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
          <Card
            label="Sent today"
            value={`${c.sentToday}/${s.currentDailyBudget}`}
            hint={`adaptive · ceiling ${s.budgetCeiling}`}
          />
          <Card label="Eligible" value={c.eligible} />
          <Card label="Queued" value={c.queued} />
          <Card label="Replies 24h" value={c.replies24h} />
          <Card label="Interested" value={c.interested} />
          <Card label="Needs review" value={c.review} />
          <Card label="Prospects" value={totalProspects} />
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Card
            label="AI spend (24h)"
            value={`$${budget.daily.toFixed(4)}`}
            hint={`grok $${budget.grokDaily.toFixed(4)}/$${budget.grokDailyCap} · gemini $${budget.geminiDaily.toFixed(4)}/$${budget.geminiDailyCap}${budget.paused ? " · PAUSED" : ""}`}
          />
          <Card
            label="Gmail"
            value={gmailAccount?.authorized ? gmailAccount.email : "not connected"}
            hint={integrations.mockMode ? "mock transport" : (gmailAccount?.scopes ?? "authorize to send")}
          />
          <Card
            label="Dead-letter jobs"
            value={deadJobs.length}
            hint={deadJobs.map((j) => j.type).join(", ") || "none"}
          />
        </div>

        <Section title="Queued / eligible leads">
          <table className="w-full">
            <thead>
              <tr>
                <th className={TH}>Name</th>
                <th className={TH}>Role / Company</th>
                <th className={TH}>Segment</th>
                <th className={TH}>Email</th>
                <th className={TH}>State</th>
                <th className={TH}>Next action</th>
              </tr>
            </thead>
            <tbody>
              {queued.map((p) => (
                <tr key={p.id} className="border-t border-neutral-800/60">
                  <td className={TD}>{p.fullName}</td>
                  <td className={TD}>{[p.role, p.company].filter(Boolean).join(" · ")}</td>
                  <td className={TD}>{p.segment}</td>
                  <td className={TD}>{p.email}</td>
                  <td className={TD}>{p.status}</td>
                  <td className={TD}>{p.nextAction}</td>
                </tr>
              ))}
              {queued.length === 0 && (
                <tr>
                  <td className={TD} colSpan={6}>
                    No eligible leads yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Section>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Section title="Recent replies">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={TH}>From</th>
                  <th className={TH}>Class</th>
                  <th className={TH}>Received</th>
                  <th className={TH}>Thread</th>
                </tr>
              </thead>
              <tbody>
                {recentReplies.map((r) => (
                  <tr key={r.id} className="border-t border-neutral-800/60">
                    <td className={TD}>{r.fromEmail}</td>
                    <td className={TD}>{r.classification}</td>
                    <td className={TD}>{formatZoned(new Date(r.receivedAt), s.timezone)}</td>
                    <td className={TD}>
                      <a
                        className="text-amber-500 hover:underline"
                        href={gmailThreadLink(r.gmailThreadId)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        open
                      </a>
                    </td>
                  </tr>
                ))}
                {recentReplies.length === 0 && (
                  <tr>
                    <td className={TD} colSpan={4}>
                      No replies recorded.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Section>

          <Section title="Blocked / failed messages">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={TH}>Msg</th>
                  <th className={TH}>Kind</th>
                  <th className={TH}>Status</th>
                  <th className={TH}>Reason</th>
                </tr>
              </thead>
              <tbody>
                {failures.map((m) => (
                  <tr key={m.id} className="border-t border-neutral-800/60">
                    <td className={TD}>#{m.id}</td>
                    <td className={TD}>{m.kind}</td>
                    <td className={TD}>{m.status}</td>
                    <td className={TD}>{m.blockedReason ?? m.error}</td>
                  </tr>
                ))}
                {failures.length === 0 && (
                  <tr>
                    <td className={TD} colSpan={4}>
                      None.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Section>

          <Section title="Suppression list">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={TH}>Email</th>
                  <th className={TH}>Reason</th>
                  <th className={TH}>Added</th>
                </tr>
              </thead>
              <tbody>
                {suppressed.map((x) => (
                  <tr key={x.id} className="border-t border-neutral-800/60">
                    <td className={TD}>{x.emailNormalized}</td>
                    <td className={TD}>{x.reason}</td>
                    <td className={TD}>{formatZoned(new Date(x.createdAt), s.timezone)}</td>
                  </tr>
                ))}
                {suppressed.length === 0 && (
                  <tr>
                    <td className={TD} colSpan={3}>
                      Empty.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Section>

          <Section title="Daily reports">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={TH}>Serial</th>
                  <th className={TH}>File</th>
                  <th className={TH}>Generated</th>
                  <th className={TH}>Delivery</th>
                  <th className={TH}>PDF</th>
                </tr>
              </thead>
              <tbody>
                {reportRows.map((r) => (
                  <tr key={r.id} className="border-t border-neutral-800/60">
                    <td className={TD}>
                      {String(r.serial).padStart(3, "0")}
                      {r.cycle > 1 ? ` · c${r.cycle}` : ""}
                    </td>
                    <td className={TD}>{r.fileName}</td>
                    <td className={TD}>{formatZoned(new Date(r.generatedAt), s.timezone)}</td>
                    <td className={TD}>{r.deliveryStatus}</td>
                    <td className={TD}>
                      <a className="text-amber-500 hover:underline" href={`/api/admin/reports/${r.id}`}>
                        download
                      </a>
                    </td>
                  </tr>
                ))}
                {reportRows.length === 0 && (
                  <tr>
                    <td className={TD} colSpan={5}>
                      No reports generated yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Section>
        </div>

        <Section title="Adaptive sending budget decisions">
          <table className="w-full">
            <thead>
              <tr>
                <th className={TH}>Day</th>
                <th className={TH}>From → To</th>
                <th className={TH}>Action</th>
                <th className={TH}>Binding constraint</th>
                <th className={TH}>Reason</th>
              </tr>
            </thead>
            <tbody>
              {budgetRows.map((b) => (
                <tr key={b.id} className="border-t border-neutral-800/60">
                  <td className={TD}>{b.dayKey}</td>
                  <td className={TD}>
                    {b.previousBudget} → {b.newBudget}
                  </td>
                  <td className={TD}>{b.action}</td>
                  <td className={TD}>{b.bindingConstraint}</td>
                  <td className={TD}>{b.reason}</td>
                </tr>
              ))}
              {budgetRows.length === 0 && (
                <tr>
                  <td className={TD} colSpan={5}>
                    No budget decisions recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Section>

        <Section title="Recent activity">
          <ul className="space-y-1 text-xs text-neutral-400">
            {activity.map((a) => (
              <li key={a.id}>
                <span className="text-neutral-600">
                  {formatZoned(new Date(a.createdAt), s.timezone)}
                </span>{" "}
                <span className="text-amber-500/80">{a.action}</span>{" "}
                <span className="text-neutral-500">by {a.actor}</span>
              </li>
            ))}
            {activity.length === 0 && <li>No activity recorded.</li>}
          </ul>
        </Section>
      </div>
    </main>
  );
}
