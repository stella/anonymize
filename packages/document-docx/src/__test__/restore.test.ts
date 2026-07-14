import { describe, expect, test } from "bun:test";
import { strToU8, unzipSync, zipSync } from "fflate";

import {
  DocxRestorationError,
  extractDocxText,
  restoreDocxText,
  type DocxRestorationSession,
} from "../index";

const CONTENT_TYPES_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const WORD_NAMESPACE =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const RELATIONSHIP_NAMESPACE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_RELATIONSHIP_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const DOCUMENT_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

const docx = (body: string): Uint8Array =>
  zipSync({
    "[Content_Types].xml": strToU8(
      `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override PartName="/word/document.xml" ContentType="${DOCUMENT_CONTENT_TYPE}"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<Relationships xmlns="${PACKAGE_RELATIONSHIP_NAMESPACE}"><Relationship Id="rId1" Type="${RELATIONSHIP_NAMESPACE}/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    "word/document.xml": strToU8(
      `<w:document xmlns:w="${WORD_NAMESPACE}"><w:body>${body}</w:body></w:document>`,
    ),
    "word/media/image.bin": new Uint8Array([0, 1, 2, 3, 255]),
  });

type FakeSessionOptions = {
  mappings?: Readonly<Record<string, string>>;
  onRestore?: (text: string, observedAtEpochSeconds?: number) => void;
  rejectUnknownOwned?: boolean;
  sessionId?: string;
};

const fakeSession = ({
  mappings = {},
  onRestore,
  rejectUnknownOwned = true,
  sessionId = "matter_1",
}: FakeSessionOptions = {}): DocxRestorationSession => ({
  sessionId: () => sessionId,
  restoreText: (text, observedAtEpochSeconds) => {
    onRestore?.(text, observedAtEpochSeconds);
    const replacement = mappings[text];
    if (replacement !== undefined) {
      return replacement;
    }
    if (
      rejectUnknownOwned &&
      text.includes(`_${sessionId.replaceAll("_", "%5F")}_`)
    ) {
      throw new Error("unknown session placeholder");
    }
    return text;
  },
});

describe("restoreDocxText", () => {
  test("restores repeated placeholders across runs without flattening the package", () => {
    const document = docx(
      [
        "<w:p>",
        "<w:r><w:t>Contact [PERSON_</w:t></w:r>",
        "<w:r><w:rPr><w:b/></w:rPr><w:t>matter%5F1_1]</w:t></w:r>",
        "<w:r><w:t> and [PERSON_matter%5F1_1].</w:t></w:r>",
        "</w:p>",
      ].join(""),
    );
    const restoredInputs: string[] = [];
    const result = restoreDocxText({
      document,
      session: fakeSession({
        mappings: { "[PERSON_matter%5F1_1]": "Alice" },
        onRestore: (text) => restoredInputs.push(text),
      }),
      expectedSessionId: "matter_1",
    });

    expect(result).toMatchObject({
      sessionId: "matter_1",
      restoredBlockCount: 1,
      restoredPlaceholderCount: 2,
    });
    expect(extractDocxText(result.document).blocks.at(0)?.text).toBe(
      "Contact Alice and Alice.",
    );
    expect(restoredInputs).toEqual(["", "[PERSON_matter%5F1_1]", ""]);
    expect(unzipSync(result.document)["word/media/image.bin"]).toEqual(
      new Uint8Array([0, 1, 2, 3, 255]),
    );
    const xml = new TextDecoder().decode(
      unzipSync(result.document)["word/document.xml"],
    );
    expect(xml).toContain("<w:rPr><w:b/></w:rPr>");
  });

  test("requires the expected session before parsing or restoring", () => {
    let restoreCalled = false;
    expect(() =>
      restoreDocxText({
        document: new Uint8Array([0]),
        session: fakeSession({
          sessionId: "matter_2",
          onRestore: () => {
            restoreCalled = true;
          },
        }),
        expectedSessionId: "matter_1",
      }),
    ).toThrow(DocxRestorationError);
    expect(restoreCalled).toBeFalse();
  });

  test("fails closed for unknown and incomplete expected-session placeholders", () => {
    const unknown = docx(
      "<w:p><w:r><w:t>[PERSON_matter%5F1_99]</w:t></w:r></w:p>",
    );
    expect(() =>
      restoreDocxText({
        document: unknown,
        session: fakeSession({ rejectUnknownOwned: false }),
        expectedSessionId: "matter_1",
      }),
    ).toThrow("unknown placeholder for the expected session");

    const incomplete = docx(
      "<w:p><w:r><w:t>[PERSON_matter%5F1_1</w:t></w:r></w:p>",
    );
    expect(() =>
      restoreDocxText({
        document: incomplete,
        session: fakeSession(),
        expectedSessionId: "matter_1",
      }),
    ).toThrow("incomplete placeholder");

    const incompleteBeforeText = docx(
      "<w:p><w:r><w:t>[PERSON_matter%5F1_1 signed [note</w:t></w:r></w:p>",
    );
    expect(() =>
      restoreDocxText({
        document: incompleteBeforeText,
        session: fakeSession(),
        expectedSessionId: "matter_1",
      }),
    ).toThrow("incomplete placeholder");

    const malformedClosed = docx(
      "<w:p><w:r><w:t>[PERSON_matter%5F1_1 signed]</w:t></w:r></w:p>",
    );
    expect(() =>
      restoreDocxText({
        document: malformedClosed,
        session: fakeSession({ rejectUnknownOwned: false }),
        expectedSessionId: "matter_1",
      }),
    ).toThrow("unknown placeholder for the expected session");

    for (const malformedCount of [
      "[PERSON_matter%5F1_]",
      "[PERSON_matter%5F1_+1]",
    ]) {
      expect(() =>
        restoreDocxText({
          document: docx(`<w:p><w:r><w:t>${malformedCount}</w:t></w:r></w:p>`),
          session: fakeSession({ rejectUnknownOwned: false }),
          expectedSessionId: "matter_1",
        }),
      ).toThrow("unknown placeholder for the expected session");
    }
  });

  test("bounds work for repeated unmatched opening brackets", () => {
    const text = "[".repeat(100_000);
    const document = docx(`<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`);
    const result = restoreDocxText({
      document,
      session: fakeSession(),
      expectedSessionId: "matter_1",
    });

    expect(result.document).toEqual(document);
    expect(result.restoredPlaceholderCount).toBe(0);
  });

  test("leaves other namespaces unchanged and still checks session availability", () => {
    const document = docx(
      "<w:p><w:r><w:t>[PERSON_other%5Fmatter_1]</w:t></w:r></w:p>",
    );
    const observations: Array<number | undefined> = [];
    const result = restoreDocxText({
      document,
      session: fakeSession({
        onRestore: (_text, observedAt) => observations.push(observedAt),
      }),
      expectedSessionId: "matter_1",
      observedAtEpochSeconds: 150,
    });
    expect(result.document).toEqual(document);
    expect(result.restoredPlaceholderCount).toBe(0);
    expect(observations).toEqual([150, 150, 150]);
  });

  test("rechecks session availability after planning and before rewriting", () => {
    const document = docx(
      "<w:p><w:r><w:t>[PERSON_matter%5F1_1]</w:t></w:r></w:p>",
    );
    let availabilityChecks = 0;
    const session: DocxRestorationSession = {
      sessionId: () => "matter_1",
      restoreText: (text) => {
        if (text === "[PERSON_matter%5F1_1]") {
          return "Alice";
        }
        availabilityChecks += 1;
        if (availabilityChecks === 2) {
          throw new Error("session was deleted");
        }
        return text;
      },
    };

    expect(() =>
      restoreDocxText({
        document,
        session,
        expectedSessionId: "matter_1",
      }),
    ).toThrow("session was deleted");
  });

  test("inherits revision and package-signature rewrite protections", () => {
    const revision = docx(
      '<w:p><w:ins w:id="1"><w:r><w:t>[PERSON_matter%5F1_1]</w:t></w:r></w:ins></w:p>',
    );
    const session = fakeSession({
      mappings: { "[PERSON_matter%5F1_1]": "Alice" },
    });
    expect(() =>
      restoreDocxText({
        document: revision,
        session,
        expectedSessionId: "matter_1",
      }),
    ).toThrow("contiguous non-revision text segments");

    const entries = unzipSync(
      docx("<w:p><w:r><w:t>[PERSON_matter%5F1_1]</w:t></w:r></w:p>"),
    );
    const signed = zipSync({
      ...entries,
      "_XmlSignatures/sig1.xml": strToU8("<Signature/>"),
    });
    expect(() =>
      restoreDocxText({
        document: signed,
        session,
        expectedSessionId: "matter_1",
      }),
    ).toThrow("must be re-signed");
  });
});
