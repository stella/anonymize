# @stll/anonymize-mcp

## 2.4.1

### Patch Changes

- Updated dependencies [[`6469935`](https://github.com/stella/anonymize/commit/64699354e210eed7eadaa2650d06fd195942c5c6), [`20071a8`](https://github.com/stella/anonymize/commit/20071a8a8d0841cb1c7bf1a7dd41f183966f0ab3), [`bf1eda3`](https://github.com/stella/anonymize/commit/bf1eda396973bc04986c75cb6b5ec63214e24799), [`3e95d22`](https://github.com/stella/anonymize/commit/3e95d22a8768539b539fdbb39df6e1e5d4d8e88f), [`4f5140f`](https://github.com/stella/anonymize/commit/4f5140fbaddbb69aafa68dec98bd06c4b2b7a45e), [`bf1eda3`](https://github.com/stella/anonymize/commit/bf1eda396973bc04986c75cb6b5ec63214e24799), [`4f5140f`](https://github.com/stella/anonymize/commit/4f5140fbaddbb69aafa68dec98bd06c4b2b7a45e)]:
  - @stll/anonymize@2.4.1
  - @stll/anonymize-pdf@2.4.1
  - @stll/anonymize-docx@2.4.1

## 2.4.0

### Minor Changes

- [#340](https://github.com/stella/anonymize/pull/340) [`86d4fd1`](https://github.com/stella/anonymize/commit/86d4fd16b67e18c449e8efbafd16a3bfa8014b9b) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add public MCP capability discovery, opt-in encrypted durable sessions, and
  path-only provider-neutral external detection sidecar ingestion.

- [#345](https://github.com/stella/anonymize/pull/345) [`7254ed2`](https://github.com/stella/anonymize/commit/7254ed28a1a81e0943f8e6bf1c6bed10c18873ed) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add a path-only local PDF raster anonymization tool with server-configured Poppler and Tesseract executables and aggregate-only verification results.

### Patch Changes

- Updated dependencies [[`a8ffd9b`](https://github.com/stella/anonymize/commit/a8ffd9be1ad3115ae0f405d5eb0880589377a98a), [`6b547a1`](https://github.com/stella/anonymize/commit/6b547a1e675ba5219d3a97de7d2a6b5213ebad7c), [`ac27bc1`](https://github.com/stella/anonymize/commit/ac27bc1b620d847daadcd8559919258867c7e8bb), [`66b250b`](https://github.com/stella/anonymize/commit/66b250bb4d633715402784210428341047c73816), [`3923dbe`](https://github.com/stella/anonymize/commit/3923dbe6d0b1fe202e1a3a23a54166aee5885d64), [`ed699d9`](https://github.com/stella/anonymize/commit/ed699d932ce40c5ca5749b6235146b713eba78b6), [`97cdfff`](https://github.com/stella/anonymize/commit/97cdfff8cf42851e2f7d5d1b866cfadfaaa5dbc0), [`41f440c`](https://github.com/stella/anonymize/commit/41f440c19ab7b8cebe59f4cbb2c2dcda47b4dd67), [`db7c4d1`](https://github.com/stella/anonymize/commit/db7c4d1908750585e4e294e380cb826a36b48375), [`984c7bb`](https://github.com/stella/anonymize/commit/984c7bb6b8d2c8ec7855af67b104bd8c2e4b0b38)]:
  - @stll/anonymize@2.4.0
  - @stll/anonymize-pdf@2.4.0
  - @stll/anonymize-docx@2.4.0

## 2.3.0

### Minor Changes

- [#316](https://github.com/stella/anonymize/pull/316) [`b845008`](https://github.com/stella/anonymize/commit/b8450082126c69d1ac4e7776989b04267080a4d5) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add a path-only local stdio MCP server for text and DOCX anonymization,
  restoration, and audit-safe DOCX coverage inspection.

### Patch Changes

- [#321](https://github.com/stella/anonymize/pull/321) [`1d5a1d0`](https://github.com/stella/anonymize/commit/1d5a1d0e8f4d9d89be949e1074cd3e407ccc5c41) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Detect day-month dates without a year while rejecting invalid calendar days
  and keeping lowercase month ambiguities scoped to their language vocabulary.
- Updated dependencies [[`1d5a1d0`](https://github.com/stella/anonymize/commit/1d5a1d0e8f4d9d89be949e1074cd3e407ccc5c41), [`f74669b`](https://github.com/stella/anonymize/commit/f74669ba7ca7611d22baaafd71251e8bb39c734b), [`d8d415b`](https://github.com/stella/anonymize/commit/d8d415b73081aac38ca5d3b190a237e372d3a557), [`6ae6b7b`](https://github.com/stella/anonymize/commit/6ae6b7bf6107d221e2d00e6ab9bddd464637920d), [`dab5a5d`](https://github.com/stella/anonymize/commit/dab5a5d0b2855e0684ceac8d0d70e5ebc5ac234f), [`9683503`](https://github.com/stella/anonymize/commit/96835036dd4c47d246d4237d9e7476c9d58b9e2a), [`b4d8986`](https://github.com/stella/anonymize/commit/b4d89868988c467d20e6d5f5a860235e04464a95), [`4016556`](https://github.com/stella/anonymize/commit/4016556b0d63d3e534722ac2e8e8eb1023a6cd1a), [`2b205ad`](https://github.com/stella/anonymize/commit/2b205adcc78721340aa233fb9d259c614a908e2c), [`315b963`](https://github.com/stella/anonymize/commit/315b963107fd6da567d14beac69b85f0575e9a0a), [`431611c`](https://github.com/stella/anonymize/commit/431611c978e8c8ac425357af1a42d4534e46f7c7)]:
  - @stll/anonymize@2.3.0
  - @stll/anonymize-docx@2.3.0
