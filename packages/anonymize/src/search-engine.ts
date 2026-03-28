/**
 * Late-bound TextSearch constructor.
 *
 * Native entry injects @stll/text-search,
 * WASM entry injects @stll/text-search-wasm.
 * Both expose the same API.
 */

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type TextSearchCtor = new (...args: any[]) => any;

let _TextSearch: TextSearchCtor | undefined;

export const initTextSearch = (ctor: TextSearchCtor): void => {
  _TextSearch = ctor;
};

export const getTextSearch = (): TextSearchCtor => {
  if (!_TextSearch) {
    throw new Error(
      "TextSearch not initialized. Import from " +
        "@stll/anonymize or @stll/anonymize-wasm, " +
        "not from internal modules.",
    );
  }
  return _TextSearch;
};
