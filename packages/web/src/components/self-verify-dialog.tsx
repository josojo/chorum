"use client";

// The "verify to ask" modal: a big Self QR that dominates the dialog plus a
// single line telling the user what to do. On open it asks the server for a
// fresh verification request, renders the returned universal link as a large QR,
// and polls until the Self app's proof verifies — at which point the server has
// already set the asker session cookie and we fire onVerified().

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";

type Status = "loading" | "ready" | "verified" | "error";

export function SelfVerifyDialog({
  open,
  onClose,
  onVerified,
}: {
  open: boolean;
  onClose: () => void;
  onVerified: () => void;
}) {
  const [status, setStatus] = useState<Status>("loading");
  const [qr, setQr] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  // Keep onVerified out of the effect deps so the request/poll lifecycle isn't
  // restarted on every parent re-render.
  const onVerifiedRef = useRef(onVerified);
  onVerifiedRef.current = onVerified;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let requestId: string | null = null;
    setStatus("loading");
    setQr(null);
    setMessage("");

    const poll = () => {
      timer = setTimeout(async () => {
        if (cancelled || !requestId) return;
        try {
          const res = await fetch(`/api/ask-verify/poll?id=${encodeURIComponent(requestId)}`);
          const data = await res.json();
          if (cancelled) return;
          if (data.verified) {
            setStatus("verified");
            setTimeout(() => !cancelled && onVerifiedRef.current(), 900);
            return;
          }
          if (data.failed) setMessage("That proof didn't verify — re-scan to try again.");
          poll();
        } catch {
          if (!cancelled) poll();
        }
      }, 2500);
    };

    (async () => {
      try {
        const res = await fetch("/api/ask-verify/start", { method: "POST" });
        if (!res.ok) throw new Error("start failed");
        const { requestId: id, url } = await res.json();
        if (cancelled) return;
        requestId = id;
        const dataUrl = await QRCode.toDataURL(url, {
          errorCorrectionLevel: "L",
          margin: 1,
          width: 512,
        });
        if (cancelled) return;
        setQr(dataUrl);
        setStatus("ready");
        poll();
      } catch {
        if (!cancelled) {
          setStatus("error");
          setMessage("Couldn't start verification. Close and try again.");
        }
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [open]);

  // Escape to close + body scroll lock while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-4 backdrop-blur-sm sm:items-center"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Verify with Self to ask"
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-sm rounded-3xl bg-white p-6 text-center shadow-2xl"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 grid h-8 w-8 place-items-center rounded-full bg-white/70 text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
        >
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
            <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>

        {status === "verified" ? (
          <div className="flex flex-col items-center py-10">
            <svg viewBox="0 0 40 40" className="h-16 w-16" aria-hidden>
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
            <p className="mt-3 text-lg font-semibold text-slate-900">Verified</p>
            <p className="text-sm text-slate-500">You can post your question now.</p>
          </div>
        ) : (
          <>
            {/* The QR is the hero: it fills the bulk of the dialog. */}
            <div className="mx-auto flex aspect-square w-full max-w-[20rem] items-center justify-center overflow-hidden rounded-2xl bg-white ring-1 ring-slate-200">
              {qr ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={qr} alt="Self verification QR code" className="h-full w-full" />
              ) : (
                <span className="text-sm text-slate-400">
                  {status === "error" ? "Unavailable" : "Generating QR…"}
                </span>
              )}
            </div>
            <p className="mt-4 text-base font-medium text-slate-900">
              Scan the code with the Self app
            </p>
            {message ? (
              <p className="mt-2 text-sm text-rose-600">{message}</p>
            ) : (
              <p className="mt-1 text-xs text-slate-500">
                Proves you&apos;re a unique human · your passport never leaves your phone
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
