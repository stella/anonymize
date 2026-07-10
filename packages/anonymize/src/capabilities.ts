import { ENTITY_CAPABILITIES } from "./constants";

export const CAPABILITY_MANIFEST_SCHEMA_VERSION = 1 as const;

export const CAPABILITY_RUNTIMES = ["node", "python", "wasm"] as const;

export type CapabilityRuntime = (typeof CAPABILITY_RUNTIMES)[number];

export type CapabilityManifest = {
  schemaVersion: typeof CAPABILITY_MANIFEST_SCHEMA_VERSION;
  runtimes: readonly CapabilityRuntime[];
  entities: typeof ENTITY_CAPABILITIES;
};

/**
 * Versioned, runtime-free discovery contract for the deterministic pipeline.
 * The manifest contains no accuracy claims; it describes available labels,
 * activation, provenance sources, and runtime parity only.
 */
export const CAPABILITY_MANIFEST = {
  schemaVersion: CAPABILITY_MANIFEST_SCHEMA_VERSION,
  runtimes: CAPABILITY_RUNTIMES,
  entities: ENTITY_CAPABILITIES,
} as const satisfies CapabilityManifest;
