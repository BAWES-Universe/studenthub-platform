# Orchestrator v1 Demonstration Contract

**Version 1.0 — proposed, revised 2026-09-23 after a non-author review at `e9a4b04` returned DO-NOT-APPROVE.**
This file is frozen only by Khalid's approval. After freezing, any change is a v1.1 or a follow-up card.

**What the review found, and what this revision does about it** (so a reader can see the argument change, not just
the prose):

1. §2 said "dispatch stays off" while §3's evidence requires worker launches. **Fixed** — §2 states the real gate
   state, and §4 row 11 marks the one switch that is Khalid's decision rather than this contract's.
2. Nothing required the seeded defect to **be there**. **Fixed** — §4 row 4 measures it, and it is **currently
   failing**: the trap is absent from the fixture branch today, so v1 as previously written would have produced an
   honest step-2 PASS and proved nothing.
3. The seeder was unnamed. **Fixed** — §7 names it (Hermes orchestration lane, third party, per the fixture card).
4. The schedule was blamed for a failure it had nothing to do with. **Fixed** — §6: the journal shows the schedule
   working and the run prevented by eligibility and the activation check.
5. Several host claims were unverifiable or unmeasured as written. **Fixed** — §4 rows 4–10 now carry a command and
   a reading, including the host clone HEAD the review could not read.
6. The actor v1 is judged by — the verifier — had no brief. **Fixed** — §3.1.

## What v1 demonstrates, in one sentence

The orchestrator runs **one unattended sequence on one fixture** — build, independent review, automatic revision,
PASS — with **no human relay between any two steps**, woken by a **host service schedule** rather than by a chat
turn that happens to have a background process, and it **stops before merge**.

This is the E2E that matters for v1: the orchestrator doing the job, not the authority emitting a pin.

## 1. The fixture: SHU-140, shown able to serve

From `.github/coordinator/config.json` → `fixture_lane` (read at `01409cc`):

```
id:                   SHU-140
authorization_ref:    FIXTURE-OPUS-CONTRACT-20260905
reviewer_lane:        claude-verifier
note:                 "seeded-defect fixture (SHU-63); Linear minted identifier SHU-140 for lane id SHU-FIXTURE-001"
initial_build_paths:  tools/fixture/scan-vacuous.mjs
                      tools/fixture/test/scan-vacuous.test.mjs
revision_paths:       the two above
                      tools/fixture-conformance/scan-vacuous.expectations.mjs
seeded_defect_path:   tools/fixture-conformance/scan-vacuous.expectations.mjs
```

**Why it can serve, and not merely exists.**

- It is a **one-slot** fixture: exactly one `seeded_defect_path`, a single string rather than an array.
- The defect sits in the fixture's **acceptance oracle**, which a **reviewer** reads and `node --test` never loads
  — measured on the branch, the review's own `review-test.1.json` lists
  `test_files: ["tools/fixture/test/scan-vacuous.test.mjs"]` and nothing else, and the lane's 20/20 TAP passes with
  the oracle never loaded. A green CI is therefore not evidence of a correct fixture, which is exactly the property
  v1 must demonstrate: the *reviewer* is what catches it.
- Its rows are `{name, src, expected}` triples whose `expected` is **mechanically comparable** to
  `scanVacuousTests(src)`, and `/srv/shu/shu63-oracle-check.mjs` is an objective checker over them (§4 row 4).
- Its reviewer lane is **distinct from its builder** (`claude-verifier`), so review is not the builder marking its
  own work.
- The path set is small and declared, so a revision is bounded to `revision_paths`.

**The fixture card is the authority for its own design.** Linear SHU-140 (read 2026-09-23) states the builder lane
`requested_worker=codex-builder` (the coordinator's documented default), the reviewer lane `claude-verifier`, the
label `repo:platform`, the seeder, and a run contract that is the sequence in §2 verbatim: *"build → exact-head
BLOCK → automatic return to writer → same-branch revision → CI → automatic re-review → PASS → stop before merge."*

**Two corrections the review caught.** The fixture files exist **only on `origin/coordinator/SHU-140`**, not on
`main`. And this section previously called `SHU-254` "not in v1" while `config.json` sets
`dispatch_scope.issue_ids: ["SHU-140","SHU-254"]` — **length 2 selects the two-fixture code path that SHU-140's own
run takes** (`reconcile.mjs:484`). So: SHU-254's *lane* and `tools/fixture-2/` are out of v1, but its *presence in
`dispatch_scope`* is load-bearing and stays. Removing it is a `config.json` edit, and therefore an escalation
(§7), not a tidy-up.

**Naming, recorded rather than resolved:** `config.json` calls it the SHU-63 seeded-defect fixture and records
SHU-140 as the Linear-minted identifier for lane `SHU-FIXTURE-001`; the fixture README says "SHU-140 fixture"
while the oracle file's header says "SHU-63 fixture". v1 pins the **config's identifier (SHU-140)** and the paths
above. The mismatch is load-bearing in `reconcile.mjs:494-496` and is noted so nobody re-litigates it mid-run.

## 2. The sequence, and the exact gate state it runs under

| # | step | who runs it | must be true at the end | human relay |
|---|------|-------------|--------------------------|-------------|
| 1 | **build** | builder lane (`codex-builder`) on SHU-140, touching only `initial_build_paths` | a commit on `coordinator/SHU-140`, receipted | none |
| 2 | **independent review** | `claude-verifier`, separate worktree, clean environment, adversarial brief | a verdict naming the **exact head**, and it must be **BLOCK** — the seeded defect is present (§4 row 4) | none |
| 3 | **automatic revision** | builder lane re-dispatched **with the review's findings**, no human editing anything | a second commit addressing the findings, receipted | none |
| 4 | **PASS** | `claude-verifier` at the revised head | `stage: PASS` at the exact revised head, finding closed by citation | none |

The property that makes this "unattended": steps 2 → 3 and 3 → 4 are triggered by the previous step's own receipt.
No step waits for a person to read a message and start the next one.

**The gate state, stated accurately.** Committed `enable_dispatch: false` **stays false**. What allows worker
launches is the runtime environment switch `ENABLE_DISPATCH`, and the two-fixture branch additionally requires an
**armed `two-fixture-v1` activation** whose `coordinator_revision` matches the deployed clone (`reconcile.mjs:484`).
Merging is a **separate** lever: `routine_merge_authority.enabled: false` (authority_ref `SHU-259`). So
"stop before merge" is enforced by a different switch from the one that lets the sequence run: **v1 needs the
launching switch on and the merging switch off.** Turning the launching switch on is §4 row 11 and is **Khalid's
decision, not this contract's** — the fixture card says the same in its own words: *"Dispatch stays disabled... this
card cannot be selected at all until Khalid approves activation and it is moved deliberately."*

**A false PASS at step 2 is a FAILURE by name, and §8 no longer reads it as a success arriving early.** The
detector is mechanical: a genuine sequence leaves **two** `push-<attempt_id>.json` receipts on `coordinator/SHU-140`
with **different** `result_sha` values; a false PASS leaves one. The verifier must check that count and the
difference (§3.1), and it must independently confirm the defect was present at the step-1 head. Without those two
checks a step-2 PASS is indistinguishable from a fixture that was never seeded — which is the state of the box
today (§4 row 4).

**Bounded, and owned.** Per-step budget: `max_failed_attempts: 3` (config). The unit is `Restart=on-failure` under
a firing timer, so a wrong step 3 would otherwise re-fire indefinitely: **the abort owner is the operator on call,
and the abort is the kill switch — config `enable_dispatch: false` with `ENABLE_DISPATCH` unset** (both gates
required; flipping one cannot arm or disarm it). **No merge. No push to `main`. Dispatch stays off at rest.**

## 3. Evidence, and who checks it

Shapes measured on `178.105.227.11` on 2026-09-23.

| step | exact evidence | produced by |
|------|----------------|-------------|
| 1 build | `/srv/shu/state/coordinator-runs/push-<attempt_id>.json` — `{"version":1,"stage":"PUSHED","attempt_id":…,"result_sha":…,"branch":"coordinator/SHU-140","repo":"BAWES-Universe/studenthub-platform","worktree":…,"pushed_at":…,"remote_head":…}` with `result_sha == remote_head` | coordinator, from the builder lane |
| 1 build (builder-side equivalent) | `/srv/shu/state/coordinator-runs/workspace-result-<id>.json` | coordinator |
| 2 review | `/srv/shu/state/reviewer-evidence/<attempt_id>.claude-envelope.<sequence>.stdout` and `<attempt_id>.review-test.1.json`. The naming is the adapter's own — `path.join(dir, \`${attemptId}.claude-envelope.${sequence}.stdout\`)`, `.github/coordinator/adapters/claude-code.mjs:163`. The review attempt id is minted by the coordinator from the run it belongs to, so **the pairing is made by the reviewed head SHA**, which the review evidence and the next push receipt both carry, not by the shape of the id | `claude-verifier`, via the claude-code adapter |
| 3 revision | a **second** `push-<attempt_id>.json` for the same branch with a **different** `result_sha`, plus the findings text the builder was given | coordinator + builder lane |
| 4 PASS | `stage: PASS` at the revised head, with the step-2 finding closed by citation | `claude-verifier` |
| coordinator identity | each coordinator receipt carries its attempt id; the verifier additionally records the systemd `InvocationID` of the run | coordinator / systemd |

The checker is **not** the builder, not this contract's author, and not the orchestrator. Its output is the final
artifact of v1.

### 3.1 The verifier's brief

The verifier is **independent: non-author, its own session, no stake in this programme.** It writes its verdict to
`/srv/shu/state/verifier-evidence/v1-<run>.json` plus a human-readable log, and records, with the command it ran
and the output it got:

1. **The seeded defect was present at the step-1 head** — `/srv/shu/shu63-oracle-check.mjs <laneTree>` exits **1**
   there, and the seed commit is present with the **seeder recorded** (the card requires a third party who is
   neither the builder nor the reviewer).
2. **Two push receipts with different `result_sha`** on `coordinator/SHU-140` (§2's detector for a false step-2
   PASS), and that the second head descends from the first.
3. **Step 2 returned BLOCK at the exact step-1 head**, and step 4 returned `stage: PASS` at the exact revised head
   — each read from its own evidence, never from a summary.
4. **The merge switches**: `routine_merge_authority.enabled: false`, no merge commit on the branch, nothing pushed
   to `main`.
5. **Ordering**: the receipts' timestamps are strictly ordered, and the branch's commits between the step-1 head and
   the step-4 verdict are exactly the lanes' own — **no human-authored commit or edit in between**.
6. **The limit, stated rather than hidden:** the host records *machine* events, so it proves **no human commit and
   no human-started step**. It cannot prove nobody typed a sentence into a chat beside the run. The verifier states
   which of the two it established and does not claim the second.

## 4. Preconditions, each with how it is measured, and today's reading

Measured on `178.105.227.11` unless stated. Readings are 2026-09-23 and are re-taken at precondition time.

| # | precondition | how it is measured | reading at 2026-09-23 |
|---|--------------|--------------------|------------------------|
| 1 | the schedule wakes runs (**not** a chat turn) | a **positive demonstration**: `journalctl -u shu-coordinator.service` shows a tick reaching a launch decision | **WORKS.** `Sep 16 05:47:35 dispatch_scope=SHU-140,SHU-254` → `HOLD=NO_ELIGIBLE_WORK; no launch — SHU-140: dispatch_scope target is unavailable or ineligible` → `dispatch: PREVENTED — single-run activation REFUSED (ACT_MALFORMED: ACT_EXECUTION_REVISION_WRONG); no fallback, no writes` |
| 2 | the units are installed | `ls /etc/systemd/system/ /usr/lib/systemd/system/ \| grep shu` | installed: `shu-coordinator.service`, `shu-coordinator.timer`, `shu-supervisor.service`, `shu71-evidence.service` (+ `.d/` overrides) |
| 3 | state and receipts persist | `ls /srv/shu/state` | present: `coordinator-runs/`, `reviewer-evidence/`, `shu71-evidence/`, `auth.json`, `shu251-window-0002/`, `shu251-window-0003/`, plus 7 `single-run-activation.candidate-*` files |
| 4 | **the seeded defect is present at the step-1 head** | `node /srv/shu/shu63-oracle-check.mjs <laneTree>` → **exit 1 = seeded, exit 0 = clean** | **FAILING — exit 0, `VERDICT: PASS — every declared row and the helper agree`.** The trap was corrected by the Sep 13 revision, so the branch is clean today. **Re-seeding is a precondition of the run, not an accident to discover mid-run** |
| 5 | coordinator credentials are present without a chat turn | `ls -l /srv/shu/coordinator.env` — **metadata only, no value read** | not measured in this pass; must be `0600 shu-coordinator:shu-coordinator` per `.github/coordinator/service/SHU-251-HOST-BINDINGS.md` |
| 6 | the reviewer works in a worktree separate from the builder's | the run's own receipts: distinct `worktree` values under `/srv/shu/worktrees/` for the build and the review attempt | to be confirmed from the run's receipts |
| 7 | **the toolchain** | `claude --version` on the host — true; and **the model id recorded in each step's receipt — FALSE for the builder**: the builder receipts carry no model field | toolchain: to be measured; model-in-receipt: the review's finding stands and this contract does not fix it |
| 8 | the activation state | `/srv/shu/state/shu71-activation.json` present and **armed**; the 7 `single-run-activation.candidate-*.json` files **spent** (byte-identical to their `used-` counterparts) | **no armed activation** (file absent); 7 candidates present and spent |
| 9 | the deployed revision an activation must match | `git -c safe.directory=/srv/shu/studenthub-platform -C /srv/shu/studenthub-platform rev-parse HEAD` (read-only; plain `git` refuses on `dubious ownership`) | **`a51c8490dfb8572917049b3ab73dcf94409365c4`**, detached |
| 10 | Linear eligibility | SHU-140 is `Todo` and meets `ELIGIBILITY.md`: exactly one `repo:` ownership label, no delegate/assignee conflict, `blockedBy` all `Done`, `needs:decision` absent | **FAILING — state is `Backlog`, assignee Khalid.** The card says Backlog **by design**; it moves only on his deliberate approval |
| 11 | **the launching switch is on for the bounded run** | `systemctl show -p Environment shu-coordinator.service` (today: `ENABLE_DISPATCH=false`) | **KHALID'S DECISION** — §2, §7 |
| 12 | dispatch off and nothing armed at rest | config `enable_dispatch: false`, `ENABLE_DISPATCH` unset, no `/srv/shu/state/shu71-activation.json` | **TRUE** — `enable_dispatch: false`, `routine_merge_authority.enabled: false`, activation absent |

**Rows 4, 10 and 11 are what stop the run today**, and each has a different owner: row 4 the seeder (§7,
autonomous), rows 10 and 11 Khalid.

## 5. What is NOT in v1

**Upstream programme items, out:** the CI receipt authority, the claim manifest, cold gates, suite portability,
general activation, any second fixture lane.

**Operational items, also out:** minting any activation record, editing any systemd unit, editing `config.json`
(including `dispatch_scope`), re-running a failed sequence beyond what the failure names, moving any Linear card
other than as §4 row 10 requires, and any merge. A reader can now tell scope creep from the text.

**Does v1's evidence need #167?** **No, and the review confirmed it by inspection:** every receipt v1 rests on
(`push-*`, `workspace-result-*`, `*.workspace.json`, `*.review-test.1.json`, `*.claude-envelope.1.stdout`) carries
no manifest reference, no pin and no authority field, and no line of §2 or §3 reads one. **But the review also
corrected the surrounding claim:** two *other* dependencies are load-bearing and are **not** #167 — the
**activation-record pin** (§4 rows 8–9, §2) and the **toolchain evidentiary pin** (§4 row 7, false for the
builder). Both are in this contract now instead of being silent.

**The author's position, for the record:** none of #161, #162 or #167 needs to move for v1. They stay frozen.

**Linear is a mirror.** SHU-66 and SHU-71 point at this file. No new requirements come from Linear, and no
estimates are given until this contract is frozen and the remaining gates are measured.

## 6. The scheduler: v1 must wake itself

**Requirement.** The step after any step starts from a **real service schedule with persisted state and receipts**
— not from a chat turn that happens to have a background process.

**Use what exists. Do not build a new scheduler.** `shu-coordinator.timer` drives `shu-coordinator.service` under
`shu-supervisor.service`, `WorkingDirectory=/srv/shu/studenthub-platform`, state and receipts under
`/srv/shu/state` — **measured working** in §4 row 1: the tick fires, reaches the launch decision, and is
**prevented by eligibility and by the activation check**, `no fallback, no writes`. The schedule was never the
broken part, and this contract no longer says it was.

## 7. Autonomy and escalation

**Autonomous:** ordinary implementation and test repairs; measurement; drafting; work inside the fixture's declared
paths, **including re-seeding the trap** — the fixture card names the seeder as the **Hermes orchestration lane,
third party to the run, recorded on the seed commit**, and `seeded_defect_path` is a declared path. The gate on
seeding is objective: `/srv/shu/shu63-oracle-check.mjs` must exit **1** before the run starts.

**Escalate to Khalid:** host privilege (enabling/starting units, changing `Environment=`), secret or key custody,
**live dispatch** (§4 row 11 — turning the launching switch on and arming the two-fixture-v1 activation),
**moving SHU-140 out of `Backlog`** (§4 row 10), merge authority, and any change to this committed contract.

## 8. After this package

A new finding may block v1 **only if it directly falsifies a line of this contract**; everything else becomes a
follow-up card and stays off the critical path. **A step-2 PASS is such a falsification, by name** (§2): it is a
failure of v1, not a success arriving early. If the v1 run fails, **fix only what the failure names**.

This file gets **one non-author review (Opus)** — done at `e9a4b04`, whose findings are folded in above — and
**Khalid's approval**, and is then frozen.
