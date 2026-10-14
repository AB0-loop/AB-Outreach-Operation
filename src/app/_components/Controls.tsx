"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

async function post(action: string, payload?: Record<string, unknown>) {
  const res = await fetch("/api/admin/actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, payload }),
  });
  const json = (await res.json()) as { error?: string; result?: unknown };
  if (!res.ok) throw new Error(json.error ?? "Request failed");
  return json;
}

function Btn({
  children,
  onClick,
  tone = "default",
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone?: "default" | "danger" | "primary";
  disabled?: boolean;
}) {
  const cls =
    tone === "danger"
      ? "border-red-800 bg-red-950/60 text-red-300 hover:bg-red-900/60"
      : tone === "primary"
        ? "border-amber-700 bg-amber-600 text-neutral-950 hover:bg-amber-500"
        : "border-neutral-800 bg-neutral-900 text-neutral-200 hover:bg-neutral-800";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded border px-3 py-1.5 text-xs font-medium transition disabled:opacity-40 ${cls}`}
    >
      {children}
    </button>
  );
}

type Check = {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  critical: boolean;
  fix?: string;
};
type Preflight = { canLaunch: boolean; checks: Check[]; failedCritical: string[] };

export default function Controls({
  emergencyStop,
  sendingEnabled,
  businessPhone,
  businessPhoneVerified,
  aiPaused,
  launched,
}: {
  emergencyStop: boolean;
  sendingEnabled: boolean;
  businessPhone: string | null;
  businessPhoneVerified: boolean;
  aiPaused: boolean;
  launched: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [phone, setPhone] = useState(businessPhone ?? "");
  const [importText, setImportText] = useState("");
  const [testTo, setTestTo] = useState("");
  const [preflight, setPreflight] = useState<Preflight | null>(null);

  const runPreflight = (thenLaunch: boolean) => {
    setMsg(null);
    start(async () => {
      try {
        const res = await fetch("/api/admin/actions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: thenLaunch ? "launch" : "preflight" }),
        });
        const json = (await res.json()) as { result?: Preflight; error?: string };
        if (json.result) setPreflight(json.result);
        setMsg(res.ok ? (thenLaunch ? "Launched" : "Preflight complete") : (json.error ?? "Failed"));
        router.refresh();
      } catch (e) {
        setMsg(e instanceof Error ? e.message : "Failed");
      }
    });
  };

  const run = (action: string, payload?: Record<string, unknown>) => {
    setMsg(null);
    start(async () => {
      try {
        const r = await post(action, payload);
        setMsg(r.result ? `OK — ${JSON.stringify(r.result).slice(0, 220)}` : "Done");
        router.refresh();
      } catch (e) {
        setMsg(e instanceof Error ? e.message : "Failed");
      }
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded border border-amber-800/40 bg-amber-950/20 p-3">
        <Btn disabled={pending} onClick={() => runPreflight(false)}>
          🧪 Run preflight
        </Btn>
        <Btn tone="primary" disabled={pending} onClick={() => runPreflight(true)}>
          🚀 {launched ? "Re-launch" : "Launch"}
        </Btn>
        <span className="text-xs text-neutral-400">
          Launch re-runs preflight and is blocked if any critical check fails.
        </span>
      </div>

      {preflight && (
        <div className="rounded border border-neutral-800 bg-neutral-900/60 p-3">
          <div className="mb-2 text-xs text-neutral-300">
            {preflight.canLaunch
              ? "✅ All critical checks passed."
              : `❌ Blocked by: ${preflight.failedCritical.join(", ")}`}
          </div>
          <ul className="space-y-1">
            {preflight.checks.map((c) => (
              <li key={c.id} className="text-[11px]">
                <span>
                  {c.status === "pass" ? "✅" : c.status === "warn" ? "⚠️" : "❌"}
                </span>{" "}
                <span className="text-neutral-200">{c.label}</span>{" "}
                <span className="text-neutral-500">— {c.detail}</span>
                {c.fix && c.status !== "pass" && (
                  <span className="text-amber-500/80"> → {c.fix}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {emergencyStop ? (
          <Btn tone="primary" disabled={pending} onClick={() => run("clear_emergency_stop")}>
            ✅ Clear Emergency Stop
          </Btn>
        ) : (
          <Btn tone="danger" disabled={pending} onClick={() => run("emergency_stop")}>
            🛑 EMERGENCY STOP
          </Btn>
        )}
        <Btn
          disabled={pending}
          onClick={() => run("set_sending", { enabled: !sendingEnabled })}
        >
          {sendingEnabled ? "⏸ Pause sending" : "▶️ Enable sending"}
        </Btn>
        <Btn disabled={pending} onClick={() => run("report_now")}>
          📄 Generate report now
        </Btn>
        <Btn disabled={pending} onClick={() => run("run_tick")}>
          ⚙️ Run scheduler tick
        </Btn>
        <Btn disabled={pending} onClick={() => run("recompute_budget")}>
          📈 Recompute send budget
        </Btn>
        {aiPaused && (
          <Btn disabled={pending} onClick={() => run("resume_ai")}>
            🤖 Resume AI
          </Btn>
        )}
        <a
          href="/api/oauth/gmail/start"
          className="rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs font-medium text-neutral-200 hover:bg-neutral-800"
        >
          ✉️ Connect Gmail
        </a>
        <form method="post" action="/api/auth/logout">
          <button className="rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-400 hover:bg-neutral-800">
            Sign out
          </button>
        </form>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+91XXXXXXXXXX business phone"
          className="w-64 rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs outline-none focus:border-amber-600"
        />
        <Btn
          disabled={pending}
          onClick={() => run("set_business_phone", { phone, verified: true })}
        >
          Save &amp; mark verified
        </Btn>
        <span className="text-xs text-neutral-500">
          {businessPhoneVerified ? "verified ✓" : "not verified — live sending blocked"}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={testTo}
          onChange={(e) => setTestTo(e.target.value)}
          placeholder="your-own@address.test"
          className="w-64 rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs outline-none focus:border-amber-600"
        />
        <Btn disabled={pending} onClick={() => run("send_test_email", { to: testTo })}>
          ✉️ Send test email
        </Btn>
        <span className="text-xs text-neutral-500">
          Use an address you control. Never a real prospect.
        </span>
      </div>

      <details className="rounded border border-neutral-800 bg-neutral-900/50 p-3">
        <summary className="cursor-pointer text-xs text-neutral-400">
          Import prospects (JSON array, evidence required)
        </summary>
        <textarea
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          rows={8}
          placeholder='[{"fullName":"...","role":"Founder","company":"...","email":"...","emailSourceUrl":"https://...","sourceUrl":"https://...","qualificationReason":"...","claims":[{"claimText":"...","sourceUrl":"https://...","excerpt":"..."}]}]'
          className="mt-2 w-full rounded border border-neutral-800 bg-neutral-950 p-2 font-mono text-[11px] outline-none focus:border-amber-600"
        />
        <Btn
          disabled={pending}
          onClick={() => {
            try {
              const records = JSON.parse(importText) as unknown;
              run("import_prospects", { records });
            } catch {
              setMsg("Invalid JSON");
            }
          }}
        >
          Import
        </Btn>
      </details>

      {msg && (
        <p className="rounded border border-neutral-800 bg-neutral-900 p-2 text-xs text-amber-300">
          {msg}
        </p>
      )}
    </div>
  );
}
