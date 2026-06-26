# GLiNER2 PII Integration — Rust Sidecar Design

**Date:** 2026-06-26
**Status:** Draft

## Summary

Integrate `SemplificaAI/gliner2-privacy-filter-PII-multi` (fragmented ONNX V2, 42 PII
labels, 7 languages) as an NER detection layer in the anonymize pipeline. Inference
runs in a Rust HTTP sidecar binary using the `gliner2-inference` crate, which loads
the 8 ONNX V2 fragments and handles all model orchestration internally.

The existing `NerInferenceFn` abstraction in `src/pipeline.ts` already decouples NER
from the pipeline — this integration provides a concrete implementation via a
`Gliner2Client` that spawns and communicates with the Rust server.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  TS / Bun Process                                              │
│                                                                │
│  ┌────────────────────┐    ┌──────────────────────────┐       │
│  │  anonymize pipeline │    │  Gliner2Client           │       │
│  │  (pipeline.ts)      │───>│  (src/gliner2/client.ts) │       │
│  │                     │    │                          │       │
│  │  nerInference =      │    │  start() — spawn binary │       │
│  │    buildGliner2Infer │    │  infer() — POST /v1/infer│      │
│  │                     │    │  stop()  — SIGTERM       │       │
│  └────────────────────┘    └─────────┬─────────────────┘       │
│                                      │ HTTP (127.0.0.1)        │
└────────────────────────────────────────────────────────────────┘
                        │
                   POST /v1/infer
                        │
┌──────────────────────────────────────────────────────────────┐
│  Rust Binary (gliner2-server)                                  │
│                                                                │
│  axum HTTP server                                              │
│  Gliner2Engine (gliner2-inference crate)                       │
│    ├─ encoder.onnx                                             │
│    ├─ token_gather.onnx           ← 8 ONNX V2 fragments       │
│    ├─ span_rep.onnx                 auto-downloaded from HF    │
│    ├─ schema_gather.onnx                                      │
│    ├─ count_pred_argmax.onnx                                  │
│    ├─ count_lstm_fixed.onnx                                   │
│    ├─ scorer.onnx                                              │
│    ├─ classifier.onnx                                         │
│    └─ tokenizer.json                                           │
│                                                                │
│  Model: SemplificaAI/gliner2-privacy-filter-PII-multi         │
│  Variant: fp16_v2 (CUDA/ROCm) / fp16 (macOS CoreML)           │
│  ~530MB cached in ~/.cache/huggingface/hub/                    │
└────────────────────────────────────────────────────────────────┘
```

## Data Flow

1. Pipeline calls `nerInference(text, labels, threshold, signal?)`
2. `Gliner2Client` maps pipeline labels → model label set via static table (TS-only)
3. Client POSTs model-native labels to `http://127.0.0.1:{port}/v1/infer`
4. Rust server calls `Gliner2Engine::extract(text, &tasks)` with `InferenceParams`
5. Rust returns model-native labels in response
6. `Gliner2Client` maps model labels → pipeline canonical labels (reverse map)
7. Client returns `Entity[]` to the pipeline

## HTTP API

```
POST /v1/infer
Content-Type: application/json

Request:
{
  "text": "Contact Maria Jensen at maria@example.com.",
  "labels": ["person", "email", "phone_number"],
  "threshold": 0.5
}

Response:
{
  "entities": [
    {"text": "Maria Jensen", "start": 9, "end": 21,
     "label": "person", "score": 0.92},
    {"text": "maria@example.com", "start": 25, "end": 42,
     "label": "email", "score": 0.98}
  ]
}

Note: "labels" in the request and "label" in the response use model-native
label names (underscore-separated, matching the GLiNER2 42-label schema).
The TS client maps pipeline labels to model labels before sending, and
maps model labels back to pipeline canonical labels after receiving.
```

```
GET /v1/health
Response: { "status": "ok", "model_loaded": true, "version": "0.1.0" }
```

## Pipeline Canonical Labels

The pipeline defines 22 canonical entity labels in `src/constants.ts:DEFAULT_ENTITY_LABELS`:

```
person, organization, phone number, address, country,
email address, date, date of birth, bank account number,
iban, tax identification number, identity card number,
birth number, national identification number,
social security number, registration number,
credit card number, passport number, crypto,
monetary amount, land parcel, misc
```

GLiNER2 NER handles a subset; the rest are covered by rule-based detectors.

## Label Mapping

### Pipeline → Model (1:N)

| Pipeline label | Model labels |
|---|---|
| `person` | `person`, `full_name`, `first_name`, `middle_name`, `last_name` |
| `phone number` | `phone_number` |
| `address` | `address`, `street_address` |
| `email address` | `email` |
| `date of birth` | `date_of_birth` |
| `bank account number` | `bank_account`, `account_number` |
| `iban` | `iban` |
| `tax identification number` | `tax_id`, `tax_number` |
| `identity card number` | `government_id`, `national_id_number` |
| `birth number` | `national_id_number` |
| `national identification number` | `national_id_number` |
| `social security number` | `national_id_number` |
| `credit card number` | `payment_card`, `card_number` |
| `passport number` | `passport_number` |
| `date` | `sensitive_date`, `document_date`, `expiration_date` |

### Skipped pipeline labels (handled by rule-based detectors)

`organization`, `country`, `monetary amount`, `registration number`,
`land parcel`, `crypto`, `misc`

(`crypto` and `misc` are also excluded at the pipeline level via `NON_NER_LABELS`.)

### Model → Pipeline (reverse lookup)

```
phone_number  → "phone number"
email         → "email address"
date_of_birth → "date of birth"
...
```

The reverse map is maintained in the TS `label-map.ts`. When multiple pipeline
labels map to the same model label (e.g., `identity card number`, `birth number`,
`national identification number`, `social security number` → `national_id_number`),
the TS client disambiguates by preferring the **original pipeline label that was
requested** in the infer call. If the caller asked for `"social security number"`
and the model returns `"national_id_number"`, it maps back to
`"social security number"`. If the caller asked for `"birth number"`, it maps back
to `"birth number"`. If the model returns a label that wasn't in the original
request (unlikely but defensive), fall back to a hardcoded preference order.

## Rust Server

### Crate structure

```
packages/gliner2-server/
  Cargo.toml
  src/
    main.rs       — axum HTTP server, CLI arg parsing, startup
    infer.rs      — POST /v1/infer handler
    health.rs     — GET /v1/health handler
    types.rs      — Request/Response serde structs
    engine.rs     — Gliner2Engine singleton wrapper
```

### Dependencies (`Cargo.toml`)

```toml
[dependencies]
axum = "0.8"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
gliner2-inference = "0.5"
tracing = "0.1"
tracing-subscriber = "0.3"
clap = { version = "4", features = ["derive"] }
```

### CLI

```
gliner2-server [OPTIONS]

Options:
  -p, --port <PORT>          Server port [default: 0 = random]
  -H, --host <HOST>          Bind address [default: 127.0.0.1]
  -m, --model <NAME>         HF model repo [default: SemplificaAI/gliner2-privacy-filter-PII-multi]
  -v, --variant <VARIANT>    ONNX variant [default: auto — fp16_v2 on CUDA, fp16 on macOS, fp32 fallback]
  -d, --model-dir <DIR>      Override model cache directory
```

Output on startup (machine-parseable):
```
{"event":"listening","host":"127.0.0.1","port":8765}
```

### Engine singleton

- `Gliner2Engine` is created once, stored in axum application state
- Created lazily on first `/v1/infer` request (not at startup, so the server is
  responsive immediately for health checks)
- First request blocks until `from_pretrained()` completes (model download + ONNX loading)
- Subsequent requests reuse the loaded engine

### Label mapping

The Rust server is model-agnostic: it receives whatever labels the client
sends and returns model-native labels. All label mapping (pipeline ↔ model)
lives on the **TS client side only**:

- **Outbound**: TS client expands pipeline labels to model labels via the
  1:N forward map (e.g., `"person"` → `["person", "full_name", "first_name"]`)
- **Inbound**: TS client collapses model labels back to pipeline canonical
  labels via the reverse map (e.g., `"phone_number"` → `"phone number"`)

The Rust server has no knowledge of the pipeline's canonical label set.

## TypeScript Integration

### New files in `src/gliner2/`

| File | Purpose |
|---|---|
| `client.ts` | `Gliner2Client` — spawns/stops Rust binary, HTTP transport |
| `inference.ts` | `buildGliner2Inference()` factory returns `NerInferenceFn` |
| `label-map.ts` | Label mapping tables (pipeline ↔ model) |
| `types.ts` | Request/response types for the HTTP API |

### Gliner2Client lifecycle

- **`start()`**: Resolve binary path, spawn process, read port from stdout,
  poll `/v1/health` every 500ms (max 30s)
- **`infer()`**: Map labels, POST to `/v1/infer`, apply `AbortSignal`
- **`stop()`** / **`dispose()`**: SIGTERM to process, wait 5s, then SIGKILL
- Auto-start on first `infer()` call
- Process crash → retry spawn once, then throw

### Binary path resolution

1. `ANONYMIZE_GLINER2_SERVER_PATH` env var (explicit override)
2. Check `node_modules/@stll/gliner2-server/bin/{platform}-{arch}/` (bundled binary)
3. Download from GitHub Releases on first call (lazy download)

### Integration point

```typescript
import { buildGliner2Inference } from "./gliner2/inference";

const nerInference = buildGliner2Inference();

const entities = await runPipeline({
  fullText,
  config: { ...config, enableNer: true },
  gazetteerEntries,
  nerInference,
});
```

No changes to `pipeline.ts`.

## Binary Distribution

### Platform matrix

Built via CI from this monorepo and published as GitHub Release assets.

| Target | Binary name |
|---|---|
| `x86_64-pc-windows-msvc` | `gliner2-server-x86_64-windows.exe` |
| `x86_64-unknown-linux-gnu` | `gliner2-server-x86_64-linux` |
| `x86_64-apple-darwin` | `gliner2-server-x86_64-darwin` |
| `aarch64-apple-darwin` | `gliner2-server-aarch64-darwin` |

### Download

The TS client includes a download helper that fetches the appropriate binary
on first use from the repo's GitHub Releases:

```typescript
const binaryPath = await downloadBinary({
  repo: "stella/anonymize",
  version: "v0.1.0",
  platform: process.platform,
  arch: process.arch,
});
```

The binary is cached in `node_modules/.cache/gliner2-server/`.

### Model caching

Model ONNX files (~530MB) are cached by `gliner2-rs` via the `hf-hub` crate in
`~/.cache/huggingface/hub/`. No TS-side model management needed.

## Error Handling

| Scenario | Behavior |
|---|---|
| Binary not found | Download on first call, or throw with install instructions |
| Binary incompatible (wrong arch) | Clear error with expected platform string |
| Server crash mid-request | Client retries spawn once, then throws |
| Model not cached (first run) | First `/v1/infer` blocks until download completes (~530MB) |
| AbortSignal | HTTP request cancelled; server-side inference continues (no server-side abort in `gliner2-inference` yet) |
| GPU OOM | Model fails to load; health endpoint returns error |
| Port conflict | Server exits immediately (exit code != 0). Client detects missing process, picks a different port, re-spawns. Max 3 retries. |

## Security

- Server binds to `127.0.0.1` only (no remote access)
- No authentication (local-only, same host)
- Text data travels over localhost HTTP — no encryption needed
- Rust binary has no network access beyond the listening socket and HuggingFace Hub

## Testing

- **Unit**: label mapping (both directions), binary path resolution
- **Integration**: start Rust binary in test setup, run infer, verify output shape
- **Pipeline**: run `runPipeline` with `enableNer: true` and `nerInference`, verify
  NER entities appear in merged output
- **Slow test**: contract fixture pipeline run with GLiNER2 enabled

## Non-Goals

- Replacing the existing `src/gliner/` decoders (v1 GLiNER code stays for backward compat)
- Hot-reloading the model (process restart required)
- Server-side label remapping (kept in TS for simplicity)
- Windows ARM64 binary (not available from gliner2-rs dependencies)

## Future Considerations

- **Server-side abort**: `gliner2-inference` doesn't support cancellation yet;
  upstream issue if needed
- **Multi-worker**: Multiple server processes behind a load balancer for higher throughput
- **Model updates**: Bump default model tag in the server when new fine-tunes are released
- **Binary updates**: Version negotiation between TS client and Rust binary
