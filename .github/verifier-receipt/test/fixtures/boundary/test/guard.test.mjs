// A HONEST CONTROL: it really exercises the guard, so the protected mutation really kills it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { allowsHead } from '../src/guard.mjs';

test('the guard refuses a stale head', () => {
  assert.equal(allowsHead('a'.repeat(40), 'a'.repeat(40)), true);
  assert.equal(allowsHead('b'.repeat(40), 'a'.repeat(40)), false);
});

test('the guard refuses a head that is not a commit id', () => {
  assert.equal(allowsHead('short', 'short'), false);
});
