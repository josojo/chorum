// Precomputed map geometry. Runs once at module load (pure JS — safe in the
// browser, in Node tests, and during SSR). We project real country boundaries
// (Natural Earth 110m, via the bundled TopoJSON) into a fixed 1000×500 viewBox
// and expose, per country: its projected SVG path, alpha-2 code, continent,
// centroid and bounds. Continent-level bounding boxes (used for drill-down
// zoom and world-view labels) come from curated lon/lat extents rather than the
// union of member-country bounds — otherwise a single far-flung country (e.g.
// eastern Russia under "EU") would blow the box across half the globe.

import { geoNaturalEarth1, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type {
  Feature,
  FeatureCollection,
  Geometry,
} from "geojson";
import type { GeometryCollection, Topology } from "topojson-specification";
import topology from "./countries-110m.json";
import { NUMERIC_TO_ALPHA2 } from "./iso-numeric";
import { COUNTRY_TO_CONTINENT, type Continent } from "../geo-data";

export const MAP_WIDTH = 1000;
export const MAP_HEIGHT = 500;
const PAD = 12;

export type DrillContinent = Exclude<Continent, "AN">;

export type CountryShape = {
  /** ISO 3166-1 numeric id (matches TopoJSON). */
  id: string;
  /** ISO 3166-1 alpha-2, or null for unmatched/disputed territories. */
  a2: string | null;
  continent: Continent | null;
  name: string;
  /** Projected SVG path data in viewBox coordinates. */
  d: string;
  centroid: [number, number];
  bounds: [[number, number], [number, number]];
};

type CountryProps = { name?: string };

const topo = topology as unknown as Topology;
const collection = topo.objects.countries as GeometryCollection<CountryProps>;
const fc = feature(topo, collection) as FeatureCollection<Geometry, CountryProps>;

const projection = geoNaturalEarth1().fitExtent(
  [
    [PAD, PAD],
    [MAP_WIDTH - PAD, MAP_HEIGHT - PAD],
  ],
  fc,
);
const pathGen = geoPath(projection);

export const COUNTRIES: CountryShape[] = fc.features.map(
  (f: Feature<Geometry, CountryProps>, index: number) => {
    const numericId = f.id != null ? String(f.id) : "";
    // A handful of disputed territories have no numeric id; synthesise a unique
    // one so React keys never collide.
    const id = numericId || `x${index}`;
    const a2 = NUMERIC_TO_ALPHA2[numericId] ?? null;
    const continent = a2
      ? (COUNTRY_TO_CONTINENT[a2] as Continent | undefined) ?? null
      : null;
    return {
      id,
      a2,
      continent,
      name: f.properties?.name ?? a2 ?? id,
      d: pathGen(f) ?? "",
      centroid: pathGen.centroid(f) as [number, number],
      bounds: pathGen.bounds(f) as [[number, number], [number, number]],
    };
  },
);

// Curated [west, south] / [east, north] lon-lat extents per drill-down
// continent. Deliberately frame the populated landmass (e.g. Europe proper, not
// the Russian far east) so the zoom lands somewhere legible.
const CONTINENT_LONLAT: Record<
  DrillContinent,
  { sw: [number, number]; ne: [number, number] }
> = {
  NA: { sw: [-168, 7], ne: [-52, 72] },
  SA: { sw: [-82, -56], ne: [-34, 13] },
  EU: { sw: [-25, 34], ne: [45, 71] },
  AF: { sw: [-19, -35], ne: [52, 38] },
  AS: { sw: [26, -11], ne: [180, 73] },
  OC: { sw: [112, -48], ne: [180, -1] },
};

export const DISPLAY_ORDER: DrillContinent[] = [
  "NA",
  "SA",
  "EU",
  "AF",
  "AS",
  "OC",
];

export type ContinentBox = {
  bounds: [[number, number], [number, number]];
  center: [number, number];
};

/** Project a lon/lat box into pixel bounds by sampling a grid (the projection
 * is curved, so corner points alone under-state the extent). */
function projectBox(sw: [number, number], ne: [number, number]): ContinentBox {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const steps = 6;
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const lon = sw[0] + ((ne[0] - sw[0]) * i) / steps;
      const lat = sw[1] + ((ne[1] - sw[1]) * j) / steps;
      const p = projection([lon, lat]);
      if (!p) continue;
      if (p[0] < x0) x0 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[0] > x1) x1 = p[0];
      if (p[1] > y1) y1 = p[1];
    }
  }
  const centerLL: [number, number] = [
    (sw[0] + ne[0]) / 2,
    (sw[1] + ne[1]) / 2,
  ];
  const c = projection(centerLL) ?? [(x0 + x1) / 2, (y0 + y1) / 2];
  return {
    bounds: [
      [x0, y0],
      [x1, y1],
    ],
    center: [c[0], c[1]],
  };
}

export const CONTINENT_BOX: Record<DrillContinent, ContinentBox> =
  Object.fromEntries(
    DISPLAY_ORDER.map((code) => [
      code,
      projectBox(CONTINENT_LONLAT[code].sw, CONTINENT_LONLAT[code].ne),
    ]),
  ) as Record<DrillContinent, ContinentBox>;
