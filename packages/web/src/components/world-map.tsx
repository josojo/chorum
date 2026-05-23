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

export type ContinentDatum = {
  code: Continent;
  yes: number;
  no: number;
};

export type CountryDatum = {
  code: string;
  yes: number;
  no: number;
};

export type WorldMapProps = {
  continentData: ContinentDatum[];
  countryData?: CountryDatum[];
  total: number;
  /** When set, the map opens zoomed into this continent (continent-scoped questions). */
  focusContinent?: Continent | null;
};

type Tally = { yes: number; no: number };

const NO_DATA = "#e2e8f0"; // slate-200 — in-scope but no votes
const OUT_OF_FOCUS = "#eef2f7"; // near-white — neighbouring continents while drilled in

// Continuous diverging spectrum on the yes-share: red (all no) → yellow (even)
// → green (all yes). Interpolated, not bucketed.
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

function colorForShare(t: Tally | null): string {
  const rgb = t ? rgbForShare(t.yes, t.no) : null;
  return rgb ? `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` : NO_DATA;
}

function isDarkFill(t: Tally | null): boolean {
  const rgb = t ? rgbForShare(t.yes, t.no) : null;
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
  focusContinent = null,
}: WorldMapProps) {
  // Per-continent shares come from explicit continent tallies, falling back to
  // a sum of any per-country tallies so a continent-scoped question still shows
  // a coloured continent at the world level.
  const { continentShare, countryShare, continentsWithCountryData } = useMemo(() => {
    const explicit = new Map<Continent, Tally>();
    for (const d of continentData) explicit.set(d.code, { yes: d.yes, no: d.no });

    const derived = new Map<Continent, Tally>();
    const countryShare = new Map<string, Tally>();
    const continentsWithCountryData = new Set<Continent>();
    for (const d of countryData) {
      countryShare.set(d.code, { yes: d.yes, no: d.no });
      const cont = COUNTRY_TO_CONTINENT[d.code] as Continent | undefined;
      if (!cont) continue;
      continentsWithCountryData.add(cont);
      const cur = derived.get(cont) ?? { yes: 0, no: 0 };
      derived.set(cont, { yes: cur.yes + d.yes, no: cur.no + d.no });
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
      if (cs) return colorForShare(cs);
      // No per-country datum. If the whole continent lacks country-level data
      // (e.g. a worldwide question), keep it coloured by the continent average
      // rather than greying it out; otherwise grey means "in scope, no votes".
      if (!activeHasCountryData) return colorForShare(continentShare(active));
      return NO_DATA;
    }
    return colorForShare(country.continent ? continentShare(country.continent) : null);
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
          count: t.yes + t.no,
          dark: isDarkFill(t),
          x: tx + k * c.centroid[0],
          y: ty + k * c.centroid[1],
        };
      })
    : DISPLAY_ORDER.map((code) => {
        const t = continentShare(code);
        return {
          key: code,
          name: CONTINENT_NAMES[code],
          count: t ? t.yes + t.no : 0,
          dark: isDarkFill(t),
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
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-slate-500">Jump to</span>
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
                  "rounded-full px-3 py-1 text-xs font-medium ring-1 transition " +
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
        <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-sky-50 via-indigo-50 to-violet-50 p-2 ring-1 ring-slate-200/70">
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
              {hoverContent.tally && hoverContent.tally.yes + hoverContent.tally.no > 0 ? (
                <div className="mt-0.5 space-y-0.5 text-slate-200">
                  <div className="tabular-nums">
                    <span className="font-semibold text-emerald-300">
                      {Math.round(
                        yesShare(hoverContent.tally.yes, hoverContent.tally.no) * 100,
                      )}
                      % yes
                    </span>
                    <span className="ml-2 text-slate-400">
                      {hoverContent.tally.yes} yes · {hoverContent.tally.no} no
                    </span>
                  </div>
                  <div className="text-slate-400 tabular-nums">
                    {hoverContent.tally.yes + hoverContent.tally.no}
                    {total > 0
                      ? ` · ${(((hoverContent.tally.yes + hoverContent.tally.no) / total) * 100).toFixed(0)}% of total`
                      : ""}
                  </div>
                </div>
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
            {selectedTally && selectedTally.yes + selectedTally.no > 0 ? (
              <span className="ml-2 tabular-nums text-slate-600">
                <span className="font-semibold text-emerald-700">{selectedTally.yes} yes</span>
                <span className="mx-1 text-slate-300">·</span>
                <span className="font-semibold text-rose-700">{selectedTally.no} no</span>
                <span className="ml-2 text-slate-400">
                  {Math.round(yesShare(selectedTally.yes, selectedTally.no) * 100)}% yes
                </span>
              </span>
            ) : (
              <span className="ml-2 text-slate-400">No responses yet</span>
            )}
          </div>
        ) : null}

        {/* Legend strip — diverging no → yes scale. */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
          <div className="flex items-center gap-2">
            <span className="font-medium uppercase tracking-wider text-rose-600">More no</span>
            <div
              className="h-3 w-32 rounded-full ring-1 ring-slate-200"
              style={{ background: SPECTRUM_CSS }}
            />
            <span className="font-medium uppercase tracking-wider text-emerald-600">More yes</span>
          </div>
          <div className="text-slate-500">
            {!active
              ? "Shaded by each continent's yes-share"
              : activeHasCountryData
              ? "Shaded by each country's yes-share"
              : `No country-level data — showing the ${activeName} average`}
          </div>
        </div>
      </div>
    </div>
  );
}
