import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { InMemoryAuthzStore } from "@studenthub/contracts";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import { InMemoryApprovedProfileAdapter, OwnProfileRepository } from "@studenthub/profile";
import {
  InMemoryApprovedOrganizationAdapter, OrganizationRepository, SYNTHETIC_ORGANIZATION_FIXTURES, ORGANIZATION_NOTE_FIELDS,
  organizationNoteDecision, organizationNotePrincipalRef, organizationNoteRecordRef, organizationNoteTypeOf, organizationNotesView,
  type OrganizationNoteRow,
} from "@studenthub/organizations";
import type { SafeWriteStore } from "@studenthub/safe-write-contract";
import { createGatewayServer, createLoginApplication } from "../src/index.js";
import { errorPage } from "../src/shell/error-pages.js";
import { createContextNavigation } from "../src/context-navigation.js";
import { createOrganizationNotes, type OrganizationNotes, type OrganizationNotesStore } from "../src/organization-notes.js";
import { renderError, type BrowserLoginApplication } from "../src/web-ui.js";

const ORIGIN = "https://studenthub.example.invalid";
const SECRET = "o06-notes-page-test-secret-is-at-least-thirty-two-bytes";
const CONFLICT = "This note was already saved or its preview expired. Open the notes again and retry.";
/** The gateway's unknown-path answer for a browser (U-07). */
const FALLBACK = errorPage("not-found").html;
const SESSIONS = {
  owner: "e".repeat(43), recruiter: "r".repeat(43), staff: "s".repeat(43), admin: "m".repeat(43), outsider: "b".repeat(43),
} as const;
type Who = keyof typeof SESSIONS | "none";
const PEOPLE: Record<keyof typeof SESSIONS, string> = {
  owner: "person-owner", recruiter: "person-recruiter", staff: "person-staff", admin: "person-admin", outsider: "person-outsider",
};
const LABELS: Readonly<Record<string, string>> = {
  internal_note: "Internal note", phone_call: "Phone call", email: "Email", meeting: "Meeting", interview: "Interview", task: "Task",
};
// Stored rows in no particular order: the service sorts them newest first.
const SEEDED: readonly OrganizationNoteRow[] = [
  { id: "1", author_principal_id: "person-staff", body: "First call with the company", created_at: "2026-11-01T09:00:00.000Z", note_type: "phone_call" },
  { id: "2", author_principal_id: "person-admin", body: "<script>x</script>", created_at: "2026-11-20T09:00:00.000Z", note_type: "internal_note" },
  { id: "3", author_principal_id: "person-staff", body: "Sent the contract", created_at: "2026-11-10T09:00:00.000Z", note_type: "email" },
  { id: "4", author_principal_id: "person-admin", body: "Interview day agreed", created_at: "2026-11-15T09:00:00.000Z", note_type: "interview" },
  { id: "5", author_principal_id: "person-staff", body: "Visit the head office", created_at: "2026-11-05T09:00:00.000Z", note_type: "meeting" },
  { id: "6", author_principal_id: "person-admin", body: "Chase the signed copy", created_at: "2026-11-12T09:00:00.000Z", note_type: "task" },
];

interface Options { readonly noNotes?: boolean; readonly throwing?: "list" | "preview" | "confirm" }

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
  await store.grantMany(PEOPLE.outsider, [{ orgId: "org-b", role: "staff", scope: "subtree" }]);

  // The in-memory notes store: access is decided as the Postgres store decides it,
  // with organizationNoteDecision over the principal's grants and the organization's ancestors.
  const rows = new Map<string, OrganizationNoteRow[]>([["org-a", [...SEEDED]], ["org-a1", []], ["org-b", []]]);
  const spent = new Set<string>();
  let nextId = 100;
  let now = new Date("2026-11-23T10:00:00.000Z");
  const ancestors = async (orgId: string) => {
    const chain: string[] = [];
    for (let org = await store.getOrganization(orgId); org?.parentOrgId; org = await store.getOrganization(org.parentOrgId)) chain.push(org.parentOrgId);
    return chain;
  };
  const allowed = async (principalId: string, orgId: string) => {
    if (!(await store.getOrganization(orgId))) return false;
    const grants = (await store.listGrantsForPrincipal(principalId)).map((grant) => ({ org_id: grant.orgId, role: grant.role, scope: grant.scope }));
    return organizationNoteDecision(grants, orgId, await ancestors(orgId));
  };
  const notesStore: OrganizationNotesStore = {
    forPrincipal(principalId: string, orgId: string): SafeWriteStore {
      const principal = organizationNotePrincipalRef(principalId), record = organizationNoteRecordRef(orgId);
      return {
        ownedRecord: async (principalRef) => principalRef === principal && await allowed(principalId, orgId) ? record : null,
        readField: () => null,
        commit: async (input) => {
          if (input.principalRef !== principal || input.personRef !== record || !(await allowed(principalId, orgId))) return { ok: false, reason: "not_own_record" };
          if (spent.has(input.tokenId)) return { ok: false, reason: "token_already_used" };
          if (input.expectedBefore !== null) return { ok: false, reason: "state_changed" };
          spent.add(input.tokenId);
          rows.get(orgId)!.push({ id: String(nextId++), author_principal_id: principalId, body: input.value, created_at: now.toISOString(), note_type: organizationNoteTypeOf(input.field)! });
          return { ok: true };
        },
      };
    },
    readReceipt: async () => null,
    list: async (principalId, orgId) => await allowed(principalId, orgId) ? [...(rows.get(orgId) ?? [])] : null,
  };
  const service = createOrganizationNotes({ sessions: rig.sessions, store: notesStore, secret: SECRET, clock: { now: () => now } });
  const lists: string[] = []; const previews: unknown[] = []; const confirms: unknown[] = [];
  const organizationNotes: OrganizationNotes = {
    async list(session, orgId) { lists.push(orgId); if (options.throwing === "list") throw new Error("private list detail"); return service.list(session, orgId); },
    async preview(session, body) { previews.push(body); if (options.throwing === "preview") throw new Error("private preview detail"); return service.preview(session, body); },
    async confirm(session, body) { confirms.push(body); if (options.throwing === "confirm") throw new Error("private confirm detail"); return service.confirm(session, body); },
    receipt: (session, orgId, ref) => service.receipt(session, orgId, ref),
  };

  const { parentA, childA1, unrelatedB } = SYNTHETIC_ORGANIZATION_FIXTURES;
  const organizations = new OrganizationRepository({ store, source: new InMemoryApprovedOrganizationAdapter(new Map<string, unknown>([
    ["org-a", parentA], ["org-a1", childA1], ["org-b", unrelatedB],
  ])) });
  const navigation = createContextNavigation(rig.sessions, store, organizations);
  const login: BrowserLoginApplication & { organizationNotes?: OrganizationNotes } = {
    ...rig.app, navigation, ...(options.noNotes ? {} : { organizationNotes }),
    web: { origin: ORIGIN, returnTo: rig.config.allowedReturnUrls[1],
      profiles: new OwnProfileRepository({ principals: store, source: new InMemoryApprovedProfileAdapter({ links: [], rows: new Map() }), today: () => "2026-11-23" }) },
  };
  const server = createGatewayServer(undefined, undefined, undefined, login);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const cookie = (who: Who): Record<string, string> => who === "none" ? {} : { cookie: `__Host-studenthub_session=${SESSIONS[who]}` };
  const get = (path: string, who: Who = "staff", method = "GET") => fetch(`${base}${path}`, { method, headers: { accept: "text/html", ...cookie(who) }, redirect: "manual" });
  const post = (path: string, body: string | URLSearchParams, who: Who = "staff", headers: Record<string, string> = {}) =>
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
  const stored = () => rows.get("org-a")!.length;
  return { get, post, confirmForm, rows, stored, lists, previews, confirms, login, service, base,
    advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

const NOTES = "/organization/org-a/notes", PREVIEW = `${NOTES}/preview`, CONFIRM = `${NOTES}/confirm`;
const note = (field: string, value: string) => new URLSearchParams({ field, value });
const unescape = (text: string) => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const items = (html: string) => [...html.matchAll(/<li><strong>([^<]*)<\/strong> <time datetime="([^"]*)">([^<]*)<\/time><p>([\s\S]*?)<\/p><\/li>/g)]
  .map(([, label, datetime, shown, text]) => ({ label: unescape(label!), datetime: unescape(datetime!), shown: unescape(shown!), text: unescape(text!) }));
const conflictPattern = new RegExp(CONFLICT.replace(/\./g, "\\."));

test("NOTES_LIST staff and admin see the notes newest first with the typed add form", async (t) => {
  const f = await fixture(t);
  const response = await f.get(NOTES); const body = await response.text();
  assert.equal(response.status, 200, "NOTES_LIST staff page is 200");
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(body, /<h1>Notes<\/h1>/, "NOTES_LIST heading");
  assert.ok(body.includes("<p>&lt;script&gt;x&lt;/script&gt;</p>"), "NOTES_LIST note text is escaped");
  assert.doesNotMatch(body, /<script>x<\/script>/, "NOTES_LIST raw note text never renders");
  const listed = await f.service.list(`${SESSIONS.staff}`, "org-a");
  assert.equal(listed.status, 200);
  const expected = (listed.body as { notes: ReturnType<typeof organizationNotesView> }).notes;
  assert.deepEqual(expected, organizationNotesView(SEEDED), "NOTES_LIST the service lists in organizationNotesView order");
  assert.deepEqual(items(body), expected.map((view) => ({ label: LABELS[view.noteType], datetime: view.createdAt, shown: view.createdAt, text: view.text })),
    "NOTES_LIST one item per note, newest first, with label, time and text");
  assert.deepEqual(items(body).map((item) => item.label), ["Internal note", "Interview", "Task", "Email", "Meeting", "Phone call"]);
  assert.equal([...body.matchAll(/<ol>/g)].length, 1); assert.doesNotMatch(body, /No notes yet\./);
  assert.doesNotMatch(body, /person-staff|person-admin/, "NOTES_LIST author ids are never shown");
  assert.match(body, /<a href="\/organization\/org-a">Company<\/a>/, "NOTES_LIST links back to the company");
  const form = /<form method="post" action="\/organization\/org-a\/notes\/preview">([\s\S]*?)<\/form>/.exec(body);
  assert.ok(form, "NOTES_LIST the add form posts to preview");
  const options = [...form[1]!.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map(([, value, label]) => [value, label]);
  assert.deepEqual(options, ORGANIZATION_NOTE_FIELDS.map((field) => [field, LABELS[organizationNoteTypeOf(field)!]]), "NOTES_LIST one option per note field");
  assert.match(form[1]!, /<select[^>]* name="field">/); assert.match(form[1]!, /<textarea[^>]* name="value" maxlength="2000"><\/textarea>/, "NOTES_LIST textarea value maxlength 2000");
  const admin = await f.get(NOTES, "admin");
  assert.equal(admin.status, 200, "NOTES_LIST admin page is 200"); assert.equal(await admin.text(), body, "NOTES_LIST admin sees the same page");
  const empty = await f.get("/organization/org-a1/notes"); const emptyBody = await empty.text();
  assert.equal(empty.status, 200); assert.match(emptyBody, /<p>No notes yet\.<\/p>/, "NOTES_LIST empty state"); assert.doesNotMatch(emptyBody, /<ol>|<li>/, "NOTES_LIST empty state has no list");
  const head = await f.get(NOTES, "staff", "HEAD");
  assert.equal(head.status, 200, "NOTES_LIST HEAD is answered like GET"); assert.match(head.headers.get("content-type") ?? "", /^text\/html\b/);
  assert.equal(head.headers.get("cache-control"), "no-store"); assert.equal(await head.text(), "");
  assert.equal(f.stored(), SEEDED.length);
});

test("NOTES_DENY refusals are private 404s and no session is 401", async (t) => {
  const f = await fixture(t);
  for (const response of [await f.get(NOTES, "none"), await f.post(PREVIEW, note("note", "x"), "none"), await f.post(CONFIRM, note("note", "x"), "none")]) {
    assert.equal(response.status, 401, "NOTES_DENY no session is 401");
    assert.equal(await response.text(), renderError(401, f.login), "NOTES_DENY no session is renderError(401)");
  }
  const bodies: string[] = [];
  const refusals: [string, Who, string][] = [
    ["org-owner of org-a", "owner", "org-a"], ["recruiter of org-a", "recruiter", "org-a"], ["holds nothing at org-a", "outsider", "org-a"],
    ["unknown organization", "staff", "missing"], ["malformed orgId", "staff", "%20"], ["overlong orgId", "staff", "a".repeat(257)],
  ];
  for (const [, who, org] of refusals) {
    const page = await f.get(`/organization/${org}/notes`, who);
    assert.equal(page.status, 404, "NOTES_DENY every refusal is 404"); bodies.push(await page.text());
    const preview = await f.post(`/organization/${org}/notes/preview`, note("note", "Taken"), who);
    assert.equal(preview.status, 404, "NOTES_DENY every refusal is 404"); bodies.push(await preview.text());
    const confirm = await f.post(`/organization/${org}/notes/confirm`, note("note", "Taken"), who);
    assert.equal(confirm.status, 404, "NOTES_DENY every refusal is 404"); bodies.push(await confirm.text());
  }
  assert.ok(bodies.every((body) => body === bodies[0]), "NOTES_DENY refusal bodies are byte-identical");
  assert.equal(bodies[0], renderError(404, f.login));
  assert.deepEqual([f.previews.length, f.confirms.length, f.stored()], [0, 0, SEEDED.length], "NOTES_DENY refusals store nothing");
  // A refused principal holding a token issued to staff still cannot write.
  const issued = f.confirmForm(await (await f.post(PREVIEW, note("note", "Staff only"))).text());
  const stolen = await f.post(CONFIRM, issued, "owner");
  assert.equal(stolen.status, 404, "NOTES_DENY every refusal is 404"); assert.equal(await stolen.text(), bodies[0]);
  assert.equal(f.stored(), SEEDED.length, "NOTES_DENY refusals store nothing");
});

test("NOTES_PREVIEW a typed note previews escaped with a token-carrying confirm form", async (t) => {
  const f = await fixture(t);
  const response = await f.post(PREVIEW, note("note_email", "<b>Hello & bye</b>")); const body = await response.text();
  assert.equal(response.status, 200, "NOTES_PREVIEW valid note is 200");
  assert.deepEqual(f.previews, [{ orgId: "org-a", field: "note_email", value: "<b>Hello & bye</b>" }], "NOTES_PREVIEW calls preview once");
  assert.match(body, /<dd>Email<\/dd>/, "NOTES_PREVIEW shows the type label");
  assert.match(body, /<dd>&lt;b&gt;Hello &amp; bye&lt;\/b&gt;<\/dd>/, "NOTES_PREVIEW shows the escaped text"); assert.doesNotMatch(body, /<b>Hello/);
  const form = f.confirmForm(body);
  assert.deepEqual([...form.keys()].sort(), ["field", "token.changeSetDigest", "token.expectedBeforeDigest", "token.expiresAt",
    "token.issuedAt", "token.mac", "token.principalRef", "token.tokenId", "value"], "NOTES_PREVIEW hidden inputs");
  assert.deepEqual([form.get("field"), form.get("value")], ["note_email", "<b>Hello & bye</b>"]);
  assert.match(body, /<form method="post" action="\/organization\/org-a\/notes\/confirm">[\s\S]*<button[^>]*>Save note<\/button><\/form>/, "NOTES_PREVIEW Save note posts to confirm");
  assert.match(body, /<a class="text-link" href="\/organization\/org-a\/notes">Cancel<\/a>/, "NOTES_PREVIEW Cancel goes back");
  assert.equal(f.stored(), SEEDED.length, "NOTES_PREVIEW a preview stores nothing");
  f.previews.length = 0;

  const whitespace = await f.post(PREVIEW, note("note", " \t\n "));
  assert.equal(f.previews.length, 0, "NOTES_PREVIEW a whitespace-only value never reaches the service");
  assert.equal(whitespace.status, 400); assert.match(await whitespace.text(), /class="error-page"/);
  const bad: [string, string][] = [
    ["unknown field", "field=legal_name&value=X"], ["missing value", "field=note"], ["missing field", "value=X"],
    ["repeated key", "field=note&value=X&value=Y"], ["extra key", "field=note&value=X&orgId=org-a"], ["empty value", "field=note&value="],
  ];
  for (const [name, form] of bad) {
    const refused = await f.post(PREVIEW, form); assert.equal(refused.status, 400, `NOTES_PREVIEW ${name} is 400`);
    assert.match(await refused.text(), /class="error-page"/, `NOTES_PREVIEW ${name} is a plain page`);
  }
  assert.equal(f.previews.length, 0, "NOTES_PREVIEW malformed forms never reach the service");
  const serviceRefusals: [string, URLSearchParams | string][] = [
    ["2001 characters", note("note", "a".repeat(2001))], ["a control character", note("note", "bad\u0001value")],
    ["a body over 32768 bytes", `field=note&value=${"a".repeat(32_800)}`],
  ];
  for (const [name, form] of serviceRefusals) {
    const refused = await f.post(PREVIEW, form); assert.equal(refused.status, 400, `NOTES_PREVIEW ${name} is 400`);
    const text = await refused.text();
    assert.match(text, /class="error-page"/, `NOTES_PREVIEW ${name} is a plain page`); assert.doesNotMatch(text, /invalid_value/);
  }
  assert.equal(f.stored(), SEEDED.length, "NOTES_PREVIEW every 400 stores nothing");

  const arabic = "ب".repeat(2000);
  const ok = await f.post(PREVIEW, note("note_meeting", arabic)); assert.equal(ok.status, 200, "NOTES_PREVIEW 2000 Arabic characters preview");
  const saved = await f.post(CONFIRM, f.confirmForm(await ok.text())); assert.equal(saved.status, 303, "NOTES_PREVIEW 2000 Arabic characters confirm");
  const row = f.rows.get("org-a")!.at(-1)!;
  assert.deepEqual([row.body, row.note_type, row.author_principal_id], [arabic, "meeting", "person-staff"], "NOTES_PREVIEW the Arabic note is stored unchanged");
  const first = items(await (await f.get(`${NOTES}?saved=note`)).text())[0]!;
  assert.deepEqual([first.label, first.text], ["Meeting", arabic], "NOTES_PREVIEW the Arabic note reads back first");
});

test("NOTES_CONFIRM a confirmed note is saved once and replays or bad tokens are 409", async (t) => {
  const f = await fixture(t);
  const form = f.confirmForm(await (await f.post(PREVIEW, note("note_task", "Call back on Sunday"))).text());
  const done = await f.post(CONFIRM, form);
  assert.equal(done.status, 303, "NOTES_CONFIRM confirm redirects with 303");
  assert.equal(done.headers.get("location"), "/organization/org-a/notes?saved=note", "NOTES_CONFIRM redirects to the saved notice");
  assert.equal(f.confirms.length, 1, "NOTES_CONFIRM confirm calls the service once");
  assert.equal(f.stored(), SEEDED.length + 1, "NOTES_CONFIRM confirm stores the note");
  const page = await f.get(`${NOTES}?saved=note`); const body = await page.text();
  assert.equal(page.status, 200); assert.match(body, /<strong>Note saved\.<\/strong>/, "NOTES_CONFIRM shows Note saved.");
  assert.deepEqual(items(body)[0], { label: "Task", datetime: "2026-11-23T10:00:00.000Z", shown: "2026-11-23T10:00:00.000Z", text: "Call back on Sunday" }, "NOTES_CONFIRM the new note is first");
  assert.doesNotMatch(await (await f.get(NOTES)).text(), /Note saved\./, "NOTES_CONFIRM no notice without the query");
  for (const query of ["?saved=other", "?saved=", "?x=1", "?saved=note&saved=note", "?saved=note&x=1"]) {
    const refused = await f.get(`${NOTES}${query}`);
    assert.equal(refused.status, 400, `NOTES_CONFIRM ${query} is 400`); assert.match(await refused.text(), /class="error-page"/);
  }

  const replay = await f.post(CONFIRM, form);
  assert.equal(replay.status, 409, "NOTES_CONFIRM a replay is 409"); assert.match(await replay.text(), conflictPattern, "NOTES_CONFIRM a replay shows the conflict page");
  assert.equal(f.stored(), SEEDED.length + 1, "NOTES_CONFIRM a replay stores nothing more");

  const fresh = f.confirmForm(await (await f.post(PREVIEW, note("note", "Fresh text"))).text());
  const tampered = new URLSearchParams(fresh); tampered.set("token.mac", "A".repeat(fresh.get("token.mac")!.length));
  const forged = await f.post(CONFIRM, tampered);
  assert.equal(forged.status, 409, "NOTES_CONFIRM a tampered token is 409"); assert.match(await forged.text(), conflictPattern);
  const swapped = new URLSearchParams(fresh); swapped.set("value", "Different text");
  const changed = await f.post(CONFIRM, swapped);
  assert.equal(changed.status, 409, "NOTES_CONFIRM a token for another text is 409"); assert.match(await changed.text(), conflictPattern);
  f.advance(24 * 60 * 60 * 1000);
  const expired = await f.post(CONFIRM, fresh);
  assert.equal(expired.status, 409, "NOTES_CONFIRM an expired token is 409"); assert.match(await expired.text(), conflictPattern);
  assert.equal(f.stored(), SEEDED.length + 1, "NOTES_CONFIRM conflicts store nothing");
  assert.ok(!f.rows.get("org-a")!.some((row) => row.body === "Fresh text" || row.body === "Different text"));
});

test("NOTES_ORIGIN both posts refuse a missing or foreign origin before reading the body", async (t) => {
  const f = await fixture(t);
  for (const path of [PREVIEW, CONFIRM]) {
    const missing = await f.post(path, note("note", "X"), "staff", { origin: "" });
    assert.equal(missing.status, 403, "NOTES_ORIGIN a missing Origin is 403");
    assert.equal((await f.post(path, note("note", "X"), "staff", { origin: "https://evil.example.invalid" })).status, 403, "NOTES_ORIGIN a foreign Origin is 403");
    assert.equal((await f.post(path, note("note", "X"), "staff", { "sec-fetch-site": "cross-site" })).status, 403, "NOTES_ORIGIN cross-site is 403");
  }
  assert.deepEqual([f.lists.length, f.previews.length, f.confirms.length], [0, 0, 0], "NOTES_ORIGIN origin refusals call nothing");
  for (const path of [PREVIEW, CONFIRM]) {
    for (const type of ["application/json", "text/plain", "multipart/form-data; boundary=x"]) {
      const refused = await f.post(path, "field=note&value=X", "staff", { "content-type": type });
      assert.equal(refused.status, 400, "NOTES_ORIGIN a non-form content type is 400"); assert.match(await refused.text(), /class="error-page"/);
    }
  }
  assert.deepEqual([f.previews.length, f.confirms.length, f.stored()], [0, 0, SEEDED.length], "NOTES_ORIGIN refusals store nothing");
});

test("NOTES_UNAVAILABLE an unconfigured or failing service is a plain 503", async (t) => {
  const off = await fixture(t, { noNotes: true });
  for (const response of [await off.get(NOTES), await off.post(PREVIEW, note("note", "X")), await off.post(CONFIRM, note("note", "X"))]) {
    assert.equal(response.status, 503, "NOTES_UNAVAILABLE an unconfigured service is 503");
    const body = await response.text();
    assert.match(body, /class="error-page"/); assert.match(body, /Notes are unavailable right now\./, "NOTES_UNAVAILABLE says notes are unavailable");
  }
  const secret = /private (?:list|preview|confirm) detail|Error:|\n\s+at /;
  const listThrows = await fixture(t, { throwing: "list" });
  for (const response of [await listThrows.get(NOTES), await listThrows.post(PREVIEW, note("note", "X"))]) {
    assert.equal(response.status, 503, "NOTES_UNAVAILABLE a throwing list is 503");
    const body = await response.text(); assert.doesNotMatch(body, secret); assert.match(body, /Notes are unavailable right now\./);
  }
  const previewThrows = await fixture(t, { throwing: "preview" });
  const thrown = await previewThrows.post(PREVIEW, note("note", "X")); const thrownBody = await thrown.text();
  assert.equal(thrown.status, 503, "NOTES_UNAVAILABLE a throwing preview is 503"); assert.doesNotMatch(thrownBody, secret);
  const confirmThrows = await fixture(t, { throwing: "confirm" });
  const form = confirmThrows.confirmForm(await (await confirmThrows.post(PREVIEW, note("note", "X"))).text());
  const failed = await confirmThrows.post(CONFIRM, form); const failedBody = await failed.text();
  assert.equal(failed.status, 503, "NOTES_UNAVAILABLE a throwing confirm is 503"); assert.doesNotMatch(failedBody, secret);
  assert.equal(confirmThrows.stored(), SEEDED.length, "NOTES_UNAVAILABLE a failed confirm stores nothing");
});

test("NOTES_PASSTHROUGH the JSON routes and the other company pages answer as before", async (t) => {
  const f = await fixture(t);
  const json = (path: string, body: unknown) => fetch(`${f.base}${path}`, { method: "POST", body: JSON.stringify(body),
    headers: { origin: ORIGIN, "content-type": "application/json", cookie: `__Host-studenthub_session=${SESSIONS.staff}` } });
  const list = await fetch(`${f.base}/organization/notes/org-a`, { headers: { cookie: `__Host-studenthub_session=${SESSIONS.staff}` } });
  assert.equal(list.status, 200, "NOTES_PASSTHROUGH the JSON list answers");
  assert.equal(list.headers.get("content-type"), "application/json");
  assert.deepEqual(await list.json(), { notes: organizationNotesView(SEEDED) }, "NOTES_PASSTHROUGH the JSON list body");
  const change = { orgId: "org-a", field: "note", value: "Through JSON" };
  const preview = await json("/organization/notes/preview", change);
  assert.equal(preview.status, 200, "NOTES_PASSTHROUGH the JSON preview answers"); assert.equal(preview.headers.get("content-type"), "application/json");
  const previewed = await preview.json() as { token: unknown; changes: unknown };
  assert.deepEqual(Object.keys(previewed).sort(), ["changes", "token"]);
  const confirm = await json("/organization/notes/confirm", { ...change, token: previewed.token });
  assert.equal(confirm.status, 200, "NOTES_PASSTHROUGH the JSON confirm answers"); assert.equal(confirm.headers.get("content-type"), "application/json");
  assert.deepEqual(Object.keys(await confirm.json() as object), ["receipt"]);
  assert.equal(f.stored(), SEEDED.length + 1); assert.equal(f.rows.get("org-a")!.at(-1)!.body, "Through JSON");
  const deniedJson = await fetch(`${f.base}/organization/notes/org-a`, { headers: { cookie: `__Host-studenthub_session=${SESSIONS.owner}` } });
  assert.equal(deniedJson.status, 404); assert.deepEqual(await deniedJson.json(), { error: "not_found" });

  const overview = await f.get("/organization/org-a", "owner"); const overviewBody = await overview.text();
  assert.equal(overview.status, 200, "NOTES_PASSTHROUGH the overview answers an allowed member as before");
  assert.match(overviewBody, /<h1>Synthetic Retail Group<\/h1>/); assert.match(overviewBody, /href="\/organization\/org-a\/edit">Edit company details</);
  const staffOverview = await f.get("/organization/org-a?role=staff");
  assert.equal(staffOverview.status, 200, "NOTES_PASSTHROUGH the overview answers staff as before");
  const edit = await f.get("/organization/org-a/edit", "owner");
  assert.equal(edit.status, 200, "NOTES_PASSTHROUGH the edit page answers as before"); assert.match(await edit.text(), /Editing is unavailable right now\./);
  const stores = await f.get("/organization/org-a/stores");
  assert.equal(stores.status, 503, "NOTES_PASSTHROUGH the unwired stores page answers as before"); assert.match(await stores.text(), /Stores unavailable/);

  for (const [method, path] of [["PUT", NOTES], ["DELETE", NOTES], ["PATCH", PREVIEW], ["GET", PREVIEW], ["GET", CONFIRM], ["HEAD", CONFIRM], ["DELETE", CONFIRM],
    ["GET", `${NOTES}/receipts`], ["GET", `${NOTES}/`], ["POST", `${NOTES}/other`], ["GET", "/organization/org-a/notesx"]] as const) {
    const response = await f.get(path, "staff", method);
    assert.equal(response.status, 404, `NOTES_PASSTHROUGH ${method} ${path} falls through`);
    if (method !== "HEAD") assert.equal(await response.text(), FALLBACK, `NOTES_PASSTHROUGH ${method} ${path} reaches the fallback`);
  }
  assert.deepEqual([f.previews.length, f.confirms.length], [1, 1], "NOTES_PASSTHROUGH only the JSON writes reached the service");
});
