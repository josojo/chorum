"use client";

// Keeps a server-rendered page genuinely live without websockets/SSE: it calls
// router.refresh() on an interval, which re-runs the server component and
// reconciles fresh aggregates into the tree. Pauses while the tab is hidden so
// background tabs don't poll, and refreshes once on regaining focus.
//
// Renders a small "Live" badge so the on-page promise matches reality.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export function LiveRefresh({ intervalMs = 12000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    const refresh = () => {
      setPulse(true);
      router.refresh();
      setTimeout(() => setPulse(false), 700);
    };

    const id = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, intervalMs);

    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router, intervalMs]);

  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600"
      title="Results refresh automatically"
    >
      <span
        className={
          "h-1.5 w-1.5 rounded-full bg-emerald-500 " +
          (pulse ? "animate-ping" : "animate-pulse")
        }
        aria-hidden
      />
      Live
    </span>
  );
}
