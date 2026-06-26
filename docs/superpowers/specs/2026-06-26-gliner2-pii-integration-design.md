# GLiNER2 PII Integration Design

**Date:** 2026-06-26
**Status:** Draft

## Summary

Integrate `fastino/gliner2-privacy-filter-PII-multi` as an NER detection layer in the
anonymize pipeline via a Python sidecar process (FastAPI + `gliner2` library). The
existing `NerInferenceFn` abstraction in `src/pipeline.ts` already decouples NER
from the pipeline — this integration provides a concrete implementation.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  TypeScript / Bun Process                                        │
│                                                                  │
│  ┌─────────────────────────┐     ┌─────────────────────────┐    │
│  │  anonymize pipeline     │     │  Gliner2Client          │    │
│  │  (src/pipeline.ts)      │────>│  (src/gliner2/client.ts)│    │
│  │                         │     │                         │    │
│  │  nerInference =          │     │  start() / infer()     │    │
│  │    buildGliner2Inference │     │  stop()                 │    │
│  └─────────────────────────┘     └──────────┬──────────────┘    │
│                                            │ HTTP (localhost)    │
└─────────────────────────────────────────────────────────────────┘
                         │
                    POST /v1/infer
                         │
┌─────────────────────────────────────────────────────────────────┐
│  Python Sidecar Process (FastAPI + uvicorn)                      │
│                                                                  │
│  gliner2_server/                                                 │
│    main.py        — FastAPI app, /v1/infer, /v1/health          │
│    model.py       — GLiNER2 singleton, lazy from_pretrained     │
│    schemas.py     — Pydantic request/response                   │
│    label_map.py   — Pipeline↔Model label mapping                │
│    pyproject.toml — Python deps                                  │
│                                                                  │
│  Model: fastino/gliner2-privacy-filter-PII-multi (205M params)  │
│  Cached via huggingface_hub, lazy-loaded on first request       │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow

1. Pipeline calls `nerInference(text, labels, threshold, signal?)`
2. `Gliner2Client` maps pipeline labels → model label set via static table
3. Client POSTs JSON to `localhost:{port}/v1/infer`
4. Python server runs `model.extract_entities(text, model_labels, threshold)`
5. Python maps model results back to pipeline canonical labels
6. Client returns `Entity[]` to the pipeline

## API Contract

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
     "label": "person", "score": 0.92}
  ]
}
```

```
GET /v1/health
Response: { "status": "ok", "model_loaded": true }
```

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

### Model → Pipeline (reverse lookup)

```
phone_number  → "phone number"
email         → "email address"
date_of_birth → "date of birth"
...
```

## TypeScript Implementation

### New files in `src/gliner2/`

| File | Purpose |
|---|---|
| `client.ts` | `Gliner2Client` — spawns/stops Python server, HTTP transport |
| `inference.ts` | `buildGliner2Inference()` factory returns `NerInferenceFn` |
| `label-map.ts` | TypeScript copy of the label mapping tables |
| `types.ts` | Request/response types for the HTTP API |

### Server lifecycle (`Gliner2Client`)

- `start()`: Find a free port, spawn `uvicorn gliner2_server.main --port N`,
  poll `/v1/health` until ready (max 30s)
- `infer()`: POST to `/v1/infer`, stream response, apply `AbortSignal`
- `stop()`: `SIGTERM` to Python process, wait for graceful exit (5s timeout → `SIGKILL`)
- Auto-start on first `infer()` call if not running
- Process crash → retry spawn once, then throw

### Integration point

```typescript
// No changes to pipeline.ts — it already accepts nerInference
const nerInference = buildGliner2Inference();

const entities = await runPipeline({
  fullText,
  config: { ...config, enableNer: true },
  gazetteerEntries,
  nerInference,
});
```

## Python Implementation

### Server design

- **Entry point**: `main.py` with FastAPI + uvicorn
- **Model**: `GLiNER2.from_pretrained("fastino/gliner2-privacy-filter-PII-multi")`
  loaded lazily on first request; singleton per process
- **Label mapping**: applied both inbound (pipeline→model) and outbound (model→pipeline)
- **Concurrency**: uvicorn with single worker (GLiNER2 is CPU-bound; multiple workers
  would compete for GPU memory)

### Dependencies (`pyproject.toml`)

- `fastapi>=0.115`
- `uvicorn[standard]>=0.34`
- `gliner2>=0.4`
- `huggingface_hub>=0.27`
- `pydantic>=2.0`

### Model caching

`huggingface_hub` caches the model in `~/.cache/huggingface/hub/` automatically.
First inference triggers a ~500MB download.

## Error Handling

| Scenario | Behavior |
|---|---|
| Python not installed | `buildGliner2Inference()` throws clear message on start |
| Model not cached (first run) | First request blocks until download completes |
| Server crash mid-request | Client retries spawn once, then throws |
| AbortSignal | HTTP request cancelled; server side aborts inference |
| Server busy | Sequential requests (single worker); queue naturally |
| GPU OOM | Model fails to load; health check returns error |

## Security

- Server binds to `127.0.0.1` only (no remote access)
- No authentication (local-only, same host)
- Text data travels over localhost HTTP — no encryption needed
- Python process inherits the same user permissions as the parent

## Testing

- **Unit**: label mapping (both directions), result mapping edge cases
- **Integration**: start Python server in test setup, run infer, verify output shape
- **Pipeline**: run `runPipeline` with `enableNer: true` and `nerInference`, verify
  NER entities appear in merged output alongside rule-based entities
- **Slow test**: contract fixture pipeline run with GLiNER2 enabled (compare
  snapshot stability)

## Future Considerations

- **Multi-worker**: If throughput demands, add `--workers N` with model copied per worker
- **GPU support**: Automatic if CUDA/NPU is available; no code changes needed
- **ONNX direct path**: If Python dependency is undesirable, the fragmented ONNX
  variant can be loaded via `onnxruntime-node` as a future alternative
- **Model update**: Bump model tag in `main.py` when new fine-tunes are released

## Non-Goals

- Bundling the Python server into the npm package (distributed separately)
- Replacing the existing `src/gliner/` decoders (v1 GLiNER code stays for backward compat)
- Hot-reloading the model (process restart required)
- Windows ASGI support (uvicorn works on Windows; no special handling needed)
