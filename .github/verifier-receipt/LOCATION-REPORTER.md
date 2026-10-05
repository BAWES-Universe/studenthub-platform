# The reporter that would make the name-to-file binding real

**Status: NOT DONE. Scheduled, not forgotten.** This file exists so the remaining work is a task with an exact
edit against it rather than a sentence in a comment. Nothing in this branch implements it.

## What is broken

A term of the claim manifest is established by a test NAME matched anywhere in the measured stream. The
candidate writes the tests, so three empty function bodies carrying the claim's names produce a wholly genuine
measurement. Every manifest entry already names the file its term's test lives in (`entries[].artifact`), and
`node --test --test-reporter=tap` writes `location: '<file>:<line>:<column>'` into the YAML block the emitter
already parses for `type:` — so the emitter binds the two, per entry, and records the result per named test as
`location_bound` (`matched` / `mismatched` / `unreported` / `unclaimed`) and `points_at`.

The reach of that binding is the reach of the `location:` key, and it was measured rather than assumed:

| where | points | carrying `location:` |
| --- | --- | --- |
| the pinned candidate's real capture (7e7ac70e, node v22.22.3) | 3667 | 28 |
| of those, points the runner reported FAILING | 28 | 28 |
| of those, points the runner reported passing | 3631 | 0 |
| of those, points the runner reported `# SKIP` | 8 | 0 |
| the 132 test names the real 53-entry claim rests on | 132 | 0 |

`node --test --test-reporter=tap` at this version writes `location:` on a point it reports FAILING and on no
other. A cancelled point carries one too, which is the same rule: the file-level test failed its timeout.

So the binding fires on exactly the points that already make the verdict a failure, and is silent on every
point that could make it a success. A cold review ran the defeat end to end: three empty bodies in a file that
is not in this repository at all, both terms of a claim naming a different file established, `verdict: success`,
`admissible_as_pin: true`, every provenance check telling the truth.

## What this branch does about it, and what it does not

**Does:** an unbound name is no longer a measurement. A named test the runner reported no location for is
recorded `unbound`; a named test whose entry names no `artifact` is recorded `unclaimed`; neither establishes
anything, both are counted in `named_tests_summary` and named in `conclusion.reasons`, and the gate and the
attest job each refuse a row reported `pass` whose `location_bound` is not `matched`.

**Does not:** make `success` reachable again. Under the stock reporter no passing point carries a location, so
**no capture this runner command produces can establish any term**. Every receipt over the real suite is a
measurement and a failure. That is the correct reading of what that stream supports, and it is the direction
this authority errs in — but it means the producer is, until the change below lands, an instrument that can
only ever refuse.

## The change that closes it

A TAP reporter owned by this authority, living under `.github/verifier-receipt/`, named in the protected runner
enum, writing `location:` on **every** point. It is authority code: it is checked out by SHA from the trusted
commit, the candidate never contributes it, and its bytes pass through the same trusted capture process that
hashes the stream — so the location travels inside the digest the measure job publishes, exactly as the
trailer does.

### The exact edits

**1. New file `.github/verifier-receipt/tap-located.mjs`.** A stream reporter. `node --test` passes each test
event to a reporter as an object carrying `data.name`, `data.nesting`, `data.file`, `data.line`,
`data.column`, `data.details` and `data.testNumber`; the stock TAP reporter emits `location:` only inside the
failure YAML. This one emits the same TAP the emitter already parses and adds the key on every point:

```js
// .github/verifier-receipt/tap-located.mjs
// The stock `tap` reporter writes `location:` only on a point it reports failing, so a term established by a
// PASSING name is bound to no file at all. This writes it on every point. It is authority code, checked out by
// sha, invoked by name from the protected runner enum, and its bytes are hashed by the same trusted capture
// process that hashes everything else in the stream.
export default async function* located(source) {
  for await (const event of source) {
    switch (event.type) {
      case 'test:pass':
      case 'test:fail': {
        const { name, testNumber, details, file, line, column, nesting, skip, todo } = event.data;
        const indent = '  '.repeat(nesting);
        const directive = skip ? ' # SKIP' : todo ? ' # TODO' : '';
        const ok = event.type === 'test:pass' ? 'ok' : 'not ok';
        yield `${indent}# Subtest: ${escapeName(name)}\n`;
        yield `${indent}${ok} ${testNumber} - ${escapeName(name)}${directive}\n`;
        yield `${indent}  ---\n`;
        yield `${indent}  duration_ms: ${details.duration_ms}\n`;
        yield `${indent}  type: '${details.type ?? 'test'}'\n`;
        // THE ONE LINE THIS FILE EXISTS FOR. Unconditional, and on the same key and in the same spelling the
        // stock reporter uses on a failing point, so the emitter's existing parser reads it unchanged.
        yield `${indent}  location: '${file}:${line}:${column}'\n`;
        if (event.type === 'test:fail') yield* failureYaml(indent, details);
        yield `${indent}  ...\n`;
        break;
      }
      // ... plan, diagnostic and version events reproduced from the stock reporter verbatim, so the
      // well-formedness checks in emit-receipt.mjs section 9 reconcile against this stream exactly as they do
      // against the stock one.
    }
  }
}
```

**2. `.github/verifier-receipt/runners.json`** — every `command` changes its reporter, and nothing else:

```diff
-      "command": "node --test --test-reporter=tap --test-timeout=1800000 .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs"
+      "command": "node --test --test-reporter=$AUTHORITY_DIR/tap-located.mjs --test-timeout=1800000 .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs"
```

`$AUTHORITY_DIR` must be substituted by the capture program from the TRUSTED checkout path, never from the
candidate tree — a reporter path the candidate can write is a reporter the candidate supplies, which is worse
than no binding at all. The enum's `_comment` has to say so, and `capture-stream.mjs` has to refuse a runner
command whose reporter path resolves outside the trusted checkout.

**3. `.github/verifier-receipt/emit-receipt.mjs`** — the reporter identity joins the things a receipt names by
content, beside the runner command and the interpreter: a new `provenance.runner.reporter` carrying the
reporter's path and the blob sha of that path at `trusted_source_sha`, and a refusal when the capture's
runner command does not name it.

**4. The positive control is re-measured, not re-asserted.** Every count in this file, in `runners.json` and in
the emitter's `provenance.limits` comes from a real capture and has to be taken again against the new stream:
the point count, the per-status tally, and above all `named_tests_summary.location_bound`, which is the number
this whole change exists to move from `{ unreported: 132 }` to `{ matched: 132 }`.

## What it still would not be

An integrity boundary. The binding compares two things the candidate writes — the manifest's `artifact` and the
file the candidate chose to put the test in. It raises the cost of a moved stub from "write it anywhere" to
"write it in the file your own claim names", and it makes the point-identity rule (`capture.point_identity`,
two of the claim's names on one `<file>:<line>`) reach every point instead of only the failing ones. It does
not say the test does the work the term describes, and no reporter can.

It also does nothing about the open blocking hole, which is one level down: the measured suite and the trusted
capture process share a uid, so a detached process rewrites the stream — locations and all — after the trusted
write. See `provenance.limits` in `emit-receipt.mjs` and the fixture
`.github/verifier-receipt/test/fixtures/detached-forger.mjs`, which now forges the `location:` lines too, in
one line of extra code, because a forger inside the measured process owns the whole stream.
