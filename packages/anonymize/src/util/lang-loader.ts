/**
 * Language manifest loader and config auto-discovery.
 *
 * Reads `manifest.json` from @stll/anonymize-data to
 * determine which languages have which config types,
 * then loads them via a static registry of import()
 * calls (string literals for bundler compatibility).
 */

// ── Types ────────────────────────────────────────────

type ManifestLanguage = {
  triggers?: boolean;
  coreference?: boolean;
};

type Manifest = {
  languages: Record<string, ManifestLanguage>;
};

type ConfigType = "triggers" | "coreference";

// ── Manifest loader (cached) ─────────────────────────

let _manifest: Manifest | null = null;
let _manifestPromise: Promise<Manifest> | null = null;

const loadManifest = (): Promise<Manifest> => {
  if (_manifest) {
    return Promise.resolve(_manifest);
  }
  if (_manifestPromise) {
    return _manifestPromise;
  }
  _manifestPromise = (async () => {
    try {
      const mod = await import(
        "@stll/anonymize-data/config/manifest.json"
      );
      // eslint-disable-next-line no-unsafe-type-assertion -- JSON manifest
      const parsed = (mod.default ?? mod) as Manifest;
      if (
        !parsed ||
        typeof parsed.languages !== "object" ||
        parsed.languages === null ||
        Array.isArray(parsed.languages)
      ) {
        console.warn(
          "[anonymize] lang-loader: manifest has " +
            "unexpected structure, falling back " +
            "to hardcoded list",
        );
        _manifest = { languages: {} };
        return _manifest;
      }
      _manifest = parsed;
      return _manifest;
    } catch (err) {
      // Manifest not available (old data package version
      // or unexpected import error). Cache the empty
      // result so we don't retry the failed import.
      console.warn(
        "[anonymize] lang-loader: manifest not " +
          "available, falling back to hardcoded " +
          "language list:",
        err,
      );
      _manifest = { languages: {} };
      return _manifest;
    }
  })();
  return _manifestPromise;
};

// ── Static import registries ─────────────────────────
// String literals so bundlers can statically analyze
// the import paths. Each registry maps language code
// to a lazy loader thunk.

const TRIGGER_LOADERS: Record<
  string,
  () => Promise<unknown>
> = {
  cs: () =>
    import(
      "@stll/anonymize-data/config/triggers.cs.json"
    ),
  de: () =>
    import(
      "@stll/anonymize-data/config/triggers.de.json"
    ),
  en: () =>
    import(
      "@stll/anonymize-data/config/triggers.en.json"
    ),
  es: () =>
    import(
      "@stll/anonymize-data/config/triggers.es.json"
    ),
  fr: () =>
    import(
      "@stll/anonymize-data/config/triggers.fr.json"
    ),
  hu: () =>
    import(
      "@stll/anonymize-data/config/triggers.hu.json"
    ),
  it: () =>
    import(
      "@stll/anonymize-data/config/triggers.it.json"
    ),
  pl: () =>
    import(
      "@stll/anonymize-data/config/triggers.pl.json"
    ),
  ro: () =>
    import(
      "@stll/anonymize-data/config/triggers.ro.json"
    ),
  sv: () =>
    import(
      "@stll/anonymize-data/config/triggers.sv.json"
    ),
};

const COREFERENCE_LOADERS: Record<
  string,
  () => Promise<unknown>
> = {
  cs: () =>
    import(
      "@stll/anonymize-data/config/coreference.cs.json"
    ),
  de: () =>
    import(
      "@stll/anonymize-data/config/coreference.de.json"
    ),
  en: () =>
    import(
      "@stll/anonymize-data/config/coreference.en.json"
    ),
  sk: () =>
    import(
      "@stll/anonymize-data/config/coreference.sk.json"
    ),
};

const LOADER_REGISTRIES: Record<
  ConfigType,
  Record<string, () => Promise<unknown>>
> = {
  triggers: TRIGGER_LOADERS,
  coreference: COREFERENCE_LOADERS,
};

// ── Fallback language lists ──────────────────────────
// Used when the manifest is unavailable (old data
// package). Matches the hardcoded lists that existed
// before the manifest was introduced.

const FALLBACK_LANGUAGES: Record<
  ConfigType,
  readonly string[]
> = {
  triggers: [
    "cs", "de", "en", "es", "fr",
    "hu", "it", "pl", "ro", "sv",
  ],
  coreference: ["cs", "de", "en", "sk"],
};

// ── Public API ───────────────────────────────────────

/**
 * Load all config files of a given type for all
 * languages enabled in the manifest.
 *
 * Falls back to the hardcoded language list when the
 * manifest is unavailable (backward compatibility).
 */
export const loadLanguageConfigs = async <
  T extends NonNullable<unknown>,
>(
  configType: ConfigType,
  mapFn: (mod: unknown) => T,
): Promise<T[]> => {
  const manifest = await loadManifest();
  const registry = LOADER_REGISTRIES[configType];

  // Determine which language codes to load
  const hasManifestLanguages =
    Object.keys(manifest.languages).length > 0;

  const codes = hasManifestLanguages
    ? Object.entries(manifest.languages)
        .filter(([code, lang]) => {
          if (!lang || typeof lang !== "object") {
            console.warn(
              `[anonymize] lang-loader: manifest ` +
                `entry for "${code}" is not an ` +
                `object, skipping`,
            );
            return false;
          }
          return lang[configType] === true;
        })
        .map(([code]) => code)
    : [...FALLBACK_LANGUAGES[configType]];

  // Use indexed assignment so results preserve
  // manifest declaration order regardless of import
  // resolution timing.
  const results: (T | undefined)[] = new Array(
    codes.length,
  );

  const loads = codes.map(async (code, i) => {
    const loader = registry[code];
    if (!loader) {
      console.warn(
        `[anonymize] lang-loader: language "${code}" ` +
          `is enabled in the manifest for ` +
          `"${configType}" but has no loader in ` +
          `the static registry`,
      );
      return;
    }
    let mod: unknown;
    try {
      mod = await loader();
    } catch {
      // Config file missing or data package not installed
      return;
    }
    let result: T;
    try {
      result = mapFn(mod);
    } catch (err) {
      console.warn(
        `[anonymize] lang-loader: mapFn failed ` +
          `for "${code}" (${configType}):`,
        err,
      );
      return;
    }
    results[i] = result;
  });

  await Promise.all(loads);
  return results.filter(
    (r): r is T => r !== undefined,
  );
};

/**
 * Reset cached manifest. Exposed for testing only.
 */
export const _resetManifestCache = (): void => {
  _manifest = null;
  _manifestPromise = null;
};
