#!/usr/bin/env node
/**
 * dashboard.mjs — compare Kiro models side by side in one HTML page.
 *
 *   node dashboard.mjs [--run] [--models a,b] [--turns N] [--warmup N] [--out path] [--no-open]
 *
 *   --run      first run acp-bench.mjs once per model (one after the other),
 *              then show only the rows that run just wrote.
 *   (no --run) show the latest N turns per model from the stats store.
 *
 * Defaults: every Claude model Kiro offers at 4.6 and above —
 *   Opus 4.6/4.7/4.8/5/5.5, Sonnet 5/5.5, Haiku 5.5 — 3 turns, 1 warm-up.
 * (Find Kiro's current IDs with: node acp-bench.mjs --list-models.)
 * Output: one self-contained HTML file (one tiny script that shows times in
 * the local time zone; no network), also printed
 * as a plain text table. The page opens in your browser unless --no-open.
 *
 * Where the HTML goes by default: <repo>/dashboard.html when this script runs
 * from a git checkout, otherwise next to the stats store
 * (~/.cache/llm-speed-bench/dashboard.html, e.g. from ~/.kiro/kirobench).
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { median, readStats, fmtMs, fmtTps, fmtTokens, fmtCost, STORE_DIR } from "./speed-core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DEFAULT_OUT = join(existsSync(join(ROOT, ".git")) ? ROOT : STORE_DIR, "dashboard.html");

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const has = (name) => args.includes("--" + name);
const models = opt("models", "claude-opus-4.6,claude-opus-4.7,claude-opus-4.8,claude-opus-5,claude-opus-5.5,claude-sonnet-5,claude-sonnet-5.5,claude-haiku-5.5").split(",").map((m) => m.trim()).filter(Boolean);
const turns = Math.max(1, parseInt(opt("turns", "3"), 10) || 3);
const warmup = Math.max(0, parseInt(opt("warmup", "1"), 10) || 0);
const out = resolve(opt("out", DEFAULT_OUT));
if (!models.length) { console.error("error: --models is empty"); process.exit(1); }

// 1. Optionally run the benchmark, one model at a time.
const batchStart = Date.now();
if (has("run")) {
  for (const model of models) {
    console.log(`\n=== ${model}: ${warmup} warm-up + ${turns} measured turns ===`);
    const r = spawnSync(process.execPath, [join(HERE, "acp-bench.mjs"), "--model", model, "--turns", String(turns), "--warmup", String(warmup)], { stdio: "inherit" });
    if (r.status !== 0) console.error(`warning: run for ${model} failed (exit ${r.status}); its rows may be missing`);
  }
}

// 2. Pick the rows: this run's rows, or the latest N per model.
const all = readStats(2000).filter((s) => s.agent === "kiro-acp");
const rowsOf = (model) => {
  const mine = all.filter((s) => s.model === model);
  return (has("run") ? mine.filter((s) => s.ts >= batchStart) : mine.slice(-turns)).sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
};
const sum = (rows, key) => rows.reduce((t, s) => t + (Number(s[key]) || 0), 0);
const summary = models.map((model) => {
  const rows = rowsOf(model);
  const ttfts = rows.map((s) => s.ttftMs);
  const overalls = rows.map((s) => Number(s.overallTps)).filter((v) => Number.isFinite(v) && v > 0);
  return {
    model,
    turns: rows.length,
    ttftMedian: median(ttfts),
    ttftMin: ttfts.length ? Math.min(...ttfts) : 0,
    ttftMax: ttfts.length ? Math.max(...ttfts) : 0,
    overallMedian: median(rows.map((s) => s.overallTps)),
    overallMin: overalls.length ? Math.min(...overalls) : 0,
    overallMax: overalls.length ? Math.max(...overalls) : 0,
    tokens: sum(rows, "outputTokens"),
    credits: sum(rows, "credits"),
    costUsd: sum(rows, "costUsd"),
    lastTs: rows.length ? Math.max(...rows.map((s) => Number(s.ts) || 0)) : 0,
    rows: rows.map((s, i) => ({ turn: i + 1, ts: Number(s.ts) || 0, ttftMs: s.ttftMs, totalMs: s.totalMs, overallTps: s.overallTps, credits: Number(s.credits) || 0 })),
  };
});

// 3. Best value per speed column (only when at least two models have data).
const withData = summary.filter((s) => s.turns > 0);
const best = {};
if (withData.length > 1) {
  best.ttft = Math.min(...withData.map((s) => s.ttftMedian).filter((v) => v > 0));
  best.overall = Math.max(...withData.map((s) => s.overallMedian));
}

// 4. Text table for the terminal.
const range = (s) => (s.ttftMax ? `${fmtMs(s.ttftMin)}–${fmtMs(s.ttftMax)}` : "—");
const tpsRange = (s) => (s.overallMax ? `${fmtTps(s.overallMin)}–${fmtTps(s.overallMax)}` : "—");
const cols = ["Model", "Turns", "TTFT med", "TTFT min–max", "tok/s", "tok/s min–max", "Out tok", "Credits", "Cost"];
const textRows = summary.map((s) => s.turns
  ? [s.model, s.turns, s.ttftMedian ? fmtMs(s.ttftMedian) : "—", range(s), fmtTps(s.overallMedian), tpsRange(s), fmtTokens(s.tokens), s.credits.toFixed(3), fmtCost(s.costUsd)]
  : [s.model, 0, "no data", "", "", "", "", "", ""]);
const widths = cols.map((c, i) => Math.max(c.length, ...textRows.map((r) => String(r[i]).length)));
const line = (r) => r.map((v, i) => (i ? String(v).padStart(widths[i]) : String(v).padEnd(widths[i]))).join("  ");
console.log("\nKiro CLI speed — model comparison (medians)\n" + [line(cols), ...textRows.map(line)].join("\n"));

// 5. HTML. Every model string goes through esc(). The only script is a fixed
// one that sets textContent on cells carrying a numeric data-ts.
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const generated = new Date();
const cell = (text, isBest) => `<td${isBest ? ' class="best"' : ""}>${esc(text)}</td>`;
const mainRows = summary.map((s) => s.turns
  ? `<tr><th scope="row">${esc(s.model)}</th><td>${s.turns}</td>${cell(s.ttftMedian ? fmtMs(s.ttftMedian) : "—", s.ttftMedian && s.ttftMedian === best.ttft)}<td>${esc(range(s))}</td>${cell(fmtTps(s.overallMedian), s.overallMedian && s.overallMedian === best.overall)}<td>${esc(tpsRange(s))}</td><td>${esc(fmtTokens(s.tokens))}</td><td>${s.credits.toFixed(3)}</td><td>${esc(fmtCost(s.costUsd))}</td><td data-ts="${s.lastTs}">—</td></tr>`
  : `<tr><th scope="row">${esc(s.model)}</th><td colspan="9" class="nodata">no data</td></tr>`).join("\n");
const turnRows = summary.flatMap((s) => s.rows.map((r) =>
  `<tr><td class="ts" data-ts="${r.ts}">—</td><th scope="row">${esc(s.model)}</th><td>${r.turn}</td><td>${esc(fmtMs(r.ttftMs))}</td><td>${esc(fmtMs(r.totalMs))}</td><td>${esc(fmtTps(r.overallTps))}</td><td>${r.credits.toFixed(3)}</td></tr>`)).join("\n");
// "<" is written as \u003c so no model name can close the script tag.
const dataJson = JSON.stringify({ generated: generated.toISOString(), summary }).replaceAll("<", "\\u003c");

// Charts: inline SVG built here, no script. One bar per model = median; one dot
// per measured turn. The axis starts at 0. Model names go through esc().
const CW = 360, CX0 = 8, CX1 = 292, ROW = 62, CTOP = 6;
const short = (name, n = 22) => (name.length > n ? name.slice(0, n - 1) + "…" : name);
function niceScale(maxVal, floor) {
  const m = Math.max(Number.isFinite(maxVal) ? maxVal : 0, floor);
  const rough = m / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((v) => v >= rough) || mag * 10;
  return { step, max: Math.ceil(m / step - 1e-9) * step };
}
function barChart({ id, heading, values, med, floor, tickFmt, fmt, isBest }) {
  const items = summary.map((s, i) => ({ s, i, m: med(s), v: values(s).filter((x) => Number.isFinite(x) && x > 0) }));
  const { step, max } = niceScale(Math.max(0, ...items.flatMap((it) => [it.m, ...it.v]).filter(Number.isFinite)), floor);
  const px = (v) => CX0 + (Math.max(0, v) / max) * (CX1 - CX0);
  const bottom = CTOP + items.length * ROW;
  const H = bottom + 28;
  let g = "";
  const nTicks = Math.max(1, Math.round(max / step));
  for (let t = 0; t <= nTicks; t++) {
    const x = px(t * step).toFixed(2);
    g += `<line class="grid${t ? "" : " axis"}" x1="${x}" x2="${x}" y1="${CTOP}" y2="${bottom}"/><text class="tick" x="${x}" y="${bottom + 20}" text-anchor="middle">${esc(tickFmt(t * step))}</text>`;
  }
  items.forEach((it, k) => {
    const y = CTOP + k * ROW;
    const has = it.m > 0;
    const best = has && isBest(it.s);
    const cls = "m" + (it.i % 10);
    g += `<rect class="${cls}" x="${CX0}" y="${y + 6}" width="12" height="12" rx="2"/>`
      + `<text class="name" x="${CX0 + 18}" y="${y + 18}">${esc(short(it.s.model))}</text>`
      + (best ? `<text class="tag" x="${CW - 8}" y="${y + 18}" text-anchor="end">fastest</text>` : "")
      + `<rect class="track" x="${CX0}" y="${y + 26}" width="${CX1 - CX0}" height="24" rx="4"/>`;
    if (!has) { g += `<text class="faint" x="${CX0 + 8}" y="${y + 43}">no data</text>`; return; }
    const w = Math.max(2, px(it.m) - CX0).toFixed(2);
    g += `<rect class="bar ${cls}${best ? " best" : ""}" x="${CX0}" y="${y + 26}" width="${w}" height="24" rx="4"><title>${esc(it.s.model)} median ${esc(fmt(it.m))}</title></rect>`
      + `<text class="val" x="${CX1 + 6}" y="${y + 43}">${esc(fmt(it.m))}</text>`
      + it.v.map((v, j) => `<circle class="dot" cx="${px(v).toFixed(2)}" cy="${y + 38}" r="5"><title>Turn ${j + 1}: ${esc(fmt(v))}</title></circle>`).join("");
  });
  const desc = items.map((it) => `${it.s.model}: ${it.m > 0 ? `median ${fmt(it.m)}, turns ${it.v.map(fmt).join(", ")}` : "no data"}`).join("; ");
  return `<svg class="chart" viewBox="0 0 ${CW} ${H}" role="img" aria-labelledby="${id}-t ${id}-d"><title id="${id}-t">${esc(heading)}</title><desc id="${id}-d">${esc(desc)}</desc>${g}</svg>`;
}
const ttftChart = barChart({
  id: "c-ttft", heading: "TTFT (lower is better)",
  values: (s) => s.rows.map((r) => r.ttftMs / 1000), med: (s) => s.ttftMedian / 1000, floor: 1,
  tickFmt: (v) => +v.toFixed(2) + "s", fmt: (v) => fmtMs(v * 1000), isBest: (s) => s.ttftMedian === best.ttft,
});
const tpsChart = barChart({
  id: "c-tps", heading: "tok/s (higher is better)",
  values: (s) => s.rows.map((r) => Number(r.overallTps)), med: (s) => s.overallMedian, floor: 1,
  tickFmt: (v) => String(+v.toFixed(2)), fmt: fmtTps, isBest: (s) => s.overallMedian === best.overall,
});
const turnsLine = summary.map((s) => `${esc(s.model)} ${s.turns}`).join(", ");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kiro CLI speed — model comparison</title>
<style>
:root { color-scheme: light dark; --bg: #fff; --fg: #1a1a1a; --muted: #555; --line: #d0d0d0; --head: #f0f0f0; --best: #d9f2de; --c0: #1d4ed8; --c1: #c2410c; --c2: #047857; --c3: #7e22ce; --c4: #be123c; --c5: #0e7490; --c6: #4d7c0f; --c7: #b45309; --c8: #0f766e; --c9: #a21caf; }
@media (prefers-color-scheme: dark) { :root { --bg: #14161a; --fg: #e8e8e8; --muted: #a8a8a8; --line: #3a3d44; --head: #1f2228; --best: #1d4a2a; --c0: #60a5fa; --c1: #fb923c; --c2: #34d399; --c3: #c084fc; --c4: #fb7185; --c5: #22d3ee; --c6: #a3e635; --c7: #fbbf24; --c8: #2dd4bf; --c9: #e879f9; } }
body { margin: 0; padding: 1rem; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 64rem; margin: 0 auto; }
h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
h2 { font-size: 1.1rem; margin: 2rem 0 .5rem; }
p, li { color: var(--muted); }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
caption { text-align: left; color: var(--muted); padding-bottom: .5rem; }
th, td { padding: .5rem .6rem; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
thead th { background: var(--head); white-space: normal; vertical-align: bottom; }
th[scope="row"], thead th:first-child, td.ts, th.l { text-align: left; }
td.best { background: var(--best); font-weight: 700; }
td.nodata { text-align: left; color: var(--muted); font-style: italic; }
.strip p { margin: .25rem 0; }
.charts { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1rem; margin-top: 1rem; }
.card { min-width: 0; border: 1px solid var(--line); border-radius: .75rem; padding: .75rem; }
.card h2 { margin: 0 0 .5rem; }
.card .note { margin: .5rem 0 0; font-size: .875rem; }
.chart { display: block; width: 100%; height: auto; color: var(--fg); }
.chart text { fill: currentColor; font-size: 14px; }
.chart .tick, .chart .faint { fill: var(--muted); }
.chart .name, .chart .tag, .chart .val { font-weight: 700; }
.chart .faint { font-style: italic; }
.chart .grid { stroke: currentColor; stroke-opacity: .18; }
.chart .grid.axis { stroke-opacity: .55; }
.chart .track { fill: currentColor; fill-opacity: .07; }
.chart .bar.best { stroke: var(--fg); stroke-width: 1.5; }
.chart .dot { fill: var(--bg); stroke: var(--fg); stroke-width: 1.5; }
.chart .m0 { fill: var(--c0); } .chart .m1 { fill: var(--c1); } .chart .m2 { fill: var(--c2); } .chart .m3 { fill: var(--c3); } .chart .m4 { fill: var(--c4); } .chart .m5 { fill: var(--c5); } .chart .m6 { fill: var(--c6); } .chart .m7 { fill: var(--c7); } .chart .m8 { fill: var(--c8); } .chart .m9 { fill: var(--c9); }
@media (min-width: 40rem) { body { padding: 2rem; } h1 { font-size: 1.8rem; } }
@media (min-width: 760px) { .charts { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
</head>
<body>
<main>
<header class="strip">
<h1>Kiro CLI speed — model comparison</h1>
<p>Generated ${esc(generated.toLocaleString())}. ${has("run") ? `This run: ${warmup} warm-up and ${turns} measured turns per model.` : `Latest ${turns} stored turns per model.`}</p>
<p>Models compared: ${summary.map((s) => esc(s.model)).join(", ")}. Turns measured: ${turnsLine}.</p>
</header>

<section class="charts" aria-label="Charts">
<div class="card">
<h2>TTFT (lower is better)</h2>
${ttftChart}
<p class="note">Bar = median time to first token. Each circle = one measured turn.</p>
</div>
<div class="card">
<h2>tok/s (higher is better)</h2>
${tpsChart}
<p class="note">Bar = median tokens per second. Each circle = one measured turn.</p>
</div>
</section>

<h2>Summary</h2>
<div class="scroll" role="region" aria-label="Summary table" tabindex="0">
<table>
<caption>One row per model. Medians and min–max ranges for speed. Best median in each column is shaded and bold.</caption>
<thead><tr><th scope="col">Model</th><th scope="col">Turns</th><th scope="col">TTFT (median)</th><th scope="col">TTFT (min–max)</th><th scope="col">tok/s (median)</th><th scope="col">tok/s (min–max)</th><th scope="col">Output tokens (total)</th><th scope="col">Credits (total)</th><th scope="col">Cost (total, USD)</th><th scope="col">Last measured</th></tr></thead>
<tbody>
${mainRows}
</tbody>
</table>
</div>

<h2>Individual turns</h2>
<div class="scroll" role="region" aria-label="Individual turns table" tabindex="0">
<table>
<thead><tr><th scope="col">Time</th><th scope="col" class="l">Model</th><th scope="col">Turn</th><th scope="col">TTFT</th><th scope="col">Total</th><th scope="col">tok/s</th><th scope="col">Credits</th></tr></thead>
<tbody>
${turnRows || '<tr><td colspan="7" class="nodata">no data</td></tr>'}
</tbody>
</table>
</div>

<h2>How to read this</h2>
<ul>
<li>TTFT: time from sending the prompt to the first streamed chunk. The model's thinking text counts as the first token.</li>
<li>tok/s: estimated tokens divided by the total time of the turn.</li>
<li>Tokens are estimated (characters divided by 4) because Kiro does not report them.</li>
<li>Cost: credits × $0.02.</li>
<li>With only a few turns per model, the numbers are noisy. Read small gaps with care.</li>
</ul>
</main>
<script type="application/json" id="data">${dataJson}</script>
<script>
// Show each epoch-ms time (data-ts) as local "YYYY-MM-DD HH:MM:SS", 24 hour.
document.querySelectorAll("[data-ts]").forEach(function (el) {
  var t = Number(el.getAttribute("data-ts"));
  if (!(t > 0)) return;
  var d = new Date(t), p = function (n) { return (n < 10 ? "0" : "") + n; };
  el.textContent = d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
});
</script>
</body>
</html>
`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log("\nHTML: " + out);

// 6. Open it in the default browser. A failure here never fails the script.
if (!has("no-open")) {
  const [cmd, cmdArgs] = process.platform === "win32" ? ["cmd", ["/c", "start", '""', `"${out}"`]]
    : process.platform === "darwin" ? ["open", [out]] : ["xdg-open", [out]];
  try {
    const p = spawn(cmd, cmdArgs, { stdio: "ignore", detached: true, windowsHide: true, windowsVerbatimArguments: process.platform === "win32" });
    p.on("error", () => {});
    p.unref();
  } catch { /* no browser available */ }
}
