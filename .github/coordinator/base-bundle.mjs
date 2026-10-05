import fs from "node:fs";
import path from "node:path";

export class BaseBundleUnavailableError extends Error {
  constructor(root, bundlePath, cause) {
    super(`BASE_BUNDLE_UNAVAILABLE: configured SHU_WORKSPACE_STATE_DIR=${JSON.stringify(root ?? null)}; bundle=${JSON.stringify(bundlePath)}; ${cause.message}`, { cause });
    this.name = "BaseBundleUnavailableError";
    this.code = this.workspaceCode = "BASE_BUNDLE_UNAVAILABLE";
  }
}

// Single location contract for creation and reconstruction. Adapter session
// roots are deliberately not inputs: they may differ from workspace state.
export function baseBundlePath(env, attemptId, { mustExist = false } = {}) {
  const root = env.SHU_WORKSPACE_STATE_DIR;
  let bundlePath = null;
  try {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(attemptId ?? "")) throw new Error("invalid attempt identity");
    if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("workspace state root must be absolute");
    bundlePath = path.join(root, `${attemptId}.base.bundle`);
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(root) !== path.resolve(root) || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
      throw new Error("workspace state root must be canonical, private and coordinator-owned");
    }
    if (mustExist) {
      const bundle = fs.lstatSync(bundlePath);
      if (!bundle.isFile() || bundle.isSymbolicLink() || bundle.uid !== process.getuid() || (bundle.mode & 0o077)) throw new Error("bundle must be private and coordinator-owned");
    }
    return bundlePath;
  } catch (cause) { throw new BaseBundleUnavailableError(root, bundlePath, cause); }
}
