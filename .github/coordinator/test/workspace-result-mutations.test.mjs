import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

// Mutate independent copies of the current source; never checkout/reset the
// implementation under test. Every probe must fail an assertion, not syntax.
const mutations = [
  ["M1 callback before commit", "adapters/codex-cli.mjs", 'if (!callbackValid(callback, { attempt_id, target_sha })) {', 'if (false) {', "callback is bound"],
  ["M2 worker Git directory", "workspace-result.mjs", '"--git-dir", dir, "--work-tree", worktree', '"--git-dir", path.join(worktree,".git"), "--work-tree", worktree', "filters, hooks"],
  ["M3 worker index", "workspace-result.mjs", 'const indexFile = path.join(dir, "snapshot-index");', 'const indexFile = path.join(worktree, ".git/index");', "filters, hooks"],
  ["M4 wrong parent", "workspace-result.mjs", 'tree, "-p", target_sha,', 'tree,', "host commits raw files"],
  ["M5 empty result", "workspace-result.mjs", 'if (tree === original) throw', 'if (false) throw', "refuses empty"],
  ["M6 dirty race", "push-broker.mjs", '} else if (workspaceReady) {', '} else if (workspaceReady) { cleanOk = true; } else if (workspaceReady) {', "refuses raced"],
  ["M7 broker HOLD promotion", "adapters/codex-cli.mjs", 'if (push.ok !== true || (workspaceReady && !SHA_RE.test(push.remote_head ?? ""))) {', 'if (false) {', "callback is bound"],
  ["M8 network enabled", "adapters/codex-cli.mjs", 'sandbox_workspace_write.network_access=false', 'sandbox_workspace_write.network_access=true', "model choices"],
  ["M9 nondeterministic retry", "workspace-result.mjs", '`StudentHub worker result ${attempt_id}`', '`StudentHub worker result ${attempt_id} ${randomUUID()}`', "host commits raw files"],
  ["M10 wrong tree", "workspace-result.mjs", 'const tree = (await git("write-tree")).trim();', 'const tree = (await git("rev-parse", `${target_sha}^{tree}`)).trim();', "host commits raw files"],
  ["M11 premium builder", "adapters/codex-cli.mjs", 'CODEX_MODEL = "gpt-5.6-sol"', 'CODEX_MODEL = "gpt-6"', "model choices"],
  ["M12 premium reviewer", "adapters/claude-code.mjs", 'CLAUDE_MODEL = "opus"', 'CLAUDE_MODEL = "fable"', "model choices"],
  ["M13 expiry at publication", "push-broker.mjs", 'if (beforePublish && await beforePublish() !== true) return held("result authorization expired or revoked");\n  } catch', 'if (false) return held("result authorization expired or revoked");\n  } catch', "expiry during snapshot"],
];

for (const [name, file, before, after, pattern] of mutations) {
  test(`SHU-228 mutation: ${name}`, () => {
    const root=fs.mkdtempSync(path.join(tmpdir(),"shu228-mutation-"));
    try {
      fs.cpSync(new URL("../",import.meta.url),root,{recursive:true});
      const target=path.join(root,file), original=fs.readFileSync(target,"utf8");
      assert.equal(original.split(before).length,2,`${name}: mutation anchor must be unique`);
      fs.writeFileSync(target,original.replace(before,after));
      const childEnv={...process.env}; delete childEnv.NODE_TEST_CONTEXT;
      const result=spawnSync(process.execPath,["--test",`--test-name-pattern=${pattern}`,path.join(root,"test/workspace-result.test.mjs")],
        {encoding:"utf8",timeout:20000,env:childEnv});
      assert.equal(result.status,1,`${name} survived or did not run: ${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout+result.stderr,/AssertionError/);
      assert.doesNotMatch(result.stdout+result.stderr,/SyntaxError|ERR_MODULE_NOT_FOUND/);
    } finally { fs.rmSync(root,{recursive:true,force:true}); }
  });
}
