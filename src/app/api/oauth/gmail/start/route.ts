import { guard } from "@/lib/auth";
import { env } from "@/lib/env";
import { authUrl } from "@/lib/providers/gmail";
import { hmac } from "@/lib/crypto";

export const dynamic = "force-dynamic";

export async function GET() {
  const unauthorized = await guard();
  if (unauthorized) return unauthorized;
  if (!env.googleClientId || !env.googleClientSecret)
    return Response.json(
      { error: "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not configured" },
      { status: 400 },
    );
  if (!env.encryptionKey)
    return Response.json(
      { error: "TOKEN_ENCRYPTION_KEY must be set before authorizing Gmail" },
      { status: 400 },
    );

  const nonce = `${Date.now()}`;
  const state = `${nonce}.${hmac(nonce, env.sessionSecret)}`;
  return Response.redirect(authUrl(state), 302);
}
