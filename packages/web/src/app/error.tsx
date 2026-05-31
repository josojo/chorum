"use client";

// App Router error boundary. Next.js requires error boundaries to be client
// components ("use client"). Catches uncaught errors thrown while rendering a
// route (e.g. a DB query failure) so the user sees a recoverable screen instead
// of a raw 500. Mirrors the inline-style / CSS-var conventions in layout.tsx.
import { useEffect } from "react";

const WRAP_STYLE: React.CSSProperties = {
  textAlign: "center",
  padding: "3rem 1.5rem",
};

const TITLE_STYLE: React.CSSProperties = {
  fontWeight: 700,
  letterSpacing: "-0.02em",
  marginBottom: "0.5rem",
};

const BODY_STYLE: React.CSSProperties = {
  color: "var(--muted)",
  marginBottom: "1.5rem",
};

const BUTTON_STYLE: React.CSSProperties = {
  fontWeight: 600,
  padding: "0.5rem 1rem",
  border: "1px solid var(--border)",
  borderRadius: "0.375rem",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
};

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface the error for diagnostics; the UI never shows raw details.
    console.error(error);
  }, [error]);

  return (
    <div style={WRAP_STYLE}>
      <h1 style={TITLE_STYLE}>Something went wrong</h1>
      <p style={BODY_STYLE}>
        We couldn&apos;t load this page. Please try again.
      </p>
      <button type="button" style={BUTTON_STYLE} onClick={() => reset()}>
        Try again
      </button>
    </div>
  );
}
