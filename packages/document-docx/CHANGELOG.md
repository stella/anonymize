# @stll/anonymize-docx

## 2.3.0

### Patch Changes

- [#321](https://github.com/stella/anonymize/pull/321) [`1d5a1d0`](https://github.com/stella/anonymize/commit/1d5a1d0e8f4d9d89be949e1074cd3e407ccc5c41) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Detect day-month dates without a year while rejecting invalid calendar days
  and keeping lowercase month ambiguities scoped to their language vocabulary.

- [#312](https://github.com/stella/anonymize/pull/312) [`2b205ad`](https://github.com/stella/anonymize/commit/2b205adcc78721340aa233fb9d259c614a908e2c) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Route Node and Python DOCX extraction through one bounded Rust core, with archive-wide fail-fast budgets and fail-closed package inventory.

- [#314](https://github.com/stella/anonymize/pull/314) [`315b963`](https://github.com/stella/anonymize/commit/315b963107fd6da567d14beac69b85f0575e9a0a) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Route DOCX restoration planning through the shared Rust core while preserving stable Node and Python error categories.

- [#313](https://github.com/stella/anonymize/pull/313) [`431611c`](https://github.com/stella/anonymize/commit/431611c978e8c8ac425357af1a42d4534e46f7c7) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Route Node and Python DOCX rewriting through the shared bounded Rust core while preserving stable adapter contracts.

- Updated dependencies [[`1d5a1d0`](https://github.com/stella/anonymize/commit/1d5a1d0e8f4d9d89be949e1074cd3e407ccc5c41), [`f74669b`](https://github.com/stella/anonymize/commit/f74669ba7ca7611d22baaafd71251e8bb39c734b), [`d8d415b`](https://github.com/stella/anonymize/commit/d8d415b73081aac38ca5d3b190a237e372d3a557), [`6ae6b7b`](https://github.com/stella/anonymize/commit/6ae6b7bf6107d221e2d00e6ab9bddd464637920d), [`dab5a5d`](https://github.com/stella/anonymize/commit/dab5a5d0b2855e0684ceac8d0d70e5ebc5ac234f), [`9683503`](https://github.com/stella/anonymize/commit/96835036dd4c47d246d4237d9e7476c9d58b9e2a), [`b4d8986`](https://github.com/stella/anonymize/commit/b4d89868988c467d20e6d5f5a860235e04464a95), [`4016556`](https://github.com/stella/anonymize/commit/4016556b0d63d3e534722ac2e8e8eb1023a6cd1a), [`2b205ad`](https://github.com/stella/anonymize/commit/2b205adcc78721340aa233fb9d259c614a908e2c), [`315b963`](https://github.com/stella/anonymize/commit/315b963107fd6da567d14beac69b85f0575e9a0a), [`431611c`](https://github.com/stella/anonymize/commit/431611c978e8c8ac425357af1a42d4534e46f7c7)]:
  - @stll/anonymize@2.3.0

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
