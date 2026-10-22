// Self-repair B2, G1: the patch lines the weakening guard must refuse. They are
// diff text, not tests, and live outside *.test.mjs so the SHU251 source guard
// (service/test/host-suite-contract.test.mjs) never reads them as real skips.
export const ADDED_WEAKENING_LINES = Object.freeze([
  "test.skip('x', () => {})", "it.only('x', () => {})", "describe . skip ('x', () => {})", "test .todo ('x')", "t.skip()",
  "xit('x', () => {})", "xdescribe('x', () => {})", "xtest('x', () => {})", "fit('x', () => {})",
  "test('x', { skip: true }, () => {})", "test('x', { todo: true }, () => {})", "test('x', {skip}, () => {})", "test('x', { skip: 'later' })",
]);
