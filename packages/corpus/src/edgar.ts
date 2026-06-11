const EFTS_SEARCH_URL = "https://efts.sec.gov/LATEST/search-index";
const EDGAR_ARCHIVES_URL = "https://www.sec.gov/Archives/edgar/data";

/** Exhibit type prefix for material contracts. */
const MATERIAL_CONTRACT_PREFIX = "EX-10";

/** SEC asks for polite spacing between requests. */
const REQUEST_SPACING_MS = 220;
const RETRYABLE_STATUS = new Set([429, 503]);
const MAX_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 1_000;
const PAGE_SIZE = 100;

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
  fileType?.startsWith(MATERIAL_CONTRACT_PREFIX) ?? false;

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
      const response = await fetch(url, {
        headers: { "User-Agent": userAgent },
      });
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
      for (let page = 0; page < pages; page += 1) {
        const params = new URLSearchParams({
          q: `"${query}"`,
          forms,
          from: String(page * PAGE_SIZE),
        });
        const response = await politeFetch(
          `${EFTS_SEARCH_URL}?${params.toString()}`,
        );
        // SAFETY: EFTS response shape is owned by the SEC API;
        // optional chaining below tolerates missing fields.
        const body = (await response.json()) as EftsResponse;
        const hits = body.hits?.hits ?? [];
        for (const hit of hits) {
          if (!isMaterialContract(hit._source.file_type)) {
            continue;
          }
          const ref = parseHit(hit);
          if (ref) {
            refs.push(ref);
          }
        }
        if (hits.length < PAGE_SIZE) {
          break;
        }
      }
      return refs;
    },
    fetchDocument: async (ref) => {
      const response = await politeFetch(ref.url);
      return response.text();
    },
  };
};
