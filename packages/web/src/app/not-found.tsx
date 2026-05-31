// App Router not-found boundary. Rendered for notFound() calls (e.g. an unknown
// or malformed /q/[id]) and for unmatched routes. Server component — mirrors the
// inline-style / CSS-var conventions used in layout.tsx.
import Link from "next/link";

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

export default function NotFound() {
  return (
    <div style={WRAP_STYLE}>
      <h1 style={TITLE_STYLE}>Question not found</h1>
      <p style={BODY_STYLE}>
        This question doesn&apos;t exist, or the link is no longer valid.
      </p>
      <Link href="/" style={{ fontWeight: 600 }}>
        ← Back to home
      </Link>
    </div>
  );
}
