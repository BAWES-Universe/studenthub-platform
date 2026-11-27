import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { InMemoryAuthzStore } from "@studenthub/contracts";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import { InMemoryApprovedProfileAdapter, OwnProfileRepository } from "@studenthub/profile";
import {
  InMemoryApprovedOrganizationAdapter, OrganizationRepository, SYNTHETIC_ORGANIZATION_FIXTURES, type OrganizationStatusEventRow,
} from "@studenthub/organizations";
import { createGatewayServer, createLoginApplication } from "../src/index.js";
import { createContextNavigation, type ContextNavigation } from "../src/context-navigation.js";
import { createCompanyDirectory } from "../src/company-directory.js";
import { renderError, type BrowserLoginApplication } from "../src/web-ui.js";

const ORIGIN = "https://studenthub.example.invalid";
const CONFLICT = "The company changed while you were reviewing. Open it again and retry.";
const SESSIONS = {
  owner: "e".repeat(43), recruiter: "r".repeat(43), staff: "s".repeat(43), admin: "m".repeat(43), sibling: "b".repeat(43),
} as const;
type Who = keyof typeof SESSIONS | "none";
const PEOPLE: Record<keyof typeof SESSIONS, string> = { owner: "person-owner", recruiter: "person-recruiter", staff: "person-staff", admin: "person-admin", sibling: "person-sibling" };
const OPERATORS: Readonly<Record<string, "staff" | "admin">> = { "person-staff": "staff", "person-admin": "admin" };
type Service = "organizationStatus" | "organizationApprovedToHire" | "organizationCommercialTerms" | "organizationDeletion";
const SERVICE_FIELDS: Readonly<Record<Service, readonly string[]>> = {
  organizationStatus: ["status"], organizationApprovedToHire: ["approved_to_hire"],
  organizationCommercialTerms: ["hourly_rate", "bonus_commission", "currency_code"], organizationDeletion: ["deletion"],
};
const VALID: Readonly<Record<string, RegExp>> = {
  status: /^(active|under_review|inactive|none)$/, approved_to_hire: /^(true|false)$/,
  hourly_rate: /^(none|[0-9]{1,10}(\.[0-9]{1,6})?)$/, bonus_commission: /^(none|[0-9]{1,10}(\.[0-9]{1,6})?)$/,
  currency_code: /^(none|[A-Za-z]{3})$/, deletion: /^deleted$/,
};
const TOKEN_KEYS = ["changeSetDigest", "expectedBeforeDigest", "expiresAt", "issuedAt", "mac", "principalRef", "tokenId"];

interface Options { readonly missing?: readonly Service[]; readonly throwing?: "preview" | "confirm"; readonly blockers?: readonly string[] }

async function fixture(t: TestContext, options: Options = {}) {
  const rig = createSyntheticLoginRig(createLoginApplication);
  for (const [who, id] of Object.entries(SESSIONS)) await rig.sessions.put({ id, personId: PEOPLE[who as keyof typeof SESSIONS] });
  const store = new InMemoryAuthzStore({
    principals: Object.values(PEOPLE).map((id) => ({ id, pbuuids: [`${id}@example.invalid`] })),
    organizations: [{ id: "root", name: "Root" }, { id: "org-a", name: "Registry A", parentOrgId: "root" },
      { id: "org-a1", name: "Registry Child", parentOrgId: "org-a" }, { id: "org-b", name: "Registry B", parentOrgId: "root" }],
  });
  await store.grantMany(PEOPLE.owner, [{ orgId: "org-a", role: "org-owner", scope: "subtree" }]);
  await store.grantMany(PEOPLE.recruiter, [{ orgId: "org-a", role: "recruiter" }]);
  await store.grantMany(PEOPLE.staff, [{ orgId: "root", role: "staff", scope: "subtree" }]);
  await store.grantMany(PEOPLE.admin, [{ orgId: "root", role: "admin", scope: "subtree" }]);
  await store.grantMany(PEOPLE.sibling, [{ orgId: "org-b", role: "org-owner" }]);

  // A stand-in for each company safe write with the same contract: staff and admin may
  // change status and approved to hire, only admin may change terms or delete, and a
  // token is spent once and only while the value it was issued for is unchanged.
  const values = new Map<string, unknown>();
  const issued = new Map<string, { field: string; value: string; before: unknown; orgId: string }>();
  const spent = new Set<string>();
  const commits: { service: Service; orgId: string; field: string; value: string }[] = [];
  const calls: { service: Service; kind: "preview" | "confirm"; body: unknown }[] = [];
  let next = 0;
  const relay = (name: Service) => ({
    async preview(session: string | undefined, body: unknown) {
      calls.push({ service: name, kind: "preview", body });
      if (options.throwing === "preview") throw new Error("private preview detail");
      const person = session ? (await rig.sessions.get(session))?.personId : undefined;
      if (!person) return { status: 401 as const, body: { error: "unauthorized" } };
      const { orgId, field, value } = body as { orgId: string; field: string; value: string };
      if (!SERVICE_FIELDS[name].includes(field) || !VALID[field]!.test(value)) return { status: 400 as const, body: { error: "invalid_request" } };
      const role = OPERATORS[person];
      if (!role || orgId === "root" || (role === "staff" && (name === "organizationCommercialTerms" || name === "organizationDeletion"))) return { status: 404 as const, body: { error: "not_own_record" } };
      if (name === "organizationDeletion" && options.blockers?.length) return { status: 409 as const, body: { error: "deletion_blocked", blockers: options.blockers } };
      const tokenId = `token-${++next}`;
      const before = values.get(`${orgId}:${field}`) ?? null;
      issued.set(tokenId, { field, value, before, orgId });
      return { status: 200 as const, body: { changes: [{ field, before, after: value }], token: Object.fromEntries(TOKEN_KEYS.map((key) => [key, key === "tokenId" ? tokenId : `${key}<&"'>`])) } };
    },
    async confirm(session: string | undefined, body: unknown) {
      calls.push({ service: name, kind: "confirm", body });
      if (options.throwing === "confirm") throw new Error("private confirm detail");
      const person = session ? (await rig.sessions.get(session))?.personId : undefined;
      if (!person) return { status: 401 as const, body: { error: "unauthorized" } };
      const { orgId, field, value, token } = body as { orgId: string; field: string; value: string; token: Record<string, string> };
      const ticket = issued.get(token.tokenId!);
      if (!ticket || ticket.orgId !== orgId || ticket.field !== field || ticket.value !== value
        || token.mac !== 'mac<&"\'>') return { status: 409 as const, body: { error: "token_not_issued" } };
      if (spent.has(token.tokenId!)) return { status: 409 as const, body: { error: "token_already_used" } };
      if ((values.get(`${orgId}:${field}`) ?? null) !== ticket.before) return { status: 409 as const, body: { error: "state_changed" } };
      spent.add(token.tokenId!); values.set(`${orgId}:${field}`, value); commits.push({ service: name, orgId, field, value });
      return { status: 200 as const, body: { receipt: { ref: token.tokenId } } };
    },
    receipt: async () => ({ status: 404 as const, body: { error: "receipt_not_found" } }),
    history: async () => ({ status: 404 as const, body: { error: "not_found" } }),
  });

  const { parentA, childA1, unrelatedB } = SYNTHETIC_ORGANIZATION_FIXTURES;
  const organizations = new OrganizationRepository({ store, source: new InMemoryApprovedOrganizationAdapter(new Map<string, unknown>([
    ["org-a", parentA], ["org-a1", childA1], ["org-b", unrelatedB],
  ])) });
  const history: OrganizationStatusEventRow[] = [{ from_status: null, to_status: "under_review", occurred_at: "2026-11-20T08:00:00.000Z" }];
  const actual = createContextNavigation(rig.sessions, store, organizations, undefined, { history: async () => history });
  const opens: string[] = [];
  const navigation: ContextNavigation = { open(session, selection) { opens.push(String(selection)); return actual.open(session, selection); } };
  const services = Object.fromEntries((Object.keys(SERVICE_FIELDS) as Service[])
    .filter((name) => !options.missing?.includes(name)).map((name) => [name, relay(name)]));
  const login = {
    ...rig.app, navigation, ...services, companies: createCompanyDirectory(rig.sessions, store, organizations),
    web: { origin: ORIGIN, returnTo: rig.config.allowedReturnUrls[1],
      profiles: new OwnProfileRepository({ principals: store, source: new InMemoryApprovedProfileAdapter({ links: [], rows: new Map() }), today: () => "2026-11-27" }) },
  } as unknown as BrowserLoginApplication;
  const server = createGatewayServer(undefined, undefined, undefined, login);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const cookie = (who: Who): Record<string, string> => who === "none" ? {} : { cookie: `__Host-studenthub_session=${SESSIONS[who]}` };
  const get = (path: string, who: Who = "admin") => fetch(`${base}${path}`, { headers: { accept: "text/html", ...cookie(who) }, redirect: "manual" });
  const post = (path: string, body: string | URLSearchParams, who: Who = "admin", headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", redirect: "manual", body: String(body),
      headers: Object.fromEntries(Object.entries({ accept: "text/html", origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", ...cookie(who), ...headers })
        .filter(([, value]) => value !== "")) });
  const confirmForm = (html: string) => {
    const form = new URLSearchParams();
    for (const [, name, value] of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
      form.append(name!, value!.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
    }
    return form;
  };
  return { get, post, confirmForm, values, commits, calls, opens, login, history };
}

const PAGE = "/workspace/companies/org-a/admin", PREVIEW = `${PAGE}/preview`, CONFIRM = `${PAGE}/confirm`;
const change = (field: string, value: string) => new URLSearchParams({ field, value });
const forms = (html: string) => [...html.matchAll(/<form method="post" action="([^"]+)" data-field="([^"]+)">([\s\S]*?)<\/form>/g)];

test("ADMIN_PAGE admin sees every company control with today's values; staff sees status and hiring only", async (t) => {
  const f = await fixture(t);
  const response = await f.get(PAGE); const body = await response.text();
  assert.equal(response.status, 200, "ADMIN_PAGE admin page is 200");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(body, /<h1>Company admin<\/h1><p class="field-meta">Synthetic Retail Group<\/p>/, "ADMIN_PAGE names the company");
  const admin = forms(body);
  assert.deepEqual(admin.map(([, , field]) => field), ["status", "approved_to_hire", "hourly_rate", "bonus_commission", "currency_code", "deletion"], "ADMIN_PAGE admin forms");
  assert.ok(admin.every(([, action]) => action === PREVIEW), "ADMIN_PAGE every form posts to preview");
  const inner = Object.fromEntries(admin.map(([, , field, html]) => [field!, html!]));
  assert.match(inner.status!, /<option value="none" selected>Not set<\/option>/, "ADMIN_PAGE no override selects Not set");
  assert.match(inner.approved_to_hire!, /<option value="true" selected>Yes<\/option>/, "ADMIN_PAGE approved to hire prefilled");
  assert.match(inner.hourly_rate!, /name="value" type="text" maxlength="17" value="1\.500"/, "ADMIN_PAGE hourly rate prefilled");
  assert.match(inner.bonus_commission!, /value="20\.00"/, "ADMIN_PAGE bonus prefilled");
  assert.match(inner.currency_code!, /maxlength="3" value="KWD"/, "ADMIN_PAGE currency prefilled");
  assert.match(inner.deletion!, /<input type="hidden" name="value" value="deleted">/, "ADMIN_PAGE deletion posts the one allowed value");
  assert.doesNotMatch(body, /disabled/, "ADMIN_PAGE nothing disabled when every service is wired");
  assert.match(body, /<h2 id="status-history-title">Status history<\/h2><ol><li>Not set → Under review <time datetime="2026-11-20T08:00:00.000Z">2026-11-20<\/time><\/li><\/ol>/, "ADMIN_PAGE status history");
  assert.match(body, /href="\/workspace\?org_id=org-a&amp;role=admin">Account manager and company details<\/a>/, "ADMIN_PAGE links the workspace panel");

  const staff = await (await f.get(PAGE, "staff")).text();
  assert.deepEqual(forms(staff).map(([, , field]) => field), ["status", "approved_to_hire"], "ADMIN_PAGE staff forms");
  assert.doesNotMatch(staff, /Hourly|Bonus|deletion/i, "ADMIN_PAGE staff sees no terms or deletion");
  assert.match(staff, /role=staff/, "ADMIN_PAGE staff workspace link keeps the staff role");
  assert.deepEqual(f.calls, [], "ADMIN_PAGE reading the page calls no write service");

  const workspace = await (await f.get("/workspace?org_id=org-a&role=admin")).text();
  assert.match(workspace, /<a class="text-link" href="\/workspace\/companies\/org-a\/admin">Company admin<\/a>/, "ADMIN_PAGE the workspace links the page");
  const owner = await (await f.get("/workspace?org_id=org-a&role=org-owner", "owner")).text();
  assert.doesNotMatch(owner, /Company admin/, "ADMIN_PAGE an owner's workspace has no link");

  const staffWorkspace = await (await f.get("/workspace?org_id=org-a&role=staff", "staff")).text();
  assert.match(staffWorkspace, /href="\/workspace\/companies\/org-a\/admin">Company admin<\/a>/, "ADMIN_PAGE the staff workspace links the page");

  // A forged success link never produces a notice: the page takes no query at all.
  for (const query of ["?saved=status", "?saved=hourly_rate", "?saved=deletion", "?saved=status&saved=hourly_rate", "?x=1"]) {
    for (const who of ["admin", "staff"] as const) {
      const forged = await f.get(`${PAGE}${query}`, who);
      assert.equal(forged.status, 400, `ADMIN_PAGE ${who} ${query} is 400`);
      assert.doesNotMatch(await forged.text(), /Saved/, `ADMIN_PAGE ${who} ${query} shows no saved notice`);
    }
  }
});

test("ADMIN_NAVIGATION the workspace leads to the page: companies list, company panel, Company admin", async (t) => {
  const f = await fixture(t);
  for (const role of ["admin", "staff"] as const) {
    const home = await (await f.get(`/workspace?org_id=root&role=${role}`, role)).text();
    const list = /href="(\/workspace\/companies\?[^"]+)">Companies<\/a>/.exec(home)?.[1]?.replace(/&amp;/g, "&");
    assert.ok(list, `ADMIN_NAVIGATION ${role} workspace links the companies list`);
    const directory = await (await f.get(list, role)).text();
    const row = /<th scope="row"><a href="([^"]+)">Synthetic Retail Group<\/a>/.exec(directory)?.[1]?.replace(/&amp;/g, "&");
    assert.equal(row, `/workspace?org_id=org-a&role=${role}`, `ADMIN_NAVIGATION ${role} list links the company`);
    const panel = await (await f.get(row!, role)).text();
    const admin = /<a class="text-link" href="([^"]+)">Company admin<\/a>/.exec(panel)?.[1];
    assert.equal(admin, PAGE, `ADMIN_NAVIGATION ${role} company panel links the page`);
    assert.equal((await f.get(admin!, role)).status, 200, `ADMIN_NAVIGATION ${role} reaches the page`);
  }
});

test("ADMIN_STAFF_LIMIT staff posting an admin-only field directly is refused before any service call", async (t) => {
  const f = await fixture(t);
  const unknown = await (await f.get("/workspace/companies/org-a/no-such-page", "staff")).text();
  const adminReview = await (await f.post(PREVIEW, change("hourly_rate", "9"))).text();
  const callsBefore = f.calls.length;
  for (const [field, value] of [["hourly_rate", "9"], ["bonus_commission", "1"], ["currency_code", "USD"], ["deletion", "deleted"]] as const) {
    const preview = await f.post(PREVIEW, change(field, value), "staff");
    assert.equal(preview.status, 404, `ADMIN_STAFF_LIMIT staff preview ${field} is 404`);
    assert.equal(await preview.text(), unknown, `ADMIN_STAFF_LIMIT staff preview ${field} is the unknown-path page`);
    const form = f.confirmForm(adminReview); form.set("field", field); form.set("value", value);
    const confirm = await f.post(CONFIRM, form, "staff");
    assert.equal(confirm.status, 404, `ADMIN_STAFF_LIMIT staff confirm ${field} is 404`);
    assert.equal(await confirm.text(), unknown, `ADMIN_STAFF_LIMIT staff confirm ${field} is the unknown-path page`);
  }
  const replay = await f.post(CONFIRM, f.confirmForm(adminReview), "staff");
  assert.equal(replay.status, 404, "ADMIN_STAFF_LIMIT staff replaying an admin's reviewed form is 404");
  assert.equal(f.calls.length, callsBefore, "ADMIN_STAFF_LIMIT no service saw a staff admin-only post");
  assert.equal(f.commits.length, 0, "ADMIN_STAFF_LIMIT nothing saved");
});

test("ADMIN_ACCESS only staff and admin reach the page and its posts; everyone else gets the unknown-path 404", async (t) => {
  const f = await fixture(t);
  const unknown = await f.get("/workspace/companies/org-a/no-such-page", "owner");
  const bodies: string[] = [];
  const refusals: [string, Who, string][] = [
    ["owner of org-a", "owner", "org-a"], ["recruiter of org-a", "recruiter", "org-a"], ["sibling owner", "sibling", "org-a"],
    ["unknown organization", "admin", "missing"], ["operator organization", "admin", "root"], ["malformed orgId", "admin", "%20"],
  ];
  for (const [name, who, org] of refusals) {
    const page = await f.get(`/workspace/companies/${org}/admin`, who);
    assert.equal(page.status, 404, `ADMIN_ACCESS ${name} is hidden`); bodies.push(await page.text());
    const preview = await f.post(`/workspace/companies/${org}/admin/preview`, change("status", "active"), who);
    assert.equal(preview.status, 404, `ADMIN_ACCESS ${name} preview is hidden`); bodies.push(await preview.text());
    const confirm = await f.post(`/workspace/companies/${org}/admin/confirm`, "orgId=org-a", who);
    assert.equal(confirm.status, 404, `ADMIN_ACCESS ${name} confirm is hidden`); bodies.push(await confirm.text());
  }
  assert.equal(unknown.status, 404);
  const unknownBody = await unknown.text();
  assert.ok(bodies.every((body) => body === unknownBody), "ADMIN_ACCESS refusals match the unknown-path 404");
  assert.deepEqual(f.calls, [], "ADMIN_ACCESS refusals reach no write service");
  for (const response of [await f.get(PAGE, "none"), await f.post(PREVIEW, change("status", "active"), "none"), await f.post(CONFIRM, "orgId=org-a", "none")]) {
    assert.equal(response.status, 401, "ADMIN_ACCESS no session is 401");
    assert.equal(await response.text(), renderError(401, f.login), "ADMIN_ACCESS no session is renderError(401)");
  }
  assert.ok(f.opens.every((selection) => /^org_id=[^&]+&role=(admin|staff)$/.test(selection)), "ADMIN_ACCESS opens only operator contexts");
});

test("ADMIN_FLOW preview names the current and new value, confirm saves once and returns to the page", async (t) => {
  const f = await fixture(t);
  const preview = await f.post(PREVIEW, change("status", "inactive"));
  const review = await preview.text();
  assert.equal(preview.status, 200, "ADMIN_FLOW preview is 200");
  assert.match(review, /<dd class="field-label">Status set by staff<\/dd>/);
  assert.match(review, /<dd class="current-value">Not set<\/dd>/, "ADMIN_FLOW current value in words");
  assert.match(review, /<dd class="new-value">Inactive<\/dd>/, "ADMIN_FLOW new value in words");
  assert.match(review, /<p>Nothing changes until you confirm\.<\/p>/);
  assert.match(review, /name="token\.mac" value="mac&lt;&amp;&quot;&#39;&gt;"/, "ADMIN_FLOW token values are escaped");
  assert.deepEqual(f.calls[0], { service: "organizationStatus", kind: "preview", body: { orgId: "org-a", field: "status", value: "inactive" } }, "ADMIN_FLOW preview relays exactly");
  const form = f.confirmForm(review);
  const saved = await f.post(CONFIRM, form);
  assert.equal(saved.status, 303, "ADMIN_FLOW confirm redirects");
  assert.equal(saved.headers.get("location"), PAGE, "ADMIN_FLOW confirm returns to the page with no query");
  assert.deepEqual(f.commits, [{ service: "organizationStatus", orgId: "org-a", field: "status", value: "inactive" }], "ADMIN_FLOW one commit");
  const replay = await f.post(CONFIRM, form);
  assert.equal(replay.status, 409, "ADMIN_FLOW a replay is a conflict");
  assert.match(await replay.text(), new RegExp(CONFLICT), "ADMIN_FLOW conflict wording");
  assert.equal(f.commits.length, 1, "ADMIN_FLOW the replay saved nothing");

  assert.doesNotMatch(await (await f.get(PAGE)).text(), /Saved/, "ADMIN_FLOW the page shows stored state, not a notice");

  const terms = await (await f.post(PREVIEW, change("bonus_commission", "25.5"))).text();
  assert.match(terms, /<dd class="new-value">25\.5%<\/dd>/, "ADMIN_FLOW bonus shown as a percentage");
  assert.equal((await f.post(CONFIRM, f.confirmForm(terms))).headers.get("location"), PAGE);
  const cleared = await (await f.post(PREVIEW, change("currency_code", ""))).text();
  assert.match(cleared, /<dd class="new-value">Not set<\/dd>/, "ADMIN_FLOW an empty box clears");
  assert.deepEqual(f.calls.at(-1)?.body, { orgId: "org-a", field: "currency_code", value: "none" }, "ADMIN_FLOW an empty box is sent as none");

  const staff = await f.post(PREVIEW, change("approved_to_hire", "false"), "staff");
  const staffReview = await staff.text();
  assert.equal(staff.status, 200, "ADMIN_FLOW staff can change approved to hire");
  assert.match(staffReview, /<dd class="new-value">No<\/dd>/);
  assert.equal((await f.post(CONFIRM, f.confirmForm(staffReview), "staff")).status, 303);
  assert.deepEqual(f.commits.at(-1), { service: "organizationApprovedToHire", orgId: "org-a", field: "approved_to_hire", value: "false" });
});

test("ADMIN_DELETE deletion shows its blockers, and a confirmed deletion leaves for the workspace", async (t) => {
  const blocked = await fixture(t, { blockers: ["live_stores", "member_grants"] });
  const refused = await blocked.post(PREVIEW, change("deletion", "deleted"));
  const text = await refused.text();
  assert.equal(refused.status, 409, "ADMIN_DELETE blocked deletion is 409");
  assert.match(text, /<h1>This company can’t be deleted yet<\/h1><p>Nothing was changed\.<\/p><ul class="deletion-blockers"><li>It still has stores\.<\/li><li>People still have access to it\.<\/li><\/ul>/, "ADMIN_DELETE blockers in words");
  const f = await fixture(t);
  const review = await (await f.post(PREVIEW, change("deletion", "deleted"))).text();
  assert.match(review, /<p class="deletion-warning">This deletes Synthetic Retail Group\. Nothing changes until you confirm\.<\/p>/);
  assert.match(review, /<dd class="current-value">Not deleted<\/dd>[\s\S]*<dd class="new-value">Deleted<\/dd>/);
  assert.match(review, /<button class="button primary" type="submit">Delete company<\/button>/);
  const done = await f.post(CONFIRM, f.confirmForm(review));
  assert.equal(done.status, 303);
  assert.equal(done.headers.get("location"), "/workspace", "ADMIN_DELETE returns to the workspace");
  const staff = await f.post(PREVIEW, change("deletion", "deleted"), "staff");
  assert.equal(staff.status, 404, "ADMIN_DELETE staff cannot delete");
  assert.match(await staff.text(), /We can’t find that page\./, "ADMIN_DELETE staff refusal is the unknown-path page");
});

test("ADMIN_GUARDS origin, form shape and missing services are refused before any write", async (t) => {
  const f = await fixture(t);
  for (const [name, headers] of [["other origin", { origin: "https://evil.example.invalid" }], ["no origin", { origin: "" }], ["cross-site", { "sec-fetch-site": "cross-site" }]] as const) {
    const response = await f.post(PREVIEW, change("status", "active"), "admin", headers);
    assert.equal(response.status, 403, `ADMIN_GUARDS ${name} is 403`);
  }
  assert.equal(f.opens.length, 0, "ADMIN_GUARDS origin is checked before the context is opened");
  assert.equal((await f.post(PREVIEW, change("status", "active"), "admin", { "content-type": "application/json" })).status, 400, "ADMIN_GUARDS json is 400");
  for (const body of ["field=status", "field=status&value=active&extra=1", "field=status&field=status&value=active", "field=legal_name&value=x"]) {
    assert.equal((await f.post(PREVIEW, body)).status, 400, `ADMIN_GUARDS ${body} is 400`);
  }
  assert.equal((await f.post(PREVIEW, `field=status&value=${"a".repeat(40_000)}`)).status, 400, "ADMIN_GUARDS oversized body is 400");
  const review = await (await f.post(PREVIEW, change("status", "active"))).text();
  const other = f.confirmForm(review); other.set("orgId", "org-b");
  assert.equal((await f.post(CONFIRM, other)).status, 400, "ADMIN_GUARDS confirm for another company is 400");
  const tampered = f.confirmForm(review); tampered.set("value", "inactive");
  assert.equal((await f.post(CONFIRM, tampered)).status, 409, "ADMIN_GUARDS a changed value is refused by the service");
  assert.equal(f.calls.filter((call) => call.kind === "preview").length, 1, "ADMIN_GUARDS only the well-formed preview reached a service");
  assert.equal(f.commits.length, 0, "ADMIN_GUARDS nothing saved");

  const missing = await fixture(t, { missing: ["organizationCommercialTerms"] });
  const page = await (await missing.get(PAGE)).text();
  assert.match(page, /Some changes are unavailable right now/, "ADMIN_GUARDS missing service is announced");
  assert.equal(forms(page).filter(([, , , html]) => / disabled/.test(html!)).map(([, , field]) => field).join(), "hourly_rate,bonus_commission,currency_code", "ADMIN_GUARDS only its fields are disabled");
  assert.equal((await missing.post(PREVIEW, change("hourly_rate", "2"))).status, 503, "ADMIN_GUARDS missing service preview is 503");
  const throwing = await fixture(t, { throwing: "preview" });
  const failed = await throwing.post(PREVIEW, change("status", "active"));
  assert.equal(failed.status, 503, "ADMIN_GUARDS a throwing service is 503");
  assert.doesNotMatch(await failed.text(), /private/, "ADMIN_GUARDS no internal detail leaks");
});
