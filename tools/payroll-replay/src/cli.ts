import { readFile, stat, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compareCells, fromLegacyFixture } from './replay.js';
const LIMIT = 16 * 1024 * 1024;
async function readJson(path: string): Promise<unknown> {
  if (!(await stat(path)).isFile() || (await stat(path)).size > LIMIT) throw new Error('INVALID_FILE');
  const raw = await readFile(path);
  if (raw.byteLength > LIMIT) throw new Error('INVALID_FILE');
  return JSON.parse(raw.toString('utf8'));
}
export async function main(args: string[], output = console.log, error = console.error): Promise<number> {
  if (args.length !== 3 || args[0] !== '--synthetic-cells') {
    error('Usage: cli --synthetic-cells legacy-fixtures.json candidate-cells.json'); return 2;
  }
  try {
    const [fixture, candidate] = await Promise.all(args.slice(1).map(readJson));
    const receipt = compareCells(fromLegacyFixture(fixture), candidate);
    output(JSON.stringify(receipt));
    return receipt.status === 'PASS_SYNTHETIC_CELLS' ? 0 : 1;
  } catch { error('PAYROLL_REPLAY_INPUT_REJECTED'); return 2; }
}
export async function isEntrypoint(moduleUrl: string, arg: string | undefined): Promise<boolean> {
  if (!arg) return false;
  try { return await realpath(fileURLToPath(moduleUrl)) === await realpath(arg); } catch { return false; }
}
if (await isEntrypoint(import.meta.url, process.argv[1])) process.exitCode = await main(process.argv.slice(2));
