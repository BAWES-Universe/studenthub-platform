import test from 'node:test';
import assert from 'node:assert/strict';
import { changedNames } from './changed-names.mjs';

function all(source) { return `@@ -0,0 +1,${source.split('\n').length} @@\n${source.split('\n').map((line) => '+' + line).join('\n')}`; }
function names(source) { return changedNames(source, all(source)); }

test('extracts default, aliases, it and static template literals', () => {
  assert.deepEqual(names("import check, {test as verify, it} from 'node:test';\ncheck('one',()=>{}); verify.only(`two`,()=>{}); it('three',()=>{});"), ['one', 'two', 'three']);
});
test('comments and strings never create declarations', () => {
  assert.deepEqual(names("import test from 'node:test';\n// test('comment',()=>{});\nconst text = `test('string',()=>{});`;"), []);
});
test('unrelated globals and namespace imports are not inferred', () => {
  assert.deepEqual(names("import {test} from 'other'; import * as nt from 'node:test'; test('other',()=>{}); nt.test('namespace',()=>{});"), []);
});
test('only the name token on added lines counts, not removed names or body edits', () => {
  const source = "import test from 'node:test';\ntest('existing',()=>{\n  return 4;\n});\ntest('new',()=>{});";
  const patch = "@@ -3 +3 @@\n-  return 3;\n+  return 4;\n@@ -5 +5 @@\n-test('old',()=>{});\n+test('new',()=>{});";
  assert.deepEqual(changedNames(source, patch), ['new']);
});
test('skip and todo declarations and options are excluded conservatively', () => {
  assert.deepEqual(names("import test from 'node:test'; test.skip('s',()=>{}); test.todo('t'); test('o',{skip:false},()=>{}); test('p',{todo:true},()=>{}); test('yes',()=>{});"), ['yes']);
});
test('dynamic names are not guessed and duplicates are collapsed', () => {
  assert.deepEqual(names("import test from 'node:test'; test(name,()=>{}); test(`x${1}`,()=>{}); test('one',()=>{}); test('one',()=>{});"), ['one']);
});
test('shadowed parameters and local declarations disable that imported binding', () => {
  assert.deepEqual(names("import test, {it} from 'node:test'; function f(test) { test('fake',()=>{}); } test('real',()=>{}); it('it',()=>{});"), ['it']);
  assert.deepEqual(names("import test from 'node:test'; { const test = ()=>{}; test('fake',()=>{}); }"), []);
});
test('destructured shadowing is rejected', () => {
  assert.deepEqual(names("import test from 'node:test'; function f({test}) { test('fake',()=>{}); }"), []);
});
test('broken source and type-only imports are not inferred', () => {
  assert.deepEqual(names("import test from 'node:test'; test('bad',()=>{"), []);
  assert.deepEqual(names("import type {test} from 'node:test'; test('fake',()=>{});"), []);
});
test('multiple zero-context hunks count actual added lines and ignore patch headers', () => {
  const source = "import test from 'node:test';\ntest('one',()=>{});\ntest('unchanged',()=>{});\ntest('four',()=>{});";
  assert.deepEqual(changedNames(source, "--- a/file\n+++ b/file\n@@ -2 +2 @@\n-old\n+new\n@@ -4 +4 @@\n-old\n+new\n\\ No newline at end of file"), ['one', 'four']);
});
