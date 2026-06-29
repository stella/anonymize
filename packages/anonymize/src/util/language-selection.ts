const normalizeLanguageCode = (language: string): string =>
  language.trim().toLowerCase();

const normalizeLanguageSelection = (
  languages: readonly string[] | undefined,
): string[] =>
  languages === undefined
    ? []
    : languages
        .map(normalizeLanguageCode)
        .filter((language) => language.length > 0);

export const languageSelectionKey = (
  languages: readonly string[] | undefined,
): string => {
  const normalized = normalizeLanguageSelection(languages).toSorted();
  return normalized.length === 0 ? "*" : normalized.join(",");
};

const baseLanguage = (language: string): string => {
  const index = language.indexOf("-");
  return index === -1 ? language : language.slice(0, index);
};

export const languageConfigMatches = (
  configLanguage: string,
  selectedLanguages: readonly string[] | undefined,
): boolean => {
  if (selectedLanguages === undefined || selectedLanguages.length === 0) {
    return true;
  }
  const normalizedSelectedLanguages =
    normalizeLanguageSelection(selectedLanguages);
  if (normalizedSelectedLanguages.length === 0) {
    return true;
  }

  const normalizedConfigLanguage = normalizeLanguageCode(configLanguage);
  if (normalizedConfigLanguage.length === 0) {
    return false;
  }

  const genericConfig =
    baseLanguage(normalizedConfigLanguage) === normalizedConfigLanguage;
  for (const normalizedLanguage of normalizedSelectedLanguages) {
    if (normalizedLanguage === normalizedConfigLanguage) {
      return true;
    }
    if (
      genericConfig &&
      baseLanguage(normalizedLanguage) === normalizedConfigLanguage
    ) {
      return true;
    }
  }

  return false;
};
