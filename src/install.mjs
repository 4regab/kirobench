#!/usr/bin/env node
/**
 * Install kirobench for Kiro CLI (works on Windows, macOS, Linux).
 *
 *   node install.mjs                  → ~/.kiro/agents/speed-bench.json (new agent)
 *   node install.mjs <agentName>      → add the same hooks to ~/.kiro/agents/<agentName>.json
 *
 * Kiro only runs hooks that live in an agent config, so the hooks go there.
 * Safe to run again: our own files are replaced, and other fields and hooks are kept.
 */

import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url))); // repo src folder
const DEST = join(homedir(), ".kiro", "kirobench");
const name = process.argv[2] || "speed-bench";
if (!/^[\w.-]+$/.test(name)) { console.error(`bad agent name: ${name}`); process.exit(1); }
const agentFile = join(homedir(), ".kiro", "agents", name + ".json");

// 1. Copy files (idempotent: wipe our own dir first).
if (SRC !== resolve(DEST, "src")) {
  rmSync(DEST, { recursive: true, force: true });
  cpSync(SRC, join(DEST, "src"), { recursive: true });
}
console.log("  files → " + DEST);

// 2. Merge the hooks into the agent config.
let agent = { name, description: "Kiro with kirobench: logs tok/s for every turn", tools: ["*"] };
if (existsSync(agentFile)) {
  try {
    agent = JSON.parse(readFileSync(agentFile, "utf8"));
  } catch {
    console.error(`✗ ${agentFile} is not valid JSON — left untouched`);
    process.exit(1);
  }
} else if (name !== "speed-bench") {
  console.error(`✗ no agent named "${name}" at ${agentFile}`);
  process.exit(1);
}
const cmd = `node "${DEST.replaceAll("\\", "/")}/src/speed-hook.mjs" --agent kiro`;
agent.hooks ??= {};
for (const ev of ["userPromptSubmit", "stop"]) {
  agent.hooks[ev] = (agent.hooks[ev] || []).filter((h) => !/kirobench|llm-speed-bench/.test(JSON.stringify(h)));
  agent.hooks[ev].push({ command: cmd });
}
mkdirSync(dirname(agentFile), { recursive: true });
writeFileSync(agentFile, JSON.stringify(agent, null, 2) + "\n");
console.log("  hooks merged → " + agentFile);
console.log(`done. run: kiro-cli chat --agent ${name}`);
console.log(`table: node "${DEST.replaceAll("\\", "/")}/src/speed-hook.mjs" table`);
