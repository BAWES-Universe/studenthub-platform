import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../src/documents-upload-http.js', import.meta.url), 'utf8');
for (const [name, needle] of Object.entries({ Q14_1_LIMIT:'SHU521_BODY_BOUND', Q14_1_OWNER:'request.headers.origin !== service.options.origin', Q14_1_ONE_PATH:'SHU521_FINALIZE', Q14_1_REFUSALS:'finalized.status !== 200' })) {
  assert.equal(source.split(needle).length, 2, `${name} mutation binding`);
}
