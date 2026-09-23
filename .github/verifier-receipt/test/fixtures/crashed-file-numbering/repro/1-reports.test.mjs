// The file that behaves. Its three points are renumbered into the run's global sequence on their way
// through the parent, which is why they read 1, 2, 3 here and would read 1, 2, 3 whatever this file's
// position in the sorted file list happened to be.
import { test } from 'node:test';

test('the first point this run reports', () => {});
test('the second point this run reports', () => {});
test('the third point this run reports', () => {});
