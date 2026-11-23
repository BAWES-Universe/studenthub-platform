import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The launcher is plain JavaScript run from the source tree; each case copies it into a synthetic
// git checkout with a stand-in importer that records whether it was ever loaded.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const LAUNCHER = path.join(REPO, "tools/legacy-import/m4-launch.mjs");

interface Checkout { readonly root: string; readonly head: string; readonly loaded: string }

function checkout(): Checkout {
  const root = mkdtempSync(path.join(tmpdir(), "m4-launch-"));
  const write = (rel: string, text: string) => { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), text); };
  const loaded = path.join(root, "loaded.txt");
  mkdirSync(path.join(root, "tools/legacy-import"), { recursive: true });
  copyFileSync(LAUNCHER, path.join(root, "tools/legacy-import/m4-launch.mjs"));
  write("package.json", "{}");
  write("package-lock.json", '{"lockfileVersion":3}');
  write("packages/db/package.json", '{"name":"@studenthub/db"}');
  write(".gitignore", "dist/\nnode_modules/\npackages/*/dist/\nloaded.txt\nout.json\n");
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.email=t@example.test", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git("init", "-q");
  git("add", "-A");
  git("commit", "--no-gpg-sign", "-qm", "synthetic");
  // The built and installed runtime: untracked, as after `npm ci --ignore-scripts && npm run build`.
  write("dist/tools/legacy-import/src/m4-cli.js", `import { appendFileSync, writeFileSync } from "node:fs";
appendFileSync(${JSON.stringify(loaded)}, "loaded\\n");
export const defaultDeps = (env, built) => ({ env, built });
export async function main(argv, deps) {
  writeFileSync(${JSON.stringify(path.join(root, "out.json"))}, JSON.stringify({ argv, built: deps.built }));
  return 0;
}
`);
  write("dist/tools/legacy-import/src/m4-run.js", "export {};\n");
  write("packages/db/dist/import/index.js", "export {};\n");
  write("node_modules/pg/package.json", '{"name":"pg","version":"8.0.0"}');
  write("node_modules/pg/lib/index.js", "module.exports = {};\n");
  mkdirSync(path.join(root, "node_modules/@studenthub"), { recursive: true });
  symlinkSync("../../packages/db", path.join(root, "node_modules/@studenthub/db"));
  return { root, head: git("rev-parse", "HEAD"), loaded };
}

function run(c: Checkout, argv: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [path.join(c.root, "tools/legacy-import/m4-launch.mjs"), ...argv],
    { cwd: c.root, encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

function pin(c: Checkout): string {
  const r = run(c, ["provenance"]);
  assert.equal(r.status, 0, r.stderr);
  const match = /^m4 provenance head=([0-9a-f]{40}) clean=true artifact=([0-9a-f]{64})$/.exec(r.stdout);
  assert.ok(match, r.stdout);
  assert.equal(match[1], c.head);
  return match[2]!;
}

test("provenance prints the commit and the installed runtime's digest and loads nothing", () => {
  const c = checkout();
  try {
    const digest = pin(c);
    assert.equal(pin(c), digest);
    assert.equal(existsSync(c.loaded), false);
    // A runtime missing a required part has no digest at all, so nothing can be pinned to it.
    for (const rel of ["node_modules", "dist/tools/legacy-import/src/m4-cli.js", "package-lock.json"]) {
      const c2 = checkout();
      try {
        rmSync(path.join(c2.root, rel), { recursive: true });
        const r = run(c2, ["provenance"]);
        assert.equal(r.status, 1, rel);
        assert.match(r.stdout, /artifact=incomplete$/, rel);
      } finally { rmSync(c2.root, { recursive: true, force: true }); }
    }
  } finally { rmSync(c.root, { recursive: true, force: true }); }
});

test("a verified runtime loads the importer and hands it the verified provenance", () => {
  const c = checkout();
  try {
    const digest = pin(c);
    const r = run(c, ["plan"], { M4_REVISION: c.head, M4_ARTIFACT_DIGEST: digest });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(c.loaded, "utf8"), "loaded\n");
    assert.deepEqual(JSON.parse(readFileSync(path.join(c.root, "out.json"), "utf8")), { argv: ["plan"], built: { head: c.head, clean: true, artifact: digest } });
  } finally { rmSync(c.root, { recursive: true, force: true }); }
});

test("a missing or mismatched runtime, a wrong commit or a changed tracked file refuses before the importer loads", () => {
  const cases: { name: string; change: (c: Checkout, digest: string) => Record<string, string> }[] = [
    { name: "no pin", change: (c) => ({ M4_REVISION: c.head }) },
    { name: "malformed pin", change: (c) => ({ M4_REVISION: c.head, M4_ARTIFACT_DIGEST: "nope" }) },
    { name: "other pin", change: (c) => ({ M4_REVISION: c.head, M4_ARTIFACT_DIGEST: "f".repeat(64) }) },
    { name: "other revision", change: (_c, d) => ({ M4_REVISION: "b".repeat(40), M4_ARTIFACT_DIGEST: d }) },
    { name: "no revision", change: (_c, d) => ({ M4_ARTIFACT_DIGEST: d }) },
    { name: "entrypoint missing", change: (c, d) => { rmSync(path.join(c.root, "dist/tools/legacy-import/src/m4-cli.js")); return { M4_REVISION: c.head, M4_ARTIFACT_DIGEST: d }; } },
    { name: "built file changed", change: (c, d) => { writeFileSync(path.join(c.root, "dist/tools/legacy-import/src/m4-run.js"), "export const x = 1;\n"); return { M4_REVISION: c.head, M4_ARTIFACT_DIGEST: d }; } },
    { name: "built file added", change: (c, d) => { writeFileSync(path.join(c.root, "dist/extra.js"), "\n"); return { M4_REVISION: c.head, M4_ARTIFACT_DIGEST: d }; } },
    { name: "workspace build changed", change: (c, d) => { writeFileSync(path.join(c.root, "packages/db/dist/import/index.js"), "export const y = 1;\n"); return { M4_REVISION: c.head, M4_ARTIFACT_DIGEST: d }; } },
    { name: "installed package changed", change: (c, d) => { writeFileSync(path.join(c.root, "node_modules/pg/lib/index.js"), "module.exports = { patched: true };\n"); return { M4_REVISION: c.head, M4_ARTIFACT_DIGEST: d }; } },
    { name: "installed package missing", change: (c, d) => { rmSync(path.join(c.root, "node_modules/pg"), { recursive: true }); return { M4_REVISION: c.head, M4_ARTIFACT_DIGEST: d }; } },
    { name: "workspace link moved", change: (c, d) => { rmSync(path.join(c.root, "node_modules/@studenthub/db")); symlinkSync("../../elsewhere", path.join(c.root, "node_modules/@studenthub/db")); return { M4_REVISION: c.head, M4_ARTIFACT_DIGEST: d }; } },
    { name: "node_modules missing", change: (c, d) => { rmSync(path.join(c.root, "node_modules"), { recursive: true }); return { M4_REVISION: c.head, M4_ARTIFACT_DIGEST: d }; } },
    { name: "tracked file changed", change: (c, d) => { writeFileSync(path.join(c.root, "package.json"), '{"changed":true}'); return { M4_REVISION: c.head, M4_ARTIFACT_DIGEST: d }; } },
    { name: "launcher changed", change: (c, d) => { writeFileSync(path.join(c.root, "tools/legacy-import/m4-launch.mjs"), readFileSync(LAUNCHER, "utf8") + "\n// edited\n"); return { M4_REVISION: c.head, M4_ARTIFACT_DIGEST: d }; } },
    { name: "not a git checkout", change: (c, d) => { rmSync(path.join(c.root, ".git"), { recursive: true }); return { M4_REVISION: c.head, M4_ARTIFACT_DIGEST: d }; } },
  ];
  for (const k of cases) {
    const c = checkout();
    try {
      const env = k.change(c, pin(c));
      for (const mode of ["plan", "write"]) {
        const r = run(c, [mode], env);
        assert.equal(r.status, 2, `${k.name} ${mode}: ${r.stderr}`);
        assert.equal(r.stderr, "m4: refused.provenance", k.name);
        assert.equal(existsSync(c.loaded), false, `${k.name}: the importer was loaded`);
      }
    } finally { rmSync(c.root, { recursive: true, force: true }); }
  }
});

test("a dirty build is printed but is not a pin", () => {
  const c = checkout();
  try {
    writeFileSync(path.join(c.root, "package.json"), '{"changed":true}');
    const r = run(c, ["provenance"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^m4 provenance head=[0-9a-f]{40} clean=false artifact=[0-9a-f]{64}$/);
  } finally { rmSync(c.root, { recursive: true, force: true }); }
});

test("a runtime file that cannot be read refuses as provenance, before the importer loads", (t) => {
  if (process.getuid?.() === 0) { t.skip("root reads any file"); return; }
  const c = checkout();
  const file = path.join(c.root, "dist/tools/legacy-import/src/m4-run.js");
  try {
    const digest = pin(c);
    chmodSync(file, 0o000);
    const r = run(c, ["write"], { M4_REVISION: c.head, M4_ARTIFACT_DIGEST: digest });
    assert.deepEqual([r.status, r.stderr], [2, "m4: refused.provenance"]);
    assert.equal(existsSync(c.loaded), false);
  } finally { chmodSync(file, 0o644); rmSync(c.root, { recursive: true, force: true }); }
});

test("the importer refuses to run without the launcher", () => {
  const r = spawnSync(process.execPath, [path.join(REPO, "dist/tools/legacy-import/src/m4-cli.js"), "write"], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(r.status, 2);
  assert.equal(r.stderr.trim(), "m4: refused.launcher");
});

test("the real installed runtime is complete", () => {
  const r = spawnSync(process.execPath, [LAUNCHER, "provenance"], { cwd: REPO, encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.match(r.stdout.trim(), /^m4 provenance head=[0-9a-f]{40} clean=(true|false) artifact=[0-9a-f]{64}$/);
});
