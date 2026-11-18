import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createGatewayServer } from "../src/index.js";
import { blockList, type AbuseGatePorts } from "../src/access/abuse-gate.js";
import { PERSON_LIMITS, blockListOf, parseTrustedProxies, type AbuseStore, type IpBlockRow } from "../../../packages/access/src/index.js";

const ORIGIN = "https://studenthub.example.invalid";
const SESSIONS: Record<string, string> = { ["a".repeat(43)]: "admin-1", ["s".repeat(43)]: "staff-1", ["p".repeat(43)]: "person-1", ["q".repeat(43)]: "person-1" };
const cookieFor = (key: string) => ({ cookie: `__Host-studenthub_session=${key.repeat(43)}` });

function world(trusted = "127.0.0.0/8") {
  const counts = new Map<string, number>();
  let rows: IpBlockRow[] = [];
  const changes: string[] = [];
  const store: AbuseStore = {
    async hit(principalId, kind, start) { const key = `${principalId}|${kind}|${start}`; counts.set(key, (counts.get(key) ?? 0) + 1); return counts.get(key)!; },
    async blocks() { return rows; },
    async changeBlock(callerId, request, mayChange) {
      if (!mayChange(await reads.callerGrants(callerId))) return { kind: "refused", reason: "not_allowed" };
      const cidr = `${request.cidr.address}/${request.cidr.prefix}`;
      changes.push(`${request.action}:${cidr}:${callerId}`);
      if (request.action === "block") {
        if (rows.some((row) => row.cidr === cidr)) return { kind: "refused", reason: "already_blocked" };
        rows = [...rows, { id: cidr, cidr, reason: request.reason, createdAt: "2026-11-17T10:00:00.000Z", createdBy: { principalId: callerId, displayName: "Grace Admin" } }];
        return { kind: "blocked" };
      }
      if (!rows.some((row) => row.cidr === cidr)) return { kind: "refused", reason: "not_blocked" };
      rows = rows.filter((row) => row.cidr !== cidr);
      return { kind: "unblocked" };
    },
  };
  const grants: Record<string, { orgId: string; role: string; scope: string }[]> = {
    "admin-1": [{ orgId: "root", role: "admin", scope: "subtree" }], "staff-1": [{ orgId: "root", role: "staff", scope: "subtree" }],
  };
  let now = 1_800_000_000;
  const reads = { callerGrants: async (id: string) => grants[id] ?? [] };
  const ports: AbuseGatePorts = {
    sessions: { get: async (id) => (SESSIONS[id] ? { id, personId: SESSIONS[id]! } : undefined) },
    store, reads,
    trustedProxies: blockListOf(parseTrustedProxies(trusted)), operatorOrgIds: ["root"], nowEpochSeconds: () => now, blockListSeconds: 0,
  };
  return { ports, changes, counts, grants, block: (cidr: string) => { rows = [...rows, { id: cidr, cidr, reason: "test", createdAt: "2026-11-17T10:00:00.000Z", createdBy: { principalId: "admin-1", displayName: null } }]; }, tick: (seconds: number) => { now += seconds; } };
}

async function serve(t: TestContext, ports: AbuseGatePorts) {
  const server = createGatewayServer(undefined, undefined, undefined, { abuse: ports, web: { origin: ORIGIN } } as never);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  return (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    fetch(base + path, { redirect: "manual", ...init, headers: { accept: "text/html", ...init.headers } });
}

test("A8_BLOCKS a blocked address is refused with a page on every path but /health, read through the trusted proxy only", async (t) => {
  const w = world();
  w.block("203.0.113.0/24");
  const http = await serve(t, w.ports);
  for (const path of ["/", "/profile", "/admin/access", "/definitely-unknown"]) {
    const response = await http(path, { headers: { "x-forwarded-for": "203.0.113.9" } });
    assert.equal(response.status, 403, path);
    assert.match(await response.text(), /We can’t accept requests from your network\./);
  }
  const json = await http("/profile", { headers: { accept: "application/json", "x-forwarded-for": "203.0.113.9" } });
  assert.deepEqual([json.status, await json.json()], [403, { error: "blocked" }]);
  assert.equal((await http("/health", { headers: { "x-forwarded-for": "203.0.113.9" } })).status, 200);
  assert.equal((await http("/", { headers: { "x-forwarded-for": "203.0.114.9" } })).status, 200, "another address passes");
  assert.equal((await http("/", { headers: { "x-forwarded-for": "203.0.113.9, 198.51.100.1" } })).status, 200, "the rightmost untrusted hop decides");
  const untrusted = world("10.0.0.0/8");
  untrusted.block("203.0.113.0/24");
  const direct = await serve(t, untrusted.ports);
  assert.equal((await direct("/", { headers: { "x-forwarded-for": "203.0.113.9" } })).status, 200, "a header from an untrusted peer is ignored");
  untrusted.block("127.0.0.1/32");
  assert.equal((await direct("/")).status, 403, "the socket peer itself is checked");
});

test("A8_LIMITS a person past the write limit gets a 429 page with Retry-After, shared across their sessions", async (t) => {
  const w = world();
  const http = await serve(t, w.ports);
  const post = (key: string) => http("/definitely-unknown", { method: "POST", headers: { ...cookieFor(key), "content-type": "application/x-www-form-urlencoded" }, body: "a=1" });
  for (let index = 0; index < PERSON_LIMITS.write.max; index += 1) assert.equal((await post(index % 2 ? "p" : "q")).status, 404);
  const limited = await post("p");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "600");
  assert.match(await limited.text(), /Please slow down\./);
  assert.equal((await post("q")).status, 429, "the other session of the same person is limited too");
  assert.equal((await http("/definitely-unknown", { headers: cookieFor("q") })).status, 404, "reading still works");
  const signOut = await http("/logout", { method: "POST", headers: { ...cookieFor("p"), origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: "" });
  assert.notEqual(signOut.status, 429, "signing out is never limited");
  assert.equal((await post("s")).status, 404, "another person is not limited");
  const upload = await http("/definitely-unknown", { method: "POST", headers: { ...cookieFor("p"), accept: "application/json", "content-type": "multipart/form-data; boundary=x" }, body: "--x--" });
  assert.equal(upload.status, 404, "uploads have their own count, even while writes are limited");
  const pdf = await http("/definitely-unknown", { method: "POST", headers: { ...cookieFor("p"), accept: "application/json", "content-type": " Application/PDF; charset=binary" }, body: "%PDF" });
  assert.equal(pdf.status, 404, "a parameterized PDF counts as an upload, not a write");
  assert.equal(w.counts.get(`person-1|upload|${1_800_000_000 - (1_800_000_000 % PERSON_LIMITS.upload.windowSeconds)}`), 2);
  w.tick(600);
  assert.equal((await post("p")).status, 404, "the next window starts afresh");
});

test("A8_BLOCKS only an operator admin opens and changes the block list; their own address is refused", async (t) => {
  const w = world();
  const http = await serve(t, w.ports);
  const unknown = await (await http("/definitely-unknown", { headers: cookieFor("s") })).text();
  for (const key of [undefined, "s", "p"]) {
    const response = await http("/admin/ip-blocks", { headers: key ? cookieFor(key) : {} });
    assert.equal(response.status, 404);
    if (key === "s") assert.equal(await response.text(), unknown);
  }
  const form = (body: Record<string, string>, origin = ORIGIN) => http("/admin/ip-blocks", { method: "POST", body: new URLSearchParams(body).toString(),
    headers: { ...cookieFor("a"), origin, "content-type": "application/x-www-form-urlencoded" } });
  assert.match(await (await http("/admin/ip-blocks", { headers: cookieFor("a") })).text(), /No address is blocked\./);
  const blocked = await form({ action: "block", cidr: "198.51.100.0/24", reason: "Credential stuffing" });
  assert.equal(blocked.status, 303);
  assert.equal(blocked.headers.get("location"), "/admin/ip-blocks?done=blocked");
  const page = await (await http("/admin/ip-blocks?done=blocked", { headers: cookieFor("a") })).text();
  assert.match(page, /The address was blocked\./);
  assert.match(page, /198\.51\.100\.0\/24<\/th><td>Grace Admin<\/td><td>2026-11-17<\/td><td>Credential stuffing/);
  assert.equal((await form({ action: "block", cidr: "198.51.100.0/24", reason: "Again please" })).status, 409);
  assert.equal((await form({ action: "block", cidr: "198.51.100.7/24", reason: "Credential stuffing" })).status, 400);
  assert.equal((await form({ action: "block", cidr: "127.0.0.0/8", reason: "Oops on myself" })).status, 409, "own address");
  assert.equal((await form({ action: "block", cidr: "192.0.2.0/24", reason: "Cross site" }, "https://evil.invalid")).status, 400);
  assert.equal((await form({ action: "unblock", cidr: "198.51.100.0/24", reason: "Shared office" })).status, 303);
  assert.deepEqual(w.changes, ["block:198.51.100.0/24:admin-1", "block:198.51.100.0/24:admin-1", "unblock:198.51.100.0/24:admin-1"]);
});

test("A8_BLOCKS an admin right lost between the page check and the write changes nothing and reads as the unknown path", async (t) => {
  const w = world();
  const http = await serve(t, w.ports);
  const reads = w.ports.reads as { callerGrants: (id: string) => Promise<readonly { orgId: string; role: string; scope: string }[]> };
  const original = reads.callerGrants;
  let calls = 0;
  // The gateway's page check sees the admin grant; the store's in-transaction read sees it gone.
  reads.callerGrants = async (id) => (++calls > 1 ? [] : original(id));
  const response = await http("/admin/ip-blocks", { method: "POST", body: new URLSearchParams({ action: "block", cidr: "198.51.100.0/24", reason: "Credential stuffing" }).toString(),
    headers: { ...cookieFor("a"), origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(response.status, 404);
  assert.deepEqual(w.changes, [], "nothing was written");
});

test("A8_BLOCKS a block-list read superseded by a change never publishes the old list as fresh", async () => {
  const w = world();
  const ports: AbuseGatePorts = { ...w.ports, blockListSeconds: 60 };
  const pending: { resolve: (rows: readonly IpBlockRow[]) => void; reject: (error: Error) => void }[] = [];
  const real = ports.store.blocks.bind(ports.store);
  ports.store.blocks = () => new Promise((resolve, reject) => { pending.push({ resolve, reject }); });
  const now = 1_800_000_000;
  const before = blockList(ports, now); // a read of the list as it was before a change
  const after = blockList(ports, now, true); // the change starts a new generation
  pending[0]!.resolve([]); // the old read answers after the change
  assert.deepEqual((await before)?.rows, [], "the request that started it uses what it read");
  pending[1]!.reject(new Error("read failed")); // and the read after the change fails
  assert.equal(await after, undefined);
  w.block("203.0.113.0/24");
  ports.store.blocks = real;
  // The old list was never held, so a read after the retry pause sees the block.
  const held = await blockList(ports, now + 6);
  assert.equal(held?.rows.length, 1);
});

test("A8_BLOCKS a hung block-list read is bounded and released, so later requests don't wait on it", async (t) => {
  const w = world();
  w.ports.store.blocks = () => new Promise(() => {});
  const http = await serve(t, w.ports);
  let started = Date.now();
  assert.equal((await http("/")).status, 200, "the request goes on without a list");
  assert.ok(Date.now() - started < 3_000);
  started = Date.now();
  assert.equal((await http("/")).status, 200);
  assert.ok(Date.now() - started < 500, "a failed read is not retried at once");
});

test("A8_BLOCKS a form is read by its media type, whatever the parameters or case", async (t) => {
  const w = world();
  const http = await serve(t, w.ports);
  const response = await http("/admin/ip-blocks", { method: "POST", body: new URLSearchParams({ action: "block", cidr: "198.51.100.0/24", reason: "Credential stuffing" }).toString(),
    headers: { ...cookieFor("a"), origin: ORIGIN, "content-type": " Application/X-WWW-Form-Urlencoded ; charset=UTF-8" } });
  assert.equal(response.status, 303);
  assert.deepEqual(w.changes, ["block:198.51.100.0/24:admin-1"]);
});
