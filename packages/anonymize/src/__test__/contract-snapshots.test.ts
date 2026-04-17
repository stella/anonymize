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

const CONTEXT = createPipelineContext();

type SnapshotEntity = Pick<
  Entity,
  "start" | "end" | "label" | "text" | "source"
>;

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
            entity.label === "address" &&
            /^(?:V|Ve)\s+.+\s+dne$/u.test(entity.text),
        ),
      ).toBe(false);
    },
  },
  {
    name: "edgar employment agreement",
    textPath: join(FIXTURES_DIR, "en", "pra-group-employment-agreement.txt"),
    snapshotPath: join(
      FIXTURES_DIR,
      "en",
      "pra-group-employment-agreement.snapshot.json",
    ),
    assertQuality: (entities) => {
      expect(
        entities.some(
          (entity) =>
            entity.label === "organization" &&
            entity.text === "PRA Group, Inc.",
        ),
      ).toBe(true);
      expect(
        entities.some(
          (entity) =>
            entity.label === "person" && entity.text === "Vikram A. Atal",
        ),
      ).toBe(true);
      expect(
        entities.some(
          (entity) =>
            entity.label === "organization" && entity.text === "Committee",
        ),
      ).toBe(false);
      expect(
        entities.some(
          (entity) =>
            entity.label === "person" &&
            (entity.text === "COBRA Reimbursement Period" ||
              entity.text === "American Arbitration Association" ||
              entity.text === "Dodd-Frank Wall Street Reform"),
        ),
      ).toBe(false);
    },
  },
  {
    name: "czech sanofi bonus agreement",
    textPath: join(FIXTURES_DIR, "cs", "sanofi-bonus-agreement.txt"),
    snapshotPath: join(
      FIXTURES_DIR,
      "cs",
      "sanofi-bonus-agreement.snapshot.json",
    ),
    assertQuality: (entities) => {
      expect(
        entities.some(
          (entity) =>
            entity.label === "organization" && entity.text === "Sanofi s.r.o.",
        ),
      ).toBe(true);
      expect(
        entities.some(
          (entity) =>
            entity.label === "organization" &&
            entity.text === "Nemocnice Blansko",
        ),
      ).toBe(true);
      expect(
        entities.some(
          (entity) =>
            entity.label === "registration number" && entity.text === "Pr",
        ),
      ).toBe(false);
      expect(
        entities.some(
          (entity) => entity.label === "address" && entity.text === "Republic",
        ),
      ).toBe(false);
    },
  },
  {
    name: "czech vinci donation agreement",
    textPath: join(FIXTURES_DIR, "cs", "vinci-donation-agreement.txt"),
    snapshotPath: join(
      FIXTURES_DIR,
      "cs",
      "vinci-donation-agreement.snapshot.json",
    ),
    assertQuality: (entities) => {
      expect(
        entities.some(
          (entity) =>
            entity.label === "organization" &&
            entity.text === "VINCI Construction CS a.s.",
        ),
      ).toBe(true);
      expect(
        entities.some(
          (entity) =>
            entity.label === "person" &&
            entity.text.includes("Martinem Borovkou"),
        ),
      ).toBe(true);
    },
  },
  {
    name: "czech eagles rental agreement",
    textPath: join(FIXTURES_DIR, "cs", "eagles-rental-agreement.txt"),
    snapshotPath: join(
      FIXTURES_DIR,
      "cs",
      "eagles-rental-agreement.snapshot.json",
    ),
    assertQuality: (entities) => {
      expect(
        entities.some(
          (entity) =>
            entity.label === "organization" &&
            entity.text === "EAGLES BRNO, z.s.",
        ),
      ).toBe(true);
      expect(
        entities.some(
          (entity) =>
            entity.label === "organization" &&
            entity.text ===
              "Základní škola, Brno, Kamínky 5, příspěvková organizace",
        ),
      ).toBe(true);
    },
  },
  {
    name: "czech nakit legal services framework",
    textPath: join(FIXTURES_DIR, "cs", "nakit-legal-services-framework.txt"),
    snapshotPath: join(
      FIXTURES_DIR,
      "cs",
      "nakit-legal-services-framework.snapshot.json",
    ),
    assertQuality: (entities) => {
      expect(
        entities.some(
          (entity) =>
            entity.label === "organization" &&
            entity.text ===
              "Národní agentura pro komunikační a informační technologie, s. p.",
        ),
      ).toBe(true);
      expect(
        entities.some(
          (entity) =>
            entity.label === "person" && entity.text === "Mgr. Ondřej Durďák",
        ),
      ).toBe(true);
      expect(
        entities.some(
          (entity) => entity.label === "address" && entity.text === "Lhůta",
        ),
      ).toBe(false);
    },
  },
  {
    name: "edgar gt biopharma employment amendment",
    textPath: join(FIXTURES_DIR, "en", "gt-biopharma-employment-amendment.txt"),
    snapshotPath: join(
      FIXTURES_DIR,
      "en",
      "gt-biopharma-employment-amendment.snapshot.json",
    ),
    assertQuality: (entities) => {
      expect(
        entities.some(
          (entity) =>
            entity.label === "organization" &&
            entity.text === "GT Biopharma, Inc.",
        ),
      ).toBe(true);
      expect(
        entities.some(
          (entity) =>
            entity.label === "person" && entity.text === "Michael Breen",
        ),
      ).toBe(true);
      expect(
        entities.some(
          (entity) =>
            entity.label === "address" &&
            (entity.text === "Page" || entity.text === "Page Follows"),
        ),
      ).toBe(false);
    },
  },
  {
    name: "edgar healthcare trust employment amendment",
    textPath: join(
      FIXTURES_DIR,
      "en",
      "healthcare-trust-employment-amendment.txt",
    ),
    snapshotPath: join(
      FIXTURES_DIR,
      "en",
      "healthcare-trust-employment-amendment.snapshot.json",
    ),
    assertQuality: (entities) => {
      expect(
        entities.some(
          (entity) =>
            entity.label === "person" && entity.text === "Amanda L. Houghton",
        ),
      ).toBe(true);
      expect(
        entities.some(
          (entity) =>
            entity.label === "person" && entity.text === "Peter N. Foss",
        ),
      ).toBe(true);
      expect(
        entities.some(
          (entity) =>
            entity.label === "organization" &&
            entity.text ===
              "THIS AMENDMENT NO. 1 TO AMENDED AND RESTATED EMPLOYMENT AGREEMENT",
        ),
      ).toBe(false);
      expect(
        entities.some(
          (entity) => entity.label === "date" && entity.text.includes("&#"),
        ),
      ).toBe(false);
    },
  },
  {
    name: "czech probo frame purchase contract",
    textPath: join(FIXTURES_DIR, "cs", "probo-frame-purchase-contract.txt"),
    snapshotPath: join(
      FIXTURES_DIR,
      "cs",
      "probo-frame-purchase-contract.snapshot.json",
    ),
    assertQuality: (entities) => {
      expect(
        entities.some(
          (entity) =>
            entity.label === "organization" &&
            entity.text === "PROBO-NB s.r.o.",
        ),
      ).toBe(true);
      expect(
        entities.some(
          (entity) =>
            entity.label === "person" && entity.text === "Bc. Vratislav Pavlín",
        ),
      ).toBe(true);
      expect(
        entities.some(
          (entity) =>
            entity.label === "person" && entity.text.includes("e-mail:"),
        ),
      ).toBe(false);
      expect(
        entities.some(
          (entity) =>
            entity.label === "address" && entity.text.includes("Přílohou"),
        ),
      ).toBe(false);
    },
  },
  {
    name: "czech patrik nguyen used vehicle sale",
    textPath: join(FIXTURES_DIR, "cs", "patrik-nguyen-used-vehicle-sale.txt"),
    snapshotPath: join(
      FIXTURES_DIR,
      "cs",
      "patrik-nguyen-used-vehicle-sale.snapshot.json",
    ),
    assertQuality: (entities) => {
      expect(
        entities.some(
          (entity) =>
            entity.label === "organization" &&
            entity.text ===
              "Zdravotnickými zařízeními Ministerstva spravedlnosti, státní příspěvkovou organizací",
        ),
      ).toBe(true);
      expect(
        entities.some(
          (entity) =>
            entity.label === "person" && entity.text === "Patrik Nguyen",
        ),
      ).toBe(true);
      expect(
        entities.some(
          (entity) =>
            entity.label === "address" &&
            entity.text === "Na Květnici 1657/16, 140 00 Praha 4",
        ),
      ).toBe(true);
      expect(
        entities.some(
          (entity) =>
            entity.label === "address" &&
            entity.text.startsWith("prodávajícího "),
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
      const entities = await runPipeline({
        fullText,
        config: CONFIG,
        gazetteerEntries: [],
        context: CONTEXT,
      });

      fixture.assertQuality?.(entities);

      const snapshot = toSnapshot(fullText, entities, CONTEXT);

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
