import { guard } from "@/lib/auth";
import { env } from "@/lib/env";
import { hmac, timingSafeEqual } from "@/lib/crypto";
import { exchangeCode, startWatch } from "@/lib/providers/gmail";
import { audit } from "@/lib/audit";
import { errorMessage } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const unauthorized = await guard();
  if (unauthorized) return unauthorized;

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? "";
  const [nonce, sig] = state.split(".");
  if (!code || !nonce || !sig || !timingSafeEqual(sig, hmac(nonce, env.sessionSecret)))
    return Response.json({ error: "invalid oauth state" }, { status: 400 });
  if (Date.now() - Number(nonce) > 10 * 60_000)
    return Response.json({ error: "oauth state expired" }, { status: 400 });

  try {
    const email = await exchangeCode(code);
    const watch = await startWatch();
    await audit({
      actor: "operator",
      action: "gmail.authorized",
      detail: { email, watch: watch.detail },
    });
    return Response.redirect(`${env.appUrl}/?gmail=connected`, 302);
  } catch (e) {
    return Response.json({ error: errorMessage(e) }, { status: 500 });
  }
}
