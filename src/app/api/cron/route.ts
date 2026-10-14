import { env } from "@/lib/env";
import { timingSafeEqual } from "@/lib/crypto";
import { tick } from "@/lib/jobs/runner";
import { currentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function authorized(req: Request): Promise<boolean> {
  const secret = env.cronSecret;
  if (secret) {
    const header =
      req.headers.get("x-cron-secret") ??
      req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
      "";
    if (header && timingSafeEqual(header, secret)) return true;
  }
  return (await currentUser()) !== null;
}

export async function POST(req: Request) {
  if (!(await authorized(req)))
    return Response.json({ error: "unauthorized" }, { status: 401 });
  const result = await tick();
  return Response.json({ ok: true, ...result });
}

export async function GET(req: Request) {
  return POST(req);
}
