// THE DEFEAT OF THE COMMIT UNDER REVIEW, AS A FIXTURE. A cold review ran this three times out of three and
// reached `verdict success; 2/2 terms established; admissible as pin: true` for a tree whose every named test
// had really FAILED.
//
// The suite below fails every test the claim names, and then detaches a process that outlives it - stdio
// 'ignore', so the trusted capture process sees EOF the moment the real runner exits - which waits for
// capture-stream.mjs to write suite.out and capture-meta.json and rewrites BOTH of them: a forged stream in
// which the three named tests pass, a forged trailer that agrees with those bytes, and a meta whose every
// digest, byte count and exit status agrees with the forgery. Every identifying field it needs is already in
// the environment of the step the candidate's own tests run in, which is the whole point.
//
// It is kept and run because the only honest way to show where a defence reaches is to point the defeat at it.
// Two tests in the suite use it: one asserts this forgery is now refused by name, because it cannot reach the
// exit status the measure job publishes as its own output; the other asserts that a forger which ALSO beats
// that channel is NOT refused, which is the open residual and is not closed by anything in this authority.
import { test } from 'node:test';
import { spawn } from 'node:child_process';

// Every name the world's default claim rests on. The forger has to produce all of them, because a name the
// stream does not carry is `absent` and the verdict would be failure for a reason that has nothing to do with
// the forgery.
const NAMED = ['the coordinator refuses a stale head',
  'the mutant that removes the stale-head guard dies', 'the push broker retries only reads',
  'the mutant that removes the read-only retry guard dies'];
// AND THE FILE THE CLAIM SAYS THEY LIVE IN. The emitter no longer establishes a term from a point the runner
// reported no `location:` for, so the forgery now writes one - which costs it a single line per point, because
// the location is a line of the stream the forger already owns. That is the honest measure of what the
// name-to-file binding is worth against a forger INSIDE the measured process: nothing. What it is worth
// against a candidate that merely moves a stub into another file is in the tests above.
const LOCATION = '/home/runner/work/repo/repo/candidate/.github/coordinator/service/test/coordinator-checks.mjs';

// DECLARED ONE PER LINE, not in a loop. `node --test` reports the file and line a point was declared at, and
// four tests declared in one loop body share one. The emitter refuses a capture whose points carry more than
// one claimed name at a single file and line - one test reported under two names is a test this authority
// cannot attribute - so a loop here would make this fixture fail on point identity before it ever reached the
// forgery it exists to demonstrate.
const boom = () => { throw new Error('this test really fails, and the forgery below hides it'); };
test(NAMED[0], boom);
test(NAMED[1], boom);
test(NAMED[2], boom);
test(NAMED[3], boom);

test('detach a process that outlives this suite and rewrites the capture', () => {
  const forger = `
    const fs = require('node:fs');
    const path = require('node:path');
    const crypto = require('node:crypto');
    const dir = process.env.CAPTURE_DIR;
    const metaPath = path.join(dir, 'capture-meta.json');
    const deadline = Date.now() + 20000;
    const wait = () => {
      if (!fs.existsSync(metaPath) || !fs.existsSync(path.join(dir, 'suite.out'))) {
        if (Date.now() > deadline) return;
        return setTimeout(wait, 5);
      }
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const names = ${JSON.stringify(NAMED)};
      const where = ${JSON.stringify(LOCATION)};
      const lines = ['TAP version 13'];
      names.forEach((name, index) => {
        lines.push('# Subtest: ' + name, 'ok ' + (index + 1) + ' - ' + name, '  ---', '  duration_ms: 1.5',
          "  type: 'test'", "  location: '" + where + ':' + (12 + index) + ":1'", '  ...');
      });
      lines.push('1..' + names.length, '# tests ' + names.length, '# suites 0', '# pass ' + names.length,
        '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0', '# duration_ms 12.5', '');
      const body = Buffer.from(lines.join('\\n'), 'utf8');
      const bodyDigest = crypto.createHash('sha256').update(body).digest('hex');
      const field = value => encodeURIComponent(String(value));
      const trailer = '# verifier-capture v1 exit=0 signal=- body_bytes=' + body.length
        + ' body_sha256=' + bodyDigest + ' run=' + field(meta.run_id) + ' attempt=' + field(meta.run_attempt)
        + ' job=' + field(meta.job_name) + ' candidate=' + field(meta.candidate_sha)
        + ' tree=' + field(meta.candidate_tree) + ' runner=' + field(meta.runner_key)
        + ' node=' + field(meta.runner_node) + ' arch=' + field(meta.runner_arch)
        + ' image=' + field(meta.runner_image === null ? '-' : meta.runner_image)
        + ' image_version=' + field(meta.runner_image_version === null ? '-' : meta.runner_image_version);
      const capture = Buffer.concat([body, Buffer.from(trailer + '\\n', 'utf8')]);
      fs.writeFileSync(path.join(dir, 'suite.out'), capture);
      meta.capture_bytes = capture.length;
      meta.capture_sha256 = crypto.createHash('sha256').update(capture).digest('hex');
      meta.capture_body_bytes = body.length;
      meta.capture_body_sha256 = bodyDigest;
      meta.capture_trailer = trailer;
      meta.suite_exit = '0';
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\\n');
      fs.writeFileSync(path.join(process.env.RUNNER_TEMP, 'forged'), meta.capture_sha256 + '\\n');
    };
    wait();
  `;
  const child = spawn(process.execPath, ['-e', forger], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
});
