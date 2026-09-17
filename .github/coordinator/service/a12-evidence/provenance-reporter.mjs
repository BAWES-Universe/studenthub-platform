import fs from 'node:fs';
import reporter from '../host-suite-contract.mjs';
export default async function* provenance(source) {
  async function* observed() {
    for await (const event of source) {
      if (['test:pass', 'test:fail'].includes(event.type) && event.data.details?.type !== 'suite') {
        fs.appendFileSync('/tmp/a12-provenance.jsonl', JSON.stringify({ name: event.data.name, file: event.data.file, line: event.data.line }) + '\n');
      }
      yield event;
    }
  }
  yield* reporter(observed());
}
