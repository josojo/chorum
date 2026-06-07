// Pure geo lookup data — country/continent codes and friendly names.
// Safe to import from client components; no Next.js server-only modules.

export type Continent = "AF" | "AN" | "AS" | "EU" | "NA" | "OC" | "SA";

// Reduce an IP to its network prefix before it leaves our infra (issue #104):
// IPv4 -> /24 (last octet zeroed), IPv6 -> /48 (first three hextets, rest
// zeroed). Country resolution is unaffected; the host part — the bit that
// identifies one device — is dropped. Returns null for anything that doesn't
// parse as an address. Pure (no server-only deps) so geo.ts and tests share it.
export function maskIp(ip: string): string | null {
  if (ip.includes(".") && !ip.includes(":")) {
    const parts = ip.split(".");
    if (parts.length !== 4) return null;
    if (parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
    return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  }
  if (ip.includes(":")) {
    // Expand against "::" once, take the first 3 groups, zero-fill to /48.
    const [head, tail = ""] = ip.split("::");
    const headGroups = head ? head.split(":") : [];
    const tailGroups = tail ? tail.split(":") : [];
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 0) return null;
    const full = [...headGroups, ...Array(Math.max(missing, 0)).fill("0"), ...tailGroups];
    if (full.length !== 8) return null;
    if (full.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
    return `${full[0]}:${full[1]}:${full[2]}::`;
  }
  return null;
}

export const CONTINENT_NAMES: Record<Continent, string> = {
  AF: "Africa",
  AN: "Antarctica",
  AS: "Asia",
  EU: "Europe",
  NA: "North America",
  OC: "Oceania",
  SA: "South America",
};

export const COUNTRY_TO_CONTINENT: Record<string, Continent> = {
  // Africa
  DZ:"AF",AO:"AF",BJ:"AF",BW:"AF",BF:"AF",BI:"AF",CM:"AF",CV:"AF",CF:"AF",
  TD:"AF",KM:"AF",CG:"AF",CD:"AF",CI:"AF",DJ:"AF",EG:"AF",GQ:"AF",ER:"AF",
  SZ:"AF",ET:"AF",GA:"AF",GM:"AF",GH:"AF",GN:"AF",GW:"AF",KE:"AF",LS:"AF",
  LR:"AF",LY:"AF",MG:"AF",MW:"AF",ML:"AF",MR:"AF",MU:"AF",YT:"AF",MA:"AF",
  MZ:"AF",NA:"AF",NE:"AF",NG:"AF",RE:"AF",RW:"AF",SH:"AF",ST:"AF",SN:"AF",
  SC:"AF",SL:"AF",SO:"AF",ZA:"AF",SS:"AF",SD:"AF",TZ:"AF",TG:"AF",TN:"AF",
  UG:"AF",EH:"AF",ZM:"AF",ZW:"AF",
  // Antarctica
  AQ:"AN",BV:"AN",GS:"AN",HM:"AN",TF:"AN",
  // Asia
  AF:"AS",AM:"AS",AZ:"AS",BH:"AS",BD:"AS",BT:"AS",BN:"AS",KH:"AS",CN:"AS",
  CY:"AS",GE:"AS",HK:"AS",IN:"AS",ID:"AS",IR:"AS",IQ:"AS",IL:"AS",JP:"AS",
  JO:"AS",KZ:"AS",KP:"AS",KR:"AS",KW:"AS",KG:"AS",LA:"AS",LB:"AS",MO:"AS",
  MY:"AS",MV:"AS",MN:"AS",MM:"AS",NP:"AS",OM:"AS",PK:"AS",PS:"AS",PH:"AS",
  QA:"AS",SA:"AS",SG:"AS",LK:"AS",SY:"AS",TW:"AS",TJ:"AS",TH:"AS",TL:"AS",
  TR:"AS",TM:"AS",AE:"AS",UZ:"AS",VN:"AS",YE:"AS",
  // Europe
  AL:"EU",AD:"EU",AT:"EU",BY:"EU",BE:"EU",BA:"EU",BG:"EU",HR:"EU",CZ:"EU",
  DK:"EU",EE:"EU",FO:"EU",FI:"EU",FR:"EU",DE:"EU",GI:"EU",GR:"EU",GG:"EU",
  HU:"EU",IS:"EU",IE:"EU",IM:"EU",IT:"EU",JE:"EU",XK:"EU",LV:"EU",LI:"EU",
  LT:"EU",LU:"EU",MT:"EU",MD:"EU",MC:"EU",ME:"EU",NL:"EU",MK:"EU",NO:"EU",
  PL:"EU",PT:"EU",RO:"EU",RU:"EU",SM:"EU",RS:"EU",SK:"EU",SI:"EU",ES:"EU",
  SE:"EU",CH:"EU",UA:"EU",GB:"EU",VA:"EU",AX:"EU",SJ:"EU",
  // North America
  AI:"NA",AG:"NA",AW:"NA",BS:"NA",BB:"NA",BZ:"NA",BM:"NA",CA:"NA",KY:"NA",
  CR:"NA",CU:"NA",CW:"NA",DM:"NA",DO:"NA",SV:"NA",GL:"NA",GD:"NA",GP:"NA",
  GT:"NA",HT:"NA",HN:"NA",JM:"NA",MQ:"NA",MX:"NA",MS:"NA",NI:"NA",PA:"NA",
  PR:"NA",BL:"NA",KN:"NA",LC:"NA",MF:"NA",PM:"NA",VC:"NA",SX:"NA",TT:"NA",
  TC:"NA",US:"NA",VG:"NA",VI:"NA",
  // Oceania
  AS:"OC",AU:"OC",CK:"OC",FJ:"OC",PF:"OC",GU:"OC",KI:"OC",MH:"OC",FM:"OC",
  NR:"OC",NC:"OC",NZ:"OC",NU:"OC",NF:"OC",MP:"OC",PW:"OC",PG:"OC",PN:"OC",
  WS:"OC",SB:"OC",TK:"OC",TO:"OC",TV:"OC",UM:"OC",VU:"OC",WF:"OC",
  // South America
  AR:"SA",BO:"SA",BR:"SA",CL:"SA",CO:"SA",EC:"SA",FK:"SA",GF:"SA",GY:"SA",
  PY:"SA",PE:"SA",SR:"SA",UY:"SA",VE:"SA",
};

// Subset of friendly names — only the ones we ship test data for. Anything
// not listed falls back to the bare 2-letter code, which is acceptable.
export const COUNTRY_NAMES: Record<string, string> = {
  US: "United States", CA: "Canada", MX: "Mexico", BR: "Brazil", AR: "Argentina",
  GB: "United Kingdom", DE: "Germany", FR: "France", ES: "Spain", IT: "Italy",
  NL: "Netherlands", SE: "Sweden", NO: "Norway", PL: "Poland", UA: "Ukraine",
  CH: "Switzerland", AT: "Austria", BE: "Belgium", IE: "Ireland", DK: "Denmark",
  JP: "Japan", CN: "China", IN: "India", KR: "South Korea", SG: "Singapore",
  ID: "Indonesia", TH: "Thailand", VN: "Vietnam", AE: "United Arab Emirates",
  IL: "Israel", TR: "Turkey", SA: "Saudi Arabia", PH: "Philippines",
  AU: "Australia", NZ: "New Zealand", FJ: "Fiji",
  ZA: "South Africa", NG: "Nigeria", EG: "Egypt", KE: "Kenya", MA: "Morocco",
  CO: "Colombia", CL: "Chile", PE: "Peru", VE: "Venezuela", UY: "Uruguay",
  RU: "Russia", FI: "Finland", PT: "Portugal", GR: "Greece", CZ: "Czechia",
};
