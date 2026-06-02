// Pure predicate derivation: Self disclosures -> Hearme bucketed predicates.
//
// The broker is authoritative for disclosed_predicates (ARCHITECTURE_V0.md §5): it
// derives them from the verified Self outputs, never trusting a client copy.
//   - region   <- nationality (ISO-3166 alpha-2) mapped to a continent code
//                  (AF/AN/AS/EU/NA/OC/SA). Europe collapses to "EU".
//   - country  <- the raw ISO-3166 alpha-2 nationality (upper-cased).
//   - age_band <- the max satisfied "older-than" threshold from the ladder. A
//                  lone 18 proof yields "18+".

export class PredicateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PredicateError";
  }
}

// Continent membership by ISO-3166-1 alpha-2. Europe -> "EU".
const CONTINENT_COUNTRIES: Record<string, string[]> = {
  EU: [
    "AL", "AD", "AT", "BA", "BE", "BG", "BY", "CH", "CY", "CZ", "DE", "DK",
    "EE", "ES", "FI", "FO", "FR", "GB", "GE", "GI", "GR", "HR", "HU", "IE",
    "IS", "IT", "LI", "LT", "LU", "LV", "MC", "MD", "ME", "MK", "MT", "NL",
    "NO", "PL", "PT", "RO", "RS", "RU", "SE", "SI", "SK", "SM", "UA", "VA",
    "XK",
  ],
  AS: [
    "AE", "AF", "AM", "AZ", "BD", "BH", "BN", "BT", "CN", "HK", "ID", "IL",
    "IN", "IQ", "IR", "JO", "JP", "KG", "KH", "KP", "KR", "KW", "KZ", "LA",
    "LB", "LK", "MM", "MN", "MO", "MV", "MY", "NP", "OM", "PH", "PK", "PS",
    "QA", "SA", "SG", "SY", "TH", "TJ", "TL", "TM", "TR", "TW", "UZ", "VN",
    "YE",
  ],
  AF: [
    "AO", "BF", "BI", "BJ", "BW", "CD", "CF", "CG", "CI", "CM", "CV", "DJ",
    "DZ", "EG", "EH", "ER", "ET", "GA", "GH", "GM", "GN", "GQ", "GW", "KE",
    "KM", "LR", "LS", "LY", "MA", "MG", "ML", "MR", "MU", "MW", "MZ", "NA",
    "NE", "NG", "RW", "SC", "SD", "SL", "SN", "SO", "SS", "ST", "SZ", "TD",
    "TG", "TN", "TZ", "UG", "ZA", "ZM", "ZW",
  ],
  NA: [
    "AG", "BB", "BS", "BZ", "CA", "CR", "CU", "DM", "DO", "GD", "GT", "HN",
    "HT", "JM", "KN", "LC", "MX", "NI", "PA", "PR", "SV", "TT", "US", "VC",
  ],
  SA: ["AR", "BO", "BR", "CL", "CO", "EC", "GY", "PE", "PY", "SR", "UY", "VE"],
  OC: [
    "AU", "FJ", "FM", "KI", "MH", "NR", "NZ", "PG", "PW", "SB", "TO", "TV",
    "VU", "WS",
  ],
  AN: ["AQ"],
};

const COUNTRY_TO_CONTINENT: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [continent, countries] of Object.entries(CONTINENT_COUNTRIES)) {
    for (const country of countries) out[country] = continent;
  }
  return out;
})();

// Self discloses nationality as ISO-3166 alpha-3 (e.g. 'USA'); normalize to alpha-2.
const ALPHA3_TO_ALPHA2: Record<string, string> = {
  AND: "AD", ARE: "AE", AFG: "AF", ATG: "AG", ALB: "AL", ARM: "AM", AGO: "AO",
  ATA: "AQ", ARG: "AR", AUT: "AT", AUS: "AU", AZE: "AZ", BIH: "BA", BRB: "BB",
  BGD: "BD", BEL: "BE", BFA: "BF", BGR: "BG", BHR: "BH", BDI: "BI", BEN: "BJ",
  BRN: "BN", BOL: "BO", BRA: "BR", BHS: "BS", BTN: "BT", BWA: "BW", BLR: "BY",
  BLZ: "BZ", CAN: "CA", COD: "CD", CAF: "CF", COG: "CG", CHE: "CH", CIV: "CI",
  CHL: "CL", CMR: "CM", CHN: "CN", COL: "CO", CRI: "CR", CUB: "CU", CPV: "CV",
  CYP: "CY", CZE: "CZ", DEU: "DE", DJI: "DJ", DNK: "DK", DMA: "DM", DOM: "DO",
  DZA: "DZ", ECU: "EC", EST: "EE", EGY: "EG", ESH: "EH", ERI: "ER", ESP: "ES",
  ETH: "ET", FIN: "FI", FJI: "FJ", FSM: "FM", FRO: "FO", FRA: "FR", GAB: "GA",
  GBR: "GB", GRD: "GD", GEO: "GE", GHA: "GH", GIB: "GI", GMB: "GM", GIN: "GN",
  GNQ: "GQ", GRC: "GR", GTM: "GT", GNB: "GW", GUY: "GY", HKG: "HK", HND: "HN",
  HRV: "HR", HTI: "HT", HUN: "HU", IDN: "ID", IRL: "IE", ISR: "IL", IND: "IN",
  IRQ: "IQ", IRN: "IR", ISL: "IS", ITA: "IT", JAM: "JM", JOR: "JO", JPN: "JP",
  KEN: "KE", KGZ: "KG", KHM: "KH", KIR: "KI", COM: "KM", KNA: "KN", PRK: "KP",
  KOR: "KR", KWT: "KW", KAZ: "KZ", LAO: "LA", LBN: "LB", LCA: "LC", LIE: "LI",
  LKA: "LK", LBR: "LR", LSO: "LS", LTU: "LT", LUX: "LU", LVA: "LV", LBY: "LY",
  MAR: "MA", MCO: "MC", MDA: "MD", MNE: "ME", MDG: "MG", MHL: "MH", MKD: "MK",
  MLI: "ML", MMR: "MM", MNG: "MN", MAC: "MO", MRT: "MR", MLT: "MT", MUS: "MU",
  MDV: "MV", MWI: "MW", MEX: "MX", MYS: "MY", MOZ: "MZ", NAM: "NA", NER: "NE",
  NGA: "NG", NIC: "NI", NLD: "NL", NOR: "NO", NPL: "NP", NRU: "NR", NZL: "NZ",
  OMN: "OM", PAN: "PA", PER: "PE", PNG: "PG", PHL: "PH", PAK: "PK", POL: "PL",
  PRI: "PR", PSE: "PS", PRT: "PT", PLW: "PW", PRY: "PY", QAT: "QA", ROU: "RO",
  SRB: "RS", RUS: "RU", RWA: "RW", SAU: "SA", SLB: "SB", SYC: "SC", SDN: "SD",
  SWE: "SE", SGP: "SG", SVN: "SI", SVK: "SK", SLE: "SL", SMR: "SM", SEN: "SN",
  SOM: "SO", SUR: "SR", SSD: "SS", STP: "ST", SLV: "SV", SYR: "SY", SWZ: "SZ",
  TCD: "TD", TGO: "TG", THA: "TH", TJK: "TJ", TLS: "TL", TKM: "TM", TUN: "TN",
  TON: "TO", TUR: "TR", TTO: "TT", TUV: "TV", TWN: "TW", TZA: "TZ", UKR: "UA",
  UGA: "UG", USA: "US", URY: "UY", UZB: "UZ", VAT: "VA", VCT: "VC", VEN: "VE",
  VNM: "VN", VUT: "VU", WSM: "WS", YEM: "YE", ZAF: "ZA", ZMB: "ZM", ZWE: "ZW",
  XKX: "XK",
};

// The standard age ladder (ARCHITECTURE_V0.md §8.3). Keep in sync with the
// self-bridge SELF_AGE_THRESHOLDS default.
export const AGE_LADDER: readonly number[] = [18, 25, 35, 50, 65];

const BAND_BY_MAX: Record<number, string> = {
  18: "18-24",
  25: "25-34",
  35: "35-49",
  50: "50-64",
  65: "65+",
};

// Strip ICAO Doc 9303 MRZ fillers and remap legacy national codes (e.g. the
// pre-2007 German passport "D<<" -> "DE"). Returns the input unchanged when
// nothing applies.
function normalizeMrzCountry(code: string): string {
  const cleaned = code.replace(/</g, "");
  if (cleaned === "D") return "DE";
  return cleaned;
}

// Map an ISO-3166 country code (alpha-2 or alpha-3) to a continent code.
export function countryToRegion(country: string): string {
  if (!country) throw new PredicateError("nationality missing");
  let code = normalizeMrzCountry(country.trim().toUpperCase());
  if (code.length === 3) code = ALPHA3_TO_ALPHA2[code] ?? code;
  const region = COUNTRY_TO_CONTINENT[code];
  if (region === undefined) {
    throw new PredicateError(`unmapped country code '${country.trim().toUpperCase()}'`);
  }
  return region;
}

// Map satisfied older-than thresholds to a band. 18 must be present
// (registration is adult-gated). A lone 18 yields "18+".
export function thresholdsToAgeBand(satisfied: number[]): string {
  const ladder = new Set(AGE_LADDER);
  const valid = [...new Set(satisfied.filter((t) => ladder.has(t)))].sort((a, b) => a - b);
  if (valid.length === 0 || valid[0] !== 18) {
    throw new PredicateError("age: no satisfied 18+ threshold");
  }
  if (valid.length === 1) return "18+";
  return BAND_BY_MAX[valid[valid.length - 1]];
}

// Full derivation -> {region, country, age_band}. Throws PredicateError.
export function derivePredicates(args: {
  nationality: string;
  satisfiedThresholds: number[];
}): Record<string, string> {
  let code = normalizeMrzCountry(args.nationality.trim().toUpperCase());
  if (code.length === 3) code = ALPHA3_TO_ALPHA2[code] ?? code;
  const region = countryToRegion(code);
  return {
    region,
    country: code,
    age_band: thresholdsToAgeBand(args.satisfiedThresholds),
  };
}
