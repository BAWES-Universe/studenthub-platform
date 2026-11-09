import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dispatchEnabledFor } from '../reconcile.mjs';

const source = fs.readFileSync(new URL('../reconcile.mjs', import.meta.url), 'utf8');
const gateSource = source.slice(source.indexOf('export function dispatchEnabledFor('), source.indexOf('// resolveAuthorizationRef'));
const config = (mode = 'general', committed = true, pair = false) => ({
  dispatch_scope_mode: mode, enable_dispatch: committed,
  ...(pair ? { dispatch_scope: { issue_ids: ['SHU-140', 'SHU-254'] } } : {}),
});
const on = { ENABLE_DISPATCH: 'true' };
const armed = { state: 'armed' };
const pairArmed = { kind: 'two-fixture-v1', state: 'armed' };
const code = 'DISPATCH_SCOPE_MODE_INVALID';
const positive = gate => assert.equal(gate(on, config()), true, 'GENERAL_BOTH_GATES_ENABLE');
const refusals = [undefined, null, '', 'GENERAL', 'typo', {}, [], true, 1];

// Independent, explicit vectors: runtime order is unset, false, true, TRUE,
// mixed case, empty, whitespace. Bit strings pin every cell (not gate logic).
const runtimes = [undefined, 'false', 'true', 'TRUE', 'True', '', ' true '];
const activations = [null, { state: 'absent' }, { state: 'refused' }, { state: 'spent' }, armed,
  { kind: 'two-fixture-v1', state: 'absent' }, { kind: 'two-fixture-v1', state: 'refused' }, pairArmed];
const committedValues = [false, true, undefined, 'true', 1];
const OFF = '0000000', EXACT = '0010000', LEGACY = '0011100';
// Each row is an activation column; each entry holds the seven runtime cells.
const tables = {
  general: [
    [OFF, OFF, OFF, OFF, OFF, OFF, OFF, EXACT],
    [EXACT, EXACT, EXACT, EXACT, EXACT, OFF, OFF, OFF],
    [OFF, OFF, OFF, OFF, OFF, OFF, OFF, OFF],
    [OFF, OFF, OFF, OFF, OFF, OFF, OFF, OFF],
    [OFF, OFF, OFF, OFF, OFF, OFF, OFF, OFF],
  ],
  bounded: [
    [OFF, OFF, OFF, OFF, LEGACY, OFF, OFF, EXACT],
    [LEGACY, LEGACY, LEGACY, LEGACY, LEGACY, OFF, OFF, OFF],
    [OFF, OFF, OFF, OFF, LEGACY, OFF, OFF, OFF],
    [OFF, OFF, OFF, OFF, LEGACY, OFF, OFF, OFF],
    [OFF, OFF, OFF, OFF, LEGACY, OFF, OFF, OFF],
  ],
  pair: [
    [OFF, OFF, OFF, OFF, OFF, OFF, OFF, EXACT],
    [OFF, OFF, OFF, OFF, OFF, OFF, OFF, OFF],
    [OFF, OFF, OFF, OFF, OFF, OFF, OFF, OFF],
    [OFF, OFF, OFF, OFF, OFF, OFF, OFF, OFF],
    [OFF, OFF, OFF, OFF, OFF, OFF, OFF, OFF],
  ],
};

test('GENERAL_BOTH_GATES_ENABLE', () => positive(dispatchEnabledFor));
test('GATE_EXACT_TRUTH_TABLE_6160_CELLS', () => {
  let cells = 0;
  for (const mode of ['general', 'bounded', ...refusals]) {
    for (const pair of [false, true]) {
      for (const [c, committed] of committedValues.entries()) {
        for (const [a, activation] of activations.entries()) {
          for (const [r, runtime] of runtimes.entries()) {
            const cfg = config(mode, committed, pair);
            // Explicitly remove defaults for the missing-mode/flag cases.
            cfg.dispatch_scope_mode = mode;
            cfg.enable_dispatch = committed;
            if (mode === undefined) delete cfg.dispatch_scope_mode;
            const env = runtime === undefined ? {} : { ENABLE_DISPATCH: runtime };
            const label = `GATE_CELL mode=${JSON.stringify(mode)} pair=${pair} committed=${JSON.stringify(committed)} runtime=${JSON.stringify(runtime)} activation=${JSON.stringify(activation)}`;
            if (mode !== 'general' && mode !== 'bounded') {
              assert.throws(() => dispatchEnabledFor(env, cfg, activation), { code }, label);
            } else {
              assert.equal(dispatchEnabledFor(env, cfg, activation), tables[pair ? 'pair' : mode][c][a][r] === '1', label);
            }
            cells++;
          }
        }
      }
    }
  }
  assert.equal(cells, 6160, 'GATE_ALL_CELLS_MEASURED');
});

const checks = {
  MODE_MISSING_REFUSED: gate => assert.throws(() => gate(on, { enable_dispatch: true }), { code }, 'MODE_MISSING_REFUSED'),
  MODE_UNKNOWN_REFUSED: gate => assert.throws(() => gate(on, config('typo')), { code }, 'MODE_UNKNOWN_REFUSED'),
  MODE_MALFORMED_REFUSED: gate => assert.throws(() => gate(on, config({})), { code }, 'MODE_MALFORMED_REFUSED'),
  MODE_ERROR_NAMED: gate => assert.throws(() => gate(on, config(null)), { code }, 'MODE_ERROR_NAMED'),
  GENERAL_COMMITTED_REQUIRED: gate => assert.equal(gate(on, config('general', false), armed), false, 'GENERAL_COMMITTED_REQUIRED'),
  GENERAL_COMMITTED_STRICT: gate => assert.equal(gate(on, config('general', 'true')), false, 'GENERAL_COMMITTED_STRICT'),
  GENERAL_RUNTIME_REQUIRED: gate => assert.equal(gate({}, config()), false, 'GENERAL_RUNTIME_REQUIRED'),
  GENERAL_RUNTIME_FALSE: gate => assert.equal(gate({ ENABLE_DISPATCH: 'false' }, config()), false, 'GENERAL_RUNTIME_FALSE'),
  GENERAL_RUNTIME_EXACT_CASE: gate => assert.equal(gate({ ENABLE_DISPATCH: 'TRUE' }, config()), false, 'GENERAL_RUNTIME_EXACT_CASE'),
  BOUNDED_SINGLE_UNCHANGED: gate => assert.equal(gate({ ENABLE_DISPATCH: 'TRUE' }, config('bounded', false), armed), true, 'BOUNDED_SINGLE_UNCHANGED'),
  PAIR_COMMITTED_TRUE_REFUSED: gate => assert.equal(gate(on, config('general', true, true), pairArmed), false, 'PAIR_COMMITTED_TRUE_REFUSED'),
};
for (const [name, check] of Object.entries(checks)) test(name, () => check(dispatchEnabledFor));

const modeGuard = 'mode !== "bounded" && mode !== "general"';
const generalBranch = 'if (mode === "general") return config.enable_dispatch === true && env.ENABLE_DISPATCH === "true";';
const mutations = [
  ['M01_DELETE_MODE_REFUSAL', modeGuard, 'false', 'MODE_MALFORMED_REFUSED'],
  ['M02_ALLOW_MISSING_MODE', modeGuard, `${modeGuard} && mode !== undefined`, 'MODE_MISSING_REFUSED'],
  ['M03_ALLOW_UNKNOWN_MODE', modeGuard, `${modeGuard} && mode !== "typo"`, 'MODE_UNKNOWN_REFUSED'],
  ['M04_ALLOW_MALFORMED_MODE', modeGuard, `${modeGuard} && typeof mode !== "object"`, 'MODE_MALFORMED_REFUSED'],
  ['M05_DROP_NAMED_ERROR', '{ code: "DISPATCH_SCOPE_MODE_INVALID" }', '{}', 'MODE_ERROR_NAMED'],
  ['M06_GENERAL_BYPASS_COMMITTED', generalBranch, 'if (mode === "general") return env.ENABLE_DISPATCH === "true";', 'GENERAL_COMMITTED_REQUIRED'],
  ['M07_GENERAL_TRUTHY_COMMITTED', generalBranch, 'if (mode === "general") return !!config.enable_dispatch && env.ENABLE_DISPATCH === "true";', 'GENERAL_COMMITTED_STRICT'],
  ['M08_GENERAL_DROP_RUNTIME', generalBranch, 'if (mode === "general") return config.enable_dispatch === true;', 'GENERAL_RUNTIME_REQUIRED'],
  ['M09_GENERAL_TRUTHY_RUNTIME', generalBranch, 'if (mode === "general") return config.enable_dispatch === true && !!env.ENABLE_DISPATCH;', 'GENERAL_RUNTIME_FALSE'],
  ['M10_GENERAL_CASE_FOLD_RUNTIME', generalBranch, 'if (mode === "general") return config.enable_dispatch === true && (env.ENABLE_DISPATCH ?? "false").toLowerCase() === "true";', 'GENERAL_RUNTIME_EXACT_CASE'],
  ['M11_DELETE_GENERAL_BRANCH', generalBranch, '', 'GENERAL_COMMITTED_REQUIRED'],
  ['M12_GENERAL_APPLIES_TO_BOUNDED', 'if (mode === "general")', 'if (true)', 'BOUNDED_SINGLE_UNCHANGED'],
  ['M13_GENERAL_BYPASS_PAIR', 'if (config.dispatch_scope?.issue_ids?.length === 2 || activation?.kind === "two-fixture-v1")', 'if (mode !== "general" && (config.dispatch_scope?.issue_ids?.length === 2 || activation?.kind === "two-fixture-v1"))', 'PAIR_COMMITTED_TRUE_REFUSED'],
];
for (const [name, from, to, killer] of mutations) {
  test(`${name} killed by ${killer}; positive survives`, () => {
    assert.equal(gateSource.split(from).length - 1, 1, `${name}_ANCHOR_UNIQUE`);
    const mutant = new Function(`${gateSource.replace('export ', '').replace(from, to)}; return dispatchEnabledFor;`)();
    positive(mutant);
    assert.throws(() => checks[killer](mutant), error => error.code === 'ERR_ASSERTION' && error.message.includes(killer), `${name}_NAMED_KILL`);
  });
}

test('COMMITTED_SCOPE_OFF_AND_PAIR_UNCHANGED', () => {
  const committed = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.equal(committed.enable_dispatch, false);
  assert.equal(committed.dispatch_scope_mode, 'bounded');
  assert.deepEqual(committed.dispatch_scope, { issue_ids: ['SHU-140', 'SHU-254'] });
  assert.equal(dispatchEnabledFor(on, committed), false);
  assert.equal(dispatchEnabledFor(on, committed, pairArmed), true);
  assert.equal(dispatchEnabledFor(on, { ...committed, enable_dispatch: true }, pairArmed), false);
});
