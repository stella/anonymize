/**
 * Known legal form suffixes. Shared between trigger
 * detection (reclassification) and org-propagation
 * (suffix stripping). Ordered longest-first so
 * "spol. s r.o." matches before "s.r.o.".
 */
export const LEGAL_SUFFIXES = [
  "spol. s r.o.",
  "s.r.o.",
  "s. r. o.",
  "a.s.",
  "a. s.",
  "v.o.s.",
  "v. o. s.",
  "k.s.",
  "k. s.",
  "z.s.",
  "z. s.",
  "z.ú.",
  "z. ú.",
  "o.p.s.",
  "o. p. s.",
  "s.p.",
  "s. p.",
  "GmbH",
  "AG",
  "SE",
  "KG",
  "OHG",
  "Ltd.",
  "Ltd",
  "LLC",
  "LLP",
  "Inc.",
  "S.A.",
  "SA",
  "SAS",
  "SARL",
  "Sp. z o.o.",
  "S.p.A.",
] as const;
