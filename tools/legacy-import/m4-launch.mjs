#!/usr/bin/env node
// M-4 importer launcher: the only way to run the M-4 importer. It verifies the runtime before any
// application module is loaded, using node builtins only:
//   1. this checkout is a git checkout whose HEAD is M4_REVISION, with no tracked file changed
//      (so this launcher itself is the reviewed one);
//   2. the installed runtime (the built dist trees, workspace package manifests, the whole of
//      node_modules as installed, and the lockfile) hashes to M4_ARTIFACT_DIGEST, the digest
//      Platform CI's "Pin the M-4 importer build" step printed for that same commit after
//      `npm ci --ignore-scripts` and `npm run build`; and
//   3. the importer entrypoint is present.
// Only then does it import the importer and hand it the verified provenance. Any failure prints
// `m4: refused.provenance` (exit 2) and loads nothing.
//
//   node tools/legacy-import/m4-launch.mjs provenance      prints head, clean and runtime digest
//   node tools/legacy-import/m4-launch.mjs plan|write      verify, then run the importer
//
// The digest covers file bytes and symlink targets, by path. Node itself is not covered beyond its
// major version, which is part of the digest.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ENTRYPOINT = "dist/tools/legacy-import/src/m4-cli.js";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// Written by npm beside the install, not loaded by Node.
const SKIP = new Set(["node_modules/.package-lock.json", "node_modules/.cache"]);

/** The installed runtime's manifest: one line per file or link, sorted by path. */
export function runtimeManifest(root) {
  const lines = new Set();
  const missing = [];
  const visit = (rel) => {
    if (SKIP.has(rel)) return;
    let stat;
    try { stat = lstatSync(path.join(root, rel)); } catch { missing.push(rel); return; }
    if (stat.isSymbolicLink()) lines.add(`${rel}\0link\0${readlinkSync(path.join(root, rel))}`);
    else if (stat.isDirectory()) for (const name of readdirSync(path.join(root, rel)).sort()) visit(`${rel}/${name}`);
    else if (stat.isFile()) lines.add(`${rel}\0file\0${createHash("sha256").update(readFileSync(path.join(root, rel))).digest("hex")}`);
  };
  for (const rel of ["package.json", "package-lock.json", ENTRYPOINT, "dist", "node_modules"]) visit(rel);
  let packages = [];
  try { packages = readdirSync(path.join(root, "packages")).sort(); } catch { missing.push("packages"); }
  // Workspace packages with their own manifest and build; the others compile into dist/.
  const present = (rel) => { try { lstatSync(path.join(root, rel)); return true; } catch { return false; } };
  for (const name of packages) {
    for (const rel of [`packages/${name}/package.json`, `packages/${name}/dist`]) if (present(rel)) visit(rel);
  }
  return { lines: [...lines].sort(), missing };
}

export function runtimeDigest(root) {
  const { lines, missing } = runtimeManifest(root);
  if (missing.length > 0) return { digest: null, files: lines.length, missing };
  const node = `node-major\0${process.versions.node.split(".")[0]}`;
  return { digest: createHash("sha256").update([node, ...lines].join("\n")).digest("hex"), files: lines.length, missing: [] };
}

export function provenance(root) {
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { PATH: process.env.PATH, LANG: "C" } });
  const head = git(["rev-parse", "HEAD"]);
  const status = git(["status", "--porcelain", "--untracked-files=no"]);
  return {
    head: head.status === 0 && /^[0-9a-f]{40}\n?$/.test(head.stdout) ? head.stdout.trim() : null,
    clean: status.status === 0 && status.stdout.trim() === "",
    artifact: runtimeDigest(root).digest,
  };
}

/** Whether the runtime may be loaded for this approval. */
export function verified(built, env) {
  return /^[0-9a-f]{40}$/.test(env.M4_REVISION ?? "") && /^[0-9a-f]{64}$/.test(env.M4_ARTIFACT_DIGEST ?? "")
    && built.head === env.M4_REVISION && built.clean && built.artifact === env.M4_ARTIFACT_DIGEST;
}

async function launch(argv, env) {
  const built = provenance(ROOT);
  if (argv[0] === "provenance") {
    console.log(`m4 provenance head=${built.head ?? "none"} clean=${built.clean} artifact=${built.artifact ?? "incomplete"}`);
    return built.head && built.artifact ? 0 : 1;
  }
  if (!verified(built, env)) {
    console.error("m4: refused.provenance");
    return 2;
  }
  const cli = await import(pathToFileURL(path.join(ROOT, ENTRYPOINT)).href);
  return cli.main(argv, cli.defaultDeps(env, built));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  launch(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; }, () => {
    console.error("m4: m4.failed");
    process.exitCode = 1;
  });
}
