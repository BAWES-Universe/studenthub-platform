# Recruit lane: lease

**Owner:** Claude (contributor lane, hand-built). **Reviewer:** Codex on the box (cross-family). **Since:** 2026-11-17, base main `016ccd2`.
**Plan of record:** full migration, 17 Dec verified release candidate, 1 Jan live. Recruit code done by 8 to 15 Dec.
**Supersedes:** the box queue rows of PR #412 (never merged; those card ids are not queued and will not be).
**Spec:** recruit inventory `docs/parity/discover-apply-and-recruit.md` (PR #58), decisions of 2026-10-27 (legacy production is the benchmark, nothing a user can do today is removed).

## Paths held by this lease

New, owned outright:
- `packages/recruit/**` (pure domain: statuses, state machines, legacy maps, guards, projections; no package manifest, compiled by the root build and imported by relative path, like `packages/notifications`)
- `packages/db/src/recruit/**`, `packages/db/test/postgres-recruit-*.test.ts` (the db runner discovers `postgres-*` only)
- `packages/db/migrations/0450_*.sql` to `0499_*.sql`
- `apps/gateway/src/recruit/**`, `apps/gateway/test/recruit-*.test.ts`, `apps/gateway/test/recruit-*-mutations.mjs`
- `apps/gateway/src/routes/recruit.ts`, `apps/gateway/src/wiring/recruit.ts`, `apps/gateway/src/contributions/recruit.ts`
- `docs/lanes/recruit/**`, `docs/parity/recruit/**`

Shared seams, additive lines only (one contiguous block each, no other line changed):
- `packages/db/package.json`: one `./recruit` export; `packages/db/src/index.ts`: one `export * from "./recruit/index.js"` line (the root golden equals the union of the areas)
- `apps/gateway/test/db-subpaths.test.ts`: the `recruit` area, its expected exports and the area count
- `apps/gateway/test/wiring-runtime.test.ts`: the recruit application keys and the pool count (the recruit area uses one shared pool, so the count moves by one for the whole lane)
- `apps/gateway/src/routes/index.ts`: one import line and the recruit route entries
- `apps/gateway/test/routes-order.test.ts`: the recruit route names and the new length
- `apps/gateway/src/routes/context.ts`: one optional `recruit` service field
- `apps/gateway/src/login-runtime.ts`: one `wireRecruit` call and its close
- `apps/gateway/src/contributions/index.ts`: `RECRUIT_CONTRIBUTION` in the merge list
- `apps/gateway/src/ui/profile-copy.ts`: recruit navigation label keys only

Lease extension, 2026-11-17 (coordinator, for decision SHU-200 employer document links), additive only:
- `packages/private-documents/src/employer-delivery.ts` (new file beside `staff-delivery.ts`; no existing private-documents line changes), `packages/private-documents/test/employer-delivery.test.mjs`, `packages/private-documents/test/employer-delivery-mutations.mjs`
- `apps/gateway/test/contributions.test.ts` and `apps/gateway/test/profile-kit.test.ts`: the recruit navigation entry and the copy count it moves
- Store-manager sight codes against the access lane's A4 read port (`managedStores(principalId)`, PR #509 lane); the requests store requires it, and the recruit wiring passes `NO_STORE_MANAGERS` (nobody manages a store) until A4's store-manager grants are on main, when A4 swaps in its reader; the db test `REC5_STORE_MANAGER` covers own-store sight, sibling and other-company refusal, and the production source

Read only: `packages/search/**` (Typesense adapter), `packages/notifications/**` and `packages/db/src/notifications/**` (outbox), `packages/organizations/**`, `packages/pay-contracts/**`, `tools/legacy-import/**`.

Excludes: workflows, `.github/coordinator/**`, `apps/gateway/src/index.ts`, `web-ui.ts`, any payroll path (GPT pay lease), any other lane's package.

## Slices

| Slice | Outcome | Legacy | Migration |
|---|---|---|---|
| R1 | A company raises a request, tracks it with one status convention (draft, open, filling, filled, closed) and an activity list; staff see all requests | `Request.php`, company and staff `RequestController` | 0450 |
| R2 | Staff assign a recruiter and move people through a checked pipeline (suggested, contacted, interviewing, offered, placed, withdrawn), with request checklists; placing hands over to work assignment exactly once | `Story.php`, `StoryController`, `RequestChecklist` | 0451 to 0452 (built) |
| R3 | Staff and employers search people looking for work, server side, with facets; no index key in a browser | staff and company `AlgoliaController` | none (built) |
| R4 | Suggestions to the company (accept, reject) and invitations to people (seen, accept, decline), events to the notification outbox | `Suggestion`, `Invitation` controllers, `cron/every-minute` | 0453 (built) |
| R5 | Employers see the people suggested, invited or assigned to their requests and stores, as legacy (decision SHU-200: documents through signed, audited links) | company candidate views | 0454 (document view audit) |
| R6 | Interviews and versioned evaluations, with internal and shared notes kept apart | `RequestInterview`, `InterviewEvaluation`, `CandidateEvaluation` | 0455 |
| R7 | Job board as legacy: staff publish, people browse and apply once, "My applications"; closed or draft jobs refuse applications (decision SHU-207) | `Job`, `JobInterest`, candidate `JobController` | 0456 (built) |
| R7b | Candidates browse open requests and apply once (as with the job board, company and staff accounts get nothing); the company or the request's recruiter accepts an applicant onto the pipeline (then interviews, R6) or rejects them | `RequestApplication`, candidate and company `RequestController` | 0458 (built) |
| R9 | Full-timer track kept as a second candidate type on the same pipeline (legacy benchmark rule) | `FulltimerController` | 0457 (built) |
| Import | Legacy rows map into the new tables; rows that do not map land in the reconciliation report | all of the above | none |

Individual hirers (R8) are not in legacy and not in this release.

## Rules

- Every commit carries a `Claude-Session` trailer. No card ids in PR bodies.
- Each slice lands as its own reviewable commit range; the PR leaves draft when R1 to R4 pass CI, and stays leased until the lane is released in `contracts/reservations.md`.
- Every recruit write decides inside its own transaction: the caller's grants (and a subject's candidate grant) are read `FOR SHARE`, referenced rows (request, step, card, store, catalogue item, job) are read `FOR SHARE` or `FOR UPDATE`, then the write runs. A revocation or soft delete either commits first and the write is refused, or waits until the write commits. An assigned recruiter keeps authority over a request only while they still hold a recruiter grant. Each store's db suite has a `*_REVOKE_RACE` test built on `packages/db/test/recruit-races.ts`.
- A write that authorises through organization ancestry (requests, interviews) first takes the organization tree lock shared, so a reparent waits for it. Every move forward re-checks the card's subject (candidate grant, or a live full-timer); withdrawing is always possible. No hire is recorded on a closed request, and "placed" is offered for a person only once a work placement is wired. FK `ON DELETE SET NULL` on actors and authors is allowed through the immutability triggers; nothing else moves.
