import { ENTITY_CAPABILITIES } from "./constants";

export const CAPABILITY_MANIFEST_SCHEMA_VERSION = 2 as const;

export const CAPABILITY_RUNTIMES = ["node", "python", "wasm"] as const;

export type CapabilityRuntime = (typeof CAPABILITY_RUNTIMES)[number];

export const CAPABILITY_PARITY_PROFILES = {
  core: CAPABILITY_RUNTIMES,
  local: ["node", "python"],
  document: ["node", "python"],
} as const satisfies Record<string, readonly CapabilityRuntime[]>;

export type CapabilityParityProfile = keyof typeof CAPABILITY_PARITY_PROFILES;

export const CAPABILITY_SURFACES = [
  { id: "package.prepare", profile: "core" },
  { id: "package.load", profile: "core" },
  { id: "package.load-file", profile: "local" },
  { id: "text.normalize", profile: "core" },
  { id: "text.redact", profile: "core" },
  { id: "text.redact-stream", profile: "core" },
  { id: "text.diagnostics", profile: "core" },
  { id: "text.summary-diagnostics", profile: "core" },
  { id: "text.caller-detections", profile: "core" },
  { id: "text.external-detection-batch", profile: "core" },
  { id: "text.operators", profile: "core" },
  { id: "package.default", profile: "core" },
  { id: "session.cross-document", profile: "core" },
  { id: "session.lifecycle", profile: "core" },
  { id: "session.plaintext-transfer", profile: "core" },
  { id: "session.encrypted-archive", profile: "core" },
  { id: "document.docx.extract", profile: "document" },
  { id: "document.docx.rewrite", profile: "document" },
  { id: "document.docx.anonymize", profile: "document" },
  { id: "document.docx.restore", profile: "document" },
  { id: "document.pdf.inspect", profile: "core" },
  { id: "document.pdf.anonymize-raster", profile: "document" },
  { id: "document.pdf.rewrite-raster", profile: "document" },
] as const satisfies readonly {
  id: string;
  profile: CapabilityParityProfile;
}[];

export type CapabilitySurface = (typeof CAPABILITY_SURFACES)[number];
export type CapabilitySurfaceId = CapabilitySurface["id"];

export type CapabilityManifest = {
  schemaVersion: typeof CAPABILITY_MANIFEST_SCHEMA_VERSION;
  runtimes: readonly CapabilityRuntime[];
  parityProfiles: typeof CAPABILITY_PARITY_PROFILES;
  surfaces: typeof CAPABILITY_SURFACES;
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
  parityProfiles: CAPABILITY_PARITY_PROFILES,
  surfaces: CAPABILITY_SURFACES,
  entities: ENTITY_CAPABILITIES,
} as const satisfies CapabilityManifest;
