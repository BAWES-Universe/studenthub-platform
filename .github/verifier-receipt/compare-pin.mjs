// Compare the pin a candidate COMMITTED with the pin the API produced, and refuse every way they can differ.
//
// WHY THIS IS A FILE AND NOT A `node -e` STRING. It was one, inside `.github/workflows/verify-claim.yml`, and
// the shape of that is what this round is fixing: `pins.find(...)` answers `undefined` when the manifest
// carries no entry for the run the pin names, and the next line read a field off it - so the step died with
// `TypeError: Cannot read properties of undefined`. That fails closed by CRASHING, which is not this
// repository's standard: a refusal names what it refused and why, and a crash names a property access. A
// refusal also has to be testable, and a string inside a YAML step body is not.
//
// WHAT IT ESTABLISHES, and nothing more: the candidate's committed pin says what the API says - on the fields
// that identify the run and the bytes AND on the whole body it publishes; and the receipt behind it records a
// success that is admissible as a pin. It establishes nothing about the fetched pin itself - that is
// `fetch-receipt.mjs`'s job, and it has already refused anything it could not verify by the time this file is
// asked a question.
//
// ITEM 4. THE BODY IS COMPARED, NOT JUST THE BOOLEAN. This step used to compare ten scalar fields and
// `receipt.conclusion.verdict`, and nothing else - so the `receipt` block a candidate publishes (`suite`,
// `named_tests`, `named_tests_summary`, `candidate`, `manifest`), the whole `admissibility` block that says
// which rule admitted it, `artifact_id` and `attestation_digest` were all free text. A review committed a pin
// whose body said the suite was red with 60 failures under tests it had renamed, naming an all-`f` module blob
// and `derived_reasons: ["the suite was red and we pinned it anyway"]`, and this step said ACCEPTED, because
// the one string it checked was honest. The brief's acceptance criterion is rejection of a tampered boolean
// AND BODY, so every key of the fetched pin is now either compared or named below as deliberately not.
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

// ITEM 5a. A DUPLICATE run_id IS REFUSED BY NAME. `pins.find(...)` answers the FIRST match, so a manifest
// carrying an honest pin for run 4242 and a forged second one for the same run was verified twice against the
// honest one and the forgery was never looked at - and the workflow's loop iterates the manifest's run ids, so
// it asked about that run twice and got the same answer both times. A manifest that says two things about one
// run has not said what that run was, and choosing either of them is this file deciding something the evidence
// does not.
const byRun = new Map();
for (const pin of pins) {
  const id = String(pin?.run_id ?? null);
  byRun.set(id, (byRun.get(id) ?? 0) + 1);
}
const duplicated = [...byRun.entries()].filter(([, count]) => count > 1);
if (duplicated.length > 0) {
  fail('the candidate\'s pin file carries more than one pin for the same run: '
    + duplicated.map(([id, count]) => `run ${id} (${count} pins)`).join('; ')
    + '. Two pins for one run are two claims about one measurement, and this step refuses the disagreement '
    + 'rather than reading the first of them and never looking at the second');
}

// ITEM 5b. EVERY PIN NAMING THE RUN IS COMPARED, NOT THE FIRST. The refusal above already makes this set a
// singleton today; it is a filter rather than a find so that the property "no pin naming this run goes
// unexamined" holds on its own, and does not quietly become false if the duplicate rule is ever relaxed.
//
// ITEM 5c. A NAMED REFUSAL WHERE THERE WAS A TYPEERROR. The candidate's file may simply not contain the run
// this verification fetched - a pin deleted, a run id edited, a file rewritten between steps - and the answer
// to that is a sentence saying so, with what was looked for and what was there.
const claimedPins = pins.filter(pin => String(pin?.run_id) === String(fetched.run_id));
if (claimedPins.length === 0) {
  const present = pins.map(pin => String(pin?.run_id ?? null));
  fail(`the candidate's pin file carries no pin for run ${fetched.run_id}, which is the run this verification `
    + `fetched: it holds ${pins.length} pin(s)`
    + (present.length > 0 ? ` naming ${present.join(', ')}` : '')
    + '. A pin that is not there cannot be the evidence for a term, and its absence is refused by name rather '
    + 'than read off an undefined object');
}

// C9. THE VERDICT AND THE ADMISSIBILITY ARE REQUIRED, NOT MERELY COMPARED. The check below asks only that the
// two objects AGREE about the verdict, so a pin that honestly copies `verdict: "failure"` used to pass this
// step - agreement is not success. This is the step that gates the candidate, so it asks for the thing itself.
// It is asked of the FETCHED pin, which is why it is settled once rather than per claimed pin.
if (fetched.receipt?.conclusion?.verdict !== 'success') {
  fail('the pin names a run whose receipt records verdict '
    + `${JSON.stringify(fetched.receipt?.conclusion?.verdict ?? null)}, and only a success establishes anything`);
}
if (fetched.receipt?.admissible_as_pin !== true) {
  fail('the pin names a receipt that is not admissible as a pin (admissible_as_pin '
    + `${JSON.stringify(fetched.receipt?.admissible_as_pin ?? null)})`);
}

// C10 AND ITEM 4. WHAT MUST AGREE, AND WHAT IS NAMED AS NOT AGREEING RATHER THAN LEFT OUT.
//
// `SCALARS` are compared as strings, which is how they have always been compared. `BODIES` are compared
// whole, by canonical JSON, so that every field inside them is covered by naming the block once - adding a
// field to the pin cannot silently add an uncompared field.
const SCALARS = ['schema', 'repository', 'workflow_path', 'workflow_ref', 'workflow_head_sha', 'run_id',
  'run_attempt', 'artifact_name', 'artifact_id', 'artifact_digest', 'receipt_digest', 'attestation_digest',
  'attestation_workflow_ref'];
// `receipt` is the body the pin publishes - the suite, the named tests and their summary, the candidate and
// the manifest - and `admissibility` is the rule the pin says admitted it, both of which a candidate could
// previously write anything into.
const BODIES = ['receipt', 'admissibility'];
// AND THE ONE BLOCK THAT IS DELIBERATELY NOT COMPARED, NAMED HERE SO THAT "never compared" IS A STATEMENT
// RATHER THAN AN OVERSIGHT. `fetched_with` records the binaries THIS verification read the API and opened the
// archive through. It is a fact about the verifying run's channels, not about the receipt: the candidate's pin
// was produced by a different run on a different machine, so requiring the two to agree would refuse honest
// pins and establish nothing. The value a reader should trust is the fetched pin's, which this run measured.
const NOT_COMPARED = { fetched_with: 'it describes the binaries THIS verification read the API and opened the '
  + 'archive through, not the receipt, so the candidate\'s copy of it is not evidence of anything and is not '
  + 'required to match' };

// ITEM 3. AND IT IS PRINTED, BECAUSE NOT COMPARED WAS BEING READ AS NOT THERE.
//
// The reasoning above is right and the conclusion drawn from it was not. A review committed a pin whose
// `fetched_with` named a `gh` that never existed, and this step said ACCEPTED without a word; it committed a
// pin with no `fetched_with` at all and got the same silence. So the DURABLE record - the file in the
// repository, which is the only pin a reader ever opens - carried an unchecked trust-root statement that
// nothing in the log contradicted, while `fetch-receipt.mjs` claimed a reader could see which binaries the
// evidence rested on.
//
// LOGGED RATHER THAN REFUSED, and the reason is that the honest workflow is to commit the pin the fetch tool
// emitted, and that pin carries this block. Refusing its presence would refuse the tool's own output, so the
// rule would be "delete a field the producer writes" - a trap rather than a check. Printing both values costs
// nothing, cannot refuse an honest candidate, and turns a silent claim into one a reader can see and
// disbelieve. Nothing here is evidence, and this function says so in the line it prints.
const channels = value => (value === undefined ? 'absent'
  : value === null || typeof value !== 'object' || Array.isArray(value) ? JSON.stringify(value)
    : Object.keys(value).length === 0 ? '{}'
      : Object.keys(value).sort().map(key => `${key}=${JSON.stringify(value[key])}`).join(' '));
const reportFetchedWith = claimed => {
  console.log(`note: fetched_with is not compared (${NOT_COMPARED.fetched_with}). This run measured: `
    + `${channels(fetched.fetched_with)}`);
  console.log(`note: the committed pin for run ${fetched.run_id} states: ${channels(claimed.fetched_with)}. `
    + 'That statement was not verified by anything and establishes nothing: it is printed so that a trust '
    + 'root a candidate wrote into the durable record is visible rather than silent');
};

// A field of the fetched pin that is in none of the three lists is a field nobody decided about. That is
// exactly how `artifact_id` and `attestation_digest` came to be uncompared, so it is refused here: this step
// fails closed on a pin shape it was not written for rather than passing over the part it does not know.
const known = new Set([...SCALARS, ...BODIES, ...Object.keys(NOT_COMPARED)]);
const unknown = Object.keys(fetched).filter(field => !known.has(field));
if (unknown.length > 0) {
  fail(`the pin this run fetched carries ${unknown.length} field(s) this comparison does not know about `
    + `(${unknown.join(', ')}): a field that is neither compared nor named as uncompared is a field a `
    + 'candidate is free to write anything into, which is the defect this list exists to prevent');
}

const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Where two objects differ, say WHICH key - a diff of two 3000-character blobs is not a refusal a reader can
// act on. Where one side is not an object at all there are no keys to name, so the block is reported whole.
const differingKeys = (claimed, expected) => {
  if (!isObject(claimed) || !isObject(expected)) return null;
  const keys = [...new Set([...Object.keys(claimed), ...Object.keys(expected)])].sort();
  return keys.filter(key => canonical(claimed[key]) !== canonical(expected[key]));
};

for (const claimed of claimedPins) {
  const wrong = SCALARS.filter(field => String(claimed[field]) !== String(fetched[field]));
  if (wrong.length > 0) {
    fail('the claimed pin disagrees with the run it names on: '
      + wrong.map(field => `${field} (claimed ${JSON.stringify(claimed[field] ?? null)}, `
        + `fetched ${JSON.stringify(fetched[field] ?? null)})`).join('; '));
  }
  // The verdict gets its own sentence before the block comparison below, because it is the disagreement a
  // reader most often has to act on and "receipt.conclusion differs" is a worse way to say it.
  const claimedSaysVerdict = claimed.receipt?.conclusion?.verdict ?? null;
  if (claimedSaysVerdict !== fetched.receipt?.conclusion?.verdict) {
    fail(`the claimed pin reports verdict ${JSON.stringify(claimedSaysVerdict)} and the receipt it names `
      + `reports ${JSON.stringify(fetched.receipt?.conclusion?.verdict ?? null)}`);
  }
  for (const block of BODIES) {
    if (canonical(claimed[block]) === canonical(fetched[block])) continue;
    const keys = differingKeys(claimed[block], fetched[block]);
    fail(`the claimed pin publishes a ${block} block that is not the one this verification fetched, on `
      + (keys === null
        ? `the whole block (claimed ${JSON.stringify(claimed[block] ?? null)}, fetched `
          + `${JSON.stringify(fetched[block] ?? null)})`
        : `${keys.length} field(s): `
          + keys.map(key => `${block}.${key} (claimed ${JSON.stringify(claimed[block][key] ?? null)}, fetched `
            + `${JSON.stringify(fetched[block][key] ?? null)})`).join('; '))
      + '. A pin publishes a body as well as a verdict, and a body nobody compares is a body that can say '
      + 'anything');
  }
  // FIELDS THE COMMITTED PIN CARRIES AND THE FETCHED ONE DOES NOT ARE PRINTED, NOT REFUSED. What a manifest
  // pin may carry beyond the fetched shape - a term id, a note - is the manifest schema's business and the
  // owner's decision, not this step's, and refusing them here would settle it by accident. They establish
  // nothing, so they are named in the log rather than left silent: a reader can then see everything the
  // committed pin says that this step did not check.
  reportFetchedWith(claimed);
  const extra = Object.keys(claimed).filter(field => !(field in fetched));
  if (extra.length > 0) {
    console.log(`note: the committed pin for run ${fetched.run_id} carries ${extra.length} field(s) the `
      + `fetched pin does not (${extra.join(', ')}); they are not compared and establish nothing`);
  }
}
const claimedVerdict = fetched.receipt?.conclusion?.verdict ?? null;
console.log(`pin for run ${fetched.run_id} matches the API on every compared field `
  + `(${claimedPins.length} claimed pin(s), ${SCALARS.length} scalar(s), the ${BODIES.join(' and ')} blocks; `
  + `${Object.keys(NOT_COMPARED).join(', ')} is not compared and why is in this file), verdict ${claimedVerdict}`);
