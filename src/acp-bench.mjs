#!/usr/bin/env node
/**
 * acp-bench.mjs — measure Kiro CLI with a real TTFT, by driving `kiro-cli acp`.
 *
 *   node acp-bench.mjs [--turns N] [--warmup N] [--model ID] [--agent NAME] [--prompt "text"]
 *   node acp-bench.mjs --list-models   print Kiro's available model IDs (no prompts, no cost)
 *
 * Kiro hooks cannot see streaming, but an ACP client can. This script is that
 * client: it starts `kiro-cli acp`, opens ONE session and sends N prompts one
 * after another (JSON-RPC 2.0, one JSON object per line over stdin/stdout).
 *
 * Per turn:
 *   TTFT   prompt written → first streamed chunk (a "thinking" chunk counts:
 *          it is the model's first output token)
 *   total  prompt written → prompt response
 *   tokens estimated from the streamed text (chars ÷ 4)
 *   credits/cost from Kiro's metadata notice; cost = credits x $0.02
 *
 * --model ID switches the session to that model (ACP session/set_model). The
 * run then checks Kiro's own session file to prove the model really changed,
 * and writes no row until it has. --warmup N runs N extra turns first and does
 * not record them (the first request is often slower than the rest).
 *
 * Rows go to the shared stats store with agent "kiro-acp", so they stay apart
 * from the hook rows ("kiro"). LLM_SPEED_ACP=1 is set for the child so the
 * Kiro hooks do not count these turns a second time.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { computeStat, charsToTokens, appendStat, renderTable, readStats, fmtMs, fmtTps, fmtCost } from "./speed-core.mjs";

// Kiro credit price: $20 per 1,000 credits.
const USD_PER_CREDIT = Number(process.env.LLM_SPEED_USD_PER_CREDIT) || 0.02;
const TURN_TIMEOUT_MS = 300_000;

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const turns = Math.max(1, parseInt(opt("turns", "3"), 10) || 3);
const warmup = Math.max(0, parseInt(opt("warmup", "0"), 10) || 0);
const wantModel = opt("model", "");
const wantListModels = args.includes("--list-models");
const agent = opt("agent", "");
const prompt = opt("prompt", "Explain in about 150 words how a hash map works. No tools.");

function fail(message) {
  console.error("error: " + message);
  process.exit(1);
}

/** Models that Kiro's own session file says were used (empty until Kiro writes it). */
function sessionFileModels(sessionId) {
  try {
    const file = join(homedir(), ".kiro", "sessions", "cli", sessionId + ".json");
    const s = JSON.parse(readFileSync(file, "utf8")).session_state ?? {};
    const lastTurn = (s.conversation_metadata?.user_turn_metadatas ?? []).at(-1);
    return [lastTurn?.model, s.conversation_metadata?.last_context_usage?.model_id, s.rts_model_state?.model_info?.model_id].filter(Boolean);
  } catch {
    return [];
  }
}

/** Wait for Kiro to write the session file, then check every model entry is the one we asked for. */
async function confirmModel(sessionId, wanted) {
  for (let i = 0; i < 20; i++) {
    const seen = sessionFileModels(sessionId);
    if (seen.length >= 3) {
      if (seen.every((m) => m === wanted)) return;
      throw new Error(`model switch failed: asked for ${wanted}, Kiro session file says ${[...new Set(seen)].join(", ")}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`cannot confirm model ${wanted}: Kiro session file ${sessionId}.json not complete after 10s`);
}

const child = spawn("kiro-cli", ["acp", ...(agent ? ["--agent", agent] : [])], {
  stdio: ["pipe", "pipe", "ignore"],
  env: { ...process.env, LLM_SPEED_ACP: "1" },
  windowsHide: true,
});
child.on("error", (e) => fail("cannot start kiro-cli: " + e.message));
process.on("exit", () => child.kill());

let nextId = 1;
const pending = new Map(); // request id → { resolve, reject }
let turn = null; // the turn being measured: { first, chars, credits }
let died = false;

const write = (obj) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...obj }) + "\n");

/** Send a request and wait for its response (rejects on error, death or timeout). */
function request(method, params, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    if (died) return reject(new Error("kiro-cli exited"));
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    write({ id, method, params });
  });
}

function onMessage(m) {
  if (m.method && m.id !== undefined) {
    // Agent asks us for something (permission, file, terminal...): refuse, never hang.
    if (m.method === "session/request_permission") write({ id: m.id, result: { outcome: { outcome: "cancelled" } } });
    else write({ id: m.id, error: { code: -32601, message: "not supported by acp-bench" } });
  } else if (m.method) {
    const update = m.params?.update;
    const kind = update?.sessionUpdate;
    if (turn && (kind === "agent_thought_chunk" || kind === "agent_message_chunk") && update.content?.text) {
      turn.first ??= performance.now();
      turn.chars += update.content.text.length;
    }
    if (turn && m.method === "_kiro.dev/metadata") {
      const usage = m.params?.meteringUsage ?? m.params?.update?.meteringUsage ?? [];
      turn.credits = usage.reduce((sum, u) => sum + (Number(u.value) || 0), 0);
    }
  } else if (pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message || "request failed"));
    else p.resolve(m.result);
  }
}

let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try { onMessage(JSON.parse(line)); } catch { /* ignore non-JSON lines */ }
  }
});
child.on("exit", () => {
  died = true;
  for (const p of pending.values()) p.reject(new Error("kiro-cli exited early"));
  pending.clear();
});

try {
  await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  });
  const session = await request("session/new", { cwd: process.cwd(), mcpServers: [] });
  const sessionId = session.sessionId;
  if (wantListModels) {
    const ids = (session.models?.availableModels ?? []).map((m) => m.modelId);
    console.log(ids.length ? ids.join("\n") : "(no models reported)");
    child.stdin.end();
    child.kill();
    process.exit(0);
  }
  let model = session.models?.currentModelId || "";
  if (wantModel) {
    // Stop early, before any prompt, when the model does not exist.
    const ids = (session.models?.availableModels ?? []).map((m) => m.modelId);
    if (!ids.includes(wantModel)) throw new Error(`unknown model "${wantModel}". Available: ${ids.join(", ")}`);
    if (model !== wantModel) await request("session/set_model", { sessionId, modelId: wantModel });
    model = wantModel; // proven after the first turn, before any row is written
  }
  console.log(`session ${sessionId} · model ${model || "?"}`);

  let confirmed = !wantModel;
  for (let n = 1; n <= warmup + turns; n++) {
    turn = { first: null, chars: 0, credits: 0 };
    const t0 = performance.now();
    const wallStart = Date.now();
    await request("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] }, TURN_TIMEOUT_MS);
    const totalMs = performance.now() - t0;
    if (turn.first === null) throw new Error(`turn ${n}: no text chunk arrived`);
    if (!confirmed) { await confirmModel(sessionId, wantModel); confirmed = true; }
    if (n <= warmup) {
      if (n === warmup) console.log("warm-up done");
      continue; // warm-up turns are not recorded
    }

    const ttftMs = turn.first - t0;
    const credits = turn.credits;
    const stat = computeStat({
      t0: wallStart, ttftMs, totalMs,
      outputTokens: charsToTokens(turn.chars),
      costUsd: credits * USD_PER_CREDIT,
      model, agent: "kiro-acp", session: sessionId,
    });
    appendStat({ ...stat, credits, tokenSource: "estimate" });
    console.log(`turn ${n - warmup}: ttft ${fmtMs(stat.ttftMs)} · total ${fmtMs(stat.totalMs)} · ${fmtTps(stat.overallTps)} tok/s · ${credits.toFixed(3)} credits · ${fmtCost(stat.costUsd)}`);
  }
  turn = null;
  console.log("\n" + renderTable(readStats(400).filter((s) => s.session === sessionId)));
} catch (e) {
  fail(e.message);
}
child.stdin.end();
child.kill();
