import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await currentUser()) redirect("/");
  const { error } = await searchParams;
  const configured = Boolean(env.adminPassword);

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="text-xs tracking-[0.4em] text-amber-500/80">AURUM BESPOKE</div>
          <h1 className="mt-2 text-xl font-light">Outreach Operations</h1>
        </div>
        {!configured && (
          <p className="mb-4 rounded border border-amber-700/40 bg-amber-950/40 p-3 text-xs text-amber-300">
            ADMIN_PASSWORD is not set on the server. Set it in the environment before use.
          </p>
        )}
        {error && (
          <p className="mb-4 rounded border border-red-800/50 bg-red-950/40 p-3 text-xs text-red-300">
            Invalid credentials.
          </p>
        )}
        <form method="post" action="/api/auth/login" className="space-y-3">
          <input
            name="username"
            placeholder="Username"
            autoComplete="username"
            defaultValue={env.adminUser}
            className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-amber-600"
          />
          <input
            name="password"
            type="password"
            placeholder="Password"
            autoComplete="current-password"
            className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-amber-600"
          />
          <button
            type="submit"
            className="w-full rounded bg-amber-600 px-3 py-2 text-sm font-medium text-neutral-950 hover:bg-amber-500"
          >
            Sign in
          </button>
        </form>
      </div>
    </main>
  );
}
