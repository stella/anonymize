#!/usr/bin/env bun
import { watch } from "fs";
import {
  runPipeline,
  redactText,
  DEFAULT_ENTITY_LABELS,
  DEFAULT_OPERATOR_CONFIG,
  createPipelineContext,
} from "./packages/anonymize/src/index";
import type { Entity, PipelineConfig } from "./packages/anonymize/src/types";

// ── Constants ───────────────────────────────────

const CONTEXT_CHARS = 60;

const COLORS: Record<string, string> = {
  person: "#ff6b6b",
  organization: "#4ecdc4",
  address: "#45b7d1",
  date: "#f9ca24",
  "date of birth": "#f9ca24",
  "czech birth number": "#e056fd",
  "registration number": "#686de0",
  "tax identification number": "#686de0",
  "bank account number": "#22a6b3",
  iban: "#22a6b3",
  "email address": "#6ab04c",
  "phone number": "#7ed6df",
  "monetary amount": "#f0932b",
  url: "#95afc0",
};

const CONFIG: PipelineConfig = {
  threshold: 0.3,
  enableTriggerPhrases: true,
  enableRegex: true,
  enableNameCorpus: true,
  enableDenyList: true,
  denyListCountries: ["CZ", "SK", "DE", "US", "GB", "FR", "AT", "CH"],
  enableGazetteer: false,
  enableNer: false,
  enableConfidenceBoost: false,
  enableCoreference: true,
  enableZoneClassification: true,
  enableHotwordRules: true,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "eval",
};

// ── Helpers ─────────────────────────────────────

const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");

const escAttr = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, " ");

const dedup = (entities: Entity[]): Entity[] => {
  const used: Entity[] = [];
  for (const e of entities) {
    if (!used.some((u) => e.start < u.end && e.end > u.start)) used.push(e);
  }
  return used;
};

/** Extract a context snippet around an entity. */
const contextSnippet = (fullText: string, entity: Entity): string => {
  const before = fullText
    .slice(Math.max(0, entity.start - CONTEXT_CHARS), entity.start)
    .replace(/\n/g, " ");
  const after = fullText
    .slice(entity.end, entity.end + CONTEXT_CHARS)
    .replace(/\n/g, " ");
  const prefix = entity.start > CONTEXT_CHARS ? "…" : "";
  const suffix = entity.end + CONTEXT_CHARS < fullText.length ? "…" : "";
  return `${prefix}${before}███${after}${suffix}`;
};

// ── Pipeline ────────────────────────────────────

const processDoc = async (path: string) => {
  const ctx = createPipelineContext();
  const text = await Bun.file(path).text();
  const name = path.split("/").pop() ?? path;
  const entities = await runPipeline({
    fullText: text,
    config: CONFIG,
    gazetteerEntries: [],
    context: ctx,
  });
  entities.sort((a, b) => a.start - b.start);
  const { redactedText } = redactText(
    text,
    entities,
    DEFAULT_OPERATOR_CONFIG,
    ctx,
  );
  return { name, text, entities, redactedText };
};

// ── Highlight ───────────────────────────────────

const highlight = (text: string, entities: Entity[]): string => {
  const sorted = dedup(entities.toSorted((a, b) => a.start - b.start));
  let result = "";
  let pos = 0;
  for (const e of sorted) {
    if (e.start > pos) result += esc(text.slice(pos, e.start));
    const color = COLORS[e.label] ?? "#dfe6e9";
    result +=
      `<span class="entity" ` +
      `style="background:${color}22;` +
      `border-bottom:2px solid ${color}" ` +
      `title="${escAttr(e.label)} ` +
      `(${e.score.toFixed(2)}, ${e.source})">` +
      `${esc(e.text)}</span>`;
    pos = e.end;
  }
  if (pos < text.length) result += esc(text.slice(pos));
  return result;
};

// ── Entity table rows ───────────────────────────

const buildEntityRows = (entities: Entity[], fullText: string): string =>
  entities
    .map((e, j) => {
      const color = COLORS[e.label] ?? "#9a9cb8";
      const ctx = escAttr(contextSnippet(fullText, e));
      const tag = e.label.replace(/\s+/g, "-");
      return [
        `<tr class="entity-row" data-ctx="${ctx}" data-label="${tag}">`,
        `<td>${j + 1}</td>`,
        `<td style="color:${color}">${esc(e.label)}</td>`,
        `<td>${esc(e.text)}</td>`,
        `<td>${e.source}</td>`,
        `<td>${e.score.toFixed(2)}</td>`,
        `</tr>`,
      ].join("");
    })
    .join("");

// ── HTML template ───────────────────────────────

type DocResult = {
  name: string;
  text: string;
  entities: Entity[];
  redactedText: string;
};

const CSS = `
:root {
  --bg: #1a1b2e; --surface: #232438; --surface2: #2a2b40;
  --border: #363752; --text: #e2e4f0; --text2: #9a9cb8;
  --accent: #6c63ff;
}
body {
  font-family: system-ui, sans-serif;
  margin: 0; padding: 16px;
  background: var(--bg); color: var(--text);
}
h2 { color: var(--text); font-weight: 600; margin: 0 0 16px; }
h3 { margin: 8px 0; font-size: 14px; color: var(--text2); }
.tabs {
  display: flex; gap: 4px; flex-wrap: wrap;
  margin-bottom: 12px;
}
.tab {
  padding: 6px 14px; border: 1px solid var(--border);
  background: var(--surface); color: var(--text2);
  cursor: pointer; border-radius: 6px 6px 0 0;
  font-size: 12px; transition: all .15s;
}
.tab:hover { background: var(--surface2); color: var(--text); }
.tab.active {
  background: var(--accent); color: #fff;
  border-color: var(--accent);
}
.panel { display: none; }
.panel.active { display: block; }
.split {
  display: grid; grid-template-columns: 1fr 1fr;
  gap: 12px; margin-bottom: 16px;
}
.pane {
  background: var(--surface); padding: 14px;
  border-radius: 8px; border: 1px solid var(--border);
}
.content {
  font-size: 13px; line-height: 1.7;
  white-space: pre-wrap; word-break: break-word;
  color: var(--text);
}
.entity {
  padding: 1px 3px; border-radius: 3px;
  cursor: help; transition: opacity .15s;
}
.entity:hover { opacity: .8; }
table {
  width: 100%; border-collapse: collapse;
  font-size: 12px; background: var(--surface);
  border-radius: 8px; overflow: hidden;
}
th, td {
  padding: 6px 10px; border: 1px solid var(--border);
  text-align: left;
}
th {
  background: var(--surface2); color: var(--text2);
  font-weight: 500;
}
td { color: var(--text); }
tr.entity-row { cursor: pointer; }
tr.entity-row:hover td { background: var(--surface2); }
tr.ctx-row td {
  padding: 4px 10px; font-size: 11px;
  color: var(--text2); background: var(--bg);
  font-family: monospace; white-space: pre-wrap;
  border-top: none;
}
tr.ctx-row td mark {
  background: #f0932b44; color: var(--text);
  padding: 0 2px; border-radius: 2px;
}
`.trim();

const JS = `
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function showTab(i) {
  document.querySelectorAll('.tab')
    .forEach((t, j) => t.classList.toggle('active', j === i));
  document.querySelectorAll('.panel')
    .forEach((p, j) => p.classList.toggle('active', j === i));
}
document.addEventListener('click', function(e) {
  var row = e.target.closest('tr.entity-row');
  if (!row) return;
  var next = row.nextElementSibling;
  if (next && next.classList.contains('ctx-row')) {
    next.remove();
    return;
  }
  // Remove any other open ctx rows in this table
  row.closest('table')
    .querySelectorAll('tr.ctx-row')
    .forEach(function(r) { r.remove(); });
  var ctx = row.getAttribute('data-ctx');
  if (!ctx) return;
  // Replace ███ marker with <label>entity text</label>
  var entityText = row.querySelectorAll('td')[2].textContent;
  var label = row.getAttribute('data-label') || 'entity';
  var tag = label.replace(/\\s+/g, '-');
  var escapedEntityText = escapeHtml(entityText || '');
  var display = ctx.replace('███',
    '<mark>&lt;' + tag + '&gt;' + escapedEntityText +
    '&lt;/' + tag + '&gt;</mark>');
  var tr = document.createElement('tr');
  tr.className = 'ctx-row';
  tr.innerHTML = '<td colspan="5">' + display + '</td>';
  row.after(tr);
});
`.trim();

const buildHtml = (docs: DocResult[]): string => {
  const totalEntities = docs.reduce((s, d) => s + d.entities.length, 0);

  const tabs = docs
    .map(
      (d, i) =>
        `<button class="tab${i === 0 ? " active" : ""}" ` +
        `onclick="showTab(${i})">${esc(d.name)}</button>`,
    )
    .join("");

  const panels = docs
    .map((d, i) => {
      const highlighted = highlight(d.text, d.entities);
      const rows = buildEntityRows(d.entities, d.text);
      return [
        `<div class="panel${i === 0 ? " active" : ""}" id="p${i}">`,
        `<div class="split">`,
        `<div class="pane"><h3>Original</h3>`,
        `<div class="content">${highlighted}</div></div>`,
        `<div class="pane"><h3>Redacted</h3>`,
        `<div class="content">${esc(d.redactedText)}</div></div>`,
        `</div>`,
        `<h3>Entities (${d.entities.length})</h3>`,
        `<table>`,
        `<tr><th>#</th><th>Label</th>`,
        `<th>Text</th><th>Source</th><th>Score</th></tr>`,
        rows,
        `</table></div>`,
      ].join("\n");
    })
    .join("\n");

  return [
    `<!DOCTYPE html>`,
    `<html><head>`,
    `<meta charset="utf-8">`,
    `<title>Eval — ${docs.length} docs</title>`,
    `<style>${CSS}</style>`,
    `</head><body>`,
    `<h2>Eval — ${docs.length} docs, ${totalEntities} entities</h2>`,
    `<div class="tabs">${tabs}</div>`,
    panels,
    `<script>${JS}</script>`,
    `</body></html>`,
  ].join("\n");
};

// ── CLI ─────────────────────────────────────────

const args = process.argv.slice(2);
let outputPath = "/tmp/eval-report.html";
let watchMode = false;
const inputs: string[] = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--output" && args[i + 1]) {
    outputPath = args[i + 1]!;
    i++;
  } else if (arg === "--watch" || arg === "-w") {
    watchMode = true;
  } else {
    inputs.push(arg!);
  }
}

if (inputs.length === 0) {
  console.error(
    "Usage: bun eval-html.ts [--watch] " +
      "<input.txt> [...] [--output out.html]",
  );
  process.exit(1);
}

const run = async () => {
  const start = performance.now();
  const docs = await Promise.all(inputs.map(processDoc));
  await Bun.write(outputPath, buildHtml(docs));
  const ms = (performance.now() - start).toFixed(0);
  const total = docs.reduce((s, d) => s + d.entities.length, 0);
  console.log(
    `${docs.length} docs, ${total} entities ` + `(${ms}ms) → ${outputPath}`,
  );
};

await run();

if (watchMode) {
  let debounce: ReturnType<typeof setTimeout> | null = null;
  console.log(`Watching ${inputs.length} file(s)...`);

  for (const path of inputs) {
    watch(path, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(async () => {
        debounce = null;
        console.log(`\nFile changed: ${path}`);
        await run();
      }, 300);
    });
  }
}
