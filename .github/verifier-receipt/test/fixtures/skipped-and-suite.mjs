// A fixture run by `node --test --test-reporter=tap` so the tests below are fed the REPORTER'S OWN BYTES for
// the two shapes that put `ok` on the wire without executing anything a claim could be about:
//
//   * a `{ skip: true }` test, reported `ok N - <name> # SKIP`;
//   * an empty `describe()`, reported `ok N - <name>` with `type: 'suite'` and `# tests 0` under it;
//
// plus a `{ todo: true }` test, which the reporter counts in `# todo` rather than in `# pass` or `# fail`, and
// one ordinary passing test so the capture also shows what a real measurement looks like beside them. A review
// defeated an earlier emitter with the first two: both were recorded `pass` for a term.
//
// It is deliberately not named `*.test.mjs`: the emit job runs `node --test test/*.test.mjs`, and this file is
// a capture to be read, not a suite to be run.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

test('the stale-head guard holds', { skip: true }, () => { assert.fail('never reached'); });
test('the broker retry budget is respected', { todo: true }, () => {});
describe('the mutant that removes the stale-head guard dies', () => {});
test('the coordinator refuses a stale head', () => { assert.ok(true); });
