# Rollback discovery contract

Previously `automatic-staging.mjs` began `previous()` with:

```js
const digest = inspect(`${IMAGE}:latest`);
```

It required a valid SHA-256 digest, pulled that digest, read a full lowercase
40-character `/image-source-revision`, matched `status: ok`, `component: gateway`
and the exact revision from staging health, then ran `image-smoke.sh`. It returned:

```js
return { image: IMAGE, digest, pin, revision };
```

The new `rollback-artifact.mjs` contract requires a verified running container
observation before registry discovery. The production reader uses existing SSH
access (`ROLLBACK_SSH_HOST`, an SSH alias, and `ROLLBACK_CONTAINER_ID`, the full
container ID selected by the operator). It performs only host reads: container
inspect, image inspect, and `exec ... cat /image-source-revision`. The container
must be running and healthy, its image ID must match the inspected image, and that
image must have one unambiguous gateway RepoDigest. The container ID, image ID,
start time and health are checked again after reading the revision. Discovery
rechecks running digest/revision after image validation. No host configuration,
known-host update, deployment or registry publication is performed by discovery.

`previous()` is coded as:

```js
const result = await discoverRollback(io);
if (result.outcome !== 'ROLLBACK_READY') fail(`${result.outcome}: ${result.remediation}`);
const { image, digest, pin, revision } = result;
return { image, digest, pin, revision };
```

`ROLLBACK_READY` requires the full `main-<40-character revision>` tag AND the
running digest reference to resolve to the running digest. The pulled image's
embedded revision must match the host revision. All prior health, revision,
digest and image smoke checks remain. Automatic promotion, dispatch gates,
trigger conditions, feature checks and freeze behavior are unchanged.

An explicitly absent manifest returns `ROLLBACK_RUNNING_REVISION_UNTAGGED` from
`discoverRollback()` (and exit 0 from its standalone CLI), with image, revision,
digest, pin, expected tag and remediation. This is a discovery result, never
rollback readiness or deployment success. Authentication, transport, ambiguous
host state, digest mismatch and validation failures fail closed. `previous()`
rejects the untagged result as `PRECONDITION_NOT_MET`, preserving the existing
pre-deployment gate. It never substitutes `latest`.

For the established staging state, revision
`50db30ee3c48b9fe4a056a253cd13992cfaba772` runs at
`sha256:b902332195eae3c01a3972684706a9beaebc1d1e226549c2ab8b5c8a0a9c8648`
and lacks its immutable tag. Remediation is to publish the immutable full-revision
tag for that revision at the verified running digest, or address that digest
directly and repeat digest, embedded revision, health and image smoke validation.
Rebuilding the same revision does not prove the same digest. Moving `latest` is
not a remediation. This change performs neither publication nor deployment.

The existing workflow does not supply the host-reader inputs. Until trusted host
access and container selection are available, automatic discovery fails closed.
This lane does not configure that access or change workflow configuration. Stubbed
tests prove the contract, not live host reachability or live rollback readiness.

## Local verification (2026-09-14)

Commands were run from `/home/bawes/work/rollfix`.

| Command | Result |
| --- | --- |
| Initial `npm test` | Exit 2 during build: missing Node type definitions; zero tests executed |
| `npm ci` | Exit 0; installed locked dependencies; no lockfile changes |
| `node --test deploy/coolify/test/rollback-artifact.test.mjs` | Final run: 9 passed, 0 failed; initial harness run had 6 passed/3 failed, corrected by isolating child test-runner environment |
| Final root `npm test` | Exit 0: 473 tests passed, 0 failed/skipped; 75 additional standalone mutants killed |
| `umask 0002` then `chmod -R go-w .github/coordinator` then `node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs` | Exit 0: 931 tests, 924 passed, 7 skipped, 0 failed |
| PyYAML `safe_load` on workflow YAML and Coolify compose YAML | 7 files passed |
| `actionlint` v1.7.7 | Exit 0, 6 workflows, no diagnostics |
| `node --check deploy/coolify/rollback-artifact.mjs` | Exit 0, 1 module |
| `node --check deploy/coolify/automatic-staging.mjs` | Exit 0, 1 module |
| `git diff --check` | Exit 0 |

Root `npm test` constituent commands, counted separately (do not add these again
to the root total):

| Constituent command | Passed / killed |
| --- | ---: |
| Build + compiled core `node --test` file list in package.json | 258 tests |
| `test:profile:mutations` | 10 mutants |
| `test:idempotency:mutations` | 3 mutants |
| `test:assertion` | 27 tests |
| `test:deployment` | 97 tests (includes the 9 rollback tests) |
| `test:web` | 15 tests |
| `test:documents` | 19 tests |
| `test:documents:mutations` | 17 mutants |
| `test:documents:hardening` | 10 tests |
| `test:documents:hardening:mutations` | 10 mutants |
| `test:observability` | 15 tests |
| `test:observability:mutations` | 17 mutants |
| `exercise:observability` | Exit 0, local synthetic exercise |
| `test:documents:lifecycle` | 25 tests |
| `test:documents:lifecycle:mutations` | 18 mutants |
| `test:documents:r2` | 7 tests |

Outcome proofs in `test/rollback-artifact.test.mjs`:

| Test | Mutation's observed named failure |
| --- | --- |
| `published running revision returns verified running digest despite different latest` | `AssertionError: ROLLBACK_NO_LATEST_SUBSTITUTION` |
| `today running 50db30ee untagged returns explicit non-fatal remediation` | `AssertionError: ROLLBACK_UNTAGGED_TYPED` |
| `missing running evidence fails closed before registry access` | `AssertionError: ROLLBACK_RUNNING_ARTIFACT_REQUIRED` |

Each mutation runs the corresponding test in a child Node process, requires a
nonzero exit and `AssertionError` containing the named assertion. Tests also cover
registry authentication/transport failure, mismatch, revision, health, smoke,
changing running state and read-only host command construction. No live host or
registry was queried to repeat the established evidence.
