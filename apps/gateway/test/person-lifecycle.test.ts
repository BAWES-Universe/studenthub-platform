import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { PeopleDirectoryRow, PeopleDirectoryStore } from "@studenthub/profile";
import type { PersonLifecycle, PersonTagRecord, PersonWarningRecord } from "@studenthub/db/access";
import { createPeopleDirectory } from "../src/people-directory.js";
import type { PersonLifecycleHttp } from "../src/person-lifecycle.js";
import { hasOperatorStaffGrant } from "../src/wiring/profile.js";
import { REAL_PROFILE_ORIGIN, REAL_PROFILE_OTHER_PERSON, REAL_PROFILE_OTHER_SESSION, REAL_PROFILE_PERSON, startRealProfileServer } from "./helpers/real-profile-server.js";

// A-02 slice 1: staff warn and tag a person from the person page (legacy CandidateController warn and tag actions).
const person: PeopleDirectoryRow = { principalId: REAL_PROFILE_OTHER_PERSON, name: "Other <Person>", universeName: null, arabicName: null, workStatus: null,
  nationality: null, detailsMissing: 0, civilState: "recorded", imported: false, employeeId: null, phoneLast4: null };
const base = `/workspace/people/${REAL_PROFILE_OTHER_PERSON}`, page = `${base}/lifecycle`;
const W1 = "11111111-1111-4111-8111-111111111111", T1 = "22222222-2222-4222-8222-222222222222";

type Call = readonly [string, ...unknown[]];

async function setup(t: TestContext, options: { staff?: boolean } = {}) {
  const calls: Call[] = [];
  let next = 0;
  const warnings: PersonWarningRecord[] = [{ id: W1, title: "Late <again>", message: "Missed the 9 & 10 shifts", created_by_name: "Staff \"One\"", created_at: "2026-11-20T06:30:00.000Z", version: 1, updated_by_name: null, updated_at: null }];
  const tags: PersonTagRecord[] = [{ id: T1, tag: "No show", reason: "Two missed interviews", created_by_name: null, created_at: "2026-11-21T07:00:00.000Z" }];
  let authzRef: { listGrantsForPrincipal(id: string): Promise<readonly { role: string; scope: string; orgId: string }[]> } | undefined;
  /** As the Postgres store: the caller's grants and the person are checked again inside the call. */
  const allowed = async (actor: string, principal: string) => principal === REAL_PROFILE_OTHER_PERSON && hasOperatorStaffGrant(await authzRef!.listGrantsForPrincipal(actor));
  const store: PersonLifecycleHttp["store"] = {
    async read(actor, principal) { calls.push(["read", actor, principal]); return await allowed(actor, principal) ? { warnings: [...warnings], tags: [...tags] } satisfies PersonLifecycle : null; },
    async warn(actor, principal, input) { calls.push(["warn", actor, principal, input]); if (!await allowed(actor, principal)) return { kind: "not_found" }; const id = `00000000-0000-4000-8000-00000000000${next++}`; warnings.unshift({ id, ...input, created_by_name: "Me", created_at: "2026-11-28T09:00:00.000Z", version: 1, updated_by_name: null, updated_at: null }); return { kind: "warned", warningId: id }; },
    async correctWarning(actor, principal, id, input) { calls.push(["correct", actor, principal, id, input]); if (!await allowed(actor, principal)) return { kind: "not_found" }; const w = warnings.find((x) => x.id === id); if (!w) return { kind: "not_found" }; if (w.version !== input.expectedVersion) return { kind: "stale", version: w.version }; Object.assign(w, { title: input.title, message: input.message, version: w.version + 1, updated_by_name: "Me", updated_at: "2026-11-28T09:30:00.000Z" }); return { kind: "corrected", version: w.version }; },
    async addTag(actor, principal, input) { calls.push(["tag", actor, principal, input]); if (!await allowed(actor, principal)) return { kind: "not_found" }; if (tags.some((x) => x.tag.toLowerCase() === input.tag.toLowerCase())) return { kind: "duplicate" }; const id = `33333333-3333-4333-8333-33333333333${next++}`; tags.unshift({ id, tag: input.tag, reason: input.reason, created_by_name: "Me", created_at: "2026-11-28T09:00:00.000Z" }); return { kind: "tagged", tagId: id }; },
    async removeTag(actor, principal, id) { calls.push(["untag", actor, principal, id]); if (!await allowed(actor, principal)) return { kind: "not_found" }; const at = tags.findIndex((x) => x.id === id); if (at < 0) return { kind: "not_found" }; tags.splice(at, 1); return { kind: "removed" }; },
  };
  const people: PeopleDirectoryStore = { async page() { return { rows: [person], total: 1 }; }, async person(id: string) { return id === person.principalId ? person : null; } };
  const server = await startRealProfileServer(t, {
    extend: (services) => { authzRef = services.authz; return { people: createPeopleDirectory({ sessions: services.sessions, authz: services.authz, store: people, choices: async () => ({ countries: [] }), now: services.now }), lifecycle: { sessions: services.sessions, store } } as never; },
  });
  if (options.staff !== false) await server.authz.grantMany(REAL_PROFILE_PERSON, [{ orgId: "root", role: "staff", scope: "subtree" }]);
  return { server, calls, warnings, tags };
}
type Rig = Awaited<ReturnType<typeof setup>>;
const unknownPath = async (x: Rig) => (await x.server.get("/no-such-page")).text();
const post = (x: Rig, path: string, body: string, headers: Record<string, string> = {}, session?: string) => fetch(`${x.server.url}${path}`, { method: "POST", redirect: "manual", body,
  headers: { accept: "text/html", cookie: x.server.cookie(session), origin: REAL_PROFILE_ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded", ...headers } });
const writes = (x: Rig) => x.calls.filter((c) => c[0] !== "read");

test("A02_PAGE staff see the warnings and live tags with who and when, escaped, and the forms", async (t) => {
  const x = await setup(t);
  const response = await x.server.get(page);
  const html = await response.text();
  assert.equal(response.status, 200, "A02_PAGE staff page is 200");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(html, /<h1>Warnings and tags for Other &lt;Person&gt;<\/h1>/, "A02_PAGE heading names the person, escaped");
  assert.ok(html.includes("<h3>Late &lt;again&gt;</h3><p class=\"warning-message\">Missed the 9 &amp; 10 shifts</p>"), "A02_PAGE warning title and message, escaped");
  assert.ok(html.includes("By Staff &quot;One&quot;, 20 Nov 2026, 09:30 Kuwait time</p>"), "A02_PAGE warning author and Kuwait time");
  assert.ok(html.includes(`<form method="post" action="${base}/warnings/${W1}"><input type="hidden" name="version" value="1">`), "A02_PAGE correction form carries the version read");
  assert.ok(html.includes("<strong>No show</strong><p>Two missed interviews</p><p class=\"field-meta\">By Unknown, 21 Nov 2026, 10:00 Kuwait time</p>"), "A02_PAGE tag with reason, unknown author");
  assert.ok(html.includes(`<form method="post" action="${base}/tags/${T1}/remove"><button class="text-link" type="submit">Remove tag</button></form>`), "A02_PAGE remove form");
  assert.ok(html.includes(`<form method="post" action="${base}/warnings"><h3>Warn this person</h3><label>Title<input name="title" required maxlength="100" value="Not appearing for interview">`), "A02_PAGE legacy default title");
  assert.match(html, /The person is emailed this title and message\./, "A02_PAGE says a warning is emailed");
  assert.ok(html.includes(`<form method="post" action="${base}/tags"><h3>Add a tag</h3><label>Tag<input name="tag" required maxlength="128"></label><label>Reason<textarea name="reason" required maxlength="1000">`), "A02_PAGE tag form needs a reason");
  assert.match(html, /Companies and the person do not\./, "A02_PAGE says who does not see it");
  assert.deepEqual(x.calls, [["read", REAL_PROFILE_PERSON, REAL_PROFILE_OTHER_PERSON]], "A02_PAGE one store read as the session's person");

  const json = await (await fetch(x.server.url + page, { headers: { accept: "application/json", cookie: x.server.cookie() } })).json() as { person: unknown; warnings: unknown[]; tags: unknown[] };
  assert.deepEqual(json.person, { principalId: REAL_PROFILE_OTHER_PERSON, name: "Other <Person>" }, "A02_PAGE JSON person");
  assert.equal(json.warnings.length, 1); assert.equal(json.tags.length, 1);

  const detail = await (await x.server.get(base)).text();
  assert.ok(detail.includes(`<a class="text-link" href="${page}">Warnings and tags</a>`), "A02_PAGE the person page links here");
  assert.ok(html.includes(`href="${base}">Back to Other &lt;Person&gt;</a>`), "A02_PAGE links back to the person");

  const empty = await setup(t);
  empty.warnings.length = 0; empty.tags.length = 0;
  const none = await (await empty.server.get(page)).text();
  assert.match(none, /No warnings\./); assert.match(none, /No tags\./);
});

test("A02_DENY non-staff, no session, a bad id or a stray query get nothing and change nothing", async (t) => {
  const x = await setup(t, { staff: false });
  const unknown = await unknownPath(x);
  for (const path of [page, `/workspace/people/nobody/lifecycle`, `/workspace/people/%E0/lifecycle`]) {
    const response = await x.server.get(path);
    assert.equal(response.status, 404, `A02_DENY ${path} is 404`);
    assert.equal(await response.text(), unknown, `A02_DENY ${path} is the unknown-path page`);
  }
  for (const [path, body] of [[`${base}/warnings`, "title=a&message=b"], [`${base}/warnings/${W1}`, "title=a&message=b&version=1"], [`${base}/tags`, "tag=a&reason=b"], [`${base}/tags/${T1}/remove`, ""]] as const) {
    const response = await post(x, path, body);
    assert.equal(response.status, 404, `A02_DENY non-staff POST ${path} is 404`);
    assert.equal(await response.text(), unknown);
  }
  assert.deepEqual(x.calls, [], "A02_DENY no store call for a non-staff caller");

  const staff = await setup(t);
  assert.equal((await staff.server.get(page, REAL_PROFILE_OTHER_SESSION)).status, 404, "A02_DENY the person themselves get the 404");
  assert.equal((await fetch(staff.server.url + page, { headers: { accept: "text/html" }, redirect: "manual" })).status, 401, "A02_DENY no session is 401");
  for (const query of ["?x=1", "?done=nope", "?done=warned&done=tagged", "?done=warned&x=1"]) assert.equal((await staff.server.get(page + query)).status, 404, `A02_DENY query ${query} is 404`);
  assert.equal((await staff.server.get(`${page}?done=tagged`)).status, 200, "A02_DENY a known notice is allowed");
  assert.equal((await post(staff, `${base}/warnings?x=1`, "title=a&message=b")).status, 404, "A02_DENY POST query is 404");
  assert.equal((await post(staff, `${base}/warnings/not-a-uuid`, "title=a&message=b&version=1")).status, 404, "A02_DENY bad warning id is 404");
  assert.equal((await post(staff, `${base}/tags/not-a-uuid/remove`, "")).status, 404, "A02_DENY bad tag id is 404");
  assert.equal((await post(staff, `${base}/tags`, "tag=a&reason=b", {}, REAL_PROFILE_OTHER_SESSION)).status, 404, "A02_DENY the person cannot tag themselves");
  assert.deepEqual(writes(staff), [], "A02_DENY no write reached the store");
});

test("A02_ORIGIN a form from another site is refused before the session or body is read", async (t) => {
  const x = await setup(t);
  for (const headers of [{ origin: "https://evil.invalid" }, { "sec-fetch-site": "cross-site" }, { origin: "" }] as Record<string, string>[]) {
    const response = await post(x, `${base}/warnings`, "title=a&message=b", headers);
    assert.equal(response.status, 403, `A02_ORIGIN ${JSON.stringify(headers)} is 403`);
    assert.match(await response.text(), /must be sent from StudentHub itself/);
  }
  assert.deepEqual(x.calls, [], "A02_ORIGIN nothing reached the store");
});

test("A02_WARN a warning is saved as trimmed text by the session's person; invalid forms change nothing", async (t) => {
  const x = await setup(t);
  const response = await post(x, `${base}/warnings`, new URLSearchParams({ title: "  Late  ", message: " Missed shift \n" }).toString());
  assert.equal(response.status, 303, "A02_WARN 303");
  assert.equal(response.headers.get("location"), `${page}?done=warned`, "A02_WARN back to the page with a notice");
  assert.deepEqual(writes(x), [["warn", REAL_PROFILE_PERSON, REAL_PROFILE_OTHER_PERSON, { title: "Late", message: "Missed shift" }]], "A02_WARN one write, trimmed, as the session's person");
  const after = await (await x.server.get(`${page}?done=warned`)).text();
  assert.match(after, /<section class="notice" role="status"><p>Warning saved\. The person is emailed its title and message\.<\/p><\/section>/, "A02_WARN notice");
  assert.match(after, /<h3>Late<\/h3>/, "A02_WARN shown newest first");

  x.calls.length = 0;
  for (const [body, why] of [
    ["title=&message=b", "blank title"], ["title=a&message=+", "blank message"], ["title=a", "missing message"],
    [`title=${"x".repeat(101)}&message=b`, "title over 100"], [`title=a&message=${"x".repeat(5001)}`, "message over 5000"],
    ["title=a&message=b&extra=1", "unknown field"], ["title=a&title=b&message=c", "repeated field"],
  ] as const) {
    const refused = await post(x, `${base}/warnings`, body);
    assert.equal(refused.status, 400, `A02_WARN ${why} is 400`);
    assert.match(await refused.text(), /role="alert"/, `A02_WARN ${why} shows the page with a refusal`);
  }
  const typed = await post(x, `${base}/warnings`, "title=a&message=b", { "content-type": "text/plain" });
  assert.equal(typed.status, 400, "A02_WARN wrong content type is 400");
  const huge = await post(x, `${base}/warnings`, `title=a&message=${"x".repeat(70000)}`);
  assert.equal(huge.status, 400, "A02_WARN a body over the limit is 400");
  assert.match(await huge.text(), /That text is too long\./);
  assert.equal(`title=a&message=${"é".repeat(5000)}`.length < 64 * 1024, true);
  const wide = await post(x, `${base}/warnings`, new URLSearchParams({ title: "a", message: "é".repeat(5000) }).toString());
  assert.equal(wide.status, 303, "A02_WARN 5000 two-byte characters fit the byte limit");
  assert.deepEqual(writes(x).length, 1, "A02_WARN only the valid form wrote");
});

test("A02_CORRECT a correction needs the version read; a stale one is refused and shows the current wording", async (t) => {
  const x = await setup(t);
  const ok = await post(x, `${base}/warnings/${W1}`, "title=Late&message=Missed+one+shift&version=1");
  assert.equal(ok.status, 303, "A02_CORRECT 303");
  assert.equal(ok.headers.get("location"), `${page}?done=corrected`);
  assert.deepEqual(writes(x), [["correct", REAL_PROFILE_PERSON, REAL_PROFILE_OTHER_PERSON, W1, { title: "Late", message: "Missed one shift", expectedVersion: 1 }]], "A02_CORRECT one write with the version read");
  const after = await (await x.server.get(`${page}?done=corrected`)).text();
  assert.match(after, /Corrected by Me, 28 Nov 2026, 12:30 Kuwait time/, "A02_CORRECT who corrected it and when");
  assert.match(after, /name="version" value="2"/, "A02_CORRECT the form now carries version 2");

  const stale = await post(x, `${base}/warnings/${W1}`, "title=Old&message=Old&version=1");
  assert.equal(stale.status, 409, "A02_CORRECT stale is 409");
  const staleHtml = await stale.text();
  assert.match(staleHtml, /Someone corrected this warning meanwhile/, "A02_CORRECT stale message");
  assert.match(staleHtml, /<p class="warning-message">Missed one shift<\/p>/, "A02_CORRECT stale shows the current wording");

  x.calls.length = 0;
  for (const version of ["", "0", "-1", "1.5", "x", "01", "9999999999"]) assert.equal((await post(x, `${base}/warnings/${W1}`, `title=a&message=b&version=${version}`)).status, 400, `A02_CORRECT version ${JSON.stringify(version)} is 400`);
  assert.deepEqual(writes(x), [], "A02_CORRECT bad versions never reach the store");
  const missing = await post(x, `${base}/warnings/99999999-9999-4999-8999-999999999999`, "title=a&message=b&version=1");
  assert.equal(missing.status, 404, "A02_CORRECT another warning id is 404");
});

test("A02_TAGS a tag needs a reason, is unique whatever its case, and is removed once", async (t) => {
  const x = await setup(t);
  const ok = await post(x, `${base}/tags`, "tag=+Reliable+&reason=+Always+on+time+");
  assert.equal(ok.status, 303, "A02_TAGS add 303");
  assert.equal(ok.headers.get("location"), `${page}?done=tagged`);
  assert.deepEqual(writes(x), [["tag", REAL_PROFILE_PERSON, REAL_PROFILE_OTHER_PERSON, { tag: "Reliable", reason: "Always on time" }]], "A02_TAGS trimmed");

  const dup = await post(x, `${base}/tags`, "tag=no+SHOW&reason=again");
  assert.equal(dup.status, 409, "A02_TAGS duplicate whatever its case is 409");
  assert.match(await dup.text(), /This person already has that tag\./);

  x.calls.length = 0;
  for (const [body, why] of [["tag=a&reason=", "blank reason"], ["tag=a", "no reason"], ["tag=+&reason=b", "blank tag"], [`tag=${"x".repeat(129)}&reason=b`, "tag over 128"], [`tag=a&reason=${"x".repeat(1001)}`, "reason over 1000"], ["tag=a&reason=b&title=c", "unknown field"]] as const)
    assert.equal((await post(x, `${base}/tags`, body)).status, 400, `A02_TAGS ${why} is 400`);
  assert.deepEqual(writes(x), [], "A02_TAGS invalid tags never reach the store");

  const removed = await post(x, `${base}/tags/${T1}/remove`, "");
  assert.equal(removed.status, 303, "A02_TAGS remove 303");
  assert.equal(removed.headers.get("location"), `${page}?done=removed`);
  assert.deepEqual(writes(x), [["untag", REAL_PROFILE_PERSON, REAL_PROFILE_OTHER_PERSON, T1]]);
  const again = await post(x, `${base}/tags/${T1}/remove`, "");
  assert.equal(again.status, 409, "A02_TAGS removing twice is 409");
  assert.match(await again.text(), /That tag was already removed\./);
  assert.equal((await post(x, `${base}/tags/${T1}/remove`, "x=1")).status, 400, "A02_TAGS remove takes no fields");
  const html = await (await x.server.get(`${page}?done=removed`)).text();
  assert.doesNotMatch(html, /No show/, "A02_TAGS a removed tag is not shown");
  assert.match(html, /Tag removed\./);
});
