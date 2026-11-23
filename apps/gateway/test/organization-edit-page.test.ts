import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { InMemoryAuthzStore } from "@studenthub/contracts";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import { InMemoryApprovedProfileAdapter, OwnProfileRepository } from "@studenthub/profile";
import {
  InMemoryApprovedOrganizationAdapter, OrganizationRepository, SYNTHETIC_ORGANIZATION_FIXTURES, ORGANIZATION_PROFILE_FIELDS,
  organizationProfilePrincipalRef, organizationProfileRecordRef, type OrganizationProfileRecord,
} from "@studenthub/organizations";
import type { CommitInput, SafeWriteStore } from "@studenthub/safe-write-contract";
import { createGatewayServer, createLoginApplication } from "../src/index.js";
import { createContextNavigation, type ContextNavigation } from "../src/context-navigation.js";
import { createOrganizationProfile, type OrganizationProfile } from "../src/organization-profile.js";
import { renderError, type BrowserLoginApplication } from "../src/web-ui.js";

const ORIGIN = "https://studenthub.example.invalid";
const SECRET = "o03-edit-page-test-secret-is-at-least-thirty-two-bytes";
const CONFLICT = "The company changed while you were reviewing. Open it again and retry.";
const SESSIONS = {
  owner: "e".repeat(43), recruiter: "r".repeat(43), staff: "s".repeat(43), admin: "m".repeat(43), sibling: "b".repeat(43),
} as const;
type Who = keyof typeof SESSIONS | "none";
const PEOPLE: Record<keyof typeof SESSIONS, string> = { owner: "person-owner", recruiter: "person-recruiter", staff: "person-staff", admin: "person-admin", sibling: "person-sibling" };
const OWNS: Readonly<Record<string, string>> = { "person-owner": "org-a", "person-sibling": "org-b" };

interface Options { readonly noProfile?: boolean; readonly throwing?: "preview" | "confirm" }

async function fixture(t: TestContext, options: Options = {}) {
  const rig = createSyntheticLoginRig(createLoginApplication);
  for (const [who, id] of Object.entries(SESSIONS)) await rig.sessions.put({ id, personId: PEOPLE[who as keyof typeof SESSIONS] });
  const store = new InMemoryAuthzStore({
    principals: Object.values(PEOPLE).map((id) => ({ id, pbuuids: [`${id}@example.invalid`] })),
    organizations: [{ id: "root", name: "Root" }, { id: "org-a", name: "Registry A", parentOrgId: "root" },
      { id: "org-a1", name: "Registry Child", parentOrgId: "org-a" }, { id: "org-a2", name: "Registry Unimported", parentOrgId: "org-a" },
      { id: "org-b", name: "Registry B", parentOrgId: "root" }],
  });
  await store.grantMany(PEOPLE.owner, [{ orgId: "org-a", role: "org-owner", scope: "subtree" }]);
  await store.grantMany(PEOPLE.recruiter, [{ orgId: "org-a", role: "recruiter" }]);
  await store.grantMany(PEOPLE.staff, [{ orgId: "root", role: "staff", scope: "subtree" }]);
  await store.grantMany(PEOPLE.admin, [{ orgId: "root", role: "admin", scope: "subtree" }]);
  await store.grantMany(PEOPLE.sibling, [{ orgId: "org-b", role: "org-owner" }]);

  // The saved profile values: the safe-write store writes them, the read model reads them.
  const values = new Map<string, Record<string, string>>();
  const spent = new Set<string>();
  const commits: CommitInput[] = [];
  const orgOfRecord = (ref: string) => ["org-a", "org-a1", "org-a2", "org-b"].find((orgId) => organizationProfileRecordRef(orgId) === ref);
  const read = (ref: string, field: string) => values.get(orgOfRecord(ref) ?? "")?.[field] ?? null;
  const writes = {
    forPrincipal(principalId: string, orgId: string): SafeWriteStore {
      return {
        ownedRecord: (principalRef) => principalRef === organizationProfilePrincipalRef(principalId) && OWNS[principalId] === orgId
          ? organizationProfileRecordRef(orgId) : null,
        readField: (ref, field) => read(ref, field),
        commit: (input) => {
          if (spent.has(input.tokenId)) return { ok: false, reason: "token_already_used" };
          if (read(input.personRef, input.field) !== input.expectedBefore) return { ok: false, reason: "state_changed" };
          const orgId = orgOfRecord(input.personRef)!;
          values.set(orgId, { ...values.get(orgId), [input.field]: input.value });
          spent.add(input.tokenId); commits.push(input);
          return { ok: true };
        },
      };
    },
    readReceipt: async () => null,
  };
  let now = new Date("2026-11-23T10:00:00.000Z");
  const service = createOrganizationProfile({ sessions: rig.sessions, store: writes, secret: SECRET, clock: { now: () => now } });
  const previews: unknown[] = []; const confirms: unknown[] = [];
  const organizationProfile: OrganizationProfile = {
    async preview(session, body) { previews.push(body); if (options.throwing === "preview") throw new Error("private preview detail"); return service.preview(session, body); },
    async confirm(session, body) { confirms.push(body); if (options.throwing === "confirm") throw new Error("private confirm detail"); return service.confirm(session, body); },
    receipt: (session, orgId, ref) => service.receipt(session, orgId, ref),
  };

  const { parentA, childA1, unrelatedB } = SYNTHETIC_ORGANIZATION_FIXTURES;
  const organizations = new OrganizationRepository({ store, source: new InMemoryApprovedOrganizationAdapter(new Map<string, unknown>([
    ["org-a", parentA], ["org-a1", childA1], ["org-b", unrelatedB],
  ])), profiles: { read: async (orgId) => ({ ...values.get(orgId) }) as OrganizationProfileRecord } });
  const actual = createContextNavigation(rig.sessions, store, organizations);
  const calls: string[] = [];
  const navigation: ContextNavigation = { open(session, selection) { calls.push(String(selection)); return actual.open(session, selection); } };
  const login: BrowserLoginApplication & { organizationProfile?: OrganizationProfile } = {
    ...rig.app, navigation, ...(options.noProfile ? {} : { organizationProfile }),
    web: { origin: ORIGIN, returnTo: rig.config.allowedReturnUrls[1],
      profiles: new OwnProfileRepository({ principals: store, source: new InMemoryApprovedProfileAdapter({ links: [], rows: new Map() }), today: () => "2026-11-23" }) },
  };
  const server = createGatewayServer(undefined, undefined, undefined, login);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const cookie = (who: Who): Record<string, string> => who === "none" ? {} : { cookie: `__Host-studenthub_session=${SESSIONS[who]}` };
  const get = (path: string, who: Who = "owner") => fetch(`${base}${path}`, { headers: { accept: "text/html", ...cookie(who) }, redirect: "manual" });
  const post = (path: string, body: string | URLSearchParams, who: Who = "owner", headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", redirect: "manual", body: String(body),
      // An empty override leaves the header out, so "missing" really is missing.
      headers: Object.fromEntries(Object.entries({ accept: "text/html", origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", ...cookie(who), ...headers })
        .filter(([, value]) => value !== "")) });
  const confirmForm = (html: string) => {
    const form = new URLSearchParams();
    for (const [, name, value] of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
      form.append(name!, value!.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
    }
    return form;
  };
  return { get, post, confirmForm, values, commits, previews, confirms, calls, login,
    advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

const PREVIEW = "/organization/org-a/edit/preview", CONFIRM = "/organization/org-a/edit/confirm";
const change = (field: string, value: string) => new URLSearchParams({ field, value });

test("EDIT_FORM the owner sees one prefilled form per editable field", async (t) => {
  const f = await fixture(t);
  const response = await f.get("/organization/org-a/edit"); const body = await response.text();
  assert.equal(response.status, 200, "EDIT_FORM owner page is 200");
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/); assert.equal(response.headers.get("cache-control"), "no-store");
  const forms = [...body.matchAll(/<form method="post" action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)];
  assert.equal(forms.length, ORGANIZATION_PROFILE_FIELDS.length, "EDIT_FORM one form per field");
  const expected: Record<string, [string, string]> = {
    name_en: ["Synthetic Retail", "255"], name_ar: ["التجزئة التجريبية", "255"], description_en: ["A synthetic parent organization.", "2000"],
    description_ar: ["شركة تجريبية.", "2000"], website: ["synthetic-retail.example.invalid", "2000"],
  };
  ORGANIZATION_PROFILE_FIELDS.forEach((field, index) => {
    const [, action, inner] = forms[index]!;
    assert.equal(action, PREVIEW, `EDIT_FORM ${field} posts to preview`);
    assert.match(inner!, new RegExp(`<input type="hidden" name="field" value="${field}">`), `EDIT_FORM ${field} posts its field`);
    const [value, max] = expected[field]!;
    if (field.startsWith("description")) assert.match(inner!, new RegExp(`<textarea[^>]* name="value" maxlength="${max}"[^>]*>${value.replace(".", "\\.")}</textarea>`), `EDIT_FORM ${field} prefilled`);
    else assert.match(inner!, new RegExp(`<input[^>]* name="value"[^>]* maxlength="${max}" value="${value.replace(".", "\\.")}"`), `EDIT_FORM ${field} prefilled`);
  });
  assert.match(body, /<dt>Company name<\/dt><dd class="read-only">Synthetic Retail Group<\/dd>/, "EDIT_FORM legal name is read-only");
  assert.doesNotMatch(body, /value="legal|name="legal/i, "EDIT_FORM legal name has no form");
  const empty = await (await f.get("/organization/org-a2/edit")).text();
  assert.equal([...empty.matchAll(/<input[^>]* name="value"[^>]* value=""/g)].length, 3, "EDIT_FORM unavailable values are empty");
  assert.equal([...empty.matchAll(/<textarea[^>]*><\/textarea>/g)].length, 2, "EDIT_FORM unavailable descriptions are empty");
  for (const query of ["?saved=legal_name", "?saved=name_en&saved=website", "?x=1", "?saved=name_en&x=1"]) {
    assert.equal((await f.get(`/organization/org-a/edit${query}`)).status, 400, `EDIT_FORM ${query} is 400`);
  }
});

test("EDIT_OWNER only the org-owner context reaches the page and its posts", async (t) => {
  const f = await fixture(t);
  const bodies: string[] = [];
  const refusals: [string, Who, string][] = [
    ["recruiter of org-a", "recruiter", "org-a"], ["staff of org-a", "staff", "org-a"], ["admin of org-a", "admin", "org-a"],
    ["sibling owner", "sibling", "org-a"], ["unknown organization", "owner", "missing"], ["malformed orgId", "owner", "%20"],
  ];
  for (const [name, who, org] of refusals) {
    const page = await f.get(`/organization/${org}/edit`, who);
    assert.equal(page.status, 404, `EDIT_OWNER ${name} is hidden`); bodies.push(await page.text());
    const preview = await f.post(`/organization/${org}/edit/preview`, change("name_en", "Taken"), who);
    assert.equal(preview.status, 404, `EDIT_OWNER ${name} preview is hidden`); bodies.push(await preview.text());
    const confirm = await f.post(`/organization/${org}/edit/confirm`, "orgId=org-a", who);
    assert.equal(confirm.status, 404, `EDIT_OWNER ${name} confirm is hidden`); bodies.push(await confirm.text());
  }
  assert.ok(bodies.every((body) => body === bodies[0]), "EDIT_OWNER refusal bodies are byte-identical");
  assert.deepEqual([f.previews.length, f.confirms.length, f.commits.length], [0, 0, 0], "EDIT_OWNER refusals store nothing");
  for (const response of [await f.get("/organization/org-a/edit", "none"), await f.post(PREVIEW, change("name_en", "X"), "none"), await f.post(CONFIRM, "orgId=org-a", "none")]) {
    assert.equal(response.status, 401, "EDIT_OWNER no session is 401");
    assert.equal(await response.text(), renderError(401, f.login), "EDIT_OWNER no session is renderError(401)");
  }
  f.calls.length = 0;
  assert.equal((await f.get("/organization/org-a/edit")).status, 200);
  const preview = await f.post(PREVIEW, change("name_en", "Owner Name")); assert.equal(preview.status, 200);
  assert.equal((await f.post(CONFIRM, f.confirmForm(await preview.text()))).status, 303);
  assert.deepEqual(f.calls, Array(3).fill("org_id=org-a&role=org-owner"), "EDIT_OWNER every request opens the org-owner context");
});

test("EDIT_PREVIEW a change is previewed with escaped values and a token-carrying confirm form", async (t) => {
  const f = await fixture(t);
  const response = await f.post(PREVIEW, change("name_en", "<b>New & Co</b>")); const body = await response.text();
  assert.equal(response.status, 200, "EDIT_PREVIEW valid change is 200");
  assert.doesNotMatch(body, /<b>New & Co<\/b>/, "EDIT_PREVIEW new value is escaped");
  assert.match(body, /<dd class="new-value">&lt;b&gt;New &amp; Co&lt;\/b&gt;<\/dd>/, "EDIT_PREVIEW shows the new value");
  assert.match(body, /<dd class="field-label">Common name<\/dd>/, "EDIT_PREVIEW shows the field label");
  assert.match(body, /<dd class="current-value">Synthetic Retail<\/dd>/, "EDIT_PREVIEW shows the current value");
  assert.deepEqual(f.previews, [{ orgId: "org-a", field: "name_en", value: "<b>New & Co</b>" }], "EDIT_PREVIEW calls preview once");
  const form = f.confirmForm(body);
  assert.deepEqual([...form.keys()].sort(), ["field", "orgId", "token.changeSetDigest", "token.expectedBeforeDigest", "token.expiresAt",
    "token.issuedAt", "token.mac", "token.principalRef", "token.tokenId", "value"], "EDIT_PREVIEW hidden inputs");
  assert.deepEqual([form.get("orgId"), form.get("field"), form.get("value")], ["org-a", "name_en", "<b>New & Co</b>"]);
  assert.match(body, /<form method="post" action="\/organization\/org-a\/edit\/confirm">[\s\S]*<button[^>]*>Save change<\/button><\/form>/, "EDIT_PREVIEW Save change posts to confirm");
  assert.match(body, /<a class="text-link" href="\/organization\/org-a\/edit">Cancel<\/a>/, "EDIT_PREVIEW Cancel goes back");
  f.previews.length = 0;
  const bad: [string, string][] = [
    ["unknown field", "field=legal_name&value=X"], ["missing value", "field=name_en"], ["missing field", "value=X"],
    ["repeated key", "field=name_en&value=X&value=Y"], ["extra key", "field=name_en&value=X&orgId=org-a"],
    ["oversized body", `field=description_en&value=${"a".repeat(32_800)}`],
  ];
  for (const [name, form] of bad) {
    const refused = await f.post(PREVIEW, form); assert.equal(refused.status, 400, `EDIT_PREVIEW ${name} is 400`);
    assert.match(await refused.text(), /class="error-page"/, `EDIT_PREVIEW ${name} is a plain page`);
  }
  assert.equal(f.previews.length, 0, "EDIT_PREVIEW malformed forms never reach the service");
  const long = await f.post(PREVIEW, change("name_en", "n".repeat(256)));
  assert.equal(long.status, 400, "EDIT_PREVIEW a 256-character name is 400 invalid_value");
  const arabic = "ب".repeat(2000);
  const ok = await f.post(PREVIEW, change("description_ar", arabic)); assert.equal(ok.status, 200, "EDIT_PREVIEW 2000 Arabic characters preview");
  const saved = await f.post(CONFIRM, f.confirmForm(await ok.text())); assert.equal(saved.status, 303, "EDIT_PREVIEW 2000 Arabic characters confirm");
  assert.equal(f.values.get("org-a")?.description_ar, arabic);
  assert.ok((await (await f.get("/organization/org-a/edit")).text()).includes(`>${arabic}</textarea>`), "EDIT_PREVIEW the Arabic value reads back unchanged");
  const over = await f.post(PREVIEW, change("description_ar", "ب".repeat(2001))); assert.equal(over.status, 400, "EDIT_PREVIEW 2001 Arabic characters is 400");
  assert.equal(f.commits.length, 1, "EDIT_PREVIEW refused previews store nothing");
});

test("EDIT_CONFIRM a confirmed change is saved once and conflicts are 409", async (t) => {
  const f = await fixture(t);
  const preview = await f.post(PREVIEW, change("name_en", "Renamed Retail")); const form = f.confirmForm(await preview.text());
  const done = await f.post(CONFIRM, form);
  assert.equal(done.status, 303, "EDIT_CONFIRM confirm redirects");
  assert.equal(done.headers.get("location"), "/organization/org-a/edit?saved=name_en", "EDIT_CONFIRM redirects to the saved notice");
  assert.equal(f.confirms.length, 1, "EDIT_CONFIRM confirm calls the service once");
  assert.equal(f.commits.length, 1, "EDIT_CONFIRM confirm stores the value");
  assert.equal(f.values.get("org-a")?.name_en, "Renamed Retail");
  const page = await (await f.get("/organization/org-a/edit?saved=name_en")).text();
  assert.match(page, /<strong>Saved\.<\/strong>/, "EDIT_CONFIRM shows Saved."); assert.match(page, /class="saved-value">Renamed Retail</);
  const overview = await (await f.get("/organization/org-a")).text();
  assert.match(overview, /<dt>Common name<\/dt><dd>Renamed Retail<\/dd>/, "EDIT_CONFIRM the overview reads the new name");

  const stale = f.confirmForm(await (await f.post(PREVIEW, change("website", "https://new.example.invalid"))).text());
  f.values.set("org-a", { ...f.values.get("org-a"), website: "https://someone-else.example.invalid" });
  const conflict = await f.post(CONFIRM, stale);
  assert.equal(conflict.status, 409, "EDIT_CONFIRM state_changed is 409");
  assert.match(await conflict.text(), new RegExp(CONFLICT.replace(/\./g, "\\.")), "EDIT_CONFIRM state_changed shows the conflict page");
  assert.equal(f.values.get("org-a")?.website, "https://someone-else.example.invalid");

  const replay = await f.post(CONFIRM, form); assert.equal(replay.status, 409, "EDIT_CONFIRM a replay is refused");
  assert.equal(f.commits.length, 1, "EDIT_CONFIRM a replay stores nothing twice");

  const fresh = f.confirmForm(await (await f.post(PREVIEW, change("description_en", "Fresh text"))).text());
  const tampered = new URLSearchParams(fresh); tampered.set("token.mac", "A".repeat(fresh.get("token.mac")!.length));
  const forged = await f.post(CONFIRM, tampered); assert.equal(forged.status, 409, "EDIT_CONFIRM a tampered token is 409");
  assert.match(await forged.text(), new RegExp(CONFLICT.replace(/\./g, "\\.")));
  f.advance(24 * 60 * 60 * 1000);
  const expired = await f.post(CONFIRM, fresh); assert.equal(expired.status, 409, "EDIT_CONFIRM an expired token is 409");
  assert.match(await expired.text(), new RegExp(CONFLICT.replace(/\./g, "\\.")));
  assert.equal(f.commits.length, 1, "EDIT_CONFIRM conflicts store nothing"); assert.equal(f.values.get("org-a")?.description_en, undefined);
});

test("EDIT_ORIGIN both posts refuse a missing or foreign origin before reading the body", async (t) => {
  const f = await fixture(t);
  for (const path of [PREVIEW, CONFIRM]) {
    const noOrigin = await f.post(path, change("name_en", "X"), "owner", { origin: "" });
    assert.equal(noOrigin.status, 403, "EDIT_ORIGIN a missing Origin is 403");
    assert.equal((await f.post(path, change("name_en", "X"), "owner", { origin: "https://evil.example.invalid" })).status, 403, "EDIT_ORIGIN a foreign Origin is 403");
    assert.equal((await f.post(path, change("name_en", "X"), "owner", { "sec-fetch-site": "cross-site" })).status, 403, "EDIT_ORIGIN cross-site is 403");
  }
  assert.equal(f.calls.length, 0, "EDIT_ORIGIN origin refusals open nothing");
  for (const path of [PREVIEW, CONFIRM]) {
    assert.equal((await f.post(path, "{}", "owner", { "content-type": "application/json" })).status, 400, "EDIT_ORIGIN a non-form content type is 400");
  }
  assert.deepEqual([f.previews.length, f.confirms.length, f.commits.length], [0, 0, 0], "EDIT_ORIGIN refusals store nothing");
});

test("EDIT_UNAVAILABLE an unconfigured or failing service is a disabled form or a plain 503", async (t) => {
  const off = await fixture(t, { noProfile: true });
  const page = await off.get("/organization/org-a/edit"); const body = await page.text();
  assert.equal(page.status, 200); assert.match(body, /Editing is unavailable right now\./, "EDIT_UNAVAILABLE says editing is unavailable");
  assert.equal([...body.matchAll(/<button[^>]* disabled>/g)].length, ORGANIZATION_PROFILE_FIELDS.length, "EDIT_UNAVAILABLE the forms are disabled");
  for (const path of [PREVIEW, CONFIRM]) {
    const response = await off.post(path, change("name_en", "X"));
    assert.equal(response.status, 503, `EDIT_UNAVAILABLE ${path} is 503`); assert.match(await response.text(), /class="error-page"/);
  }
  const previewThrows = await fixture(t, { throwing: "preview" });
  const thrown = await previewThrows.post(PREVIEW, change("name_en", "X")); const thrownBody = await thrown.text();
  assert.equal(thrown.status, 503, "EDIT_UNAVAILABLE a throwing preview is 503"); assert.doesNotMatch(thrownBody, /private preview detail|Error:|\n\s+at /);
  const confirmThrows = await fixture(t, { throwing: "confirm" });
  const form = confirmThrows.confirmForm(await (await confirmThrows.post(PREVIEW, change("name_en", "X"))).text());
  const failed = await confirmThrows.post(CONFIRM, form); const failedBody = await failed.text();
  assert.equal(failed.status, 503, "EDIT_UNAVAILABLE a throwing confirm is 503"); assert.doesNotMatch(failedBody, /private confirm detail|Error:|\n\s+at /);
  assert.equal(confirmThrows.commits.length, 0);
});
