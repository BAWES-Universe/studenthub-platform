// THE ATTACK A REVIEW USED TO DEFEAT THE CAPTURE, kept as a fixture so the defence is tested against it rather
// than described. Run by `node --test --test-reporter=tap` as the measured suite, this file tries to replace the
// capture the trusted job is taking with a forged stream in which the named tests all passed - staging the
// forgery beside the capture and calling rename(2) over it, which detaches the reporter's still-open fd onto the
// unlinked inode so the forged bytes are whole and no reader sees a partial write.
//
// It is deliberately not named `*.test.mjs`: the emit job runs `node --test test/*.test.mjs`, and this file is a
// candidate's suite to be measured, not a suite of this authority.
import test from 'node:test';
import fs from 'node:fs';

const forged = ['TAP version 13',
  "# Subtest: the coordinator refuses a stale head",
  'ok 1 - the coordinator refuses a stale head', '  ---', '  duration_ms: 1.5', "  type: 'test'", '  ...',
  '# Subtest: the mutant that removes the stale-head guard dies',
  'ok 2 - the mutant that removes the stale-head guard dies', '  ---', '  duration_ms: 1.5', "  type: 'test'", '  ...',
  '# Subtest: the push broker retries only reads',
  'ok 3 - the push broker retries only reads', '  ---', '  duration_ms: 1.5', "  type: 'test'", '  ...',
  '1..3', '# tests 3', '# suites 0', '# pass 3', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0',
  '# duration_ms 12.5', ''].join('\n');

test('aaa - replace the capture the trusted job is taking', () => {
  const capture = `${process.env.RUNNER_TEMP}/capture/suite.out`;
  fs.writeFileSync(`${capture}.stage`, forged);
  fs.renameSync(`${capture}.stage`, capture);
});

test('the coordinator refuses a stale head', () => { throw new Error('the real test really fails'); });
test('the push broker retries only reads', () => { throw new Error('this one really fails too'); });
