"use client";

// Stylised SVG world map. Each continent is a single <path> coloured by how
// that continent voted — a red→amber→green diverging scale on the yes-share
// (yes / (yes + no)), NOT by how many people answered. The number rendered on
// each continent is still the total response count. Hovering reveals the
// yes/no split. Pure client component — no data fetch.

import { useState } from "react";
import { CONTINENT_NAMES, type Continent } from "@/lib/geo-data";

export type ContinentDatum = {
  code: Continent;
  yes: number;
  no: number;
};

export type WorldMapProps = {
  data: ContinentDatum[];
  total: number;
};

// Approximate continent silhouettes inside a 1000×500 viewBox (equirectangular-ish).
// These are deliberately stylised — recognisable shapes at the right rough
// positions — not pixel-accurate cartography.
const CONTINENT_PATHS: Record<Exclude<Continent, "AN">, string> = {
  NA: "M 60,95 Q 95,80 140,80 L 200,78 Q 245,82 280,100 Q 300,118 295,138 L 270,150 Q 250,158 240,175 L 230,205 Q 218,232 198,250 L 178,272 Q 162,285 150,288 Q 138,290 134,278 L 138,260 L 155,248 L 168,228 L 158,210 L 142,200 L 122,196 L 108,182 Q 96,160 88,140 Q 75,118 60,95 Z M 200,295 L 215,305 L 232,320 Q 225,332 210,328 L 195,315 Z",
  SA: "M 252,295 Q 285,288 312,300 L 328,322 Q 338,355 332,395 Q 325,432 310,458 L 295,472 Q 285,476 280,468 L 275,448 Q 270,418 264,388 L 258,348 L 252,318 Z",
  EU: "M 460,90 Q 485,78 520,80 L 568,76 Q 600,82 612,102 Q 605,128 580,138 L 548,148 Q 520,152 498,148 L 478,152 L 472,142 L 464,124 Q 458,108 460,90 Z M 498,158 L 508,168 L 502,178 L 490,170 Z M 528,160 L 540,168 L 534,178 L 522,172 Z",
  AF: "M 500,180 Q 545,170 590,182 L 615,210 Q 622,250 614,290 Q 604,330 584,360 L 562,382 Q 542,388 522,382 L 504,368 Q 488,340 482,308 Q 478,268 480,232 Q 488,198 500,180 Z",
  AS: "M 600,80 Q 660,72 720,76 L 800,82 Q 870,90 920,110 Q 945,128 942,158 L 928,182 Q 900,200 862,206 L 820,214 Q 790,224 770,248 Q 758,268 750,290 L 738,302 Q 722,302 708,288 L 690,268 Q 668,248 648,232 L 626,212 Q 608,192 600,170 L 592,140 Q 588,108 600,80 Z M 760,220 L 780,232 L 770,250 L 752,240 Z M 850,230 L 872,240 L 866,256 L 848,248 Z",
  OC: "M 815,330 Q 855,320 900,332 L 930,348 Q 938,372 920,388 Q 890,398 854,395 L 822,388 Q 806,372 810,352 Z M 940,300 L 952,310 L 944,322 L 932,314 Z M 870,300 L 882,308 L 875,318 L 864,312 Z M 800,360 L 808,368 L 800,376 L 792,368 Z",
};

const DISPLAY_ORDER: Array<Exclude<Continent, "AN">> = ["NA", "SA", "EU", "AF", "AS", "OC"];

// Label anchors — visual centroids of each continent silhouette.
const LABEL_POS: Record<Exclude<Continent, "AN">, { x: number; y: number }> = {
  NA: { x: 170, y: 175 },
  SA: { x: 295, y: 380 },
  EU: { x: 535, y: 118 },
  AF: { x: 550, y: 285 },
  AS: { x: 770, y: 155 },
  OC: { x: 868, y: 360 },
};

const NO_DATA = "#e2e8f0"; // slate-200

// Continuous diverging spectrum on the yes-share: red (all no) → yellow
// (even) → green (all yes). The fill is interpolated, not bucketed, so the
// colour reflects the exact ratio.
const NO_RGB: [number, number, number] = [220, 38, 38]; // red-600
const EVEN_RGB: [number, number, number] = [250, 204, 21]; // yellow-400
const YES_RGB: [number, number, number] = [22, 163, 74]; // green-600
const SPECTRUM_CSS =
  "linear-gradient(to right, rgb(220,38,38), rgb(250,204,21), rgb(22,163,74))";

function yesShare(yes: number, no: number): number {
  const total = yes + no;
  return total === 0 ? 0 : yes / total;
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

/** Interpolated spectrum colour for the yes-share, or null when no votes. */
function rgbForShare(yes: number, no: number): [number, number, number] | null {
  if (yes + no === 0) return null;
  const s = yesShare(yes, no);
  if (s <= 0.5) {
    const t = s / 0.5;
    return [
      lerp(NO_RGB[0], EVEN_RGB[0], t),
      lerp(NO_RGB[1], EVEN_RGB[1], t),
      lerp(NO_RGB[2], EVEN_RGB[2], t),
    ];
  }
  const t = (s - 0.5) / 0.5;
  return [
    lerp(EVEN_RGB[0], YES_RGB[0], t),
    lerp(EVEN_RGB[1], YES_RGB[1], t),
    lerp(EVEN_RGB[2], YES_RGB[2], t),
  ];
}

function colorForShare(yes: number, no: number): string {
  const rgb = rgbForShare(yes, no);
  return rgb ? `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` : NO_DATA;
}

// Use light label text only over the darker red/green ends; the bright yellow
// midband keeps dark text. Decide from the perceived luminance of the fill.
function isDarkFill(yes: number, no: number): boolean {
  const rgb = rgbForShare(yes, no);
  if (!rgb) return false;
  const lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
  return lum < 0.55;
}

export function WorldMap({ data, total }: WorldMapProps) {
  const byCode = new Map(data.map((d) => [d.code, d]));

  const [hover, setHover] = useState<Exclude<Continent, "AN"> | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);

  const hovered = hover ? byCode.get(hover) : null;
  const hoveredCount = hovered ? hovered.yes + hovered.no : 0;

  return (
    <div className="space-y-3">
      <div className="relative">
        {/* The SVG itself sits inside a soft rounded "ocean" panel. */}
        <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-sky-50 via-indigo-50 to-violet-50 p-2 ring-1 ring-slate-200/70">
          <svg
            viewBox="0 0 1000 500"
            role="img"
            aria-label="World map of yes/no responses by continent"
            className="block h-auto w-full"
            onMouseLeave={() => {
              setHover(null);
              setPointer(null);
            }}
          >
            <defs>
              {/* Subtle grid lines suggest a globe without clutter. */}
              <pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse">
                <path d="M 50 0 L 0 0 0 50" fill="none" stroke="#94a3b8" strokeOpacity="0.08" strokeWidth="0.5" />
              </pattern>
              <radialGradient id="oceanGlow" cx="50%" cy="50%" r="60%">
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0.3" />
                <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
              </radialGradient>
            </defs>
            <rect width="1000" height="500" fill="url(#grid)" />
            <rect width="1000" height="500" fill="url(#oceanGlow)" />

            {DISPLAY_ORDER.map((code) => {
              const datum = byCode.get(code);
              const yes = datum?.yes ?? 0;
              const no = datum?.no ?? 0;
              const fill = colorForShare(yes, no);
              const isHover = hover === code;
              const hasData = yes + no > 0;
              return (
                <path
                  key={code}
                  d={CONTINENT_PATHS[code]}
                  fill={fill}
                  stroke={isHover ? "#1e1b4b" : "#ffffff"}
                  strokeWidth={isHover ? 2 : 1.5}
                  strokeLinejoin="round"
                  className={
                    "transition-[fill,stroke-width,filter] duration-150 " +
                    (hasData ? "cursor-pointer" : "")
                  }
                  style={{
                    filter: isHover
                      ? "drop-shadow(0 4px 10px rgba(15, 23, 42, 0.35))"
                      : undefined,
                  }}
                  onMouseEnter={() => setHover(code)}
                  onMouseMove={(e) => {
                    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                    setPointer({
                      x: ((e.clientX - rect.left) / rect.width) * 100,
                      y: ((e.clientY - rect.top) / rect.height) * 100,
                    });
                  }}
                />
              );
            })}

            {/* Continent labels (subtle, always visible): name + total count. */}
            {DISPLAY_ORDER.map((code) => {
              const datum = byCode.get(code);
              const yes = datum?.yes ?? 0;
              const no = datum?.no ?? 0;
              const count = yes + no;
              const dark = isDarkFill(yes, no);
              const pos = LABEL_POS[code];
              return (
                <g key={`label-${code}`} pointerEvents="none">
                  <text
                    x={pos.x}
                    y={pos.y - 8}
                    textAnchor="middle"
                    fontSize="14"
                    fontWeight="600"
                    fill={dark ? "#ffffff" : "#334155"}
                    style={{
                      paintOrder: "stroke",
                      stroke: dark ? "rgba(15,23,42,0.35)" : "rgba(255,255,255,0.7)",
                      strokeWidth: 2,
                      strokeLinejoin: "round",
                    }}
                  >
                    {CONTINENT_NAMES[code]}
                  </text>
                  <text
                    x={pos.x}
                    y={pos.y + 12}
                    textAnchor="middle"
                    fontSize="13"
                    fontWeight="700"
                    fill={dark ? "#ffffff" : "#1e1b4b"}
                    style={{
                      paintOrder: "stroke",
                      stroke: dark ? "rgba(15,23,42,0.35)" : "rgba(255,255,255,0.7)",
                      strokeWidth: 2,
                      strokeLinejoin: "round",
                    }}
                  >
                    {count}
                  </text>
                </g>
              );
            })}
          </svg>

          {/* Floating tooltip */}
          {hover && pointer ? (
            <div
              className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[110%] rounded-lg bg-slate-900/95 px-3 py-2 text-xs text-white shadow-lg ring-1 ring-black/10 backdrop-blur"
              style={{ left: `${pointer.x}%`, top: `${pointer.y}%` }}
            >
              <div className="font-semibold">{CONTINENT_NAMES[hover]}</div>
              {hoveredCount > 0 ? (
                <div className="mt-0.5 space-y-0.5 text-slate-200">
                  <div className="tabular-nums">
                    <span className="font-semibold text-emerald-300">
                      {Math.round(yesShare(hovered!.yes, hovered!.no) * 100)}% yes
                    </span>
                    <span className="ml-2 text-slate-400">
                      {hovered!.yes} yes · {hovered!.no} no
                    </span>
                  </div>
                  <div className="text-slate-400 tabular-nums">
                    {hoveredCount}
                    {total > 0
                      ? ` · ${((hoveredCount / total) * 100).toFixed(0)}% of total`
                      : ""}
                  </div>
                </div>
              ) : (
                <div className="mt-0.5 text-slate-400">No responses yet</div>
              )}
            </div>
          ) : null}
        </div>

        {/* Legend strip — diverging no → yes scale. */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
          <div className="flex items-center gap-2">
            <span className="font-medium uppercase tracking-wider text-rose-600">
              More no
            </span>
            <div
              className="h-3 w-32 rounded-full ring-1 ring-slate-200"
              style={{ background: SPECTRUM_CSS }}
            />
            <span className="font-medium uppercase tracking-wider text-emerald-600">
              More yes
            </span>
          </div>
          <div className="text-slate-500">
            Hover a continent for the yes/no split
          </div>
        </div>
      </div>
    </div>
  );
}
