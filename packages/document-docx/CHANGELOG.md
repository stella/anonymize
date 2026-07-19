# @stll/anonymize-docx

## 2.2.0

### Patch Changes

- [#288](https://github.com/stella/anonymize/pull/288) [`b90de58`](https://github.com/stella/anonymize/commit/b90de58df6d09cec68d72ce810b2dd07fe5a5694) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Fail closed on DOCX coverage gaps: hyperlink relationship targets
  (`mailto:`/`tel:` in `*.rels`) and document metadata parts (`docProps/*`,
  `customXml/*`) are now surfaced as unsupported coverage instead of being
  silently reported as fully covered, so `require-full` no longer passes a
  document that would leak PII in those parts. Also adds aggregate work budgets to
  extraction (segment×depth) and rewrite (planned replacement bytes) so crafted
  inputs cannot exhaust memory before existing size checks fire.

  Note: because nearly all real documents carry `docProps/core.xml`, callers
  relying on `require-full` will now need `allow-partial` (or metadata redaction)
  until metadata redaction lands.

- Updated dependencies [[`eeef356`](https://github.com/stella/anonymize/commit/eeef356715307cda6c0c5e425c5fc9f3e0a317bb), [`39f4deb`](https://github.com/stella/anonymize/commit/39f4deb5f6011d8953585ff3656c53058dc13f73), [`9f53741`](https://github.com/stella/anonymize/commit/9f53741e4ca9d847097fa342fecb2693b6e3a091), [`d6a8fd9`](https://github.com/stella/anonymize/commit/d6a8fd9fa2d096423afbcd7e0f558bfee17840bb), [`33c533a`](https://github.com/stella/anonymize/commit/33c533a60a4937213e557aec05c37d11f4d78731), [`956d098`](https://github.com/stella/anonymize/commit/956d0989dcd51fd7a45c36076813392112a6bfb6), [`32807bb`](https://github.com/stella/anonymize/commit/32807bb416854e5dce169e2f2cacd9237ed5f4ce), [`b90de58`](https://github.com/stella/anonymize/commit/b90de58df6d09cec68d72ce810b2dd07fe5a5694), [`b90de58`](https://github.com/stella/anonymize/commit/b90de58df6d09cec68d72ce810b2dd07fe5a5694)]:
  - @stll/anonymize@2.2.0

## 2.1.0

### Patch Changes

- Updated dependencies [[`a427007`](https://github.com/stella/anonymize/commit/a427007925e7f1cf6c74e1796cd4e622affd0250)]:
  - @stll/anonymize@2.1.0
