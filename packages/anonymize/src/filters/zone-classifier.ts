import type { Entity } from "../types";
import type { PipelineContext } from "../context";
import { defaultContext } from "../context";

// ── Zone types ───────────────────────────────────

export type DocumentZone =
  | "header"
  | "signature"
  | "body"
  | "table";

export type ZoneSpan = {
  zone: DocumentZone;
  start: number;
  end: number;
};

// ── Score adjustments per zone ───────────────────

/**
 * Additive score adjustments per document zone.
 * Header and signature blocks are dense with PII;
 * tables often contain structured identifying data.
 */
export const ZONE_SCORE_ADJUSTMENTS = {
  header: 0.1,
  signature: 0.15,
  body: 0,
  table: 0.05,
} as const satisfies Record<DocumentZone, number>;

// ── Lazy-loaded config ───────────────────────────

type SectionHeadingsConfig = {
  patterns: Array<{ re: string; flags: string }>;
};

type SigningClauseConfig = {
  patterns: Array<{
    lang: string;
    prefix: string;
    suffix: string;
    prepositions: string[];
  }>;
};

const loadSectionHeadings =
  async (): Promise<RegExp[]> => {
    const mod = await import(
      "@stll/anonymize-data/config/section-headings.json"
    );
    const data: SectionHeadingsConfig =
      mod.default ?? mod;
    return data.patterns.map(
      (p) => new RegExp(p.re, p.flags),
    );
  };

const loadSigningClauses =
  async (): Promise<RegExp[]> => {
    const mod = await import(
      "@stll/anonymize-data/config/signing-clauses.json"
    );
    const data: SigningClauseConfig =
      mod.default ?? mod;
    return data.patterns.map((p) => {
      // Build a pattern that matches the signing
      // clause prefix at the start of a line.
      // Note: prefix/suffix are regex fragments by
      // design (e.g. `(?:V|Ve)\\s+`), not literals.
      const prefix = p.prefix || "";
      const suffix = p.suffix || "";
      // Include prepositions so multi-word place
      // names like "Ústí nad Labem" are matched,
      // consistent with buildSigningClausePatterns
      // in detectors/regex.ts.
      const prepAlt =
        p.prepositions.length > 0
          ? p.prepositions.join("|")
          : null;
      const place = prepAlt
        ? `\\p{Lu}\\p{Ll}+` +
          `(?:\\s+(?:${prepAlt})` +
          `\\s+\\p{Lu}\\p{Ll}+)*` +
          `(?:\\s+\\p{Lu}\\p{Ll}+)*`
        : `\\p{Lu}\\p{Ll}+` +
          `(?:[- ]\\p{Lu}\\p{Ll}+)*`;
      // Anchor to the start of the line. Each line is
      // already split on \n, so ^ suffices without m.
      const combined =
        `^\\s*(?:${prefix}${place}${suffix})`;
      return new RegExp(combined, "u");
    });
  };

/**
 * Ensure config data is loaded. Call once before
 * classifyZones. Safe to call multiple times.
 */
export const initZoneClassifier = (
  ctx: PipelineContext = defaultContext,
): Promise<void> => {
  if (ctx.zoneInitPromise) return ctx.zoneInitPromise;
  ctx.zoneInitPromise = Promise.all([
    loadSectionHeadings(),
    loadSigningClauses(),
  ])
    .then(([headings, clauses]) => {
      ctx.zoneHeadingPatterns = headings;
      ctx.zoneSigningPatterns = clauses;
    })
    .catch((err: unknown) => {
      // Clear cached promise so a subsequent call
      // can retry after a transient failure.
      ctx.zoneInitPromise = null;
      throw err;
    });
  return ctx.zoneInitPromise;
};

// ── Table detection ──────────────────────────────

const MIN_TABS_FOR_TABLE = 2;

const isTableLine = (line: string): boolean => {
  let tabCount = 0;
  for (const ch of line) {
    if (ch === "\t") tabCount++;
    if (tabCount >= MIN_TABS_FOR_TABLE) return true;
  }
  return false;
};

// ── Zone classification ──────────────────────────

/**
 * Classify a document into zones based on
 * structural heuristics. Zones are non-overlapping
 * and cover the entire text.
 *
 * Must call `initZoneClassifier()` first.
 */
export const classifyZones = (
  fullText: string,
  ctx: PipelineContext = defaultContext,
): ZoneSpan[] => {
  if (fullText.length === 0) return [];

  const headingRes = ctx.zoneHeadingPatterns;
  const signingRes = ctx.zoneSigningPatterns;

  if (!headingRes || !signingRes) {
    console.warn(
      "[anonymize] classifyZones called before " +
        "initZoneClassifier(); returning body-only",
    );
    return [
      { zone: "body", start: 0, end: fullText.length },
    ];
  }

  const lines = fullText.split("\n");
  const zones: ZoneSpan[] = [];

  // Find header end: first section heading line
  let headerEndLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    for (const re of headingRes) {
      if (re.test(line)) {
        headerEndLine = i;
        break;
      }
    }
    if (headerEndLine !== -1) break;
  }

  // Find signature start: last signing clause line
  let signatureStartLine = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    for (const re of signingRes) {
      if (re.test(line)) {
        signatureStartLine = i;
        break;
      }
    }
    if (signatureStartLine !== -1) break;
  }

  // Build offset map: line index -> char offset
  const lineOffsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineOffsets.push(offset);
    // +1 for the newline character
    offset += line.length + 1;
  }

  // Determine zone boundaries
  let headerEndOffset =
    headerEndLine >= 0
      ? (lineOffsets[headerEndLine] ?? 0)
      : 0;

  const signatureStartOffset =
    signatureStartLine >= 0
      ? (lineOffsets[signatureStartLine] ??
        fullText.length)
      : fullText.length;

  // Guard: if the signing clause appears before
  // the first section heading, the zones would
  // overlap. Treat as degenerate layout: drop the
  // header so the signature zone takes priority.
  if (
    headerEndLine > 0 &&
    signatureStartLine >= 0 &&
    headerEndOffset > signatureStartOffset
  ) {
    headerEndLine = -1;
    headerEndOffset = 0;
  }

  // Add header zone if detected. Using > 0 (not
  // >= 0) intentionally: when the section heading is
  // on line 0, there is no preamble to classify as a
  // header — everything starts as body.
  if (headerEndLine > 0) {
    zones.push({
      zone: "header",
      start: 0,
      end: headerEndOffset,
    });
  }

  // Scan body region for table zones
  const bodyStart =
    headerEndLine > 0 ? headerEndOffset : 0;
  const bodyEnd =
    signatureStartLine >= 0
      ? signatureStartOffset
      : fullText.length;

  let tableStart = -1;
  for (
    let i = Math.max(headerEndLine, 0);
    i <
    (signatureStartLine >= 0
      ? signatureStartLine
      : lines.length);
    i++
  ) {
    const line = lines[i];
    if (line === undefined) continue;
    const lineStart = lineOffsets[i] ?? 0;
    const lineEnd = lineStart + line.length;

    if (isTableLine(line)) {
      if (tableStart === -1) {
        tableStart = lineStart;
      }
    } else if (tableStart !== -1) {
      zones.push({
        zone: "table",
        start: tableStart,
        end: lineStart,
      });
      tableStart = -1;
    }

    // Close table at the end of body range
    if (
      i ===
        (signatureStartLine >= 0
          ? signatureStartLine - 1
          : lines.length - 1) &&
      tableStart !== -1
    ) {
      zones.push({
        zone: "table",
        start: tableStart,
        end: Math.min(lineEnd + 1, bodyEnd),
      });
      tableStart = -1;
    }
  }

  // Fill body gaps between header/table/signature
  const sortedSpecial = zones.toSorted(
    (a, b) => a.start - b.start,
  );

  let cursor = bodyStart;
  const bodyZones: ZoneSpan[] = [];
  for (const span of sortedSpecial) {
    if (span.zone === "header") continue;
    if (span.start > cursor) {
      bodyZones.push({
        zone: "body",
        start: cursor,
        end: span.start,
      });
    }
    cursor = Math.max(cursor, span.end);
  }
  if (cursor < bodyEnd) {
    bodyZones.push({
      zone: "body",
      start: cursor,
      end: bodyEnd,
    });
  }

  for (const z of bodyZones) zones.push(z);

  // Add signature zone if detected
  if (signatureStartLine >= 0) {
    zones.push({
      zone: "signature",
      start: signatureStartOffset,
      end: fullText.length,
    });
  }

  return zones.toSorted(
    (a, b) => a.start - b.start,
  );
};

// ── Entity zone lookup ───────────────────────────

/**
 * Find which zone an entity's midpoint falls in.
 * Returns "body" if no zone matches (defensive).
 */
const findZone = (
  midpoint: number,
  zones: ZoneSpan[],
): DocumentZone => {
  for (const span of zones) {
    if (
      midpoint >= span.start &&
      midpoint < span.end
    ) {
      return span.zone;
    }
  }
  return "body";
};

/**
 * Apply zone-based score adjustments to entities.
 * Entities in header/signature/table zones get a
 * small additive boost reflecting the higher PII
 * density in those regions.
 *
 * Returns a new array; does not mutate inputs.
 */
export const applyZoneAdjustments = (
  entities: Entity[],
  zones: ZoneSpan[],
): Entity[] => {
  if (zones.length === 0) {
    return entities.map((e) => ({ ...e }));
  }

  const result: Entity[] = [];
  for (const entity of entities) {
    const midpoint =
      (entity.start + entity.end) / 2;
    const zone = findZone(midpoint, zones);
    const adjustment = ZONE_SCORE_ADJUSTMENTS[zone];

    if (adjustment > 0) {
      result.push({
        ...entity,
        score: Math.min(
          1,
          entity.score + adjustment,
        ),
      });
    } else {
      result.push({ ...entity });
    }
  }
  return result;
};
