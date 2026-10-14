import { SESSION_COOKIE } from "@/lib/auth";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function POST() {
  const res = new Response(null, { status: 303, headers: { location: `${env.appUrl}/login` } });
  res.headers.append("set-cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
  return res;
}
