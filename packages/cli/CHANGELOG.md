# @stll/anonymize-cli

## 2.3.0

### Patch Changes

- [#321](https://github.com/stella/anonymize/pull/321) [`1d5a1d0`](https://github.com/stella/anonymize/commit/1d5a1d0e8f4d9d89be949e1074cd3e407ccc5c41) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Detect day-month dates without a year while rejecting invalid calendar days
  and keeping lowercase month ambiguities scoped to their language vocabulary.
- Updated dependencies [[`1d5a1d0`](https://github.com/stella/anonymize/commit/1d5a1d0e8f4d9d89be949e1074cd3e407ccc5c41), [`f74669b`](https://github.com/stella/anonymize/commit/f74669ba7ca7611d22baaafd71251e8bb39c734b), [`d8d415b`](https://github.com/stella/anonymize/commit/d8d415b73081aac38ca5d3b190a237e372d3a557), [`6ae6b7b`](https://github.com/stella/anonymize/commit/6ae6b7bf6107d221e2d00e6ab9bddd464637920d), [`dab5a5d`](https://github.com/stella/anonymize/commit/dab5a5d0b2855e0684ceac8d0d70e5ebc5ac234f), [`9683503`](https://github.com/stella/anonymize/commit/96835036dd4c47d246d4237d9e7476c9d58b9e2a), [`b4d8986`](https://github.com/stella/anonymize/commit/b4d89868988c467d20e6d5f5a860235e04464a95), [`4016556`](https://github.com/stella/anonymize/commit/4016556b0d63d3e534722ac2e8e8eb1023a6cd1a), [`2b205ad`](https://github.com/stella/anonymize/commit/2b205adcc78721340aa233fb9d259c614a908e2c), [`315b963`](https://github.com/stella/anonymize/commit/315b963107fd6da567d14beac69b85f0575e9a0a), [`431611c`](https://github.com/stella/anonymize/commit/431611c978e8c8ac425357af1a42d4534e46f7c7)]:
  - @stll/anonymize@2.3.0
  - @stll/anonymize-docx@2.3.0

## 2.2.0

### Minor Changes

- [#293](https://github.com/stella/anonymize/pull/293) [`32807bb`](https://github.com/stella/anonymize/commit/32807bb416854e5dce169e2f2cacd9237ed5f4ce) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Remove the deprecated `PipelineConfig.enableNer` field. The native pipeline never implemented NER and always rejected `true`; typed callers that still pass `enableNer: false` should delete the line. Untyped callers that pass `enableNer: true` keep failing fast through `assertNativePipelineSupported`. Configs serialized with the old field (existing prepared packages) continue to load; the stale key is ignored.

### Patch Changes

- Updated dependencies [[`eeef356`](https://github.com/stella/anonymize/commit/eeef356715307cda6c0c5e425c5fc9f3e0a317bb), [`39f4deb`](https://github.com/stella/anonymize/commit/39f4deb5f6011d8953585ff3656c53058dc13f73), [`9f53741`](https://github.com/stella/anonymize/commit/9f53741e4ca9d847097fa342fecb2693b6e3a091), [`d6a8fd9`](https://github.com/stella/anonymize/commit/d6a8fd9fa2d096423afbcd7e0f558bfee17840bb), [`33c533a`](https://github.com/stella/anonymize/commit/33c533a60a4937213e557aec05c37d11f4d78731), [`956d098`](https://github.com/stella/anonymize/commit/956d0989dcd51fd7a45c36076813392112a6bfb6), [`32807bb`](https://github.com/stella/anonymize/commit/32807bb416854e5dce169e2f2cacd9237ed5f4ce), [`b90de58`](https://github.com/stella/anonymize/commit/b90de58df6d09cec68d72ce810b2dd07fe5a5694), [`b90de58`](https://github.com/stella/anonymize/commit/b90de58df6d09cec68d72ce810b2dd07fe5a5694), [`b90de58`](https://github.com/stella/anonymize/commit/b90de58df6d09cec68d72ce810b2dd07fe5a5694)]:
  - @stll/anonymize@2.2.0
  - @stll/anonymize-docx@2.2.0

## 2.1.0

### Patch Changes

- Updated dependencies [[`a427007`](https://github.com/stella/anonymize/commit/a427007925e7f1cf6c74e1796cd4e622affd0250)]:
  - @stll/anonymize@2.1.0
  - @stll/anonymize-docx@2.1.0
