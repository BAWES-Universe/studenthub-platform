import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export const evidencePredicate = 'reservations.length === 32 && reservations.every((e, i) => e.attempts === i + 1)';
// Fixed regression witnesses supplied by R8; acceptance is the state table.
export const demonstratedMutants = [
  { id: 'W7', bypass: "journal.entries.some(e => e.event === 'SETTLEMENT_STARTED')", witness: { counter: 'exhausted', journal: 'intact', allowance: 'consumed' } },
  { id: 'W13', bypass: 'JSON.parse(privateRead(`${dir}/automatic-teardown.json`)).settlement_started', witness: { counter: 'settlement-started-set', journal: 'intact', allowance: 'unconsumed' } },
  { id: 'W1b', bypass: '(journal.recovered && reservations.length >= 1)', witness: { counter: 'exhausted', journal: 'recovered', allowance: 'unconsumed' } },
  { id: 'W15', bypass: "(journal.recovered && journal.entries.some(e => e.event === 'ARMED'))", witness: { counter: 'exhausted', journal: 'recovered', allowance: 'unconsumed' } },
];
export async function loadMutant(t, m) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-r8-mutant-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const url = new URL('../shu71-production.mjs', import.meta.url);
  let source = fs.readFileSync(url, 'utf8');
  if (source.split(evidencePredicate).length !== 2) throw Error('B4_R8_UNIQUE_MUTATION_SITE');
  source = source.replace(evidencePredicate, `(${m.bypass}) || (${evidencePredicate})`)
    .replace(/(from\s+)(['"])(\.{1,2}\/[^'"]+)\2/g, (_, p, q, r) => `${p}${q}${new URL(r, url).href}${q}`);
  const file = path.join(root, 'production.mjs'); fs.writeFileSync(file, source);
  return (await import(pathToFileURL(file))).createShu71Production;
}
