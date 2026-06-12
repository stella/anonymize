import { describe, expect, test } from "bun:test";

import {
  buildDocumentUrl,
  isMaterialContract,
  isSupportedDocumentFile,
  parseHit,
} from "../edgar";

describe("isMaterialContract", () => {
  test("accepts EX-10 variants", () => {
    expect(isMaterialContract("EX-10")).toBe(true);
    expect(isMaterialContract("EX-10.1")).toBe(true);
    expect(isMaterialContract("EX-10.12")).toBe(true);
  });

  test("rejects other exhibits and missing types", () => {
    expect(isMaterialContract("EX-99.1")).toBe(false);
    expect(isMaterialContract(undefined)).toBe(false);
  });

  test("rejects EX-101 XBRL interactive data despite the EX-10 prefix", () => {
    expect(isMaterialContract("EX-101")).toBe(false);
    expect(isMaterialContract("EX-101.INS")).toBe(false);
    expect(isMaterialContract("EX-104")).toBe(false);
  });
});

describe("buildDocumentUrl", () => {
  test("strips CIK leading zeros and accession dashes", () => {
    expect(
      buildDocumentUrl({
        cik: "0000320193",
        accession: "0000320193-24-000001",
        filename: "ex10-1.htm",
      }),
    ).toBe(
      "https://www.sec.gov/Archives/edgar/data/320193/000032019324000001/ex10-1.htm",
    );
  });
});

describe("isSupportedDocumentFile", () => {
  test("accepts text and HTML exhibits", () => {
    expect(isSupportedDocumentFile("agreement.htm")).toBe(true);
    expect(isSupportedDocumentFile("agreement.HTML")).toBe(true);
    expect(isSupportedDocumentFile("agreement.txt")).toBe(true);
  });

  test("rejects binary attachments", () => {
    expect(isSupportedDocumentFile("agreement.pdf")).toBe(false);
    expect(isSupportedDocumentFile("agreement.docx")).toBe(false);
  });
});

describe("parseHit", () => {
  test("parses a hit into a document ref", () => {
    const ref = parseHit({
      _id: "0000320193-24-000001:ex10-1.htm",
      _source: { ciks: ["0000320193"], file_type: "EX-10.1" },
    });
    expect(ref).toEqual({
      id: "0000320193-24-000001:ex10-1.htm",
      accession: "0000320193-24-000001",
      filename: "ex10-1.htm",
      cik: "0000320193",
      url: "https://www.sec.gov/Archives/edgar/data/320193/000032019324000001/ex10-1.htm",
    });
  });

  test("returns null for malformed ids or missing CIK", () => {
    expect(
      parseHit({ _id: "no-filename", _source: { ciks: ["1"] } }),
    ).toBeNull();
    expect(parseHit({ _id: "a:b.htm", _source: { ciks: [] } })).toBeNull();
  });
});
