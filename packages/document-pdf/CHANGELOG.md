# @stll/anonymize-pdf

## 2.4.0

### Minor Changes

- [#344](https://github.com/stella/anonymize/pull/344) [`66b250b`](https://github.com/stella/anonymize/commit/66b250bb4d633715402784210428341047c73816) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add a bounded local Poppler/Tesseract PDF observation adapter and an atomic,
  non-overwriting CLI workflow for verified destructive image-only output. OCR
  uses one explicit language pack and the certificate remains honest about recall.

- [#338](https://github.com/stella/anonymize/pull/338) [`3923dbe`](https://github.com/stella/anonymize/commit/3923dbe6d0b1fe202e1a3a23a54166aee5885d64) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add a bounded, cross-runtime PDF structure and coverage inspection contract.
  Inventory forms, annotations, attachments, metadata, JavaScript, XFA, optional
  content, signatures, and image objects without claiming that inspection or an
  opaque rectangle overlay anonymizes a PDF.

- [#342](https://github.com/stella/anonymize/pull/342) [`41f440c`](https://github.com/stella/anonymize/commit/41f440c19ab7b8cebe59f4cbb2c2dcda47b4dd67) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add a fail-closed, provider-neutral PDF raster anonymization contract with
  exact Node and Python document-profile parity. The surface emits a verified,
  fresh image-only PDF and never retains source PDF objects or hidden content.

### Patch Changes

- Updated dependencies [[`a8ffd9b`](https://github.com/stella/anonymize/commit/a8ffd9be1ad3115ae0f405d5eb0880589377a98a), [`6b547a1`](https://github.com/stella/anonymize/commit/6b547a1e675ba5219d3a97de7d2a6b5213ebad7c), [`ac27bc1`](https://github.com/stella/anonymize/commit/ac27bc1b620d847daadcd8559919258867c7e8bb), [`3923dbe`](https://github.com/stella/anonymize/commit/3923dbe6d0b1fe202e1a3a23a54166aee5885d64), [`ed699d9`](https://github.com/stella/anonymize/commit/ed699d932ce40c5ca5749b6235146b713eba78b6), [`97cdfff`](https://github.com/stella/anonymize/commit/97cdfff8cf42851e2f7d5d1b866cfadfaaa5dbc0), [`41f440c`](https://github.com/stella/anonymize/commit/41f440c19ab7b8cebe59f4cbb2c2dcda47b4dd67), [`db7c4d1`](https://github.com/stella/anonymize/commit/db7c4d1908750585e4e294e380cb826a36b48375), [`984c7bb`](https://github.com/stella/anonymize/commit/984c7bb6b8d2c8ec7855af67b104bd8c2e4b0b38)]:
  - @stll/anonymize@2.4.0
