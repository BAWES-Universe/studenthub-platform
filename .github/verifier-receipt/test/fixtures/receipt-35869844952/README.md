# A real receipt, and the refusal it is the fixture for

`receipt.trimmed.json` is the receipt the authority produced on run **35869844952** for candidate
**6feac016e3a0796d0c7b21d86426af0f1491a9c1**, with three top-level keys removed and nothing else changed.
It is here because the consumer's refusals were previously tested only against receipts the test wrote
itself, and a receipt a test invents agrees with the test about what a receipt looks like.

It is a **failure** receipt, and that is why it is the honest fixture for the refusal path: a real receipt,
from a real dispatch of the authority on `refs/heads/main`, that a real consumer must refuse to pin.

    "provenance": {
      "admissible_as_pin": false,
      "inadmissibility_reasons": [
        "this receipt's verdict is failure, so there is nothing in it for a manifest to pin"
      ]
    }

The candidate's suite ran 3649 tests with 60 failing, none of them named by the claim
(`conclusion.verdict: "failure"`, `suite.state: "red"`). The authority's `attest` job refused to attest it,
so **GitHub recorded no attestation over these bytes** - read back on 2026-09-23:

    $ gh api /repos/BAWES-Universe/studenthub-platform/attestations/sha256:74947a1b7ece2db76a723b245078012e867b0aecadb913ef26769371979cf815
    gh: Not Found (HTTP 404)

`fetch-receipt.test.mjs` refuses this receipt on admissibility before it ever asks the API for an
attestation, so the case that reads this file supplies none.

Every identity field in it is genuine and passes the consumer's identity checks - the path, the ref, the
repository and the head_sha are what that dispatch recorded - which is what makes the refusal land where it
should: on admissibility, not on shape.

## What the real bytes are

Retrieved through GitHub's API as an Actions artifact of run 35869844952, never written by a lane. The
artifact is `verifier-receipt`, id `10754354187`, created `2026-09-23T13:56:11Z`; the digest below is the
one **GitHub itself reports** for it:

    $ gh api /repos/BAWES-Universe/studenthub-platform/actions/runs/35869844952/artifacts \
        --jq '.artifacts[] | select(.name == "verifier-receipt") | {id, size_in_bytes, digest}'
    {"digest":"sha256:b6c84e8325aec145cad7b912bbef0a29a560a85b4ed2d96d92668b39127736ff",
     "id":10754354187,"size_in_bytes":61770}

The run itself is `{"event":"workflow_dispatch","head_branch":"main","status":"completed",`
`"conclusion":"failure","head_sha":"01409cc7e4ad5ab9aab2c24a9e3b1f6f45df2a1e","run_attempt":1}`. The
**failure** conclusion is the run's, and the consumer refuses on it before reading any receipt at all -
which is why the admissibility case in `fetch-receipt.test.mjs` stages this run with `conclusion: "success"`
and says so in the one place it departs from the API's record. Everything else it stages is the API's.

| object | bytes | sha256 |
| --- | --- | --- |
| `artifact.zip` (the artifact as GitHub served it) | 61,770 | `b6c84e8325aec145cad7b912bbef0a29a560a85b4ed2d96d92668b39127736ff` |
| `receipt.json` inside it | 276,367 | `74947a1b7ece2db76a723b245078012e867b0aecadb913ef26769371979cf815` |
| `controller-observed.json` inside it | 562,525 | `c4f819a73a219af604a79aa9839ca5706d6835b2f11e7ead159f0ed429b7a5d6` |
| `receipt.trimmed.json` (this directory) | 89,010 | `93595c1e7238434d9df7377fa28d5b98924fce52116d5cd2e613ab8fdb7baad3` |

`controller-observed.json` is the controller's own observations, not the candidate's stdout. It is not
copied here: nothing in the consumer reads it.

## Exactly which bytes are trimmed

Three top-level keys were **removed whole**. No value anywhere in this file was edited, reordered or
rounded, and nothing was added.

| key removed | size as JSON | what it held |
| --- | --- | --- |
| `terms` | 111,811 bytes | 53 per-term rows |
| `terms_summary` | 8,729 bytes | the per-term histogram over those 53 |
| `controller_observation` | 11,729 bytes | the controller's summary of the same run |

The consumer in this branch reads none of the three. Everything the consumer reads - `schema`,
`repository`, `workflow.*`, `run.id`, `candidate`, `provenance.admissible_as_pin`,
`provenance.inadmissibility_reasons`, `manifest`, `suite`, `named_tests`, `named_tests_summary` and
`conclusion` - is present here verbatim. `named_tests` is kept in full (132 rows, 52,810 bytes) precisely
because the pin would carry it.

**A trimmed file is not the receipt.** Its bytes hash to `93595c1e...`, not to `74947a1b...`, so it can
never stand in for the receipt in a digest or attestation check; it stands in only for the receipt's
*contents*, which is what the checks it exercises read. `fetch-receipt.test.mjs` pins `93595c1e...` so that
a later edit to this file - including one made to turn a refusal into a pass - fails the suite rather than
passing quietly.

## Reproducing this file from the artifact

With the artifact downloaded to `$DIR` (`gh api /repos/<owner>/<name>/actions/artifacts/<id>/zip`):

    python3 -c "import sys,zipfile; a=zipfile.ZipFile(sys.argv[1]); open(sys.argv[2],'wb').write(a.read('receipt.json'))" \
      "$DIR/artifact.zip" "$DIR/receipt.json"
    node -e '
      const fs = require("node:fs");
      const receipt = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      for (const key of ["terms", "terms_summary", "controller_observation"]) delete receipt[key];
      fs.writeFileSync(process.argv[2], JSON.stringify(receipt, null, 2) + "\n");
    ' "$DIR/receipt.json" receipt.trimmed.json

and the check that the trim dropped keys rather than changing values:

    node -e '
      const fs = require("node:fs"), assert = require("node:assert/strict");
      const real = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const trimmed = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
      for (const key of ["terms", "terms_summary", "controller_observation"]) delete real[key];
      assert.deepEqual(trimmed, real);
    ' "$DIR/receipt.json" receipt.trimmed.json

Re-serialising with `JSON.stringify(..., 2)` changes whitespace, which is why the table above records the
trimmed file's own digest separately instead of implying it is the receipt's.
