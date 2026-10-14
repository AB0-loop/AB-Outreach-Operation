import { checkCredentials, createSessionValue, SESSION_COOKIE, SESSION_TTL_MS } from "@/lib/auth";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!env.adminPassword)
    return Response.json(
      { error: "ADMIN_PASSWORD is not configured on the server" },
      { status: 503 },
    );

  const form = await req.formData();
  const user = String(form.get("username") ?? "");
  const password = String(form.get("password") ?? "");

  if (!checkCredentials(user, password)) {
    await audit({ actor: "anonymous", action: "login.failed", detail: { user } });
    return Response.redirect(`${env.appUrl}/login?error=1`, 303);
  }

  await audit({ actor: user, action: "login.success" });
  const res = new Response(null, { status: 303, headers: { location: `${env.appUrl}/` } });
  res.headers.append(
    "set-cookie",
    `${SESSION_COOKIE}=${createSessionValue(user)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${env.appUrl.startsWith("https") ? "; Secure" : ""}`,
  );
  return res;
}
