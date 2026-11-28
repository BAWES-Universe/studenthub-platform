import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { createGatewayServer } from "../src/index.js";
import { createPlatformIntegrations, DISPOSITION_LABELS, ROTATION_LABELS } from "../src/platform/integrations-page.js";
import { INTEGRATION_REGISTER } from "../src/platform/integration-register.js";

// Synthetic sessions and grants only; the register is the committed one.
const SESSIONS: Record<string, { grants: { orgId: string; role: string }[] }> = {
  ["a".repeat(43)]: { grants: [{ orgId: "root", role: "admin" }] },
  ["s".repeat(43)]: { grants: [{ orgId: "root", role: "staff" }] },
  ["o".repeat(43)]: { grants: [{ orgId: "org-a", role: "admin" }] },
  ["n".repeat(43)]: { grants: [] },
};
const ADMIN = "a".repeat(43);

async function rig(t: TestContext) {
  const reads = { grants: 0 };
  const integrations = createPlatformIntegrations({
    sessions: { get: async (id: string) => SESSIONS[id] ? { id, personId: `person-${id[0]}` } as never : undefined },
    authz: { listGrantsForPrincipal: async (personId: string) => { reads.grants++; const s = SESSIONS[personId.slice(7).repeat(43)]; return (s?.grants ?? []).map((g, i) => ({ id: `g${i}`, principalId: personId, scope: "subtree", ...g })) as never; } },
  });
  const server = createGatewayServer(undefined, undefined, undefined, { platformIntegrations: integrations } as never);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, session?: string, accept = "text/html", method = "GET") =>
    fetch(base + path, { method, headers: { accept, ...(session ? { cookie: `__Host-studenthub_session=${session}` } : {}) }, redirect: "manual" });
  return { call, reads };
}

function deployRegister(): { integrations: { id: string; name: string; rotation_state: string; disposition: string; notes: string; credential_names: string[] }[] } {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "deploy/coolify/integration-register.json"))) {
    const up = dirname(dir);
    assert.notEqual(up, dir, "the repository's integration register is reachable");
    dir = up;
  }
  return JSON.parse(readFileSync(join(dir, "deploy/coolify/integration-register.json"), "utf8"));
}

test("INTEGRATIONS_REGISTER the page's register matches the deploy register, without owners or credential names", () => {
  const source = deployRegister().integrations;
  assert.deepEqual(INTEGRATION_REGISTER.map(i => [i.id, i.name, i.rotationState, i.disposition, i.notes]),
    source.map(i => [i.id, i.name, i.rotation_state, i.disposition, i.notes]), "INTEGRATIONS_REGISTER drift from deploy/coolify/integration-register.json");
  for (const entry of INTEGRATION_REGISTER) assert.deepEqual(Object.keys(entry).sort(), ["disposition", "id", "name", "notes", "rotationState"]);
  assert.ok(Object.isFrozen(INTEGRATION_REGISTER) && INTEGRATION_REGISTER.every(Object.isFrozen));
});

test("INTEGRATIONS_PAGE an operator admin sees every integration, its plan and credential state, and never a credential", async (t) => {
  const { call } = await rig(t);
  const r = await call("/platform/integrations", ADMIN);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.match(r.headers.get("content-type") ?? "", /^text\/html/);
  const html = await r.text();
  assert.equal((html.match(/<h1>/g) ?? []).length, 1); assert.match(html, /<h1>Integrations<\/h1>/);
  const pending = INTEGRATION_REGISTER.filter(i => i.disposition === "pending").length;
  assert.ok(pending > 1);
  assert.match(html, new RegExp(`role="status">${pending} integrations are waiting for a decision\\. Until it is made, the integration is not connected and its old service is not retired\\.`));
  for (const [label, key] of [["Keep", "keep"], ["Replace", "replace"], ["Drop", "drop"], ["Waiting for a decision", "pending"]] as const) {
    assert.match(html, new RegExp(`<dt>${label}</dt><dd>${INTEGRATION_REGISTER.filter(i => i.disposition === key).length}</dd>`));
  }
  for (const i of INTEGRATION_REGISTER) {
    const plan = i.disposition === "pending" ? `<strong>${DISPOSITION_LABELS.pending}</strong>` : DISPOSITION_LABELS[i.disposition];
    assert.ok(html.includes(`<tr><th scope="row">${i.name}</th><td>${plan}</td><td>${ROTATION_LABELS[i.rotationState]}</td><td>${i.notes}</td></tr>`), i.id);
  }
  assert.match(html, /Credentials are never shown here\./);
  for (const name of deployRegister().integrations.flatMap(i => i.credential_names)) assert.equal(html.includes(name), false, `credential name ${name}`);
  assert.doesNotMatch(html, /SHU-\d/, "no owner card keys");
  assert.doesNotMatch(html, /<form|<input|<button/, "read-only");
  assert.match(html, /href="\/platform\/operations"/);
});

test("INTEGRATIONS_JSON an API caller gets the same register as JSON", async (t) => {
  const { call } = await rig(t);
  const r = await call("/platform/integrations", ADMIN, "application/json");
  assert.equal(r.status, 200); assert.equal(r.headers.get("cache-control"), "no-store");
  const body = await r.json();
  assert.equal(body.status, "ok");
  assert.deepEqual(body.integrations, JSON.parse(JSON.stringify(INTEGRATION_REGISTER)));
  assert.equal(Object.values(body.counts as Record<string, number>).reduce((a, b) => a + b, 0), INTEGRATION_REGISTER.length);
  const head = await call("/platform/integrations", ADMIN, "application/json", "HEAD");
  assert.equal(head.status, 200); assert.equal(await head.text(), "");
});

test("INTEGRATIONS_HIDDEN anyone but an operator admin gets the unknown-path answer", async (t) => {
  const { call } = await rig(t);
  for (const accept of ["text/html", "application/json"]) {
    const missing = await call("/no/such/page", undefined, accept), expected = { status: missing.status, type: missing.headers.get("content-type"), body: await missing.text() };
    for (const [who, session] of [["signed out", undefined], ["unknown session", "x".repeat(43)], ["no grant", "n".repeat(43)], ["root staff", "s".repeat(43)], ["admin at a company", "o".repeat(43)]] as const) {
      const r = await call("/platform/integrations", session, accept);
      assert.deepEqual({ status: r.status, type: r.headers.get("content-type"), body: await r.text() }, expected, `INTEGRATIONS_HIDDEN ${who} ${accept}`);
    }
    for (const method of ["POST", "PUT", "DELETE"]) {
      const r = await call("/platform/integrations", ADMIN, accept, method), m = await call("/no/such/page", ADMIN, accept, method);
      assert.deepEqual([r.status, await r.text()], [m.status, await m.text()], `INTEGRATIONS_HIDDEN ${method} ${accept}`);
    }
  }
  assert.equal((await call("/platform/integrations/x", ADMIN)).status, 404, "a deeper path is the wildcard");
});

test("INTEGRATIONS_COUNTS one waiting integration reads in the singular, none hides the warning", async () => {
  const one = createPlatformIntegrations({ sessions: { get: async (id: string) => ({ id, personId: "p" }) as never },
    authz: { listGrantsForPrincipal: async () => [{ id: "g", principalId: "p", orgId: "root", role: "admin", scope: "subtree" }] as never },
    register: [INTEGRATION_REGISTER.find(i => i.disposition === "pending")!, INTEGRATION_REGISTER.find(i => i.disposition === "keep")!] });
  const view = await one.open(ADMIN);
  assert.deepEqual(view?.counts, { keep: 1, replace: 0, drop: 0, pending: 1 });
});
