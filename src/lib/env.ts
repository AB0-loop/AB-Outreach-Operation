/**
 * Centralised environment access. Secrets are never logged or exported to the
 * client. Missing secrets degrade the system into a safe "not configured"
 * state instead of crashing — the operator sees the gap on the dashboard and
 * in /api/health.
 */

function str(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

export const env = {
  get databaseUrl() {
    return str("DATABASE_URL");
  },
  get appUrl() {
    return str("APP_BASE_URL") ?? "http://localhost:3000";
  },

  // Dashboard auth
  get adminUser() {
    return str("ADMIN_USERNAME") ?? "aurum";
  },
  get adminPassword() {
    return str("ADMIN_PASSWORD");
  },
  get sessionSecret() {
    return str("SESSION_SECRET") ?? "dev-only-insecure-session-secret";
  },
  get encryptionKey() {
    return str("TOKEN_ENCRYPTION_KEY");
  },

  // Gmail OAuth
  get googleClientId() {
    return str("GOOGLE_CLIENT_ID");
  },
  get googleClientSecret() {
    return str("GOOGLE_CLIENT_SECRET");
  },
  get googleRedirectUri() {
    return (
      str("GOOGLE_REDIRECT_URI") ??
      `${str("APP_BASE_URL") ?? "http://localhost:3000"}/api/oauth/gmail/callback`
    );
  },
  get gmailPushSecret() {
    return str("GMAIL_PUSH_SECRET");
  },
  get gmailPubsubTopic() {
    return str("GMAIL_PUBSUB_TOPIC");
  },

  // xAI Grok (primary)
  get xaiApiKey() {
    return str("XAI_API_KEY");
  },
  get xaiBaseUrl() {
    return str("XAI_BASE_URL") ?? "https://api.x.ai/v1";
  },

  // Google Gemini (secondary / failover)
  get geminiApiKey() {
    return str("GEMINI_API_KEY");
  },
  get geminiBaseUrl() {
    return str("GEMINI_BASE_URL") ?? "https://generativelanguage.googleapis.com/v1beta";
  },

  // Telegram
  get telegramBotToken() {
    return str("TELEGRAM_BOT_TOKEN");
  },
  get telegramChatId() {
    return str("TELEGRAM_CHAT_ID");
  },
  get telegramWebhookSecret() {
    return str("TELEGRAM_WEBHOOK_SECRET");
  },

  // Operations
  get cronSecret() {
    return str("CRON_SECRET");
  },
  /** When set, all external providers are replaced by deterministic fakes. */
  get mockMode() {
    return str("OUTREACH_MOCK") === "1";
  },
  /** In-process scheduler loop (disable when using an external cron). */
  get schedulerEnabled() {
    return str("SCHEDULER_ENABLED") !== "0";
  },
  get schedulerIntervalMs() {
    return Number(str("SCHEDULER_INTERVAL_MS") ?? 30000);
  },
} as const;

export type ConfigGap = { key: string; detail: string; blocksSending: boolean };

/** Which integrations are actually configured right now. */
export function integrationStatus() {
  return {
    gmailOAuth: Boolean(env.googleClientId && env.googleClientSecret),
    grok: Boolean(env.xaiApiKey),
    gemini: Boolean(env.geminiApiKey),
    telegram: Boolean(env.telegramBotToken && env.telegramChatId),
    encryption: Boolean(env.encryptionKey),
    adminAuth: Boolean(env.adminPassword),
    mockMode: env.mockMode,
  };
}

export function missingEnvForSending(): ConfigGap[] {
  const gaps: ConfigGap[] = [];
  if (env.mockMode) return gaps;
  if (!env.googleClientId || !env.googleClientSecret)
    gaps.push({
      key: "GOOGLE_CLIENT_ID/SECRET",
      detail: "Gmail OAuth client not configured",
      blocksSending: true,
    });
  if (!env.encryptionKey)
    gaps.push({
      key: "TOKEN_ENCRYPTION_KEY",
      detail: "OAuth tokens cannot be encrypted at rest",
      blocksSending: true,
    });
  if (!env.telegramBotToken || !env.telegramChatId)
    gaps.push({
      key: "TELEGRAM_BOT_TOKEN/CHAT_ID",
      detail: "Operator cannot be notified of replies",
      blocksSending: true,
    });
  if (!env.adminPassword)
    gaps.push({
      key: "ADMIN_PASSWORD",
      detail: "Dashboard is not protected",
      blocksSending: true,
    });
  return gaps;
}
