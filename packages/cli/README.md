# @stll/anonymize-cli

Command-line PII detection and anonymization powered by
[`@stll/anonymize`](https://github.com/stella/anonymize).
Fully offline: no network calls, ever.

## Usage

```bash
# No install needed
echo "Contact Jan Novák at jan.novak@example.com" | bunx @stll/anonymize-cli
# Contact [PERSON_1] at [EMAIL_ADDRESS_1]

# Or with npx / a global install (bin name: anonymize)
npx @stll/anonymize-cli contract.txt > contract.anon.txt
```

Reversible round-trip for LLM workflows — anonymize, send the
redacted text to a model, restore names in the answer:

```bash
anonymize -k key.json -o redacted.txt input.txt
# ... send redacted.txt to the LLM, save reply as reply.txt ...
anonymize -d key.json reply.txt
```

## Options

| Flag                      | Meaning                                         |
| ------------------------- | ----------------------------------------------- |
| `-o, --output <path>`     | Output file, or directory for multiple inputs   |
| `-m, --mode <mode>`       | `replace` (reversible placeholders) or `redact` |
| `-k, --key <path>`        | Write the redaction key JSON (replace mode)     |
| `-d, --deanonymise <key>` | Restore text using a redaction key              |
| `--labels <list>`         | Entity labels to detect (default: all)          |
| `--languages <list>`      | Name-corpus languages, e.g. `cs,de,en`          |
| `--countries <list>`      | ISO 3166-1 alpha-2 deny-list/city scope         |
| `--threshold <n>`         | Minimum confidence score 0-1 (default 0.3)      |
| `--redact-string <s>`     | Replacement text in redact mode                 |
| `--json`                  | Emit entities + redacted text as JSON           |
| `--quiet`                 | Suppress the stderr summary                     |

Run `anonymize --help` for the full reference, including the
`--json` schema and exit codes.

## Scripting and agents

- Exit codes: `0` success, `1` runtime error, `2` usage error.
- The stderr summary contains entity-label counts only, never
  detected text.
- The interactive locale prompt appears only when stdin and
  stderr are TTYs and no scope flags are given; piped runs
  never block.
- `--json` offsets are UTF-16 code-unit indexes into the input.

## Standalone binary

The single-file `bun build --compile` binary is temporarily
unavailable. It embedded the previous in-process TS pipeline;
that engine has been replaced by the `@stll/anonymize-wasm`
native binding, which instantiates through the napi-rs
`wasm32-wasip1-threads` glue (`node:wasi` + worker threads).
Bun's `node:wasi` does not yet implement `WASI.prototype.initialize`,
so the binding cannot instantiate under the Bun runtime that a
compiled binary ships with. The binary will return once Bun
implements the missing `node:wasi` surface (or a non-threaded
single-file wasm artifact is available). The npm CLI above is
the supported distribution in the meantime.

## License

MIT
