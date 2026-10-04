// A REF WRITTEN DOWN AS THE GIT TREES THE AUTHORITY CHECK WALKS, for the two suites that need one.
//
// ../authority-scope.mjs reads `GET /repos/{repo}/git/trees/{sha}` and walks the root tree down to `.github`
// and `.github/workflows`, so a world it can be asked about is three tree responses per ref. Both the
// authority-scope suite and the emitter's world need exactly that shape, and they needed it to agree on what
// `mode` and `truncated` mean - so it is built once here rather than twice, for the same reason the decision
// itself lives in one module with two callers.
//
// SUBTREE IDS ARE DERIVED FROM THE CONTENTS, as git derives them. Two refs describing the same `.github` name
// the same tree id, so the module fetches it once and the dedupe it does is exercised rather than asserted
// about. The flags are folded into the id too: a ref whose `.github` the API will not serve must not collide
// with an identical one it will.
import crypto from 'node:crypto';

export const TREE_MODE = '040000';
export const FILE_MODE = '100644';
export const EXEC_MODE = '100755';
export const WORKFLOW_SHA = '1a'.repeat(20);
export const DIRECTORY_SHA = '2b'.repeat(20);
export const OTHER_WORKFLOW_SHA = '3c'.repeat(20);

const idOf = (...parts) => crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex');

// `treesFor(ref, options)` returns `{ [treeish]: <trees response body> }` for one ref: the root tree under the
// ref's own name, `.github`, and `.github/workflows`. Options:
//
//   workflow      - the object id of `.github/workflows/verifier-receipt.yml`, or null for "not there"
//   workflowMode  - its file mode, which is part of the comparison: `chmod +x` moves this and not the id
//   directory     - the object id of `.github/verifier-receipt`, or null for "not there"
//   directoryMode - its file mode
//   directoryType - 'tree', or 'blob' for a candidate that puts a FILE where the directory was
//   fill          - extra entries in `.github`, for a response that is long without being cut off
//   workflowsFill - extra entries in `.github/workflows`, e.g. the name a rename moved the authority to
//   unreadable    - paths ('' for the root, '.github', '.github/workflows') whose tree this ref does not serve
//   truncated     - paths whose response says `"truncated": true`
export const treesFor = (ref, {
  workflow = WORKFLOW_SHA, workflowMode = FILE_MODE,
  directory = DIRECTORY_SHA, directoryMode = TREE_MODE, directoryType = 'tree',
  fill = [], workflowsFill = [], unreadable = [], truncated = [],
} = {}) => {
  const salt = [unreadable, truncated];
  const workflows = [
    { path: 'ci.yml', mode: FILE_MODE, type: 'blob', sha: OTHER_WORKFLOW_SHA },
    ...workflowsFill,
    ...(workflow === null ? []
      : [{ path: 'verifier-receipt.yml', mode: workflowMode, type: 'blob', sha: workflow }]),
  ];
  const workflowsId = idOf('.github/workflows', workflows, salt);
  const dotGithub = [
    { path: 'coordinator', mode: TREE_MODE, type: 'tree', sha: '4d'.repeat(20) },
    ...fill,
    ...(directory === null ? []
      : [{ path: 'verifier-receipt', mode: directoryMode, type: directoryType, sha: directory }]),
    { path: 'workflows', mode: TREE_MODE, type: 'tree', sha: workflowsId },
  ];
  const dotGithubId = idOf('.github', dotGithub, salt);
  const root = [
    { path: 'README.md', mode: FILE_MODE, type: 'blob', sha: '8b'.repeat(20) },
    { path: '.github', mode: TREE_MODE, type: 'tree', sha: dotGithubId },
  ];

  const bodies = {};
  const put = (at, treeish, tree) => {
    // A tree this ref does not serve is OMITTED, so the endpoint 404s exactly as the API does for a sha it will
    // not serve - rather than being served as some other shape the module might read past.
    if (unreadable.includes(at)) return;
    bodies[treeish] = { sha: treeish, truncated: truncated.includes(at), tree };
  };
  put('', ref, root);
  put('.github', dotGithubId, dotGithub);
  put('.github/workflows', workflowsId, workflows);
  return bodies;
};
