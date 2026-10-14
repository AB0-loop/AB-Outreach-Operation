import { db } from "@/db";
import { sql } from "drizzle-orm";

/**
 * Durable report serial allocator: 001 → 999, then rollover to 001 with the
 * cycle counter incremented.
 *
 * Collision safety: the counter lives in a single PostgreSQL row and is
 * advanced with one atomic `UPDATE ... RETURNING`. The row lock serialises
 * concurrent jobs, and because the value is persisted it survives restarts and
 * redeployments. `(serial, cycle)` is additionally UNIQUE on `reports`, so even
 * a logic bug cannot silently overwrite an older report.
 */

export type AllocatedSerial = {
  serial: number;
  cycle: number;
  /** Zero-padded 001..999 */
  padded: string;
};

export async function allocateSerial(): Promise<AllocatedSerial> {
  await db.execute(
    sql`insert into report_counter (id, last_serial, cycle) values (1, 0, 1) on conflict (id) do nothing`,
  );
  const res = await db.execute(sql`
    update report_counter
       set last_serial = case when last_serial >= 999 then 1 else last_serial + 1 end,
           cycle       = case when last_serial >= 999 then cycle + 1 else cycle end,
           updated_at  = now()
     where id = 1
    returning last_serial, cycle
  `);
  const row = (res.rows as { last_serial: number; cycle: number }[])[0];
  if (!row) throw new Error("Failed to allocate a report serial");
  return {
    serial: row.last_serial,
    cycle: row.cycle,
    padded: String(row.last_serial).padStart(3, "0"),
  };
}

export async function peekSerial(): Promise<{ lastSerial: number; cycle: number }> {
  const res = await db.execute(
    sql`select last_serial, cycle from report_counter where id = 1`,
  );
  const row = (res.rows as { last_serial: number; cycle: number }[])[0];
  return { lastSerial: row?.last_serial ?? 0, cycle: row?.cycle ?? 1 };
}

export const REPORT_TYPES = {
  main_prospects: "MAIN_PROSPECTS",
  event_planners: "EVENT_PLANNERS",
  daily_activity: "DAILY_ACTIVITY",
  replies: "REPLIES_FOLLOWUPS",
  appointments: "APPOINTMENTS",
  deliverability: "DELIVERABILITY",
  executive_summary: "EXECUTIVE_SUMMARY",
} as const;

export type ReportType = keyof typeof REPORT_TYPES;

/**
 * `001_MAIN_PROSPECTS_2026-03-11.pdf`
 * After a rollover the cycle is appended so an archive filename is never
 * reused: `001_MAIN_PROSPECTS_2027-01-04_c2.pdf`
 */
export function reportFileName(
  s: AllocatedSerial,
  type: ReportType,
  dateKey: string,
): string {
  const suffix = s.cycle > 1 ? `_c${s.cycle}` : "";
  return `${s.padded}_${REPORT_TYPES[type]}_${dateKey}${suffix}.pdf`;
}
