import { describe, expect, test } from "bun:test";

import { htmlToText, looksLikeHtml } from "../html-text";

describe("htmlToText", () => {
  test("strips tags and keeps block boundaries as newlines", () => {
    const html =
      "<html><body><p>EMPLOYMENT AGREEMENT</p><p>between <b>Acme Corp</b> and John Doe</p></body></html>";
    expect(htmlToText(html)).toBe(
      "EMPLOYMENT AGREEMENT\nbetween Acme Corp and John Doe",
    );
  });

  test("keeps attributed br elements as line breaks", () => {
    expect(htmlToText('John Doe<br class="page-break">123 Main St')).toBe(
      "John Doe\n123 Main St",
    );
  });

  test("removes script and style blocks entirely", () => {
    const html =
      "<style>p { color: red; }</style><p>kept</p><script>var hidden = 1;</script>";
    expect(htmlToText(html)).toBe("kept");
  });

  test("decodes named, decimal, and hex entities", () => {
    expect(
      htmlToText("Smith&nbsp;&amp;&nbsp;Jones&#39;s &#x201C;deal&#x201D;"),
    ).toBe("Smith & Jones's “deal”");
  });

  test("leaves unknown entities untouched", () => {
    expect(htmlToText("a &bogus; b")).toBe("a &bogus; b");
  });

  test("leaves malformed and out-of-range numeric entities untouched", () => {
    // &#abc; parses to NaN; &#x110000; is past the max code point.
    expect(htmlToText("a &#abc; b")).toBe("a &#abc; b");
    expect(htmlToText("a &#x110000; b")).toBe("a &#x110000; b");
    expect(htmlToText("a &#xabc; b")).toBe("a ઼ b");
    // A decimal body with trailing letters must not decode its numeric
    // prefix (`&#123abc;` is not `&#123;` followed by "abc;").
    expect(htmlToText("a &#123abc; b")).toBe("a &#123abc; b");
  });

  test("collapses whitespace runs but preserves paragraph breaks", () => {
    const html = "<p>one</p>\n\n\n<p>two   three</p>";
    expect(htmlToText(html)).toBe("one\n\ntwo three");
  });
});

describe("looksLikeHtml", () => {
  test("detects html documents", () => {
    expect(looksLikeHtml('<html lang="en"><body>x</body>')).toBe(true);
    expect(looksLikeHtml("<p>exhibit</p>")).toBe(true);
  });

  test("rejects plain-text contracts", () => {
    expect(
      looksLikeHtml("THIS AGREEMENT is made between A < B and C > D"),
    ).toBe(false);
  });
});
