/**
 * speed-core — shared metrics engine for kirobench (Kiro CLI).
 *
 * The hook and the ACP runner write to the same on-disk store so tooling
 * can read one uniform format:
 *
 *   ~/.cache/llm-speed-bench/
 *     starts/<sessionId>.json   in-flight turn markers (t0, model, agent)
 *     stats.jsonl               one line per completed response
 *
 * Metrics (same definitions everywhere):
 *   TTFT          request sent → first streamed token
 *   decode tok/s  (tokens − 1) ÷ seconds AFTER the first token
 *   overall tok/s tokens ÷ total seconds (what you actually feel)
 *
 * Everything here is crash-safe by design: adapters run inside host coding
 * agents, so no fs failure may ever escape as an exception.
 */

import {
  mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, rmSync,
  renameSync, statSync, readdirSync, openSync, fstatSync, readSync, closeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const STORE_DIR =
  process.env.LLM_SPEED_DIR || join(homedir(), ".cache", "llm-speed-bench");
const STARTS = join(STORE_DIR, "starts");
const STATS = join(STORE_DIR, "stats.jsonl");
const MAX_STATS_BYTES = 16 * 1024 * 1024;

function ensureDirs() {
  mkdirSync(STARTS, { recursive: true });
}

function safeId(id) {
  return String(id ?? "unknown").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

/** Record the moment a turn was kicked off (user prompt / model request). */
export function recordStart(sessionId, meta = {}) {
  try {
    ensureDirs();
    const { t0: _clobber, ...rest } = meta; // meta can never override t0
    writeFileSync(join(STARTS, safeId(sessionId) + ".json"), JSON.stringify({ ...rest, t0: Date.now() }));
    // opportunistic prune of markers whose Stop never fired (host killed, etc.)
    try {
      for (const f of readdirSync(STARTS)) {
        const p = join(STARTS, f);
        if (Date.now() - statSync(p).mtimeMs > 24 * 3600 * 1000) rmSync(p);
      }
    } catch {}
  } catch { /* never break the host agent */ }
}

/** Atomically claim + read + remove the in-flight marker. Returns null when absent/corrupt. */
export function takeStart(sessionId) {
  const file = join(STARTS, safeId(sessionId) + ".json");
  const claim = `${file}.${process.pid}.claim`;
  try {
    renameSync(file, claim); // atomic: exactly one concurrent caller wins
  } catch {
    return null; // ENOENT → absent or already claimed
  }
  try {
    const start = JSON.parse(readFileSync(claim, "utf8"));
    return Number.isFinite(start?.t0) ? start : null; // reject corrupt markers
  } catch {
    return null;
  } finally {
    try { rmSync(claim); } catch {}
  }
}

/** Append one completed-response stat (with lightweight rotation). */
export function appendStat(stat) {
  try {
    ensureDirs();
    try {
      if (existsSync(STATS) && statSync(STATS).size > MAX_STATS_BYTES) {
        renameSync(STATS, `${STATS}.${new Date().toISOString().slice(0, 10)}`);
      }
    } catch {}
    appendFileSync(STATS, JSON.stringify({ ts: Date.now(), ...stat }) + "\n");
  } catch { /* never break the host agent */ }
}

/** Read the last `limit` stats (newest last) via a bounded tail read. */
export function readStats(limit = 200) {
  try {
    if (!existsSync(STATS)) return [];
    const CHUNK = 256 * 1024; // >200 rows comfortably (~150 B/row)
    const fd = openSync(STATS, "r");
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, CHUNK);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString("utf8").split("\n").filter(Boolean);
      if (size > len && lines.length) lines.shift(); // drop possibly-torn first line
      return lines.slice(-limit)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
}

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!v.length) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Build a full stat from raw timings. NaN- and type-poisoning proof. */
export function computeStat({ t0, ttftMs = 0, totalMs, outputTokens, costUsd = 0, model = "", agent = "", session = "" }) {
  const total = Number.isFinite(totalMs) && totalMs > 0 ? Math.max(1, Math.round(totalMs)) : 1;
  const ttft = Number.isFinite(ttftMs) && ttftMs > 0 ? Math.round(ttftMs) : 0;
  const tokens = Number.isFinite(outputTokens) ? Math.max(0, Math.round(outputTokens)) : 0;
  const gen = Math.max(1, total - ttft);
  return {
    agent: String(agent ?? ""), session: String(session ?? ""), model: String(model ?? ""),
    ttftMs: ttft,
    totalMs: total,
    outputTokens: tokens,
    decodeTps: tokens > 0 ? (tokens - 1) / (gen / 1000) : 0,
    overallTps: tokens > 0 ? tokens / (total / 1000) : 0,
    costUsd: Number.isFinite(costUsd) ? costUsd : 0,
  };
}

/** Rough token estimate when only character counts are available (~4 chars/token). */
export function charsToTokens(chars) {
  return Math.max(0, Math.round(chars / 4));
}

/** Aggregate stats by agent+model. */
export function aggregate(stats = readStats()) {
  const map = new Map();
  for (const s of stats) {
    const key = `${s.agent || "?"}|${s.model || "?"}`;
    const agg =
      map.get(key) ||
      { agent: s.agent || "?", model: s.model || "?", responses: 0, ttfts: [], decodes: [], overalls: [], tokens: 0, costUsd: 0 };
    agg.responses++;
    if (s.ttftMs > 0) agg.ttfts.push(s.ttftMs);
    if (s.decodeTps > 0) agg.decodes.push(s.decodeTps);
    if (s.overallTps > 0) agg.overalls.push(s.overallTps);
    agg.tokens += s.outputTokens || 0;
    agg.costUsd += s.costUsd || 0;
    map.set(key, agg);
  }
  return [...map.values()];
}

export function fmtMs(ms) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function fmtTps(tps) {
  return tps > 0 ? tps.toFixed(1) : "—";
}

export function fmtTokens(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

export function fmtCost(usd) {
  if (!usd) return "$0";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** Render the aggregate table (used by /speed-style commands across agents). */
export function renderTable(stats = readStats()) {
  const aggs = aggregate(stats);
  if (!aggs.length) return "No responses measured yet.";
  const lines = [];
  lines.push("Speed counter — per-model medians");
  lines.push(
    `${"agent".padEnd(9)} ${"model".padEnd(28)} ${"resp".padStart(4)}  ${"TTFT".padStart(7)}  ${"decode tok/s".padStart(12)}  ${"overall tok/s".padStart(13)}  ${"out tok".padStart(7)}  ${"cost".padStart(8)}`,
  );
  for (const a of aggs) {
    lines.push(
      `${String(a.agent ?? "?").padEnd(9).slice(0, 9)} ${String(a.model ?? "?").padEnd(28).slice(0, 28)} ${String(a.responses).padStart(4)}  ${a.ttfts.length ? fmtMs(median(a.ttfts)).padStart(7) : "—".padStart(7)}  ${fmtTps(median(a.decodes)).padStart(12)}  ${fmtTps(median(a.overalls)).padStart(13)}  ${fmtTokens(a.tokens).padStart(7)}  ${fmtCost(a.costUsd).padStart(8)}`,
    );
  }
  lines.push("");
  lines.push("TTFT · request sent → first streamed token");
  lines.push("decode tok/s · generation speed after the first token");
  lines.push("overall tok/s · tokens ÷ total seconds (includes prefill wait)");
  return lines.join("\n");
}
