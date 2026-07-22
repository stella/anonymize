import { cpus, loadavg, platform, totalmem } from "node:os";
import { readFileSync } from "node:fs";

export const CANONICAL_HOST_LABEL = "anonymize-perf-v1";
export const DEFAULT_HOST_PROFILE_PATH =
  "/etc/stella-anonymize/perf-host-v1.json";

export type HostProfile = {
  readonly schemaVersion: 1;
  readonly label: typeof CANONICAL_HOST_LABEL;
  readonly platform: "linux";
  readonly architecture: string;
  readonly cpuModel: string;
  readonly logicalCores: number;
  readonly totalMemoryBytes: number;
  readonly maximumLoadPerCore: number;
  readonly governor: "performance";
  readonly turbo: "disabled";
};

export type HostSnapshot = {
  readonly eventName: string | undefined;
  readonly repository: string | undefined;
  readonly ref: string | undefined;
  readonly platform: string;
  readonly architecture: string;
  readonly cpuModel: string;
  readonly logicalCores: number;
  readonly totalMemoryBytes: number;
  readonly loadOneMinute: number;
  readonly governors: readonly string[];
  readonly turboDisabled: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const assertHostProfile: (value: unknown) => asserts value is HostProfile = (
  value,
) => {
  if (!isRecord(value)) {
    throw new Error("canonical host profile must be an object");
  }
  const record = value;
  const keys = [
    "schemaVersion",
    "label",
    "platform",
    "architecture",
    "cpuModel",
    "logicalCores",
    "totalMemoryBytes",
    "maximumLoadPerCore",
    "governor",
    "turbo",
  ];
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !(key in record))
  ) {
    throw new Error(
      "canonical host profile fields do not match schema version 1",
    );
  }
  if (
    record["schemaVersion"] !== 1 ||
    record["label"] !== CANONICAL_HOST_LABEL ||
    record["platform"] !== "linux" ||
    typeof record["architecture"] !== "string" ||
    record["architecture"] === "" ||
    typeof record["cpuModel"] !== "string" ||
    record["cpuModel"] === "" ||
    !Number.isSafeInteger(record["logicalCores"]) ||
    (typeof record["logicalCores"] === "number" &&
      record["logicalCores"] <= 0) ||
    !Number.isSafeInteger(record["totalMemoryBytes"]) ||
    (typeof record["totalMemoryBytes"] === "number" &&
      record["totalMemoryBytes"] <= 0) ||
    typeof record["maximumLoadPerCore"] !== "number" ||
    !Number.isFinite(record["maximumLoadPerCore"]) ||
    record["maximumLoadPerCore"] <= 0 ||
    record["governor"] !== "performance" ||
    record["turbo"] !== "disabled"
  ) {
    throw new Error("canonical host profile values are invalid");
  }
};

const readGovernors = (): string[] => {
  const values = new Set<string>();
  for (let index = 0; index < cpus().length; index += 1) {
    try {
      values.add(
        readFileSync(
          `/sys/devices/system/cpu/cpu${index}/cpufreq/scaling_governor`,
          "utf8",
        ).trim(),
      );
    } catch {
      throw new Error(`CPU ${index} scaling governor is unavailable`);
    }
  }
  return [...values].sort();
};

const readTurboDisabled = (): boolean => {
  try {
    return (
      readFileSync(
        "/sys/devices/system/cpu/intel_pstate/no_turbo",
        "utf8",
      ).trim() === "1"
    );
  } catch {
    try {
      return (
        readFileSync("/sys/devices/system/cpu/cpufreq/boost", "utf8").trim() ===
        "0"
      );
    } catch {
      throw new Error("CPU turbo/boost state is unavailable");
    }
  }
};

export const currentHostSnapshot = (): HostSnapshot => {
  const processors = cpus();
  const firstProcessor = processors.at(0);
  if (firstProcessor === undefined)
    throw new Error("CPU metadata is unavailable");
  return {
    eventName: process.env["GITHUB_EVENT_NAME"],
    repository: process.env["GITHUB_REPOSITORY"],
    ref: process.env["GITHUB_REF"],
    platform: platform(),
    architecture: process.arch,
    cpuModel: firstProcessor.model,
    logicalCores: processors.length,
    totalMemoryBytes: totalmem(),
    loadOneMinute: loadavg().at(0) ?? Number.POSITIVE_INFINITY,
    governors: readGovernors(),
    turboDisabled: readTurboDisabled(),
  };
};

export const assertCanonicalHost = (
  profile: HostProfile,
  snapshot: HostSnapshot,
): void => {
  if (profile.schemaVersion !== 1 || profile.label !== CANONICAL_HOST_LABEL) {
    throw new Error(`host profile must declare ${CANONICAL_HOST_LABEL}`);
  }
  const trustedEvent =
    (snapshot.eventName === "workflow_dispatch" ||
      snapshot.eventName === "push") &&
    snapshot.ref === "refs/heads/main";
  if (!trustedEvent || snapshot.repository !== "stella/anonymize") {
    throw new Error(
      "canonical performance runs require a trusted repository event",
    );
  }
  if (
    snapshot.platform !== profile.platform ||
    snapshot.architecture !== profile.architecture ||
    snapshot.cpuModel !== profile.cpuModel ||
    snapshot.logicalCores !== profile.logicalCores
  ) {
    throw new Error("current CPU does not match the canonical host profile");
  }
  const memoryDrift = Math.abs(
    snapshot.totalMemoryBytes - profile.totalMemoryBytes,
  );
  if (memoryDrift > profile.totalMemoryBytes * 0.01) {
    throw new Error("current memory does not match the canonical host profile");
  }
  if (
    snapshot.loadOneMinute / snapshot.logicalCores >
    profile.maximumLoadPerCore
  ) {
    throw new Error("canonical host load exceeds its declared ceiling");
  }
  if (
    snapshot.governors.length !== 1 ||
    snapshot.governors.at(0) !== profile.governor
  ) {
    throw new Error("canonical CPU governor must be performance");
  }
  if (!snapshot.turboDisabled || profile.turbo !== "disabled") {
    throw new Error("canonical CPU turbo/boost must be disabled");
  }
};

export const verifyCanonicalHost = (
  profilePath = process.env["ANONYMIZE_PERF_HOST_PROFILE"] ??
    DEFAULT_HOST_PROFILE_PATH,
): void => {
  let profile: HostProfile;
  try {
    const parsed: unknown = JSON.parse(readFileSync(profilePath, "utf8"));
    assertHostProfile(parsed);
    profile = parsed;
  } catch (error) {
    throw new Error(`canonical host profile is unavailable at ${profilePath}`, {
      cause: error,
    });
  }
  assertCanonicalHost(profile, currentHostSnapshot());
};
