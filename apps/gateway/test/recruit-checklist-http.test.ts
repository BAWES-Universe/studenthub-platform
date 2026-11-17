import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRecruitChecklist, handleRecruitChecklist, type RecruitChecklistStore } from "../src/recruit/checklist-http.js";

const ORIGIN = "https://studenthub.example.invalid", SESSION = "e".repeat(43);
const REQ = "223e4567-e89b-42d3-a456-426614174000", ITEM = "523e4567-e89b-42d3-a456-426614174000", NOTE = "623e4567-e89b-42d3-a456-426614174000";
const calls: string[] = [];
const items = [{ id: ITEM, name_en: "Brief <store>", name_ar: "إحاطة", required: true, sort_order: 1 }, { id: "b", name_en: "Optional", name_ar: null, required: false, sort_order: 2 }];
const store: RecruitChecklistStore = {
  items: async () => items,
  createItem: async (_p, input) => { calls.push(`create:${JSON.stringify(input)}`); return { kind: "created", itemId: ITEM }; },
  updateItem: async (_p, id, input) => { calls.push(`update:${id}:${input.nameEn}`); return { kind: id === ITEM ? "updated" : "not_found" }; },
  removeItem: async (_p, id) => { calls.push(`remove:${id}`); return { kind: id === ITEM ? "removed" : "not_found" }; },
  addNote: async (_p, r, input) => { calls.push(`note:${r}:${JSON.stringify(input)}`); return r !== REQ ? { kind: "not_found" } : input.checklistItemId === NOTE ? { kind: "item_not_found" } : { kind: "created", noteId: NOTE }; },
  editNote: async (_p, id, type, text) => { calls.push(`edit:${id}:${type}:${text}`); return { kind: id === NOTE ? "updated" : "not_found" }; },
  removeNote: async (_p, id) => { calls.push(`unnote:${id}`); return { kind: id === NOTE ? "removed" : "not_found" }; },
  requestNotes: async (_p, r) => r !== REQ ? null : {
    title: "Cashier <x>", items, doneItemIds: [ITEM],
    notes: [{ id: NOTE, card_id: null, person_name: "Noor <b>", checklist_item_id: ITEM, checklist_name: "Brief <store>", note_type: "phone_call", note_text: "Line one\n<script>", author_name: "Sara", created_at: "2026-11-17T10:00:00.000Z", updated_at: "2026-11-17T11:00:00.000Z" }],
  },
};
const service = createRecruitChecklist({ sessions: { get: async (id) => (id === SESSION ? { id, personId: "staff" } : undefined) }, store });

async function call(path: string, o: { body?: string; method?: string; headers?: Record<string, string>; html?: boolean } = {}) {
  const req = Readable.from(o.body ? [o.body] : []) as IncomingMessage;
  req.url = path; req.method = o.method ?? "GET";
  req.headers = { origin: ORIGIN, "content-type": "application/json", cookie: `__Host-studenthub_session=${SESSION}`, ...o.headers };
  let status = 0, payload = "", headers: Record<string, string> = {}, page: { status: number; body: string } | undefined;
  const fake = { headersSent: false, writeHead(code: number, h: Record<string, string>) { status = code; headers = h; fake.headersSent = true; return fake; }, end(chunk?: string) { payload = chunk ?? ""; return fake; }, destroy() { return fake; } };
  const handled = await handleRecruitChecklist(req, fake as unknown as ServerResponse, service, ORIGIN, (s, _t, body) => { page = { status: s, body }; }, o.html ?? false);
  return { handled, status: page?.status ?? status, headers, json: payload ? JSON.parse(payload) as unknown : undefined, page };
}
const post = (value: unknown) => ({ body: JSON.stringify(value), method: "POST" });
const form = (body: string) => ({ body, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, html: true });

test("REC2B_HTTP checklist and notes answer by outcome; refusals reveal nothing; writes need the same origin and a session", async () => {
  calls.length = 0;
  assert.deepEqual((await call("/recruit/admin/checklist")).json, { items: [{ itemId: ITEM, nameEn: "Brief <store>", nameAr: "إحاطة", required: true, sortOrder: 1 }, { itemId: "b", nameEn: "Optional", nameAr: null, required: false, sortOrder: 2 }] });
  assert.deepEqual((await call("/recruit/admin/checklist/create", post({ nameEn: "Call" }))).json, { itemId: ITEM });
  assert.deepEqual((await call("/recruit/admin/checklist/create", post({ nameEn: "" }))).json, { error: "invalid_request" });
  assert.deepEqual((await call(`/recruit/admin/checklist/${ITEM.toUpperCase()}/update`, post({ nameEn: "Call" }))).json, { itemId: ITEM });
  assert.deepEqual((await call(`/recruit/admin/checklist/${REQ}/remove`, { method: "POST", body: "{}" })).json, { error: "not_found" });
  assert.deepEqual((await call("/recruit/admin/checklist/nope/remove", { method: "POST", body: "{}" })).json, { error: "not_found" });
  const notes = (await call(`/recruit/staff/requests/${REQ}/notes`)).json as { checklist: { done: boolean }[]; requiredRemaining: number; notes: { edited: boolean; text: string }[] };
  assert.deepEqual([notes.checklist.map((c) => c.done), notes.requiredRemaining, notes.notes[0]!.edited, notes.notes[0]!.text], [[true, false], 0, true, "Line one\n<script>"]);
  assert.deepEqual((await call(`/recruit/staff/requests/${REQ}/notes`, post({ type: "email", text: "Sent" }))).json, { noteId: NOTE });
  assert.deepEqual((await call(`/recruit/staff/requests/${REQ}/notes`, post({ type: "email", text: "Sent", checklistItemId: NOTE }))).json, { error: "item_not_found" });
  assert.deepEqual((await call(`/recruit/staff/requests/${REQ}/notes`, post({ type: "gossip", text: "x" }))).json, { error: "invalid_request" });
  assert.deepEqual((await call(`/recruit/staff/notes/${NOTE}/edit`, post({ type: "task", text: "Now" }))).json, { noteId: NOTE });
  assert.deepEqual((await call(`/recruit/staff/notes/${NOTE}/edit`, post({ type: "task", text: "Now", cardId: REQ }))).json, { error: "invalid_request" }, "an edit cannot move a note");
  assert.deepEqual((await call(`/recruit/staff/notes/${REQ}/remove`, { method: "POST", body: "{}" })).json, { error: "not_found" });
  const other = "423e4567-e89b-42d3-a456-426614174000";
  assert.deepEqual((await call(`/recruit/staff/requests/${other}/notes`)).json, { error: "not_found" });
  assert.deepEqual((await call(`/recruit/staff/requests/${other}/notes`, post({ type: "email", text: "x" }))).json, { error: "not_found" });
  const before = calls.length;
  assert.equal((await call(`/recruit/staff/notes/${NOTE}/remove`, { method: "POST", body: "{}", headers: { origin: "https://evil.invalid" } })).status, 403);
  assert.equal((await call(`/recruit/staff/notes/${NOTE}/remove`, { method: "POST", body: "{}", headers: { cookie: "" } })).status, 401);
  assert.equal((await call(`/recruit/staff/notes/${NOTE}/remove`)).status, 404);
  assert.equal((await call("/recruit/admin/checklist", post({}))).status, 404);
  assert.equal(calls.length, before, "refused writes reach no store");
  assert.equal((await call(`/recruit/staff/requests/${REQ}`)).handled, false, "the pipeline page belongs to the pipeline module");
});

test("REC2B_HTTP_PAGE pages escape names and notes; forms drop blank fields and return to their page", async () => {
  const admin = (await call("/recruit/admin/checklist", { html: true })).page!;
  for (const text of ["Brief &lt;store&gt;", 'dir="rtl"', `/recruit/admin/checklist/${ITEM}/update`, "checked"]) assert.ok(admin.body.includes(text), text);
  const page = (await call(`/recruit/staff/requests/${REQ}/notes`, { html: true })).page!;
  assert.equal(page.status, 200);
  for (const text of ["Cashier &lt;x&gt;: notes", "✓ Brief &lt;store&gt;", "○ Optional", "0 required steps left.", "Noor &lt;b&gt;", "&lt;script&gt;", "(edited)", "Phone call", `value="${REQ}"`]) assert.ok(page.body.includes(text), text);
  assert.equal(page.body.includes("<script>"), false);
  calls.length = 0;
  const added = await call(`/recruit/staff/requests/${REQ}/notes`, form("type=meeting&text=Met+them&checklistItemId=&cardId="));
  assert.deepEqual([added.status, added.headers.location], [303, `/recruit/staff/requests/${REQ}/notes`]);
  assert.deepEqual(calls, [`note:${REQ}:${JSON.stringify({ type: "meeting", text: "Met them", checklistItemId: null, cardId: null })}`]);
  const removed = await call(`/recruit/staff/notes/${NOTE}/remove`, form(`requestId=${REQ}`));
  assert.deepEqual([removed.status, removed.headers.location], [303, `/recruit/staff/requests/${REQ}/notes`]);
  const created = await call("/recruit/admin/checklist/create", form("nameEn=Call&nameAr=&required=on&sortOrder=4"));
  assert.deepEqual([created.status, created.headers.location], [303, "/recruit/admin/checklist"]);
  assert.equal(calls.at(-1), `create:${JSON.stringify({ nameEn: "Call", nameAr: null, required: true, sortOrder: 4 })}`);
  assert.equal((await call(`/recruit/staff/requests/${REQ}/notes`, form("type=meeting&text=a&text=b"))).status, 400, "a repeated form key is refused");
  assert.equal((await call(`/recruit/staff/requests/${REQ}/notes`, form("type=meeting&text=x&checklistItemId=" + NOTE))).page?.status, 409);
});
