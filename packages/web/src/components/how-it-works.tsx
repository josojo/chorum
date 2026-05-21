"use client";

// "How it works" — a small click-through that explains hearme in three steps,
// modeled on the onboarding popover found on prediction-market sites. Renders
// its own trigger button (drop it anywhere) plus the modal it opens.
//
// It auto-opens once per browser on first visit, gated behind a localStorage
// flag, then stays available behind the header button forever after.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const SEEN_KEY = "hearme:how-it-works-seen-v1";

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
    title: "Real humans answer",
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();

  const close = useCallback(() => {
    setOpen(false);
    try {
      window.localStorage.setItem(SEEN_KEY, "1");
    } catch {
      // localStorage can throw in private mode; ignore — worst case it re-opens.
    }
  }, []);

  const start = useCallback(() => {
    setStep(0);
    setOpen(true);
  }, []);

  // Auto-open once on a visitor's first ever visit.
  useEffect(() => {
    let seen = "1";
    try {
      seen = window.localStorage.getItem(SEEN_KEY) ?? "";
    } catch {
      seen = "1"; // can't read storage → don't nag.
    }
    if (!seen) setOpen(true);
  }, []);

  // Escape to close, and lock body scroll while open. Focus the dialog so the
  // keyboard lands inside it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, close]);

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

      {open ? (
        <div
          className="hiw-backdrop fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-4 backdrop-blur-sm sm:items-center"
          onClick={close}
          role="presentation"
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={bodyId}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            className="hiw-card relative w-full max-w-md overflow-hidden rounded-3xl bg-white shadow-2xl outline-none"
          >
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              className="absolute right-4 top-4 z-10 grid h-8 w-8 place-items-center rounded-full bg-white/70 text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
            >
              <CloseIcon />
            </button>

            {/* Illustration stage. */}
            <div className="relative flex h-56 items-center justify-center overflow-hidden bg-gradient-to-br from-violet-50 via-white to-fuchsia-50">
              <div
                aria-hidden
                className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-fuchsia-200/40 blur-3xl"
              />
              <div
                aria-hidden
                className="pointer-events-none absolute -bottom-20 -left-12 h-48 w-48 rounded-full bg-violet-200/40 blur-3xl"
              />
              <div className="relative">{current.illustration()}</div>
            </div>

            <div className="p-6">
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

              {/* Step dots. */}
              <div className="mt-5 flex items-center gap-1.5" aria-hidden>
                {STEPS.map((_, i) => (
                  <span
                    key={i}
                    className={
                      "h-1.5 rounded-full transition-all " +
                      (i === step ? "w-6 bg-violet-600" : "w-1.5 bg-slate-200")
                    }
                  />
                ))}
              </div>

              <div className="mt-5 flex items-center justify-between gap-3">
                {step > 0 ? (
                  <button
                    type="button"
                    onClick={() => setStep((s) => s - 1)}
                    className="rounded-full px-4 py-2.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100"
                  >
                    Back
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={close}
                    className="rounded-full px-4 py-2.5 text-sm font-medium text-slate-500 transition hover:bg-slate-100"
                  >
                    Skip
                  </button>
                )}

                {isLast ? (
                  <button
                    type="button"
                    onClick={() => {
                      close();
                      router.push("/ask");
                    }}
                    className="inline-flex items-center gap-1.5 rounded-full bg-brand-gradient px-6 py-2.5 text-sm font-semibold text-white shadow-glow transition hover:opacity-95"
                  >
                    Ask a question <span aria-hidden>→</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setStep((s) => s + 1)}
                    className="rounded-full bg-brand-gradient px-6 py-2.5 text-sm font-semibold text-white shadow-glow transition hover:opacity-95"
                  >
                    Next
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}
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

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path
        d="M5 5l10 10M15 5L5 15"
        stroke="currentColor"
        strokeWidth="1.8"
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
