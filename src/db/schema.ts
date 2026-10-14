import {
  pgTable,
  serial,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  numeric,
  uniqueIndex,
  index,
  customType,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/* ------------------------------------------------------------------ */
/* Settings (single row, id = 1)                                       */
/* ------------------------------------------------------------------ */
export const settings = pgTable("settings", {
  id: integer("id").primaryKey().default(1),

  // Hard safety gates
  emergencyStop: boolean("emergency_stop").notNull().default(true),
  sendingEnabled: boolean("sending_enabled").notNull().default(false),

  // Launch state
  launchedAt: timestamp("launched_at", { withTimezone: true }),
  preflightPassedAt: timestamp("preflight_passed_at", { withTimezone: true }),

  // Verified business contact details (gate live sending)
  businessPhone: text("business_phone"),
  businessPhoneVerified: boolean("business_phone_verified")
    .notNull()
    .default(false),
  businessWebsite: text("business_website")
    .notNull()
    .default("https://aurumbespoke.com"),
  senderEmail: text("sender_email")
    .notNull()
    .default("connectaurumbespoke@gmail.com"),
  senderName: text("sender_name").notNull().default("Aurum Bespoke"),
  businessAddress: text("business_address"),

  /* --- Adaptive sending controller (no hard-coded cap) --- */
  /** Current adaptive budget, recomputed daily from real delivery health. */
  currentDailyBudget: integer("current_daily_budget").notNull().default(5),
  /** Conservative starting point. */
  budgetFloor: integer("budget_floor").notNull().default(5),
  /** Operator-set hard ceiling the controller may never exceed. */
  budgetCeiling: integer("budget_ceiling").notNull().default(40),
  /**
   * The recipient/day limit the OPERATOR has verified for this Gmail account.
   * This is not an "official Google number" asserted by the system — it must be
   * confirmed against the actual account (see docs/SETUP_GMAIL.md).
   */
  providerDailyLimit: integer("provider_daily_limit").notNull().default(100),
  /** Growth step as a percentage of the current budget. */
  budgetGrowthPct: integer("budget_growth_pct").notNull().default(25),
  lastBudgetDecisionAt: timestamp("last_budget_decision_at", {
    withTimezone: true,
  }),
  budgetPausedReason: text("budget_paused_reason"),

  maxFollowups: integer("max_followups").notNull().default(1),
  followupBusinessDays: integer("followup_business_days").notNull().default(4),
  sendWindowStartHour: integer("send_window_start_hour").notNull().default(10),
  sendWindowEndHour: integer("send_window_end_hour").notNull().default(18),
  timezone: text("timezone").notNull().default("Asia/Kolkata"),

  /* --- Email quality gate --- */
  minQualityScore: integer("min_quality_score").notNull().default(75),
  minLeadScore: integer("min_lead_score").notNull().default(60),

  // Target mix (planning ratio only)
  professionalRatio: integer("professional_ratio").notNull().default(80),

  /* --- AI: Grok primary, Gemini secondary failover --- */
  aiModel: text("ai_model").notNull().default("grok-3-mini"),
  geminiModel: text("gemini_model").notNull().default("gemini-2.0-flash"),
  /** Set false to forbid failover entirely (e.g. Gemini billing not approved). */
  geminiEnabled: boolean("gemini_enabled").notNull().default(true),

  aiMaxInputTokens: integer("ai_max_input_tokens").notNull().default(2000),
  aiMaxOutputTokens: integer("ai_max_output_tokens").notNull().default(600),

  // Combined ceilings across both providers.
  aiDailyCapUsd: numeric("ai_daily_cap_usd", { precision: 10, scale: 4 })
    .notNull()
    .default("1.0000"),
  aiMonthlyCapUsd: numeric("ai_monthly_cap_usd", { precision: 10, scale: 4 })
    .notNull()
    .default("20.0000"),
  // Per-provider ceilings: failover can never spend past Gemini's own budget.
  grokDailyCapUsd: numeric("grok_daily_cap_usd", { precision: 10, scale: 4 })
    .notNull()
    .default("1.0000"),
  geminiDailyCapUsd: numeric("gemini_daily_cap_usd", { precision: 10, scale: 4 })
    .notNull()
    .default("0.5000"),

  aiInputUsdPerMTok: numeric("ai_input_usd_per_mtok", {
    precision: 10,
    scale: 4,
  })
    .notNull()
    .default("0.3000"),
  aiOutputUsdPerMTok: numeric("ai_output_usd_per_mtok", {
    precision: 10,
    scale: 4,
  })
    .notNull()
    .default("0.5000"),
  geminiInputUsdPerMTok: numeric("gemini_input_usd_per_mtok", {
    precision: 10,
    scale: 4,
  })
    .notNull()
    .default("0.1000"),
  geminiOutputUsdPerMTok: numeric("gemini_output_usd_per_mtok", {
    precision: 10,
    scale: 4,
  })
    .notNull()
    .default("0.4000"),

  aiPaused: boolean("ai_paused").notNull().default(false),
  aiPausedReason: text("ai_paused_reason"),

  // Reporting
  reportIntervalHours: integer("report_interval_hours").notNull().default(24),
  lastReportAt: timestamp("last_report_at", { withTimezone: true }),

  // Evidence freshness
  evidenceMaxAgeDays: integer("evidence_max_age_days").notNull().default(180),

  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/* ------------------------------------------------------------------ */
/* Prospects                                                           */
/* ------------------------------------------------------------------ */
export const prospects = pgTable(
  "prospects",
  {
    id: serial("id").primaryKey(),
    fullName: text("full_name").notNull(),
    role: text("role"),
    company: text("company"),
    /** 'professional' | 'wedding_event' */
    segment: text("segment").notNull().default("professional"),
    category: text("category"),

    city: text("city").notNull().default("Bengaluru"),
    bengaluruEvidenceUrl: text("bengaluru_evidence_url"),

    email: text("email").notNull(),
    emailNormalized: text("email_normalized").notNull(),
    /** 'unverified' | 'source_verified' | 'invalid' */
    emailStatus: text("email_status").notNull().default("unverified"),
    emailSourceUrl: text("email_source_url"),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    emailVerificationMethod: text("email_verification_method"),

    phone: text("phone"),
    /** 'public_business' | 'supplied_by_prospect' | 'unverified' */
    phoneType: text("phone_type"),
    phoneSourceUrl: text("phone_source_url"),
    phoneVerified: boolean("phone_verified").notNull().default(false),

    suppliedPhone: text("supplied_phone"),
    suppliedPhoneSource: text("supplied_phone_source"),
    suppliedPhoneVerified: boolean("supplied_phone_verified")
      .notNull()
      .default(false),
    suppliedPhoneAt: timestamp("supplied_phone_at", { withTimezone: true }),

    website: text("website"),
    sourceUrl: text("source_url"),
    sourceName: text("source_name"),

    qualificationReason: text("qualification_reason"),
    /** 0-100 relevance/suitability score. */
    leadScore: integer("lead_score").notNull().default(0),
    leadScoreReason: text("lead_score_reason"),
    /** 0-100 confidence that identity/role/email are correct. */
    verificationConfidence: integer("verification_confidence")
      .notNull()
      .default(0),
    linkedinUrl: text("linkedin_url"),

    /** see lib/state.ts ProspectState */
    status: text("status").notNull().default("DISCOVERED"),
    reviewReason: text("review_reason"),
    nextAction: text("next_action"),

    discoveredAt: timestamp("discovered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("prospects_email_norm_uq").on(t.emailNormalized),
    index("prospects_status_idx").on(t.status),
  ],
);

/* ------------------------------------------------------------------ */
/* Evidence claims (factual grounding)                                 */
/* ------------------------------------------------------------------ */
export const evidenceClaims = pgTable(
  "evidence_claims",
  {
    id: serial("id").primaryKey(),
    prospectId: integer("prospect_id")
      .notNull()
      .references(() => prospects.id, { onDelete: "cascade" }),
    claimText: text("claim_text").notNull(),
    sourceUrl: text("source_url").notNull(),
    excerpt: text("excerpt").notNull(),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    verified: boolean("verified").notNull().default(false),
    verificationMethod: text("verification_method"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("evidence_prospect_idx").on(t.prospectId)],
);

/* ------------------------------------------------------------------ */
/* Campaigns                                                           */
/* ------------------------------------------------------------------ */
export const campaigns = pgTable("campaigns", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  segment: text("segment").notNull().default("professional"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/* ------------------------------------------------------------------ */
/* Email messages                                                      */
/* ------------------------------------------------------------------ */
export const emailMessages = pgTable(
  "email_messages",
  {
    id: serial("id").primaryKey(),
    prospectId: integer("prospect_id")
      .notNull()
      .references(() => prospects.id, { onDelete: "cascade" }),
    campaignId: integer("campaign_id").references(() => campaigns.id),
    /** 'initial' | 'followup' */
    kind: text("kind").notNull().default("initial"),
    subject: text("subject").notNull(),
    bodyText: text("body_text").notNull(),
    /** 'draft'|'validated'|'queued'|'sent'|'failed'|'blocked'|'uncertain' */
    status: text("status").notNull().default("draft"),
    blockedReason: text("blocked_reason"),
    validationReport: jsonb("validation_report"),
    claimIds: jsonb("claim_ids").$type<number[]>().notNull().default([]),
    generator: text("generator").notNull().default("template"),
    /** Which AI provider produced the draft: grok | gemini | template */
    aiProvider: text("ai_provider").notNull().default("template"),
    qualityScore: integer("quality_score").notNull().default(0),
    qualityReport: jsonb("quality_report"),
    personalizationHook: text("personalization_hook"),
    regenerations: integer("regenerations").notNull().default(0),

    gmailMessageId: text("gmail_message_id"),
    gmailThreadId: text("gmail_thread_id"),
    rfcMessageId: text("rfc_message_id"),
    idempotencyKey: text("idempotency_key").notNull(),

    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("email_messages_idem_uq").on(t.idempotencyKey),
    index("email_messages_prospect_idx").on(t.prospectId),
    index("email_messages_status_idx").on(t.status),
  ],
);

/* ------------------------------------------------------------------ */
/* Replies                                                             */
/* ------------------------------------------------------------------ */
export const replies = pgTable(
  "replies",
  {
    id: serial("id").primaryKey(),
    prospectId: integer("prospect_id").references(() => prospects.id, {
      onDelete: "cascade",
    }),
    messageId: integer("message_id").references(() => emailMessages.id),
    gmailMessageId: text("gmail_message_id").notNull(),
    gmailThreadId: text("gmail_thread_id").notNull(),
    fromEmail: text("from_email").notNull(),
    subject: text("subject"),
    bodyText: text("body_text"),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** interested|consultation|pricing|decline|unsubscribe|bounce|complaint|ooo|ambiguous */
    classification: text("classification").notNull().default("ambiguous"),
    classifiedBy: text("classified_by").notNull().default("rules"),
    summary: text("summary"),
    suggestedResponse: text("suggested_response"),
    extractedPhone: text("extracted_phone"),
    extractedPhoneOwnership: text("extracted_phone_ownership"),
    handled: boolean("handled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("replies_gmail_msg_uq").on(t.gmailMessageId)],
);

/* ------------------------------------------------------------------ */
/* Global suppression list                                             */
/* ------------------------------------------------------------------ */
export const suppressions = pgTable(
  "suppressions",
  {
    id: serial("id").primaryKey(),
    emailNormalized: text("email_normalized").notNull(),
    /** unsubscribe|complaint|hard_bounce|decline|manual */
    reason: text("reason").notNull(),
    sourceRef: text("source_ref"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("suppressions_email_uq").on(t.emailNormalized)],
);

/* ------------------------------------------------------------------ */
/* State transitions (audit of the state machine)                      */
/* ------------------------------------------------------------------ */
export const stateTransitions = pgTable(
  "state_transitions",
  {
    id: serial("id").primaryKey(),
    prospectId: integer("prospect_id")
      .notNull()
      .references(() => prospects.id, { onDelete: "cascade" }),
    fromState: text("from_state").notNull(),
    toState: text("to_state").notNull(),
    reason: text("reason"),
    /** system | human | ai */
    actor: text("actor").notNull().default("system"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("state_transitions_prospect_idx").on(t.prospectId)],
);

/* ------------------------------------------------------------------ */
/* Durable jobs                                                        */
/* ------------------------------------------------------------------ */
export const jobs = pgTable(
  "jobs",
  {
    id: serial("id").primaryKey(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}),
    /** pending|running|done|failed|dead */
    status: text("status").notNull().default("pending"),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lastError: text("last_error"),
    errorCategory: text("error_category"),
    idempotencyKey: text("idempotency_key").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("jobs_idem_uq").on(t.idempotencyKey),
    index("jobs_status_runat_idx").on(t.status, t.runAt),
  ],
);

/* ------------------------------------------------------------------ */
/* Telegram outbox (durable retry queue)                               */
/* ------------------------------------------------------------------ */
export const notifications = pgTable(
  "notifications",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(),
    text: text("text").notNull(),
    replyMarkup: jsonb("reply_markup"),
    documentName: text("document_name"),
    documentContent: bytea("document_content"),
    /** pending|sent|failed|dead */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(8),
    lastError: text("last_error"),
    dedupeKey: text("dedupe_key").notNull(),
    telegramMessageId: text("telegram_message_id"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("notifications_dedupe_uq").on(t.dedupeKey),
    index("notifications_status_idx").on(t.status, t.nextAttemptAt),
  ],
);

/* ------------------------------------------------------------------ */
/* AI usage + cost ledger                                              */
/* ------------------------------------------------------------------ */
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: serial("id").primaryKey(),
    task: text("task").notNull(),
    /** grok | gemini */
    provider: text("provider").notNull().default("grok"),
    /** Why a non-primary provider was used, when applicable. */
    failoverReason: text("failover_reason"),
    model: text("model").notNull(),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 })
      .notNull()
      .default("0"),
    costSource: text("cost_source").notNull().default("estimated"),
    status: text("status").notNull(),
    latencyMs: integer("latency_ms"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("ai_usage_created_idx").on(t.createdAt)],
);

/* ------------------------------------------------------------------ */
/* Reports — PDF only                                                  */
/* ------------------------------------------------------------------ */
export const reports = pgTable(
  "reports",
  {
    id: serial("id").primaryKey(),
    reportKey: text("report_key").notNull(),
    /** 001-999, allocated atomically from report_counter. */
    serial: integer("serial").notNull(),
    /** Increments on each 999 -> 001 rollover; (serial, cycle) is unique. */
    cycle: integer("cycle").notNull().default(1),
    /** main_prospects | event_planners | daily_activity | replies |
     *  appointments | deliverability | executive_summary */
    reportType: text("report_type").notNull(),
    segment: text("segment"),
    fileName: text("file_name").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    counts: jsonb("counts").$type<Record<string, number>>().notNull(),
    pdfContent: bytea("pdf_content"),
    /** SHA-256 of the PDF bytes. */
    checksum: text("checksum"),
    byteSize: integer("byte_size"),
    /** pending|queued_for_delivery|delivered|failed */
    deliveryStatus: text("delivery_status").notNull().default("pending"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    deliveryError: text("delivery_error"),
  },
  (t) => [
    uniqueIndex("reports_key_uq").on(t.reportKey),
    uniqueIndex("reports_serial_cycle_uq").on(t.serial, t.cycle),
  ],
);

/**
 * Durable report serial counter. A single row updated atomically, so
 * concurrent jobs and process restarts can never reuse a serial.
 */
export const reportCounter = pgTable("report_counter", {
  id: integer("id").primaryKey().default(1),
  lastSerial: integer("last_serial").notNull().default(0),
  cycle: integer("cycle").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/* ------------------------------------------------------------------ */
/* Appointments / consultations                                        */
/* ------------------------------------------------------------------ */
export const appointments = pgTable(
  "appointments",
  {
    id: serial("id").primaryKey(),
    prospectId: integer("prospect_id")
      .notNull()
      .references(() => prospects.id, { onDelete: "cascade" }),
    replyId: integer("reply_id").references(() => replies.id),
    /** proposed|awaiting_confirmation|confirmed|rescheduled|cancelled */
    status: text("status").notNull().default("proposed"),
    /** Only set when the prospect states one; never inferred. */
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    evidenceExcerpt: text("evidence_excerpt"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("appointments_prospect_idx").on(t.prospectId)],
);

/* ------------------------------------------------------------------ */
/* Adaptive sending budget decisions (audit trail)                     */
/* ------------------------------------------------------------------ */
export const budgetDecisions = pgTable(
  "budget_decisions",
  {
    id: serial("id").primaryKey(),
    dayKey: text("day_key").notNull(),
    previousBudget: integer("previous_budget").notNull(),
    newBudget: integer("new_budget").notNull(),
    /** increase|hold|decrease|pause */
    action: text("action").notNull(),
    reason: text("reason").notNull(),
    metrics: jsonb("metrics").$type<Record<string, number>>().notNull(),
    bindingConstraint: text("binding_constraint").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("budget_decisions_day_uq").on(t.dayKey)],
);

/* ------------------------------------------------------------------ */
/* Human approval queue (substantive sales replies)                    */
/* ------------------------------------------------------------------ */
export const approvals = pgTable(
  "approvals",
  {
    id: serial("id").primaryKey(),
    replyId: integer("reply_id").references(() => replies.id, {
      onDelete: "cascade",
    }),
    prospectId: integer("prospect_id").references(() => prospects.id, {
      onDelete: "cascade",
    }),
    kind: text("kind").notNull(),
    proposedText: text("proposed_text"),
    /** pending|approved|rejected|handled */
    status: text("status").notNull().default("pending"),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("approvals_status_idx").on(t.status)],
);

/* ------------------------------------------------------------------ */
/* Processed external events (webhook idempotency / replay guard)      */
/* ------------------------------------------------------------------ */
export const processedEvents = pgTable(
  "processed_events",
  {
    id: serial("id").primaryKey(),
    source: text("source").notNull(),
    eventId: text("event_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("processed_events_uq").on(t.source, t.eventId)],
);

/* ------------------------------------------------------------------ */
/* OAuth accounts (Gmail)                                              */
/* ------------------------------------------------------------------ */
export const oauthAccounts = pgTable(
  "oauth_accounts",
  {
    id: serial("id").primaryKey(),
    provider: text("provider").notNull().default("gmail"),
    email: text("email").notNull(),
    refreshTokenEnc: text("refresh_token_enc"),
    accessTokenEnc: text("access_token_enc"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    scopes: text("scopes"),
    historyId: text("history_id"),
    watchExpiration: timestamp("watch_expiration", { withTimezone: true }),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    authorized: boolean("authorized").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("oauth_accounts_uq").on(t.provider, t.email)],
);

/* ------------------------------------------------------------------ */
/* Audit log                                                           */
/* ------------------------------------------------------------------ */
export const auditLog = pgTable(
  "audit_log",
  {
    id: serial("id").primaryKey(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    entity: text("entity"),
    entityId: text("entity_id"),
    detail: jsonb("detail"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("audit_created_idx").on(t.createdAt)],
);

/* ------------------------------------------------------------------ */
/* Discovery sources (operator configured, robots-respecting)          */
/* ------------------------------------------------------------------ */
export const discoverySources = pgTable("discovery_sources", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  segment: text("segment").notNull().default("professional"),
  enabled: boolean("enabled").notNull().default(true),
  lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
  lastStatus: text("last_status"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Prospect = typeof prospects.$inferSelect;
export type EmailMessage = typeof emailMessages.$inferSelect;
export type Reply = typeof replies.$inferSelect;
export type Settings = typeof settings.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type Report = typeof reports.$inferSelect;
export type Appointment = typeof appointments.$inferSelect;
export type EvidenceClaim = typeof evidenceClaims.$inferSelect;

/** The two independently managed prospect segments. */
export const SEGMENTS = ["professional", "event_planner"] as const;
export type Segment = (typeof SEGMENTS)[number];
