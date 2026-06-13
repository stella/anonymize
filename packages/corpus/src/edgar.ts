const EFTS_SEARCH_URL = "https://efts.sec.gov/LATEST/search-index";
const EDGAR_ARCHIVES_URL = "https://www.sec.gov/Archives/edgar/data";

/**
 * Material-contract exhibit types: exactly `EX-10`, or `EX-10`
 * followed by a non-digit (e.g. `EX-10.1`). Excludes `EX-101`
 * (XBRL interactive data), which shares the `EX-10` prefix.
 */
const MATERIAL_CONTRACT_RE = /^EX-10(?:\D|$)/;
const TEXT_DOCUMENT_RE = /\.(?:html?|txt)$/i;

/** SEC asks for polite spacing between requests. */
const REQUEST_SPACING_MS = 220;
const RETRYABLE_STATUS = new Set([429, 503]);
const MAX_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 1_000;
const REQUEST_TIMEOUT_MS = 30_000;

export type EftsHit = {
  _id: string;
  _source: {
    ciks: string[];
    file_type?: string;
  };
};

type EftsResponse = {
  hits?: {
    hits?: EftsHit[];
  };
};

export type EdgarDocumentRef = {
  /** `accession:filename`, the EFTS hit id. */
  id: string;
  accession: string;
  filename: string;
  cik: string;
  url: string;
};

export const isMaterialContract = (fileType: string | undefined): boolean =>
  fileType !== undefined && MATERIAL_CONTRACT_RE.test(fileType);

export const isSupportedDocumentFile = (filename: string): boolean =>
  TEXT_DOCUMENT_RE.test(filename);

export const buildDocumentUrl = ({
  cik,
  accession,
  filename,
}: {
  cik: string;
  accession: string;
  filename: string;
}): string => {
  const cikNumber = Number.parseInt(cik, 10);
  const accessionFlat = accession.replaceAll("-", "");
  return `${EDGAR_ARCHIVES_URL}/${cikNumber}/${accessionFlat}/${filename}`;
};

export const parseHit = (hit: EftsHit): EdgarDocumentRef | null => {
  const [accession, filename] = hit._id.split(":");
  if (!accession || !filename) {
    return null;
  }
  const cik = hit._source.ciks.at(0);
  if (!cik) {
    return null;
  }
  return {
    id: hit._id,
    accession,
    filename,
    cik,
    url: buildDocumentUrl({ cik, accession, filename }),
  };
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export type EdgarClient = {
  searchMaterialContracts: (options: {
    query: string;
    forms: string;
    pages: number;
  }) => Promise<EdgarDocumentRef[]>;
  fetchDocument: (ref: EdgarDocumentRef) => Promise<string>;
  /** Fetch a raw document body by URL (used by manifest refill). */
  fetchUrl: (url: string) => Promise<string>;
};

/**
 * EDGAR full-text search (EFTS) client with polite
 * request spacing and retry on throttling.
 *
 * The `forms` filter applies to the ROOT form (e.g.
 * 8-K), not the exhibit type, so hits are filtered
 * client-side to EX-10 material contracts.
 */
export const createEdgarClient = ({
  userAgent,
}: {
  userAgent: string;
}): EdgarClient => {
  let lastRequestAt = 0;

  const politeFetch = async (url: string): Promise<Response> => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const wait = lastRequestAt + REQUEST_SPACING_MS - Date.now();
      if (wait > 0) {
        await sleep(wait);
      }
      lastRequestAt = Date.now();

      let response: Response;
      try {
        response = await fetch(url, {
          headers: { "User-Agent": userAgent },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (cause) {
        // Network errors and timeouts (AbortSignal.timeout) throw;
        // retry them with the same backoff as 429/503 responses.
        if (attempt === MAX_ATTEMPTS) {
          throw new Error(`GET ${url} failed: request error`, { cause });
        }
        await sleep(RETRY_BASE_DELAY_MS * attempt);
        continue;
      }

      if (response.ok) {
        return response;
      }
      const retryable = RETRYABLE_STATUS.has(response.status);
      if (!retryable || attempt === MAX_ATTEMPTS) {
        throw new Error(`GET ${url} failed: HTTP ${response.status}`);
      }
      await sleep(RETRY_BASE_DELAY_MS * attempt);
    }
    throw new Error(`GET ${url} failed after ${MAX_ATTEMPTS} attempts`);
  };

  return {
    searchMaterialContracts: async ({ query, forms, pages }) => {
      const refs: EdgarDocumentRef[] = [];
      // EFTS paginates by `from` and returns a fixed page regardless of any
      // size hint, so advance the offset by the hits actually returned rather
      // than a presumed page size (otherwise a 100-stride over 10-hit pages
      // skips results), and stop once a page comes back empty. `pages` caps
      // how many requests we make.
      let from = 0;
      for (let page = 0; page < pages; page += 1) {
        const params = new URLSearchParams({
          q: `"${query}"`,
          forms,
          from: String(from),
        });
        const response = await politeFetch(
          `${EFTS_SEARCH_URL}?${params.toString()}`,
        );
        // SAFETY: EFTS response shape is owned by the SEC API;
        // optional chaining below tolerates missing fields.
        const body = (await response.json()) as EftsResponse;
        const hits = body.hits?.hits ?? [];
        if (hits.length === 0) {
          break;
        }
        for (const hit of hits) {
          if (!isMaterialContract(hit._source.file_type)) {
            continue;
          }
          const ref = parseHit(hit);
          if (ref) {
            refs.push(ref);
          }
        }
        from += hits.length;
      }
      return refs;
    },
    fetchDocument: async (ref) => {
      const response = await politeFetch(ref.url);
      return response.text();
    },
    fetchUrl: async (url) => {
      const response = await politeFetch(url);
      return response.text();
    },
  };
};
