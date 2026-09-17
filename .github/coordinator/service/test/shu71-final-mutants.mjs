// Fixed independent-verifier witnesses; acceptance lives in exhausted-invariants.
export const finalMutants = [
  { id: 'N1', bypass: "journal.entries.some(e => e.event === 'HALTED')", variant: 0 },
  { id: 'N2', bypass: 'b.now() - Date.parse(spec.pkg.expires_at) > 86400000', variant: 3 },
  { id: 'N3', bypass: 'JSON.parse(privateRead(`${dir}/automatic-teardown.json`)).settled === true', variant: 2 },
  { id: 'N6', bypass: "journal.entries.some(e => e.event === 'FIXTURE_REMOVE_INTENT')", variant: 1 },
];
