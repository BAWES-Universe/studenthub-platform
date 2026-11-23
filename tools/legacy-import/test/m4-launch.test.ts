import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// The launcher is plain JavaScript run from the source tree; each case copies it into a synthetic
// git checkout with a stand-in importer that records, outside the checkout, whether it was loaded.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const LAUNCHER = path.join(REPO, "tools/legacy-import/m4-launch.mjs");

interface Checkout { readonly root: string; readonly head: string; readonly loaded: string; readonly out: string; readonly scratch: string }

const chmodTree = (dir: string, writable: boolean) => {
  spawnSync("chmod", ["-R", writable ? "u+w" : "a-w", dir]);
};

function checkout(): Checkout {
  const scratch = mkdtempSync(path.join(tmpdir(), "m4-launch-"));
  const root = path.join(scratch, "repo");
  const write = (rel: string, text: string) => { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), text); };
  const loaded = path.join(scratch, "loaded.txt");
  const out = path.join(scratch, "out.json");
  mkdirSync(path.join(root, "tools/legacy-import"), { recursive: true });
  copyFileSync(LAUNCHER, path.join(root, "tools/legacy-import/m4-launch.mjs"));
  write("package.json", "{}");
  write("package-lock.json", '{"lockfileVersion":3}');
  write("packages/db/package.json", '{"name":"@studenthub/db"}');
  write(".gitignore", "dist/\nnode_modules/\npackages/*/dist/\n");
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.email=t@example.test", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git("init", "-q");
  git("add", "-A");
  git("commit", "--no-gpg-sign", "-qm", "synthetic");
  // The built and installed runtime: ignored, as after `npm ci --ignore-scripts && npm run build`.
  write("dist/tools/legacy-import/src/m4-cli.js", `import { appendFileSync, writeFileSync } from "node:fs";
appendFileSync(${JSON.stringify(loaded)}, "loaded\\n");
export const defaultDeps = (env, built) => ({ env, built });
export async function main(argv, deps) {
  writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv, built: deps.built }));
  return 0;
}
`);
  write("dist/tools/legacy-import/src/m4-run.js", "export {};\n");
  write("packages/db/dist/import/index.js", "export {};\n");
  write("node_modules/pg/package.json", '{"name":"pg","version":"8.0.0"}');
  write("node_modules/pg/lib/index.js", "module.exports = {};\n");
  mkdirSync(path.join(root, "node_modules/@studenthub"), { recursive: true });
  symlinkSync("../../packages/db", path.join(root, "node_modules/@studenthub/db"));
  return { root, head: git("rev-parse", "HEAD"), loaded, out, scratch };
}

const remove = (c: Checkout) => { chmodTree(c.scratch, true); rmSync(c.scratch, { recursive: true, force: true }); };

function run(c: Checkout, argv: string[], env: Record<string, string> = {}, nodeArgs: string[] = []) {
  const r = spawnSync(process.execPath, [...nodeArgs, path.join(c.root, "tools/legacy-import/m4-launch.mjs"), ...argv],
    { cwd: c.scratch, encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

const LINE = /^m4 provenance source=(\S+) head=([0-9a-f]{40}|none) clean=(true|false) platform=(\S+) node=(\S+) artifact=([0-9a-f]{64}|incomplete)$/;

function pin(c: Checkout): string {
  const r = run(c, ["provenance", "--expect", c.head, "--source", "test"]);
  assert.equal(r.status, 0, r.stdout);
  const match = LINE.exec(r.stdout);
  assert.ok(match, r.stdout);
  assert.deepEqual([match[1], match[2], match[3], match[4]], ["test", c.head, "true", `${process.platform}-${process.arch}-node${process.versions.node.split(".")[0]}`]);
  return match[6]!;
}

const approved = (c: Checkout, digest: string) => ({ M4_REVISION: c.head, M4_ARTIFACT_DIGEST: digest });

test("a pin is issued only for a clean, complete build of exactly the declared commit", () => {
  const c = checkout();
  try {
    const digest = pin(c);
    assert.equal(pin(c), digest);
    // Without the declared commit, or for another one, the line is printed but nothing is issued.
    for (const argv of [["provenance"], ["provenance", "--expect", "b".repeat(40)], ["provenance", "--expect", "HEAD"]]) {
      const r = run(c, argv);
      assert.equal(r.status, 1, argv.join(" "));
      assert.match(r.stdout, LINE);
    }
    writeFileSync(path.join(c.root, "package.json"), '{"changed":true}');
    assert.equal(run(c, ["provenance", "--expect", c.head]).status, 1, "dirty tracked file");
    writeFileSync(path.join(c.root, "package.json"), "{}");
    writeFileSync(path.join(c.root, "notes.txt"), "untracked\n");
    assert.equal(run(c, ["provenance", "--expect", c.head]).status, 1, "untracked file");
    assert.equal(existsSync(c.loaded), false);
  } finally { remove(c); }
  // A runtime missing a required part has no digest at all.
  for (const rel of ["node_modules", "dist/tools/legacy-import/src/m4-cli.js", "package-lock.json"]) {
    const c2 = checkout();
    try {
      rmSync(path.join(c2.root, rel), { recursive: true });
      const r = run(c2, ["provenance", "--expect", c2.head]);
      assert.equal(r.status, 1, rel);
      assert.match(r.stdout, /artifact=incomplete$/, rel);
    } finally { remove(c2); }
  }
});

test("a verified, read-only runtime loads the importer once and hands it the verified provenance", () => {
  const c = checkout();
  try {
    const digest = pin(c);
    chmodTree(c.root, false);
    const r = run(c, ["plan"], approved(c, digest));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(c.loaded, "utf8"), "loaded\n");
    assert.deepEqual(JSON.parse(readFileSync(c.out, "utf8")), { argv: ["plan"], built: { head: c.head, clean: true, artifact: digest, readOnly: true } });
  } finally { remove(c); }
});

test("a missing or mismatched runtime, a wrong commit, a writable tree or a changed file refuses before the importer loads", () => {
  type Change = (c: Checkout, digest: string) => Record<string, string>;
  const same: Change = (c, d) => approved(c, d);
  const cases: { name: string; change: Change; writable?: boolean }[] = [
    { name: "no pin", change: (c) => ({ M4_REVISION: c.head }) },
    { name: "malformed pin", change: (c) => ({ M4_REVISION: c.head, M4_ARTIFACT_DIGEST: "nope" }) },
    { name: "other pin", change: (c) => approved(c, "f".repeat(64)) },
    { name: "other revision", change: (_c, d) => ({ M4_REVISION: "b".repeat(40), M4_ARTIFACT_DIGEST: d }) },
    { name: "no revision", change: (_c, d) => ({ M4_ARTIFACT_DIGEST: d }) },
    { name: "entrypoint missing", change: (c, d) => { rmSync(path.join(c.root, "dist/tools/legacy-import/src/m4-cli.js")); return same(c, d); } },
    { name: "built file changed", change: (c, d) => { writeFileSync(path.join(c.root, "dist/tools/legacy-import/src/m4-run.js"), "export const x = 1;\n"); return same(c, d); } },
    { name: "built file added", change: (c, d) => { writeFileSync(path.join(c.root, "dist/extra.js"), "\n"); return same(c, d); } },
    { name: "workspace build changed", change: (c, d) => { writeFileSync(path.join(c.root, "packages/db/dist/import/index.js"), "export const y = 1;\n"); return same(c, d); } },
    // Node resolves from packages/db/dist through packages/db/node_modules before the root tree.
    { name: "workspace dependency tree", change: (c, d) => {
      mkdirSync(path.join(c.root, "packages/db/node_modules/pg"), { recursive: true });
      writeFileSync(path.join(c.root, "packages/db/node_modules/pg/index.js"), "module.exports = { shadow: true };\n");
      return same(c, d);
    } },
    { name: "dependency tree beside dist", change: (c, d) => { mkdirSync(path.join(c.root, "dist/node_modules/pg"), { recursive: true }); writeFileSync(path.join(c.root, "dist/node_modules/pg/index.js"), "\n"); return same(c, d); } },
    { name: "ignored file elsewhere", change: (c, d) => { writeFileSync(path.join(c.root, "packages/db/dist/import/.env"), "X=1\n"); return same(c, d); } },
    { name: "installed package changed", change: (c, d) => { writeFileSync(path.join(c.root, "node_modules/pg/lib/index.js"), "module.exports = { patched: true };\n"); return same(c, d); } },
    { name: "installed package missing", change: (c, d) => { rmSync(path.join(c.root, "node_modules/pg"), { recursive: true }); return same(c, d); } },
    { name: "workspace link moved", change: (c, d) => { rmSync(path.join(c.root, "node_modules/@studenthub/db")); symlinkSync("../../elsewhere", path.join(c.root, "node_modules/@studenthub/db")); return same(c, d); } },
    { name: "node_modules missing", change: (c, d) => { rmSync(path.join(c.root, "node_modules"), { recursive: true }); return same(c, d); } },
    { name: "tracked file changed", change: (c, d) => { writeFileSync(path.join(c.root, "package.json"), '{"changed":true}'); return same(c, d); } },
    { name: "untracked file", change: (c, d) => { writeFileSync(path.join(c.root, "notes.txt"), "x\n"); return same(c, d); } },
    { name: "launcher changed", change: (c, d) => { writeFileSync(path.join(c.root, "tools/legacy-import/m4-launch.mjs"), readFileSync(LAUNCHER, "utf8") + "\n// edited\n"); return same(c, d); } },
    { name: "not a git checkout", change: (c, d) => { rmSync(path.join(c.root, ".git"), { recursive: true }); return same(c, d); } },
    { name: "writable tree", change: same, writable: true },
    { name: "one writable file", change: (c, d) => { chmodTree(c.root, false); chmodSync(path.join(c.root, "node_modules/pg/lib/index.js"), 0o644); return same(c, d); }, writable: true },
  ];
  for (const k of cases) {
    const c = checkout();
    try {
      const env = k.change(c, pin(c));
      if (!k.writable) chmodTree(c.root, false);
      for (const mode of ["plan", "write"]) {
        const r = run(c, [mode], env);
        assert.equal(r.status, 2, `${k.name} ${mode}: ${r.stderr}`);
        assert.equal(r.stderr, "m4: refused.provenance", k.name);
        assert.equal(existsSync(c.loaded), false, `${k.name}: the importer was loaded`);
      }
    } finally { remove(c); }
  }
});

test("a Node start with a preload, loader or module path override refuses before anything is read", () => {
  const c = checkout();
  try {
    const digest = pin(c);
    chmodTree(c.root, false);
    const preload = path.join(c.scratch, "preload.cjs");
    writeFileSync(preload, "require('node:fs').appendFileSync(process.env.MARK, 'preloaded\\n');\n");
    // A preload runs before any script, so the launcher cannot stop it running; it refuses to go on.
    const env = { ...approved(c, digest), MARK: path.join(c.scratch, "preloaded.txt") };
    for (const [label, extraEnv, nodeArgs] of [
      ["--require", {}, ["--require", preload]],
      ["--import", {}, ["--import", `data:text/javascript,`]],
      ["NODE_OPTIONS", { NODE_OPTIONS: "--no-warnings" }, []],
      ["NODE_PATH", { NODE_PATH: c.scratch }, []],
    ] as const) {
      const r = run(c, ["write"], { ...env, ...extraEnv }, [...nodeArgs]);
      assert.equal(r.status, 2, label);
      assert.equal(r.stderr, "m4: refused.startup", label);
      assert.equal(existsSync(c.loaded), false, label);
    }
  } finally { remove(c); }
});

test("a runtime file that cannot be read refuses as provenance, before the importer loads", (t) => {
  if (process.getuid?.() === 0) { t.skip("root reads any file"); return; }
  const c = checkout();
  const file = path.join(c.root, "dist/tools/legacy-import/src/m4-run.js");
  try {
    const digest = pin(c);
    chmodTree(c.root, false);
    chmodSync(file, 0o000);
    const r = run(c, ["write"], approved(c, digest));
    assert.deepEqual([r.status, r.stderr], [2, "m4: refused.provenance"]);
    assert.equal(existsSync(c.loaded), false);
  } finally { chmodSync(file, 0o444); remove(c); }
});

test("the importer module is not an entry point: run directly, it does nothing", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "m4-direct-"));
  try {
    const r = spawnSync(process.execPath, [path.join(REPO, "dist/tools/legacy-import/src/m4-cli.js"), "write"],
      { cwd: scratch, encoding: "utf8", env: { PATH: process.env.PATH, M4_OUTPUT_DIR: path.join(scratch, "out") } });
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""]);
    assert.equal(existsSync(path.join(scratch, "out")), false);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("the real checkout's runtime is complete", () => {
  const r = spawnSync(process.execPath, [LAUNCHER, "provenance"], { cwd: REPO, encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.match(r.stdout.trim(), LINE);
  assert.doesNotMatch(r.stdout, /artifact=incomplete/);
});

test("the digest covers the runtime it was installed for, and a load needs every check to hold", async () => {
  const launcher = await import(pathToFileURL(LAUNCHER).href) as {
    platformKey(): string;
    runtimeManifest(root: string): { lines: string[] };
    runtimeDigest(root: string): { digest: string | null };
    verified(built: Record<string, unknown>, env: Record<string, string>): boolean;
  };
  const c = checkout();
  try {
    pin(c);
    const { lines } = launcher.runtimeManifest(c.root);
    const expected = createHash("sha256").update([`platform\0${launcher.platformKey()}`, ...lines].join("\n")).digest("hex");
    assert.equal(launcher.runtimeDigest(c.root).digest, expected);
    assert.notEqual(expected, createHash("sha256").update(lines.join("\n")).digest("hex"));
  } finally { remove(c); }
  const head = "a".repeat(40);
  const artifact = "b".repeat(64);
  const env = { M4_REVISION: head, M4_ARTIFACT_DIGEST: artifact };
  const good = { head, clean: true, artifact, readOnly: true };
  assert.equal(launcher.verified(good, env), true);
  for (const change of [{ head: "c".repeat(40) }, { clean: false }, { artifact: "d".repeat(64) }, { artifact: null }, { readOnly: false }]) {
    assert.equal(launcher.verified({ ...good, ...change }, env), false, JSON.stringify(change));
  }
  assert.equal(launcher.verified(good, { ...env, M4_REVISION: "" }), false);
  assert.equal(launcher.verified({ ...good, artifact: "" }, { ...env, M4_ARTIFACT_DIGEST: "" }), false);
});
