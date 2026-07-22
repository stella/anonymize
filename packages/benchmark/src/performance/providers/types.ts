import type { Distribution } from "../statistics";

export const CROSS_PROVIDER_REPORT_SCHEMA_VERSION = 1 as const;

export const CROSS_PROVIDER_IDS = [
  "stella-full",
  "stella-regex-detectors-only",
  "scrubadub-base",
  "datafog-regex-only",
] as const;

export type CrossProviderId = (typeof CROSS_PROVIDER_IDS)[number];

export type ProviderScope =
  | "full-pipeline"
  | "base-install"
  | "regex-only"
  | "regex-detectors-only";

export type ProviderSample = {
  readonly provider: CrossProviderId;
  readonly providerVersion: string;
  readonly runtimeVersion: string;
  readonly scope: ProviderScope;
  readonly inputBytes: number;
  readonly inputCharacters: number;
  readonly inputSha256: string;
  readonly outputCount: number;
  readonly outputDigest: string;
  readonly outputLabelCounts: Readonly<Record<string, number>>;
  readonly initSeconds: number;
  readonly coldSeconds: number;
  readonly warmSeconds: number;
};

export type IsolatedProviderSample = ProviderSample & {
  readonly startupSeconds: number;
};

export type ProviderResult = {
  readonly provider: CrossProviderId;
  readonly providerVersion: string;
  readonly runtimeVersion: string;
  readonly scope: ProviderScope;
  readonly inputBytes: number;
  readonly inputCharacters: number;
  readonly inputSha256: string;
  readonly outputCount: number;
  readonly outputDigest: string;
  readonly outputLabelCounts: Readonly<Record<string, number>>;
  readonly startupSeconds: Distribution;
  readonly initSeconds: Distribution;
  readonly coldSeconds: Distribution;
  readonly warmSeconds: Distribution;
  readonly warmCharactersPerSecond: Distribution;
};
