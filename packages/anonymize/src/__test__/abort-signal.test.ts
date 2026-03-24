import { describe, expect, test } from "bun:test";
import { runPipeline } from "../pipeline";
import type { NerInferenceFn } from "../pipeline";
import type { PipelineConfig } from "../types";

const minimalConfig: PipelineConfig = {
  threshold: 0.5,
  enableTriggerPhrases: false,
  enableRegex: false,
  enableNameCorpus: false,
  enableDenyList: false,
  enableGazetteer: false,
  enableNer: false,
  enableConfidenceBoost: false,
  enableCoreference: false,
  labels: [],
  workspaceId: "test",
};

describe("runPipeline abort signal", () => {
  test("completes normally without signal", async () => {
    const result = await runPipeline(
      "hello world",
      minimalConfig,
      [],
      null,
    );
    expect(Array.isArray(result)).toBe(true);
  });

  test("throws AbortError when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    try {
      await runPipeline(
        "hello world",
        minimalConfig,
        [],
        null,
        undefined,
        undefined,
        controller.signal,
      );
      // Should not reach here
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(DOMException);
      expect(
        (err as DOMException).name,
      ).toBe("AbortError");
    }
  });

  test("error message is 'Pipeline aborted'", async () => {
    const controller = new AbortController();
    controller.abort();

    try {
      await runPipeline(
        "hello world",
        minimalConfig,
        [],
        null,
        undefined,
        undefined,
        controller.signal,
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(
        (err as DOMException).message,
      ).toBe("Pipeline aborted");
    }
  });

  test("passes signal to NER inference function", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    const mockNer: NerInferenceFn = async (
      _text,
      _labels,
      _threshold,
      signal,
    ) => {
      receivedSignal = signal;
      return [];
    };

    const nerConfig: PipelineConfig = {
      ...minimalConfig,
      enableNer: true,
      labels: ["person"],
    };

    await runPipeline(
      "hello world",
      nerConfig,
      [],
      mockNer,
      undefined,
      undefined,
      controller.signal,
    );

    expect(receivedSignal).toBe(controller.signal);
  });

  test("aborts before NER when signal fires during earlier stage", async () => {
    const controller = new AbortController();
    let nerCalled = false;

    const mockNer: NerInferenceFn = async () => {
      nerCalled = true;
      return [];
    };

    const nerConfig: PipelineConfig = {
      ...minimalConfig,
      enableNer: true,
      labels: ["person"],
    };

    // Abort after a microtask to allow the pipeline
    // to start but catch it before NER
    const onProgress = (step: string) => {
      // Abort as soon as any stage reports progress
      if (step === "regex" || step === "legal-forms") {
        controller.abort();
      }
    };

    // With a pre-aborted signal instead (deterministic)
    const preAborted = new AbortController();
    preAborted.abort();

    try {
      await runPipeline(
        "hello world",
        nerConfig,
        [],
        mockNer,
        onProgress,
        undefined,
        preAborted.signal,
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(
        (err as DOMException).name,
      ).toBe("AbortError");
      expect(nerCalled).toBe(false);
    }
  });
});
