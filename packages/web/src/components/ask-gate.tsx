"use client";

// AskGate — the login wall in front of the /ask form (ARCHITECTURE.md §15.3).
//
// Clicking "Ask" lands here. Before the question form appears, a three-step
// dialog: (1) explain that asking needs a verified, unique human — sign in with
// Self (self.xyz) or email the team; (2) scan a Self QR, which re-derives the
// same nullifier the asker's agent registered under (deterministic per scope),
// so the broker can look up their contribution score; (3) show that score — how
// far past / short of the unlock threshold they are. Cleared ⇒ reveal the form,
// carrying a short-lived, broker-signed asker session the submit re-verifies.
//
// The browser never sees a raw identity: it holds only a requestId and, once
// verified, an opaque broker-signed session. All of /api/asker-login proxies the
// broker, which alone talks to the self-bridge.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { AskForm } from "./ask-form";
import {
  OnboardingDialog,
  StepNav,
  primaryButtonClass,
} from "./onboarding-dialog";

const TEAM_EMAIL = "newquestion@hearme.fi";
const POLL_INTERVAL_MS = 2500;

type Scope = "worldwide" | "continent" | "country";

type Eligibility = {
  authorized: boolean;
  can_ask: boolean;
  is_admin: boolean;
  total_answers: number;
  signal_answers: number;
  required_total: number;
  required_signal: number;
  remaining_total: number;
  remaining_signal: number;
  reason: string | null;
  unique_identifier: string | null;
};

type StatusResponse = {
  status: "pending" | "failed" | "complete";
  reason: string | null;
  eligibility: Eligibility | null;
  asker_session: unknown | null;
};

type Step = "intro" | "scan" | "score";

type Props = {
  // Gate only when the broker requires asker auth. In local/demo mode
  // (ASKER_AUTH_REQUIRED=false) there's no broker to verify against, so render
  // the form directly — exactly the pre-gate behaviour.
  authRequired: boolean;
  defaultScope?: Scope;
  defaultCountry?: string;
  defaultContinent?: string;
};

// Mirror of lib/asker-auth's gate copy, for the score step.
function remainingMessage(e: Eligibility): string {
  if (e.reason === "not_enough_signal") {
    const n = e.remaining_signal;
    return `Almost there — ${n} more answer${n === 1 ? "" : "s"} where your agent gave a real opinion (not "no opinion") and you can ask.`;
  }
  const n = e.remaining_total;
  return `Answer ${n} more question${n === 1 ? "" : "s"} to unlock asking.`;
}

export function AskGate({
  authRequired,
  defaultScope,
  defaultCountry,
  defaultContinent,
}: Props) {
  const [open, setOpen] = useState(authRequired);
  const [step, setStep] = useState<Step>("intro");
  const [ready, setReady] = useState(false);

  const [session, setSession] = useState<string | null>(null);
  const [eligibility, setEligibility] = useState<Eligibility | null>(null);

  const titleId = useId();
  const bodyId = useId();

  const reset = useCallback(() => {
    setStep("intro");
    setSession(null);
    setEligibility(null);
    setOpen(true);
  }, []);

  // Local/demo mode: no gate, render the form straight away.
  if (!authRequired) {
    return (
      <AskForm
        defaultScope={defaultScope}
        defaultCountry={defaultCountry}
        defaultContinent={defaultContinent}
      />
    );
  }

  if (ready && session) {
    return (
      <AskForm
        askerSession={session}
        defaultScope={defaultScope}
        defaultCountry={defaultCountry}
        defaultContinent={defaultContinent}
      />
    );
  }

  const onVerified = (s: StatusResponse) => {
    if (s.asker_session) setSession(JSON.stringify(s.asker_session));
    setEligibility(s.eligibility);
    setStep("score");
  };

  return (
    <>
      {/* What sits behind / instead of the form until verified. */}
      <LockedPlaceholder
        verified={Boolean(eligibility)}
        onOpen={() => setOpen(true)}
      />

      <OnboardingDialog
        open={open}
        onClose={() => setOpen(false)}
        labelledBy={titleId}
        describedBy={bodyId}
        illustration={
          step === "intro" ? (
            <ShieldIllustration />
          ) : step === "scan" ? (
            <ScanStage onVerified={onVerified} />
          ) : (
            <ScoreIllustration eligibility={eligibility} />
          )
        }
      >
        {step === "intro" ? (
          <IntroBody titleId={titleId} bodyId={bodyId} />
        ) : step === "scan" ? (
          <ScanBody titleId={titleId} bodyId={bodyId} />
        ) : (
          <ScoreBody titleId={titleId} bodyId={bodyId} eligibility={eligibility} />
        )}

        <GateNav
          step={step}
          eligibility={eligibility}
          onBack={() => setStep(step === "score" ? "scan" : "intro")}
          onClose={() => setOpen(false)}
          onStartScan={() => setStep("scan")}
          onRetry={reset}
          onFillIn={() => {
            setOpen(false);
            setReady(true);
          }}
        />
      </OnboardingDialog>
    </>
  );
}

/* ---------- step bodies ---------- */

function StepLabel({ n }: { n: number }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-wide text-violet-600">
      Verify to ask · step {n} of 3
    </p>
  );
}

function IntroBody({ titleId, bodyId }: { titleId: string; bodyId: string }) {
  return (
    <>
      <StepLabel n={1} />
      <h2
        id={titleId}
        className="mt-1 text-xl font-semibold tracking-tight text-slate-900"
      >
        Verify you&apos;re a unique human
      </h2>
      <p id={bodyId} className="mt-2 text-sm leading-relaxed text-slate-600">
        Asking is earned. Sign in with{" "}
        <span className="font-medium text-slate-800">Self (self.xyz)</span> — a
        quick passport scan that proves you&apos;re one real person and lets us
        check your contribution score. No account, and your passport never leaves
        your phone.
      </p>
      <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500">
        Not set up with Self yet? Email{" "}
        <a
          href={`mailto:${TEAM_EMAIL}`}
          className="font-medium text-violet-700 underline-offset-2 hover:underline"
        >
          {TEAM_EMAIL}
        </a>{" "}
        and the team will get you in.
      </p>
    </>
  );
}

function ScanBody({ titleId, bodyId }: { titleId: string; bodyId: string }) {
  return (
    <>
      <StepLabel n={2} />
      <h2
        id={titleId}
        className="mt-1 text-xl font-semibold tracking-tight text-slate-900"
      >
        Scan with the Self app
      </h2>
      <p id={bodyId} className="mt-2 text-sm leading-relaxed text-slate-600">
        Open Self on your phone and scan the code. It recreates your verification
        for this app, so we can read your current score — a zero-knowledge proof,
        nothing about who you are is revealed.
      </p>
      <p className="mt-3 text-xs text-slate-400">
        Trouble scanning? Email{" "}
        <a
          href={`mailto:${TEAM_EMAIL}`}
          className="font-medium text-violet-600 underline-offset-2 hover:underline"
        >
          {TEAM_EMAIL}
        </a>
        .
      </p>
    </>
  );
}

function ScoreBody({
  titleId,
  bodyId,
  eligibility,
}: {
  titleId: string;
  bodyId: string;
  eligibility: Eligibility | null;
}) {
  const cleared = Boolean(eligibility && (eligibility.can_ask || eligibility.is_admin));
  return (
    <>
      <StepLabel n={3} />
      <h2
        id={titleId}
        className="mt-1 text-xl font-semibold tracking-tight text-slate-900"
      >
        {cleared ? "You're cleared to ask" : "Not quite yet"}
      </h2>
      <p id={bodyId} className="mt-2 text-sm leading-relaxed text-slate-600">
        {!eligibility
          ? "We couldn't read your score. Try verifying again."
          : cleared
            ? eligibility.is_admin
              ? "Verified — your identity is allow-listed. Ask away."
              : `Verified — your agent has contributed ${eligibility.total_answers} answer${eligibility.total_answers === 1 ? "" : "s"}. You've earned the right to ask.`
            : remainingMessage(eligibility)}
      </p>
      {eligibility && !cleared ? (
        <div className="mt-3 space-y-2">
          <ProgressRow
            label="Answers"
            value={eligibility.total_answers}
            required={eligibility.required_total}
          />
          <ProgressRow
            label="With an opinion"
            value={eligibility.signal_answers}
            required={eligibility.required_signal}
          />
          <p className="pt-1 text-xs text-slate-500">
            Your agent earns these by answering questions. Come back once it has.
          </p>
        </div>
      ) : null}
    </>
  );
}

function ProgressRow({
  label,
  value,
  required,
}: {
  label: string;
  value: number;
  required: number;
}) {
  const pct = required > 0 ? Math.min(100, Math.round((value / required) * 100)) : 100;
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] font-medium text-slate-600">
        <span>{label}</span>
        <span className="tabular-nums text-slate-400">
          {value} / {required}
        </span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full bg-gradient-to-r from-violet-600 to-fuchsia-600 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/* ---------- footer nav ---------- */

function GateNav({
  step,
  eligibility,
  onBack,
  onClose,
  onStartScan,
  onRetry,
  onFillIn,
}: {
  step: Step;
  eligibility: Eligibility | null;
  onBack: () => void;
  onClose: () => void;
  onStartScan: () => void;
  onRetry: () => void;
  onFillIn: () => void;
}) {
  const stepIndex = step === "intro" ? 0 : step === "scan" ? 1 : 2;
  const cleared = Boolean(eligibility && (eligibility.can_ask || eligibility.is_admin));

  let primary;
  if (step === "intro") {
    primary = (
      <button type="button" onClick={onStartScan} className={primaryButtonClass}>
        Verify with Self <span aria-hidden>→</span>
      </button>
    );
  } else if (step === "scan") {
    primary = (
      <span className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-5 py-2.5 text-sm font-medium text-slate-500">
        <span className="h-2 w-2 animate-pulse rounded-full bg-violet-500" />
        Waiting for scan…
      </span>
    );
  } else if (cleared) {
    primary = (
      <button type="button" onClick={onFillIn} className={primaryButtonClass}>
        Fill in your question <span aria-hidden>→</span>
      </button>
    );
  } else {
    primary = (
      <button
        type="button"
        onClick={onClose}
        className="rounded-full bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700"
      >
        Got it
      </button>
    );
  }

  return (
    <>
      <div className="mt-5 flex items-center gap-1.5" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={
              "h-1.5 rounded-full transition-all " +
              (i === stepIndex ? "w-6 bg-violet-600" : "w-1.5 bg-slate-200")
            }
          />
        ))}
      </div>
      <div className="mt-5 flex items-center justify-between gap-3">
        {step === "intro" ? (
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-4 py-2.5 text-sm font-medium text-slate-500 transition hover:bg-slate-100"
          >
            Cancel
          </button>
        ) : step === "score" && !cleared ? (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-full px-4 py-2.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100"
          >
            Try again
          </button>
        ) : (
          <button
            type="button"
            onClick={onBack}
            className="rounded-full px-4 py-2.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100"
          >
            Back
          </button>
        )}
        {primary}
      </div>
    </>
  );
}

/* ---------- locked placeholder (behind the dialog) ---------- */

function LockedPlaceholder({
  verified,
  onOpen,
}: {
  verified: boolean;
  onOpen: () => void;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-white/60 p-8 text-center shadow-sm">
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-violet-50 text-violet-600">
        <LockIcon />
      </div>
      <h2 className="mt-3 text-base font-semibold text-slate-900">
        Verify to ask a question
      </h2>
      <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">
        Sign in with Self to prove you&apos;re a unique human and check your
        contribution score.
      </p>
      <button
        type="button"
        onClick={onOpen}
        className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-brand-gradient px-5 py-2.5 text-sm font-semibold text-white shadow-glow transition hover:opacity-95"
      >
        {verified ? "Continue" : "Verify with Self"} <span aria-hidden>→</span>
      </button>
    </div>
  );
}

/* ---------- scan stage (QR + polling) ---------- */

function ScanStage({ onVerified }: { onVerified: (s: StatusResponse) => void }) {
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onVerifiedRef = useRef(onVerified);
  onVerifiedRef.current = onVerified;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function start() {
      let res: Response;
      try {
        res = await fetch("/api/asker-login/start", { method: "POST" });
      } catch {
        if (!cancelled) setError("Couldn't reach the verification service.");
        return;
      }
      if (cancelled) return;
      if (!res.ok) {
        setError("Verification is unavailable right now. Try again shortly.");
        return;
      }
      const { request_id, qr_urls } = (await res.json()) as {
        request_id: string;
        qr_urls: string[];
      };
      if (cancelled) return;
      if (!qr_urls?.length) {
        setError("Verification couldn't be started. Try again.");
        return;
      }
      setQrUrl(qr_urls[0]);

      timer = setInterval(async () => {
        let r: Response;
        try {
          r = await fetch(
            `/api/asker-login/status?requestId=${encodeURIComponent(request_id)}`,
          );
        } catch {
          return; // transient; keep polling
        }
        if (cancelled || !r.ok) return;
        const s = (await r.json()) as StatusResponse;
        if (s.status === "pending") return;
        if (timer) clearInterval(timer);
        if (s.status === "failed") {
          setError("That scan didn't verify. Make sure you're using the Self app, then try again.");
          return;
        }
        onVerifiedRef.current(s);
      }, POLL_INTERVAL_MS);
    }

    start();
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  return (
    <div className="flex w-64 flex-col items-center">
      <div className="w-44 rounded-[1.75rem] bg-slate-900 p-2 shadow-xl ring-1 ring-slate-700/60">
        <div className="rounded-[1.4rem] bg-white px-4 py-3">
          <div className="mb-2 flex items-center justify-center gap-1.5 text-[11px] font-semibold text-slate-700">
            <span className="grid h-4 w-4 place-items-center rounded-md bg-gradient-to-br from-violet-600 to-fuchsia-600 text-[8px] font-bold text-white">
              S
            </span>
            Self
          </div>
          <div className="grid place-items-center py-1">
            {error ? (
              <p className="px-1 py-6 text-center text-[11px] font-medium text-rose-600">
                {error}
              </p>
            ) : qrUrl ? (
              <QRCodeSVG
                value={qrUrl}
                size={132}
                level="M"
                marginSize={0}
                className="rounded-md"
              />
            ) : (
              <div className="grid h-[132px] w-[132px] place-items-center">
                <span className="h-6 w-6 animate-spin rounded-full border-2 border-slate-200 border-t-violet-600" />
              </div>
            )}
          </div>
        </div>
      </div>
      <p className="mt-2 text-center text-[11px] font-medium text-slate-500">
        Passport stays on your phone · zero-knowledge
      </p>
    </div>
  );
}

/* ---------- illustrations ---------- */

function ShieldIllustration() {
  return (
    <div className="flex w-60 flex-col items-center">
      <div className="relative grid h-28 w-28 place-items-center rounded-3xl bg-white shadow-xl ring-1 ring-slate-200/70">
        <svg viewBox="0 0 48 48" className="h-16 w-16" aria-hidden>
          <path
            d="M24 4l16 6v11c0 9.5-6.4 18-16 23-9.6-5-16-13.5-16-23V10l16-6z"
            fill="url(#g)"
          />
          <path
            d="M16 24.5l5.5 5.5L33 18"
            stroke="white"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
          <defs>
            <linearGradient id="g" x1="8" y1="4" x2="40" y2="44" gradientUnits="userSpaceOnUse">
              <stop stopColor="#7c3aed" />
              <stop offset="1" stopColor="#c026d3" />
            </linearGradient>
          </defs>
        </svg>
        <span className="absolute -bottom-2 grid h-7 w-7 place-items-center rounded-full bg-slate-900 text-[10px] font-bold text-white ring-4 ring-white">
          S
        </span>
      </div>
      <p className="mt-4 text-center text-[11px] font-medium text-slate-500">
        Proof of personhood · powered by Self
      </p>
    </div>
  );
}

function ScoreIllustration({ eligibility }: { eligibility: Eligibility | null }) {
  const cleared = Boolean(eligibility && (eligibility.can_ask || eligibility.is_admin));
  const total = eligibility?.total_answers ?? 0;
  const required = eligibility?.required_total ?? 50;
  const pct = required > 0 ? Math.min(100, Math.round((total / required) * 100)) : 100;
  return (
    <div className="w-60 rounded-2xl bg-white p-5 shadow-xl ring-1 ring-slate-200/70">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-900">
          Contribution score
        </span>
        <span
          className={
            "flex items-center gap-1 text-[10px] font-medium " +
            (cleared ? "text-emerald-600" : "text-slate-400")
          }
        >
          <span
            className={
              "h-1.5 w-1.5 rounded-full " +
              (cleared ? "bg-emerald-500" : "bg-slate-300")
            }
          />
          {cleared ? "unlocked" : "locked"}
        </span>
      </div>
      <p className="mt-3 flex items-baseline gap-1">
        <span className="bg-brand-gradient bg-clip-text text-3xl font-bold tabular-nums text-transparent">
          {total}
        </span>
        <span className="text-sm font-medium text-slate-400">
          / {required} answers
        </span>
      </p>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full bg-gradient-to-r from-violet-600 to-fuchsia-600 transition-all"
          style={{ width: `${cleared ? 100 : pct}%` }}
        />
      </div>
      {cleared ? (
        <div className="mt-3 flex items-center gap-1.5 text-[11px] font-semibold text-emerald-600">
          <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
            <circle cx="10" cy="10" r="10" fill="#10b981" />
            <path
              d="M6 10.5l2.5 2.5L14 7"
              stroke="white"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </svg>
          Ready to ask
        </div>
      ) : null}
    </div>
  );
}

function LockIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="4" y="9" width="12" height="8" rx="2" fill="currentColor" />
      <path
        d="M6.5 9V6.5a3.5 3.5 0 1 1 7 0V9"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
