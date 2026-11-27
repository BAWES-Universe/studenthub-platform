// Operator entry for the 0661 handover checks (store-handover.ts). Reads DATABASE_URL.
//   node dist/packages/private-documents/src/store-handover-cli.js precheck > handover-pre.json
//   node dist/packages/private-documents/src/store-handover-cli.js postcheck handover-pre.json
// Prints counts and a digest only; exit 0 passed, 2 refused (with the fixed code), 1 failed.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { HandoverError, postcheck, precheck, type HandoverPrecheck } from './store-handover.js';

export async function handoverMain(argv: readonly string[], env: NodeJS.ProcessEnv, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  const [mode, file] = argv;
  if ((mode !== 'precheck' && mode !== 'postcheck') || (mode === 'postcheck' && !file) || !env.DATABASE_URL) { err('handover: usage'); return 2; }
  let expected: HandoverPrecheck | undefined;
  if (mode === 'postcheck') {
    try { expected = JSON.parse(readFileSync(file!, 'utf8')) as HandoverPrecheck; } catch { err('handover: refused.precheckFile'); return 2; }
  }
  const client = new pg.Client({ connectionString: env.DATABASE_URL, application_name: 'document-store-handover' });
  try {
    await client.connect();
    const result = mode === 'precheck' ? await precheck(client) : await postcheck(client, expected!);
    out(JSON.stringify(result));
    return 0;
  } catch (error) {
    if (error instanceof HandoverError) { err(`handover: refused.${error.code}`); return 2; }
    err('handover: failed');
    return 1;
  } finally { await client.end().catch(() => {}); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await handoverMain(process.argv.slice(2), process.env, (s) => console.log(s), (s) => console.error(s));
}
