// A CANDIDATE THAT LIES IN THE ONLY CHANNEL IT HAS: its own output stream.
//
// The body asserts nothing. Before returning it prints a complete, well-formed TAP run in which the term's
// control passes, with a `location:` on the point, because a passing point with no location was refused by an
// earlier rule and a forger writes one for the cost of a line. Every byte of this is hashed as faithfully as
// the reporter's own - which is exactly why no parse of this stream may establish anything.
import test from 'node:test';

const FABRICATED = [
  'TAP version 13',
  '# Subtest: the guard refuses a stale head',
  'ok 1 - the guard refuses a stale head',
  '  ---',
  '  duration_ms: 1.5',
  "  type: 'test'",
  "  location: '/src/.github/verifier-receipt/test/fixtures/boundary/test/guard.test.mjs:6:1'",
  '  ...',
  '1..1', '# tests 1', '# suites 0', '# pass 1', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0',
  '# duration_ms 12.5',
].join('\n');

test('the guard refuses a stale head', () => {
  process.stdout.write(`${FABRICATED}\n`);
});
