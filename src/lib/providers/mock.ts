/**
 * Deterministic in-memory fakes for Gmail / Telegram / Grok.
 * Active only when OUTREACH_MOCK=1. Used by automated acceptance tests and by
 * operators who want to exercise the full pipeline before credentials exist.
 */

export type MockSentEmail = {
  id: string;
  threadId: string;
  to: string;
  subject: string;
  body: string;
  sentAt: string;
};

export type MockInboundEmail = {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  receivedAt: string;
};

export type MockTelegramCall = {
  method: string;
  text?: string;
  documentName?: string;
  replyMarkup?: unknown;
};

export type MockAiFailure =
  | false
  | "timeout"
  | "error"
  | "rate_limit"
  | "quota"
  | "auth";

type Store = {
  sent: MockSentEmail[];
  inbox: MockInboundEmail[];
  telegram: MockTelegramCall[];
  aiCalls: { provider: "grok" | "gemini"; task: string }[];
  failTelegram: boolean;
  failGmailSend: boolean;
  failGrok: MockAiFailure;
  failGemini: MockAiFailure;
  seq: number;
};

const g = globalThis as typeof globalThis & { __aurumMock?: Store };

export function mockStore(): Store {
  if (!g.__aurumMock) {
    g.__aurumMock = {
      sent: [],
      inbox: [],
      telegram: [],
      aiCalls: [],
      failTelegram: false,
      failGmailSend: false,
      failGrok: false,
      failGemini: false,
      seq: 0,
    };
  }
  return g.__aurumMock;
}

export function resetMock() {
  const s = mockStore();
  s.sent = [];
  s.inbox = [];
  s.telegram = [];
  s.aiCalls = [];
  s.failTelegram = false;
  s.failGmailSend = false;
  s.failGrok = false;
  s.failGemini = false;
  s.seq = 0;
}

export function nextMockId(prefix: string) {
  const s = mockStore();
  s.seq += 1;
  return `${prefix}${String(s.seq).padStart(6, "0")}`;
}
