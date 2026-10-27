// M15 step 1: what one worker run cost, read from the CLI's own output after
// it exits. Counts only: no prompt, message or file text is kept. A run whose
// output carries no usage reports null, and nothing decides anything from it.

const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

// `codex exec --json` prints one turn.completed event per turn, each with that
// turn's token counts; its input_tokens already include the cached ones.
export function parseCodexUsage(stdout) {
  const usage = { family: "codex", input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, cost_usd: null, turns: 0 };
  for (const line of String(stdout ?? "").split("\n")) {
    if (!line.includes("turn.completed")) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type !== "turn.completed" || typeof event.usage !== "object" || event.usage === null) continue;
    usage.input_tokens += count(event.usage.input_tokens);
    usage.cached_input_tokens += count(event.usage.cached_input_tokens);
    usage.output_tokens += count(event.usage.output_tokens);
    usage.turns += 1;
  }
  return usage.turns ? usage : null;
}

// `claude -p --output-format json` prints one envelope with the run's totals.
// Its input_tokens leave out cache writes and reads, so they are added here:
// input_tokens is every input token, of which cached_input_tokens were read
// from cache, the way Codex counts them.
export function parseClaudeUsage(stdout) {
  let envelope;
  try { envelope = JSON.parse(String(stdout ?? "").trim()); } catch { return null; }
  const u = envelope?.usage;
  if (typeof u !== "object" || u === null) return null;
  const cost = envelope.total_cost_usd;
  return {
    family: "claude",
    input_tokens: count(u.input_tokens) + count(u.cache_creation_input_tokens) + count(u.cache_read_input_tokens),
    cached_input_tokens: count(u.cache_read_input_tokens),
    output_tokens: count(u.output_tokens),
    cost_usd: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null,
    turns: count(envelope.num_turns),
  };
}

// Adds the run's usage to its terminal result, best effort: a parse failure
// leaves the result exactly as the adapter returned it.
export function withUsage(result, usage) {
  if (!usage || typeof result !== "object" || result === null) return result;
  return { ...result, usage };
}
