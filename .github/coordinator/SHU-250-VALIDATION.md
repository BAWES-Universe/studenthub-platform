# SHU-250 validation

Base: `35f98a48ac6a4e14e8b5520a8bd5939bcc7e4dac`

Branch: `feat/shu-250-supervisor-dispatch-path`

Full-suite command, run from the repository root after `chmod -R go-w .github/coordinator`:

```sh
node --test .github/coordinator/test/*.test.mjs
```

| Suite | Tests | Pass | Fail | Skipped |
| --- | ---: | ---: | ---: | ---: |
| Base | 731 | 725 | 0 | 6 |
| Final | 758 | 752 | 0 | 6 |
| New tests, focused verification | 27 | 27 | 0 | 0 |

The table records a **non-root** run (752 pass / 6 skipped at final).
The equivalent root run is 758 pass / 0 skipped; the six tests require root.

The six baseline skips remain unchanged. The final full run measured 17.0 ms
for submission and 1.5 ms for a later real reconcile tick while the deterministic
child double remained running. The enforced bound is 1000 ms. Mutating dispatch
back to the awaited adapter crosses that bound with a 1500 ms simulated worker.

The receipt state-machine implementation and receipt schema are unchanged.
The config file is byte-identical to base. The existing Hermes main-level tests
now explicitly inject their adapter using the existing unit-test seam. The
existing independent-supervisor-submissions fixture uses different branches,
so it continues to test independent submissions while enforcing branch ownership.
Existing assertions were retained.

All tests use deterministic doubles and local temporary state. No live worker,
production contact, service installation, dispatch enablement, push or PR was
performed. Host installation and live proof remain SHU-251 work.

## New test names

1. `SHU-250: real tick returns while a long-running supervised child executes`
2. `SHU-250: concurrent ticks recover the same durable attempt with one launch`
3. `SHU-250: crash after submission recovers once and ambiguous restart HOLDs`
4. `SHU-250: conflicting retry HOLDs without scheduling or launching`
5. `SHU-250: worker death surfaces a terminal HOLD receipt without blocking later tick`
6. `SHU-250: completion with no worker evidence HOLDs`
7. `SHU-250: carried result SHA disagrees with verified head and HOLDs`
8. `SHU-250: bound callback and observed identity survive completion and restart`
9. `SHU-250: stopped heartbeat never declares a live worker dead`
10. `SHU-250: unknown socket and result contract versions fail closed`
11. `SHU-250: fixture driver unassigns and restores on terminal path`
12. `SHU-250: failed run restores and failed restore retains recoverable journal`
13. `SHU-250 mutation: awaited in-process launch`
14. `SHU-250 mutation: drop pre-spawn marker`
15. `SHU-250 mutation: conflicting retry`
16. `SHU-250 mutation: drop terminal fixture restore`
17. `SHU-250 mutation: accept no evidence`
18. `SHU-250 mutation: accept unbound result SHA`
19. `SHU-250 mutation: missing heartbeat terminal`
20. `SHU-250: different attempts cannot own the same branch concurrently`
21. `SHU-250: invalid heartbeat version HOLDs and callback binding is never rewritten`
22. `SHU-250: bounded driver exhaustion restores fixture`
23. `SHU-250: supervised review persists observed identity before PASS`
24. `SHU-250: supervised review rejects its author`
25. `SHU-250: adapter refusal cannot be overridden by its successful callback`
26. `SHU-250: child wrapper transports adapter artifact verbatim and rechecks authority`
27. `SHU-250: legacy ambiguous launch is never resubmitted as a fresh supervised child`

## Required mutation evidence

Each mutation is applied to a temporary copy of the coordinator. Its probe must
exit 1, report `AssertionError`, and contain the exact named assertion below.
A syntax error, timeout, unrelated failure or surviving mutation fails the test.

| Mutation | Named AssertionError text |
| --- | --- |
| Restore awaited in-process launch | `SHU250_RESPONSIVE: tick must return within 1000ms without awaiting worker` |
| Drop the durable pre-spawn marker | `SHU250_PRESPAWN: durable spawn_attempted must precede process creation` |
| Launch on a conflicting retry | `SHU250_CONFLICT: conflicting retry must HOLD before launch` |
| Drop terminal fixture restore | `SHU250_RESTORE: terminal path must restore original assignment and state` |
| Accept an exit-only completion as terminal | `SHU250_NO_EVIDENCE: completion without worker callback must HOLD` |
| Accept an unbound result SHA | `SHU250_RESULT_SHA: carried result_sha must equal the verified head` |
| Treat missing heartbeat as terminal failure | `SHU250_HEARTBEAT: missing heartbeat must never cause terminal failure` |
