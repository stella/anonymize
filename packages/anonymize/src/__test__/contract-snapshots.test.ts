import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  createPipelineContext,
  DEFAULT_ENTITY_LABELS,
  redactText,
  runPipeline,
} from "../index";
import type { PipelineContext } from "../context";
import type { Entity, PipelineConfig } from "../types";

const FIXTURES_DIR = join(import.meta.dir, "fixtures", "contracts");
const UPDATE_SNAPSHOTS = process.env.UPDATE_CONTRACT_SNAPSHOTS === "1";

const CONFIG: PipelineConfig = {
  threshold: 0.3,
  enableTriggerPhrases: true,
  enableRegex: true,
  enableLegalForms: true,
  enableNameCorpus: true,
  enableDenyList: true,
  enableGazetteer: false,
  enableNer: false,
  enableConfidenceBoost: true,
  enableCoreference: true,
  enableHotwordRules: true,
  enableZoneClassification: true,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "contract-snapshot-test",
};

type SnapshotEntity = Pick<Entity, "start" | "end" | "label" | "text" | "source">;

type ContractSnapshot = {
  entityCount: number;
  counts: Record<string, number>;
  entities: SnapshotEntity[];
  redactedText: string;
};

type ContractFixture = {
  name: string;
  textPath: string;
  snapshotPath: string;
  assertQuality?: (entities: Entity[]) => void;
};

const FIXTURES: ContractFixture[] = [
  {
    name: "czech registr smluv service contract",
    textPath: join(FIXTURES_DIR, "cs", "database-cz-service-contract.txt"),
    snapshotPath: join(
      FIXTURES_DIR,
      "cs",
      "database-cz-service-contract.snapshot.json",
    ),
    assertQuality: (entities) => {
      expect(
        entities.some(
          (entity) =>
            entity.label === "registration number" && entity.text === "C",
        ),
      ).toBe(false);
      expect(
        entities.some(
          (entity) =>
            entity.label === "address" && /^(?:V|Ve)\s+.+\s+dne$/u.test(entity.text),
        ),
      ).toBe(false);
    },
  },
];

const toSnapshot = (
  fullText: string,
  entities: Entity[],
  ctx: PipelineContext,
): ContractSnapshot => {
  const sorted = entities.toSorted(
    (left, right) =>
      left.start - right.start ||
      left.end - right.end ||
      left.label.localeCompare(right.label) ||
      left.text.localeCompare(right.text),
  );
  const counts: Record<string, number> = {};
  for (const entity of sorted) {
    counts[entity.label] = (counts[entity.label] ?? 0) + 1;
  }

  const redacted = redactText(fullText, sorted, undefined, ctx);

  return {
    entityCount: sorted.length,
    counts,
    entities: sorted.map(({ start, end, label, text, source }) => ({
      start,
      end,
      label,
      text,
      source,
    })),
    redactedText: redacted.redactedText,
  };
};

const writeSnapshot = (path: string, snapshot: ContractSnapshot) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`);
};

describe("contract snapshots", () => {
  for (const fixture of FIXTURES) {
    test(fixture.name, async () => {
      const fullText = readFileSync(fixture.textPath, "utf8");
      const ctx = createPipelineContext();
      const entities = await runPipeline({
        fullText,
        config: CONFIG,
        gazetteerEntries: [],
        context: ctx,
      });

      fixture.assertQuality?.(entities);

      const snapshot = toSnapshot(fullText, entities, ctx);

      if (UPDATE_SNAPSHOTS || !existsSync(fixture.snapshotPath)) {
        writeSnapshot(fixture.snapshotPath, snapshot);
      }

      const expected = JSON.parse(
        readFileSync(fixture.snapshotPath, "utf8"),
      ) as ContractSnapshot;

      expect(snapshot).toEqual(expected);
    });
  }
});
