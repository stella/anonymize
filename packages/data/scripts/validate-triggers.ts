/**
 * Build-time validation for trigger v2 config files.
 * Ensures all JSON configs conform to the schema
 * before the data package is published.
 *
 * Usage: bun run scripts/validate-triggers.ts
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const VALID_STRATEGY_TYPES = new Set([
  "to-next-comma",
  "to-end-of-line",
  "n-words",
  "company-id-value",
  "address",
]);

const VALID_VALIDATION_TYPES = new Set([
  "starts-uppercase",
  "min-length",
  "max-length",
  "no-digits",
  "has-digits",
  "matches-pattern",
]);

const VALID_EXTENSIONS = new Set([
  "add-colon",
  "add-trailing-space",
  "add-colon-space",
  "normalize-spaces",
]);

type ValidationError = {
  file: string;
  groupIndex: number;
  message: string;
};

const validateFile = async (filePath: string): Promise<ValidationError[]> => {
  const errors: ValidationError[] = [];
  const fileName = filePath.split("/").pop() ?? filePath;

  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    errors.push({
      file: fileName,
      groupIndex: -1,
      message: `Failed to read file`,
    });
    return errors;
  }

  let groups: unknown[];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      errors.push({
        file: fileName,
        groupIndex: -1,
        message: `Top-level value must be an array`,
      });
      return errors;
    }
    groups = parsed;
  } catch {
    errors.push({
      file: fileName,
      groupIndex: -1,
      message: `Invalid JSON`,
    });
    return errors;
  }

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (typeof group !== "object" || group === null || Array.isArray(group)) {
      errors.push({
        file: fileName,
        groupIndex: i,
        message: `Group must be an object`,
      });
      continue;
    }

    const g = group as Record<string, unknown>;

    // Required: triggers (string[])
    if (!Array.isArray(g.triggers) || g.triggers.length === 0) {
      errors.push({
        file: fileName,
        groupIndex: i,
        message: `"triggers" must be a non-empty array`,
      });
    } else {
      for (const t of g.triggers) {
        if (typeof t !== "string" || t.length === 0) {
          errors.push({
            file: fileName,
            groupIndex: i,
            message: `Each trigger must be a non-empty string`,
          });
          break;
        }
      }
    }

    // Required: label (string)
    if (typeof g.label !== "string" || g.label.length === 0) {
      errors.push({
        file: fileName,
        groupIndex: i,
        message: `"label" must be a non-empty string`,
      });
    }

    // Required: strategy
    if (typeof g.strategy !== "object" || g.strategy === null) {
      errors.push({
        file: fileName,
        groupIndex: i,
        message: `"strategy" must be an object`,
      });
    } else {
      const s = g.strategy as Record<string, unknown>;
      if (!VALID_STRATEGY_TYPES.has(s.type as string)) {
        errors.push({
          file: fileName,
          groupIndex: i,
          message: `Invalid strategy type: "${s.type}"`,
        });
      }
      if (
        s.type === "n-words" &&
        (typeof s.count !== "number" || s.count < 1)
      ) {
        errors.push({
          file: fileName,
          groupIndex: i,
          message: `n-words strategy requires count >= 1`,
        });
      }
      if (
        s.type === "address" &&
        s.maxChars !== undefined &&
        (typeof s.maxChars !== "number" || s.maxChars < 1)
      ) {
        errors.push({
          file: fileName,
          groupIndex: i,
          message: `address strategy maxChars must be >= 1`,
        });
      }
    }

    // Optional: extensions
    if (g.extensions !== undefined) {
      if (!Array.isArray(g.extensions)) {
        errors.push({
          file: fileName,
          groupIndex: i,
          message: `"extensions" must be an array`,
        });
      } else {
        for (const ext of g.extensions) {
          if (!VALID_EXTENSIONS.has(ext as string)) {
            errors.push({
              file: fileName,
              groupIndex: i,
              message: `Invalid extension: "${ext}"`,
            });
          }
        }
      }
    }

    // Optional: validations
    if (g.validations !== undefined) {
      if (!Array.isArray(g.validations)) {
        errors.push({
          file: fileName,
          groupIndex: i,
          message: `"validations" must be an array`,
        });
      } else {
        for (const val of g.validations) {
          if (typeof val !== "object" || val === null) {
            errors.push({
              file: fileName,
              groupIndex: i,
              message: `Each validation must be an object`,
            });
            continue;
          }
          const v = val as Record<string, unknown>;
          if (!VALID_VALIDATION_TYPES.has(v.type as string)) {
            errors.push({
              file: fileName,
              groupIndex: i,
              message: `Invalid validation type: "${v.type}"`,
            });
          }
          if (v.type === "min-length") {
            if (typeof v.min !== "number" || v.min < 1) {
              errors.push({
                file: fileName,
                groupIndex: i,
                message: `min-length requires "min" ` + `to be a number >= 1`,
              });
            }
          }
          if (v.type === "max-length") {
            if (typeof v.max !== "number" || v.max < 1) {
              errors.push({
                file: fileName,
                groupIndex: i,
                message: `max-length requires "max" ` + `to be a number >= 1`,
              });
            }
          }
          if (v.type === "matches-pattern") {
            if (typeof v.pattern !== "string") {
              errors.push({
                file: fileName,
                groupIndex: i,
                message: `matches-pattern requires ` + `"pattern" string`,
              });
            } else {
              const flags = typeof v.flags === "string" ? v.flags : "";
              if (/[gy]/.test(flags)) {
                errors.push({
                  file: fileName,
                  groupIndex: i,
                  message:
                    `matches-pattern: "g" and "y" ` +
                    `flags are not allowed (regex ` +
                    `is shared and stateful)`,
                });
              }
              try {
                new RegExp(v.pattern, flags || undefined);
              } catch (err) {
                errors.push({
                  file: fileName,
                  groupIndex: i,
                  message:
                    `Invalid regex pattern or flags: ` +
                    `"${v.pattern}"` +
                    (flags ? ` (flags: "${flags}")` : "") +
                    (err instanceof Error ? `: ${err.message}` : ""),
                });
              }
            }
          }
        }
      }
    }
  }

  // Intra-file duplicate trigger detection.
  // Warn when the same base trigger string appears in
  // multiple groups with different strategies or labels,
  // which causes double-extraction at runtime.
  // NOTE: only checks base triggers, not extension-
  // generated variants. Extension-generated conflicts
  // (e.g., group A "test" + add-colon vs group B
  // "test:") are caught at runtime by
  // buildTriggerPatterns' duplicate warning.
  const triggerIndex = new Map<
    string,
    { groupId: string; strategy: string; label: string }
  >();
  for (const [i, group] of groups.entries()) {
    // group is Record<string, unknown> from JSON parse
    const g = group as Record<string, unknown>;
    const stratObj = g.strategy;
    const strategy =
      typeof stratObj === "object" && stratObj !== null && "type" in stratObj
        ? String((stratObj as Record<string, unknown>).type)
        : "unknown";
    const label = typeof g.label === "string" ? g.label : "unknown";
    const gid = typeof g.id === "string" ? g.id : `group[${i}]`;
    const triggers = Array.isArray(g.triggers) ? (g.triggers as unknown[]) : [];
    // Detect intra-group duplicates (copy-paste errors)
    const groupSeen = new Set<string>();
    for (const t of triggers) {
      if (typeof t === "string") {
        const lc = t.toLowerCase();
        if (groupSeen.has(lc)) {
          errors.push({
            file: fileName,
            groupIndex: i,
            message: `Duplicate trigger "${t}" within ` + `group "${gid}"`,
          });
        }
        groupSeen.add(lc);
      }
    }
    for (const t of triggers) {
      if (typeof t !== "string") continue;
      const key = t.toLowerCase();
      const prev = triggerIndex.get(key);
      if (prev !== undefined) {
        const stratDiff = prev.strategy !== strategy;
        const labelDiff = prev.label !== label;
        if (stratDiff || labelDiff) {
          errors.push({
            file: fileName,
            groupIndex: i,
            message:
              `Duplicate trigger "${t}" also in ` +
              `"${prev.groupId}"` +
              (stratDiff
                ? ` (strategy: "${prev.strategy}"` + ` vs "${strategy}")`
                : "") +
              (labelDiff ? ` (label: "${prev.label}"` + ` vs "${label}")` : ""),
          });
        }
      }
      triggerIndex.set(key, {
        groupId: gid,
        strategy,
        label,
      });
    }
  }

  return errors;
};

const main = async (): Promise<void> => {
  const configDir = join(import.meta.dir, "..", "config");
  const files = await readdir(configDir);
  const triggerFiles = files.filter(
    (f) => f.startsWith("triggers.") && f.endsWith(".json"),
  );

  if (triggerFiles.length === 0) {
    console.error("No trigger config files found");
    process.exit(1);
  }

  let totalErrors = 0;

  for (const file of triggerFiles) {
    const filePath = join(configDir, file);
    const errors = await validateFile(filePath);
    totalErrors += errors.length;

    if (errors.length > 0) {
      console.error(`\n${file}:`);
      for (const err of errors) {
        const loc = err.groupIndex >= 0 ? ` [group ${err.groupIndex}]` : "";
        console.error(`  ${loc} ${err.message}`);
      }
    } else {
      console.log(`  ${file}: OK`);
    }
  }

  if (totalErrors > 0) {
    console.error(`\n${totalErrors} error(s) found.`);
    process.exit(1);
  }

  console.log(`\nAll ${triggerFiles.length} trigger configs valid.`);
};

main();
