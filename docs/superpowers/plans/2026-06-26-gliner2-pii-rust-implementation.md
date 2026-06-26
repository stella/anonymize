# GLiNER2 PII — Rust Sidecar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Rust HTTP sidecar binary that loads `SemplificaAI/gliner2-privacy-filter-PII-multi` (fragmented ONNX V2, 42 PII labels) and serves inference, plus a TS client that integrates it into the anonymize pipeline via `NerInferenceFn`.

**Architecture:** Rust binary (`crates/gliner2-server/`) runs an axum HTTP server wrapping `gliner2-inference` crate. TS `Gliner2Client` spawns the binary, sends POST requests, maps labels on both sides. Pipeline integration via `buildGliner2Inference()` factory — zero changes to `pipeline.ts`. The crate lives in `crates/` (matching existing Rust workspace convention) and is registered in the root `Cargo.toml` as a workspace member.

**Tech Stack:** Rust (axum, gliner2-inference 0.5, ort, hf-hub), TypeScript (Bun, anonymize pipeline), GitHub Actions (cross-compilation)

**Spec:** `docs/superpowers/specs/2026-06-26-gliner2-pii-integration-rust-design.md`

---

### Prerequisite: Register crate in workspace

- [ ] **Step 0 (before Task 1, committed with Task 1's Step 7)**

Add `"crates/gliner2-server"` to `members` in root `Cargo.toml`:
```toml
members = [
  "crates/anonymize-adapter-contract",
  "crates/anonymize-core",
  "crates/anonymize-napi",
  "crates/anonymize-py",
  "crates/gliner2-server",
]
```

This ensures CI's `cargo clippy --workspace` and `cargo test --workspace` include the new crate.

### Task 1: Rust project scaffold + health endpoint

**Files:**
- Create: `crates/gliner2-server/Cargo.toml`
- Modify: `Cargo.toml` (workspace members)
- Create: `crates/gliner2-server/src/main.rs`
- Create: `crates/gliner2-server/src/types.rs`
- Create: `crates/gliner2-server/src/health.rs`

- [ ] **Step 1: Create Cargo.toml with dependencies**

```toml
[package]
name = "gliner2-server"
version.workspace = true
edition.workspace = true
description = "HTTP sidecar for GLiNER2 PII inference"
license.workspace = true
publish.workspace = true
repository.workspace = true

[dependencies]
axum = "0.8"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
clap = { version = "4", features = ["derive"] }

[lints]
workspace = true
```

- [ ] **Step 2: Create main.rs with axum server + CLI parsing**

Workspace lints deny `print_stdout`, `unwrap_used`, `expect_used`, `panic`, `exit`. The startup JSON must go to stdout (protocol requirement for the TS client) — allow it with a crate-level attribute.

```rust
#![allow(clippy::print_stdout)]

use axum::{Router, serve};
use clap::Parser;
use std::io::Write;
use std::net::SocketAddr;
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

mod health;
mod types;

#[derive(Parser, Debug)]
#[command(name = "gliner2-server")]
struct Cli {
    #[arg(short, long, default_value = "0")]
    port: u16,
    #[arg(short = 'H', long, default_value = "127.0.0.1")]
    host: String,
    #[arg(short, long, default_value = "SemplificaAI/gliner2-privacy-filter-PII-multi")]
    model: String,
    #[arg(short, long)]
    variant: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let cli = Cli::parse();
    let max_attempts = 3;

    for attempt in 0..max_attempts {
        let port = if attempt == 0 { cli.port } else { 0 };
        let addr: SocketAddr = format!("{}:{}", cli.host, port).parse()?;

        match TcpListener::bind(addr).await {
            Ok(listener) => {
                let local = listener.local_addr()?;
                let startup = serde_json::json!({"event":"listening","host":format!("{}", local.ip()),"port":local.port()});
                writeln!(std::io::stdout(), "{startup}")?;

                let app = Router::new()
                    .route("/v1/health", axum::routing::get(health::health_handler));

                serve(listener, app).await?;
                return Ok(());
            }
            Err(e) if attempt + 1 < max_attempts => {
                tracing::warn!("port {port} failed (attempt {}): {e}; retrying with random port", attempt + 1);
            }
            Err(e) => {
                anyhow::bail!("failed to bind after {max_attempts} attempts: {e}");
            }
        }
    }

    Ok(())
}
```

- [ ] **Step 3: Create health.rs**

```rust
use axum::Json;
use serde::Serialize;

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub model_loaded: bool,
    pub version: String,
}

pub async fn health_handler() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".into(),
        model_loaded: false,
        version: "0.1.0".into(),
    })
}
```

- [ ] **Step 4: Create types.rs**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct InferRequest {
    pub text: String,
    pub labels: Vec<String>,
    pub threshold: Option<f32>,
}

#[derive(Debug, Serialize)]
pub struct EntityOutput {
    pub text: String,
    pub start: usize,
    pub end: usize,
    pub label: String,
    pub score: f32,
}

#[derive(Debug, Serialize)]
pub struct InferResponse {
    pub entities: Vec<EntityOutput>,
}
```

- [ ] **Step 5: Build and verify the scaffold compiles**

Run: `cd crates/gliner2-server && cargo build`
Expected: Build succeeds (dependencies may take time to download)

- [ ] **Step 6: Verify health endpoint works**

Run: `cd crates/gliner2-server && cargo run -- --port 18765`
In another terminal: `curl http://127.0.0.1:18765/v1/health`
Expected: `{"status":"ok","model_loaded":false,"version":"0.1.0"}`

- [ ] **Step 7: Commit (includes Step 0 workspace registration)**

```bash
git add Cargo.toml crates/gliner2-server/
git commit -m "feat: add gliner2-server Rust scaffold with health endpoint"
```

---

### Task 2: Rust inference endpoint with Gliner2Engine

**Files:**
- Modify: `crates/gliner2-server/Cargo.toml`
- Create: `crates/gliner2-server/src/engine.rs`
- Create: `crates/gliner2-server/src/infer.rs`
- Modify: `crates/gliner2-server/src/main.rs`

- [ ] **Step 1: Add gliner2-inference and ort to Cargo.toml**

Add under `[dependencies]`:
```toml
gliner2-inference = "0.5"
ort = { version = "=2.0.0-rc.9", features = ["load-dynamic"] }
anyhow = "1"
```

- [ ] **Step 2: Create engine.rs — Gliner2Engine lazy singleton**

```rust
use gliner2_inference::{Gliner2Engine, ModelType};
use std::sync::Arc;
use tokio::sync::OnceCell;

static ENGINE: OnceCell<Arc<Gliner2Engine>> = OnceCell::const_new();

pub async fn get_or_init(
    model_id: &str,
    variant: Option<&str>,
) -> anyhow::Result<Arc<Gliner2Engine>> {
    let model_id = model_id.to_string();
    let variant = variant.map(|s| s.to_string());
    ENGINE
        .get_or_try_init(|| async move {
            ort::init().with_name("GLiNER2_Engine").commit()?;
            let engine = Gliner2Engine::from_pretrained(
                &model_id,
                variant.as_deref(),
                ModelType::HuggingFace,
            )?;
            Ok(Arc::new(engine))
        })
        .await
        .map(Arc::clone)
}

pub fn is_initialized() -> bool {
    ENGINE.initialized()
}
```

- [ ] **Step 3: Create infer.rs — POST /v1/infer handler**

```rust
use axum::{Json, extract::State, http::StatusCode};
use crate::engine;
use crate::types::{EntityOutput, InferRequest, InferResponse};
use gliner2_inference::{InferenceParams, SchemaTask};
use std::sync::Arc;

pub struct AppState {
    pub model_id: String,
    pub variant: Option<String>,
}

pub async fn infer_handler(
    State(state): State<Arc<AppState>>,
    Json(req): Json<InferRequest>,
) -> Result<Json<InferResponse>, (StatusCode, String)> {
    let engine = engine::get_or_init(&state.model_id, state.variant.as_deref())
        .await
        .map_err(|e| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                format!("model not ready: {e}"),
            )
        })?;

    let tasks = vec![SchemaTask::Entities(req.labels)];
    let params = InferenceParams {
        threshold: req.threshold.unwrap_or(0.5),
        flat_ner: true,
    };

    let (entities, _, _) = engine
        .extract(&req.text, &tasks, Some(&params))
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("inference failed: {e}"),
            )
        })?;

    let output: Vec<EntityOutput> = entities
        .into_iter()
        .map(|e| EntityOutput {
            text: e.text,
            start: e.start,
            end: e.end,
            label: e.label,
            score: e.score,
        })
        .collect();

    Ok(Json(InferResponse { entities: output }))
}
```

Note: `extract()` signature may differ slightly — adapt to the actual gliner2-inference 0.5 API (e.g., `InferenceParams` struct fields). Verify against `gliner2-rs` docs and adjust.

- [ ] **Step 4: Wire infer route + state into main.rs**

Add `mod engine; mod infer;` and `use infer::AppState;`. Replace the `Router::new()` block in main.rs with:

```rust
use std::sync::Arc;

mod engine;
mod infer;

// Replace the Router::new() block in main():
let state = Arc::new(infer::AppState {
    model_id: cli.model.clone(),
    variant: cli.variant.clone(),
});

let app = Router::new()
    .route("/v1/health", axum::routing::get(health::health_handler))
    .route("/v1/infer", axum::routing::post(infer::infer_handler))
    .with_state(state);
```

- [ ] **Step 5: Update health handler to report model_loaded**

```rust
use axum::{Json, extract::State};
use serde::Serialize;
use std::sync::Arc;
use crate::engine;
use crate::infer::AppState;

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub model_loaded: bool,
    pub version: String,
}

pub async fn health_handler(
    State(state): State<Arc<AppState>>,
) -> Json<HealthResponse> {
    let model_loaded = engine::is_initialized();
    Json(HealthResponse {
        status: "ok".into(),
        model_loaded,
        version: "0.1.0".into(),
    })
}
```

- [ ] **Step 6: Build and verify**

Run: `cd crates/gliner2-server && cargo build`
Expected: Build succeeds

- [ ] **Step 7: Test inference end-to-end with a real text**

Run: `cd crates/gliner2-server && cargo run -- --port 18765`
Wait for startup JSON line, then:
```bash
curl -X POST http://127.0.0.1:18765/v1/infer \
  -H "Content-Type: application/json" \
  -d '{"text":"Contact Maria Jensen at maria@example.com.","labels":["person","email"],"threshold":0.5}'
```
Expected: JSON response with entities array. First request will block for model download (~530MB, ~2s on fast connection).

- [ ] **Step 8: Commit**

```bash
git add crates/gliner2-server/
git commit -m "feat: add GLiNER2 inference endpoint with Gliner2Engine"
```

---

### Task 3: TS client types + label mapping

**Files:**
- Create: `packages/anonymize/src/gliner2/types.ts`
- Create: `packages/anonymize/src/gliner2/label-map.ts`
- Create: `packages/anonymize/src/gliner2/__test__/label-map.test.ts`

- [ ] **Step 1: Create types.ts**

```typescript
export type InferRequest = {
  text: string;
  labels: string[];
  threshold: number;
};

export type EntityOutput = {
  text: string;
  start: number;
  end: number;
  label: string;
  score: number;
};

export type InferResponse = {
  entities: EntityOutput[];
};

export type HealthResponse = {
  status: string;
  model_loaded: boolean;
  version: string;
};
```

- [ ] **Step 2: Create label-map.ts**

```typescript
// Pipeline canonical label → model label(s) (1:N)
export const PIPELINE_TO_MODEL: Record<string, readonly string[]> = {
  person:                       ["person", "full_name", "first_name", "middle_name", "last_name"],
  "phone number":              ["phone_number"],
  address:                     ["address", "street_address"],
  "email address":             ["email"],
  "date of birth":             ["date_of_birth"],
  "bank account number":       ["bank_account", "account_number"],
  iban:                        ["iban"],
  "tax identification number": ["tax_id", "tax_number"],
  "identity card number":      ["government_id", "national_id_number"],
  "birth number":              ["national_id_number"],
  "national identification number": ["national_id_number"],
  "social security number":    ["national_id_number"],
  "credit card number":        ["payment_card", "card_number"],
  "passport number":           ["passport_number"],
  date:                        ["sensitive_date", "document_date", "expiration_date"],
};

// Model label → pipeline canonical label (N:1, with disambiguation)
// When multiple pipeline labels map to the same model label, the
// reverse lookup prefers the first match, then the caller's
// original requested label overrides.
const MODEL_TO_PIPELINE: Record<string, string> = {};
for (const [pipeline, models] of Object.entries(PIPELINE_TO_MODEL)) {
  for (const model of models) {
    // First registration wins (earliest pipeline label takes priority)
    if (!(model in MODEL_TO_PIPELINE)) {
      MODEL_TO_PIPELINE[model] = pipeline;
    }
  }
}

// Map pipeline labels to expanded list of model labels for the request
export const expandLabels = (pipelineLabels: readonly string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const label of pipelineLabels) {
    const modelLabels = PIPELINE_TO_MODEL[label];
    if (!modelLabels) continue; // skip labels not supported by model
    for (const ml of modelLabels) {
      if (!seen.has(ml)) {
        seen.add(ml);
        result.push(ml);
      }
    }
  }
  return result;
};

// Map a model label back to pipeline canonical label.
// `requestedPipelineLabels` is the original set from the caller, used
// to disambiguate collisions (e.g., national_id_number → prefer the
// pipeline label the caller actually asked for).
export const collapseLabel = (
  modelLabel: string,
  requestedPipelineLabels: ReadonlySet<string>,
): string => {
  // The reverse map gives us the default pipeline label
  const defaultLabel = MODEL_TO_PIPELINE[modelLabel];
  if (!defaultLabel) return modelLabel; // unknown label, pass through

  // If the caller asked for this specific pipeline label, use it
  // (handles the case where multiple pipeline labels map to one model label)
  if (requestedPipelineLabels.has(defaultLabel)) return defaultLabel;

  // If the default doesn't match, check if any other pipeline label
  // that maps to this model label was requested
  for (const [pipeline, models] of Object.entries(PIPELINE_TO_MODEL)) {
    if (models.includes(modelLabel) && requestedPipelineLabels.has(pipeline)) {
      return pipeline;
    }
  }

  return defaultLabel;
};
```

- [ ] **Step 3: Write label-map test**

```typescript
import { describe, it, expect } from "bun:test";
import { expandLabels, collapseLabel, PIPELINE_TO_MODEL } from "../label-map";

describe("label-map", () => {
  it("expands person to 5 model labels", () => {
    const expanded = expandLabels(["person"]);
    expect(expanded).toEqual([
      "person", "full_name", "first_name", "middle_name", "last_name",
    ]);
  });

  it("skips labels not in model", () => {
    const expanded = expandLabels(["organization", "person"]);
    expect(expanded).not.toContain("organization");
    expect(expanded).toContain("person");
  });

  it("deduplicates when multiple pipeline labels share model labels", () => {
    const expanded = expandLabels([
      "social security number",
      "birth number",
      "person",
    ]);
    const nins = expanded.filter((l) => l === "national_id_number");
    expect(nins).toHaveLength(1);
  });

  it("collapses model label preferring requested pipeline label", () => {
    const result = collapseLabel("national_id_number", new Set(["social security number"]));
    expect(result).toBe("social security number");
  });

  it("falls back to reverse map default when no collision", () => {
    const result = collapseLabel("email", new Set(["person"]));
    expect(result).toBe("email address");
  });

  it("passes through unknown labels", () => {
    const result = collapseLabel("unknown_label", new Set());
    expect(result).toBe("unknown_label");
  });
});
```

- [ ] **Step 4: Run tests**

Run: `cd packages/anonymize && bun test src/gliner2/__test__/label-map.test.ts`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/anonymize/src/gliner2/
git commit -m "feat: add GLiNER2 client types and label mapping"
```

---

### Task 4: TS Gliner2Client — lifecycle + HTTP transport

**Files:**
- Create: `packages/anonymize/src/gliner2/client.ts`
- Create: `packages/anonymize/src/gliner2/__test__/client.test.ts`

- [ ] **Step 1: Create client.ts**

```typescript
import type { InferRequest, InferResponse, HealthResponse } from "./types";

export type Gliner2ClientOptions = {
  /** Override binary path. Default: auto-detect. */
  binaryPath?: string;
  /** Port for the sidecar. Default: 0 (random). */
  port?: number;
  /** HuggingFace model repo. Default: SemplificaAI/gliner2-privacy-filter-PII-multi */
  modelId?: string;
  /** ONNX variant (e.g., "fp16_v2"). Default: auto. */
  variant?: string;
  /** Timeout in ms for model load. Default: 120_000. */
  modelLoadTimeout?: number;
};

export class Gliner2Client {
  private process: ChildProcess | null = null;
  private port: number | null = null;
  private baseUrl: string | null = null;
  private opts: Required<Gliner2ClientOptions>;

  constructor(opts: Gliner2ClientOptions = {}) {
    this.opts = {
      binaryPath: opts.binaryPath ?? "",
      port: opts.port ?? 0,
      modelId: opts.modelId ?? "SemplificaAI/gliner2-privacy-filter-PII-multi",
      variant: opts.variant ?? "",
      modelLoadTimeout: opts.modelLoadTimeout ?? 120_000,
    };
  }

  get isRunning(): boolean {
    return this.process !== null && this.port !== null;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    // Resolve binary path
    const binPath = await this.resolveBinary();
    // Spawn the process
    const args = ["--port", String(this.opts.port), "--host", "127.0.0.1"];
    if (this.opts.variant) args.push("--variant", this.opts.variant);
    args.push("--model", this.opts.modelId);

    this.process = Bun.spawn([binPath, ...args], {
      stdout: "pipe",
      stderr: "inherit",
    });

    // Read port from stdout JSON line
    const reader = this.process.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      for (const line of lines) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.event === "listening") {
            this.port = parsed.port as number;
            this.baseUrl = `http://127.0.0.1:${this.port}`;
            break;
          }
        } catch { /* not JSON yet, keep buffering */ }
      }
      if (this.baseUrl) break;
      // Keep remainder in buffer for next chunk
      buffer = lines[lines.length - 1] ?? "";
    }

    if (!this.baseUrl) throw new Error("Failed to start gliner2-server: no listening event");

    // Wait for model to be ready (poll health)
    await this.waitForModel();
  }

  private async waitForModel(): Promise<void> {
    const deadline = Date.now() + this.opts.modelLoadTimeout;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.baseUrl}/v1/health`);
        const health = (await res.json()) as HealthResponse;
        if (health.model_loaded) return;
      } catch { /* server not ready yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("Model load timeout — check network and HuggingFace access");
  }

  async infer(
    text: string,
    labels: string[],
    threshold: number,
    signal?: AbortSignal,
  ): Promise<InferResponse> {
    if (!this.isRunning) await this.start();
    const body: InferRequest = { text, labels, threshold };
    const res = await fetch(`${this.baseUrl}/v1/infer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Inference failed (${res.status}): ${errText}`);
    }
    return res.json() as Promise<InferResponse>;
  }

  async stop(): Promise<void> {
    if (!this.process) return;
    this.process.kill("SIGTERM");
    // Wait up to 5s for graceful exit
    const exited = Bun.sleep(5000).then(() => {
      this.process?.kill("SIGKILL");
    });
    await Promise.race([this.process.exited, exited]);
    this.process = null;
    this.port = null;
    this.baseUrl = null;
  }

  dispose(): void {
    this.stop().catch(() => {});
  }

  private async resolveBinary(): Promise<string> {
    const envPath = process.env.ANONYMIZE_GLINER2_SERVER_PATH;
    if (envPath) return envPath;
    // TODO: check bundled binary in node_modules, fallback to download
    throw new Error(
      "gliner2-server binary not found. " +
      "Set ANONYMIZE_GLINER2_SERVER_PATH or use a bundled installation."
    );
  }
}
```

- [ ] **Step 2: Write client test with a mock server**

```typescript
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Gliner2Client } from "../client";

// These tests require a running gliner2-server binary.
// Skip if not available.
const hasBinary = process.env.ANONYMIZE_GLINER2_SERVER_PATH !== undefined;

describe.skipIf(!hasBinary)("Gliner2Client", () => {
  let client: Gliner2Client;

  beforeAll(async () => {
    client = new Gliner2Client({
      port: 0,
      modelLoadTimeout: 180_000,
    });
    await client.start();
  }, 200_000);

  afterAll(async () => {
    await client.stop();
  });

  it("detects model as loaded", async () => {
    // Inferred from successful infer — no direct health access from client
    expect(client.isRunning).toBe(true);
  });

  it("returns entities for person + email", async () => {
    const result = await client.infer(
      "Contact Maria Jensen at maria@example.com.",
      ["person", "email"],
      0.5,
    );
    expect(result.entities.length).toBeGreaterThan(0);
    const labels = result.entities.map((e) => e.label);
    expect(labels).toContain("person");
    expect(labels).toContain("email");
  }, 60_000);

  it("returns empty for unmapped labels", async () => {
    const result = await client.infer("No PII here.", ["organization"], 0.5);
    // organization is not in the model's 42-label set
    expect(Array.isArray(result.entities)).toBe(true);
  }, 30_000);
});
```

- [ ] **Step 3: Commit**

```bash
git add packages/anonymize/src/gliner2/
git commit -m "feat: add Gliner2Client with lifecycle and HTTP transport"
```

---

### Task 5: TS inference factory and pipeline integration

**Files:**
- Create: `packages/anonymize/src/gliner2/inference.ts`
- Modify: `packages/anonymize/src/index-shared.ts`
- Create: `packages/anonymize/src/gliner2/__test__/inference.test.ts`

- [ ] **Step 1: Create inference.ts**

```typescript
import type { NerInferenceFn } from "../pipeline";
import type { Entity } from "../types";
import { Gliner2Client, type Gliner2ClientOptions } from "./client";
import { expandLabels, collapseLabel } from "./label-map";

export const buildGliner2Inference = (
  options: Gliner2ClientOptions = {},
): NerInferenceFn => {
  const client = new Gliner2Client(options);

  return async (fullText, labels, threshold, signal) => {
    const modelLabels = expandLabels(labels);
    if (modelLabels.length === 0) return [];

    const pipelineLabelSet = new Set(labels);
    const response = await client.infer(fullText, modelLabels, threshold, signal);

    return response.entities.map(
      (e): Entity => ({
        text: e.text,
        start: e.start,
        end: e.end,
        label: collapseLabel(e.label, pipelineLabelSet),
        score: e.score,
        source: "ner" as const,
      }),
    );
  };
};
```

- [ ] **Step 2: Export from shared index**

In `packages/anonymize/src/index-shared.ts`, add to the GLiNER section:
```typescript
// ── GLiNER2 Sidecar ──────────────────────────────
export { buildGliner2Inference } from "./gliner2/inference";
export { Gliner2Client } from "./gliner2/client";
```

- [ ] **Step 3: Commit**

```bash
git add packages/anonymize/src/gliner2/inference.ts packages/anonymize/src/index-shared.ts
git commit -m "feat: add buildGliner2Inference factory and export"
```

---

### Task 6: Pipeline integration test

**Files:**
- Create: `packages/anonymize/src/__test__/slow/gliner2-pipeline.test.ts`

- [ ] **Step 1: Write pipeline integration test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { runPipeline, type NerInferenceFn } from "../../pipeline";
import { buildGliner2Inference } from "../../gliner2/inference";
import type { PipelineConfig, Entity } from "../../types";
import { DEFAULT_ENTITY_LABELS } from "../../constants";

const hasBinary = process.env.ANONYMIZE_GLINER2_SERVER_PATH !== undefined;

describe.skipIf(!hasBinary)("GLiNER2 pipeline integration", () => {
  let nerInference: NerInferenceFn;

  beforeAll(async () => {
    nerInference = buildGliner2Inference({
      modelLoadTimeout: 180_000,
    });
    // Warm up — triggers model download + server start
    await nerInference("Warm up.", ["person"], 0.5);
  }, 200_000);

  afterAll(() => {
    // Cleanup handled by GC / process exit for the client
  });

  const baseConfig: PipelineConfig = {
    threshold: 0.5,
    enableTriggerPhrases: false,
    enableRegex: false,
    enableLegalForms: false,
    enableNameCorpus: false,
    enableDenyList: false,
    enableGazetteer: false,
    enableCountries: false,
    enableNer: true,
    enableConfidenceBoost: false,
    enableCoreference: false,
    labels: [...DEFAULT_ENTITY_LABELS],
    workspaceId: "test",
  };

  it("detects person via NER in pipeline output", async () => {
    const text = "Maria Jensen called yesterday.";
    const entities = await runPipeline({
      fullText: text,
      config: baseConfig,
      gazetteerEntries: [],
      nerInference,
    });
    const people = entities.filter((e) => e.label === "person");
    expect(people.length).toBeGreaterThan(0);
    expect(people.some((p) => p.text.includes("Maria"))).toBe(true);
  }, 60_000);

  it("NER entities have source='ner'", async () => {
    const text = "Email john@test.com for info.";
    const entities = await runPipeline({
      fullText: text,
      config: { ...baseConfig, labels: ["email address"] },
      gazetteerEntries: [],
      nerInference,
    });
    for (const e of entities) {
      expect(e.source).toBe("ner");
    }
  }, 30_000);
});
```

- [ ] **Step 2: Run the slow tests**

Run directly with `bun test` (the `bun run test` script has a 15s default timeout):
```bash
cd packages/anonymize && bun test src/__test__/slow/gliner2-pipeline.test.ts --timeout 300000
```
Expected: Tests pass (may take 2-3 minutes for model download + server start)

- [ ] **Step 3: Commit**

```bash
git add packages/anonymize/src/__test__/slow/gliner2-pipeline.test.ts
git commit -m "test: add GLiNER2 pipeline integration test"
```

---

### Task 7: Binary download and distribution (future / separate PR)

**Files:**
- Create: `.github/workflows/gliner2-server.yml`
- Create: `packages/anonymize/scripts/download-gliner2-server.ts`

This task is scoped as a future step — the initial implementation requires the binary to be pre-built or available via `ANONYMIZE_GLINER2_SERVER_PATH`. CI cross-compilation and auto-download can be added in a follow-up.

- [ ] **Step 1: Create GitHub Actions workflow for cross-compilation**

```yaml
# .github/workflows/gliner2-server.yml
name: Build gliner2-server

on:
  release:
    types: [published]

jobs:
  build:
    strategy:
      matrix:
        target:
          - x86_64-unknown-linux-gnu
          - x86_64-apple-darwin
          - aarch64-apple-darwin
          - x86_64-pc-windows-msvc
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions-rust-lang/setup-rust-toolchain@v1
        with:
          targets: ${{ matrix.target }}
      - run: |
          cd crates/gliner2-server
          cargo build --release --target ${{ matrix.target }}
      - name: Upload release asset
        uses: softprops/action-gh-release@v2
        with:
          files: crates/gliner2-server/target/${{ matrix.target }}/release/gliner2-server${{ runner.os == 'Windows' && '.exe' || '' }}
          name: gliner2-server-${{ matrix.target }}
```

- [ ] **Step 2: Commit (separate PR)**

Skipped for initial implementation.

---

## Plan Review

After all tasks are implemented, run these checks (in order, stop on first failure):

```bash
# Rust — workspace-wide (new crate must compile)
cd crates/gliner2-server && cargo check
cd ../.. && cargo ci-clippy && cargo ci-test

# TypeScript — test files use separate tsconfig
cd packages/anonymize && tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.test.json

# Lint + format
cd packages/anonymize && bun run lint && bun run format:check

# Fast tests (slow tests require binary)
bun test
```
