"use client";

// Interactive choropleth world map. Real country boundaries (projected once in
// lib/geo/atlas) are filled on a continuous red→amber→green diverging scale of
// the yes-share (yes / (yes + no)) — NOT by how many people answered.
//
// Two zoom levels:
//   • World — every country is shaded by its CONTINENT's aggregate vote, so each
//     continent reads as one colour block. Click a continent to drill in.
//   • Continent — pans/zooms to one continent and re-shades each country by its
//     OWN yes-share (when per-country tallies exist), revealing the granularity
//     beneath the continent average.
//
// Pure client component — no data fetch.

import { useMemo, useState } from "react";
import { CONTINENT_NAMES, COUNTRY_TO_CONTINENT, type Continent } from "@/lib/geo-data";
import {
  COUNTRIES,
  CONTINENT_BOX,
  DISPLAY_ORDER,
  MAP_HEIGHT,
  MAP_WIDTH,
  type DrillContinent,
} from "@/lib/geo/atlas";
import {
  OPTION_PALETTE,
  isYesNo,
  type OptionTally,
  tallyTotal,
} from "./options-bar";

export type ContinentDatum = {
  code: Continent;
  tally: OptionTally;
};

export type CountryDatum = {
  code: string;
  tally: OptionTally;
};

export type WorldMapProps = {
  continentData: ContinentDatum[];
  countryData?: CountryDatum[];
  total: number;
  options: readonly string[];
  /** When set, the map opens zoomed into this continent (continent-scoped questions). */
  focusContinent?: Continent | null;
};

type Tally = OptionTally;

const NO_DATA = "#e2e8f0"; // slate-200 — in-scope but no votes
const OUT_OF_FOCUS = "#eef2f7"; // near-white — neighbouring continents while drilled in

// 2-option (yes/no) diverging spectrum: red (all option[1]) → yellow (even)
// → green (all option[0]). Interpolated, not bucketed.
const NEG_RGB: [number, number, number] = [220, 38, 38]; // red-600
const EVEN_RGB: [number, number, number] = [250, 204, 21]; // yellow-400
const POS_RGB: [number, number, number] = [22, 163, 74]; // green-600
const SPECTRUM_CSS =
  "linear-gradient(to right, rgb(220,38,38), rgb(250,204,21), rgb(22,163,74))";

// Lighter palette swatches for the N-option "leading option" mode.
// Each entry mirrors OPTION_PALETTE by index so legends align across charts.
const OPTION_FILL_RGB: ReadonlyArray<[number, number, number]> = [
  [99, 102, 241],  // indigo-500
  [245, 158, 11],  // amber-500
  [16, 185, 129],  // emerald-500
  [236, 72, 153],  // pink-500
  [6, 182, 212],   // cyan-500
  [249, 115, 22],  // orange-500
  [139, 92, 246],  // violet-500
  [100, 116, 139], // slate-500
];

function totalOf(t: Tally | null): number {
  return t ? tallyTotal(t) : 0;
}

function shareOf(t: Tally, label: string): number {
  const tot = tallyTotal(t);
  return tot === 0 ? 0 : (t[label] ?? 0) / tot;
}

function lerp(a: number, b: number, x: number): number {
  return Math.round(a + (b - a) * x);
}

function rgbForYesNo(t: Tally, options: readonly string[]): [number, number, number] | null {
  const yes = t[options[0]] ?? 0;
  const no = t[options[1]] ?? 0;
  if (yes + no === 0) return null;
  const s = yes / (yes + no);
  if (s <= 0.5) {
    const x = s / 0.5;
    return [
      lerp(NEG_RGB[0], EVEN_RGB[0], x),
      lerp(NEG_RGB[1], EVEN_RGB[1], x),
      lerp(NEG_RGB[2], EVEN_RGB[2], x),
    ];
  }
  const x = (s - 0.5) / 0.5;
  return [
    lerp(EVEN_RGB[0], POS_RGB[0], x),
    lerp(EVEN_RGB[1], POS_RGB[1], x),
    lerp(EVEN_RGB[2], POS_RGB[2], x),
  ];
}

function leadingIndex(t: Tally, options: readonly string[]): number {
  let best = -1;
  let bestN = -1;
  for (let i = 0; i < options.length; i++) {
    const n = t[options[i]] ?? 0;
    if (n > bestN) {
      bestN = n;
      best = i;
    }
  }
  return best;
}

function rgbForLeading(
  t: Tally,
  options: readonly string[],
): [number, number, number] | null {
  if (tallyTotal(t) === 0) return null;
  const idx = leadingIndex(t, options);
  if (idx < 0) return null;
  const base = OPTION_FILL_RGB[idx % OPTION_FILL_RGB.length];
  // Tint by how dominant the leader is (50% lead share → 60% saturation).
  // Map share in [1/n, 1] to alpha in [0.55, 1.0].
  const share = shareOf(t, options[idx]);
  const minShare = 1 / Math.max(options.length, 1);
  const x = Math.min(1, Math.max(0, (share - minShare) / Math.max(1e-6, 1 - minShare)));
  const alpha = 0.55 + 0.45 * x;
  return [
    lerp(255, base[0], alpha),
    lerp(255, base[1], alpha),
    lerp(255, base[2], alpha),
  ];
}

function colorForTally(t: Tally | null, options: readonly string[]): string {
  if (!t) return NO_DATA;
  const rgb = isYesNo(options)
    ? rgbForYesNo(t, options)
    : rgbForLeading(t, options);
  return rgb ? `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` : NO_DATA;
}

function isDarkFill(t: Tally | null, options: readonly string[]): boolean {
  if (!t) return false;
  const rgb = isYesNo(options)
    ? rgbForYesNo(t, options)
    : rgbForLeading(t, options);
  if (!rgb) return false;
  const lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
  return lum < 0.55;
}

function isDrill(c: Continent | null | undefined): c is DrillContinent {
  return !!c && c !== "AN";
}

export function WorldMap({
  continentData,
  countryData = [],
  total,
  options,
  focusContinent = null,
}: WorldMapProps) {
  // Per-continent shares come from explicit continent tallies, falling back to
  // a sum of any per-country tallies so a continent-scoped question still shows
  // a coloured continent at the world level.
  const { continentShare, countryShare, continentsWithCountryData } = useMemo(() => {
    const explicit = new Map<Continent, Tally>();
    for (const d of continentData) explicit.set(d.code, { ...d.tally });

    const derived = new Map<Continent, Tally>();
    const countryShare = new Map<string, Tally>();
    const continentsWithCountryData = new Set<Continent>();
    for (const d of countryData) {
      countryShare.set(d.code, { ...d.tally });
      const cont = COUNTRY_TO_CONTINENT[d.code] as Continent | undefined;
      if (!cont) continue;
      continentsWithCountryData.add(cont);
      const cur = derived.get(cont) ?? {};
      const merged: Tally = { ...cur };
      for (const k of Object.keys(d.tally)) {
        merged[k] = (merged[k] ?? 0) + (d.tally[k] ?? 0);
      }
      derived.set(cont, merged);
    }

    const continentShare = (code: Continent): Tally | null =>
      explicit.get(code) ?? derived.get(code) ?? null;
    return { continentShare, countryShare, continentsWithCountryData };
  }, [continentData, countryData]);

  const initialActive = isDrill(focusContinent) ? focusContinent : null;
  const [active, setActive] = useState<DrillContinent | null>(initialActive);
  const [hover, setHover] = useState<{ type: "c" | "k"; key: string } | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  // Zoom transform: identity at world level, fit-to-box when drilled in.
  const { k, tx, ty } = useMemo(() => {
    if (!active) return { k: 1, tx: 0, ty: 0 };
    const [[x0, y0], [x1, y1]] = CONTINENT_BOX[active].bounds;
    const k = Math.min(MAP_WIDTH / (x1 - x0), MAP_HEIGHT / (y1 - y0)) * 0.92;
    const tx = MAP_WIDTH / 2 - (k * (x0 + x1)) / 2;
    const ty = MAP_HEIGHT / 2 - (k * (y0 + y1)) / 2;
    return { k, tx, ty };
  }, [active]);

  const activeHasCountryData = active
    ? continentsWithCountryData.has(active)
    : false;

  function fillFor(country: (typeof COUNTRIES)[number]): string {
    if (active) {
      if (country.continent !== active) return OUT_OF_FOCUS;
      const cs = country.a2 ? countryShare.get(country.a2) ?? null : null;
      if (cs) return colorForTally(cs, options);
      // No per-country datum. If the whole continent lacks country-level data
      // (e.g. a worldwide question), keep it coloured by the continent average
      // rather than greying it out; otherwise grey means "in scope, no votes".
      if (!activeHasCountryData) return colorForTally(continentShare(active), options);
      return NO_DATA;
    }
    return colorForTally(
      country.continent ? continentShare(country.continent) : null,
      options,
    );
  }

  function isHovered(country: (typeof COUNTRIES)[number]): boolean {
    if (!hover) return false;
    return active
      ? hover.type === "k" && hover.key === country.id
      : hover.type === "c" && hover.key === country.continent;
  }

  function onEnter(country: (typeof COUNTRIES)[number]) {
    if (active) {
      if (country.continent !== active) return;
      // Without per-country data, the whole continent reads as one average.
      setHover(
        activeHasCountryData
          ? { type: "k", key: country.id }
          : { type: "c", key: active },
      );
    } else if (country.continent) {
      setHover({ type: "c", key: country.continent });
    }
  }

  function onClickCountry(country: (typeof COUNTRIES)[number]) {
    if (!active) {
      if (isDrill(country.continent)) {
        setActive(country.continent);
        setHover(null);
        setSelected(null);
      }
      return;
    }
    if (country.continent === active && activeHasCountryData) {
      setSelected((cur) => (cur === country.id ? null : country.id));
    }
  }

  // Labels: continents at world level, data-bearing countries when drilled in.
  // Positions are pre-multiplied by the zoom transform and rendered in a
  // non-scaled overlay so glyphs stay a constant size.
  const labels = active
    ? COUNTRIES.filter(
        (c) => c.continent === active && c.a2 && countryShare.has(c.a2),
      ).map((c) => {
        const t = countryShare.get(c.a2!)!;
        return {
          key: c.id,
          name: c.name,
          count: totalOf(t),
          dark: isDarkFill(t, options),
          x: tx + k * c.centroid[0],
          y: ty + k * c.centroid[1],
        };
      })
    : DISPLAY_ORDER.map((code) => {
        const t = continentShare(code);
        return {
          key: code,
          name: CONTINENT_NAMES[code],
          count: totalOf(t),
          dark: isDarkFill(t, options),
          x: CONTINENT_BOX[code].center[0],
          y: CONTINENT_BOX[code].center[1],
        };
      });

  // Tooltip / caption content.
  const hoverContent = (() => {
    if (!hover) return null;
    if (hover.type === "c") {
      const code = hover.key as Continent;
      const t = continentShare(code);
      return { title: CONTINENT_NAMES[code] ?? code, tally: t };
    }
    const country = COUNTRIES.find((c) => c.id === hover.key);
    if (!country) return null;
    return {
      title: country.name,
      tally: country.a2 ? countryShare.get(country.a2) ?? null : null,
    };
  })();

  const selectedCountry = selected
    ? COUNTRIES.find((c) => c.id === selected)
    : null;
  const selectedTally =
    selectedCountry?.a2 ? countryShare.get(selectedCountry.a2) ?? null : null;

  const activeName = active ? CONTINENT_NAMES[active] : null;

  // Continents we can drill into that actually have responses — drives the
  // accessible quick-jump buttons.
  const drillTargets = DISPLAY_ORDER.filter(
    (code): code is DrillContinent => isDrill(code) && continentShare(code) !== null,
  );

  return (
    <div className="space-y-3">
      {/* View header: current level + back control. */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm">
          <button
            type="button"
            onClick={() => {
              setActive(null);
              setSelected(null);
              setHover(null);
            }}
            disabled={!active}
            className={
              "rounded-full px-3 py-1 text-xs font-medium ring-1 transition " +
              (active
                ? "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50"
                : "cursor-default bg-slate-100 text-slate-400 ring-transparent")
            }
          >
            🌍 World
          </button>
          {activeName ? (
            <>
              <span className="text-slate-400">›</span>
              <span className="rounded-full bg-violet-100 px-3 py-1 text-xs font-semibold text-violet-800">
                {activeName}
              </span>
            </>
          ) : null}
        </div>
        <div className="hidden text-xs text-slate-500 sm:block">
          {!active
            ? "Tap a continent to drill into its countries"
            : activeHasCountryData
            ? "Tap a country for its split · World to zoom out"
            : "World to zoom out"}
        </div>
      </div>

      {/* Continent quick-jump — a keyboard- and touch-accessible way to drill
          in, since the country <path>s themselves are pointer-only. */}
      {drillTargets.length > 0 ? (
        <div className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-1 sm:flex-wrap sm:overflow-visible sm:pb-0">
          <span className="shrink-0 text-xs font-medium text-slate-500">Jump to</span>
          {drillTargets.map((code) => {
            const isOn = active === code;
            return (
              <button
                key={code}
                type="button"
                aria-pressed={isOn}
                onClick={() => {
                  setActive(code);
                  setSelected(null);
                  setHover(null);
                }}
                className={
                  "shrink-0 rounded-full px-3 py-1 text-xs font-medium ring-1 transition " +
                  (isOn
                    ? "bg-violet-600 text-white ring-violet-600"
                    : "bg-white text-slate-600 ring-slate-200 hover:text-violet-700 hover:ring-violet-300")
                }
              >
                {CONTINENT_NAMES[code]}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="relative">
        <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-violet-50 via-teal-50 to-emerald-50 p-2 ring-1 ring-slate-200/70">
          <svg
            viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
            role="img"
            aria-label={
              active
                ? `Map of ${activeName} coloured by yes/no responses per country`
                : "World map of yes/no responses by continent"
            }
            className="block h-auto w-full"
            onMouseLeave={() => {
              setHover(null);
              setPointer(null);
            }}
          >
            <defs>
              <pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse">
                <path d="M 50 0 L 0 0 0 50" fill="none" stroke="#94a3b8" strokeOpacity="0.08" strokeWidth="0.5" />
              </pattern>
              <radialGradient id="oceanGlow" cx="50%" cy="50%" r="60%">
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0.3" />
                <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
              </radialGradient>
            </defs>
            <rect width={MAP_WIDTH} height={MAP_HEIGHT} fill="url(#grid)" />
            <rect width={MAP_WIDTH} height={MAP_HEIGHT} fill="url(#oceanGlow)" />

            {/* Geography — smoothly zoomed via a CSS transform on the group. */}
            <g
              style={{
                transform: `translate(${tx}px, ${ty}px) scale(${k})`,
                transformOrigin: "0px 0px",
                transition: "transform 600ms cubic-bezier(0.4, 0, 0.2, 1)",
              }}
            >
              {COUNTRIES.map((country) => {
                const hovered = isHovered(country);
                const isSelected = selected === country.id;
                const interactive = active
                  ? country.continent === active
                  : !!country.continent;
                return (
                  <path
                    key={country.id}
                    data-id={country.id}
                    data-a2={country.a2 ?? ""}
                    data-continent={country.continent ?? ""}
                    d={country.d}
                    fill={fillFor(country)}
                    stroke={hovered || isSelected ? "#1e1b4b" : "#ffffff"}
                    strokeWidth={hovered || isSelected ? 1.4 : 0.5}
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                    className={interactive ? "cursor-pointer" : ""}
                    style={{
                      transition: "fill 300ms ease",
                      filter:
                        hovered || isSelected
                          ? "drop-shadow(0 1px 3px rgba(15, 23, 42, 0.4))"
                          : undefined,
                    }}
                    onMouseEnter={() => onEnter(country)}
                    onMouseMove={(e) => {
                      const svg = e.currentTarget.ownerSVGElement;
                      if (!svg) return;
                      const rect = svg.getBoundingClientRect();
                      setPointer({
                        x: ((e.clientX - rect.left) / rect.width) * 100,
                        y: ((e.clientY - rect.top) / rect.height) * 100,
                      });
                    }}
                    onClick={() => onClickCountry(country)}
                  />
                );
              })}
            </g>

            {/* Labels overlay (constant glyph size). */}
            <g pointerEvents="none">
              {labels.map((l) => (
                <g key={l.key}>
                  <text
                    x={l.x}
                    y={l.y - (active ? 5 : 8)}
                    textAnchor="middle"
                    fontSize={active ? 11 : 14}
                    fontWeight="600"
                    fill={l.dark ? "#ffffff" : "#334155"}
                    style={{
                      paintOrder: "stroke",
                      stroke: l.dark ? "rgba(15,23,42,0.35)" : "rgba(255,255,255,0.8)",
                      strokeWidth: 2,
                      strokeLinejoin: "round",
                    }}
                  >
                    {l.name}
                  </text>
                  <text
                    x={l.x}
                    y={l.y + (active ? 8 : 12)}
                    textAnchor="middle"
                    fontSize={active ? 10 : 13}
                    fontWeight="700"
                    fill={l.dark ? "#ffffff" : "#1e1b4b"}
                    style={{
                      paintOrder: "stroke",
                      stroke: l.dark ? "rgba(15,23,42,0.35)" : "rgba(255,255,255,0.8)",
                      strokeWidth: 2,
                      strokeLinejoin: "round",
                    }}
                  >
                    {l.count}
                  </text>
                </g>
              ))}
            </g>
          </svg>

          {/* Floating tooltip (hover, desktop). */}
          {hoverContent && pointer ? (
            <div
              className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[110%] rounded-lg bg-slate-900/95 px-3 py-2 text-xs text-white shadow-lg ring-1 ring-black/10 backdrop-blur"
              style={{ left: `${pointer.x}%`, top: `${pointer.y}%` }}
            >
              <div className="font-semibold">{hoverContent.title}</div>
              {hoverContent.tally && totalOf(hoverContent.tally) > 0 ? (
                <TallySummary tally={hoverContent.tally} options={options} total={total} />
              ) : (
                <div className="mt-0.5 text-slate-400">No responses yet</div>
              )}
            </div>
          ) : null}
        </div>

        {/* Selected-country caption (persists; works without hover on touch). */}
        {active && selectedCountry ? (
          <div className="mt-2 rounded-xl bg-white p-3 text-sm shadow-sm ring-1 ring-slate-200">
            <span className="font-semibold text-slate-900">{selectedCountry.name}</span>
            {selectedTally && totalOf(selectedTally) > 0 ? (
              <SelectedTally tally={selectedTally} options={options} />
            ) : (
              <span className="ml-2 text-slate-400">No responses yet</span>
            )}
          </div>
        ) : null}

        {/* Legend strip — depends on whether we're in yes/no or N-option mode. */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-xs text-slate-600">
          {isYesNo(options) ? (
            <div className="flex min-w-0 items-center gap-2">
              <span className="font-medium uppercase tracking-wider text-rose-600">No</span>
              <div
                className="h-3 w-24 rounded-full ring-1 ring-slate-200 sm:w-32"
                style={{ background: SPECTRUM_CSS }}
              />
              <span className="font-medium uppercase tracking-wider text-emerald-600">Yes</span>
            </div>
          ) : (
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              {options.map((opt, i) => {
                const rgb = OPTION_FILL_RGB[i % OPTION_FILL_RGB.length];
                return (
                  <span key={opt} className="inline-flex items-center gap-1.5">
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ background: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` }}
                    />
                    {opt}
                  </span>
                );
              })}
            </div>
          )}
          <div className="w-full text-slate-500 sm:w-auto">
            {!active
              ? isYesNo(options)
                ? "Shaded by each continent's yes-share"
                : "Shaded by each continent's leading option"
              : activeHasCountryData
              ? isYesNo(options)
                ? "Shaded by each country's yes-share"
                : "Shaded by each country's leading option"
              : `No country-level data — showing the ${activeName} average`}
          </div>
        </div>
      </div>
    </div>
  );
}

function TallySummary({
  tally,
  options,
  total,
}: {
  tally: Tally;
  options: readonly string[];
  total: number;
}) {
  const tot = totalOf(tally);
  const entries = options
    .map((opt) => ({ opt, n: tally[opt] ?? 0 }))
    .sort((a, b) => b.n - a.n);
  return (
    <div className="mt-0.5 space-y-0.5 text-slate-200">
      <div className="space-y-0.5 text-slate-200">
        {entries.map(({ opt, n }) => {
          const pct = tot === 0 ? 0 : Math.round((n / tot) * 100);
          return (
            <div key={opt} className="tabular-nums">
              <span className="font-semibold">{opt}</span>
              <span className="ml-2 text-slate-400">{n} · {pct}%</span>
            </div>
          );
        })}
      </div>
      <div className="text-slate-400 tabular-nums">
        {tot}
        {total > 0 ? ` · ${((tot / total) * 100).toFixed(0)}% of total` : ""}
      </div>
    </div>
  );
}

function SelectedTally({
  tally,
  options,
}: {
  tally: Tally;
  options: readonly string[];
}) {
  const tot = totalOf(tally);
  return (
    <span className="ml-2 tabular-nums text-slate-600">
      {options.map((opt, i) => {
        const n = tally[opt] ?? 0;
        const pct = tot === 0 ? 0 : Math.round((n / tot) * 100);
        return (
          <span key={opt}>
            <span className="font-semibold text-slate-800">{n} {opt}</span>
            <span className="ml-1 text-slate-400">({pct}%)</span>
            {i < options.length - 1 ? (
              <span className="mx-1 text-slate-300">·</span>
            ) : null}
          </span>
        );
      })}
    </span>
  );
}
