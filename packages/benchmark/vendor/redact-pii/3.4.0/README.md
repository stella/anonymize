# redact-pii 3.4.0 benchmark assets

This directory contains the two detector inputs consumed by the benchmark
adapter, copied byte-for-byte from the `redact-pii@3.4.0` npm package:

- `lib/built-ins/simple-regexp-patterns.js`, stored here with a `.cjs` extension
  so its upstream CommonJS module format remains explicit;
- `lib/built-ins/well-known-names.json`.

Source: <https://www.npmjs.com/package/redact-pii/v/3.4.0>

Repository: <https://github.com/solvvy/redact-pii>

npm integrity:
`sha512-eXx5rwqqdJGD3LVvuJawJf5ge2G42Cx9ec4ItVzjZEoatN+pg2wJg3S6eBht7dQMI+6UbkKigLziOoD3FmF6ug==`

SHA-256 checksums:

```text
bbe8e7fd9e16ecedb835edfd56cfb5a85eec1a76fe594e51fbc97fff2f5ee5f3  simple-regexp-patterns.cjs
71a844c12470df3a46cccaa8dc61c813836e1abb2c7e614576dc087dd1bcdfd2  well-known-names.json
0f2a047368f36e563b8e6ac845c630a7a17ab65061e19061062ccbbc80dfbd7e  LICENSE
```

The files are redistributed under the included MIT license. Keeping only these
static inputs preserves the pinned comparison while avoiding installation of
runtime dependencies that this adapter never invokes.
