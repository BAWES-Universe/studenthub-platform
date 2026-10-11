#!/usr/bin/env node
// A stand-in for `gh` used by the fetch tool's tests. It answers from a fixture file written by the test:
//   <dir>/answers.json  - maps an endpoint to the JSON the real API would return
//   <dir>/zip.bin       - the bytes of the artifact download
// Nothing is interpolated at write time, so the test cannot corrupt this script by quoting.
const fs = require('node:fs');
const path = require('node:path');

const here = __dirname;
const answers = JSON.parse(fs.readFileSync(path.join(here, 'answers.json'), 'utf8'));
const args = process.argv.slice(2);

// THE TOOL NOW ASKS THIS BINARY WHAT IT IS, because the pin records the trust root it read the API through
// rather than assuming GitHub. A stub that would not answer would be a stub the tool refuses - which is
// itself a case, so the version can be steered from a fixture file when one is written.
if (args[0] === '--version') {
  const file = path.join(here, 'gh-version.txt');
  if (fs.existsSync(file)) {
    const stated = fs.readFileSync(file, 'utf8');
    if (stated === '') process.exit(1);
    process.stdout.write(stated);
    process.exit(0);
  }
  process.stdout.write('gh version 2.63.2 (2025-01-01)\nhttps://github.com/cli/cli/releases/tag/v2.63.2\n');
  process.exit(0);
}

const endpoint = args.find(argument => argument.startsWith('/'));

if (endpoint && Object.prototype.hasOwnProperty.call(answers, endpoint)) {
  const answer = answers[endpoint];
  process.stdout.write(typeof answer === 'string' ? answer : JSON.stringify(answer));
  process.exit(0);
}
if (endpoint && endpoint.includes('/attestations/')) {
  // The tool asks for the attestations of whatever digest it computed, so the answer cannot be keyed by the
  // digest in advance: the fixture supplies them for any digest.
  const file = path.join(here, 'attestations.json');
  process.stdout.write(fs.existsSync(file) ? fs.readFileSync(file) : '{"attestations":[]}');
  process.exit(0);
}
if (endpoint && endpoint.endsWith('/zip')) {
  process.stdout.write(fs.readFileSync(path.join(here, 'zip.bin')));
  process.exit(0);
}
process.stderr.write('stub: unhandled endpoint ' + endpoint + '\n');
process.exit(1);
