# EnvironmentFile quoting correction — local validation

Branch: `fix/env-content-systemd-quoting`.
Start/main: `b3ef54855c52b8a14f2ed7b23ff71247e4714f9f`.
History confirmed: #127 (`b3ef548`), #126 (`75b996c`), #125 (`bd13e3f`).

## Parsing rules

`service/units.mjs:37`: `raw = raw.replace(/^[ \t\r]+|[ \t\r]+$/g, '');`
removes outer systemd whitespace.

`service/units.mjs:38`: `if (/[\x00\r\n$]/.test(raw)) return undefined;`
rejects NUL, embedded CR/newline and all dollar syntax conservatively.
Dollar rejection is requested policy, not a claim that EnvironmentFile performs
shell variable expansion.

`service/units.mjs:40`: `if (delimiter && (raw.length < 2 || raw.at(-1) !== delimiter)) return undefined;`
requires matching outer quotes.

`service/units.mjs:41`: `const body = delimiter ? raw.slice(1, -1) : raw;`
strips the matching pair.

`service/units.mjs:46`: `if (character === delimiter || (!delimiter && /["']/.test(character))) return undefined;`
rejects an unescaped delimiter, trailing text after closure, and ambiguous unquoted quotes.
The other quote kind is literal inside a quoted value.

`service/units.mjs:47`: `if (character === '\\' && delimiter !== "'") {`
leaves single-quoted backslashes literal. Line 48 rejects a dangling escape or continuation.
Line 51 decodes double-quoted escapes for double quote, backslash and backtick;
unknown double-quoted escapes retain both characters. Exact line 51:

```js
value += delimiter === '"' && !/["\\`$]/.test(next) ? '\\' + next : next;
```
 Dollar syntax is already refused.
Unquoted escapes consume the backslash and preserve the next character.

`service/units.mjs:79`: `assert.ok(value !== undefined && value.trim().length > 0, 'SHU251_ENV_CONTENT: well-formed nonempty unambiguous effective values required');`
validates successful parsing and effective nonemptiness. Supervisor byte length is
checked on the decoded value by the unchanged supervisor guard.

Reference: [systemd EnvironmentFile documentation](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml).
This is a conservative single-line subset, not a complete EnvironmentFile parser.
A single-quoted value containing an inner single quote cannot satisfy the requested
matching-quote/no-trailing-text rules. That spelling is a negative control. The
positive controls instead cover single-quoted JSON with inner double quotes and
double-quoted JSON with both quote kinds (inner double quotes escaped).
No host files were inspected and no real credential values were used or recorded.

## Controls and mutations

All 26 controls pass normally and in each throwaway copy. Each acceptance control
runs both render and assertPolicy. Four host-shaped controls are COMMAND,
SSH_COMMAND, DOUBLE_JSON and SINGLE_JSON, covering the four reported key names.
Additional controls cover escapes, outer whitespace and effective secret byte length.
Every negative below refuses in both render and assertPolicy with `SHU251_ENV_CONTENT`.

- `ENV_CONTENT_REFUSE_EMPTY`
- `ENV_CONTENT_REFUSE_WHITESPACE`
- `ENV_CONTENT_REFUSE_QUOTED_EMPTY`
- `ENV_CONTENT_REFUSE_QUOTED_WHITESPACE`
- `ENV_CONTENT_REFUSE_UNTERMINATED_DOUBLE`
- `ENV_CONTENT_REFUSE_MISMATCHED`
- `ENV_CONTENT_REFUSE_TRAILING`
- `ENV_CONTENT_REFUSE_INNER_DOUBLE`
- `ENV_CONTENT_REFUSE_INNER_SINGLE`
- `ENV_CONTENT_REFUSE_DOLLAR`
- `ENV_CONTENT_REFUSE_BRACED_DOLLAR`
- `ENV_CONTENT_REFUSE_CONTINUATION`
- `ENV_CONTENT_REFUSE_DOUBLE_CONTINUATION`
- `ENV_CONTENT_REFUSE_UNQUOTED_QUOTE`
- `ENV_CONTENT_REFUSE_ESCAPED_CLOSING`

`ENV_CONTENT_MUTATION_STRIP_QUOTES_REMOVED` replaces the body slice with raw text.
It kills COMMAND, SSH_COMMAND, DOUBLE_JSON and SINGLE_JSON by their respective
`ENV_CONTENT_ACCEPT_<label>` assertions.

`ENV_CONTENT_MUTATION_CONTENT_REFUSAL_REMOVED` removes the effective content
assertion. All 15 negatives die by their respective `ENV_CONTENT_REFUSE_<label>`
assertions (which require `SHU251_ENV_CONTENT`).

Both mutants are checked with `node --check units.mjs` (exit 0) before execution.
Every selected case must fail with both `ERR_ASSERTION` and `testCodeFailure`;
SyntaxError, TypeError and module-load failures are explicitly excluded.
The mutation harness copies the module, templates and controls into disposable
fixture directories; all edits and the final commit remain in the working clone.

## Required suites

Normalization: `umask 0002`, `chmod -R go-w .github/coordinator`.

| Invocation | Total | Pass | Fail | Skip | Cancelled | Todo |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `TMPDIR=/tmp node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs` | 1235 | 1228 | 0 | 7 | 0 | 0 |
| `TMPDIR=/tmp SHU_TEST_CLOCK_OFFSET_MS=31536000000 NODE_OPTIONS="--import=$PWD/.github/coordinator/test/fixture/shift-wall-clock.mjs" npm run test:coordinator` | 1235 | 1228 | 0 | 7 | 0 | 0 |

Exact skips in both invocations (not counted as passes):

- SHU-227: worker owns its checkout and recovery preserves descendant commits # SKIP requires root or passwordless sudo for distinct-uid proof
- SHU-227: non-owner service account resolves revision with no global Git trust # SKIP requires distinct-uid execution
- SHU-227: empty-root main drives real Git, both real adapters and real broker through four launches # SKIP requires distinct-uid execution
- SHU-228: empty-root main drives real Git, both real adapters and real broker through four launches # SKIP requires distinct-uid execution
- SHU-241 A2 host: R1 uses the existing bundle transport through the distinct worker identity # SKIP host cannot switch to the fixture worker uid
- SHU-244 A10: distinct-root scoped handoff production workspace # SKIP host cannot switch worker uid
- SHU-71 restricted capability refusal # SKIP production vocabulary has no undeclared runtime/role pair

## Assertion and scope audit

Removed diff lines matching `assert|expect|throw`: **1**, replaced by one semantic
assertion; **0** unreplaced. Old:

```js
assert.ok(value.trim().length > 0 && !/["'\\]/.test(value), 'SHU251_ENV_CONTENT: nonempty unambiguous values required');
```

New (`service/units.mjs:79`):

```js
assert.ok(value !== undefined && value.trim().length > 0, 'SHU251_ENV_CONTENT: well-formed nonempty unambiguous effective values required');
```

The replacement strengthens malformed-input validation by requiring successful
parsing (including dollar/continuation rejection) and retains effective nonemptiness.
It intentionally accepts valid quoting rejected by the old blanket character ban;
it is not a strict subset of the old acceptance set, which would prevent fixing this defect.
All other guards and key_names evidence code are unchanged.
No workflow, config, dispatch gate, SHU-140 or other tracked file outside the
coordinator directory changed. No conflict markers or real secrets in the diff.
`git diff --check` passed.

Config blob at main: `8a0317173d76f4c09811b9365e25b380b38dc93d`.
Working config blob: `8a0317173d76f4c09811b9365e25b380b38dc93d`.

## Test-name multiset

All **71** existing test files are byte-identical to main. Lost-name multiset: `[]`.
Both executions have the same name multiset: **1207 retained occurrences + 28 new
occurrences = 1235**. Equivalently, `M_final = M_main ⊎ M_added`.
Each added name below has multiplicity **1**:

- `ENV_CONTENT_MUTATION_STRIP_QUOTES_REMOVED`
- `ENV_CONTENT_MUTATION_CONTENT_REFUSAL_REMOVED`
- `ENV_CONTENT_ACCEPT_COMMAND`
- `ENV_CONTENT_ACCEPT_SSH_COMMAND`
- `ENV_CONTENT_ACCEPT_DOUBLE_JSON`
- `ENV_CONTENT_ACCEPT_SINGLE_JSON`
- `ENV_CONTENT_ACCEPT_DOUBLE_ESCAPES`
- `ENV_CONTENT_ACCEPT_SINGLE_LITERAL_SLASH`
- `ENV_CONTENT_ACCEPT_UNQUOTED_ESCAPE`
- `ENV_CONTENT_ACCEPT_OUTER_WHITESPACE`
- `ENV_CONTENT_REFUSE_EMPTY`
- `ENV_CONTENT_REFUSE_WHITESPACE`
- `ENV_CONTENT_REFUSE_QUOTED_EMPTY`
- `ENV_CONTENT_REFUSE_QUOTED_WHITESPACE`
- `ENV_CONTENT_REFUSE_UNTERMINATED_DOUBLE`
- `ENV_CONTENT_REFUSE_MISMATCHED`
- `ENV_CONTENT_REFUSE_TRAILING`
- `ENV_CONTENT_REFUSE_INNER_DOUBLE`
- `ENV_CONTENT_REFUSE_INNER_SINGLE`
- `ENV_CONTENT_REFUSE_DOLLAR`
- `ENV_CONTENT_REFUSE_BRACED_DOLLAR`
- `ENV_CONTENT_REFUSE_CONTINUATION`
- `ENV_CONTENT_REFUSE_DOUBLE_CONTINUATION`
- `ENV_CONTENT_REFUSE_UNQUOTED_QUOTE`
- `ENV_CONTENT_REFUSE_ESCAPED_CLOSING`
- `ENV_CONTENT_EFFECTIVE_DOUBLE_DECODE_SHORT`
- `ENV_CONTENT_EFFECTIVE_DOUBLE_DECODE_BOUNDARY`
- `ENV_CONTENT_EFFECTIVE_SINGLE_LITERAL_BOUNDARY`
