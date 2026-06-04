"use client";

// "Get heard" — the supply-side explainer/simulator. Where "How it works"
// pitches askers, this walks a would-be respondent through plugging the
// WorldSignal add-on into the agent they already run (Openclaw, Hermes, …),
// verifying once with Self, and then earning as their agent answers polls on
// their behalf.
//
// Split in two:
//   • EarnExplainerDialog — the controlled walkthrough (open/onClose). Reused by
//     the header trigger AND the home hero's "Add your signal" CTA.
//   • EarnExplainer — the header trigger button that owns its own open state.
//
// Each step's illustration is a small live simulation driven by a `tick` that
// advances while the modal sits on that step: the install log streams in, the
// Self check flips to verified, questions arrive and get answered, and the
// earnings counter climbs.

import { useEffect, useId, useState } from "react";
import {
  OnboardingDialog,
  StepNav,
  primaryButtonClass,
} from "./onboarding-dialog";

// The setup guide lives with the skill package on GitHub.
const SKILL_DOCS_URL = "https://github.com/josojo/hearme/tree/main/packages/skill";

type Step = {
  title: string;
  body: string;
  illustration: (tick: number) => JSX.Element;
};

const STEPS: Step[] = [
  {
    title: "Add WorldSignal to your agent",
    body: "Drop the WorldSignal add-on into the agent you already run — Openclaw, Hermes, or any open runtime. One command wires it in.",
    illustration: TerminalIllustration,
  },
  {
    title: "Verify once with Self",
    body: "Scan your ID with Self (self.xyz). A zero-knowledge proof confirms you're a unique human — your passport never leaves your phone, and nobody learns who you are.",
    illustration: VerifyIllustration,
  },
  {
    title: "Your agent answers for you",
    body: "Questions stream in. Your agent infers your take from your everyday chats, anonymizes and signs it, and submits — always within the limits you set. Override anything, anytime.",
    illustration: FeedIllustration,
  },
  {
    title: "Get heard — and earn",
    body: "Every answer gets your signal counted. Today it earns you the right to ask questions of your own; cash payouts are coming. Set your policy once and it runs quietly in the background. Sell your signal — don't give it away.",
    illustration: EarningsIllustration,
  },
];

// Controlled walkthrough. Callers own `open` and supply `onClose`.
export function EarnExplainerDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [step, setStep] = useState(0);
  const [tick, setTick] = useState(0);
  const titleId = useId();
  const bodyId = useId();

  // Reset to the first step every time the dialog opens.
  useEffect(() => {
    if (open) setStep(0);
  }, [open]);

  // Drive the per-step simulation. Resets whenever the step (or open) changes
  // so each illustration animates from the start.
  useEffect(() => {
    if (!open) return;
    setTick(0);
    const id = setInterval(() => setTick((t) => t + 1), 650);
    return () => clearInterval(id);
  }, [open, step]);

  const isLast = step === STEPS.length - 1;
  const current = STEPS[step];

  return (
    <OnboardingDialog
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      describedBy={bodyId}
      illustration={current.illustration(tick)}
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-violet-600">
        For agents · step {step + 1} of {STEPS.length}
      </p>
      <h2
        id={titleId}
        className="mt-1 text-xl font-semibold tracking-tight text-slate-900"
      >
        {current.title}
      </h2>
      <p id={bodyId} className="mt-2 text-sm leading-relaxed text-slate-600">
        {current.body}
      </p>

      <StepNav
        step={step}
        count={STEPS.length}
        onBack={() => setStep((s) => s - 1)}
        onSkip={onClose}
        primary={
          isLast ? (
            <a
              href={SKILL_DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={onClose}
              className={primaryButtonClass}
            >
              Get the skill <span aria-hidden>↗</span>
            </a>
          ) : (
            <button
              type="button"
              onClick={() => setStep((s) => s + 1)}
              className={primaryButtonClass}
            >
              Next
            </button>
          )
        }
      />
    </OnboardingDialog>
  );
}

// Header trigger: the "Get heard" chip plus the dialog it opens.
export function EarnExplainer() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-full bg-violet-50 px-3 py-1.5 font-medium text-violet-700 transition hover:bg-violet-100"
      >
        <MicIcon />
        <span className="hidden sm:inline">Get heard</span>
      </button>

      <EarnExplainerDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/* ---------- icons ---------- */

function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="7.5" y="2.5" width="5" height="9" rx="2.5" fill="currentColor" />
      <path
        d="M5 9a5 5 0 0 0 10 0M10 14v3.5M7.5 17.5h5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MaskIcon({ size = 14 }: { size?: number }) {
  // Domino mask = "anonymous"; eye holes match the slate-800 disc behind it.
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden>
      <rect x="3.5" y="6.5" width="13" height="6.2" rx="3.1" fill="white" />
      <circle cx="7.4" cy="9.6" r="1.1" fill="#1e293b" />
      <circle cx="12.6" cy="9.6" r="1.1" fill="#1e293b" />
    </svg>
  );
}

/* ---------- per-step simulations ---------- */

const TERMINAL_LINES = [
  { text: "$ hearme-skill onboard", className: "text-slate-100" },
  { text: "✓ agent key generated", className: "text-emerald-400" },
  { text: "✓ linked to Hermes / Openclaw", className: "text-emerald-400" },
  { text: "✓ ready to verify", className: "text-emerald-400" },
];

function TerminalIllustration(tick: number) {
  const shown = Math.min(TERMINAL_LINES.length, tick + 1);
  const done = shown === TERMINAL_LINES.length;
  return (
    <div className="w-72 overflow-hidden rounded-xl bg-slate-900 shadow-xl ring-1 ring-slate-700/60">
      <div className="flex items-center gap-1.5 border-b border-white/10 px-3 py-2">
        <span className="h-2.5 w-2.5 rounded-full bg-rose-400/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/80" />
        <span className="ml-1.5 text-[10px] font-medium text-slate-400">
          your agent
        </span>
      </div>
      <div className="space-y-1 p-3 font-mono text-[11px] leading-relaxed">
        {TERMINAL_LINES.slice(0, shown).map((l, i) => (
          <div key={i} className={l.className}>
            {l.text}
          </div>
        ))}
        <span
          className={
            "inline-block " + (done ? "text-emerald-400" : "animate-pulse text-slate-500")
          }
        >
          ▋
        </span>
      </div>
    </div>
  );
}

function VerifyIllustration(tick: number) {
  const verified = tick >= 2;
  return (
    <div className="flex w-64 flex-col items-center">
      <div className="w-40 rounded-[1.75rem] bg-slate-900 p-2 shadow-xl ring-1 ring-slate-700/60">
        <div className="rounded-[1.4rem] bg-white px-4 py-3">
          <div className="mb-2 flex items-center justify-center gap-1.5 text-[11px] font-semibold text-slate-700">
            <span className="grid h-4 w-4 place-items-center rounded-md bg-gradient-to-br from-violet-600 to-fuchsia-600 text-[8px] font-bold text-white">
              S
            </span>
            Self
          </div>
          {verified ? (
            <div className="flex flex-col items-center py-3">
              <svg viewBox="0 0 40 40" className="h-12 w-12" aria-hidden>
                <circle cx="20" cy="20" r="20" fill="#7c3aed" />
                <path
                  d="M12 21l5 5 11-12"
                  stroke="white"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              </svg>
              <p className="mt-2 text-xs font-semibold text-slate-900">Verified</p>
              <p className="text-[10px] text-slate-500">unique human</p>
            </div>
          ) : (
            <div className="flex flex-col items-center py-1">
              <QrMock />
              <p className="mt-2 text-center text-[10px] text-slate-500">
                Scan to prove you&apos;re human
              </p>
            </div>
          )}
        </div>
      </div>
      <p className="mt-2 text-center text-[11px] font-medium text-slate-500">
        Passport stays on your phone · zero-knowledge
      </p>
    </div>
  );
}

function QrMock() {
  // A deterministic pseudo-QR so the mock looks the part without an asset.
  const cells = Array.from({ length: 49 }, (_, i) => {
    const r = Math.floor(i / 7);
    const c = i % 7;
    const corner = (r < 2 && c < 2) || (r < 2 && c > 4) || (r > 4 && c < 2);
    return corner || (i * 7 + 3) % 5 < 2;
  });
  return (
    <div className="grid grid-cols-7 gap-0.5 rounded-md bg-white p-1.5 ring-1 ring-slate-200">
      {cells.map((on, i) => (
        <span
          key={i}
          className={"h-2.5 w-2.5 rounded-[1px] " + (on ? "bg-slate-900" : "bg-transparent")}
        />
      ))}
    </div>
  );
}

const INCOMING = [
  { q: "Is remote work here to stay?", a: "Yes" },
  { q: "Upgrading your phone this year?", a: "No" },
  { q: "Coffee or tea in the morning?", a: "Coffee" },
];

function FeedIllustration(tick: number) {
  const shown = Math.min(INCOMING.length, tick + 1);
  return (
    <div className="w-72 space-y-2">
      {INCOMING.slice(0, shown).map((it, i) => (
        <div
          key={i}
          className="flex items-center gap-2 rounded-xl bg-white p-2.5 shadow-md ring-1 ring-slate-200/70"
        >
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-slate-800">
            <MaskIcon size={13} />
          </span>
          <span className="flex-1 truncate text-[11px] font-medium text-slate-700">
            {it.q}
          </span>
          <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-600">
            {it.a}
          </span>
        </div>
      ))}
      <div className="flex items-center justify-center gap-1.5 pt-0.5 text-[11px] font-medium text-slate-500">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
        answering automatically · you can veto
      </div>
    </div>
  );
}

function EarningsIllustration(tick: number) {
  const answered = 1284 + tick * 7;
  return (
    <div className="w-64 rounded-2xl bg-white p-5 shadow-xl ring-1 ring-slate-200/70">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-900">Your signal, counted</span>
        <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-600">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
          live
        </span>
      </div>
      <p className="mt-3 bg-brand-gradient bg-clip-text text-3xl font-bold tabular-nums text-transparent">
        {answered.toLocaleString()}
      </p>
      <p className="mt-1 text-[11px] text-slate-500">
        answers this month · unlocks asking{" "}
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
          payouts coming
        </span>
      </p>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full bg-gradient-to-r from-violet-600 to-fuchsia-600 transition-all"
          style={{ width: `${Math.min(100, 42 + tick * 6)}%` }}
        />
      </div>
    </div>
  );
}
