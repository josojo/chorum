// Default share card, used for every route that doesn't define its own
// (home, /ask). The per-question card lives at q/[id]/opengraph-image.tsx.

import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Chorum — many voices, one signal";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: "28px",
          padding: "72px",
          background:
            "linear-gradient(135deg, #7c3aed 0%, #0d9488 55%, #10b981 100%)",
          color: "white",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: "72px",
              height: "72px",
              borderRadius: "20px",
              background: "rgba(255,255,255,0.18)",
              fontSize: "44px",
            }}
          >
            🎙️
          </div>
          <div style={{ fontSize: "48px", fontWeight: 700, letterSpacing: "-1px" }}>
            Chorum
          </div>
        </div>
        <div
          style={{
            display: "flex",
            fontSize: "76px",
            fontWeight: 700,
            lineHeight: 1.1,
            letterSpacing: "-2px",
          }}
        >
          Many voices. One clear signal.
        </div>
        <div style={{ display: "flex", fontSize: "34px", opacity: 0.92, maxWidth: "900px" }}>
          Your agent adds just your voice from the AI conversations you already
          have — verified human, anonymous, aggregated live by geography and age.
        </div>
      </div>
    ),
    { ...size },
  );
}
