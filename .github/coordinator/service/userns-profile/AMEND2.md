# AMEND round 2: A12_DESIGN_BLOCKER; incomplete implementation

This amendment does **not** satisfy sections 1–5 of the commissioned brief.
The authoritative complete inventory and reproducible native runner have not
been delivered. Neither prerequisite is proved bound to the other. There is no
native install/load/verify/execute/teardown implementation or claimed production
kill for its six mutations. The previous blocker commit
`5fba51942dcab409ccb2caf8c3d47d48bd46fea8`, its outcome JSON, profile bytes, and
synthetic receipt examples are preserved unchanged.

## Actual production change

`bindSuite` now rejects unknown spec fields, including alternate inventories,
wrappers, executable paths, commands and argv. Its existing caller-file and
caller-count guards remain. After the existing revision/inventory checks, it
requires the checkout realpath and verifies the bytes of **every tracked
coordinator file** against its Git revision object. This includes
`reviewer-sandbox.sh`; a clean Git status can no longer conceal changed tracked
bytes using index flags. Symlinked, missing, nonregular and aliased file entries
refuse. Raw object bytes, including trailing newlines, are hashed unchanged.

The returned binding contains revision, tree, checkout realpath, inventory
SHA-256, per-file SHA-256 values and the inventory-derived count. Production
`runSuite` preserves this binding in its result; `createDisposableSuite` preserves
it in the existing durable ready receipt. Tests invoke these production functions
with injected filesystem/command boundaries and isolated local Git fixtures.
No separate implementation stands in for those functions.

These are admission checks at a point in time, **not** authenticated custody or
protection against replacement during execution. The existing spec still supplies
the revision and checkout; this amendment does not turn those into independently
approved constants. The missing `suite-inventory.json` still causes production
admission to refuse. No partial or guessed inventory is installed, and no count
from a failed full run is treated as authoritative. The new tests use explicitly
synthetic two-test inventories, not the A12 inventory.

| New production code | Killing source mutation |
| --- | --- |
| `SHU251_SUITE_CALLER_SELECTION` | caller execution selectors accepted |
| `SHU251_SUITE_CHECKOUT_REALPATH` | checkout realpath substituted |
| `SHU251_SUITE_FILE_DIGEST` | checkout bytes substituted |

Each mutation changes the production source, passes syntax checking, then fails
the same positive/refusal control at its named assertion. Wrapper substitution,
missing bytes, symlinks, nonregular entries and aliases also have direct refusal
tests. Caller-count manipulation retains `SHU251_SUITE_INVENTORY` and its existing
mutation. These must not be relabeled as native runner mutations.

## Boundary that remains unresolved

The approved #137 revision is
`3bc169740573f95e68c33a0bcc971db00ae3bc65`. At that revision:

- `test/shu261-review-findings.test.mjs:162` invokes
  `/usr/bin/unshare --user --map-root-user /bin/bash <checkout>/.github/coordinator/reviewer-sandbox.sh`.
  Its separate `/bin/true` probe is not this proof.
- `test/shu261-cleanup-network.test.mjs:15` and `:82` invoke Bash with `-c`.
- `test/shu219-rule6-mutation.test.mjs:48` invokes Node with `-e`.
- Mutation tests execute modified Node source in temporary trees; for example
  `test/shu261-mutations.test.mjs:102`.

Paths above are relative to `.github/coordinator/`. Their pinned byte digests
are in `amend2-outcome.json`. None of these host-facing tests was executed here.

The [AppArmor 4 profile grammar](https://manpages.ubuntu.com/manpages/noble/man5/apparmor.d.5.html)
selects execution transitions by executable path/profile, not a command-line
predicate. Therefore an inherited rule permitting the Bash executable does not
itself distinguish the reviewed wrapper from `bash -c` or standard-input code.
Restricting readable script paths does not prohibit inline interpreter code.
A fixed outer native launch of Node does not mediate Node's descendant execs.
An inventory digest describes bytes; it does not add an argv predicate to
AppArmor. This is an inference from the policy grammar and these concrete call
sites, not a newly observed kernel result or a proof that every possible native
broker design is impossible.

The existing probe-only profile cannot execute the required wrapper. Expanding
it with inherited Node/Bash execution would not establish the requested exact
execution boundary. A separate child profile can reduce Bash authority, but
does not enforce which Bash program runs. No independently enforced descendant
command boundary was implemented or proved in this amendment. Accordingly the
section 3 hard stop applies: **A12_DESIGN_BLOCKER**. No profile expansion,
refusal-only executable presented as a completed runner, or fake authenticated
verifier is supplied.

## Verification and unmet controls

Before suites: `chmod -R go-w .github/coordinator`, `umask 0002`.

| Run | Tests | Pass | Fail | Skip |
| --- | ---: | ---: | ---: | ---: |
| Blocker-parent focused baseline | 93 | 93 | 0 | 0 |
| Final focused contract/parser/inventory/disposable | 97 | 97 | 0 | 0 |
| Phase-A driver | 35 | 35 | 0 | 0 |
| Existing profile design controls | 17 | 17 | 0 | 0 |

The focused command and log digests are recorded in `amend2-outcome.json`.
All eight `PERMITTED_SKIPS` entries are byte-identical to the blocker parent;
all observed focused skip lists are empty. No full-suite expected count or
full-suite success is claimed. The installed-provider test remains excluded
from the focused selection, as before.

All eight retained profile mutations were rerun with passing positive controls:

| Mutation | Named assertion |
| --- | --- |
| missing-userns | A12_USERNS_REQUIRED |
| wrong-executable | A12_EXECUTABLE_REQUIRED |
| bypassed-transition | A12_TRANSITION_REQUIRED |
| profile-name-substitution | A12_PROFILE_NAME_REQUIRED |
| widened-path | A12_PATH_SCOPE_REQUIRED |
| global-sysctl-relaxation | A12_NO_SYSCTL_RELAXATION |
| ordinary-execution-exception | A12_ORDINARY_EXCLUDED |
| teardown-residue | A12_TEARDOWN_NO_RESIDUE |

They remain **design-model** controls, not production AppArmor enforcement tests.
The six requested native production mutations remain **UNSUPPORTED, not killed**:
binary substitution; wrong binary digest; wrong owner/mode; stale/wrong loaded
profile; interrupted installation; failed teardown. No native positive lifecycle
exists against which to run them. The requested ordinary Node/Bash exception
control is likewise not established in production. The new inventory-selector,
count, wrapper-byte and argv-spec controls cover suite admission only.

No host profile load, namespace probe, installation, policy mutation, push, PR
operation, merge, GitHub comment or Linear comment occurred. Remote #137 head
reads are read-only. No host cleanup or absence-of-residue measurement is claimed.
