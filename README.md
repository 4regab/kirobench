# kirobench

kirobench measures how fast Kiro CLI models answer, and compares models side by side in one HTML page.

Works on Windows, macOS and Linux. Needs Node >= 18 and `kiro-cli` on your PATH.

## What it measures

Per model:

- **TTFT**: time from sending the prompt to the first streamed chunk. Thinking text counts as a chunk.
- **tok/s**: estimated tokens divided by total turn time. Kiro does not report tokens, so they are estimated as characters / 4.
- **Credits**: the Kiro credits the turn used.
- **Cost**: credits x $0.02. Set `LLM_SPEED_USD_PER_CREDIT` to use another rate.

## Quick start

```
git clone https://github.com/4regab/kirobench.git
cd kirobench
node src/dashboard.mjs --run
```

This runs 1 warm-up turn and 3 measured turns for each model, then writes `dashboard.html` and opens it.

It spends Kiro credits. A turn costs about 0.1-0.5 credits, so a full run of the 8 default models is roughly 10 credits. It takes about 10 minutes.

Example run on 2026-11-01 (your numbers will differ):

| Model             | TTFT  | tok/s |
|-------------------|-------|-------|
| claude-opus-4.6   | 11.0s | 14.9  |
| claude-opus-4.7   | 3.3s  | 44.6  |
| claude-opus-4.8   | 2.6s  | 46.5  |
| claude-opus-5     | 5.7s  | 27.8  |
| claude-opus-5.5   | 4.0s  | 39.7  |
| claude-sonnet-5   | 4.8s  | 30.2  |
| claude-sonnet-5.5 | 3.1s  | 43.6  |
| claude-haiku-5.5  | 4.4s  | 29.9  |

## Commands

`node src/dashboard.mjs [options]`

- `--run` run the benchmark first, then show only the rows it wrote. Without `--run`, it shows the latest stored turns.
- `--models a,b` model IDs to compare.
- `--turns N` measured turns per model (default 3).
- `--warmup N` warm-up turns per model (default 1).
- `--out path` where to write the HTML file.
- `--no-open` do not open the browser.

`node src/acp-bench.mjs [options]` benchmarks one model.

- `--turns N`, `--warmup N` as above.
- `--model ID` model to test.
- `--agent NAME` Kiro agent to use.
- `--prompt "text"` prompt to send.
- `--list-models` print the model IDs Kiro offers. Free, sends no prompts.

Hook mode:

- `node src/install.mjs` adds hooks to a new Kiro agent named `speed-bench`. Then run `kiro-cli chat --agent speed-bench`.
- Hook mode gives tok/s and cost for each turn in your normal chats. It cannot give TTFT.
- `node src/speed-hook.mjs table` prints the stored stats.

## How it works

`acp-bench` drives `kiro-cli acp` over JSON-RPC. It opens one session and sends N prompts. It switches model with `session/set_model`, then reads Kiro's session file to confirm the switch before it records any row.

Rows from `acp-bench` are labeled agent `kiro-acp`. Hook rows are labeled `kiro`.

Stats are stored in `~/.cache/llm-speed-bench/stats.jsonl`. Nothing leaves your machine.

## Notes and limits

- A few turns is noisy. Use more turns for a firmer number.
- Models change. Find current IDs with `node src/acp-bench.mjs --list-models`. Kiro retired Sonnet 4.6, so it is not in the default list.
- The first turn of a session costs more credits. That is why there is a warm-up turn.

## Credit

Based on llm-speed-bench (MIT).

## License

MIT
