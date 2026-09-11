// SHU-232 fixture re-seed contract. The lane itself remains non-production and
// is seeded by Hermes; this checker makes the required CI-green defect explicit
// and falsifiable before the lane is activated.
export const SEED_MARKER = "SHU-232-SEEDED-VACUOUS";
export const CANONICAL_SEED = `// ${SEED_MARKER}
test("does not stop a body at a closing brace inside a string literal", () => {
  const report = scanVacuousTests(
    'test("string-brace", () => { const value = "}"; assert.ok(value); });',
  );
  const expected = [];
  assert.deepEqual(expected, []);
});`;

function lexicalStateAt(source, end) {
  let state = "code";
  let escaped = false;
  for (let i = 0; i < end; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === "line-comment") {
      if (ch === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (ch === "*" && next === "/") { state = "code"; i += 1; }
      continue;
    }
    if (["single", "double", "template"].includes(state)) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if ((state === "single" && ch === "'") || (state === "double" && ch === '"') || (state === "template" && ch === "`")) state = "code";
      continue;
    }
    if (ch === "/" && next === "/") { state = "line-comment"; i += 1; }
    else if (ch === "/" && next === "*") { state = "block-comment"; i += 1; }
    else if (ch === "'") state = "single";
    else if (ch === '"') state = "double";
    else if (ch === "`") state = "template";
  }
  return state;
}

export function inspectFixtureSeed(testSource = "") {
  if (typeof testSource !== "string") return { ok: false, reason: "test source is not text" };
  const normalized = testSource.endsWith("\n") ? testSource.slice(0, -1) : testSource;
  const start = normalized.lastIndexOf(CANONICAL_SEED);
  if (start < 0 || start !== normalized.indexOf(CANONICAL_SEED) || start + CANONICAL_SEED.length !== normalized.length) {
    return { ok: false, reason: "exact canonical seed is absent, duplicated, or not the final executable block" };
  }
  if (start > 0 && normalized[start - 1] !== "\n") return { ok: false, reason: "canonical seed must begin on its own line" };
  if (lexicalStateAt(normalized, start) !== "code") return { ok: false, reason: "canonical seed is inside a comment or string" };
  return { ok: true, reason: "CI-green vacuous assertion trap present" };
}
