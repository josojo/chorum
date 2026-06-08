// IP → country/continent resolution for the home feed.
//
// Server-only: uses next/headers. Client components must import from
// `./geo-data` instead.
//
// Strategy, in order:
//   1. `?loc=DE` query override (for testing / manual switch).
//   2. Reverse-proxy geo headers Vercel/Cloudflare/Fly already set.
//      These are zero-cost and always trusted.
//   3. Free public lookup against ipwho.is, cached in-process for IP_TTL.
//   4. DEFAULT_LOCATION (US/NA) so the UI always has something to show.
//
// Privacy (issue #104): the raw client IP is PII. We never log it and never
// persist it — it lives only transiently in this process. Before step 3 sends an
// address to the third party (ipwho.is), we MASK it to the network prefix (IPv4
// /24, IPv6 /48): country-level geo is unchanged, but a fully-identifying address
// never leaves our infra. Steps 1–2 (override + edge geo headers) require no
// third-party call at all, so a deployment behind Vercel/Cloudflare/Fly leaks
// nothing. Set CHORUM_GEO_DISABLE_IP_LOOKUP=1 to drop step 3 entirely and rely
// only on edge headers + the default.

import { headers } from "next/headers";
import {
  CONTINENT_NAMES,
  COUNTRY_NAMES,
  COUNTRY_TO_CONTINENT,
  maskIp,
  type Continent,
} from "./geo-data";

// Re-export the pure data so existing imports of `@/lib/geo` keep working.
export {
  CONTINENT_NAMES,
  COUNTRY_NAMES,
  COUNTRY_TO_CONTINENT,
  maskIp,
  type Continent,
};

export type Location = {
  country: string; // ISO 3166-1 alpha-2, e.g. "US"
  continent: Continent;
  countryName: string;
  continentName: string;
  source: "override" | "header" | "lookup" | "default";
};

const DEFAULT_LOCATION: Location = {
  country: "US",
  continent: "NA",
  countryName: "United States",
  continentName: "North America",
  source: "default",
};

const IP_TTL_MS = 60 * 60 * 1000; // 1h
type CacheEntry = { expires: number; loc: Omit<Location, "source"> | null };
const ipCache = new Map<string, CacheEntry>();

function getHeader(name: string): string | null {
  try {
    return headers().get(name);
  } catch {
    return null;
  }
}

function clientIp(): string | null {
  const xff = getHeader("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return (
    getHeader("x-real-ip") ??
    getHeader("cf-connecting-ip") ??
    getHeader("fly-client-ip") ??
    null
  );
}

function isPrivateIp(ip: string | null): boolean {
  if (!ip) return true;
  if (ip === "::1" || ip === "127.0.0.1") return true;
  if (ip.startsWith("10.") || ip.startsWith("192.168.")) return true;
  if (ip.startsWith("172.")) {
    const second = Number.parseInt(ip.split(".")[1] ?? "0", 10);
    if (second >= 16 && second <= 31) return true;
  }
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true;
  return false;
}

function continentFromHeaders(): Continent | null {
  const fromVercel = getHeader("x-vercel-ip-continent");
  if (fromVercel && isContinent(fromVercel)) return fromVercel;
  return null;
}

function isContinent(s: string): s is Continent {
  return s in CONTINENT_NAMES;
}

function continentForCountry(country: string): Continent | null {
  return COUNTRY_TO_CONTINENT[country.toUpperCase()] ?? null;
}

function countryNameFor(country: string): string {
  return COUNTRY_NAMES[country.toUpperCase()] ?? country.toUpperCase();
}

function ipLookupEnabled(): boolean {
  return process.env.CHORUM_GEO_DISABLE_IP_LOOKUP !== "1";
}

async function lookupIp(rawIp: string): Promise<Omit<Location, "source"> | null> {
  const ip = maskIp(rawIp);
  if (!ip) return null;
  const now = Date.now();
  const cached = ipCache.get(ip);
  if (cached && cached.expires > now) return cached.loc;

  try {
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, {
      signal: AbortSignal.timeout(1500),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`ipwho.is ${res.status}`);
    const j = (await res.json()) as {
      success?: boolean;
      country_code?: string;
      country?: string;
      continent_code?: string;
      continent?: string;
    };
    if (!j.success || !j.country_code) {
      ipCache.set(ip, { expires: now + IP_TTL_MS, loc: null });
      return null;
    }
    const continent = j.continent_code && isContinent(j.continent_code)
      ? j.continent_code
      : continentForCountry(j.country_code);
    if (!continent) {
      ipCache.set(ip, { expires: now + IP_TTL_MS, loc: null });
      return null;
    }
    const loc = {
      country: j.country_code.toUpperCase(),
      continent,
      countryName: j.country ?? countryNameFor(j.country_code),
      continentName: j.continent ?? CONTINENT_NAMES[continent],
    };
    ipCache.set(ip, { expires: now + IP_TTL_MS, loc });
    return loc;
  } catch {
    ipCache.set(ip, { expires: now + 60_000, loc: null });
    return null;
  }
}

function locFromOverride(override: string | undefined): Location | null {
  if (!override) return null;
  const c = override.trim().toUpperCase();
  if (c.length !== 2) return null;
  const continent = continentForCountry(c);
  if (!continent) return null;
  return {
    country: c,
    continent,
    countryName: countryNameFor(c),
    continentName: CONTINENT_NAMES[continent],
    source: "override",
  };
}

function locFromHeaders(): Location | null {
  const country =
    getHeader("x-vercel-ip-country") ??
    getHeader("cf-ipcountry") ??
    getHeader("x-country-code");
  if (!country || country.length !== 2) return null;
  const c = country.toUpperCase();
  const continent =
    continentFromHeaders() ?? continentForCountry(c);
  if (!continent) return null;
  return {
    country: c,
    continent,
    countryName: countryNameFor(c),
    continentName: CONTINENT_NAMES[continent],
    source: "header",
  };
}

/**
 * Resolve the visitor's location. Always returns something — falls back
 * to DEFAULT_LOCATION if nothing else works.
 *
 * @param override an ISO 3166-1 alpha-2 country code that, when valid,
 *   short-circuits the lookup chain. Pass `searchParams.loc` here from a
 *   server component to support manual location switching.
 */
export async function resolveLocation(
  override?: string | undefined,
): Promise<Location> {
  const fromOverride = locFromOverride(override);
  if (fromOverride) return fromOverride;

  const fromHeaders = locFromHeaders();
  if (fromHeaders) return fromHeaders;

  const ip = clientIp();
  if (ip && !isPrivateIp(ip) && ipLookupEnabled()) {
    const looked = await lookupIp(ip);
    if (looked) return { ...looked, source: "lookup" };
  }

  return DEFAULT_LOCATION;
}
