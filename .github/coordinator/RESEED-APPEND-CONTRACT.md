# Deterministic reseed append contract

This is repository-only preparation. No live reseed, signing facility, network
client, host access, or activation-package modification is provided by this
module. The host supplies the Git adapter and the approved execution revision.
The existing activation mechanism continues to validate the signed package.

## Surface and binding

`reseed-append-contract.mjs` exports:

- Frozen constants: `RESEED_IDENTITY`, `RESEED_TIMESTAMP`, `RESEED_TIMEZONE`,
  `RESEED_MESSAGE`, `SEALED_SEED_BLOBS`. Scalar constants are immutable primitives;
  the identity and sealed mapping are frozen objects.
- `createGitAdapter(repo)`: synchronous Buffer-returning Git runner with an
  explicit repository, sanitized environment, no shell and sanitized failures.
- `readTreeState(git, tree, options)`, `canonicalManifest(before, after)`,
  `manifestDigest(manifest)`, `serializeReseedCommit(tree, parent, revision)`.
- `precomputeReseedBinding({ git, branch, expected_parent,
  approvedExecutionRevision, sealed = SEALED_SEED_BLOBS })`.
- `verifyReseedCommit({ git, binding, oid, sealed = SEALED_SEED_BLOBS })`.
- `createReseedAppendIo({ git, binding, sealed = SEALED_SEED_BLOBS })`, returning
  exactly `{ appendReseed, observeReseed }`.

The binding is an immutable object containing `branch`, `expected_parent`,
`approvedExecutionRevision`, `tree`, `expected_seed_head`, `patch_sha256`, and
`manifest_hex`. Hex preserves raw manifest bytes through JSON storage. Retain the
reviewed binding alongside the package. Its revision must be the package's
approved execution revision. Copy only `expected_seed_head` and `patch_sha256`
into the existing seven-field reseed plan; do not add fields to that plan.
The factory snapshots the binding and sealed mapping; treat the runner and
sealed policy as trusted host dependencies. Production uses the default seals;
custom seals allow isolated fixture testing, not authority discovery.

Both adapter methods accept the existing reseed plan and return exactly:

```js
{ before, after, parent, patch_sha256, forced: false }
```

`before` and `parent` are `expected_parent`; `after` is `expected_seed_head`.
`observeReseed` is read-only recovery: it verifies the actual ref and complete
commit rather than inferring success from installed, unreachable objects.

## Manifest

The implementation's encoding is:

```js
// status NUL path NUL old_mode NUL old_oid NUL new_mode NUL new_oid NUL
const fields = [status, raw, a?.mode ?? '000000', a?.oid ?? ZERO, b?.mode ?? '000000', b?.oid ?? ZERO];
for (const field of fields) parts.push(Buffer.from(field), Buffer.from('\0'));
```

All changed leaf paths are sorted by `Buffer.compare`. Status is only A, D or M.
A rename is a deletion plus an addition. Unchanged entries are omitted. Each
present mode is exactly 100644, 100755 or 120000; an absent side has mode 000000
and forty ASCII zeroes for its OID. Paths remain raw bytes, including tabs,
newlines and invalid UTF-8. There is no header, timestamp, revision, escaping,
textual diff, rename detection, locale sorting, or Git version in the digest.
SHA-256 is lowercase hex over these bytes alone.

Recursive tree enumeration includes traversal records to detect empty trees.
Nonempty directories are structural path prefixes, not manifest entries. Empty
trees cannot be represented by the supported leaf modes and are refused, as are
gitlinks and every unsupported mode supplied directly to the manifest builder.

The test's self-contained `independentDigest` walks the raw-byte-sorted union,
compares the two states, and feeds the six fields individually to Node's SHA-256
with `Uint8Array([0])` separators. It calls no production manifest or digest
function. Evaluating only this independent function on the following synthetic
transition produced the committed literal:

- Before: `gone`, mode 100644, OID forty `1`s; `z`, mode 100644, forty `2`s.
- After: `a` followed by TAB and LF, mode 120000, forty `4`s; `z`, mode 100755,
  forty `3`s.
- Literal: `23fd85b37240a6b4840999ae0861ac7aad7b6e789bcbea4d8f958de59be9d750`.

The independent implementation also checks the resulting real Git tree pairs.

## Deterministic commit

Identity for both author and committer is exactly
`shu-coordinator <shu-coordinator@bawes.local>`. Unix seconds are `1735689600`
(2025-01-01T00:00:00Z); timezone is `+0000`. The message is exactly
`Append approved execution revision to sealed seed.\n` (one trailing LF).

Bytes are UTF-8, without additional headers:

```text
tree <tree>\n
parent <expected_parent>\n
parent <approvedExecutionRevision>\n
author shu-coordinator <shu-coordinator@bawes.local> 1735689600 +0000\n
committer shu-coordinator <shu-coordinator@bawes.local> 1735689600 +0000\n
\n
Append approved execution revision to sealed seed.\n
```

The displayed `\n` denotes the newline ending each line, not literal backslash
bytes or an additional newline. Git's commit OID hashes the object framing
`commit <byte-length>\0` followed by these bytes. It is not the raw SHA-1 of the
unframed bytes. Only SHA-1 repositories are supported; other object formats are
refused before precomputation or append.

## Ordering and crash behavior

1. **Before signing:** verify the branch head, create an external `mkdtemp`
   object directory, and run `merge-tree --write-tree` with
   `GIT_OBJECT_DIRECTORY` pointing there and `GIT_ALTERNATE_OBJECT_DIRECTORIES`
   pointing at the repository's own object database. Resolve that database with
   `rev-parse --git-path` to support linked worktrees too. Read both trees, check
   seals, compute manifest/digest and serialize the commit. Use
   `hash-object -t commit --stdin` without `-w` to obtain the exact commit OID.
   Always remove temporary storage, including on conflict. No ref, repository
   object or worktree file is changed.
2. **At the authorized append window:** rerun the merge into the real object
   database and require the bound tree. Install the serialized commit with
   `hash-object -t commit -w --stdin`. Require its OID to equal the bound OID.
   Independently read and verify parents, metadata, trees, manifest, digest,
   seals and SHA. Check the first parent is an ancestor.
3. Perform exactly one `git update-ref <ref> <expected_seed_head>
   <expected_parent>` compare-and-swap. Its compare operand is the previously
   observed head. There is no force option, rebase or history rewrite.
4. Read the ref again and reverify the commit, ordered parents, tree, complete
   manifest, digest, metadata and seals before returning the exact IO result.

Objects are not history. Installing them before CAS ensures the new ref can
never point at an uninstalled commit. A crash between installation and CAS leaves
only unreachable, garbage-collectable objects and an unchanged ref. A failed CAS
leaves the ref at its prior value and is refused; no rollback or second ref
update is attempted. A post-CAS verification failure also refuses rather than
rewriting history. A lost successful response can be recovered by observation.
The host must coordinate concurrent writers; this contract cannot prevent an
independent writer from moving a ref after verification.

The merge algorithm itself can differ between Git versions or configuration.
The manifest encoding is version-independent for identical tree states; append
must refuse if a later merge yields a different tree or commit than the reviewed
binding. Local repository configuration is trusted input, not a sandbox.

## Refusals

Errors contain only their `SHU71_RESEED_*` code as both message and `code`, never
Git stderr, file contents or secret material. Tests exercise all twelve codes:
`PARENT_MISMATCH`, `UNEXPECTED_PARENT`, `UNEXPECTED_TREE`, `UNEXPECTED_PATH`,
`DIGEST_MISMATCH`, `RESULT_SHA_MISMATCH`, `METADATA_DRIFT`, `SEED_BLOB_CHANGED`,
`NOT_APPEND_ONLY`, `UNSUPPORTED_MODE`, `CONFLICT`, and `HASH_ALGORITHM`.

The four default seals were verified with `git ls-tree -r` at
`fb4d14b9adbea97c87b23ece831e01e61809e7a6`. All four supplied blob IDs match;
no correction is required. Tests import those blobs read-only into temporary
repositories and compare their bytes before and after append.

## Mutation controls

Each mutant has exactly one unique textual replacement and passes `node --check`.
Each matched original run must pass exactly one selected test. Each mutant must
exit 1 with exactly one failure, `code: 'ERR_ASSERTION'`,
`failureType: 'testCodeFailure'`, and the named assertion below. SyntaxError,
TypeError and ERR_MODULE_NOT_FOUND invalidate a kill.

| Mutation | Named assertion |
| --- | --- |
| M1 changed blob | RESEED blob OIDs retained |
| M2 changed mode | RESEED modes retained |
| M3 changed path | RESEED raw byte order |
| M4 parent | Missing expected exception: RESEED wrong parent refused |
| M5 timestamp | RESEED historical timestamp is fixed |
| M6 message | RESEED message is fixed |
| M7 digest convention | RESEED canonical digest convention |
| M8 extra path | Missing expected exception: RESEED extra path refused |

## Exact mutation AssertionError messages

Captured from the syntax-clean mutants (TAP `error` fields):

### M1 changed blob

```text
  error: |-
    RESEED blob OIDs retained
    + actual - expected

    + '54d68fa83c8f8fe45d64f0c2cbd9356e674ab2d217041804478a430304c02caf'
    - '23fd85b37240a6b4840999ae0861ac7aad7b6e789bcbea4d8f958de59be9d750'

```

### M2 changed mode

```text
  error: |-
    RESEED modes retained
    + actual - expected

    + 'cb7fbfef07f9bc65d9b0203acbeab05adf99b092c5e092723eec38aca4e705be'
    - '23fd85b37240a6b4840999ae0861ac7aad7b6e789bcbea4d8f958de59be9d750'

```

### M3 changed path

```text
  error: |-
    RESEED raw byte order
    + actual - expected

    + '2794e4a78e5f41a95e6ca7e741e573dca62988d9be9f2e45c93af1b91d45a610'
    - 'eb648bb12fb6b555451dcfeb5af59acb6b9b9fbbbed1670ba9a5d425b686577a'

```

### M4 parent

```text
  error: 'Missing expected exception: RESEED wrong parent refused'
```

### M5 timestamp

```text
  error: |-
    RESEED historical timestamp is fixed
    + actual - expected

    + 1735689601
    - 1735689600
               ^

```

### M6 message

```text
  error: |-
    RESEED message is fixed
    + actual - expected

    + 'Different message.\n'
    - 'Append approved execution revision to sealed seed.\n'

```

### M7 digest convention

```text
  error: |-
    RESEED canonical digest convention
    + actual - expected

    + '96b2fb6d1467e86cd26ebfbe5441f2cf23a72b0c54e3f5320bbc63a1258f3bb3'
    - '23fd85b37240a6b4840999ae0861ac7aad7b6e789bcbea4d8f958de59be9d750'

```

### M8 extra path

```text
  error: 'Missing expected exception: RESEED extra path refused'
```

## Integration limitation

No new `runShu71Command("reseed", ...)` success control is claimed. The real
validator verifies two Ed25519 signatures over the package and activation,
including the temporary repository's exact seed SHA. No already-signed package
binding this new synthetic SHA was supplied. The task also forbids signing and
keys. Under that restriction, reaching `RESEEDED` would require bypassing or
changing production signature validation, which this implementation does not do.
The existing full suites run their already-authorized ephemeral signing helpers;
permission to use the same helper in a new integration control was requested but
has not yet been received. Adapter success and observation are exercised against
real temporary repositories; end-to-end package success remains unproven here.

## Added test-name multiset

- `RESEED independent manifest literal and complete transition` (one occurrence)
- `RESEED blob OIDs are load bearing` (one occurrence)
- `RESEED modes are load bearing` (one occurrence)
- `RESEED raw path byte ordering` (one occurrence)
- `RESEED fixed timestamp literal` (one occurrence)
- `RESEED fixed message literal` (one occurrence)
- `RESEED zero footprint precompute and exact append round trip` (one occurrence)
- `RESEED temporary merge takes objects while real store stays unchanged` (one occurrence)
- `RESEED unexpected parents refused` (one occurrence)
- `RESEED extra path refused` (one occurrence)
- `RESEED named refusal matrix` (one occurrence)
- `RESEED bad CAS leaves branch unchanged and unreachable objects harmless` (one occurrence)
- `RESEED dirty binding refused before ref update` (one occurrence)
- `RESEED merge conflict has zero footprint` (one occurrence)
- `RESEED real trees retain binary paths modes symlinks additions and deletions` (one occurrence)
- `RESEED real gitlink empty tree and SHA256 repositories refused` (one occurrence)
- `RESEED all metadata headers and sealed drift refused before CAS` (one occurrence)
- `RESEED linked worktree resolves real object storage without writes` (one occurrence)
- `RESEED mutation M1 changed blob` (one occurrence)
- `RESEED mutation M2 changed mode` (one occurrence)
- `RESEED mutation M3 changed path` (one occurrence)
- `RESEED mutation M4 parent` (one occurrence)
- `RESEED mutation M5 timestamp` (one occurrence)
- `RESEED mutation M6 message` (one occurrence)
- `RESEED mutation M7 digest convention` (one occurrence)
- `RESEED mutation M8 extra path` (one occurrence)

Existing test files are byte-identical to main. Multiset delta: +26 names, -0 names; removed `assert|expect|throw`-matching lines: 0.

## Repository verification

Both final invocations passed on Git 2.43.0 / Node v22.22.3:

```sh
TMPDIR=/tmp node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs
TMPDIR=/tmp SHU_TEST_CLOCK_OFFSET_MS=31536000000 NODE_OPTIONS="--import=$PWD/.github/coordinator/test/fixture/shift-wall-clock.mjs" npm run test:coordinator
```

Each reported **1,233 tests / 1,226 pass / 0 fail / 7 skipped**. Compared with
the supplied main baseline, this adds 26 passing tests, removes none and leaves
all seven existing skips unchanged. Both TAP outputs contain the same 26 new
names, each exactly once. Existing files are unchanged. `git diff --check`
passed; removed `assert|expect|throw`-matching lines versus main: **0**.

`chmod -R go-w .github/coordinator` was applied before verification.
`config.json` was printed before and after and remains byte-identical to main:
`8a0317173d76f4c09811b9365e25b380b38dc93d`. All four additions are inside
`.github/coordinator/`; no workflow or existing mechanism was edited.
