# Acceptance policy and historical operating record

Repository correction based on `main@00eb979800b5ef6dfb918b57002d167802238612`,
branch `chore/board-policy-closure`. This is code-policy evidence, not live acceptance.
The governing sources are the owner's Hermes final execution closure directive
(`doc_eec55c7501a8_Hermes-final-execution-closure-directive.md`), L5 of
`/home/bawes/work/shu251/lanes-shared-brief.md`, and D1–D3 of
`/home/bawes/work/reconciliation-135.md`. External statements below are attributed
to those sources, not independently fetched in this correction.

## D1: repository mitigation, external matcher still unresolved

`LINEAR_COMPLETION_GUARD=UNRESOLVED`. Action C and general activation remain blocked.
Code merge must never move a live-acceptance card to Done. A merge is code delivery;
acceptance requires host/live proof, an explicit owner-authenticated acceptance
receipt, then a separately authorized state transition. No unattended agent may
perform that transition.

The repository check is `.github/policy/acceptance-metadata.mjs`. Version 2
requires a closing verb (`close`, `fix`, `resolve`, `complete`, `finish`, including
their measured inflections) connected to an issue ID or Linear URL by whitespace,
punctuation and an explicit vocabulary of connector words. It retains case,
line-break, Unicode dash, NFKC and zero-width normalization. Negated and quoted
closing forms still refuse conservatively. Neutral issue mentions, parenthesised
IDs and related-work URLs pass. This is a measured repository grammar, not proof
of Linear's private matcher or a guarantee for arbitrary natural language.

The independent verifier reported BLOCK at
`f4af691b0ec4f8a140db541e0533822a143d6633`: required run `35147803735` refused
PR #136's own benign title, then skipped both pre-existing checks. This report
is user-supplied, not independently fetched here. The original blanket-reference
ban was overbroad. Its old measurements are preserved in
[f4af691-focused.tap](evidence/board-policy/f4af691-focused.tap) and
[f4af691-manifest.json](evidence/board-policy/f4af691-manifest.json); those passes
did not establish usability or workflow independence. The correction changes four
neutral-reference probe expectations to acceptance and retains every prior
closing-form refusal, metadata-shape guard and error code.

Measured local probe outputs, including exact input, exit status and JSON output,
are in [focused.tap](evidence/board-policy/focused.tap). The fixture source is
[probes.mjs](../.github/policy/probes.mjs). Neither file is evidence of Linear's
proprietary matcher. That matcher has no supplied executable, capture or versioned
measurement in this repository. We did not create external PRs or change cards to
measure it. Unknown encodings, branch-name linking, integration configuration and
other non-metadata triggers are not proven safe by this check.

All policy steps now have explicit `always()` conditions; the metadata step
also requires a PR event. Thus a failed matcher or measurement step cannot skip
either legacy check, and an ownership failure cannot skip the tracked-path check.
No `continue-on-error` masks any failure. The required job name stays
`repository-policy`; both legacy shell script bodies are byte-identical to the
blocked head. The local workflow tests assert these conditions and execute the
three actual check commands for every combination of pass/fail fixture inputs.
These measurements are not an execution of GitHub Actions itself.

The workflow runs on PR opened/edited/reopened/synchronize/ready_for_review events;
metadata is read from the event JSON, never interpolated into shell. It runs the
policy tests on push too, but push has no PR metadata and cannot undo an earlier
integration effect. CI required-check configuration, check freshness at merge and
Linear integration settings were not inspected or changed. A repository workflow
alone cannot enforce those external settings or authenticate Linear's behavior.
Consequently D1 remains `CONFIRMED_BLOCKER` for end-to-end closure, with a tested
repository mitigation delivered. A future authorized measurement must capture
actual matcher outcomes for these same probes and non-metadata triggers, without
using live acceptance cards, before resolving this guard.

## D2: owner authority is a separate artifact

Under the governing directive, shared Linear actor identity cannot distinguish
an agent's comment or transition from the owner's. The identity premise is adopted
from the directive, not independently verified here. Agents may draft approval
text and record technical evidence; they must never manufacture owner approval,
an owner-authenticated receipt or a Done transition.

Before execution, the exact approval bytes must be readable through the actual
delivery channel. Preserve the original artifact, its SHA-256 digest, authenticated
owner provenance outside the shared Linear identity, the exact delivered bytes,
and a byte-for-byte comparison. A digest establishes byte integrity, not authorship.
A reformatted chat message, partial echo, agent-generated approval or matching
Linear username is insufficient. If either the original or delivered bytes cannot
be read and compared, execution remains blocked. Link the external owner receipt
from the operating record without representing Linear identity as proof of authorship.

The receipt must identify revision/tree, scope, operation order, activation,
expiry, evidence and teardown disposition. Signing-key use, activation-ID minting,
fixture assignee changes, acceptance-card Done transitions and protected merges
remain outside unattended authority. No approval or activation is minted here.
The next approval order must put A12 after render/identity checks and before
service start unless isolation and the need for a live plane are explicitly proved.

D2's minimum repository policy is recorded. Authentication, actual channel byte
comparison and execution enforcement are not implemented by this document; A7 and
the external owner receipt remain dependencies. D2 stays `CONFIRMED_GAP` overall.

## D3: append-only verdict lineage

The ordering below is intentional. Later code corrections do not supersede a
historical BLOCK without new exact-head evidence and the required live proof.

1. Window 0002 evidence for SHU-253 was later disqualified as untyped shell
   evidence by the directive. SHU-253 is **not live accepted** on that basis.
   Its current Linear state was not read or changed here.
2. PR #131, `2026-09-16T06:54:48Z`: reconciliation quotes “BLOCK / AMEND — verdict
   classification CORRECTED at head 7ce1e85d”. Preserve this earlier correction.
3. **PR #131, `2026-09-16T16:49:42Z`: POST-MERGE BLOCK — acceptance claims not
   satisfied. This remains visible and in force.** The reconciliation reports
   this as the latest comment at its read time; this correction makes no claim
   about today's external comment order.
4. Later reconciliation at executor head
   `885914c22f26b279e6c29b088e4c46d44037759c`, tree
   `5626c1b6dd0649f61cda4268c9f88cb2d580957e`, found A1 closed but A2–A7
   blockers. PR #135's published head was still
   `ab6c634b4ef13fbde0767f34cce0e535289e682a` at that read. Its descriptions
   “integrated” and “Required bounded actions — covered” overclaimed closure.
5. This later L5 correction adds repository policy and corrects the local record
   only. It does not overturn PR #131's post-merge BLOCK, approve PR #135, or
   establish host acceptance. Proposed external wording: “Lifecycle routing
   implemented; checkout, ownership, startup, gates-off, rollback and approval
   composition blockers remain at the reconciled executor head.” This wording
   has not been posted to GitHub or Linear.

Receipts are **SHA-256 digested** unless an actual signature and verified signer
are supplied. This correction supplies no signed receipt. Claims of “signed
receipts”, “no ref manipulation outside the driver” or “final host-state equality
proved” are unsupported here and must not be used as acceptance evidence.
Their external occurrences were not fetched or edited. Parser provenance is
corrected in [PHASE-A-DRIVER.md](../.github/coordinator/service/PHASE-A-DRIVER.md):
`cvtsudoers.ws` is the packaged classic parser name in the alternatives
arrangement, not evidence of a sudo-rs implementation. Existing A12 test labels
are retained for the separate lane; no assertion or error code was renamed.

## Evidence mapping and retained-state register

Never infer activation identity from a directory sequence such as `0002` or
`0007`. Require the artifact's explicit activation ID and evidence path, and check
the recorded revision/tree and receipt digests against its manifest. The
reconciliation cites a mechanical equality check at executor head `885914c…`:
`evidence_dir === evidence_root + '/' + activation_id`, with provider scope
mutation coverage. That code is on the executor lane, not this branch. It cannot
retroactively identify older windows. No historical manifests were supplied in
this repository; **zero historical directory-to-activation mappings are verified**.
In particular do not equate a directory called `0007` with `shu71abproof0007`.

This is a source-derived register of known categories, not a measured host
inventory. Presence, exact paths where absent below, metadata and final equality
remain unverified. Nothing is authorized for deletion by this table.

| Item from governing sources | Classification | Disposition / evidence still needed |
| --- | --- | --- |
| Retained checkout pin `00eb9798` | Approved retained state | Keep unchanged; actual HEAD/main/origin/tree/cleanliness tuple unmeasured |
| Both dispatch gates OFF | Approved retained state (required baseline) | Preserve; actual running values unmeasured |
| Historical window 0002 artifacts and PR #131 BLOCK | Required evidence | Preserve disqualified evidence and verdict; obtain manifest and exact path, do not promote to acceptance |
| Prior activation/candidates including `shu71abproof0007` | Required evidence of retirement | Never reuse; presence, archive paths and cleanup state unmeasured |
| `/srv/shu/state/shu71-evidence` archives | Required evidence | Path documented in activation package; actual inventory/custody/digests unmeasured |
| Unit files, drop-ins, enablement links, environment files, listeners/processes, locks and state paths | Unresolved drift | Need bounded read-only reconciliation after static closure; no live comparison performed |
| Disposable A12 checkout and temporary placement/fixture artifacts, if retained | Unresolved drift | Exact inventory and ownership absent; classify as removable residue only after explicit review |
| Confirmed removable residue | None established | Do not invent inventory or removal authority |

D3's local status/language correction is delivered with history preserved.
External PR/board edits, historical artifact mapping and measured residue inventory
remain `CONFIRMED_GAP`. No host access was used to fill missing facts.

## Verification and limits

Run `umask 0002` and `node --test .github/policy/test/*.test.mjs` from the repository
root. Corrected focused result: **78 tests, 78 pass, 0 fail, 0 skipped,
0 cancelled, 0 todo**. The event-file CLI measures **57 probes: 40 refused and
17 accepted**, with exact exit status and JSON code assertions. Malformed event
JSON is also refused. All 20 supported verb inflections are measured individually.
The supplied exact PR #136 title (B19), parenthesised title ID, neutral body ID,
and neutral URLs now return exit 0 / `BOARD_METADATA_ACCEPTED`. Closing forms
return exit 1 / `BOARD_ACCEPTANCE_REFERENCE`, including natural-language
connectors, punctuation, newlines, quoted/negated forms and normalized Unicode.

**Seven mutations are killed:** the two existing guard removals and a restored
blanket ban each have passing controls, syntax-clean mutants, and assertion
failure exit 1; four workflow-condition removals each fail the independence
assertion after a passing control. Eight failure combinations execute all three
check commands (24 results), including metadata failure with both legacy checks
passing and all three checks failing independently. Absolute symlink refusal and
relative symlink acceptance are measured without dereferencing either target.
Both legacy commands also pass on this repository. Fixture tests use disposable
local Git repositories and do not call host services or privileged probes.

The exact metadata of other lane PRs was not supplied or present in repository
fixtures; PR #136's exact body was also unavailable. Clearly labelled synthetic
lane title/body examples pass, but **exact
other-lane PR title/body verification remains unsupported**. No GitHub fetch or
metadata modification was performed. Hosted required-check green status also
remains unmeasured because this correction is not pushed.

The new focused suite has no baseline counterpart and no skips. Existing
coordinator/service test files and skip allowances are unchanged. Full baseline
and final coordinator/service suites were **not run**: they invoke real installed
parsers (`host-suite-contract.test.mjs`, `shu261-review-findings.test.mjs`) and
namespace/privilege probes. This task requires controlled fakes and no real-host
tests; no tests were modified or converted into skips to claim compliance. There
are no measured full-suite counts or runtime skip-name/reason comparison in this
lane. Source equality of existing tests is not a substitute for those measurements.

No host contact, push, PR creation, merge, GitHub/Linear comment, signing, reseed,
activation, fixture mutation or remote state transition occurred. The repository
commit is the only requested publication step. D1–D3 are not claimed fully closed
because the external proof and full-suite evidence listed above are unavailable
within this task's constraints.
