/**
 * Geographic regions and country code mappings for
 * scoping deny list dictionaries.
 */

export const REGIONS = {
  Global: null,
  International: null,
  Europe: [
    "AL",
    "AD",
    "AT",
    "BE",
    "BA",
    "BG",
    "HR",
    "CY",
    "CZ",
    "DK",
    "EE",
    "FI",
    "FR",
    "DE",
    "GR",
    "HU",
    "IS",
    "IE",
    "IT",
    "XK",
    "LV",
    "LI",
    "LT",
    "LU",
    "MD",
    "ME",
    "MK",
    "MT",
    "MC",
    "NL",
    "NO",
    "PL",
    "PT",
    "RO",
    "RS",
    "SK",
    "SI",
    "ES",
    "SE",
    "CH",
    "UA",
    "GB",
  ],
  Americas: [
    "US",
    "CA",
    "MX",
    "BR",
    "AR",
    "CL",
    "CO",
    "PE",
    "EC",
    "VE",
    "UY",
    "PY",
    "BO",
    "CR",
    "PA",
    "DO",
    "GT",
    "HN",
    "SV",
    "NI",
    "CU",
  ],
  AsiaPacific: [
    "AU",
    "NZ",
    "JP",
    "KR",
    "CN",
    "TW",
    "SG",
    "MY",
    "TH",
    "VN",
    "PH",
    "ID",
    "IN",
    "PK",
    "BD",
    "LK",
    "NP",
    "HK",
    "MO",
  ],
  MENA: [
    "AE",
    "SA",
    "IL",
    "TR",
    "EG",
    "JO",
    "LB",
    "IQ",
    "IR",
    "QA",
    "KW",
    "BH",
    "OM",
    "MA",
    "TN",
    "DZ",
    "LY",
    "SY",
    "YE",
    "PS",
  ],
  SubSaharanAfrica: [
    "ZA",
    "NG",
    "KE",
    "GH",
    "TZ",
    "ET",
    "SN",
    "CI",
    "CM",
    "UG",
    "RW",
    "MZ",
    "AO",
    "ZW",
    "BW",
    "NA",
    "MU",
  ],
  EU: [
    "AT",
    "BE",
    "BG",
    "HR",
    "CY",
    "CZ",
    "DK",
    "EE",
    "FI",
    "FR",
    "DE",
    "GR",
    "HU",
    "IE",
    "IT",
    "LV",
    "LT",
    "LU",
    "MT",
    "NL",
    "PL",
    "PT",
    "RO",
    "SK",
    "SI",
    "ES",
    "SE",
  ],
  DACH: ["DE", "AT", "CH"],
  Nordics: ["DK", "SE", "NO", "FI", "IS"],
  CEE: ["CZ", "SK", "PL", "HU", "RO", "BG", "HR", "SI", "LT", "LV", "EE"],
  Anglosphere: ["GB", "US", "CA", "AU", "NZ", "IE"],
  Benelux: ["BE", "NL", "LU"],
  GulfStates: ["AE", "SA", "QA", "KW", "BH", "OM"],
  SouthAsia: ["IN", "PK", "BD", "LK", "NP"],
  EastAsia: ["CN", "JP", "KR", "TW"],
  SoutheastAsia: ["SG", "MY", "TH", "VN", "PH", "ID"],
  Oceania: ["AU", "NZ"],
} as const;

export type RegionId = keyof typeof REGIONS;

type RegionArrays = {
  [K in RegionId]: (typeof REGIONS)[K];
};

type NonNullRegion = {
  [K in RegionId as RegionArrays[K] extends null ? never : K]: RegionArrays[K];
};

export type CountryCode = NonNullRegion[keyof NonNullRegion][number];

/**
 * Expand region names to country codes and merge with
 * explicit country codes. Returns null when both inputs
 * are empty/undefined (meaning "match all countries").
 */
export const resolveCountries = (
  regions?: string[],
  countries?: string[],
): Set<string> | null => {
  const hasRegions = regions && regions.length > 0;
  const hasCountries = countries && countries.length > 0;

  if (!hasRegions && !hasCountries) {
    return null;
  }

  const result = new Set<string>();

  const isRegion = (name: string): name is RegionId => name in REGIONS;

  if (hasRegions) {
    for (const name of regions) {
      if (!isRegion(name)) {
        continue;
      }
      const codes = REGIONS[name];
      if (codes === null) {
        // Global/International: return null (all)
        return null;
      }
      for (const code of codes) {
        result.add(code);
      }
    }
  }

  if (hasCountries) {
    for (const code of countries) {
      result.add(code);
    }
  }

  return result;
};
