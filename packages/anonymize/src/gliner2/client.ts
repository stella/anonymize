import type { InferRequest, InferResponse, HealthResponse } from "./types";

export type Gliner2ClientOptions = {
  binaryPath?: string;
  port?: number;
  modelId?: string;
  variant?: string;
  modelLoadTimeout?: number;
};

export class Gliner2Client {
  private process: Bun.Process | null = null;
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

    const binPath = await this.resolveBinary();
    const args = ["--port", String(this.opts.port), "--host", "127.0.0.1"];
    if (this.opts.variant) args.push("--variant", this.opts.variant);
    args.push("--model", this.opts.modelId);

    this.process = Bun.spawn([binPath, ...args], {
      stdout: "pipe",
      stderr: "inherit",
    });

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
        } catch {
          continue;
        }
      }

      if (this.baseUrl) break;
      buffer = lines[lines.length - 1] ?? "";
    }

    if (!this.baseUrl) {
      throw new Error("Failed to start gliner2-server: no listening event");
    }

    await this.waitForModel();
  }

  private async waitForModel(): Promise<void> {
    const deadline = Date.now() + this.opts.modelLoadTimeout;

    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.baseUrl}/v1/health`);
        const health = (await res.json()) as HealthResponse;
        if (health.model_loaded) return;
      } catch {
        // Server not ready yet
      }
      await Bun.sleep(500);
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

    throw new Error(
      "gliner2-server binary not found. " +
        "Set ANONYMIZE_GLINER2_SERVER_PATH or use a bundled installation.",
    );
  }
}