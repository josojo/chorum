"use client";

// Shared chrome for the onboarding click-throughs (How it works / Get heard).
//
// `OnboardingDialog` owns the modal shell: backdrop, card, close button, the
// gradient illustration stage, Escape-to-close, body scroll-lock, and moving
// focus into the dialog. `StepNav` owns the footer shared by both flows: the
// progress dots plus a Back/Skip control on the left and a caller-supplied
// primary action on the right.
//
// Callers keep their own open/step state and supply the illustration, the step
// copy, and the primary action.

import { useEffect, useRef, type ReactNode } from "react";

export function OnboardingDialog({
  open,
  onClose,
  labelledBy,
  describedBy,
  illustration,
  children,
}: {
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  describedBy?: string;
  illustration: ReactNode;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="onb-backdrop fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-4 backdrop-blur-sm sm:items-center"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="onb-card relative w-full max-w-md overflow-hidden rounded-3xl bg-white shadow-2xl outline-none"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 z-10 grid h-8 w-8 place-items-center rounded-full bg-white/70 text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
        >
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
            <path
              d="M5 5l10 10M15 5L5 15"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </button>

        <div className="relative flex h-56 items-center justify-center overflow-hidden bg-gradient-to-br from-violet-50 via-white to-rose-50">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-rose-200/40 blur-3xl"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-20 -left-12 h-48 w-48 rounded-full bg-violet-200/40 blur-3xl"
          />
          <div className="relative">{illustration}</div>
        </div>

        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}

export function StepNav({
  step,
  count,
  onBack,
  onSkip,
  primary,
}: {
  step: number;
  count: number;
  onBack: () => void;
  onSkip: () => void;
  /** Right-aligned primary action (a Next button or a final CTA). */
  primary: ReactNode;
}) {
  return (
    <>
      <div className="mt-5 flex items-center gap-1.5" aria-hidden>
        {Array.from({ length: count }).map((_, i) => (
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
            onClick={onBack}
            className="rounded-full px-4 py-2.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100"
          >
            Back
          </button>
        ) : (
          <button
            type="button"
            onClick={onSkip}
            className="rounded-full px-4 py-2.5 text-sm font-medium text-slate-500 transition hover:bg-slate-100"
          >
            Skip
          </button>
        )}
        {primary}
      </div>
    </>
  );
}

/** The gradient pill shared by the Next buttons and final CTAs. */
export const primaryButtonClass =
  "inline-flex items-center gap-1.5 rounded-full bg-brand-gradient px-6 py-2.5 text-sm font-semibold text-white shadow-glow transition hover:opacity-95";
