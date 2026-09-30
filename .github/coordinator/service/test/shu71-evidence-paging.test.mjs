// SHU-71 evidence paging: the two-fixture evidence reader follows every page of
// a fixture thread (SHU-140 passed 250 comments), refuses bad cursors and
// oversized threads, and its answer is not cut by the old 64 KiB output caps.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readTwoFixtureEvidence, EVIDENCE_MAX_PAGES, EVIDENCE_MAX_BYTES } from '../../two-fixture-evidence.mjs';

const config = { pilot_repo: 'BAWES-Universe/studenthub-platform' };
const env = { GITHUB_TOKEN: 'gh-test', LINEAR_API_TOKEN: 'lin-test' };
const HEAD = { 'SHU-140': 'a'.repeat(40), 'SHU-254': 'b'.repeat(40) };

// Serves both fixtures from a plan: comment counts, body size, and optional
// faults. Every Linear request is logged so the cursor sequence is observable.
function mockFetch(plan, logFile) {
  const source = `
import fs from 'node:fs';
const plan = ${JSON.stringify(plan)};
const logFile = ${JSON.stringify(logFile)};
const answer = value => ({ ok: true, json: async () => value });
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith('https://api.github.com/')) {
    const branch = decodeURIComponent(String(url).split('/git/ref/heads/')[1]);
    return answer({ object: { sha: plan.heads[branch.replace('coordinator/', '')] } });
  }
  const { query, variables: { id, after } } = JSON.parse(options.body);
  fs.appendFileSync(logFile, JSON.stringify({ id, after, query }) + '\\n');
  const fixture = plan.fixtures[id];
  const page = after === null ? 0 : Number(after.slice(1));
  const start = page * 250, end = Math.min(start + 250, fixture.count);
  const nodes = [];
  for (let i = start; i < end; i++) {
    nodes.push({ body: '#' + id + ':' + i + ':' + 'x'.repeat(fixture.bodySize), createdAt: new Date(Date.UTC(2026, 8, 1) + i * 1000).toISOString(), user: { id: 'actor' } });
  }
  const hasNextPage = end < fixture.count;
  let endCursor = 'c' + (page + 1);
  if (fixture.fault === 'repeat' && page === 1) endCursor = 'c1';
  if (fixture.fault === 'empty' && page === 1) endCursor = '';
  if (fixture.fault === 'missing' && page === 1) endCursor = undefined;
  const issueId = fixture.fault === 'identity' && page === 1 ? 'other-uuid' : 'uuid-' + id;
  return answer({ data: { issue: { id: issueId, identifier: id, comments: { nodes, pageInfo: { hasNextPage, endCursor } } } } });
};
`;
  return 'data:text/javascript,' + encodeURIComponent(source);
}

function readWith(t, fixtures) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-paging-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logFile = path.join(dir, 'requests.jsonl');
  fs.writeFileSync(logFile, '');
  const importUrl = mockFetch({ heads: HEAD, fixtures }, logFile);
  // The production child source and its real execFileSync options run
  // unchanged; only fetch is replaced inside the child.
  const run = (file, args, opts) => execFileSync(file, ['--import', importUrl, ...args], opts);
  const result = readTwoFixtureEvidence(config, env, run);
  const requests = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { result, requests };
}

const refused = { heads: {}, issues: [] };

test('SHU71_EVIDENCE_PAGING reads every page of a fixture thread past 250 comments', t => {
  const { result, requests } = readWith(t, { 'SHU-140': { count: 600, bodySize: 400 }, 'SHU-254': { count: 0, bodySize: 0 } });
  assert.deepEqual(result.heads, { 'coordinator/SHU-140': HEAD['SHU-140'], 'coordinator/SHU-254': HEAD['SHU-254'] });
  assert.deepEqual(result.issues.map(i => [i.id, i.linearId]).sort(), [['SHU-140', 'uuid-SHU-140'], ['SHU-254', 'uuid-SHU-254']]);
  const shu140 = result.comments.filter(c => c.body.startsWith('#SHU-140:'));
  assert.equal(shu140.length, 600, 'SHU71_EVIDENCE_ALL_PAGES');
  assert.deepEqual(shu140.map(c => Number(c.body.split(':')[1])), [...Array(600).keys()], 'SHU71_EVIDENCE_ORDER');
  assert.deepEqual(requests.filter(r => r.id === 'SHU-140').map(r => r.after), [null, 'c1', 'c2'], 'SHU71_EVIDENCE_CURSORS');
  assert.deepEqual(requests.filter(r => r.id === 'SHU-254').map(r => r.after), [null]);
  for (const { query } of requests) {
    assert.match(query, /comments\(first: 250, orderBy: createdAt, after: \$after\)/);
    assert.match(query, /pageInfo \{ hasNextPage endCursor \}/);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(result)) > 65536, 'answer is larger than the old 64 KiB cap');
});

test('SHU71_EVIDENCE_PAGE_BOUND accepts exactly the page bound and refuses one comment more', t => {
  const full = EVIDENCE_MAX_PAGES * 250;
  const atBound = readWith(t, { 'SHU-140': { count: full, bodySize: 0 }, 'SHU-254': { count: 1, bodySize: 0 } });
  assert.equal(atBound.result.comments.length, full + 1);
  const over = readWith(t, { 'SHU-140': { count: full + 1, bodySize: 0 }, 'SHU-254': { count: 1, bodySize: 0 } });
  assert.deepEqual(over.result, refused, 'SHU71_EVIDENCE_PAGE_BOUND');
  assert.equal(over.requests.filter(r => r.id === 'SHU-140').length, EVIDENCE_MAX_PAGES, 'no request past the bound');
});

test('SHU71_EVIDENCE_CURSOR refuses a repeated, empty or missing cursor instead of truncating', t => {
  for (const fault of ['repeat', 'empty', 'missing']) {
    const { result, requests } = readWith(t, { 'SHU-140': { count: 900, bodySize: 0, fault }, 'SHU-254': { count: 0, bodySize: 0 } });
    assert.deepEqual(result, refused, `SHU71_EVIDENCE_CURSOR: ${fault}`);
    assert.equal(requests.filter(r => r.id === 'SHU-140').length, 2, `stops at the bad cursor: ${fault}`);
  }
});

test('SHU71_EVIDENCE_IDENTITY refuses a thread whose issue changes between pages', t => {
  const { result } = readWith(t, { 'SHU-140': { count: 600, bodySize: 0, fault: 'identity' }, 'SHU-254': { count: 0, bodySize: 0 } });
  assert.deepEqual(result, refused, 'SHU71_EVIDENCE_IDENTITY');
});

test('SHU71_EVIDENCE_BROKER_SIZE the broker path carries answers past 64 KiB and still bounds them', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-client-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const socketPath = path.join(dir, 'fixture.sock');
  let payload = '';
  const server = net.createServer(socket => {
    socket.on('error', () => {});
    socket.once('data', () => socket.end(payload));
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(() => server.close());
  // Redirect only the fixed socket path; the client's own caps run unchanged.
  const redirect = 'data:text/javascript,' + encodeURIComponent(`import net from 'node:net';
const connect = net.createConnection; net.createConnection = () => connect(${JSON.stringify(socketPath)});`);
  const client = fileURLToPath(new URL('../fixture-evidence-client.mjs', import.meta.url));
  const runClient = () => new Promise(resolve => {
    const child = execFile(process.execPath, ['--import', redirect, client], { encoding: 'utf8', maxBuffer: EVIDENCE_MAX_BYTES * 2 },
      (error, stdout) => resolve({ code: error ? error.code ?? 1 : 0, stdout }));
    child.stdin.end('{"operation":"evidence"}');
  });

  payload = JSON.stringify({ heads: {}, issues: [], comments: [{ body: 'x'.repeat(1024 * 1024) }] }) + '\n';
  const large = await runClient();
  assert.equal(large.code, 0, 'SHU71_EVIDENCE_BROKER_SIZE');
  assert.equal(large.stdout, payload);

  payload = 'x'.repeat(EVIDENCE_MAX_BYTES + 1);
  const oversize = await runClient();
  assert.notEqual(oversize.code, 0, 'SHU71_EVIDENCE_BROKER_BOUND');
  assert.equal(oversize.stdout, '');

  // The reader side of the broker accepts the same bound.
  const seen = [];
  const answer = JSON.stringify({ heads: { fixed: 'a' }, issues: [], comments: [{ body: 'y'.repeat(200000) }] });
  const read = readTwoFixtureEvidence({}, { SHU71_EVIDENCE_BROKER: 'true' }, (file, args, opts) => { seen.push(opts.maxBuffer); return answer; });
  assert.equal(read.comments[0].body.length, 200000);
  assert.deepEqual(seen, [EVIDENCE_MAX_BYTES]);
});
