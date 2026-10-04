> **REMOVED / OUT OF SCOPE — owner Option A.** This is a historical record,
> superseded by [A12-CLOSURE.md](../A12-CLOSURE.md). The static ELF runner,
> AppArmor exception profile, host installer/load/verify/teardown model,
> authenticated collector, six native production mutations and supporting
> profile design-model machinery are no longer deliverables. Production uses
> sudo → wrapper → systemd-run with `RestrictNamespaces=yes`; the namespace
> was only a test substitute for sudo/root. The inert profile and executable
> model/tests were removed. The native runner, installer and authenticated
> collector were never built; native production mutation kills were never proved.
> All requirements, commands, counts and outstanding-work language below are
> historical, not current obligations or runnable verification instructions.

# A12 profile-scoped exception: repository-only design

Status: **candidate design, not deployable or host-verified**. This lane supplies
policy bytes, an executable specification of admission and lifecycle receipts,
eight positive controls and named mutations. It supplies no installer, native
binary, host evidence collector or host invocation. No host profile, sysctl,
sudoers or service was changed. No namespace probe was run.

The owner's audit evidence identifies causality: the reviewed unshare PID
3281823 transitions from `unconfined` to `unprivileged_userns`; that profile then
denies capability 21 (`sys_admin`) during the mapping operation. This is an
identified cause supplied by the brief, not a fresh observation by this lane.
Changing `/etc/apparmor.d/unprivileged_userns` is expressly outside this design.

## Executable boundary and exact policy

The complete exact candidate policy is [a12.apparmor](a12.apparmor). It contains
no includes, general file rule, network, mount, ptrace, cross-identity transition,
shared interpreter attachment, change_profile, unconfined mode or exec fallback.
Its attachment is exclusively `/usr/local/libexec/shu251-a12-suite-runner`.
The exact launcher argv is:

```json
["/usr/local/libexec/shu251-a12-suite-runner"]
```

This is a proposed **static native ELF**, not a script, symlink to Node, copy of
Node, dynamic interpreter wrapper, or executable delivered by the checkout.
The dedicated A12 entrypoint has exactly one operation: the reviewed namespace
capability probe. It is not a general command runner. A future implementation
must reject all extra argv, even apparently harmless options, before execution.
The suite and its general Node interpreter never receive the exception.

The native entrypoint's required algorithm (part of the design, not implemented
or proven by the JS model) is:

1. Require real/effective/saved uid 999, gid 982 and exactly supplementary group
   980; no setid bits, file capabilities or inherited permitted/effective/ambient
   capabilities. Never call sudo, setuid, setgid, or otherwise switch identities.
2. Require canonical cwd `/srv/shu251/a12-disposable/checkout`, matching the
   independently reviewed disposable checkout inode/revision receipt. Refuse
   symlinks, replacement, persistent/service checkouts and unexpected mount
   aliases. The operator must serialize lifetime against replacement. The
   runner's executable and all ancestor directories must be root-owned,
   non-writable by uid 999/groups 982 and 980; executable mode 0750, group 982.
   The checkout remains service-owned as required by the existing contract.
3. Read its AppArmor current identity and require exactly
   `shu251-a12-runner (enforce)`. Missing/complain/unconfined/stacked/unexpected
   labels refuse. Do not fall back to direct unshare if the profile is missing.
4. Close inherited fds other than bounded stdout/stderr channels; use a fixed
   empty-input descriptor. Clear the environment and pass only `LC_ALL=C`.
   No PATH lookup, NODE_OPTIONS, LD_* variables, caller command, or shell.
5. Execute precisely
   `["/usr/bin/unshare","--user","--map-root-user","/bin/true"]`.
   Keep the existing bounded timeout and failure behavior. Return success only
   on the exact probe's successful completion with independently verified
   transition evidence. Identity/hash drift invalidates the run, even on exit 0.

The parent has **no userns or capability grant**. Its only executable transition
is `/usr/bin/unshare rCx -> probe,`: mandatory local child profile, scrubbed
environment, no `Cix`, `CUx`, `ix` bypass or unconfined fallback. Child label is
`shu251-a12-runner//probe`. Ordinary `/usr/bin/unshare` execution has no global
attachment to that child. Ordinary Node, coordinator and supervisor processes
keep their existing labels. Executing the fixed native entrypoint replaces only
the invoking child; it cannot give the calling Node process new permissions.
Neither policy can execute Node, a shell, coordinator or supervisor. Even an
ordinary process able to invoke the runner gets only its fixed checked operation,
not arbitrary argv or an inherited exception in its parent.

The child permits `userns create,` and `capability sys_admin,` only. The latter is
explicit because it is the confirmed denied check; a confined profile must not
silently rely on an unconfined capability allow. AppArmor does not itself grant
Linux capabilities: the fixed unprivileged identity has none in the initial
namespace. These rules do **not** express “sys_admin only for uid_map” in AppArmor;
the fixed executable, argv, empty environment, DAC and absent mount/network/
ptrace/other exec rules are essential parts of the boundary. This must not be
represented as a generic safe grant for arbitrary programs.

The only writable files admitted are owner-qualified numeric proc uid_map,
gid_map and setgroups. AppArmor's numeric-PID pattern is not a self-PID predicate;
it also matches same-owner proc entries. The fixed reviewed unshare program must
only address its own maps. If the threat model requires kernel enforcement of
self-PID-only access independent of that program, **this candidate is blocked**;
do not broaden or claim the owner qualifier provides that guarantee.

The explicit x86_64 library paths and `/usr/bin/true` resolved path are a proposed
runtime closure, not observed target facts. `/bin/true` stays the exact argv.
Future review must pin actual realpaths, inodes, bytes, loader dependencies and
cache contents, and show every listed mapping is necessary. No glob or broad
abstraction may be substituted to make a dependency failure disappear. A platform
with a different closure requires a separately reviewed exact policy and digest.

AppArmor syntax/semantics reference: [Ubuntu's AppArmor 4 profile manual](https://manpages.ubuntu.com/manpages/noble/man5/apparmor.d.5.html)
documents `userns create`, local `Cx` mandatory transitions and scrubbed execution.
That documentation supports the proposed mechanism; it does not verify this
host or compile these policy bytes. Our syntax-clean mutations are valid JS/data
and structurally valid policy edits; **no real AppArmor parser was invoked**.

## Hard stop and full-suite boundary

`platformGate` rejects absent, partial or changed evidence with
`A12_DESIGN_BLOCKER`. Before activation, an independently trusted verifier must
establish the dedicated static ELF attachment, mandatory child transition,
userns-create support, enforcement, pinned runtime closure, authentic evidence,
and no widening of shared interpreters. Parser version, binary digest, feature
ABI and compiled-policy digest must be approved; warnings, unsupported features,
parser mismatch, name collisions or attachment ambiguity refuse activation.
There is no default_allow/unconfined or shared-Node alternative. If scoping cannot
be demonstrated on the platform, stop and return that blocker.

Those facts are **not established here**. Tests supply marked synthetic facts.
The model has no production allow path: its receipts say `design-simulation`.
A digest is integrity bookkeeping, not authenticity; callers cannot authorize
activation by copying `requiredFacts()` or setting evidence flags to true.
A native implementation and independently authenticated host evidence remain
required for deployment. This lane does not claim the platform is incapable;
it claims no verified platform admission has been obtained within its scope.

The existing L4 namespace-startup test also executes
`unshare --user --map-root-user /bin/bash <wrapper>` at line 160 of
`shu261-review-findings.test.mjs`. The fixed probe profile intentionally cannot
execute that command. **Full A12 namespace proof is unresolved by this candidate**;
a successful preflight must not be reported as full-suite success. Expanding to
that shell command would need an independently justified bounded contract from
L4. It is a design/integration blocker for claiming the whole suite now, not a
new permitted skip or a decision to defer namespace proof. No guard or skip
allowance in either protected file is changed.

## Exact single proposed integration point

Base `00eb979800b5ef6dfb918b57002d167802238612`, file
`.github/coordinator/service/host-suite-contract.mjs`, **line 126** (the brief's
line 136 refers to a different revision), inside `hostProbe`:

Before:

```js
case 'user_namespaces': return successful(asService('/usr/bin/unshare', ['--user', '--map-root-user', '/bin/true']));
```

After, only once the native runner, receipt admission and platform gates above
have been implemented and independently reviewed:

```js
case 'user_namespaces': return successful(asService('/usr/local/libexec/shu251-a12-suite-runner', []));
```

This is a documentation-only change proposal. The runner must itself refuse if
admission, identity or receipts are unavailable; a zero exit from an arbitrary
replacement binary is not admission. The existing suite failure remains
`SHU251_PREFLIGHT_USER_NAMESPACES`. No import, capability name, expected count,
assertion, skip reason or bypass flag is added. The suite must already run from
the fixed disposable cwd as uid 999/gid 982/groups [980]. The current root
`asService` branch clears groups; using it with this runner **must fail closed**,
not silently weaken the group check. Do not add sudo authority to fix it.

Neither protected file is edited. Applying this single preflight integration
point does not integrate the separate shell-wrapper proof described above.

## Deterministic receipts and rollback

`contract.mjs` is the executable **design** for a serialized lifecycle. Inputs
are exact policy bytes, fixed manifest and four lowercase SHA-256 pins: reviewed
checkout snapshot/revision, parser binary/version/feature-ABI manifest, native
runner binary/build manifest, and resolved runtime dependency manifest. The
manifest hashes must include canonical paths, ownership/modes, inode identities
and content digests as appropriate. No pin is learned from a caller-controlled
checkout or accepted on first use. Test pins are hashes of explicit `FAKE:` strings.

Canonical serialization sorts object keys, preserves array order, and excludes
clocks, random IDs and absolute local test paths. Each receipt binds all facts,
pins, design digest, action and previous receipt digest. Identical evidence
produces byte-identical receipts. Repetition in another lifecycle must be bound
by the external verifier to its fresh exclusively locked checkout snapshot;
the hash chain alone is not a replay defense across instances.

Future operator procedure, **not executed or executable by this lane**:

1. **Install:** acquire exclusive deployment lock; record complete baseline
   profile inventory, existing policy files/cache and protected settings. Refuse
   either owned profile name already present rather than replacing it. Validate
   fixed identity, runner and immutable runtime; compile exact policy with pinned
   parser/ABI, treating warnings as errors. Stage only the dedicated file
   `/etc/apparmor.d/shu251-a12-runner` and dedicated runner; atomically load only
   these two profiles, no service-wide reload. Record exact new names,
   attachment, enforce mode, parser/profile/runner/runtime digests. Receipt is
   emitted only after actual state agrees. Unrelated baseline profiles are
   excluded from `loadedNames` (which is the owned delta) but must be unchanged.
2. **Verify:** independently authenticate executable/process identity, exact
   group vector/cwd/disposable checkout digest, labels before and after `Cx`,
   fixed argv/environment, no initial/file capabilities or setid, no changed
   ordinary labels, settings or extra authority. Missing evidence refuses even
   if a child returns 0. Transition evidence must come from already authorized
   read-only kernel audit/identity observations bound to this process lifetime;
   do not add ptrace/eBPF/cross-identity privileges just to collect it. The model
   checks evidence shape/content; it does not manufacture that observation.
   Actual namespace execution remains outside this lane's authorization.
3. **Teardown:** first stop new starts and drain the owned processes while their
   confinement is still present. If any remain, refuse completion; do not unload
   policy from live tasks. Remove only the owned profiles, policy file, runner,
   owned parser cache and disposable checkout. Confirm absent profile labels,
   attached tasks and artifacts, unchanged unrelated inventory/sysctls/sudoers,
   and restored baseline. Emit teardown receipt only on full confirmation.

Verification/install failure permits only cleanup; no retry-to-success or bypass
within that lifecycle. Cleanup may be retried after partial removal, but every
receipt requires zero residue. Rollback after partial install follows the same
teardown procedure using the exclusive ownership journal; it must never delete
pre-existing resources. Failure to prove cleanup is a named failure and retained
incident, never successful rollback. Lock/journal, authenticated evidence and
host operations are requirements for the future implementation, not capabilities
supplied by this pure model.

## Controls, mutations and reproducible verification

Each row has its own unmutated passing test. The mutation harness reruns that
same test with only the named data/policy change and requires one assertion
failure, exit 1, no signal, no SyntaxError and zero skipped tests.

| Mutation | Named assertion |
| --- | --- |
| missing-userns | A12_USERNS_REQUIRED |
| wrong-executable (shared Node attachment) | A12_EXECUTABLE_REQUIRED |
| bypassed-transition (Cx becomes ix) | A12_TRANSITION_REQUIRED |
| profile-name-substitution (child renamed) | A12_PROFILE_NAME_REQUIRED |
| widened-path (exact executable becomes wildcard) | A12_PATH_SCOPE_REQUIRED |
| global-sysctl-relaxation | A12_NO_SYSCTL_RELAXATION |
| ordinary-execution-exception (coordinator and supervisor) | A12_ORDINARY_EXCLUDED |
| teardown-residue | A12_TEARDOWN_NO_RESIDUE |

Additional tests cover missing transition, unknown fields, changed identity or
argv, general capabilities/sudo grants, missing/substituted parser/loaded profile/
runtime evidence, deterministic receipt chains, platform hard stops and rollback.
All profile checks and lifecycle tests are repository data checks using fakes.
The existing focused `SHU251 contract` tests use injected probes; their reporter
test launches only two harmless temporary Node fixtures. The name filter excludes
the existing real-provider test and all host or namespace suites.

```sh
chmod -R go-w .github/coordinator
umask 0002
node --test --test-name-pattern='SHU251 contract' .github/coordinator/service/test/host-suite-contract.test.mjs
node --test .github/coordinator/service/test/userns-profile.test.mjs
node .github/coordinator/service/userns-profile/mutations.mjs
```

The base focused suite passed 10/10, zero skips. Final results and exact skip-set
comparison are recorded in [VERIFICATION.md](VERIFICATION.md). Neither running the
full coordinator suite nor the L4 test is safe under this lane's no-probe rule.
