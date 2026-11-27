// Operator entry for the 0661 handover checks (store-handover.ts). Reads DATABASE_URL and, for the checks,
// HANDOVER_APPROVED_TARGET: the fingerprint `target` printed for the approved database.
//   node dist/packages/private-documents/src/store-handover-cli.js target
//   HANDOVER_APPROVED_TARGET=<fingerprint> node .../store-handover-cli.js precheck > handover-pre.json
//   HANDOVER_APPROVED_TARGET=<fingerprint> node .../store-handover-cli.js postcheck handover-pre.json
// Prints a fingerprint, counts and a digest only; exit 0 passed, 2 refused (with the fixed code), 1 failed.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { HandoverError, parsePrecheck, postcheck, precheck, target, type HandoverPrecheck } from './store-handover.js';

const HEX = /^[0-9a-f]{32}$/;

export async function handoverMain(argv: readonly string[], env: NodeJS.ProcessEnv, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  const [mode, file] = argv;
  if ((mode !== 'target' && mode !== 'precheck' && mode !== 'postcheck') || (mode === 'postcheck' ? argv.length !== 2 : argv.length !== 1) || !env.DATABASE_URL) { err('handover: usage'); return 2; }
  const approved = env.HANDOVER_APPROVED_TARGET;
  if (mode !== 'target' && (!approved || !HEX.test(approved))) { err('handover: refused.approvedTarget'); return 2; }
  let expected: HandoverPrecheck | undefined;
  if (mode === 'postcheck') {
    try { expected = parsePrecheck(JSON.parse(readFileSync(file!, 'utf8'))); } catch { err('handover: refused.precheckFile'); return 2; }
    if (expected.target !== approved) { err('handover: refused.otherTarget'); return 2; }
  }
  const client = new pg.Client({ connectionString: env.DATABASE_URL, application_name: 'document-store-handover' });
  try {
    await client.connect();
    if (mode === 'target') { out(JSON.stringify({ target: await target(client) })); return 0; }
    const result = mode === 'precheck' ? await precheck(client) : await postcheck(client, expected!);
    if (result.target !== approved) { err('handover: refused.otherTarget'); return 2; }
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
