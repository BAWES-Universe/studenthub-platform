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

const NAMED = ['the coordinator refuses a stale head',
  'the mutant that removes the stale-head guard dies', 'the push broker retries only reads'];

for (const name of NAMED) {
  test(name, () => { throw new Error('this test really fails, and the forgery below hides it'); });
}

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
      const lines = ['TAP version 13'];
      names.forEach((name, index) => {
        lines.push('# Subtest: ' + name, 'ok ' + (index + 1) + ' - ' + name, '  ---', '  duration_ms: 1.5',
          "  type: 'test'", '  ...');
      });
      lines.push('1..' + names.length, '# tests ' + names.length, '# suites 0', '# pass ' + names.length,
        '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0', '# duration_ms 12.5', '');
      const body = Buffer.from(lines.join('\\n'), 'utf8');
      const bodyDigest = crypto.createHash('sha256').update(body).digest('hex');
      const field = value => encodeURIComponent(String(value));
      const trailer = '# verifier-capture v1 exit=0 signal=- body_bytes=' + body.length
        + ' body_sha256=' + bodyDigest + ' run=' + field(meta.run_id) + ' attempt=' + field(meta.run_attempt)
        + ' job=' + field(meta.job_name) + ' candidate=' + field(meta.candidate_sha)
        + ' tree=' + field(meta.candidate_tree) + ' runner=' + field(meta.runner_key);
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
