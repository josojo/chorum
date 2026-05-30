"use client";

// "How it works" — a small click-through that explains hearme in three steps,
// modeled on the onboarding popover found on prediction-market sites. Renders
// its own trigger button (drop it anywhere) plus the modal it opens.
//
// It stays available behind the header button.

import { useCallback, useId, useState } from "react";
import { useRouter } from "next/navigation";
import {
  OnboardingDialog,
  StepNav,
  primaryButtonClass,
} from "./onboarding-dialog";

type Step = {
  title: string;
  body: string;
  illustration: () => JSX.Element;
};

const STEPS: Step[] = [
  {
    title: "Ask anyone, anywhere",
    body: "Post a question and choose who you want to hear from — the whole world, your continent, or just your country.",
    illustration: AskIllustration,
  },
  {
    title: "Personal agent infer answer",
    body: "Nobody fills out a poll. A person's agent infers their answer from their everyday chats, anonymizes it, and submits it for them — proven human with Self, never a bot. The agent speaks so people don't have to.",
    illustration: AnswerIllustration,
  },
  {
    title: "Watch live, private results",
    body: "Counts update in real time, broken down by geography and age. You only ever see the aggregate — individual answers stay private.",
    illustration: ResultsIllustration,
  },
];

export function HowItWorks() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const router = useRouter();
  const titleId = useId();
  const bodyId = useId();

  const close = useCallback(() => {
    setOpen(false);
  }, []);

  const start = useCallback(() => {
    setStep(0);
    setOpen(true);
  }, []);

  const isLast = step === STEPS.length - 1;
  const current = STEPS[step];

  return (
    <>
      <button
        type="button"
        onClick={start}
        className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 font-medium text-slate-700 transition hover:bg-slate-100"
      >
        <InfoIcon />
        <span className="hidden sm:inline">How it works</span>
      </button>

      <OnboardingDialog
        open={open}
        onClose={close}
        labelledBy={titleId}
        describedBy={bodyId}
        illustration={current.illustration()}
      >
        <p className="text-xs font-semibold uppercase tracking-wide text-violet-600">
          Step {step + 1} of {STEPS.length}
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
          onSkip={close}
          primary={
            isLast ? (
              <button
                type="button"
                onClick={() => {
                  close();
                  router.push("/ask");
                }}
                className={primaryButtonClass}
              >
                Ask a question <span aria-hidden>→</span>
              </button>
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
    </>
  );
}

/* ---------- icons ---------- */

function InfoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
      <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="10" cy="6.4" r="1" fill="currentColor" />
      <path
        d="M10 9v5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckBadge({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden>
      <circle cx="10" cy="10" r="10" fill="#7c3aed" />
      <path
        d="M6 10.5l2.5 2.5L14 7"
        stroke="white"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

/* ---------- per-step illustrations (composed mockups) ---------- */

function AskIllustration() {
  return (
    <div className="w-64 rotate-[-2deg] rounded-2xl bg-white p-4 shadow-xl ring-1 ring-slate-200/70">
      <p className="text-sm font-semibold leading-snug text-slate-900">
        Should remote work stay the norm?
      </p>
      <div className="mt-3 grid grid-cols-3 gap-1.5">
        <ScopeChip icon="🌍" label="World" active />
        <ScopeChip icon="🗺️" label="Region" />
        <ScopeChip icon="📍" label="Country" />
      </div>
    </div>
  );
}

function ScopeChip({
  icon,
  label,
  active = false,
}: {
  icon: string;
  label: string;
  active?: boolean;
}) {
  return (
    <div
      className={
        "flex flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 text-[10px] font-medium " +
        (active
          ? "bg-gradient-to-br from-violet-600 to-fuchsia-600 text-white"
          : "bg-slate-100 text-slate-600")
      }
    >
      <span className="text-sm leading-none" aria-hidden>
        {icon}
      </span>
      <span>{label}</span>
    </div>
  );
}

function AnswerIllustration() {
  return (
    <div className="w-64 space-y-2">
      {/* The everyday chat the agent infers the answer from. */}
      <div className="rounded-2xl bg-white p-3 shadow-md ring-1 ring-slate-200/70">
        <div className="mb-2 flex items-center gap-1.5 text-[10px] font-medium text-slate-400">
          <span className="h-4 w-4 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500" />
          your daily chat
        </div>
        <div className="flex justify-end">
          <div className="rounded-2xl rounded-br-sm bg-violet-600 px-2.5 py-1.5">
            <span className="block h-1.5 w-20 rounded-full bg-white/70" />
          </div>
        </div>
        <div className="mt-1.5 flex justify-start">
          <div className="space-y-1 rounded-2xl rounded-bl-sm bg-slate-100 px-2.5 py-1.5">
            <span className="block h-1.5 w-16 rounded-full bg-slate-300" />
            <span className="block h-1.5 w-10 rounded-full bg-slate-300" />
          </div>
        </div>
      </div>

      {/* Inferred + anonymized on the way to the poll. */}
      <div className="flex items-center justify-center gap-1 text-[10px] font-medium text-slate-400">
        <DownArrow />
        infers &amp; anonymizes
      </div>

      {/* The anonymous answer dropped straight into the poll. */}
      <div className="flex items-center gap-2.5 rounded-xl bg-white p-2.5 shadow-md ring-1 ring-slate-200/70">
        <div className="grid h-8 w-8 place-items-center rounded-full bg-slate-800">
          <MaskIcon />
        </div>
        <span className="flex-1 text-[11px] font-medium text-slate-600">
          anonymous answer
        </span>
        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-600">
          Yes
        </span>
      </div>

      <div className="flex items-center justify-center gap-1.5 pt-0.5 text-[11px] font-medium text-slate-500">
        <CheckBadge className="h-3.5 w-3.5" />
        Verified human · powered by Self
      </div>
    </div>
  );
}

function DownArrow() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 3v9M4.5 8.5L8 12l3.5-3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MaskIcon() {
  // A domino mask — reads as "anonymous". Eye holes match the slate-800 disc.
  return (
    <svg width="15" height="15" viewBox="0 0 20 20" aria-hidden>
      <rect x="3.5" y="6.5" width="13" height="6.2" rx="3.1" fill="white" />
      <circle cx="7.4" cy="9.6" r="1.1" fill="#1e293b" />
      <circle cx="12.6" cy="9.6" r="1.1" fill="#1e293b" />
    </svg>
  );
}

function ResultsIllustration() {
  const bars = [
    { label: "Yes", pct: 72, value: 1840 },
    { label: "No", pct: 28, value: 716 },
  ];
  return (
    <div className="w-64 rounded-2xl bg-white p-4 shadow-xl ring-1 ring-slate-200/70">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-900">Live results</span>
        <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-600">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
          live
        </span>
      </div>
      <div className="mt-3 space-y-2.5">
        {bars.map((b) => (
          <div key={b.label}>
            <div className="flex items-center justify-between text-[11px] font-medium text-slate-600">
              <span>{b.label}</span>
              <span className="tabular-nums text-slate-400">{b.value}</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-gradient-to-r from-violet-600 to-fuchsia-600"
                style={{ width: `${b.pct}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-1">
        {["🇺🇸", "🇩🇪", "🇧🇷", "🇯🇵", "🇮🇳"].map((f) => (
          <span
            key={f}
            className="grid h-5 w-5 place-items-center rounded-full bg-slate-100 text-[10px]"
          >
            {f}
          </span>
        ))}
      </div>
    </div>
  );
}
