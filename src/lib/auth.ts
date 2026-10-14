import { cookies } from "next/headers";
import { env } from "./env";
import { hmac, timingSafeEqual } from "./crypto";

const COOKIE = "aurum_session";
const TTL_MS = 12 * 60 * 60 * 1000;

function sign(payload: string): string {
  return hmac(payload, env.sessionSecret);
}

export function createSessionValue(user: string): string {
  const exp = Date.now() + TTL_MS;
  const payload = `${user}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

export function verifySessionValue(value: string | undefined): string | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [user, exp, sig] = parts;
  if (!timingSafeEqual(sig, sign(`${user}.${exp}`))) return null;
  if (Number(exp) < Date.now()) return null;
  return user;
}

export async function currentUser(): Promise<string | null> {
  const store = await cookies();
  return verifySessionValue(store.get(COOKIE)?.value);
}

export async function requireUser(): Promise<string> {
  const user = await currentUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

export class UnauthorizedError extends Error {}

export const SESSION_COOKIE = COOKIE;
export const SESSION_TTL_MS = TTL_MS;

export function checkCredentials(user: string, password: string): boolean {
  const expected = env.adminPassword;
  if (!expected) return false;
  if (user !== env.adminUser) return false;
  return timingSafeEqual(hmac(password, env.sessionSecret), hmac(expected, env.sessionSecret));
}

/** Guard for API route handlers. Returns a 401 Response or null. */
export async function guard(): Promise<Response | null> {
  const user = await currentUser();
  if (user) return null;
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
