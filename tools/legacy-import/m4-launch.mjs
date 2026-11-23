#!/usr/bin/env node
// M-4 importer launcher: the only way to run the M-4 importer. Using node builtins only, it
// verifies everything Node could load before any application module is evaluated:
//   1. a clean Node start: no command-line flags, no NODE_OPTIONS, NODE_PATH or other preload or
//      loader settings (`refused.startup`);
//   2. this checkout is a git checkout whose HEAD is M4_REVISION, with no tracked file changed and
//      no untracked file outside .gitignore (so this launcher itself is the reviewed one);
//   3. the runtime manifest, every file and symlink in the checkout outside .git (sources, the
//      built dist trees, every node_modules tree wherever it sits, the lockfile), together with
//      the platform, architecture and Node major version, hashes to M4_ARTIFACT_DIGEST: the digest
//      the "M-4 importer build pin" workflow issued for that same commit after
//      `npm ci --ignore-scripts` and `npm run build`. Anything extra, such as a dependency tree
//      under a workspace, changes the digest and is refused;
//   4. the checkout is read-only: no file or directory in it has a write bit, so the verified
//      tree cannot be changed between hashing and loading without first changing its modes.
// Only then does it import the importer and hand it the verified provenance. A failure of 2-4
// prints `m4: refused.provenance` (exit 2) and loads nothing.
//
//   node tools/legacy-import/m4-launch.mjs provenance [--expect <sha>] [--source <label>]
//        prints the pin line; exits 0 only for a clean, complete build whose HEAD is <sha>
//   node tools/legacy-import/m4-launch.mjs plan|write
//        verify, then run the importer

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ENTRYPOINT = "dist/tools/legacy-import/src/m4-cli.js";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// Not part of what Node loads: git's own store, and npm's record of the install it wrote.
const SKIP = new Set([".git", "node_modules/.package-lock.json"]);
// Environment settings that change how Node starts or resolves modules.
const STARTUP_ENV = ["NODE_OPTIONS", "NODE_PATH", "NODE_LOADER", "NODE_REPL_EXTERNAL_MODULE", "NODE_COMPILE_CACHE"];

/** What the digest is specific to besides the files: the runtime the tree was installed for. */
export function platformKey() {
  return `${process.platform}-${process.arch}-node${process.versions.node.split(".")[0]}`;
}

/**
 * The runtime manifest: one line per file (sha256) or symlink (target) in the checkout outside
 * .git, sorted by path, plus whether any of them is writable by mode.
 */
export function runtimeManifest(root) {
  const lines = [];
  const writable = [];
  const visit = (rel) => {
    if (SKIP.has(rel)) return;
    const full = rel === "" ? root : path.join(root, rel);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) { lines.push(`${rel}\0link\0${readlinkSync(full)}`); return; }
    if ((stat.mode & 0o222) !== 0) writable.push(rel || ".");
    if (stat.isDirectory()) {
      for (const name of readdirSync(full).sort()) visit(rel === "" ? name : `${rel}/${name}`);
    } else if (stat.isFile()) {
      lines.push(`${rel}\0file\0${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
    } else {
      lines.push(`${rel}\0other\0`);
    }
  };
  visit("");
  lines.sort();
  return { lines, writable };
}

export function runtimeDigest(root) {
  const { lines, writable } = runtimeManifest(root);
  const has = (rel) => lines.some((l) => l.startsWith(`${rel}\0`));
  const missing = [ENTRYPOINT, "package-lock.json"].filter((rel) => !has(rel));
  if (!lines.some((l) => l.startsWith("node_modules/"))) missing.push("node_modules");
  const digest = missing.length > 0 ? null
    : createHash("sha256").update([`platform\0${platformKey()}`, ...lines].join("\n")).digest("hex");
  return { digest, files: lines.length, missing, writable };
}

export function provenance(root) {
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { PATH: process.env.PATH, LANG: "C" } });
  const head = git(["rev-parse", "HEAD"]);
  // Untracked files count: only ignored build and install output may sit beside the tracked tree.
  const status = git(["status", "--porcelain", "--untracked-files=normal"]);
  const runtime = runtimeDigest(root);
  return {
    head: head.status === 0 && /^[0-9a-f]{40}\n?$/.test(head.stdout) ? head.stdout.trim() : null,
    clean: status.status === 0 && status.stdout.trim() === "",
    artifact: runtime.digest,
    readOnly: runtime.writable.length === 0,
  };
}

/** A clean Node start: nothing preloaded, no loader, no module path override. */
export function cleanStart(execArgv, env) {
  return execArgv.length === 0 && STARTUP_ENV.every((name) => env[name] === undefined || env[name] === "");
}

/** Whether the runtime may be loaded for this approval. */
export function verified(built, env) {
  return /^[0-9a-f]{40}$/.test(env.M4_REVISION ?? "") && /^[0-9a-f]{64}$/.test(env.M4_ARTIFACT_DIGEST ?? "")
    && built.head === env.M4_REVISION && built.clean === true && built.artifact === env.M4_ARTIFACT_DIGEST
    && built.readOnly === true;
}

const option = (argv, name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

async function launch(argv, env, execArgv) {
  if (argv[0] !== "provenance" && !cleanStart(execArgv, env)) {
    console.error("m4: refused.startup");
    return 2;
  }
  // A runtime that cannot even be read is a refusal, not a crash.
  let built;
  try { built = provenance(ROOT); } catch { built = { head: null, clean: false, artifact: null, readOnly: false }; }
  if (argv[0] === "provenance") {
    const expect = option(argv, "--expect");
    const source = option(argv, "--source") ?? "local";
    console.log(`m4 provenance source=${source} head=${built.head ?? "none"} clean=${built.clean} platform=${platformKey()} node=${process.versions.node} artifact=${built.artifact ?? "incomplete"}`);
    // A pin is issued only for a clean, complete build of exactly the declared commit.
    const issued = Boolean(built.head && built.clean && built.artifact && /^[0-9a-f]{40}$/.test(expect ?? "") && built.head === expect);
    return issued ? 0 : 1;
  }
  if (!verified(built, env)) {
    console.error("m4: refused.provenance");
    return 2;
  }
  const cli = await import(pathToFileURL(path.join(ROOT, ENTRYPOINT)).href);
  return cli.main(argv, cli.defaultDeps(env, built));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  launch(process.argv.slice(2), process.env, process.execArgv).then((code) => { process.exitCode = code; }, () => {
    console.error("m4: m4.failed");
    process.exitCode = 1;
  });
}
