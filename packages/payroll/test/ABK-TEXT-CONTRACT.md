# F4 ABK advice TXT: pure deterministic adjacent slice

Release base `9ecba1853399d65786fc1224397ece0aa62290b2`. Exact source: `BAWES-Universe/studenthub@55119d36b87b9255eec51ecb865398c04bccbda0`, `admin/modules/v1/controllers/TransferController.php`, blob `13ec974446bf9a6027eb664c3523bad261cb4b6f`.

- Action starts 1838. Candidate selection, currency filter, bank-info/Civil-ID scopes and completed profile/bank/IBAN/name/invoice eligibility occur before formatting. This module consumes selected immutable rows; it does NOT implement those database filters.
- 1892: header sum uses `totalPaidToCandidate`, NOT XLSX `candidate_total`.
- 1903: batch label is `T<serial>V1`. This candidate requires explicit stable batch ID; it does not run count+1 or generate IDs.
- 1907–1908: `FHR,<batch>,<m/d/Y>,<count>,<sum three decimals>;` plus `PHP_EOL`.
- 1916–1919: ABKK maps to WIB and extracted account (remove first eight characters then every nine-zero sequence); other banks map to KASIP and full IBAN.
- 1921–1928: APO records, fixed literal KW locations, currency, finalized amount at 3dp, payment type, SWIFT plus XXX, OBS, `S <tcId>`, and tail `,O,,,,,,,;` plus `PHP_EOL`. Exact 26 comma-separated fields including the semicolon-only last segment. No footer.
- 1933–1939: raw concatenated text written with fopen `w` and fwrite. There is NO padding, charset conversion or BOM addition in the formatter. PHP_EOL depends on source OS; source does NOT establish CRLF universally. Windows text-mode translation adds an additional runtime dependency outside this pure candidate.

The source's hardcoded debit account and origin code are not copied. Caller supplies synthetic/configured identifiers. Tests use non-routable synthetic values only.

## Tests and acceptance

`npm run build && node --test packages/payroll/test/abk-advice-text.test.mjs` runs 12 tests against compiled JavaScript: literal complete UTF-8 LF byte vector; complete CRLF vector; Arabic byte sequence/no BOM; empty header-only batch; exact fils total and zero; deterministic corrected retry; delimiter/control/surrogate injection rejection; duplicate IDs; mixed currencies; negative/unrounded amounts; valid leap day and invalid dates. Strict ES2022/NodeNext TypeScript check passed. The standard test runner discovers this source .test.mjs file automatically; no runner, build, package or baseline edits are required. XLSX candidate is excluded from this release.

## Intentional differences / remaining checks

This implementation uses UTF-8 with no BOM as an explicit contract. PHP source writes existing string bytes without conversion, so deployment/input encoding remains to be verified before claiming full legacy byte parity. LF/CRLF is explicit; caller must choose the proven legacy platform convention. No implicit clock/timezone.

All inputs must be finalized nonnegative amounts at exactly 3 decimals. BigInt fils produces the header as the exact sum of emitted detail amounts, avoiding the source's floating sum then number_format divergence. Source rounding of arbitrary unrounded floats is NOT reproduced. Candidate rejects delimiters/newlines/invalid Unicode rather than copying malformed records, enforces unique tcIds and consistent currency, and caps 10,000 lines. Empty batch preserves source's zero-header-only shape. Stable input order is preserved, not sorted.

This proves the selected pure byte contract for synthetic vectors, not bank approval, real-account validation, source runtime execution or payment eligibility. No database, filesystem, clock, export registry, direct download or network calls exist in the generator. P-1 owns access/audit/read-link integration separately. No dependencies or shared build files added.

## Publication boundary

This is a formatter foundation, not an operational F4 export. The callable production source emits exact synthetic-tested bytes with no injected encoder, runtime dependency or mock. Its first meaningful consumer is the owner-selected locked-line snapshot + persisted generation service, with authenticated P-1 delivery handled separately. Do not wire directly to a download route or treat this PR as completion of bank-approved payment exports. Public API is the module exports `generateAbkAdviceText`, `AbkAdviceLine` and `AbkAdviceContract`; it does not require F1/F3 data-store modules.
