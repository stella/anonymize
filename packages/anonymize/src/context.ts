/**
 * Cached state for a single pipeline run (or a sequence of runs sharing the
 * same config). The native pipeline builds its prepared package once and reuses
 * it across calls with the same config; the package bytes and the key/promise
 * that guard concurrent builds live here so callers can share one warmed
 * context.
 */
export type PipelineContext = {
  // ── Native prepared-package cache ─────────────
  nativePipelinePackage: Uint8Array | null;
  nativePipelinePackageKey: string;
  nativePipelinePackagePromise: Promise<Uint8Array> | null;
};

/** Create a fresh, empty pipeline context. */
export const createPipelineContext = (): PipelineContext => ({
  nativePipelinePackage: null,
  nativePipelinePackageKey: "",
  nativePipelinePackagePromise: null,
});

/**
 * Module-level default context. Used when callers
 * don't provide an explicit context, preserving full
 * backward compatibility with the existing API.
 */
export const defaultContext: PipelineContext = createPipelineContext();
