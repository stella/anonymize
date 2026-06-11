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
