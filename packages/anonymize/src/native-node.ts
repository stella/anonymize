import { createRequire } from "node:module";
import process from "node:process";

import {
  assertNativeBindingVersion,
  type NativeAnonymizeBinding,
} from "./native";

export * from "./native";

export type NativeRequire = (specifier: string) => unknown;

export type NativeLibc = "gnu" | "musl";

export type NativePlatformPackageOptions = {
  platform: string;
  arch: string;
  libc?: NativeLibc;
};

export type LoadNativeBindingOptions = {
  expectedVersion?: string;
  platform?: string;
  arch?: string;
  libc?: NativeLibc;
  env?: Record<string, string | undefined>;
  requireModule?: NativeRequire;
};

const LOCAL_NATIVE_LOADER = "../index.cjs";
const PACKAGE_SPECIFIC_NATIVE_PATH = "STELLA_ANONYMIZE_NATIVE_LIBRARY_PATH";

export const nativePlatformPackageName = ({
  platform,
  arch,
  libc = "gnu",
}: NativePlatformPackageOptions): string | null => {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) {
    return `@stll/anonymize-darwin-${arch}`;
  }
  if (platform === "linux" && (arch === "arm64" || arch === "x64")) {
    return libc === "gnu" ? `@stll/anonymize-linux-${arch}-gnu` : null;
  }
  if (platform === "win32" && arch === "x64") {
    return "@stll/anonymize-win32-x64-msvc";
  }
  return null;
};

export const loadNativeAnonymizeBinding = (
  options: LoadNativeBindingOptions = {},
): NativeAnonymizeBinding => {
  const requireModule = options.requireModule ?? createRequire(import.meta.url);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const specifiers = nativeBindingSpecifiers({
    platform,
    arch,
    env,
    ...(options.libc !== undefined ? { libc: options.libc } : {}),
  });
  const errors: string[] = [];

  for (const specifier of specifiers) {
    const binding = tryLoadNativeBinding({
      specifier,
      requireModule,
      errors,
    });
    if (!binding) {
      continue;
    }
    if (options.expectedVersion !== undefined) {
      assertNativeBindingVersion({
        binding,
        expectedVersion: options.expectedVersion,
      });
    }
    return binding;
  }

  const packageName = nativePlatformPackageName({
    platform,
    arch,
    ...(options.libc !== undefined ? { libc: options.libc } : {}),
  });
  const platformMessage =
    packageName === null
      ? `Unsupported native anonymize platform ${platform}/${arch}`
      : `Unable to load native anonymize binding for ${platform}/${arch}`;
  throw new Error(`${platformMessage}:\n${errors.join("\n")}`);
};

type NativeBindingSpecifiersOptions = {
  platform: string;
  arch: string;
  libc?: NativeLibc;
  env: Record<string, string | undefined>;
};

const nativeBindingSpecifiers = ({
  platform,
  arch,
  libc,
  env,
}: NativeBindingSpecifiersOptions): string[] => {
  const specifiers: string[] = [];
  const overridePath = env[PACKAGE_SPECIFIC_NATIVE_PATH];
  if (overridePath) {
    specifiers.push(overridePath);
  }
  specifiers.push(LOCAL_NATIVE_LOADER);

  const packageName = nativePlatformPackageName({
    platform,
    arch,
    ...(libc !== undefined ? { libc } : {}),
  });
  if (packageName) {
    specifiers.push(packageName);
  }
  return specifiers;
};

type TryLoadNativeBindingOptions = {
  specifier: string;
  requireModule: NativeRequire;
  errors: string[];
};

const tryLoadNativeBinding = ({
  specifier,
  requireModule,
  errors,
}: TryLoadNativeBindingOptions): NativeAnonymizeBinding | null => {
  try {
    const loaded = requireModule(specifier);
    const binding = toNativeAnonymizeBinding(loaded);
    if (binding) {
      return binding;
    }
    errors.push(`${specifier}: module does not match native binding shape`);
  } catch (error) {
    errors.push(`${specifier}: ${formatLoadError(error)}`);
  }
  return null;
};

const toNativeAnonymizeBinding = (
  value: unknown,
): NativeAnonymizeBinding | null => {
  const candidate =
    isPropertyBag(value) && isPropertyBag(value["default"])
      ? value["default"]
      : value;
  return isNativeAnonymizeBinding(candidate) ? candidate : null;
};

const isNativeAnonymizeBinding = (
  candidate: unknown,
): candidate is NativeAnonymizeBinding => {
  if (!isPropertyBag(candidate)) {
    return false;
  }
  if (typeof candidate["nativePackageVersion"] !== "function") {
    return false;
  }
  if (typeof candidate["prepareStaticSearchPackageBytes"] !== "function") {
    return false;
  }
  if (
    typeof candidate["prepareStaticSearchCompressedPackageBytes"] !== "function"
  ) {
    return false;
  }
  const preparedSearch = candidate["NativePreparedSearch"];
  if (!isPropertyBag(preparedSearch)) {
    return false;
  }
  if (typeof preparedSearch["fromConfigJsonBytes"] !== "function") {
    return false;
  }
  if (typeof preparedSearch["fromPreparedPackageBytes"] !== "function") {
    return false;
  }
  return true;
};

const isPropertyBag = (value: unknown): value is Record<string, unknown> =>
  (typeof value === "object" && value !== null) || typeof value === "function";

const formatLoadError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};
