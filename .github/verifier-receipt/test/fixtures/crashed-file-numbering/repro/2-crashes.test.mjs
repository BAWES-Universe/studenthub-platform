// The file that dies before it reports anything, the way
// .github/coordinator/test/shu249-role-authority.test.mjs dies in the measurement sandbox: a `mkdir` at
// module scope whose parent directory the boundary does not grant. The process exits non-zero having
// written no TAP at all, so the parent reports the FILE, and the number it uses for that point is the
// file's own - its 1-based position in the sorted file list - and not the run's next number.
import { mkdirSync } from 'node:fs';

mkdirSync('/this-parent-directory-does-not-exist/scratch');

// Never reached. Named so that a reader can see the runner reports nothing from here.
const { test } = await import('node:test');
test('a test this file never gets to register', () => {});
