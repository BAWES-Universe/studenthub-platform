// A fixture run by `node --test --test-reporter=tap` so a test above is fed the REPORTER'S OWN BYTES, not an
// imitation of them. It reports one name twice, failing first and passing second, which is what two files of
// one glob produce when they happen to name a test the same thing - and what an emitter that took the last
// point for a name would report as `pass` for a test the protected runner watched fail.
//
// It is deliberately not named `*.test.mjs`: the emit job runs `node --test test/*.test.mjs`, and this file
// must fail when it is run, on purpose.
import test from 'node:test';
import assert from 'node:assert/strict';

test('the coordinator refuses a stale head', () => { assert.ok(true); });
test('the push broker retries only reads', () => { assert.ok(true); });
test('a duplicated name', () => { assert.fail('the real assertion failed'); });
test('a duplicated name', () => { assert.ok(true); });
