import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import { createRedactPiiAdapter } from "../adapters/redact-pii";
import { loadGroundTruth } from "../ground-truth";

const EXPECTED_PREDICTION_DIGEST =
  "a388052c8c01ba88638be2fb00a1a59cdd11c150a796b4548596eb72aa59d248";

type StablePrediction = readonly [
  string,
  readonly {
    readonly start: number;
    readonly end: number;
    readonly label: string;
    readonly text: string;
  }[],
];

describe("redact-pii benchmark adapter", () => {
  test("preserves the pinned 3.4.0 predictions", async () => {
    const adapter = createRedactPiiAdapter();
    const outcome = await adapter.run(await loadGroundTruth());

    expect(adapter.version).toBe("3.4.0");
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") {
      return;
    }

    const predictions: StablePrediction[] = [...outcome.predictions].map(
      ([id, spans]) => [
        id,
        spans.map(({ start, end, label, text }) => ({
          start,
          end,
          label,
          text,
        })),
      ],
    );
    const spanCount = predictions.reduce(
      (sum, [, spans]) => sum + spans.length,
      0,
    );
    const digest = createHash("sha256")
      .update(JSON.stringify(predictions))
      .digest("hex");

    expect(predictions).toHaveLength(28);
    expect(spanCount).toBe(139);
    expect(digest).toBe(EXPECTED_PREDICTION_DIGEST);
  });
});
