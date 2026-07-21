import { createPiiShieldAdapter } from "../blind/pii-shield";
import { createPythonAdapter } from "./python";
import { createRedactPiiAdapter } from "./redact-pii";
import { createStllAdapter } from "./stella";
import type { Adapter } from "./types";

export const createBenchmarkAdapters = (): Adapter[] => [
  createStllAdapter(),
  createPythonAdapter({
    name: "presidio",
    venvDir: ".venv-presidio",
    script: "presidio_adapter.py",
  }),
  createPythonAdapter({
    name: "scrubadub",
    venvDir: ".venv-scrubadub",
    script: "scrubadub_adapter.py",
  }),
  createRedactPiiAdapter(),
  createPiiShieldAdapter(),
];
