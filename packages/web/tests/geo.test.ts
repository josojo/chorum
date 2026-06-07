// Smoke tests for the geo lib. We can't exercise the IP-lookup path here
// without network, but the static country → continent map and the country
// flag emoji generator are pure and easy to assert on.

import { describe, it, expect } from "vitest";
import {
  COUNTRY_TO_CONTINENT,
  CONTINENT_NAMES,
  maskIp,
  type Continent,
} from "../src/lib/geo-data";
import { countryFlag } from "../src/lib/flags";

describe("COUNTRY_TO_CONTINENT", () => {
  it("maps known major countries correctly", () => {
    expect(COUNTRY_TO_CONTINENT.US).toBe("NA");
    expect(COUNTRY_TO_CONTINENT.DE).toBe("EU");
    expect(COUNTRY_TO_CONTINENT.JP).toBe("AS");
    expect(COUNTRY_TO_CONTINENT.BR).toBe("SA");
    expect(COUNTRY_TO_CONTINENT.AU).toBe("OC");
    expect(COUNTRY_TO_CONTINENT.NG).toBe("AF");
  });

  it("every mapped continent has a friendly name", () => {
    for (const c of Object.values(COUNTRY_TO_CONTINENT)) {
      expect(CONTINENT_NAMES[c as Continent]).toBeTruthy();
    }
  });
});

describe("maskIp (issue #104 — never send a full IP to the third party)", () => {
  it("zeroes the last octet of an IPv4 address (/24)", () => {
    expect(maskIp("203.0.113.42")).toBe("203.0.113.0");
    expect(maskIp("8.8.8.8")).toBe("8.8.8.0");
  });

  it("truncates an IPv6 address to its first three hextets (/48)", () => {
    expect(maskIp("2001:db8:abcd:1234:5678:9abc:def0:1234")).toBe("2001:db8:abcd::");
    expect(maskIp("2001:db8::1")).toBe("2001:db8:0::");
  });

  it("rejects garbage", () => {
    expect(maskIp("not-an-ip")).toBeNull();
    expect(maskIp("999.1.1.1")).toBeNull();
    expect(maskIp("1.2.3")).toBeNull();
    expect(maskIp("")).toBeNull();
  });
});

describe("countryFlag", () => {
  it("renders a regional-indicator pair for valid codes", () => {
    // 🇺🇸 = U+1F1FA U+1F1F8
    expect(countryFlag("US")).toBe("🇺🇸");
    expect(countryFlag("de")).toBe("🇩🇪");
  });

  it("falls back to the globe for invalid input", () => {
    expect(countryFlag("")).toBe("🌐");
    expect(countryFlag("X")).toBe("🌐");
    expect(countryFlag("12")).toBe("🌐");
  });
});
