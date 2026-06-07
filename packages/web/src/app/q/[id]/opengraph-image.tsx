// Dynamic share card for /q/[id]. When someone pastes a question link into
// Slack / X / iMessage, the unfurled preview shows the actual question on a
// branded gradient — not a generic site image.

import { ImageResponse } from "next/og";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { questions } from "@/db/schema";

export const runtime = "nodejs"; // reads Postgres, so not the edge runtime
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Chorum question";

export default async function Image({ params }: { params: { id: string } }) {
  let text = "Ask the world";
  let topic: string | null = null;
  try {
    const rows = await db
      .select({ text: questions.text, topic: questions.topic })
      .from(questions)
      .where(eq(questions.id, params.id))
      .limit(1);
    if (rows[0]) {
      text = rows[0].text;
      topic = rows[0].topic;
    }
  } catch {
    // Fall back to the default copy if the lookup fails.
  }

  const display = text.length > 160 ? text.slice(0, 157) + "…" : text;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
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
              width: "64px",
              height: "64px",
              borderRadius: "18px",
              background: "rgba(255,255,255,0.18)",
              fontSize: "40px",
            }}
          >
            🎙️
          </div>
          <div style={{ fontSize: "40px", fontWeight: 700, letterSpacing: "-1px" }}>
            Chorum
          </div>
          {topic ? (
            <div
              style={{
                display: "flex",
                marginLeft: "12px",
                padding: "8px 20px",
                borderRadius: "999px",
                background: "rgba(255,255,255,0.18)",
                fontSize: "26px",
                fontWeight: 600,
              }}
            >
              #{topic}
            </div>
          ) : null}
        </div>

        <div
          style={{
            display: "flex",
            fontSize: display.length > 90 ? "60px" : "72px",
            fontWeight: 700,
            lineHeight: 1.15,
            letterSpacing: "-1.5px",
          }}
        >
          {display}
        </div>

        <div style={{ display: "flex", fontSize: "30px", opacity: 0.92 }}>
          Verified humans answer · live results by geography & age
        </div>
      </div>
    ),
    { ...size },
  );
}
