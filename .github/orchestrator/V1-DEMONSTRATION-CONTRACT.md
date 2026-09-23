# Orchestrator v1 Demonstration Contract

**Version 1.0 — proposed, not yet frozen.** This file is frozen by Khalid's approval and by nothing else. After
freezing, any change is a v1.1 or a follow-up card; it is never an edit in place.

## What v1 demonstrates, in one sentence

The orchestrator runs **one unattended sequence on one fixture** — build, independent review, automatic revision,
PASS — with **no human relay between any two steps**, woken by a **host service schedule** rather than by a chat
turn that happens to have a background process, and it **stops before merge** with dispatch off.

This is the E2E that matters for v1: the orchestrator doing the job, not the authority emitting a pin.

## 1. The fixture: SHU-140, shown able to serve

From `.github/coordinator/config.json`, `fixture_lane` (read at `01409cc`, verbatim values):

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

- It is a **one-slot** fixture: exactly one declared `seeded_defect_path`.
- The defect sits in the fixture's **acceptance oracle**, which is read by a **reviewer** and deliberately not
  executed by `node --test` — the oracle's own header says a row that disagrees with the contract "is invisible to
  `node --test` and can only be caught by reading it against the contract". So a green CI is not evidence of a
  correct fixture, which is exactly the property v1 has to demonstrate: the *reviewer* is what catches it.
- The lane already names a **reviewer distinct from the builder** (`claude-verifier`), so review is not the
  builder marking its own work.
- The path set is small and declared, so a revision is bounded to `revision_paths`.
- The wiring is not hypothetical: `coordinator/SHU-140` has been built and reviewed before (host receipts below
  carry that branch, and `.github/coordinator/service/SHU71-B1-COMPOSITION.md` records the build → review
  sequence).

**Naming, recorded rather than resolved:** `config.json` calls it the SHU-63 seeded-defect fixture and records
SHU-140 as the Linear-minted identifier for lane `SHU-FIXTURE-001`; the fixture README says "SHU-140 fixture"
while the oracle file's header says "SHU-63 fixture". v1 pins the **config's identifier (SHU-140)** and the
**paths above**. The label mismatch is noted here so nobody re-litigates it mid-run.

**Not in v1:** the second fixture lane `SHU-254` (config only, "not activation") and its `tools/fixture-2/` paths.

## 2. The sequence

| # | step | who runs it | must be true at the end | human relay |
|---|------|-------------|--------------------------|-------------|
| 1 | **build** | builder lane on SHU-140, touching only `initial_build_paths` | a commit on `coordinator/SHU-140`, receipted | none |
| 2 | **independent review** | `claude-verifier`, separate worktree, clean environment, adversarial brief | a verdict naming the **exact head**, and it must be **BLOCK** — a PASS here fails v1, because the seeded defect is present | none |
| 3 | **automatic revision** | builder lane re-dispatched **with the review's findings**, no human editing anything | a second commit addressing the findings, receipted | none |
| 4 | **PASS** | `claude-verifier` at the revised head | **APPROVE at the exact head**, with the finding closed | none |

**Stop before merge.** No merge, no push to `main`, no arming. **Dispatch stays off.** The sequence ends with an
approved fixture branch that nobody merges.

The property that makes this "unattended": steps 2 → 3 and 3 → 4 are triggered by the previous step's own
receipt. No step waits for a person to read a message and start the next one.

## 3. Evidence, and who checks it

Every fact below is read from the host, not from a chat transcript. Shapes are the ones measured on
`178.105.227.11` on 2026-09-23.

| step | exact evidence | produced by | checked by |
|------|----------------|-------------|------------|
| 1 build | `/srv/shu/state/coordinator-runs/push-<attempt_id>.json` — the measured shape is `{"version":1,"stage":"PUSHED","attempt_id":…,"result_sha":…,"branch":"coordinator/SHU-140","repo":"BAWES-Universe/studenthub-platform","worktree":…,"pushed_at":…,"remote_head":…}`, with `result_sha == remote_head` | coordinator run of the builder lane | independent verifier, after the run |
| 1 build (workspace) | `/srv/shu/state/coordinator-runs/workspace-result-<id>.json` | coordinator | independent verifier |
| 2 review | `/srv/shu/state/reviewer-evidence/<attempt_id>.claude-envelope.1.stdout` and `<attempt_id>.review-test.1.json`, and the verdict naming the reviewed head | `claude-verifier` | independent verifier |
| 3 revision | a second `push-<attempt_id>.json` for the same fixture branch, with a **different** `result_sha`, plus the findings text the builder was given | coordinator + builder lane | independent verifier |
| 4 PASS | a verdict naming the revised head, with the step-2 finding closed by citation | `claude-verifier` | independent verifier |
| sequence integrity | the four receipts' timestamps are ordered, and no human message exists between step 1 and step 4 | host receipts + the run's session records | **independent verifier (non-author, different session, no stake in this programme), after the run**, against the host receipts |

The checker is **not** the builder, not this contract's author, and not the orchestrator. Its own output is the
final artifact of v1.

## 4. Preconditions, each with how it is measured on the host

All measured on `178.105.227.11` (the box holding `/srv/shu`). The readings in the last column are from
2026-09-23 and must be re-taken at precondition time.

| # | precondition | how it is measured | reading at 2026-09-23 |
|---|--------------|--------------------|------------------------|
| 1 | the schedule exists and can wake a run (**the scheduler requirement**) | `systemctl is-active shu-coordinator.timer` and `systemctl list-timers shu-coordinator.timer` | **inactive, `is-enabled` = `disabled`, 0 timers listed → FAILING** |
| 2 | the units are installed | `ls /etc/systemd/system/ /usr/lib/systemd/system/ \| grep shu` | installed: `shu-coordinator.service`, `shu-coordinator.timer`, `shu-supervisor.service`, `shu71-evidence.service` (+ `.d/` overrides) |
| 3 | services activate from that schedule | `systemctl is-active shu-supervisor.service shu-coordinator.service` | both `inactive` |
| 4 | persisted state and receipts exist and survive a restart | `ls /srv/shu/state` | present: `coordinator-runs/`, `reviewer-evidence/`, `auth.json`, `shu251-window-0002/`, `shu251-window-0003/`, `shu63-activation.used-20260910T1910Z.json` |
| 5 | coordinator credentials are present **without a chat turn** | `ls -l /srv/shu/coordinator.env` (metadata only; **no value is read**) | not measured in this pass; must be `0600 shu-coordinator:shu-coordinator` per `.github/coordinator/service/SHU-251-HOST-BINDINGS.md` |
| 6 | the reviewer can work in a worktree separate from the builder's | host git objects + worktree paths under `/srv/shu/worktrees/` in the run receipts | to be confirmed against the run's own receipts |
| 7 | the toolchain is pinned and recorded, not floating | `claude --version` on the host, and the model identifier recorded in each step's receipt | to be measured |
| 8 | dispatch is off and nothing is armed | absence of an activation file, and the dispatch gate's own reading | to be confirmed at precondition time |

Row 1 is the only precondition measured **failing**, and fixing it means enabling and starting host units:
**host privilege, therefore an escalation, not autonomous work** (§7).

## 5. What is NOT in v1

The CI receipt authority, the claim manifest, cold gates, suite portability, general activation, and any second
fixture lane: **all out.** They are not preconditions, not evidence, and not blockers.

**Does v1's evidence need #167?** **No**, and here is the reason, stated so it can be overruled rather than
argued later: v1's claim is that the orchestrator performs build → review → revise → PASS unattended, and that
the **host receipts** prove it. #167 governs how a CI receipt becomes *pinnable by the authority* — v1 pins
nothing and asks no term to be established, so its evidence is complete without it, and it is checked afterwards
by an independent verifier against the host receipts (§3). If Khalid wants v1 to also produce an admissible
receipt, that is a **different, larger demonstration** and it needs #167 merged first; it is not this contract.

**The author's position, for the record:** none of #161, #162 or #167 needs to move for v1. They stay frozen.

**Linear is a mirror.** SHU-66 and SHU-71 point at this file. No new requirements come from Linear, and no
estimates are given until this contract is frozen and the remaining gates are measured.

## 6. The scheduler: v1 must wake itself

**Requirement.** The step after any step starts from a **real service schedule with persisted state and
receipts** — not from a chat turn that happens to have a background process.

**Use what exists.** `shu-coordinator.timer` (schedule) drives `shu-coordinator.service` under
`shu-supervisor.service`, with state and receipts under `/srv/shu/state` (§4 rows 1–4). **Do not build a new
scheduler.**

**Measured today:** units installed, state populated, **timer disabled and inactive**. What fails is the
schedule, and everything about it that v1 needs is already installed.

## 7. Autonomy and escalation

**Autonomous (no asking):** ordinary implementation and test repairs, measurement, drafting, running the
fixture's declared paths, and anything inside this contract's boundary.

**Escalate to Khalid:** host privilege (installing, enabling or starting units — including §4 row 1), secret or
key custody, live dispatch, merge authority, and any change to this committed contract.

## 8. After this package

A new finding may block v1 **only if it directly falsifies a line of this contract**. Everything else becomes a
follow-up card and stays off the critical path. If the v1 run fails, **fix only what the failure names**.

This file gets **one non-author review (Opus)** and **Khalid's approval**, and is then frozen.
