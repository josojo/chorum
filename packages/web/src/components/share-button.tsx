"use client";

// Share / copy-link control for a question page. Uses the native share sheet
// when available (mobile), otherwise copies the URL to the clipboard and
// briefly confirms. Reads the URL at click time so it works regardless of how
// the page was reached.

import { useState } from "react";

export function ShareButton({ title }: { title: string }) {
  const [copied, setCopied] = useState(false);

  async function onShare() {
    const url = typeof window !== "undefined" ? window.location.href : "";
    if (!url) return;

    // Prefer the OS share sheet on devices that have one.
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title: "HumSig", text: title, url });
        return;
      } catch {
        // User dismissed the sheet, or share failed — fall through to copy.
      }
    }

    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (insecure context / permissions) — last resort.
      window.prompt("Copy this link:", url);
    }
  }

  return (
    <button
      type="button"
      onClick={onShare}
      aria-live="polite"
      className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700 shadow-sm transition hover:border-violet-300 hover:text-violet-700"
    >
      {copied ? (
        <>
          <CheckIcon /> Link copied
        </>
      ) : (
        <>
          <ShareIcon /> Share
        </>
      )}
    </button>
  );
}

function ShareIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden>
      <circle cx="15" cy="4.5" r="2.2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="5" cy="10" r="2.2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="15" cy="15.5" r="2.2" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M7 8.9l6-3.3M7 11.1l6 3.3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path
        d="M4 10.5l4 4 8-9"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
