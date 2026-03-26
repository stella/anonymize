#!/usr/bin/env bun
import { watch } from "fs";
import {
  runPipeline,
  redactText,
  DEFAULT_ENTITY_LABELS,
  DEFAULT_OPERATOR_CONFIG,
  createPipelineContext,
} from "./packages/anonymize/src/index";
import type {
  Entity,
  PipelineConfig,
} from "./packages/anonymize/src/types";

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

const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");

const CONFIG: PipelineConfig = {
  threshold: 0.3,
  enableTriggerPhrases: true,
  enableRegex: true,
  enableNameCorpus: true,
  enableDenyList: true,
  denyListCountries: ["CZ", "SK", "DE"],
  enableGazetteer: false,
  enableNer: false,
  enableConfidenceBoost: false,
  enableCoreference: true,
  enableZoneClassification: true,
  enableHotwordRules: true,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "eval",
};

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

const dedup = (entities: Entity[]): Entity[] => {
  const used: Entity[] = [];
  for (const e of entities) {
    if (!used.some((u) => e.start < u.end && e.end > u.start))
      used.push(e);
  }
  return used;
};

type HighlightResult = {
  html: string;
  spanIdByEntityIdx: Map<number, number>;
};

const highlight = (
  text: string,
  entities: Entity[],
  docIdx: number,
): HighlightResult => {
  const sorted = dedup(
    entities.toSorted((a, b) => a.start - b.start),
  );
  // Build a lookup: for each entity index in the
  // original array, what span index did it get?
  const spanIdByEntityIdx = new Map<number, number>();
  for (let si = 0; si < sorted.length; si++) {
    const s = sorted[si];
    if (!s) continue;
    const origIdx = entities.indexOf(s);
    if (origIdx !== -1) spanIdByEntityIdx.set(origIdx, si);
  }

  let result = "";
  let pos = 0;
  for (let si = 0; si < sorted.length; si++) {
    const e = sorted[si];
    if (!e) continue;
    if (e.start > pos) result += esc(text.slice(pos, e.start));
    const color = COLORS[e.label] ?? "#dfe6e9";
    result +=
      `<span class="entity" id="e${docIdx}-${si}" ` +
      `style="background:${color}22;` +
      `border-bottom:2px solid ${color}" ` +
      `title="${esc(e.label)} (${e.score.toFixed(2)}, ` +
      `${e.source})">${esc(e.text)}</span>`;
    pos = e.end;
  }
  if (pos < text.length) result += esc(text.slice(pos));
  return { html: result, spanIdByEntityIdx };
};

type DocResult = {
  name: string;
  text: string;
  entities: Entity[];
  redactedText: string;
};

const buildHtml = (docs: DocResult[]): string => {
  const totalEntities = docs.reduce(
    (s, d) => s + d.entities.length,
    0,
  );
  const tabs = docs
    .map(
      (d, i) =>
        `<button class="tab${i === 0 ? " active" : ""}" ` +
        `onclick="showTab(${i})">${esc(d.name)}</button>`,
    )
    .join("");
  const panels = docs
    .map((d, i) => {
      const { html, spanIdByEntityIdx } = highlight(
        d.text,
        d.entities,
        i,
      );
      const rows = d.entities
        .map((e, j) => {
          const spanId = spanIdByEntityIdx.get(j);
          const onclick =
            spanId !== undefined
              ? ` class="clickable" onclick="scrollToEntity('e${i}-${spanId}')"`
              : "";
          return (
            `<tr${onclick}><td>${j + 1}</td>` +
            `<td style="color:${COLORS[e.label] ?? "#9a9cb8"}">` +
            `${esc(e.label)}</td>` +
            `<td>${esc(e.text)}</td>` +
            `<td>${e.source}</td>` +
            `<td>${e.score.toFixed(2)}</td></tr>`
          );
        })
        .join("");
      return (
        `<div class="panel${i === 0 ? " active" : ""}" ` +
        `id="p${i}">` +
        `<div class="split">` +
        `<div class="pane"><h3>Original</h3>` +
        `<div class="content">` +
        `${html}</div></div>` +
        `<div class="pane"><h3>Redacted</h3>` +
        `<div class="content">` +
        `${esc(d.redactedText)}</div></div></div>` +
        `<h3>Entities (${d.entities.length})</h3>` +
        `<table><tr><th>#</th><th>Label</th>` +
        `<th>Text</th><th>Source</th><th>Score</th></tr>` +
        `${rows}</table></div>`
      );
    })
    .join("");

  return (
    `<!DOCTYPE html><html><head>` +
    `<meta charset="utf-8"><title>Eval</title>` +
    `<style>` +
    `:root{--bg:#1a1b2e;--surface:#232438;` +
    `--surface2:#2a2b40;--border:#363752;` +
    `--text:#e2e4f0;--text2:#9a9cb8;--accent:#6c63ff}` +
    `body{font-family:system-ui,sans-serif;margin:0;` +
    `padding:16px;background:var(--bg);color:var(--text)}` +
    `h2{color:var(--text);font-weight:600;margin:0 0 16px}` +
    `h3{margin:8px 0;font-size:14px;color:var(--text2)}` +
    `.tabs{display:flex;gap:4px;flex-wrap:wrap;` +
    `margin-bottom:12px}` +
    `.tab{padding:6px 14px;border:1px solid var(--border);` +
    `background:var(--surface);color:var(--text2);` +
    `cursor:pointer;border-radius:6px 6px 0 0;` +
    `font-size:12px;transition:all .15s}` +
    `.tab:hover{background:var(--surface2);` +
    `color:var(--text)}` +
    `.tab.active{background:var(--accent);color:#fff;` +
    `border-color:var(--accent)}` +
    `.panel{display:none}.panel.active{display:block}` +
    `.split{display:grid;grid-template-columns:1fr 1fr;` +
    `gap:12px;margin-bottom:16px}` +
    `.pane{background:var(--surface);padding:14px;` +
    `border-radius:8px;border:1px solid var(--border)}` +
    `.content{font-size:13px;line-height:1.7;` +
    `white-space:pre-wrap;word-break:break-word;` +
    `color:var(--text)}` +
    `.entity{padding:1px 3px;border-radius:3px;` +
    `cursor:help;transition:opacity .15s}` +
    `.entity:hover{opacity:.8}` +
    `table{width:100%;border-collapse:collapse;` +
    `font-size:12px;background:var(--surface);` +
    `border-radius:8px;overflow:hidden}` +
    `th,td{padding:6px 10px;border:1px solid ` +
    `var(--border);text-align:left}` +
    `th{background:var(--surface2);color:var(--text2);` +
    `font-weight:500}` +
    `td{color:var(--text)}` +
    `tr:hover td{background:var(--surface2)}` +
    `tr.clickable{cursor:pointer}` +
    `tr.clickable:hover td{background:var(--accent)22}` +
    `.entity.flash{outline:2px solid #fff;` +
    `outline-offset:1px;animation:flash .8s ease-out}` +
    `@keyframes flash{0%{outline-color:#fff}` +
    `100%{outline-color:transparent}}` +
    `</style></head><body>` +
    `<h2>Eval — ${docs.length} docs, ` +
    `${totalEntities} entities</h2>` +
    `<div class="tabs">${tabs}</div>${panels}` +
    `<script>function showTab(i){` +
    `document.querySelectorAll('.tab')` +
    `.forEach((t,j)=>t.classList.toggle('active',j===i));` +
    `document.querySelectorAll('.panel')` +
    `.forEach((p,j)=>p.classList.toggle('active',j===i))` +
    `}function scrollToEntity(id){` +
    `var el=document.getElementById(id);` +
    `if(!el)return;` +
    `el.scrollIntoView({behavior:'smooth',block:'center'});` +
    `el.classList.remove('flash');` +
    `void el.offsetWidth;` +
    `el.classList.add('flash')` +
    `}</script></body></html>`
  );
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
  const total = docs.reduce(
    (s, d) => s + d.entities.length,
    0,
  );
  console.log(
    `${docs.length} docs, ${total} entities ` +
      `(${ms}ms) → ${outputPath}`,
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
