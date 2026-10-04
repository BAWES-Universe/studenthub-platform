// Other lane metadata is not available locally. Lane examples below are synthetic,
// not claims about the exact titles/bodies of external PRs. The policy body is
// also synthetic; only the B19 title was supplied verbatim.
export const probes = [
  ['B19 own PR title', 'chore(policy): reject Linear auto-closing references and correct the historical record (SHU-251)', '', true],
  ['policy body example', '', 'Related: SHU-251. Reject auto-closing references and preserve the historical record. Live acceptance remains blocked.', true],
  ['lane title example', 'fix(coordinator): resolve the trusted parser path (SHU-251)', '', true],
  ['lane body example', '', 'Related: SHU-251 and SHU-253. Fixes parser selection. Completes local tests; acceptance remains blocked.', true],
  ['separate sentences', '', 'Fixes parser selection. Related: SHU-251', true],
  ['keyword substring', '', 'Encloses (SHU-251)', true],
  ['unrelated title verb', 'Fixes parser selection', 'Related: SHU-251', true],
  ['closing url', '', 'Closes https://linear.app/team/issue/SHU-253/acceptance', false],
  ['closing opaque url', '', 'Resolves https://linear.app/team/issue/opaque', false],
  ['markdown closing', '', '**Fixes** [SHU-253](https://linear.app/team/issue/SHU-253)', false],
  ['connector punctuation', '', 'Closes only: (the issue SHU-253)', false],
  ['list closing', '', 'Fixes: # SHU-253', false],
  ['completes only', '', 'Completes only SHU-253', false],
  ['closes only', '', 'Closes only SHU-253', false],
  ['title reference', 'Implement acceptance (SHU-253)', '', true],
  ['title completion', 'Completes only SHU-253', '', false],
  ['punctuation', '', 'Closes: (SHU-253).', false],
  ['line break', '', 'Completes only\n\nSHU-253', false],
  ['split reference', '', 'Closes SHU-\n253', false],
  ['case', '', 'rEsOlVeS shu-253', false],
  ['past tense', '', 'This has completed the work for SHU-253.', false],
  ['future tense', '', 'This will finish the acceptance work for SHU-253.', false],
  ['neutral reference', '', 'Related: SHU-253', true],
  ['negation', '', 'Does not close SHU-253', false],
  ['quoted example', '', '`Fixes SHU-253`', false],
  ['url', '', 'Related: https://linear.app/team/issue/SHU-253/acceptance', true],
  ['url without id', '', 'https://linear.app/team/issue/opaque', true],
  ['unicode dash', '', 'Completes SHU–253', false],
  ['unicode width', '', 'Closes ＳＨＵ－２５３', false],
  ['zero width', '', 'Closes SHU-\u200B253', false],
  ['other team', '', 'Closes ACCEPT-42', false],
  ['neutral repository link', '', 'Related work: [acceptance record](docs/acceptance-record.md)', true],
  ['completes without issue', '', 'Completes only the local parser tests.', true],
  ['closes without issue', '', 'Closes only the local file descriptor.', true],
  ['neutral title', 'Add repository acceptance policy', '', true],
  ['punctuation without issue', '', 'Fixes: parsing.\nResolves local test failures.', true],
  ['issue prose without identifier', '', 'Live acceptance remains pending owner proof.', true],
];

// Every supported closing-verb inflection is measured through the CLI too.
for (const verb of ['close', 'closes', 'closed', 'closing', 'fix', 'fixes', 'fixed', 'fixing', 'resolve', 'resolves', 'resolved', 'resolving', 'complete', 'completes', 'completed', 'completing', 'finish', 'finishes', 'finished', 'finishing']) {
  probes.push([`closing inflection ${verb}`, '', `${verb} SHU-253`, false]);
}
