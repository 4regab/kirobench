#!/usr/bin/env node
/**
 * speed-hook.mjs — kirobench hook for Kiro CLI.
 *
 * Kiro runs the hooks listed in an agent config (~/.kiro/agents/<name>.json),
 * each with one JSON object on stdin:
 *   userPromptSubmit → mark turn start
 *   stop             → record the finished turn
 *
 * What it measures: end-to-end time of the turn (prompt submitted → stop hook),
 * measured in the stop hook itself.
 *
 * Limits, in plain words:
 *   - TTFT is not available from Kiro hooks, so it is stored as 0.
 *   - The hook payload has no token counts. Kiro writes them to its session
 *     file only AFTER the stop hook returns (and they are 0 in Kiro 2.33), so
 *     tokens are estimated as reply characters ÷ 4 and marked
 *     tokenSource:"estimate" in stats.jsonl. If a later Kiro version fills in
 *     the counts for the turn, they are used and marked "kiro-session".
 *   - The stop hook only hands us the final reply. In a multi-step turn (tool
 *     calls between messages) the estimate is a lower bound, so tok/s is too.
 *   - Kiro bills in credits. Cost = credits x $0.02 ($20 per 1,000 credits).
 *     Kiro writes the turn's credits to its session file about 150 ms AFTER the
 *     stop hook returns, so the stop hook hands the stat to a small detached
 *     copy of this script ("finish"). It waits up to 5 s for the turn to show
 *     up in the session file, adds credits and cost, then writes the row. If
 *     the turn never shows up, the row is still written, with cost 0.
 *   - Set LLM_SPEED_ACP=1 to switch the hooks off (acp-bench.mjs does this so
 *     its turns are not counted twice).
 *
 * CLI: `node speed-hook.mjs table [sessionId]` prints the stats table.
 */

import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import { recordStart, takeStart, computeStat, charsToTokens, appendStat, renderTable, readStats } from "./speed-core.mjs";

// Kiro credit price: $20 per 1,000 credits.
const USD_PER_CREDIT = Number(process.env.LLM_SPEED_USD_PER_CREDIT) || 0.02;

/** Kiro's session_state for this session, or {} when the file is missing/unreadable. */
function readSessionState(id) {
  try {
    if (!/^[\w.-]+$/.test(id)) return {}; // the id becomes part of a file path
    const file = join(homedir(), ".kiro", "sessions", "cli", id + ".json");
    return JSON.parse(readFileSync(file, "utf8"))?.session_state ?? {};
  } catch {
    return {};
  }
}

/** Detached follow-up: wait for Kiro to write the turn's credits, then save the row. */
function finish() {
  let job;
  try {
    job = JSON.parse(readFileSync(0, "utf8")); // { stat, t0, sessionId, tokenSource }
  } catch {
    return;
  }
  const { stat, t0, sessionId, tokenSource } = job;
  let turn;
  const deadline = Date.now() + 5000;
  for (;;) {
    const turns = readSessionState(sessionId).conversation_metadata?.user_turn_metadatas ?? [];
    turn = turns.findLast((t) => Date.parse(t.end_timestamp) >= t0); // newest turn that ended after our start
    if (turn || Date.now() >= deadline) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); // sleep 50 ms
  }
  const credits = (turn?.metering_usage ?? []).reduce((sum, m) => sum + (Number(m.value) || 0), 0);
  const reported = Number(turn?.output_token_count);
  const useReported = reported > 0;
  appendStat({
    ...stat,
    ...(useReported ? computeStat({ ...stat, t0, outputTokens: reported }) : {}),
    credits,
    costUsd: credits * USD_PER_CREDIT,
    tokenSource: useReported ? "kiro-session" : tokenSource,
  });
}

function main() {
  if (process.argv[2] === "table") {
    const id = process.argv[3];
    const stats = readStats(400).filter((s) => !id || s.session === id);
    process.stdout.write(renderTable(stats) + "\n");
    return;
  }
  if (process.argv[2] === "finish") return finish();
  if (process.env.LLM_SPEED_ACP) return; // acp-bench.mjs counts its own turns

  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return; // not JSON — nothing to do
  }
  const sessionId = String(input?.session_id || "unknown");

  if (input?.hook_event_name === "userPromptSubmit") {
    recordStart(sessionId, { agent: "kiro" });
    return;
  }

  if (input?.hook_event_name === "stop") {
    const start = takeStart(sessionId);
    if (!start) return; // no matching turn start

    const state = readSessionState(sessionId);
    const meta = state.conversation_metadata ?? {};
    const turn = (meta.user_turn_metadatas ?? []).at(-1);
    // The newest turn in the file only counts if it finished after our start marker;
    // otherwise it belongs to an earlier prompt of the same session.
    const fresh = turn && Date.parse(turn.end_timestamp) >= start.t0;
    const reported = fresh ? Number(turn.output_token_count) : 0;
    const estimated = !(reported > 0);
    const outputTokens = estimated ? charsToTokens(String(input.assistant_response ?? "").length) : reported;
    if (!outputTokens) return; // nothing countable

    const stat = computeStat({
      t0: start.t0,
      totalMs: Date.now() - start.t0, // measured now, before the wait for credits
      outputTokens,
      costUsd: 0,
      model: state.rts_model_state?.model_info?.model_name || meta.last_context_usage?.model_id || turn?.model || "",
      agent: "kiro",
      session: sessionId,
    });
    // Hand the row to a detached copy of this script; it adds credits and saves it.
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "finish"], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    const tokenSource = estimated ? "estimate" : "kiro-session";
    child.on("error", () => appendStat({ ...stat, tokenSource })); // could not start: keep the row
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ stat, t0: start.t0, sessionId, tokenSource }));
    child.unref();
  }
}

try {
  main();
} catch {
  /* never break the host agent */
}
