/**
 * Known legal form suffixes. Shared between trigger
 * detection (reclassification), org-propagation (suffix
 * stripping), and the trailing-period strip in
 * sanitizeEntities. Add new entries in any order — the
 * export is sorted longest-first at module load so
 * consumers performing `endsWith` / regex-alternation
 * lookups always hit the most specific suffix
 * ("Pty Ltd." before "Pty Ltd", "spol. s r.o." before
 * "s.r.o.").
 */
const RAW_LEGAL_SUFFIXES = [
  // Czech
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
  // German / Austrian / Swiss
  "GmbH",
  "AG",
  "SE",
  "KG",
  "OHG",
  // English (UK/US/AU/IE). Title-case and ALL-CAPS
  // spellings both appear in real filings (party
  // captions and signature blocks render in caps);
  // the regex matches case-sensitively, so both
  // spellings need explicit entries.
  "Ltd.",
  "Ltd",
  "LTD.",
  "LTD",
  "LLC",
  "LLP",
  "Inc.",
  "INC.",
  "Inc",
  "INC",
  "Corp.",
  "CORP.",
  "Corp",
  "CORP",
  "Corporation",
  "CORPORATION",
  "Co.",
  "CO.",
  "LP",
  "L.P.",
  "PLC",
  "plc",
  "N.A.",
  "N.V.",
  "B.V.",
  "Pty Ltd.",
  "Pty Ltd",
  "PTY LTD.",
  "PTY LTD",
  // French / Iberian / Italian
  "S.A.",
  "SA",
  "SAS",
  "SARL",
  "S.p.A.",
  // Polish
  "Sp. z o.o.",
  "Sp. k.",
  "Sp. j.",
  // Brazilian / Portuguese. Both title-case and
  // all-caps spellings appear in BR contracts; the
  // reclassification regex is case-sensitive so each
  // spelling needs an explicit entry.
  "Ltda.",
  "LTDA.",
  "Ltda",
  "LTDA",
  "S/A",
  "EIRELI",
  "EPP",
  "ME",
  "MEI",
];

export const LEGAL_SUFFIXES: readonly string[] = [...RAW_LEGAL_SUFFIXES].sort(
  (a, b) => b.length - a.length,
);
