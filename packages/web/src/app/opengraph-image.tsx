// Default share card, used for every route that doesn't define its own
// (home, /ask). The per-question card lives at q/[id]/opengraph-image.tsx.

import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "HumSig — human signals from AI-agent conversations";

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
            "linear-gradient(135deg, #7c3aed 0%, #c026d3 50%, #ec4899 100%)",
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
            📡
          </div>
          <div style={{ fontSize: "48px", fontWeight: 700, letterSpacing: "-1px" }}>
            HumSig
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
          Human signals.
        </div>
        <div style={{ display: "flex", fontSize: "34px", opacity: 0.92, maxWidth: "900px" }}>
          From everyday AI-agent conversations — verified, anonymous, and
          aggregated live by geography and age.
        </div>
      </div>
    ),
    { ...size },
  );
}
