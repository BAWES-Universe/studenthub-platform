// Compare the pin a candidate COMMITTED with the pin the API produced, and refuse every way they can differ.
//
// WHY THIS IS A FILE AND NOT A `node -e` STRING. It was one, inside `.github/workflows/verify-claim.yml`, and
// the shape of that is what this round is fixing: `pins.find(...)` answers `undefined` when the manifest
// carries no entry for the run the pin names, and the next line read a field off it - so the step died with
// `TypeError: Cannot read properties of undefined`. That fails closed by CRASHING, which is not this
// repository's standard: a refusal names what it refused and why, and a crash names a property access. A
// refusal also has to be testable, and a string inside a YAML step body is not.
//
// WHAT IT ESTABLISHES, and nothing more: the candidate's committed pin says what the API says, on the fields
// that identify the run and the bytes; and the receipt behind it records a success that is admissible as a
// pin. It establishes nothing about the fetched pin itself - that is `fetch-receipt.mjs`'s job, and it has
// already refused anything it could not verify by the time this file is asked a question.
//
// Usage:  node compare-pin.mjs --fetched <pin.json> --manifest <verifier-receipts.json>
import fs from 'node:fs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index].replace(/^--/, ''), process.argv[index + 1]);
}
const fetchedPath = args.get('fetched');
const manifestPath = args.get('manifest');
if (!fetchedPath || !manifestPath) {
  console.error('usage: compare-pin.mjs --fetched <pin.json> --manifest <verifier-receipts.json>');
  process.exit(2);
}

const fail = message => {
  console.error(`::error::${message}`);
  process.exit(1);
};
const read = (file, what) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${what} could not be read as JSON (${file}): ${error.message}`);
  }
};

const fetched = read(fetchedPath, 'the pin this run fetched from the API');
const body = read(manifestPath, 'the candidate\'s committed pin file');
const pins = Array.isArray(body) ? body : body?.pins ?? [];
if (!Array.isArray(pins)) {
  fail(`the candidate's pin file carries no array of pins (${JSON.stringify(typeof pins)}), so there is `
    + 'nothing in it to compare with the run the API describes');
}

// ITEM 5. A NAMED REFUSAL WHERE THERE WAS A TYPEERROR. The candidate's file may simply not contain the run
// this verification fetched - a pin deleted, a run id edited, a file rewritten between steps - and the answer
// to that is a sentence saying so, with what was looked for and what was there.
const claimed = pins.find(pin => String(pin?.run_id) === String(fetched.run_id));
if (!claimed) {
  const present = pins.map(pin => String(pin?.run_id ?? null));
  fail(`the candidate's pin file carries no pin for run ${fetched.run_id}, which is the run this verification `
    + `fetched: it holds ${pins.length} pin(s)`
    + (present.length > 0 ? ` naming ${present.join(', ')}` : '')
    + '. A pin that is not there cannot be the evidence for a term, and its absence is refused by name rather '
    + 'than read off an undefined object');
}

// C10. The fields that must agree, INCLUDING the two a previous round added to the pin and never compared:
// `attestation_workflow_ref` is the anchor that distinguishes a receipt made by the protected definition from
// one made by a pull request's, and `schema` is what says these two objects are the same kind of thing at all.
// A field computed at fetch time and never compared is a field the candidate is free to write anything into.
const FIELDS = ['schema', 'workflow_path', 'workflow_ref', 'workflow_head_sha', 'run_id', 'run_attempt',
  'artifact_name', 'artifact_digest', 'receipt_digest', 'attestation_workflow_ref'];
const wrong = FIELDS.filter(field => String(claimed[field]) !== String(fetched[field]));
if (wrong.length > 0) {
  fail('the claimed pin disagrees with the run it names on: '
    + wrong.map(field => `${field} (claimed ${JSON.stringify(claimed[field] ?? null)}, `
      + `fetched ${JSON.stringify(fetched[field] ?? null)})`).join('; '));
}

// C9. THE VERDICT AND THE ADMISSIBILITY ARE REQUIRED, NOT MERELY COMPARED. The check below this one asks only
// that the two objects AGREE about the verdict, so a pin that honestly copies `verdict: "failure"` used to
// pass this step - agreement is not success. This is the step that gates the candidate, so it asks for the
// thing itself.
if (fetched.receipt?.conclusion?.verdict !== 'success') {
  fail('the pin names a run whose receipt records verdict '
    + `${JSON.stringify(fetched.receipt?.conclusion?.verdict ?? null)}, and only a success establishes anything`);
}
if (fetched.receipt?.admissible_as_pin !== true) {
  fail('the pin names a receipt that is not admissible as a pin (admissible_as_pin '
    + `${JSON.stringify(fetched.receipt?.admissible_as_pin ?? null)})`);
}

const claimedVerdict = claimed.receipt?.conclusion?.verdict ?? null;
if (claimedVerdict !== fetched.receipt?.conclusion?.verdict) {
  fail(`the claimed pin reports verdict ${JSON.stringify(claimedVerdict)} and the receipt it names reports `
    + `${JSON.stringify(fetched.receipt?.conclusion?.verdict ?? null)}`);
}
console.log(`pin for run ${fetched.run_id} matches the API, verdict ${claimedVerdict}`);
