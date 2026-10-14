export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { env } = await import("./lib/env");
  if (!env.schedulerEnabled) return;
  if (!env.databaseUrl) return;
  const { startScheduler } = await import("./lib/jobs/runner");
  startScheduler(env.schedulerIntervalMs);
}
