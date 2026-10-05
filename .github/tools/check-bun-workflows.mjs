import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

const PACKAGE_MANAGER_RE = /^bun@[0-9]+\.[0-9]+\.[0-9]+$/;
const BUN_VERSION_ENV_RE = /^\s*BUN_VERSION\s*:/;
const BUN_VERSION_INPUT_RE = /^\s*bun-version\s*:/;
const BUN_VERSION_FILE_RE =
  /^\s*bun-version-file\s*:\s*["']?package\.json["']?\s*$/;
const SETUP_BUN_RE =
  /^(?:oven-sh\/setup-bun|stella\/\.github\/actions\/setup-bun-cached)@/;
const RAW_BUN_RE = /^oven-sh\/setup-bun@/;
const CACHED_BUN_RE = /^stella\/\.github\/actions\/setup-bun-cached@/;
const TURBO_CACHE_RE = /^rharkor\/caching-for-turbo@/;
const isConfigLine = (line) => !line.trimStart().startsWith("#");

export const bunWorkflowFiles = (root = ".") => {
  const workflows = join(root, ".github/workflows");
  const actions = join(root, ".github/actions");
  return [
    ...readdirSync(workflows)
      .filter((file) => /\.ya?ml$/.test(file))
      .map((file) => join(workflows, file)),
    ...(existsSync(actions)
      ? readdirSync(actions, { recursive: true })
          .filter((file) => /^action\.ya?ml$/.test(basename(file)))
          .map((file) => join(actions, file))
      : []),
  ].toSorted();
};

// Any next step ends the block, including an `if` or `run` step. Inputs from
// a later setup must never satisfy this setup's runtime or cache policy.
const stepBlocks = (lines) =>
  lines.flatMap((line, index) => {
    const start = /^(\s*)-\s+[\w-]+:/.exec(line);
    if (!start) return [];
    const indent = start[1].length;
    const end = lines.findIndex((candidate, next) => {
      const step = /^(\s*)-\s+[\w-]+:/.exec(candidate);
      return next > index && step && step[1].length <= indent;
    });
    return [lines.slice(index, end === -1 ? undefined : end)];
  });

export const bunPinProblems = (source) => {
  const lines = source.split("\n");
  const problems = [];
  for (const [index, line] of lines.entries()) {
    if (!isConfigLine(line)) continue;
    if (BUN_VERSION_ENV_RE.test(line)) {
      problems.push(`line ${index + 1} must not define BUN_VERSION`);
    }
    if (BUN_VERSION_INPUT_RE.test(line)) {
      problems.push(
        `line ${index + 1} must use bun-version-file: "package.json"`,
      );
    }
  }
  for (const block of stepBlocks(lines)) {
    const uses = block
      .filter(isConfigLine)
      .map((line) => /^\s*(?:-\s+)?uses:\s*([^\s#]+)/.exec(line)?.[1])
      .find((value) => value !== undefined);
    if (
      SETUP_BUN_RE.test(uses ?? "") &&
      !block.some((line) => BUN_VERSION_FILE_RE.test(line))
    ) {
      problems.push(`${uses} must use bun-version-file: "package.json"`);
    }
  }
  return problems;
};

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasPublishToken = (workflow, job) => {
  if (!isRecord(job)) return false;
  const permissions =
    job["permissions"] ??
    (isRecord(workflow) ? workflow["permissions"] : undefined);
  if (typeof permissions === "string") return permissions !== "read-all";
  return (
    isRecord(permissions) &&
    ["id-token", "contents", "packages"].some(
      (key) =>
        permissions[key] === "write" ||
        (typeof permissions[key] === "string" &&
          permissions[key].includes("$" + "{{")),
    )
  );
};

const hasArtifactStep = (job, operation) =>
  isRecord(job) &&
  Array.isArray(job["steps"]) &&
  job["steps"].some(
    (step) =>
      isRecord(step) &&
      typeof step["uses"] === "string" &&
      step["uses"].startsWith(`actions/${operation}-artifact@`),
  );

// Protect the full dependency chain of a publishing token. Artifact readers
// can consume uploads without a needs edge, so include those producers too.
const publishingJobNames = (workflow) => {
  if (!isRecord(workflow) || !isRecord(workflow["jobs"])) return new Set();
  const jobs = workflow["jobs"];
  const protectedJobs = new Set(
    Object.keys(jobs).filter((name) => hasPublishToken(workflow, jobs[name])),
  );
  const pending = [...protectedJobs];
  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined) continue;
    const job = jobs[name];
    if (!isRecord(job)) continue;
    const needs = job["needs"];
    const dependencies = Array.isArray(needs)
      ? needs.filter((dependency) => typeof dependency === "string")
      : [];
    if (typeof needs === "string") dependencies.push(needs);
    if (hasArtifactStep(job, "download")) {
      dependencies.push(
        ...Object.keys(jobs).filter((candidate) =>
          hasArtifactStep(jobs[candidate], "upload"),
        ),
      );
    }
    if (hasArtifactStep(job, "upload")) {
      dependencies.push(
        ...Object.keys(jobs).filter((candidate) =>
          hasArtifactStep(jobs[candidate], "download"),
        ),
      );
    }
    for (const dependency of dependencies) {
      if (protectedJobs.has(dependency)) continue;
      if (!isRecord(jobs[dependency])) continue;
      protectedJobs.add(dependency);
      pending.push(dependency);
    }
  }
  return protectedJobs;
};

export const bunCacheProblems = (workflow) => {
  if (!isRecord(workflow) || !isRecord(workflow.jobs))
    return ["Invalid workflow jobs"];
  const publishing = publishingJobNames(workflow);
  return Object.entries(workflow.jobs).flatMap(([name, job]) => {
    if (!isRecord(job)) return [`Invalid job ${name}`];
    if (typeof job.uses === "string") return [];
    if (!Array.isArray(job.steps) || !job.steps.every(isRecord))
      return [`Invalid steps in ${name}`];
    const noCache =
      publishing.has(name) ||
      job.steps.some(
        (step) =>
          SETUP_BUN_RE.test(step.uses ?? "") &&
          isRecord(step.with) &&
          step.with["no-cache"] === true,
      );
    return job.steps.flatMap((step) => {
      const uses = typeof step.uses === "string" ? step.uses : "";
      const inputs = isRecord(step.with) ? step.with : {};
      const problems = [];
      if (
        SETUP_BUN_RE.test(uses) &&
        inputs["bun-version-file"] !== "package.json"
      ) {
        problems.push(
          `${name}: ${uses} must use bun-version-file: "package.json"`,
        );
      }
      if (
        RAW_BUN_RE.test(uses) &&
        !publishing.has(name) &&
        inputs["no-cache"] !== true
      ) {
        problems.push(
          `${name}: raw setup needs the shared install-cache action or explicit no-cache: true`,
        );
      }
      if (
        noCache &&
        (CACHED_BUN_RE.test(uses) || /^actions\/cache(?:\/[^@]+)?@/.test(uses))
      ) {
        problems.push(`${name}: ${uses} is not eligible in a no-cache job`);
      }
      if (TURBO_CACHE_RE.test(uses) && inputs["server-port"] !== "0") {
        problems.push(`${name}: ${uses} must set server-port: "0"`);
      }
      return problems;
    });
  });
};

const cacheDocumentProblems = (source) => {
  const document = globalThis.Bun.YAML.parse(source);
  if (isRecord(document) && isRecord(document.runs)) {
    return document.runs.using === "composite"
      ? bunCacheProblems({
          jobs: { composite: { steps: document.runs.steps } },
        })
      : [];
  }
  return bunCacheProblems(document);
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const mode = process.argv[2] ?? "pin";
  const packageManager = JSON.parse(
    readFileSync("package.json", "utf8"),
  ).packageManager;
  const problems = PACKAGE_MANAGER_RE.test(packageManager)
    ? []
    : [
        `package.json packageManager must pin Bun as bun@x.y.z; got ${String(packageManager)}`,
      ];
  if (mode !== "pin" && mode !== "--cache-policy")
    problems.push(`Unknown check mode: ${mode}`);
  if (mode === "--cache-policy" && !globalThis.Bun)
    problems.push("Cache policy requires the installed Bun runtime");
  if (problems.length === 0) {
    for (const file of bunWorkflowFiles()) {
      const source = readFileSync(file, "utf8");
      const findings =
        mode === "--cache-policy"
          ? cacheDocumentProblems(source)
          : bunPinProblems(source);
      problems.push(...findings.map((problem) => `${file}: ${problem}`));
    }
  }
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exit(1);
}
