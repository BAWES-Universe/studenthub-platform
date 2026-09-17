import { finalMutants } from './shu71-final-mutants.mjs';
import { exhaustedVariants, realJournalVariants, clockSweep } from './shu71-exhausted-invariants.mjs';
const journal = (event, state = 'intact') => realJournalVariants.find(v => v.label === `${event} real payload ${state}`);
const counter = fields => ({ axis: 'EXTRA_COUNTER_FIELDS', label: JSON.stringify(fields), transform(h, dir) {
  const file = `${dir}/automatic-teardown.json`; h.write(file, JSON.stringify({ ...JSON.parse(h.read(file)), ...fields }));
} });
const read = 'JSON.parse(privateRead(`${dir}/automatic-teardown.json`))';
export const deltaMutants = [
  ...finalMutants.map(m => ({ ...m, plant: exhaustedVariants[m.variant] })),
  { id: 'A1', bypass: "journal.entries.some(e => e.event === 'HALTED' && typeof e.code === 'string')", plant: journal('HALTED') },
  { id: 'A2', bypass: "journal.entries.some(e => e.event === 'FIXTURE_REMOVE_INTENT' && e.attempt_id !== undefined)", plant: journal('FIXTURE_REMOVE_INTENT') },
  { id: 'A5', bypass: "journal.entries.some(e => e.event === 'REVOKE_REQUESTED')", plant: journal('REVOKE_REQUESTED') },
  { id: 'A6', bypass: "journal.recovered && journal.entries.some(e => e.event === 'HALTED')", plant: journal('HALTED', 'recovered') },
  { id: 'B1', bypass: `${read}.note === 'operator-touched'`, plant: counter({ note: 'operator-touched' }) },
  { id: 'B2', bypass: `${read}.frozen === true`, plant: counter({ frozen: true }) },
  { id: 'B3', bypass: `${read}.provenance?.writer === 'ops'`, plant: counter({ provenance: { writer: 'ops' } }) },
  { id: 'B4', bypass: `typeof ${read}.settlement_started === 'string'`, plant: counter({ settlement_started: 'yes' }) },
  { id: 'C1', bypass: 'b.now() - Date.parse(spec.pkg.expires_at) > 86400000 && b.now() - Date.parse(spec.pkg.expires_at) < 30 * 86400000', plant: clockSweep[1] },
  { id: 'C2', bypass: 'b.now() - Date.parse(spec.pkg.expires_at) > 400 * 86400000', plant: clockSweep.at(-1) },
  { id: 'X1', bypass: "JSON.parse(privateRead(dir + '/automatic-teardown.json')).note === 'operator-touched'", plant: counter({ note: 'operator-touched' }) },
  { id: 'X3', bypass: "(({frozen}) => frozen === true)(JSON.parse(privateRead(dir + '/automatic-teardown.json')))", plant: counter({ frozen: true }) },
  { id: 'X5', bypass: `privateRead(dir + '/automatic-teardown.json').includes('"note"')`, plant: counter({ note: 'operator-touched' }) },
  { id: 'X6', bypass: 'privateRead(`${dir}/automatic-teardown.json`).includes(\'"note"\')', plant: counter({ note: 'operator-touched' }) },
  { id: 'X7', bypass: '((s) => JSON.parse(s).frozen === true)(privateRead(`${dir}/automatic-teardown.json`))', plant: counter({ frozen: true }) },
];
export const deltaKiller = m => (m.id.startsWith('B') || m.id.startsWith('X')) ? 'SHU71_CONTROL_PROPERTY_EXHAUSTED_COUNTER_CANONICAL_READ_ATTEMPTS_ONLY'
  : m.id.startsWith('C') || m.id === 'N2' ? 'SHU71_CONTROL_PROPERTY_EXHAUSTED_NO_CLOCK'
  : m.id === 'N3' ? 'SHU71_CONTROL_PROPERTY_EXHAUSTED_COUNTER_CANONICAL_READ_ATTEMPTS_ONLY'
  : 'B4_EXHAUSTED_IRRELEVANT_NON_RESERVATION_ROWS';
