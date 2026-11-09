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
